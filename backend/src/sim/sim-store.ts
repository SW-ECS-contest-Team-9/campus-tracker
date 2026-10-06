// Stores a synthetic walk as a real-looking session (collector SIM, collection_sessions.synthetic = true), through
// the same telemetry insert functions as the phones, in 2 s batches (one transaction each, like uploads).
import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../config/database.js';
import { telemetryRepository } from '../modules/telemetry/telemetry.repository.js';
import type { SyntheticWalk } from './synthetic.js';

export const SIM_COLLECTOR = 'SIM';

async function ensureSimDevice(): Promise<{ collectorId: string; deviceId: string }> {
  const { rows: c } = await pool.query<{ id: string }>(
    `INSERT INTO collectors (collector_code) VALUES ($1) ON CONFLICT (collector_code) DO UPDATE SET updated_at = now() RETURNING id`, [SIM_COLLECTOR],
  );
  const { rows: d } = await pool.query<{ id: string }>(
    `INSERT INTO devices (collector_id, client_device_id, platform, device_model, app_version) VALUES ($1, 'synthetic', 'sim', 'synthetic', 'sim')
     ON CONFLICT (collector_id, client_device_id) DO UPDATE SET last_seen_at = now() RETURNING id`, [c[0].id],
  );
  return { collectorId: c[0].id, deviceId: d[0].id };
}

export async function storeSyntheticSession(w: SyntheticWalk, note: string): Promise<string> {
  const { collectorId, deviceId } = await ensureSimDevice();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO collection_sessions (client_session_id, collector_id, device_id, started_at, ended_at, status, synthetic, sensor_capabilities, spatial_map_version_id)
     VALUES ($1, $2, $3, $4, $5, 'FINISHED', true, $6, (SELECT id FROM spatial_map_versions WHERE active LIMIT 1)) RETURNING id`,
    [randomUUID(), collectorId, deviceId, w.startedAt, w.endedAt, JSON.stringify({ synthetic: note })],
  );
  const sessionId = rows[0].id;
  const t = (s: { timestamp: string | Date }) => new Date(s.timestamp).getTime();
  const start = w.startedAt.getTime();
  const end = w.endedAt.getTime();
  const iso = (v: string | Date) => new Date(v).toISOString();
  for (let b0 = start; b0 <= end; b0 += 2000) {
    const inB = <T extends { timestamp: string | Date }>(arr: T[]) => arr.filter((s) => t(s) >= b0 && t(s) < b0 + 2000);
    const loc = inB(w.raw.locations);
    const mot = inB(w.raw.motion);
    const alt = inB(w.raw.altimeter);
    const ped = inB(w.raw.pedometer);
    if (!loc.length && !mot.length && !alt.length && !ped.length) continue;
    await withTransaction(async (client) => {
      await telemetryRepository.insertReceivedBatch(client, {
        batchId: randomUUID(), sessionId, clientCreatedAt: new Date(b0 + 2000).toISOString(),
        counts: { locations: loc.length, motion: mot.length, altimeter: alt.length, pedometer: ped.length },
        captureSource: 'LIVE', appState: 'FOREGROUND', minCapturedAt: new Date(b0).toISOString(), maxCapturedAt: new Date(b0 + 1999).toISOString(),
      });
      await telemetryRepository.insertLocations(client, sessionId, loc.map((l) => ({ ...l, timestamp: iso(l.timestamp) })) as never);
      await telemetryRepository.insertMotion(client, sessionId, mot.map((m) => ({
        sequence: m.sequence, timestamp: iso(m.timestamp),
        userAcceleration: { x: m.ax ?? 0, y: m.ay ?? 0, z: m.az ?? 0 }, gravity: { x: m.gx ?? 0, y: m.gy ?? 0, z: m.gz ?? -1 },
        rotationRate: { x: 0, y: 0, z: 0 }, attitude: { roll: m.roll ?? 0, pitch: m.pitch ?? 0, yaw: m.yaw ?? 0 },
      })) as never);
      await telemetryRepository.insertAltimeter(client, sessionId, alt.map((a) => ({ sequence: a.sequence, timestamp: iso(a.timestamp), relativeAltitude: a.relativeAltitude })) as never);
      await telemetryRepository.insertPedometer(client, sessionId, ped.map((p) => ({ timestamp: iso(p.timestamp), numberOfSteps: p.numberOfSteps, distance: p.distance })) as never);
    });
  }
  await pool.query(
    `UPDATE collection_sessions SET last_captured_at = $2, last_received_at = now(), finalized_at = now(), fusion_state = 'CLEAN', needs_reprocess = false WHERE id = $1`,
    [sessionId, w.endedAt],
  );
  return sessionId;
}
