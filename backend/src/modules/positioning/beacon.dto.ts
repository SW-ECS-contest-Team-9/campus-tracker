import { z } from 'zod';
import { IsoDateTime, isPlausibleSensorTime, Uuid } from '../../common/dto.js';
import { FLOOR_NAME } from '../markers/marker-anchor.js';
import { tmForward } from '../../geo/tm.js';

// BLE / iBeacon positioning contract (docs/BEACON_POSITIONING.md). Zod schemas are the single source of truth.

export const BEACON_MESSAGE_TYPE = 'beacon.observations.v1';
/** session:start ACK feature flag: the app may send beacon.observations.v1 for this session. */
export const BEACON_FEATURE = 'beaconObservationsV1';
export const MAX_BEACON_OBSERVATIONS = 5_000;

export const BeaconProtocol = z.string().trim().transform((v) => v.toUpperCase()).pipe(z.literal('IBEACON'));
export const Platform = z.string().trim().transform((v) => v.toLowerCase()).pipe(z.enum(['ios', 'android']));
const UInt16 = z.number().int().min(0).max(65535);
const Floor = z.string().trim().transform((v) => v.toUpperCase()).pipe(z.string().regex(FLOOR_NAME, 'floor must be 1F..99F or B1..B9'));

/** Per-observation fields. Plausibility (RSSI range, sensor time) is checked per row by the service, not here. */
export const BeaconObservation = z.object({
  observationId: Uuid,
  protocol: BeaconProtocol,
  uuid: Uuid,
  major: UInt16,
  minor: UInt16,
  rssiDbm: z.number().int(),
  observedAt: IsoDateTime,
  deviceModel: z.string().trim().max(64).nullish(),
  proximity: z.string().trim().max(16).nullish(),
  /** CLBeacon.accuracy (iOS) or none (Android). Reference only; never a range measurement. Negative = unknown. */
  platformEstimatedDistanceMeters: z.number().finite().nullish(),
  /** advertised calibrated power at 1 m from the packet (Android); iOS does not expose it */
  measuredPowerDbm: z.number().int().min(-127).max(20).nullish(),
  observationTimeUncertaintyMs: z.number().finite().nonnegative().max(600_000).nullish(),
  /** CORE_LOCATION_RANGING (iOS ~1 s aggregate) | SINGLE_ADVERTISEMENT (Android ScanResult) | other */
  rssiAggregation: z.string().trim().max(32).nullish(),
  sampleCount: z.number().int().min(1).max(10_000).nullish(),
});
export type BeaconObservation = z.infer<typeof BeaconObservation>;

export const BeaconObservationBatch = z.object({
  type: z.literal(BEACON_MESSAGE_TYPE).nullish(),
  schemaVersion: z.literal(1),
  sessionId: Uuid.nullish(),
  clientSessionId: Uuid.nullish(),
  batchId: Uuid,
  platform: Platform,
  deviceModel: z.string().trim().max(64).nullish(),
  createdAt: IsoDateTime.nullish(),
  observations: z.array(BeaconObservation).min(1).max(MAX_BEACON_OBSERVATIONS),
}).refine((b) => b.sessionId || b.clientSessionId, { message: 'sessionId or clientSessionId is required', path: ['sessionId'] });
export type BeaconObservationBatch = z.infer<typeof BeaconObservationBatch>;

/** Physically meaningful RSSI for BLE. iOS reports 0 when the RSSI of a ranged beacon is unknown. */
export const RSSI_MIN_DBM = -120;
export const RSSI_MAX_DBM = -1;

export type BeaconRowRejection = 'RSSI_OUT_OF_RANGE' | 'TIMESTAMP_IMPLAUSIBLE' | 'DUPLICATE_IN_BATCH';

/** Row-level checks after the schema: rows failing them are reported in the ACK and not stored. */
export function checkObservation(o: BeaconObservation): BeaconRowRejection | null {
  if (o.rssiDbm < RSSI_MIN_DBM || o.rssiDbm > RSSI_MAX_DBM) return 'RSSI_OUT_OF_RANGE';
  if (!isPlausibleSensorTime(o.observedAt)) return 'TIMESTAMP_IMPLAUSIBLE';
  return null;
}

/** Canonical identity key (lower-case UUID), the same on every platform. */
export const beaconKey = (protocol: string, uuid: string, major: number, minor: number) =>
  `${protocol.toUpperCase()}:${uuid.toLowerCase()}:${major}:${minor}`;

// ---- admin ----

const Height = z.number().finite().min(-500).max(3000);
const GridPosition = z.object({
  /** EPSG:5186 metres */
  x: z.number().finite().min(100_000).max(700_000),
  y: z.number().finite().min(100_000).max(800_000),
  /** orthometric height above MSL (KVD Incheon), metres: the beacon's mounting point */
  z: Height,
}).strict();
/** WGS84 input (the registration page, a phone's location); stored as EPSG:5186 like every other anchor */
const GeoPosition = z.object({
  latitude: z.number().finite().min(33).max(39),
  longitude: z.number().finite().min(124).max(132),
  z: Height,
}).strict();
export const AnchorPosition = z.union([GridPosition, GeoPosition]).transform((p) => {
  if ('x' in p) return p;
  const g = tmForward(p.latitude, p.longitude);
  return { x: g.x, y: g.y, z: p.z };
});

export const AnchorCreate = z.object({
  anchorType: z.literal('BEACON').default('BEACON'),
  buildingId: z.string().trim().min(1).max(64),
  floor: Floor.nullish(),
  floorHeightM: z.number().finite().min(-500).max(3000).nullish(),
  position: AnchorPosition,
  horizontalAccuracyM: z.number().finite().positive().max(100).default(1),
  verticalAccuracyM: z.number().finite().positive().max(100).default(1),
  label: z.string().trim().max(200).nullish(),
}).strict();
export type AnchorCreate = z.infer<typeof AnchorCreate>;

export const AnchorUpdate = z.object({
  buildingId: z.string().trim().min(1).max(64).optional(),
  floor: Floor.nullish(),
  floorHeightM: z.number().finite().min(-500).max(3000).nullish(),
  position: AnchorPosition.optional(),
  horizontalAccuracyM: z.number().finite().positive().max(100).optional(),
  verticalAccuracyM: z.number().finite().positive().max(100).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  label: z.string().trim().max(200).nullish(),
}).strict();
export type AnchorUpdate = z.infer<typeof AnchorUpdate>;

export const BeaconCreate = z.object({
  protocol: BeaconProtocol.default('IBEACON'),
  uuid: Uuid,
  major: UInt16,
  minor: UInt16,
  measuredPowerDbm: z.number().int().min(-127).max(20).nullish(),
  anchorId: Uuid.nullish(),
  /** create the anchor in the same transaction instead of linking an existing one */
  anchor: AnchorCreate.optional(),
  enabled: z.boolean().default(true),
  label: z.string().trim().max(200).nullish(),
}).strict().refine((b) => !(b.anchorId && b.anchor), { message: 'give anchorId or anchor, not both', path: ['anchor'] });
export type BeaconCreate = z.infer<typeof BeaconCreate>;

/** Identity (protocol/uuid/major/minor) is immutable: register a new beacon instead. */
export const BeaconUpdate = z.object({
  measuredPowerDbm: z.number().int().min(-127).max(20).nullish(),
  anchorId: Uuid.nullable().optional(),
  enabled: z.boolean().optional(),
  label: z.string().trim().max(200).nullish(),
}).strict();
export type BeaconUpdate = z.infer<typeof BeaconUpdate>;

export const CalibrationUpsert = z.object({
  /** null / omitted = default for every beacon */
  beaconId: Uuid.nullish(),
  platform: z.enum(['*', 'ios', 'android']).default('*'),
  deviceGroup: z.string().trim().min(1).max(64).default('*'),
  measuredPower1m: z.number().finite().min(-127).max(20),
  pathLossExponent: z.number().finite().min(1).max(6),
  rssiVariance: z.number().finite().positive().max(400),
  sampleCount: z.number().int().min(0).default(0),
}).strict();
export type CalibrationUpsert = z.infer<typeof CalibrationUpsert>;

export const BeaconListQuery = z.object({
  includeDisabled: z.stringbool().default(false),
  buildingId: z.string().trim().min(1).max(64).optional(),
});

export const SurveyUuidCreate = z.object({ uuid: Uuid, label: z.string().trim().max(200).nullish() }).strict();

export const DiscoveredQuery = z.object({
  /** look back this many hours (default one week) */
  sinceHours: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
