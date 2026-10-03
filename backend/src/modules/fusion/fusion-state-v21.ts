import { createPedometerCounter, type PedometerCounter } from './fusion.pedometer.js';
import type { LocalOrigin } from '../../geo/wgs84.js';

export type GpsQualityV21 = 'EXCELLENT' | 'GOOD' | 'MARGINAL' | 'POOR' | 'UNUSABLE';
export type HeadingSourceV21 = 'UNKNOWN' | 'GPS_COURSE' | 'GPS_TWO_POINT' | 'YAW_DELTA';
export type GpsRejectReasonV21 =
  | 'INVALID_ACCURACY'
  | 'UNUSABLE_ACCURACY'
  | 'STATIONARY_LOCK'
  | 'PHYSICAL_JUMP'
  | 'INNOVATION_TOO_LARGE'
  | 'NOT_INITIALIZED'
  | 'PRE_SESSION';
export type PdrRejectReason =
  | 'NO_HEADING'
  | 'NOT_INITIALIZED'
  | 'NEGATIVE_DELTA'
  | 'NOT_FINITE'
  | 'OVERSPEED_CLAMPED'
  | 'BELOW_HIGH_WATER' // rev 6: cumulative sample below the run's maximum (ignored)
  | 'COUNTER_RESTARTED'; // rev 6: counter restarted without a new segment id (new baseline)
export type ReanchorReason = 'GPS_CLUSTER' | 'GPS_TRACK' | 'DIVERGENCE';

/** A GPS fix kept as evidence, in local meters. */
export interface EvidenceFix {
  x: number;
  y: number;
  t: number;
  acc: number;
  /** cumulative pedometer distance seen at this time (for "walked between A and B") */
  pedometerAt: number;
}

/**
 * fusion-v2.1 state. Frame: +X East, +Y North (meters from origin), Z = ellipsoidal height in meters.
 * Heading in radians, 0 = North, clockwise.
 */
export interface FusionStateV21 {
  initialized: boolean;
  provisionalInit: boolean;
  initializedAt?: number;
  origin?: LocalOrigin;
  firstValidFixT?: number;
  initCandidate?: { latitude: number; longitude: number; ellipsoidalAltitude: number | null; altitude: number | null; acc: number; vacc: number | null; t: number };

  x: number;
  y: number;
  horizontalUncertainty: number;

  // ---- vertical (anchor based): zEllipsoidal = heightDatum + (relativeAltitude - baseRelativeAltitude) ----
  /** Ellipsoidal height corresponding to baseRelativeAltitude (or the current height while no barometer). */
  heightDatum?: number;
  heightDatumIsEllipsoidal: boolean;
  baseRelativeAltitude?: number;
  /** Sum of rejected barometer jumps; subtracted so a glitch does not move Z. */
  relativeAltitudeOffset: number;
  lastRelativeAltitude?: number;
  lastAltimeterT?: number;
  lastAltimeterSegment?: string | null;
  /** baseline restarts (segment change / long gap); Z continues from the last fused height */
  altimeterRebases: number;
  verticalUncertainty: number;
  /** consecutive GPS heights rejected by the vertical innovation gate (candidate for a datum re-anchor) */
  verticalRejects: number[];
  verticalRejectedCount: number;

  headingRad?: number;
  headingSource: HeadingSourceV21;
  yawSinceAnchorRad: number;
  lastYaw?: number;
  lastMotionT?: number;
  lastMotionSegment?: string | null;
  motionGaps: number;

  lastStepCount?: number;
  lastPedometerDistance?: number;
  lastPedometerT?: number;
  lastPedometerSegment?: string | null;
  /** high-water marks of the cumulative pedometer run (fusion.pedometer.ts) */
  pedometerCounter: PedometerCounter;
  /** Total valid pedometer distance this session (deltas only). */
  pedometerTotal: number;
  hasPedometer: boolean;

  lastObservationT?: number;
  lastAcceptedGps?: { x: number; y: number; t: number; acc: number };
  evidence: EvidenceFix[];
  lastBootstrapFix?: EvidenceFix;
  lastReanchorT?: number;

  // ---- divergence guard: displacement since the anchor must be explained by evidence ----
  anchorX: number;
  anchorY: number;
  pedometerSinceAnchor: number;
  correctionSinceAnchor: number;

  // ---- stationary ----
  stationary: boolean;
  stationaryMs: number;
  lastMovementEvidenceT?: number;
  accelWindow: { t: number; a2: number }[];
  stableFixes: { x: number; y: number; t: number }[];

  lastGpsAccuracy?: number;
  lastGpsVerticalAccuracy?: number;

  // ---- output ----
  fusionSequence: number;
  nextOutputAt?: number;
  lastOutputT?: number;
  lastOutputZ?: number;
  window: WindowV21;
  skippedLateObservations: number;
  counters: { reanchors: number; divergences: number };
}

export interface WindowV21 {
  anchored: boolean;
  immediate: boolean; // an important event asks for an output right away
  gpsCount: number;
  anyGpsUsed: boolean;
  lastGps: { seq: number; used: boolean; reason: GpsRejectReasonV21 | null; quality: GpsQualityV21 | null; acc: number | null; vacc: number | null; innovation: number | null } | null;
  pdrDistance: number;
  pdrApplied: boolean | null; // null = no pedometer movement in the window
  pdrRejectReason: PdrRejectReason | null;
  reanchorReason: ReanchorReason | null;
  divergence: boolean;
  yawDeltaRad: number;
}

export function emptyWindowV21(): WindowV21 {
  return {
    anchored: false, immediate: false, gpsCount: 0, anyGpsUsed: false, lastGps: null,
    pdrDistance: 0, pdrApplied: null, pdrRejectReason: null, reanchorReason: null, divergence: false, yawDeltaRad: 0,
  };
}

export function createFusionStateV21(): FusionStateV21 {
  return {
    initialized: false,
    provisionalInit: false,
    x: 0,
    y: 0,
    horizontalUncertainty: Infinity,
    heightDatumIsEllipsoidal: false,
    relativeAltitudeOffset: 0,
    verticalUncertainty: Infinity,
    headingSource: 'UNKNOWN',
    yawSinceAnchorRad: 0,
    pedometerTotal: 0,
    hasPedometer: false,
    pedometerCounter: createPedometerCounter(),
    evidence: [],
    anchorX: 0,
    anchorY: 0,
    pedometerSinceAnchor: 0,
    correctionSinceAnchor: 0,
    stationary: false,
    stationaryMs: 0,
    accelWindow: [],
    stableFixes: [],
    fusionSequence: 0,
    window: emptyWindowV21(),
    skippedLateObservations: 0,
    counters: { reanchors: 0, divergences: 0 },
    altimeterRebases: 0,
    motionGaps: 0,
    verticalRejects: [],
    verticalRejectedCount: 0,
  };
}
