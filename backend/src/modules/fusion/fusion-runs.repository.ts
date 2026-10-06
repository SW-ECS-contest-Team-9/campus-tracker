// Run snapshots (migration 014): every replay's own outputs, per-fix decisions and engine events.
import type { PoolClient } from 'pg';
import { pool, type DbClient } from '../../config/database.js';
import { CAMPUS_FRAME, toCampus } from '../../geo/campus-frame.js';
import type { FusedOutput } from './fusion.types.js';
import type { RunDiagnostics } from './fusion.diagnostics.js';
import type { RawSamples } from './fusion.timeline.js';

export type RunStage = 'FORWARD' | 'FINAL';
export type ReplayMode = 'SENSOR_TIME' | 'AS_RECEIVED';

export interface RunPosition {
  seq: number;
  t: number;
  latitude: number;
  longitude: number;
  x: number;
  y: number;
  h: number | null;
  zRel: number | null;
  sigmaH: number | null;
  heading: number | null;
  source: string;
  zDatumSource: string | null;
  zDatumSigma: number | null;
  heightAboveGround: number | null;
  buildingName: string | null;
  gpsUsed: boolean | null;
  gpsSequence: number | null;
  stationary: boolean | null;
}

/** Campus-frame view of fused outputs; h = orthometric height (ellipsoidal - N) when the run has an absolute height. */
export function toRunPositions(outputs: FusedOutput[], geoidN = CAMPUS_FRAME.geoidN): RunPosition[] {
  return outputs.map((o, i) => {
    const c = toCampus(o.latitude, o.longitude);
    return {
      seq: i + 1, t: o.timestamp, latitude: o.latitude, longitude: o.longitude, x: c.x, y: c.y,
      h: o.ellipsoidalAltitude === null ? null : o.ellipsoidalAltitude - geoidN,
      zRel: o.z, sigmaH: o.horizontalUncertainty ?? null, heading: o.headingDegrees, source: o.source,
      zDatumSource: o.zDatumSource ?? null, zDatumSigma: o.zDatumSigma ?? null, heightAboveGround: o.heightAboveGround ?? null,
      buildingName: o.buildingName ?? null, gpsUsed: o.gpsUsed ?? null, gpsSequence: o.gpsSequence ?? null, stationary: o.stationary ?? null,
    };
  });
}

const POSITION_COLUMNS = `seq, (extract(epoch FROM "timestamp") * 1000)::float8 AS t, latitude, longitude, x, y, h, z_rel AS "zRel", sigma_h AS "sigmaH",
  heading, source, z_datum_source AS "zDatumSource", z_datum_sigma AS "zDatumSigma", height_above_ground AS "heightAboveGround",
  building_name AS "buildingName", gps_used AS "gpsUsed", gps_sequence AS "gpsSequence", stationary`;

const RUN_COLUMNS = `r.id, r.session_id AS "sessionId", r.algorithm_version AS "algorithmVersion", r.revision, r.variant, r.overrides,
  r.mode, r.code_ref AS "codeRef", r.published, r.pinned, r.snapshot, r.status, r.trigger, r.config_hash AS "configHash",
  r.started_at AS "startedAt", r.completed_at AS "completedAt", r.output_count AS "outputCount", r.metrics, r.warnings, r.error`;

async function insertPositions(db: DbClient, runId: string, stage: RunStage, rows: RunPosition[]) {
  for (let i = 0; i < rows.length; i += 5000) {
    const chunk = rows.slice(i, i + 5000);
    const col = <K extends keyof RunPosition>(k: K) => chunk.map((r) => r[k]);
    await db.query(
      `INSERT INTO fusion_run_positions (run_id, stage, seq, "timestamp", latitude, longitude, x, y, h, z_rel, sigma_h, heading, source,
         z_datum_source, z_datum_sigma, height_above_ground, building_name, gps_used, gps_sequence, stationary)
       SELECT $1, $2, t.seq, to_timestamp(t.ms / 1000.0), t.lat, t.lon, t.x, t.y, t.h, t.zr, t.sh, t.hd, t.src, t.zs, t.zsig, t.hag, t.b, t.gu, t.gs, t.st
         FROM unnest($3::int[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::float8[],
                     $11::float8[], $12::float8[], $13::text[], $14::text[], $15::float8[], $16::float8[], $17::text[], $18::boolean[],
                     $19::bigint[], $20::boolean[])
           AS t(seq, ms, lat, lon, x, y, h, zr, sh, hd, src, zs, zsig, hag, b, gu, gs, st)`,
      [runId, stage, col('seq'), col('t'), col('latitude'), col('longitude'), col('x'), col('y'), col('h'), col('zRel'), col('sigmaH'),
        col('heading'), col('source'), col('zDatumSource'), col('zDatumSigma'), col('heightAboveGround'), col('buildingName'),
        col('gpsUsed'), col('gpsSequence'), col('stationary')],
    );
  }
}

export const fusionRunsRepository = {
  /** Stores a run's snapshot (one transaction): FORWARD only when it differs from FINAL (versions with a finalize step). */
  async saveSnapshot(client: PoolClient, runId: string, s: { forward: FusedOutput[] | null; final: FusedOutput[]; diagnostics: RunDiagnostics | null; geoidN?: number }) {
    await insertPositions(client, runId, 'FINAL', toRunPositions(s.final, s.geoidN));
    if (s.forward) await insertPositions(client, runId, 'FORWARD', toRunPositions(s.forward, s.geoidN));
    const d = s.diagnostics;
    if (d?.fixes.length) {
      const f = d.fixes;
      await client.query(
        `INSERT INTO fusion_run_fixes (run_id, location_sequence, "timestamp", forward_used, forward_reason, innovation_m, final_weight, final_residual_m)
         SELECT $1, t.seq, to_timestamp(t.ms / 1000.0), t.used, t.reason, t.inn, t.w, t.res
           FROM unnest($2::bigint[], $3::float8[], $4::boolean[], $5::text[], $6::float8[], $7::float8[], $8::float8[]) AS t(seq, ms, used, reason, inn, w, res)
         ON CONFLICT DO NOTHING`,
        [runId, f.map((x) => x.seq), f.map((x) => x.t), f.map((x) => x.forwardUsed), f.map((x) => x.forwardReason), f.map((x) => x.innovation),
          f.map((x) => x.finalWeight), f.map((x) => x.finalResidual)],
      );
    }
    if (d?.events.length) {
      for (let i = 0; i < d.events.length; i += 5000) {
        const e = d.events.slice(i, i + 5000);
        await client.query(
          `INSERT INTO fusion_run_events (run_id, "timestamp", event_type, details)
           SELECT $1, to_timestamp(t.ms / 1000.0), t.kind, t.details::jsonb FROM unnest($2::float8[], $3::text[], $4::text[]) AS t(ms, kind, details)`,
          [runId, e.map((x) => x.t), e.map((x) => x.type), e.map((x) => JSON.stringify(x.details))],
        );
      }
    }
    await client.query('UPDATE fusion_runs SET snapshot = true WHERE id = $1', [runId]);
  },

  async get(runId: string, db: DbClient = pool) {
    const { rows } = await db.query(`SELECT ${RUN_COLUMNS} FROM fusion_runs r WHERE r.id = $1`, [runId]);
    return rows[0] ?? null;
  },

  /** All snapshot runs of a session, newest first. */
  async listBySession(sessionId: string, db: DbClient = pool) {
    const { rows } = await db.query(`SELECT ${RUN_COLUMNS} FROM fusion_runs r WHERE r.session_id = $1 AND r.snapshot ORDER BY r.created_at DESC`, [sessionId]);
    return rows;
  },

  /** Latest completed snapshot of a session for a version/variant (published only when variant is null and published is asked). */
  async latest(sessionId: string, version: string, variant: string | null, db: DbClient = pool): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM fusion_runs WHERE session_id = $1 AND algorithm_version = $2 AND variant IS NOT DISTINCT FROM $3
          AND status = 'COMPLETED' AND snapshot AND mode = 'SENSOR_TIME' ORDER BY created_at DESC LIMIT 1`,
      [sessionId, version, variant],
    );
    return rows[0]?.id ?? null;
  },

  async positions(runId: string, stage: RunStage, db: DbClient = pool): Promise<RunPosition[]> {
    const { rows } = await db.query<RunPosition>(`SELECT ${POSITION_COLUMNS} FROM fusion_run_positions WHERE run_id = $1 AND stage = $2 ORDER BY seq`, [runId, stage]);
    return rows;
  },

  async fixes(runId: string, db: DbClient = pool) {
    const { rows } = await db.query(
      `SELECT location_sequence AS seq, (extract(epoch FROM "timestamp") * 1000)::float8 AS t, forward_used AS "forwardUsed", forward_reason AS "forwardReason",
              innovation_m AS innovation, final_weight AS "finalWeight", final_residual_m AS "finalResidual"
         FROM fusion_run_fixes WHERE run_id = $1 ORDER BY "timestamp", location_sequence`, [runId],
    );
    return rows;
  },

  async events(runId: string, db: DbClient = pool) {
    const { rows } = await db.query(
      `SELECT (extract(epoch FROM "timestamp") * 1000)::float8 AS t, event_type AS type, details FROM fusion_run_events WHERE run_id = $1 ORDER BY "timestamp", id`, [runId],
    );
    return rows;
  },

  async setFlags(runId: string, flags: { pinned?: boolean }, db: DbClient = pool) {
    await db.query('UPDATE fusion_runs SET pinned = COALESCE($2, pinned) WHERE id = $1', [runId, flags.pinned ?? null]);
  },

  /**
   * Deletes old snapshots: keeps pinned runs, runs referenced by route passes, and the newest `keep` per
   * (session, version, variant, mode). Raw data and fused_positions are never touched. Returns deleted run ids.
   */
  async prune(keep: number, dryRun: boolean, db: DbClient = pool): Promise<string[]> {
    const referenced = (await db.query<{ ok: boolean }>(`SELECT to_regclass('route_passes') IS NOT NULL AS ok`)).rows[0].ok;
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM (
         SELECT id, pinned, row_number() OVER (PARTITION BY session_id, algorithm_version, variant, mode ORDER BY created_at DESC) rn
           FROM fusion_runs WHERE snapshot) r
        WHERE rn > $1 AND NOT pinned ${referenced ? 'AND NOT EXISTS (SELECT 1 FROM route_passes p WHERE p.run_id = r.id)' : ''}`,
      [keep],
    );
    const ids = rows.map((r) => r.id);
    if (!dryRun && ids.length) await db.query('DELETE FROM fusion_runs WHERE id = ANY($1::uuid[])', [ids]);
    return ids;
  },

  /**
   * Raw samples regrouped into the batches the server committed: rows inserted in one transaction share created_at.
   * Batches are returned in arrival order (AS_RECEIVED replay).
   */
  async loadArrivalBatches(sessionId: string, db: DbClient = pool): Promise<RawSamples[]> {
    const [loc, mot, alt, ped] = await Promise.all([
      db.query(`SELECT created_at::text AS b, sequence, "timestamp", latitude, longitude, altitude, ellipsoidal_altitude AS "ellipsoidalAltitude",
                       horizontal_accuracy AS "horizontalAccuracy", vertical_accuracy AS "verticalAccuracy", speed, course
                  FROM location_samples WHERE session_id = $1`, [sessionId]),
      db.query(`SELECT created_at::text AS b, sequence, "timestamp", attitude_yaw AS yaw, user_acceleration_x AS ax, user_acceleration_y AS ay,
                       user_acceleration_z AS az, rotation_rate_x AS rx, rotation_rate_y AS ry, rotation_rate_z AS rz, gravity_x AS gx, gravity_y AS gy,
                       gravity_z AS gz, attitude_roll AS roll, attitude_pitch AS pitch, sensor_segment_id AS segment
                  FROM motion_samples WHERE session_id = $1`, [sessionId]),
      db.query(`SELECT created_at::text AS b, sequence, "timestamp", relative_altitude AS "relativeAltitude", sensor_segment_id AS segment
                  FROM altimeter_samples WHERE session_id = $1`, [sessionId]),
      db.query(`SELECT created_at::text AS b, "timestamp", distance, number_of_steps AS "numberOfSteps", sensor_segment_id AS segment
                  FROM pedometer_samples WHERE session_id = $1 ORDER BY "timestamp", id`, [sessionId]),
    ]);
    const batches = new Map<string, RawSamples>();
    const get = (b: string) => {
      let r = batches.get(b);
      if (!r) batches.set(b, (r = { locations: [], motion: [], altimeter: [], pedometer: [] }));
      return r;
    };
    for (const r of loc.rows) get(r.b).locations.push(r);
    for (const r of mot.rows) get(r.b).motion.push(r);
    for (const r of alt.rows) get(r.b).altimeter.push(r);
    for (const r of ped.rows) get(r.b).pedometer.push(r);
    return [...batches.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]);
  },
};
