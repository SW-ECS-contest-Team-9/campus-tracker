import type { PoolClient } from 'pg';
import { pool, type DbClient } from '../../config/database.js';
import type { RawSamples } from './fusion.timeline.js';
import type { FusedOutput, SpatialGpsDecision } from './fusion.types.js';
import type { FusedPositionView } from './fusion.dto.js';

const VIEW_COLUMNS = `
  fusion_sequence AS "fusionSequence", "timestamp", longitude, latitude,
  ellipsoidal_altitude AS "ellipsoidalAltitude", local_x AS "localX", local_y AS "localY", local_z AS "localZ",
  heading_degrees AS heading, horizontal_confidence AS "horizontalConfidence",
  vertical_confidence AS "verticalConfidence", overall_confidence AS "overallConfidence",
  gps_horizontal_accuracy AS "gpsHorizontalAccuracy", gps_vertical_accuracy AS "gpsVerticalAccuracy",
  position_source AS source, algorithm_version AS "algorithmVersion",
  gps_used AS "gpsUsed", gps_reject_reason AS "gpsRejectReason", gps_sequence AS "gpsSequence",
  innovation_distance AS "innovationDistance", stationary, heading_source AS "headingSource",
  horizontal_uncertainty AS "horizontalUncertainty",
  gps_quality AS "gpsQuality", pdr_applied AS "pdrApplied", pdr_reject_reason AS "pdrRejectReason",
  relative_altitude AS "relativeAltitude", reanchored, reanchor_reason AS "reanchorReason",
  divergence_detected AS "divergenceDetected", spatial_map_version_id AS "spatialMapVersionId",
  spatial_status AS "spatialStatus", building_id AS "buildingId", building_name AS "buildingName",
  building_match_status AS "buildingMatchStatus", spatial_segment_id AS "spatialSegmentId",
  terrain_height AS "terrainHeight", height_above_ground AS "heightAboveGround", z_datum_source AS "zDatumSource",
  z_datum_sigma AS "zDatumSigma"`;

export const fusionRepository = {
  /** Batch insert (one statement). Existing (session, version, sequence) rows are kept. Returns inserted sequences. */
  async insertOutputs(db: DbClient, sessionId: string, version: string, outputs: FusedOutput[]): Promise<number[]> {
    if (outputs.length === 0) return [];
    const col = <K extends keyof FusedOutput>(k: K) => outputs.map((o) => o[k]);
    const opt = <K extends keyof FusedOutput>(k: K) => outputs.map((o) => o[k] ?? null); // v1 has no diagnostics
    const { rows } = await db.query<{ fusion_sequence: number }>(
      `INSERT INTO fused_positions (
         session_id, algorithm_version, fusion_sequence, "timestamp", latitude, longitude, ellipsoidal_altitude,
         local_x, local_y, local_z, heading_degrees, horizontal_confidence, vertical_confidence, overall_confidence,
         gps_horizontal_accuracy, gps_vertical_accuracy, position_source, geom,
         gps_used, gps_reject_reason, gps_sequence, innovation_distance, stationary, heading_source, horizontal_uncertainty,
         gps_quality, pdr_applied, pdr_reject_reason, relative_altitude, reanchored, reanchor_reason, divergence_detected,
         spatial_map_version_id, spatial_status, building_id, building_name, building_match_status, spatial_segment_id,
         terrain_height, height_above_ground, z_datum_source, z_datum_sigma)
       SELECT $1, $2, t.seq, to_timestamp(t.ts / 1000.0), t.lat, t.lon, t.ell, t.x, t.y, t.z, t.heading, t.hc, t.vc, t.oc,
              t.hacc, t.vacc, t.src,
              ST_SetSRID(ST_MakePoint(t.lon, t.lat, t.gz), 4326),  -- X = lon, Y = lat, Z = ellipsoidal (or state) height
              t.gps_used, t.reason, t.gps_seq, t.innovation, t.stationary, t.heading_source, t.uncertainty,
              t.gps_quality, t.pdr_applied, t.pdr_reason, t.rel_alt, t.reanchored, t.reanchor_reason, t.divergence,
              t.map_version_id, t.spatial_status, t.building_id, t.building_name, t.building_match_status, t.spatial_segment_id,
              t.terrain_height, t.hag, t.z_source, t.z_sigma
         FROM unnest($3::bigint[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[],
                     $10::float8[], $11::float8[], $12::float8[], $13::float8[], $14::float8[], $15::float8[],
                     $16::float8[], $17::text[], $18::float8[],
                     $19::boolean[], $20::text[], $21::bigint[], $22::float8[], $23::boolean[], $24::text[], $25::float8[],
                     $26::text[], $27::boolean[], $28::text[], $29::float8[], $30::boolean[], $31::text[], $32::boolean[],
                     $33::text[], $34::text[], $35::text[], $36::text[], $37::text[], $38::int[],
                     $39::float8[], $40::float8[], $41::text[], $42::float8[])
              AS t(seq, ts, lat, lon, ell, x, y, z, heading, hc, vc, oc, hacc, vacc, src, gz,
                   gps_used, reason, gps_seq, innovation, stationary, heading_source, uncertainty,
                   gps_quality, pdr_applied, pdr_reason, rel_alt, reanchored, reanchor_reason, divergence,
                   map_version_id, spatial_status, building_id, building_name, building_match_status, spatial_segment_id,
                   terrain_height, hag, z_source, z_sigma)
       ON CONFLICT (session_id, algorithm_version, fusion_sequence) DO NOTHING
       RETURNING fusion_sequence`,
      [
        sessionId, version,
        col('fusionSequence'), col('timestamp'), col('latitude'), col('longitude'), col('ellipsoidalAltitude'),
        col('x'), col('y'), col('z'), col('headingDegrees'), col('horizontalConfidence'), col('verticalConfidence'),
        col('overallConfidence'), col('gpsHorizontalAccuracy'), col('gpsVerticalAccuracy'), col('source'), col('geomZ'),
        opt('gpsUsed'), opt('gpsRejectReason'), opt('gpsSequence'), opt('innovationDistance'), opt('stationary'),
        opt('headingSource'), opt('horizontalUncertainty'),
        opt('gpsQuality'), opt('pdrApplied'), opt('pdrRejectReason'), opt('relativeAltitude'), opt('reanchored'),
        opt('reanchorReason'), opt('divergenceDetected'), opt('spatialMapVersionId'), opt('spatialStatus'),
        opt('buildingId'), opt('buildingName'), opt('buildingMatchStatus'),
        opt('spatialSegmentId'),
        opt('terrainHeight'), opt('heightAboveGround'), opt('zDatumSource'), opt('zDatumSigma'),
      ],
    );
    return rows.map((r) => r.fusion_sequence);
  },

  /** Replaces one version's results of a session (must run in a transaction). Other versions are untouched. */
  async replaceOutputs(client: PoolClient, sessionId: string, version: string, outputs: FusedOutput[], decisions: SpatialGpsDecision[] = []): Promise<void> {
    await client.query('DELETE FROM fused_positions WHERE session_id = $1 AND algorithm_version = $2', [sessionId, version]);
    await client.query('DELETE FROM spatial_gps_decisions WHERE session_id = $1 AND algorithm_version = $2', [sessionId, version]);
    // Large replays are inserted in chunks to keep each statement's arrays reasonable.
    for (let i = 0; i < outputs.length; i += 5000) {
      await this.insertOutputs(client, sessionId, version, outputs.slice(i, i + 5000));
    }
    await this.insertSpatialDecisions(client, sessionId, version, decisions);
  },

  async insertSpatialDecisions(db: DbClient, sessionId: string, version: string, decisions: SpatialGpsDecision[]): Promise<void> {
    if (!decisions.length) return;
    const col = (key: keyof SpatialGpsDecision) => decisions.map((decision) => decision[key]);
    await db.query(
      `INSERT INTO spatial_gps_decisions (
         session_id, algorithm_version, location_sequence, "timestamp", spatial_map_version_id,
         campus_status, anchor_accepted, reason, horizontal_accuracy, boundary_distance_m, building_id, building_name)
       SELECT $1, $2, t.sequence, to_timestamp(t.ts / 1000.0), t.map_id,
              t.campus, t.accepted, t.reason, t.accuracy, t.boundary_distance, t.building_id, t.building_name
         FROM unnest($3::bigint[], $4::float8[], $5::text[], $6::text[], $7::boolean[], $8::text[],
                     $9::float8[], $10::float8[], $11::text[], $12::text[])
           AS t(sequence, ts, map_id, campus, accepted, reason, accuracy, boundary_distance, building_id, building_name)
       ON CONFLICT (session_id, algorithm_version, location_sequence) DO UPDATE SET
         "timestamp" = EXCLUDED."timestamp", spatial_map_version_id = EXCLUDED.spatial_map_version_id,
         campus_status = EXCLUDED.campus_status, anchor_accepted = EXCLUDED.anchor_accepted, reason = EXCLUDED.reason,
         horizontal_accuracy = EXCLUDED.horizontal_accuracy, boundary_distance_m = EXCLUDED.boundary_distance_m,
         building_id = EXCLUDED.building_id, building_name = EXCLUDED.building_name, decided_at = now()`,
      [sessionId, version, col('sequence'), col('timestamp'), col('spatialMapVersionId'), col('campusStatus'), col('anchorAccepted'),
        col('reason'), col('horizontalAccuracy'), col('boundaryDistanceM'), col('buildingId'), col('buildingName')],
    );
  },

  async spatialDecisions(sessionId: string, version: string, db: DbClient = pool) {
    const { rows } = await db.query(
      `SELECT location_sequence AS "sequence", "timestamp", spatial_map_version_id AS "spatialMapVersionId",
              campus_status AS "campusStatus", anchor_accepted AS "anchorAccepted", reason,
              horizontal_accuracy AS "horizontalAccuracy", boundary_distance_m AS "boundaryDistanceM",
              building_id AS "buildingId", building_name AS "buildingName"
         FROM spatial_gps_decisions WHERE session_id = $1 AND algorithm_version = $2
        ORDER BY "timestamp", location_sequence`, [sessionId, version],
    );
    return rows;
  },

  async replaceSensorEvents(client: PoolClient, sessionId: string, version: string, events: { timestamp: number; eventType: string; details: object }[]) {
    await client.query('DELETE FROM fusion_sensor_events WHERE session_id = $1 AND algorithm_version = $2', [sessionId, version]);
    await this.insertSensorEvents(client, sessionId, version, events);
  },

  async insertSensorEvents(db: DbClient, sessionId: string, version: string, events: { timestamp: number; eventType: string; details: object }[]) {
    if (!events.length) return;
    await db.query(
      `INSERT INTO fusion_sensor_events (session_id, algorithm_version, "timestamp", event_type, details)
       SELECT $1, $2, to_timestamp(t.ms / 1000.0), t.kind, t.details::jsonb
         FROM unnest($3::float8[], $4::text[], $5::text[]) AS t(ms, kind, details)`,
      [sessionId, version, events.map((e) => e.timestamp), events.map((e) => e.eventType), events.map((e) => JSON.stringify(e.details))],
    );
  },

  async sensorEvents(sessionId: string, version: string, db: DbClient = pool) {
    const { rows } = await db.query(
      `SELECT "timestamp", event_type AS "eventType", details
         FROM fusion_sensor_events WHERE session_id = $1 AND algorithm_version = $2
        ORDER BY "timestamp", id`, [sessionId, version],
    );
    return rows;
  },

  async list(sessionId: string, version: string, db: DbClient = pool): Promise<FusedPositionView[]> {
    const { rows } = await db.query<FusedPositionView>(
      `SELECT ${VIEW_COLUMNS} FROM fused_positions
        WHERE session_id = $1 AND algorithm_version = $2
        ORDER BY "timestamp", fusion_sequence`,
      [sessionId, version],
    );
    return rows;
  },

  async versionsSummary(sessionId: string, db: DbClient = pool) {
    const { rows } = await db.query<{ algorithmVersion: string; count: number; firstAt: Date; lastAt: Date; lastCreatedAt: Date }>(
      `SELECT algorithm_version AS "algorithmVersion", count(*) AS count, min("timestamp") AS "firstAt",
              max("timestamp") AS "lastAt", max(created_at) AS "lastCreatedAt"
         FROM fused_positions WHERE session_id = $1 GROUP BY algorithm_version ORDER BY algorithm_version`,
      [sessionId],
    );
    return rows;
  },

  /** Everything fusion needs from the raw tables (read-only), in the shape buildTimeline expects. */
  async loadRawSamples(sessionId: string, db: DbClient = pool): Promise<RawSamples> {
    const [locations, motion, altimeter, pedometer] = await Promise.all([
      db.query(
        `SELECT sequence, "timestamp", latitude, longitude, altitude, ellipsoidal_altitude AS "ellipsoidalAltitude",
                horizontal_accuracy AS "horizontalAccuracy", vertical_accuracy AS "verticalAccuracy", speed, course
           FROM location_samples WHERE session_id = $1`,
        [sessionId],
      ),
      db.query(
        `SELECT sequence, "timestamp", attitude_yaw AS yaw,
                user_acceleration_x AS ax, user_acceleration_y AS ay, user_acceleration_z AS az,
                rotation_rate_x AS rx, rotation_rate_y AS ry, rotation_rate_z AS rz,
                gravity_x AS gx, gravity_y AS gy, gravity_z AS gz,
                attitude_roll AS roll, attitude_pitch AS pitch,
                sensor_segment_id AS segment
           FROM motion_samples WHERE session_id = $1`,
        [sessionId],
      ),
      db.query(
        `SELECT sequence, "timestamp", relative_altitude AS "relativeAltitude", sensor_segment_id AS segment
           FROM altimeter_samples WHERE session_id = $1`,
        [sessionId],
      ),
      db.query(
        `SELECT "timestamp", distance, number_of_steps AS "numberOfSteps", sensor_segment_id AS segment FROM pedometer_samples
          WHERE session_id = $1 ORDER BY "timestamp", id`,
        [sessionId],
      ),
    ]);
    return { locations: locations.rows, motion: motion.rows, altimeter: altimeter.rows, pedometer: pedometer.rows };
  },

  // ---- fusion_runs (reprocessing history) ----

  async createRun(
    sessionId: string,
    version: string,
    trigger: string,
    config: object,
    configHash: string,
    extra: { revision: number; variant: string | null; overrides: object | null; mode: string; codeRef: string | null; published: boolean } | null = null,
    db: DbClient = pool,
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fusion_runs (session_id, algorithm_version, status, trigger, config, config_hash, revision, variant, overrides, mode, code_ref, published)
       VALUES ($1, $2, 'RUNNING', $3, $4, $5, $6, $7, $8, COALESCE($9, 'SENSOR_TIME'), $10, COALESCE($11, true)) RETURNING id`,
      [sessionId, version, trigger, JSON.stringify(config), configHash, extra?.revision ?? null, extra?.variant ?? null,
        extra?.overrides ? JSON.stringify(extra.overrides) : null, extra?.mode ?? null, extra?.codeRef ?? null, extra?.published ?? null],
    );
    return rows[0].id;
  },

  async completeRun(
    id: string,
    r: {
      raw: { locations: number; motion: number; altimeter: number; pedometer: number };
      outputs: number;
      accepted: number;
      rejected: number;
      reanchors: number | null;
      divergences: number | null;
      metrics: object;
      warnings: object[];
    },
    db: DbClient = pool,
  ) {
    await db.query(
      `UPDATE fusion_runs SET status = 'COMPLETED', completed_at = now(),
              raw_location_count = $2, raw_motion_count = $3, raw_altimeter_count = $4, raw_pedometer_count = $5,
              output_count = $6, gps_accepted_count = $7, gps_rejected_count = $8, metrics = $9,
              reanchor_count = $10, divergence_count = $11, warnings = $12
        WHERE id = $1`,
      [
        id, r.raw.locations, r.raw.motion, r.raw.altimeter, r.raw.pedometer, r.outputs, r.accepted, r.rejected,
        JSON.stringify(r.metrics), r.reanchors, r.divergences, JSON.stringify(r.warnings),
      ],
    );
  },

  async failRun(id: string, error: string, db: DbClient = pool) {
    await db.query(`UPDATE fusion_runs SET status = 'FAILED', completed_at = now(), error = $2 WHERE id = $1`, [id, error]);
  },

  /** Latest run per algorithm version of a session. */
  async latestRuns(sessionId: string, db: DbClient = pool) {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (algorithm_version)
              id, algorithm_version AS "algorithmVersion", status, trigger, config_hash AS "configHash",
              started_at AS "startedAt", completed_at AS "completedAt", output_count AS "outputCount",
              gps_accepted_count AS "gpsAccepted", gps_rejected_count AS "gpsRejected", metrics, error,
              reanchor_count AS "reanchors", divergence_count AS "divergences", warnings
         FROM fusion_runs WHERE session_id = $1 AND published
        ORDER BY algorithm_version, created_at DESC`,
      [sessionId],
    );
    return rows;
  },

  async hasCompletedRun(sessionId: string, version: string, configHash: string, db: DbClient = pool): Promise<boolean> {
    const { rowCount } = await db.query(
      `SELECT 1 FROM fusion_runs WHERE session_id = $1 AND algorithm_version = $2 AND config_hash = $3 AND status = 'COMPLETED' AND published LIMIT 1`,
      [sessionId, version, configHash],
    );
    return (rowCount ?? 0) > 0;
  },

  async listSessions(db: DbClient = pool): Promise<
    { id: string; status: string; collectorId: string; startedAt: Date; needsReprocess: boolean; fusionState: string; finalizedAt: Date | null }[]
  > {
    const { rows } = await db.query(
      `SELECT s.id, s.status, c.collector_code AS "collectorId", s.started_at AS "startedAt",
              s.needs_reprocess AS "needsReprocess", s.fusion_state AS "fusionState", s.finalized_at AS "finalizedAt"
         FROM collection_sessions s JOIN collectors c ON c.id = s.collector_id ORDER BY s.started_at`,
    );
    return rows;
  },

  // ---- replay lock + fusion state of the session (state tracks the realtime version only) ----

  /**
   * Cross-process lock (API, CLI and automatic replays). Returns last_received_at at lock time as TEXT
   * (microsecond precision; a JS Date would truncate it and "no new data since" could never match), or null if busy.
   */
  async tryLock(sessionId: string, lockMs: number, markProcessing: boolean, db: DbClient = pool): Promise<{ receivedAt: string | null; outOfOrder: number } | null> {
    const { rows } = await db.query<{ last_received_at: string | null; out_of_order_batches: number }>(
      `UPDATE collection_sessions
          SET fusion_lock_until = now() + ($2::int * interval '1 millisecond'),
              fusion_state = CASE WHEN $3 THEN 'PROCESSING' ELSE fusion_state END
        WHERE id = $1 AND (fusion_lock_until IS NULL OR fusion_lock_until < now())
        RETURNING last_received_at::text, out_of_order_batches`,
      [sessionId, lockMs, markProcessing],
    );
    return rows[0] ? { receivedAt: rows[0].last_received_at, outOfOrder: rows[0].out_of_order_batches } : null;
  },

  /**
   * Releases the lock. For the realtime version: CLEAN unless raw arrived during the replay (then DIRTY again);
   * a non-ACTIVE session whose data did not change is FINALIZED. A replay that realtime continues (ACTIVE) stays
   * CLEAN while only in-order batches arrived (realtime applies them after the replay); out-of-order => DIRTY.
   */
  async unlock(
    sessionId: string,
    outcome: 'success' | 'failed' | 'none',
    start: { receivedAt: string | null; outOfOrder: number },
    continuesLive: boolean,
    db: DbClient = pool,
  ) {
    await db.query(
      `UPDATE collection_sessions SET
         fusion_lock_until = NULL,
         fusion_state = CASE
           WHEN $2 = 'failed' THEN 'FAILED'
           WHEN $2 = 'success' AND (last_received_at IS NOT DISTINCT FROM $3::timestamptz OR ($4 AND out_of_order_batches = $5)) THEN 'CLEAN'
           WHEN $2 = 'success' THEN 'DIRTY'
           ELSE fusion_state END,
         needs_reprocess = CASE
           WHEN $2 = 'success' THEN last_received_at IS DISTINCT FROM $3::timestamptz AND NOT ($4 AND out_of_order_batches = $5)
           WHEN $2 = 'failed' THEN true
           ELSE needs_reprocess END,
         finalized_at = CASE
           WHEN $2 = 'success' AND status <> 'ACTIVE' AND last_received_at IS NOT DISTINCT FROM $3::timestamptz THEN now()
           ELSE finalized_at END
       WHERE id = $1`,
      [sessionId, outcome, start.receivedAt, continuesLive, start.outOfOrder],
    );
  },

  /** Realtime fusion dropped late samples: its stored result is incomplete until the next full replay. */
  async markDirty(sessionId: string, db: DbClient = pool) {
    await db.query(
      `UPDATE collection_sessions SET needs_reprocess = true, fusion_state = 'DIRTY' WHERE id = $1 AND fusion_state <> 'PROCESSING'`,
      [sessionId],
    );
  },

  /** Ended sessions whose final replay is pending (e.g. timers lost by a server restart). */
  async pendingFinalization(db: DbClient = pool): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM collection_sessions
        WHERE status <> 'ACTIVE' AND (needs_reprocess OR finalized_at IS NULL OR fusion_state <> 'CLEAN')
        ORDER BY last_received_at NULLS FIRST`,
    );
    return rows.map((r) => r.id);
  },
};
