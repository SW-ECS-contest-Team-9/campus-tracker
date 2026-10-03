import { pool, type DbClient } from '../../config/database.js';
import type { ListSessionsQuery, LocationPointView, SessionStatus, SessionView } from './session.dto.js';

export interface SessionRow {
  id: string;
  client_session_id: string;
  collector_id: string;
  device_id: string;
  started_at: Date;
  ended_at: Date | null;
  status: SessionStatus;
}

const SESSION_COLUMNS = 'id, client_session_id, collector_id, device_id, started_at, ended_at, status';

// Shared SELECT for SessionView. Counts are correlated subqueries: fine for a dev tool's data volume.
const SESSION_VIEW_SELECT = `
  SELECT s.id                  AS "sessionId",
         s.client_session_id   AS "clientSessionId",
         c.collector_code      AS "collectorId",
         json_build_object(
           'deviceId', d.id, 'clientDeviceId', d.client_device_id, 'platform', d.platform,
           'deviceModel', d.device_model, 'systemVersion', d.system_version, 'appVersion', d.app_version
         )                     AS device,
         s.started_at          AS "startedAt",
         s.ended_at            AS "endedAt",
         s.status,
         s.spatial_map_version_id AS "spatialMapVersionId",
         s.sensor_capabilities AS "sensorCapabilities",
         (SELECT count(*) FROM location_samples l WHERE l.session_id = s.id) AS "locationCount",
         (SELECT count(*) FROM event_markers m WHERE m.session_id = s.id)    AS "markerCount",
         (SELECT max(l."timestamp") FROM location_samples l WHERE l.session_id = s.id) AS "lastLocationAt",
         s.interrupted, s.created_at AS "createdAt", s.finish_requested_at AS "finishRequestedAt", s.finalized_at AS "finalizedAt",
         s.last_captured_at AS "lastCapturedAt", s.last_received_at AS "lastReceivedAt",
         s.out_of_order_batches AS "outOfOrderBatches", s.needs_reprocess AS "needsReprocess", s.fusion_state AS "fusionState"
    FROM collection_sessions s
    JOIN collectors c ON c.id = s.collector_id
    JOIN devices d    ON d.id = s.device_id`;

export const sessionRepository = {
  async findById(id: string, db: DbClient = pool): Promise<SessionRow | null> {
    const { rows } = await db.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM collection_sessions WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async findByClientSessionId(clientSessionId: string, db: DbClient = pool): Promise<SessionRow | null> {
    const { rows } = await db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM collection_sessions WHERE client_session_id = $1`,
      [clientSessionId],
    );
    return rows[0] ?? null;
  },

  /** Returns null when client_session_id already exists (idempotent start). */
  async insert(
    db: DbClient,
    data: { clientSessionId: string; collectorId: string; deviceId: string; startedAt: string | null; sensorCapabilities: unknown },
  ): Promise<SessionRow | null> {
    const { rows } = await db.query<SessionRow>(
      `INSERT INTO collection_sessions (client_session_id, collector_id, device_id, started_at, sensor_capabilities, spatial_map_version_id)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5,
               (SELECT id FROM spatial_map_versions WHERE active LIMIT 1))
       ON CONFLICT (client_session_id) DO NOTHING
       RETURNING ${SESSION_COLUMNS}`,
      [data.clientSessionId, data.collectorId, data.deviceId, data.startedAt, JSON.stringify(data.sensorCapabilities)],
    );
    return rows[0] ?? null;
  },

  /** A device collects one session at a time: older ACTIVE sessions of the same device become INTERRUPTED. */
  async interruptOtherActive(db: DbClient, deviceId: string, exceptSessionId: string): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE collection_sessions SET status = 'INTERRUPTED', updated_at = now()
        WHERE device_id = $1 AND status = 'ACTIVE' AND id <> $2
        RETURNING id`,
      [deviceId, exceptSessionId],
    );
    return rows.map((r) => r.id);
  },

  /**
   * session:finish = the collector stopped capturing. Idempotent: the first endedAt / finish time wins.
   * Raw uploads may still arrive afterwards (they are accepted and trigger a final replay).
   */
  async finish(id: string, endedAt: string | null, interrupted: boolean, db: DbClient = pool): Promise<{ row: SessionRow; changed: boolean }> {
    const { rows } = await db.query<SessionRow & { was_finished: boolean }>(
      `UPDATE collection_sessions s
          SET status = 'FINISHED',
              ended_at = COALESCE(s.ended_at, $2::timestamptz, now()),
              finish_requested_at = COALESCE(s.finish_requested_at, now()),
              interrupted = s.interrupted OR $3,
              updated_at = now()
         FROM (SELECT status = 'FINISHED' AS was_finished FROM collection_sessions WHERE id = $1) prev
        WHERE s.id = $1
        RETURNING ${SESSION_COLUMNS.split(', ').map((c) => 's.' + c).join(', ')}, prev.was_finished`,
      [id, endedAt, interrupted],
    );
    const { was_finished, ...row } = rows[0];
    return { row: row as SessionRow, changed: !was_finished };
  },

  /**
   * FIRST statement of the telemetry transaction: serializes batches of the same session.
   * FOR NO KEY UPDATE (not FOR UPDATE): it is compatible with the FOR KEY SHARE locks that the sample
   * inserts take through their foreign keys, and taking it before any insert keeps one lock order (no deadlock).
   */
  async lockForIngest(db: DbClient, sessionId: string): Promise<{ status: SessionStatus; lastCapturedAt: Date | null }> {
    const { rows } = await db.query<{ status: SessionStatus; last_captured_at: Date | null }>(
      'SELECT status, last_captured_at FROM collection_sessions WHERE id = $1 FOR NO KEY UPDATE',
      [sessionId],
    );
    return { status: rows[0].status, lastCapturedAt: rows[0].last_captured_at };
  },

  /**
   * Capture/receive bookkeeping (same transaction, after lockForIngest): marks fusion DIRTY when this batch is
   * older than data already received (out-of-order) or arrives after finish.
   */
  async recordIngest(
    db: DbClient,
    sessionId: string,
    prev: { status: SessionStatus; lastCapturedAt: Date | null },
    minCapturedAt: string | null,
    maxCapturedAt: string | null,
    reorderWindowMs: number,
  ): Promise<{ outOfOrder: boolean; dirty: boolean; status: SessionStatus }> {
    const outOfOrder = !!(minCapturedAt && prev.lastCapturedAt && Date.parse(minCapturedAt) < prev.lastCapturedAt.getTime() - reorderWindowMs);
    const dirty = outOfOrder || prev.status !== 'ACTIVE';
    await db.query(
      `UPDATE collection_sessions SET
         last_captured_at = GREATEST(last_captured_at, $2::timestamptz),
         last_received_at = now(),
         out_of_order_batches = out_of_order_batches + $3,
         needs_reprocess = needs_reprocess OR $4,
         fusion_state = CASE WHEN $4 THEN 'DIRTY' ELSE fusion_state END,
         finalized_at = CASE WHEN status <> 'ACTIVE' THEN NULL ELSE finalized_at END,
         updated_at = now()
       WHERE id = $1`,
      [sessionId, maxCapturedAt, outOfOrder ? 1 : 0, dirty],
    );
    return { outOfOrder, dirty, status: prev.status };
  },

  async mergeDiagnostics(id: string, diagnostics: Record<string, unknown>, db: DbClient = pool) {
    await db.query(`UPDATE collection_sessions SET diagnostics = COALESCE(diagnostics, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`, [
      id,
      JSON.stringify(diagnostics),
    ]);
  },

  async setSyncManifest(id: string, manifest: object, db: DbClient = pool) {
    await db.query('UPDATE collection_sessions SET sync_manifest = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(manifest)]);
  },

  /** Highest client sequence stored per stream (pedometer: max sequence if the client sends one, else count). */
  async maxSequences(id: string, db: DbClient = pool) {
    const { rows } = await db.query<{ location: number | null; motion: number | null; altimeter: number | null; pedometer: number | null; pedometer_count: number }>(
      `SELECT (SELECT max(sequence) FROM location_samples WHERE session_id = $1) AS location,
              (SELECT max(sequence) FROM motion_samples WHERE session_id = $1) AS motion,
              (SELECT max(sequence) FROM altimeter_samples WHERE session_id = $1) AS altimeter,
              (SELECT max(sequence) FROM pedometer_samples WHERE session_id = $1) AS pedometer,
              (SELECT count(*) FROM pedometer_samples WHERE session_id = $1) AS pedometer_count`,
      [id],
    );
    return rows[0];
  },

  async insertDiagnosticEvents(
    sessionId: string,
    events: { eventId?: string | null; eventType: string; clientTimestamp: string; metadata?: Record<string, unknown> | null }[],
    db: DbClient = pool,
  ): Promise<number> {
    const { rowCount } = await db.query(
      `INSERT INTO collection_diagnostic_events (session_id, event_id, event_type, client_timestamp, metadata)
       SELECT $1, t.* FROM unnest($2::uuid[], $3::text[], $4::timestamptz[], $5::jsonb[]) AS t
       ON CONFLICT (event_id) DO NOTHING`,
      [
        sessionId,
        events.map((e) => e.eventId ?? null),
        events.map((e) => e.eventType),
        events.map((e) => e.clientTimestamp),
        events.map((e) => (e.metadata ? JSON.stringify(e.metadata) : null)),
      ],
    );
    return rowCount ?? 0;
  },

  /** Raw statistics for the session detail (counts, live vs recovered, capture/receive ranges, gaps, segments). */
  async rawStats(id: string, db: DbClient = pool) {
    const [streams, gaps, extra] = await Promise.all([
      db.query(
        `WITH s AS (
           SELECT 'location' AS stream, "timestamp" AS ts, created_at AS rcv, capture_source AS src, sensor_segment_id AS seg FROM location_samples WHERE session_id = $1
           UNION ALL SELECT 'motion', "timestamp", created_at, capture_source, sensor_segment_id FROM motion_samples WHERE session_id = $1
           UNION ALL SELECT 'altimeter', "timestamp", created_at, capture_source, sensor_segment_id FROM altimeter_samples WHERE session_id = $1
           UNION ALL SELECT 'pedometer', "timestamp", created_at, capture_source, sensor_segment_id FROM pedometer_samples WHERE session_id = $1)
         SELECT stream, count(*) AS count,
                count(*) FILTER (WHERE src = 'LIVE') AS live,
                count(*) FILTER (WHERE src <> 'LIVE') AS recovered,
                min(ts) AS "firstCapturedAt", max(ts) AS "lastCapturedAt",
                min(rcv) AS "firstReceivedAt", max(rcv) AS "lastReceivedAt",
                round(extract(epoch FROM max(rcv - ts)))::int AS "maxReceiveDelaySeconds",
                count(DISTINCT seg) AS segments
           FROM s GROUP BY stream`,
        [id],
      ),
      db.query(
        `SELECT count(*) FILTER (WHERE d > interval '1 second') AS "motionGapsOver1s",
                round(extract(epoch FROM max(d)) * 1000)::bigint AS "maxMotionGapMs"
           FROM (SELECT "timestamp" - lag("timestamp") OVER (ORDER BY "timestamp", sequence) AS d FROM motion_samples WHERE session_id = $1) x`,
        [id],
      ),
      db.query(
        `SELECT (SELECT count(*) FROM received_batches WHERE session_id = $1) AS batches,
                (SELECT count(*) FROM received_batches WHERE session_id = $1 AND out_of_order) AS "outOfOrderBatches",
                (SELECT count(*) FROM collection_diagnostic_events WHERE session_id = $1) AS "diagnosticEvents",
                s.diagnostics, s.sync_manifest AS "syncManifest"
           FROM collection_sessions s WHERE s.id = $1`,
        [id],
      ),
    ]);
    return { streams: streams.rows, ...gaps.rows[0], ...extra.rows[0] };
  },

  /** For restoring in-memory collector state after a server restart: latest ACTIVE session per collector. */
  async activeSessionsByCollector(db: DbClient = pool) {
    const { rows } = await db.query<{ collectorId: string; sessionId: string; lastCapturedAt: Date | null; lastReceivedAt: Date | null }>(
      `SELECT DISTINCT ON (s.collector_id) c.collector_code AS "collectorId", s.id AS "sessionId",
              s.last_captured_at AS "lastCapturedAt", s.last_received_at AS "lastReceivedAt"
         FROM collection_sessions s JOIN collectors c ON c.id = s.collector_id
        WHERE s.status = 'ACTIVE'
        ORDER BY s.collector_id, s.started_at DESC`,
    );
    return rows;
  },

  async findView(id: string, db: DbClient = pool): Promise<SessionView | null> {
    const { rows } = await db.query<SessionView>(`${SESSION_VIEW_SELECT} WHERE s.id = $1`, [id]);
    return rows[0] ?? null;
  },

  async listViews(q: ListSessionsQuery, db: DbClient = pool): Promise<SessionView[]> {
    const { rows } = await db.query<SessionView>(
      `${SESSION_VIEW_SELECT}
        WHERE ($1::text IS NULL OR c.collector_code = $1)
          AND ($2::text IS NULL OR s.status = $2)
        ORDER BY s.started_at DESC
        LIMIT $3`,
      [q.collectorId ?? null, q.status ?? null, q.limit],
    );
    return rows;
  },

  async findLocations(sessionId: string, db: DbClient = pool): Promise<LocationPointView[]> {
    const { rows } = await db.query<LocationPointView>(
      `SELECT sequence, longitude, latitude, altitude,
              ellipsoidal_altitude AS "ellipsoidalAltitude",
              horizontal_accuracy  AS "horizontalAccuracy",
              vertical_accuracy    AS "verticalAccuracy",
              speed, course, "timestamp", created_at AS "receivedAt", capture_source AS "captureSource"
         FROM location_samples
        WHERE session_id = $1
        ORDER BY "timestamp", sequence -- sensor time, never arrival order
      `,
      [sessionId],
    );
    return rows;
  },
};
