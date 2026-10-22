import type { PoolClient } from 'pg';
import { pool, type DbClient } from '../../config/database.js';
import type { AnchorCreate, AnchorUpdate, BeaconCreate, BeaconUpdate, CalibrationUpsert } from './beacon.dto.js';
import type { CalibrationRow } from './beacon-calibration.js';

export interface AnchorView {
  anchorId: string;
  anchorType: 'BEACON';
  buildingId: string;
  floor: string | null;
  floorHeightM: number | null;
  /** EPSG:5186 metres, z = MSL (KVD Incheon) */
  position: { x: number; y: number; z: number };
  horizontalAccuracyM: number;
  verticalAccuracyM: number;
  status: 'ACTIVE' | 'INACTIVE';
  label: string | null;
  updatedAt: string;
}

export interface BeaconView {
  beaconId: string;
  protocol: 'IBEACON';
  uuid: string;
  major: number;
  minor: number;
  measuredPowerDbm: number | null;
  enabled: boolean;
  lastObservedAt: string | null;
  label: string | null;
  anchor: AnchorView | null;
  updatedAt: string;
  disabledAt: string | null;
}

/** A registry entry as an incoming observation sees it. */
export interface BeaconIdentity {
  key: string;
  beaconId: string;
  enabled: boolean;
  anchorActive: boolean;
}

const ANCHOR_COLUMNS = `a.id AS "anchorId", a.anchor_type AS "anchorType", a.building_id AS "buildingId", a.floor,
  a.floor_height_m AS "floorHeightM", ST_X(a.geom)::float8 AS ax, ST_Y(a.geom)::float8 AS ay, ST_Z(a.geom)::float8 AS az,
  a.horizontal_accuracy_m AS "horizontalAccuracyM", a.vertical_accuracy_m AS "verticalAccuracyM", a.status, a.label AS "anchorLabel",
  a.updated_at AS "anchorUpdatedAt"`;

const BEACON_SELECT = `SELECT b.id AS "beaconId", b.protocol, b.uuid::text AS uuid, b.major, b.minor,
  b.measured_power_dbm AS "measuredPowerDbm", b.enabled, b.last_observed_at AS "lastObservedAt", b.label,
  b.updated_at AS "updatedAt", b.disabled_at AS "disabledAt", ${ANCHOR_COLUMNS}
  FROM positioning.beacon_devices b LEFT JOIN positioning.spatial_anchors a ON a.id = b.anchor_id`;

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

function toAnchor(r: Row): AnchorView | null {
  if (!r.anchorId) return null;
  return {
    anchorId: String(r.anchorId), anchorType: 'BEACON', buildingId: String(r.buildingId), floor: (r.floor as string) ?? null,
    floorHeightM: (r.floorHeightM as number) ?? null, position: { x: Number(r.ax), y: Number(r.ay), z: Number(r.az) },
    horizontalAccuracyM: Number(r.horizontalAccuracyM), verticalAccuracyM: Number(r.verticalAccuracyM),
    status: r.status as AnchorView['status'], label: (r.anchorLabel as string) ?? null, updatedAt: iso(r.anchorUpdatedAt)!,
  };
}

function toBeacon(r: Row): BeaconView {
  return {
    beaconId: String(r.beaconId), protocol: 'IBEACON', uuid: String(r.uuid), major: Number(r.major), minor: Number(r.minor),
    measuredPowerDbm: (r.measuredPowerDbm as number) ?? null, enabled: Boolean(r.enabled), lastObservedAt: iso(r.lastObservedAt),
    label: (r.label as string) ?? null, anchor: toAnchor(r), updatedAt: iso(r.updatedAt)!, disabledAt: iso(r.disabledAt),
  };
}

export const beaconRepository = {
  async revision(db: DbClient = pool): Promise<{ revision: number; updatedAt: Date }> {
    const { rows } = await db.query<{ revision: string; updated_at: Date }>('SELECT revision, updated_at FROM positioning.registry_state WHERE id = 1');
    return { revision: Number(rows[0].revision), updatedAt: rows[0].updated_at };
  },

  /** Every registry change bumps the config version in its own transaction. */
  async bump(db: PoolClient) {
    await db.query('UPDATE positioning.registry_state SET revision = revision + 1, updated_at = now() WHERE id = 1');
  },

  async listBeacons(opts: { includeDisabled: boolean; buildingId?: string }, db: DbClient = pool): Promise<BeaconView[]> {
    const { rows } = await db.query<Row>(
      `${BEACON_SELECT} WHERE ($1 OR b.enabled) AND ($2::text IS NULL OR a.building_id = $2)
        ORDER BY b.uuid, b.major, b.minor`, [opts.includeDisabled, opts.buildingId ?? null]);
    return rows.map(toBeacon);
  },

  async findBeacon(beaconId: string, db: DbClient = pool): Promise<BeaconView | null> {
    const { rows } = await db.query<Row>(`${BEACON_SELECT} WHERE b.id = $1`, [beaconId]);
    return rows[0] ? toBeacon(rows[0]) : null;
  },

  async listAnchors(db: DbClient = pool): Promise<AnchorView[]> {
    const { rows } = await db.query<Row>(`SELECT ${ANCHOR_COLUMNS} FROM positioning.spatial_anchors a ORDER BY a.building_id, a.floor, a.id`);
    return rows.map((r) => toAnchor(r)!);
  },

  async findAnchor(anchorId: string, db: DbClient = pool): Promise<AnchorView | null> {
    const { rows } = await db.query<Row>(`SELECT ${ANCHOR_COLUMNS} FROM positioning.spatial_anchors a WHERE a.id = $1`, [anchorId]);
    return rows[0] ? toAnchor(rows[0]) : null;
  },

  async insertAnchor(db: PoolClient, a: AnchorCreate, actor: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO positioning.spatial_anchors (anchor_type, building_id, floor, floor_height_m, geom, horizontal_accuracy_m,
         vertical_accuracy_m, label, created_by, updated_by)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6, $7), 5186), $8, $9, $10, $11, $11) RETURNING id`,
      [a.anchorType, a.buildingId, a.floor ?? null, a.floorHeightM ?? null, a.position.x, a.position.y, a.position.z,
        a.horizontalAccuracyM, a.verticalAccuracyM, a.label ?? null, actor]);
    return rows[0].id;
  },

  async updateAnchor(db: PoolClient, anchorId: string, u: AnchorUpdate, actor: string): Promise<boolean> {
    const has = (k: keyof AnchorUpdate) => Object.prototype.hasOwnProperty.call(u, k);
    const { rowCount } = await db.query(
      `UPDATE positioning.spatial_anchors SET
         building_id = COALESCE($2, building_id),
         floor = CASE WHEN $3 THEN $4 ELSE floor END,
         floor_height_m = CASE WHEN $5 THEN $6 ELSE floor_height_m END,
         geom = CASE WHEN $7::float8 IS NULL THEN geom ELSE ST_SetSRID(ST_MakePoint($7, $8, $9), 5186) END,
         horizontal_accuracy_m = COALESCE($10, horizontal_accuracy_m),
         vertical_accuracy_m = COALESCE($11, vertical_accuracy_m),
         status = COALESCE($12, status),
         label = CASE WHEN $13 THEN $14 ELSE label END,
         updated_by = $15, updated_at = now()
       WHERE id = $1`,
      [anchorId, u.buildingId ?? null, has('floor'), u.floor ?? null, has('floorHeightM'), u.floorHeightM ?? null,
        u.position?.x ?? null, u.position?.y ?? null, u.position?.z ?? null, u.horizontalAccuracyM ?? null,
        u.verticalAccuracyM ?? null, u.status ?? null, has('label'), u.label ?? null, actor]);
    return (rowCount ?? 0) > 0;
  },

  /** beacons linked to an anchor (an anchor may be shared) */
  async anchorUsers(db: DbClient, anchorId: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM positioning.beacon_devices WHERE anchor_id = $1', [anchorId]);
    return rows[0].n;
  },

  /** replace every placement field of an anchor (an edit from the registration screens) */
  async replaceAnchor(db: PoolClient, anchorId: string, a: AnchorCreate, actor: string): Promise<void> {
    await db.query(
      `UPDATE positioning.spatial_anchors SET building_id = $2, floor = $3, floor_height_m = $4, geom = ST_SetSRID(ST_MakePoint($5, $6, $7), 5186),
         horizontal_accuracy_m = $8, vertical_accuracy_m = $9, label = COALESCE($10, label), updated_by = $11, updated_at = now()
       WHERE id = $1`,
      [anchorId, a.buildingId, a.floor ?? null, a.floorHeightM ?? null, a.position.x, a.position.y, a.position.z,
        a.horizontalAccuracyM, a.verticalAccuracyM, a.label ?? null, actor]);
  },

  /**
   * Permanent delete. Observations keep their identifier (fusion joins by identifier) and read as unregistered again;
   * per-beacon calibrations go; the anchor goes too when no other beacon uses it.
   */
  async deleteBeacon(db: PoolClient, beaconId: string): Promise<boolean> {
    const { rows } = await db.query<{ anchor_id: string | null }>('SELECT anchor_id FROM positioning.beacon_devices WHERE id = $1 FOR UPDATE', [beaconId]);
    if (!rows[0]) return false;
    await db.query(`UPDATE positioning.beacon_observations SET beacon_id = NULL, resolution = 'UNREGISTERED' WHERE beacon_id = $1`, [beaconId]);
    await db.query('DELETE FROM positioning.beacon_calibrations WHERE beacon_id = $1', [beaconId]);
    await db.query('DELETE FROM positioning.beacon_devices WHERE id = $1', [beaconId]);
    const anchorId = rows[0].anchor_id;
    if (anchorId && (await this.anchorUsers(db, anchorId)) === 0) await db.query('DELETE FROM positioning.spatial_anchors WHERE id = $1', [anchorId]);
    return true;
  },

  async insertBeacon(db: PoolClient, b: BeaconCreate, anchorId: string | null, actor: string): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO positioning.beacon_devices (anchor_id, protocol, uuid, major, minor, measured_power_dbm, enabled, label, created_by, updated_by,
         disabled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, CASE WHEN $7 THEN NULL ELSE now() END)
       ON CONFLICT (protocol, uuid, major, minor) DO NOTHING RETURNING id`,
      [anchorId, b.protocol, b.uuid.toLowerCase(), b.major, b.minor, b.measuredPowerDbm ?? null, b.enabled, b.label ?? null, actor]);
    return rows[0]?.id ?? null;
  },

  async findBeaconByIdentity(protocol: string, uuid: string, major: number, minor: number, db: DbClient = pool): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM positioning.beacon_devices WHERE protocol = $1 AND uuid = $2 AND major = $3 AND minor = $4',
      [protocol, uuid.toLowerCase(), major, minor]);
    return rows[0]?.id ?? null;
  },

  async updateBeacon(db: PoolClient, beaconId: string, u: BeaconUpdate, actor: string): Promise<boolean> {
    const has = (k: keyof BeaconUpdate) => Object.prototype.hasOwnProperty.call(u, k);
    const { rowCount } = await db.query(
      `UPDATE positioning.beacon_devices SET
         measured_power_dbm = CASE WHEN $2 THEN $3 ELSE measured_power_dbm END,
         anchor_id = CASE WHEN $4 THEN $5::uuid ELSE anchor_id END,
         enabled = COALESCE($6, enabled),
         disabled_at = CASE WHEN $6 IS NULL THEN disabled_at WHEN $6 THEN NULL ELSE COALESCE(disabled_at, now()) END,
         label = CASE WHEN $7 THEN $8 ELSE label END,
         updated_by = $9, updated_at = now()
       WHERE id = $1`,
      [beaconId, has('measuredPowerDbm'), u.measuredPowerDbm ?? null, has('anchorId'), u.anchorId ?? null,
        u.enabled ?? null, has('label'), u.label ?? null, actor]);
    return (rowCount ?? 0) > 0;
  },

  async upsertCalibration(db: PoolClient, c: CalibrationUpsert, actor: string) {
    await db.query(
      `INSERT INTO positioning.beacon_calibrations (beacon_id, platform, device_group, measured_power_1m, path_loss_exponent,
         rssi_variance_db2, sample_count, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (beacon_id, platform, device_group) DO UPDATE SET measured_power_1m = EXCLUDED.measured_power_1m,
         path_loss_exponent = EXCLUDED.path_loss_exponent, rssi_variance_db2 = EXCLUDED.rssi_variance_db2,
         sample_count = EXCLUDED.sample_count, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [c.beaconId ?? null, c.platform, c.deviceGroup, c.measuredPower1m, c.pathLossExponent, c.rssiVariance, c.sampleCount, actor]);
  },

  async calibrations(db: DbClient = pool): Promise<CalibrationRow[]> {
    const { rows } = await db.query<CalibrationRow>(
      `SELECT beacon_id AS "beaconId", platform, device_group AS "deviceGroup", measured_power_1m AS "measuredPower1m",
              path_loss_exponent AS "pathLossExponent", rssi_variance_db2 AS "rssiVariance", sample_count AS "sampleCount"
         FROM positioning.beacon_calibrations ORDER BY beacon_id NULLS FIRST, platform, device_group`);
    return rows;
  },

  /** Registry entries for the identifiers of one batch (one query). */
  async resolve(keys: { uuid: string; major: number; minor: number }[], db: DbClient = pool): Promise<Map<string, BeaconIdentity>> {
    if (!keys.length) return new Map();
    const { rows } = await db.query<{ id: string; uuid: string; major: number; minor: number; enabled: boolean; anchor_active: boolean }>(
      `SELECT b.id, b.uuid::text AS uuid, b.major, b.minor, b.enabled, COALESCE(a.status = 'ACTIVE', false) AS anchor_active
         FROM positioning.beacon_devices b LEFT JOIN positioning.spatial_anchors a ON a.id = b.anchor_id
         JOIN unnest($1::uuid[], $2::int[], $3::int[]) AS k(uuid, major, minor)
           ON b.protocol = 'IBEACON' AND b.uuid = k.uuid AND b.major = k.major AND b.minor = k.minor`,
      [keys.map((k) => k.uuid.toLowerCase()), keys.map((k) => k.major), keys.map((k) => k.minor)]);
    return new Map(rows.map((r) => {
      const key = `IBEACON:${r.uuid}:${r.major}:${r.minor}`;
      return [key, { key, beaconId: r.id, enabled: r.enabled, anchorActive: r.anchor_active }];
    }));
  },

  async insertBatch(db: PoolClient, b: { batchId: string; sessionId: string; deviceId: string; schemaVersion: number; platform: string;
    clientCreatedAt: string | null; observationCount: number }): Promise<Date | null> {
    const { rows } = await db.query<{ received_at: Date }>(
      `INSERT INTO positioning.beacon_observation_batches (batch_id, session_id, device_id, schema_version, platform, client_created_at,
         observation_count, inserted_count, registered_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0) ON CONFLICT (batch_id) DO NOTHING RETURNING received_at`,
      [b.batchId, b.sessionId, b.deviceId, b.schemaVersion, b.platform, b.clientCreatedAt, b.observationCount]);
    return rows[0]?.received_at ?? null;
  },

  async findBatch(db: DbClient, batchId: string) {
    const { rows } = await db.query<{ session_id: string; received_at: Date; observation_count: number; inserted_count: number; registered_count: number }>(
      'SELECT session_id, received_at, observation_count, inserted_count, registered_count FROM positioning.beacon_observation_batches WHERE batch_id = $1',
      [batchId]);
    return rows[0] ?? null;
  },

  async finishBatch(db: PoolClient, batchId: string, inserted: number, registered: number) {
    await db.query('UPDATE positioning.beacon_observation_batches SET inserted_count = $2, registered_count = $3 WHERE batch_id = $1',
      [batchId, inserted, registered]);
  },

  /** unnest insert; (session, observation_id) duplicates are skipped. Returns the observation ids actually inserted. */
  async insertObservations(db: PoolClient, sessionId: string, batchId: string, platform: string, rows: {
    observationId: string; protocol: string; uuid: string; major: number; minor: number; beaconId: string | null; resolution: string;
    rssiDbm: number; observedAt: string; deviceModel: string | null; proximity: string | null; platformDistanceM: number | null;
    measuredPowerDbm: number | null; timeUncertaintyMs: number | null; rssiAggregation: string | null; sampleCount: number | null;
  }[]): Promise<Set<string>> {
    if (!rows.length) return new Set();
    const col = <K extends keyof (typeof rows)[number]>(k: K) => rows.map((r) => r[k]);
    const { rows: inserted } = await db.query<{ observation_id: string }>(
      `INSERT INTO positioning.beacon_observations (session_id, batch_id, platform, observation_id, protocol, uuid, major, minor, beacon_id,
         resolution, rssi_dbm, observed_at, device_model, proximity, platform_distance_m, measured_power_dbm,
         observation_time_uncertainty_ms, rssi_aggregation, sample_count)
       SELECT $1, $2, $3, t.oid, t.protocol, t.uuid, t.major, t.minor, t.beacon_id, t.resolution, t.rssi, t.observed_at,
              t.model, t.proximity, t.distance, t.power, t.uncertainty, t.aggregation, t.samples
         FROM unnest($4::uuid[], $5::text[], $6::uuid[], $7::int[], $8::int[], $9::uuid[], $10::text[], $11::smallint[],
                     $12::timestamptz[], $13::text[], $14::text[], $15::float8[], $16::smallint[], $17::float8[], $18::text[], $19::int[])
           AS t(oid, protocol, uuid, major, minor, beacon_id, resolution, rssi, observed_at, model, proximity, distance, power,
                uncertainty, aggregation, samples)
       ON CONFLICT (session_id, observation_id) DO NOTHING RETURNING observation_id`,
      [sessionId, batchId, platform, col('observationId'), col('protocol'), col('uuid'), col('major'), col('minor'), col('beaconId'),
        col('resolution'), col('rssiDbm'), col('observedAt'), col('deviceModel'), col('proximity'), col('platformDistanceM'),
        col('measuredPowerDbm'), col('timeUncertaintyMs'), col('rssiAggregation'), col('sampleCount')]);
    return new Set(inserted.map((r) => r.observation_id.toLowerCase()));
  },

  async touchLastObserved(db: PoolClient, seen: Map<string, string>) {
    if (!seen.size) return;
    await db.query(
      `UPDATE positioning.beacon_devices b SET last_observed_at = GREATEST(b.last_observed_at, t.at)
         FROM unnest($1::uuid[], $2::timestamptz[]) AS t(id, at) WHERE b.id = t.id`,
      [[...seen.keys()], [...seen.values()]]);
  },

  async surveyUuids(db: DbClient = pool): Promise<{ uuid: string; label: string | null; createdBy: string | null; createdAt: string }[]> {
    const { rows } = await db.query(`SELECT uuid::text AS uuid, label, created_by AS "createdBy", created_at AS "createdAt"
      FROM positioning.survey_uuids ORDER BY created_at`);
    return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt)! }));
  },

  async addSurveyUuid(db: PoolClient, uuid: string, label: string | null, actor: string): Promise<boolean> {
    const { rowCount } = await db.query(`INSERT INTO positioning.survey_uuids (uuid, label, created_by) VALUES ($1, $2, $3)
      ON CONFLICT (uuid) DO UPDATE SET label = EXCLUDED.label`, [uuid.toLowerCase(), label, actor]);
    return (rowCount ?? 0) > 0;
  },

  async removeSurveyUuid(db: PoolClient, uuid: string): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM positioning.survey_uuids WHERE uuid = $1', [uuid.toLowerCase()]);
    return (rowCount ?? 0) > 0;
  },

  /**
   * Identifiers the apps heard that are not registered (yet), newest first, with where the phone was when the signal
   * was strongest: the fused position of that session within 10 s of that observation (a starting point for the anchor,
   * not a survey: the beacon is somewhere within a few metres of it).
   */
  async discovered(sinceHours: number, limit: number, fusionVersion: string, db: DbClient = pool) {
    const { rows } = await db.query(
      `WITH obs AS (
         SELECT o.uuid::text AS uuid, o.major, o.minor, o.session_id, o.observed_at, o.rssi_dbm, o.platform, o.measured_power_dbm
           FROM positioning.beacon_observations o
          WHERE o.resolution = 'UNREGISTERED' AND o.observed_at > now() - make_interval(hours => $1::int)
            AND NOT EXISTS (SELECT 1 FROM positioning.beacon_devices b
                             WHERE b.protocol = 'IBEACON' AND b.uuid = o.uuid AND b.major = o.major AND b.minor = o.minor)),
       agg AS (
         SELECT uuid, major, minor, count(*)::int AS observations, count(DISTINCT session_id)::int AS sessions,
                max(rssi_dbm)::int AS "maxRssiDbm", min(observed_at) AS "firstSeenAt", max(observed_at) AS "lastSeenAt",
                max(measured_power_dbm)::int AS "measuredPowerDbm", array_agg(DISTINCT platform) AS platforms
           FROM obs GROUP BY uuid, major, minor),
       best AS (
         SELECT DISTINCT ON (uuid, major, minor) uuid, major, minor, session_id, observed_at
           FROM obs ORDER BY uuid, major, minor, rssi_dbm DESC, observed_at DESC)
       SELECT a.*, best.observed_at AS "strongestAt", p.latitude, p.longitude, p.horizontal_uncertainty AS "horizontalUncertaintyM",
              p.floor_label AS floor, p.building_id AS "buildingId"
         FROM agg a JOIN best USING (uuid, major, minor)
         LEFT JOIN LATERAL (
           SELECT f.latitude, f.longitude, f.horizontal_uncertainty, f.floor_label, f.building_id FROM fused_positions f
            WHERE f.session_id = best.session_id AND f.algorithm_version = $3
              AND f."timestamp" BETWEEN best.observed_at - interval '10 seconds' AND best.observed_at + interval '10 seconds'
            ORDER BY abs(extract(epoch FROM f."timestamp" - best.observed_at)) LIMIT 1) p ON true
        ORDER BY a."lastSeenAt" DESC LIMIT $2`,
      [sinceHours, limit, fusionVersion]);
    return rows.map((r) => ({
      uuid: r.uuid, major: r.major, minor: r.minor, observations: r.observations, sessions: r.sessions, maxRssiDbm: r.maxRssiDbm,
      measuredPowerDbm: r.measuredPowerDbm, platforms: r.platforms, firstSeenAt: iso(r.firstSeenAt), lastSeenAt: iso(r.lastSeenAt),
      suggestedPosition: r.latitude == null ? null : {
        latitude: r.latitude, longitude: r.longitude, horizontalUncertaintyM: r.horizontalUncertaintyM, floor: r.floor ?? null,
        buildingId: r.buildingId ?? null, at: iso(r.strongestAt) },
    }));
  },

  /** Raw rows of a session for the API (paged by id). */
  async sessionObservations(sessionId: string, afterId: number, limit: number, db: DbClient = pool) {
    const { rows } = await db.query(
      `SELECT id, observation_id AS "observationId", batch_id AS "batchId", protocol, uuid::text AS uuid, major, minor,
              beacon_id AS "beaconId", resolution, rssi_dbm AS "rssiDbm", observed_at AS "observedAt", platform,
              device_model AS "deviceModel", proximity, platform_distance_m AS "platformEstimatedDistanceMeters",
              measured_power_dbm AS "measuredPowerDbm", observation_time_uncertainty_ms AS "observationTimeUncertaintyMs",
              rssi_aggregation AS "rssiAggregation", sample_count AS "sampleCount", created_at AS "receivedAt"
         FROM positioning.beacon_observations WHERE session_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [sessionId, afterId, limit]);
    return rows;
  },
};
