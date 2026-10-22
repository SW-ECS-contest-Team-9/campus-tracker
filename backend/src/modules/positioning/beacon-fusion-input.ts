// Registered beacon observations -> fusion inputs (anchor + RSSI model resolved). Used by the realtime path (after an
// ingest COMMIT) and by replays (fusionRepository.loadRawSamples), so both see the same measurement for the same row.
import { pool, type DbClient } from '../../config/database.js';
import type { BeaconRawSample } from '../fusion/fusion.timeline.js';
import { BEACON_RSSI_DEFAULTS, selectRssiModel, type CalibrationRow } from './beacon-calibration.js';
import { beaconRepository } from './beacon.repository.js';

export interface BeaconFusionRow {
  observationId: string;
  timestamp: Date | string;
  beaconId: string;
  rssi: number;
  platform: string;
  deviceModel: string | null;
  sampleCount: number | null;
  advertisedPower: number | null;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  buildingId: string;
  floor: string | null;
  floorHeightM: number | null;
  anchorHorizontalAccuracyM: number;
}

/** Pure: attaches the most specific RSSI model to every row. */
export function toFusionBeacons(rows: BeaconFusionRow[], calibrations: CalibrationRow[]): BeaconRawSample[] {
  return rows.map((r) => {
    const m = selectRssiModel(calibrations, r.beaconId, r.platform, r.deviceModel, r.advertisedPower, BEACON_RSSI_DEFAULTS);
    return {
      observationId: r.observationId, timestamp: r.timestamp, beaconId: r.beaconId, rssi: r.rssi, platform: r.platform,
      anchorX: r.anchorX, anchorY: r.anchorY, anchorZ: r.anchorZ, buildingId: r.buildingId, floor: r.floor, floorHeightM: r.floorHeightM,
      anchorHorizontalAccuracyM: r.anchorHorizontalAccuracyM, measuredPower1m: m.measuredPower1m, pathLossExponent: m.pathLossExponent,
      rssiVariance: m.rssiVariance, sampleCount: r.sampleCount,
    };
  });
}

const FUSION_SELECT = `SELECT o.observation_id::text AS "observationId", o.observed_at AS "timestamp", b.id AS "beaconId", o.rssi_dbm AS rssi,
    o.platform, o.device_model AS "deviceModel", o.sample_count AS "sampleCount",
    COALESCE(o.measured_power_dbm, b.measured_power_dbm) AS "advertisedPower",
    ST_X(a.geom)::float8 AS "anchorX", ST_Y(a.geom)::float8 AS "anchorY", ST_Z(a.geom)::float8 AS "anchorZ",
    a.building_id AS "buildingId", a.floor, a.floor_height_m AS "floorHeightM", a.horizontal_accuracy_m AS "anchorHorizontalAccuracyM"
  FROM positioning.beacon_observations o
  -- by identity, not by the beacon_id resolved at ingest: a beacon registered after a survey walk applies to that walk too
  JOIN positioning.beacon_devices b ON b.protocol = o.protocol AND b.uuid = o.uuid AND b.major = o.major AND b.minor = o.minor AND b.enabled
  JOIN positioning.spatial_anchors a ON a.id = b.anchor_id AND a.status = 'ACTIVE'`;

/**
 * Only observations of beacons that are enabled and anchored NOW: a beacon disabled later (moved, spoofed,
 * broken) drops out of every later replay, one registered later joins it; anchor corrections apply to replays too
 * (the replay input hash changes).
 */
export async function loadFusionBeacons(sessionId: string, db: DbClient = pool, observationIds?: string[]): Promise<BeaconRawSample[]> {
  const { rows } = observationIds
    ? await db.query<BeaconFusionRow>(`${FUSION_SELECT} WHERE o.session_id = $1 AND o.observation_id = ANY($2::uuid[])`, [sessionId, observationIds])
    : await db.query<BeaconFusionRow>(`${FUSION_SELECT} WHERE o.session_id = $1`, [sessionId]);
  if (!rows.length) return [];
  return toFusionBeacons(rows, await beaconRepository.calibrations(db));
}
