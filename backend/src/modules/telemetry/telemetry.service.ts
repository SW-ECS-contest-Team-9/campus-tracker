import { withTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import { logger } from '../../common/logger.js';
import { realtimeState, type LatestLocation } from '../../realtime/realtime-state.service.js';
import { previewBroadcast } from '../../realtime/preview.gateway.js';
import { sessionService } from '../sessions/session.service.js';
import { sessionRepository } from '../sessions/session.repository.js';
import { fusionService } from '../fusion/fusion.service.js';
import { preSessionCutoff } from '../fusion/fusion.timeline.js';
import { telemetryRepository } from './telemetry.repository.js';
import type { TelemetryBatchAck, TelemetryBatchRequest } from './telemetry.dto.js';

/**
 * Oldest / newest sensor timestamp in a batch (all streams). Sensor time is authoritative, not arrival time.
 * orderMin ignores pre-session cached GPS fixes: they are stored, but they are not a late upload.
 */
function captureRange(b: TelemetryBatchRequest, sessionStartedAt: Date): { min: string | null; max: string | null; orderMin: string | null } {
  let min: number | null = null;
  let max: number | null = null;
  let orderMin: number | null = null;
  const cutoff = preSessionCutoff(sessionStartedAt);
  const visit = (ts: string) => {
    const t = Date.parse(ts);
    if (min === null || t < min) min = t;
    if (max === null || t > max) max = t;
    if (t >= cutoff && (orderMin === null || t < orderMin)) orderMin = t;
  };
  for (const s of b.locations) visit(s.timestamp);
  for (const s of b.motion) visit(s.timestamp);
  for (const s of b.altimeter) visit(s.timestamp);
  for (const s of b.pedometer) visit(s.timestamp);
  const iso = (v: number | null) => (v === null ? null : new Date(v).toISOString());
  return { min: iso(min), max: iso(max), orderMin: iso(orderMin) };
}

/** Per-sample metadata: sample value > batch value > default (LIVE / UNKNOWN / no segment). */
function withMeta<T extends { captureSource?: string | null; appState?: string | null; sensorSegmentId?: string | null }>(samples: T[], b: TelemetryBatchRequest): T[] {
  return samples.map((s) => ({
    ...s,
    captureSource: s.captureSource ?? b.captureSource ?? 'LIVE',
    appState: s.appState ?? b.appState ?? 'UNKNOWN',
    sensorSegmentId: s.sensorSegmentId ?? b.sensorSegmentId ?? null,
  }));
}

export const telemetryService = {
  /**
   * validation (controller) -> ownership (sessionId or clientSessionId) -> BEGIN -> batch gate -> samples
   * -> session bookkeeping (capture/receive time, out-of-order => fusion DIRTY) -> COMMIT -> ACK.
   * Old timestamps, out-of-order batches and data arriving after session:finish are all normal (local-first upload).
   * The ACK means "durably stored"; fusion runs afterwards and can never fail the ACK.
   */
  async ingestBatch(identity: CollectorIdentity, batch: TelemetryBatchRequest): Promise<TelemetryBatchAck> {
    const session = await sessionService.resolveOwnedSession(identity, batch.sessionId, batch.clientSessionId);
    const counts = {
      locations: batch.locations.length,
      motion: batch.motion.length,
      altimeter: batch.altimeter.length,
      pedometer: batch.pedometer.length,
    };
    const range = captureRange(batch, session.started_at);
    const locations = withMeta(batch.locations, batch);
    const motion = withMeta(batch.motion, batch);
    const altimeter = withMeta(batch.altimeter, batch);
    const pedometer = withMeta(batch.pedometer, batch);

    const result = await withTransaction(async (client) => {
      const locked = await sessionRepository.lockForIngest(client, session.id); // first: fixed lock order
      const received = await telemetryRepository.insertReceivedBatch(client, {
        batchId: batch.batchId,
        sessionId: session.id,
        clientCreatedAt: batch.createdAt ?? null,
        counts,
        captureSource: batch.captureSource ?? null,
        appState: batch.appState ?? null,
        minCapturedAt: range.min,
        maxCapturedAt: range.max,
      });

      if (!received) {
        // Already committed earlier (retry after a lost ACK / reconnect) -> success without re-inserting.
        const existing = await telemetryRepository.findReceivedBatch(client, batch.batchId);
        if (!existing) throw new Error('batch conflict without existing row');
        if (existing.session_id !== session.id) {
          throw AppError.conflict('BATCH_SESSION_CONFLICT', 'batchId was already used for another session');
        }
        return { duplicate: true, receivedAt: existing.received_at, insertedSequences: [] as number[], ingest: null };
      }

      // Sample-level idempotency too: (session, sequence) / (session, timestamp) ON CONFLICT DO NOTHING.
      const insertedSequences = await telemetryRepository.insertLocations(client, session.id, locations);
      await telemetryRepository.insertMotion(client, session.id, motion);
      await telemetryRepository.insertAltimeter(client, session.id, altimeter);
      await telemetryRepository.insertPedometer(client, session.id, pedometer);
      const ingest = await sessionRepository.recordIngest(client, session.id, locked, range.orderMin, range.max, env.OUT_OF_ORDER_TOLERANCE_MS);
      if (ingest.outOfOrder) await telemetryRepository.markBatchOutOfOrder(client, batch.batchId);
      return { duplicate: false, receivedAt: received.received_at, insertedSequences, ingest };
    });

    // ---- after COMMIT ----
    if (result.duplicate || !result.ingest) {
      logger.info('batch.duplicate', { collectorId: identity.collectorId, sessionId: session.id, batchId: batch.batchId });
    } else {
      const delayS = range.max ? Math.round((result.receivedAt.getTime() - Date.parse(range.max)) / 1000) : null;
      logger.info('batch.received', {
        collectorId: identity.collectorId,
        sessionId: session.id,
        batchId: batch.batchId,
        ...counts,
        captureDelayS: delayS,
        outOfOrder: result.ingest.outOfOrder || undefined,
        afterFinish: result.ingest.status !== 'ACTIVE' || undefined,
        appState: batch.appState ?? undefined,
      });
      this.broadcastCommitted(identity, session.id, batch, result.insertedSequences, counts, range);
      // Derived processing, fire-and-forget: never blocks or fails the raw ACK.
      if (result.ingest.status === 'ACTIVE') {
        fusionService.processBatch(identity.collectorId, session.id, session.started_at, {
          locations,
          motion: motion.map((m) => ({
            sequence: m.sequence,
            timestamp: m.timestamp,
            yaw: m.attitude?.yaw ?? null,
            ax: m.userAcceleration?.x ?? null,
            ay: m.userAcceleration?.y ?? null,
            az: m.userAcceleration?.z ?? null,
            segment: m.sensorSegmentId ?? null,
          })),
          altimeter: altimeter.map((a) => ({ ...a, segment: a.sensorSegmentId ?? null })),
          pedometer: pedometer.map((p) => ({ ...p, segment: p.sensorSegmentId ?? null })),
        });
      } else {
        // Late raw for a finished session: the authoritative result is a full replay once uploads go idle.
        fusionService.finalizeSoon(session.id);
      }
    }

    return { ok: true, batchId: batch.batchId, receivedAt: result.receivedAt.toISOString(), duplicate: result.duplicate };
  },

  /** Lightweight preview data only: newly stored location points. Motion/altimeter/pedometer are never broadcast. */
  broadcastCommitted(
    identity: CollectorIdentity,
    sessionId: string,
    batch: TelemetryBatchRequest,
    insertedSequences: number[],
    counts: { locations: number; motion: number; altimeter: number; pedometer: number },
    range: { min: string | null; max: string | null },
  ) {
    const inserted = new Set(insertedSequences);
    const points = batch.locations
      .filter((l) => inserted.has(l.sequence))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence);

    let latest: LatestLocation | null = null;
    for (const l of points) {
      latest = {
        sessionId,
        sequence: l.sequence,
        longitude: l.longitude,
        latitude: l.latitude,
        altitude: l.altitude ?? null,
        ellipsoidalAltitude: l.ellipsoidalAltitude ?? null,
        horizontalAccuracy: l.horizontalAccuracy ?? null,
        verticalAccuracy: l.verticalAccuracy ?? null,
        timestamp: l.timestamp,
      };
      previewBroadcast.locationUpdate({ collectorId: identity.collectorId, ...latest });
    }
    previewBroadcast.collectorStatus(realtimeState.batchCommitted(identity.collectorId, counts, latest, range.max));
  },
};
