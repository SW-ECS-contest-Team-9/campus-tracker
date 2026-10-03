import { withTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import { logger } from '../../common/logger.js';
import { realtimeState } from '../../realtime/realtime-state.service.js';
import { previewBroadcast } from '../../realtime/preview.gateway.js';
import { collectorRepository } from '../collectors/collector.repository.js';
import { sessionRepository, type SessionRow } from './session.repository.js';
import { fusionService } from '../fusion/fusion.service.js';
import { REALTIME_FUSION_VERSION } from '../fusion/fusion.algorithms.js';
import type {
  DiagnosticEventsRequest,
  ListSessionsQuery,
  SessionDiagnosticsRequest,
  SessionFinishRequest,
  SessionStartRequest,
  SessionView,
  SyncCompleteRequest,
  SyncState,
} from './session.dto.js';

/**
 * Three separate states (local-first collection):
 *   collection: collection_sessions.status (ACTIVE until session:finish; never ended by a disconnect or restart)
 *   connection: in-memory WebSocket state (realtime-state.service)
 *   sync:       derived from capture/receive times and finalization (LIVE | DELAYED | OFFLINE | FINALIZED)
 */
export function syncStateOf(view: Pick<SessionView, 'status' | 'finalizedAt' | 'lastReceivedAt' | 'lastCapturedAt'>, connected: boolean, now = Date.now()): SyncState {
  const received = view.lastReceivedAt ? new Date(view.lastReceivedAt).getTime() : null;
  const captured = view.lastCapturedAt ? new Date(view.lastCapturedAt).getTime() : null;
  if (view.status !== 'ACTIVE' && view.finalizedAt && (received === null || received <= new Date(view.finalizedAt).getTime())) return 'FINALIZED';
  if (received !== null && connected && now - received <= env.SYNC_LIVE_WINDOW_MS && captured !== null && received - captured <= env.SYNC_LIVE_WINDOW_MS) return 'LIVE';
  if (received !== null && now - received <= env.SYNC_DELAYED_WINDOW_MS) return 'DELAYED';
  return 'OFFLINE';
}

/** Additive API fields; existing fields are unchanged. */
function decorate(view: SessionView) {
  const connected = realtimeState.get(view.collectorId)?.socketConnected ?? false;
  return {
    ...view,
    collectionState: view.status,
    syncState: syncStateOf(view, connected),
    fusion: { version: REALTIME_FUSION_VERSION, state: view.fusionState, needsReprocess: view.needsReprocess },
  };
}

async function broadcastSession(kind: 'started' | 'finished', sessionId: string) {
  const view = await sessionRepository.findView(sessionId);
  if (!view) return;
  if (kind === 'started') previewBroadcast.sessionStarted(decorate(view));
  else previewBroadcast.sessionFinished(decorate(view));
}

function ownedOrThrow(identity: CollectorIdentity, session: SessionRow | null): SessionRow {
  if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found');
  if (session.collector_id !== identity.collectorDatabaseId) throw AppError.forbidden('SESSION_FORBIDDEN', 'Session belongs to another collector');
  return session;
}

export const sessionService = {
  /**
   * Loads a session owned by the authenticated collector, by server sessionId or by clientSessionId alone
   * (a session started while offline has no server id on the phone yet). Status is intentionally NOT checked:
   * raw data captured before finish may arrive minutes later and must be stored.
   */
  async resolveOwnedSession(identity: CollectorIdentity, sessionId?: string | null, clientSessionId?: string | null): Promise<SessionRow> {
    if (sessionId) {
      const session = ownedOrThrow(identity, await sessionRepository.findById(sessionId));
      if (clientSessionId && clientSessionId.toLowerCase() !== session.client_session_id) {
        throw AppError.badRequest('CLIENT_SESSION_MISMATCH', 'clientSessionId does not match sessionId');
      }
      return session;
    }
    const session = clientSessionId ? await sessionRepository.findByClientSessionId(clientSessionId) : null;
    if (!session) {
      // Not an error the phone should drop: it must (re)send session:start with clientStartedAt, then retry.
      throw new AppError(409, 'SESSION_NOT_STARTED', 'Unknown clientSessionId: send session:start (with clientStartedAt) first, then retry', undefined, true);
    }
    return ownedOrThrow(identity, session);
  },

  /** Kept for existing callers (markers): sessionId required. */
  async getOwnedSession(identity: CollectorIdentity, sessionId: string, clientSessionId?: string | null): Promise<SessionRow> {
    return this.resolveOwnedSession(identity, sessionId, clientSessionId);
  },

  /**
   * Idempotent per clientSessionId: a reconnect, an app restart, a server restart or an offline-started session
   * all map to the same server session ("resumed": true). started_at = client collection start, created_at = server row time.
   */
  async start(identity: CollectorIdentity, req: SessionStartRequest) {
    if (req.deviceId !== identity.clientDeviceId) {
      throw AppError.forbidden('DEVICE_MISMATCH', 'deviceId does not match the authenticated device');
    }
    const startedAt = req.startedAt ?? req.clientStartedAt ?? null;

    const result = await withTransaction(async (client) => {
      await collectorRepository.upsertDevice(identity.collectorDatabaseId, identity.clientDeviceId, req, client);
      const inserted = await sessionRepository.insert(client, {
        clientSessionId: req.clientSessionId,
        collectorId: identity.collectorDatabaseId,
        deviceId: identity.deviceDatabaseId,
        startedAt,
        sensorCapabilities: req.sensorCapabilities,
      });
      if (inserted) {
        // A device collects one session at a time: other ACTIVE sessions of this device were left behind.
        const interrupted = await sessionRepository.interruptOtherActive(client, identity.deviceDatabaseId, inserted.id);
        return { session: inserted, created: true, interrupted };
      }
      const existing = await sessionRepository.findByClientSessionId(req.clientSessionId, client);
      if (!existing) throw new Error('session insert conflict without existing row');
      if (existing.collector_id !== identity.collectorDatabaseId) {
        throw AppError.conflict('SESSION_CONFLICT', 'clientSessionId already used by another collector');
      }
      return { session: existing, created: false, interrupted: [] as string[] };
    });

    const { session, created, interrupted } = result;
    logger.info(created ? 'session.started' : 'session.resumed', {
      collectorId: identity.collectorId,
      sessionId: session.id,
      clientSessionId: session.client_session_id,
      status: session.status,
      startedAt: session.started_at,
      interrupted,
    });
    for (const id of interrupted) {
      realtimeState.sessionEnded(identity.collectorId, id);
      fusionService.sessionFinished(id, identity.collectorId);
      await broadcastSession('finished', id);
    }
    if (session.status === 'ACTIVE') {
      previewBroadcast.collectorStatus(realtimeState.sessionStarted(identity.collectorId, session.id));
      if (created) {
        fusionService.sessionStarted(session.id, identity.collectorId);
        await broadcastSession('started', session.id);
      }
    }
    return {
      ok: true as const,
      sessionId: session.id,
      clientSessionId: session.client_session_id,
      startedAt: session.started_at.toISOString(),
      status: session.status,
      collectionState: session.status,
      resumed: !created,
    };
  },

  /** "Collector stopped capturing". Raw upload may continue; the final fusion replay waits until uploads go idle. */
  async finish(identity: CollectorIdentity, req: SessionFinishRequest) {
    const session = await this.resolveOwnedSession(identity, req.sessionId, req.clientSessionId);
    const { row, changed } = await sessionRepository.finish(session.id, req.endedAt ?? null, req.interrupted ?? false);
    if (req.diagnostics) await sessionRepository.mergeDiagnostics(session.id, req.diagnostics);
    const sync = req.lastSequences ? await this.compareManifest(session.id, req.lastSequences) : null;

    if (changed) {
      logger.info('session.finished', { collectorId: identity.collectorId, sessionId: session.id, interrupted: req.interrupted ?? false });
      previewBroadcast.collectorStatus(realtimeState.sessionEnded(identity.collectorId, session.id));
      fusionService.sessionFinished(session.id, identity.collectorId);
      await broadcastSession('finished', session.id);
    } else {
      logger.info('session.finish_duplicate', { collectorId: identity.collectorId, sessionId: session.id });
    }
    if (sync?.synchronized) fusionService.finalizeSoon(session.id, 0);

    return {
      ok: true as const,
      sessionId: row.id,
      endedAt: row.ended_at?.toISOString() ?? null,
      status: row.status,
      collectionState: row.status,
      ...(sync ? { sync } : {}),
    };
  },

  /**
   * Compares the client's last sequence per stream with what the server stored. A gap inside a stream is NOT
   * treated as loss (sensor callbacks can be skipped); only "the last sample arrived" matters here.
   */
  async compareManifest(sessionId: string, expected: SyncCompleteRequest['lastSequences']) {
    const server = await sessionRepository.maxSequences(sessionId);
    const streams: Record<string, { expected: number | null; server: number | null; synchronized: boolean }> = {};
    for (const key of ['location', 'motion', 'altimeter', 'pedometer'] as const) {
      const exp = expected[key] ?? null;
      // pedometer: compare by max client sequence when sent, else by row count - 1 (0-based)
      const have = key === 'pedometer' ? (server.pedometer ?? (server.pedometer_count > 0 ? server.pedometer_count - 1 : null)) : server[key];
      streams[key] = { expected: exp, server: have, synchronized: exp === null || exp < 0 || (have !== null && have >= exp) };
    }
    const synchronized = Object.values(streams).every((s) => s.synchronized);
    await sessionRepository.setSyncManifest(sessionId, { expected, streams, synchronized, comparedAt: new Date().toISOString() });
    return { synchronized, streams };
  },

  /** session:syncComplete — "everything I captured has been uploaded". Finalizes right away when the server agrees. */
  async syncComplete(identity: CollectorIdentity, req: SyncCompleteRequest) {
    const session = await this.resolveOwnedSession(identity, req.sessionId, req.clientSessionId);
    if (req.diagnostics) await sessionRepository.mergeDiagnostics(session.id, req.diagnostics);
    const sync = await this.compareManifest(session.id, req.lastSequences);
    logger.info('session.sync_complete', { collectorId: identity.collectorId, sessionId: session.id, synchronized: sync.synchronized });
    if (sync.synchronized && session.status !== 'ACTIVE') fusionService.finalizeSoon(session.id, 0);
    return { ok: true as const, sessionId: session.id, collectionState: session.status, ...sync };
  },

  async mergeDiagnostics(identity: CollectorIdentity, req: SessionDiagnosticsRequest) {
    const session = await this.resolveOwnedSession(identity, req.sessionId, req.clientSessionId);
    await sessionRepository.mergeDiagnostics(session.id, req.diagnostics);
    return { ok: true as const, sessionId: session.id };
  },

  /** Lifecycle events (APP_BACKGROUND, MOTION_STOPPED, ...). Stored for analysis only, never fusion input. */
  async diagnosticEvents(identity: CollectorIdentity, req: DiagnosticEventsRequest) {
    const session = await this.resolveOwnedSession(identity, req.sessionId, req.clientSessionId);
    const inserted = await sessionRepository.insertDiagnosticEvents(session.id, req.events);
    return { ok: true as const, sessionId: session.id, received: req.events.length, inserted, duplicates: req.events.length - inserted };
  },

  // ---- REST (preview) ----
  async list(q: ListSessionsQuery) {
    return (await sessionRepository.listViews(q)).map(decorate);
  },

  async get(sessionId: string) {
    const view = await sessionRepository.findView(sessionId);
    if (!view) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found');
    return decorate(view);
  },

  /** Detail: state + raw statistics (counts, live vs recovered, capture/receive ranges, receive delay, gaps). */
  async detail(sessionId: string) {
    const view = await this.get(sessionId);
    return { ...view, raw: await sessionRepository.rawStats(sessionId) };
  },

  /**
   * Full trajectory in SENSOR time order (timestamp, then sequence), never arrival order.
   * No pagination yet; downsample here if sessions grow too large.
   */
  async getLocations(sessionId: string) {
    await this.get(sessionId);
    return sessionRepository.findLocations(sessionId);
  },
};
