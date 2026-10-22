import { pool, withTransaction } from '../../config/database.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import { AppError } from '../../common/errors/app-error.js';
import { logger } from '../../common/logger.js';
import { sessionService } from '../sessions/session.service.js';
import { previewBroadcast } from '../../realtime/preview.gateway.js';
import { parseArkitPose } from './arkit.dto.js';
import { arkitRepository } from './arkit.repository.js';
import { buildTrajectory } from './arkit.engine.js';

// Coalesced best-effort derived work, one session at a time. Raw persistence never waits for a fit.
const pending = new Set<string>();
let busy = false;
let timer: NodeJS.Timeout | undefined;
let stopped = false;
export function stopArkitJobs() { stopped=true; if(timer) clearTimeout(timer); timer=undefined; pending.clear(); }
export function scheduleArkit(sessionId: string) {
  if(stopped) return;
  if (pending.size < 1000) pending.add(sessionId);
  if (!timer) timer = setTimeout(() => { timer = undefined; void drain(); }, 5000).unref();
}
async function drain() {
  if (busy) return;
  busy = true;
  const ids = [...pending]; pending.clear();
  try {
    for (const id of ids) {
      try { await arkitService.reprocess(id); }
      catch (err) { logger.warn('arkit.derive_failed', { sessionId: id, message: err instanceof Error ? err.message : String(err) }); }
    }
  } finally { busy = false; if (pending.size) scheduleArkit(pending.values().next().value!); }
}

export const arkitService = {
  async recoverPending() {
    const { rows } = await pool.query<{session_id:string}>(`SELECT DISTINCT a.session_id FROM arkit_sessions a
      LEFT JOIN arkit_trajectory_results r ON r.session_id=a.session_id AND r.ar_session_id=a.ar_session_id AND r.algorithm_version='arkit-rigid-relative-v1'
      WHERE r.generated_at IS NULL OR EXISTS(SELECT 1 FROM arkit_pose_samples p WHERE p.session_id=a.session_id AND p.ar_session_id=a.ar_session_id AND p.created_at>r.generated_at)
      OR EXISTS(SELECT 1 FROM location_samples g WHERE g.session_id=a.session_id AND g.created_at>r.generated_at)
      OR EXISTS(SELECT 1 FROM fused_positions f WHERE f.session_id=a.session_id AND f.created_at>r.generated_at) LIMIT 1000`);
    for (const row of rows) scheduleArkit(row.session_id);
  },
  async ingest(identity: CollectorIdentity, payload: unknown) {
    const p = parseArkitPose(payload);
    if (p.deviceId !== identity.clientDeviceId) throw AppError.forbidden('DEVICE_MISMATCH', 'deviceId must match authenticated device');
    const session = await sessionService.resolveOwnedSession(identity, p.sessionId);
    if (session.device_id !== identity.deviceDatabaseId) throw AppError.forbidden('SESSION_DEVICE_MISMATCH', 'Session belongs to another device');
    const stored = await withTransaction(db => arkitRepository.insert(db,p,identity.deviceDatabaseId));
    if (!stored.duplicate) previewBroadcast.arkitPose({ sessionId:p.sessionId, arSessionId:p.arSessionId, pose: {
      sequence:p.sequence,timestamp:p.timestamp,frameTimestamp:p.frameTimestamp,x:p.position.x,y:p.position.y,z:p.position.z,trackingState:p.trackingState },receivedAt:stored.receivedAt.toISOString() });
    scheduleArkit(p.sessionId);
    return { ok:true,sessionId:p.sessionId,arSessionId:p.arSessionId,sequence:p.sequence,duplicate:stored.duplicate,receivedAt:stored.receivedAt.toISOString() };
  },
  /** Called after committed legacy telemetry; errors cannot affect its durable ACK. */
  async telemetryCommitted(identity: CollectorIdentity, payload: unknown) {
    try {
      const p = payload as { sessionId?: string; clientSessionId?: string };
      const s = await sessionService.resolveOwnedSession(identity,p.sessionId,p.clientSessionId);
      const exists = await pool.query('SELECT 1 FROM arkit_sessions WHERE session_id=$1 LIMIT 1',[s.id]);
      if (exists.rowCount) scheduleArkit(s.id);
    } catch (err) { logger.warn('arkit.schedule_failed', { message: err instanceof Error ? err.message : String(err) }); }
  },
  async reprocess(sessionId: string) {
    // Serialize only derived rebuilds. REPEATABLE READ yields a consistent raw/GPS/fusion snapshot.
    const updated = await withTransaction(async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const lock = await db.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,27)) AS locked',[sessionId]);
      if (!lock.rows[0].locked) { scheduleArkit(sessionId); return false; }
      const sessions = await arkitRepository.sessions(sessionId,db);
      if (!sessions.length) return false;
      const gps = await arkitRepository.gps(sessionId,db), fusion = await arkitRepository.fusion(sessionId,db);
      for (const s of sessions) {
        const poses = await arkitRepository.poses(sessionId,s.arSessionId,db);
        await arkitRepository.save(db,sessionId,s.arSessionId,buildTrajectory(poses,gps,fusion));
      }
      return true;
    });
    if (updated) previewBroadcast.arkitUpdated({sessionId});
    return { ok:true,updated };
  },
};
