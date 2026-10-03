import type { PoolClient } from 'pg';
import type { AltimeterSample, LocationSample, MotionSample, PedometerSample } from './telemetry.dto.js';

// All sample inserts use INSERT ... SELECT FROM unnest($1::type[], $2::type[], ...):
// one statement per table per batch, with a constant number of bind parameters
// (one array per column) regardless of how many samples the batch has.
// ON CONFLICT DO NOTHING on (session_id, sequence) gives sample-level idempotency on top of batch_id.

const n = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

/** Background metadata columns (already resolved by the service: sample value > batch value > default). */
type Meta = { captureSource?: string | null; appState?: string | null; sensorSegmentId?: string | null };
const meta = (samples: Meta[]) => [
  samples.map((s) => s.captureSource ?? 'LIVE'),
  samples.map((s) => s.appState ?? 'UNKNOWN'),
  samples.map((s) => s.sensorSegmentId ?? null),
];

export const telemetryRepository = {
  /**
   * Idempotency gate. Returns the new row, or null when batch_id was already committed.
   * A concurrent transaction inserting the same batch_id blocks here until it commits/rolls back.
   */
  async insertReceivedBatch(
    db: PoolClient,
    data: {
      batchId: string;
      sessionId: string;
      clientCreatedAt: string | null;
      counts: { locations: number; motion: number; altimeter: number; pedometer: number };
      captureSource: string | null;
      appState: string | null;
      minCapturedAt: string | null;
      maxCapturedAt: string | null;
    },
  ): Promise<{ received_at: Date } | null> {
    const { rows } = await db.query<{ received_at: Date }>(
      `INSERT INTO received_batches (batch_id, session_id, client_created_at, location_count, motion_count, altimeter_count, pedometer_count,
                                     capture_source, app_state, min_captured_at, max_captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (batch_id) DO NOTHING
       RETURNING received_at`,
      [
        data.batchId, data.sessionId, data.clientCreatedAt, data.counts.locations, data.counts.motion, data.counts.altimeter, data.counts.pedometer,
        data.captureSource, data.appState, data.minCapturedAt, data.maxCapturedAt,
      ],
    );
    return rows[0] ?? null;
  },

  async markBatchOutOfOrder(db: PoolClient, batchId: string) {
    await db.query('UPDATE received_batches SET out_of_order = true WHERE batch_id = $1', [batchId]);
  },

  async findReceivedBatch(db: PoolClient, batchId: string): Promise<{ session_id: string; received_at: Date } | null> {
    const { rows } = await db.query<{ session_id: string; received_at: Date }>(
      'SELECT session_id, received_at FROM received_batches WHERE batch_id = $1',
      [batchId],
    );
    return rows[0] ?? null;
  },

  /**
   * geom = PointZ(X = longitude, Y = latitude, Z = height), SRID 4326.
   * Z policy:
   *   1. ellipsoidal_altitude (WGS84 ellipsoid height) when present — matches Cesium/VWorld heights.
   *   2. else altitude (MSL / orthometric height) as a fallback; it is ~20–30 m lower than the
   *      ellipsoid height in Korea (geoid undulation), so such points render slightly low.
   *   3. else 0.
   * The raw altitude / ellipsoidal_altitude columns are always stored as received, so the source
   * of Z for any row is recoverable and geom can be rebuilt later.
   * Returns the sequences actually inserted (duplicates are skipped).
   */
  async insertLocations(db: PoolClient, sessionId: string, samples: LocationSample[]): Promise<number[]> {
    if (samples.length === 0) return [];
    const { rows } = await db.query<{ sequence: number }>(
      `INSERT INTO location_samples (
         session_id, sequence, "timestamp", latitude, longitude, altitude, ellipsoidal_altitude,
         horizontal_accuracy, vertical_accuracy, speed, speed_accuracy, course, course_accuracy, floor_level, geom,
         capture_source, app_state, sensor_segment_id)
       SELECT $1, t.seq, t.ts, t.lat, t.lon, t.alt, t.ell, t.hacc, t.vacc, t.spd, t.spdacc, t.crs, t.crsacc, t.floor,
              ST_SetSRID(ST_MakePoint(t.lon, t.lat, COALESCE(t.ell, t.alt, 0)), 4326),
              t.src, t.app, t.seg
         FROM unnest($2::bigint[], $3::timestamptz[], $4::float8[], $5::float8[], $6::float8[], $7::float8[],
                     $8::float8[], $9::float8[], $10::float8[], $11::float8[], $12::float8[], $13::float8[], $14::int[],
                     $15::text[], $16::text[], $17::text[])
              AS t(seq, ts, lat, lon, alt, ell, hacc, vacc, spd, spdacc, crs, crsacc, floor, src, app, seg)
       ON CONFLICT (session_id, sequence) DO NOTHING
       RETURNING sequence`,
      [
        sessionId,
        samples.map((s) => s.sequence),
        samples.map((s) => s.timestamp),
        samples.map((s) => s.latitude),
        samples.map((s) => s.longitude),
        samples.map((s) => n(s.altitude)),
        samples.map((s) => n(s.ellipsoidalAltitude)),
        samples.map((s) => n(s.horizontalAccuracy)),
        samples.map((s) => n(s.verticalAccuracy)),
        samples.map((s) => n(s.speed)),
        samples.map((s) => n(s.speedAccuracy)),
        samples.map((s) => n(s.course)),
        samples.map((s) => n(s.courseAccuracy)),
        samples.map((s) => n(s.floor)),
        ...meta(samples),
      ],
    );
    return rows.map((r) => r.sequence);
  },

  async insertMotion(db: PoolClient, sessionId: string, samples: MotionSample[]): Promise<number> {
    if (samples.length === 0) return 0;
    const { rowCount } = await db.query(
      `INSERT INTO motion_samples (
         session_id, sequence, "timestamp",
         user_acceleration_x, user_acceleration_y, user_acceleration_z,
         rotation_rate_x, rotation_rate_y, rotation_rate_z,
         gravity_x, gravity_y, gravity_z,
         attitude_roll, attitude_pitch, attitude_yaw,
         capture_source, app_state, sensor_segment_id)
       SELECT $1, t.*
         FROM unnest($2::bigint[], $3::timestamptz[],
                     $4::float8[], $5::float8[], $6::float8[],
                     $7::float8[], $8::float8[], $9::float8[],
                     $10::float8[], $11::float8[], $12::float8[],
                     $13::float8[], $14::float8[], $15::float8[],
                     $16::text[], $17::text[], $18::text[]) AS t
       ON CONFLICT (session_id, sequence) DO NOTHING`,
      [
        sessionId,
        samples.map((s) => s.sequence),
        samples.map((s) => s.timestamp),
        samples.map((s) => n(s.userAcceleration?.x)),
        samples.map((s) => n(s.userAcceleration?.y)),
        samples.map((s) => n(s.userAcceleration?.z)),
        samples.map((s) => n(s.rotationRate?.x)),
        samples.map((s) => n(s.rotationRate?.y)),
        samples.map((s) => n(s.rotationRate?.z)),
        samples.map((s) => n(s.gravity?.x)),
        samples.map((s) => n(s.gravity?.y)),
        samples.map((s) => n(s.gravity?.z)),
        samples.map((s) => n(s.attitude?.roll)),
        samples.map((s) => n(s.attitude?.pitch)),
        samples.map((s) => n(s.attitude?.yaw)),
        ...meta(samples),
      ],
    );
    return rowCount ?? 0;
  },

  async insertAltimeter(db: PoolClient, sessionId: string, samples: AltimeterSample[]): Promise<number> {
    if (samples.length === 0) return 0;
    const { rowCount } = await db.query(
      `INSERT INTO altimeter_samples (session_id, sequence, "timestamp", relative_altitude, pressure, capture_source, app_state, sensor_segment_id)
       SELECT $1, t.* FROM unnest($2::bigint[], $3::timestamptz[], $4::float8[], $5::float8[], $6::text[], $7::text[], $8::text[]) AS t
       ON CONFLICT (session_id, sequence) DO NOTHING`,
      [
        sessionId,
        samples.map((s) => s.sequence),
        samples.map((s) => s.timestamp),
        samples.map((s) => n(s.relativeAltitude)),
        samples.map((s) => n(s.pressure)),
        ...meta(samples),
      ],
    );
    return rowCount ?? 0;
  },

  async insertPedometer(db: PoolClient, sessionId: string, samples: PedometerSample[]): Promise<number> {
    if (samples.length === 0) return 0;
    const { rowCount } = await db.query(
      `INSERT INTO pedometer_samples (
         session_id, "timestamp", number_of_steps, distance, current_pace, current_cadence, floors_ascended, floors_descended,
         sequence, capture_source, app_state, sensor_segment_id)
       SELECT $1, t.* FROM unnest($2::timestamptz[], $3::int[], $4::float8[], $5::float8[], $6::float8[], $7::int[], $8::int[],
                                  $9::bigint[], $10::text[], $11::text[], $12::text[]) AS t
       ON CONFLICT (session_id, "timestamp") DO NOTHING`,
      [
        sessionId,
        samples.map((s) => s.timestamp),
        samples.map((s) => n(s.numberOfSteps)),
        samples.map((s) => n(s.distance)),
        samples.map((s) => n(s.currentPace)),
        samples.map((s) => n(s.currentCadence)),
        samples.map((s) => n(s.floorsAscended)),
        samples.map((s) => n(s.floorsDescended)),
        samples.map((s) => n(s.sequence)),
        ...meta(samples),
      ],
    );
    return rowCount ?? 0;
  },
};
