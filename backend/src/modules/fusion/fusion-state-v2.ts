import type { LocalOrigin } from '../../geo/wgs84.js';
import type { GpsRejectReason, HeadingSource } from './fusion.types.js';

/**
 * fusion-v2 state. Same frame as v1: +X East, +Y North, +Z Up (meters from origin); heading in radians,
 * 0 = North, clockwise. Reproducible from raw data, so losing it on restart is fine.
 */
export interface FusionStateV2 {
  initialized: boolean;
  provisionalInit: boolean;
  initializedAt?: number;
  origin?: LocalOrigin;
  verticalDatum?: number; // ellipsoidal height at z = 0
  /** Before initialization: first valid fix time and the best (lowest accuracy) fix seen. */
  firstValidFixT?: number;
  initCandidate?: { latitude: number; longitude: number; height: number; ellipsoidalAltitude: number | null; hacc: number; vacc: number | null; t: number };

  x: number;
  y: number;
  z: number;
  /** Heuristic horizontal / vertical uncertainty (m). Confidence = exp(-u / scale). */
  horizontalUncertainty: number;
  verticalUncertainty: number;

  headingRad?: number;
  headingSource: HeadingSource;

  lastObservationT?: number;
  lastYaw?: number;
  lastStepCount?: number;
  lastPedometerDistance?: number;
  lastPedometerT?: number;
  lastRelativeAltitude?: number;
  lastAltimeterT?: number;

  /** Last fix that passed all gates (raw GPS position in local meters). */
  lastAcceptedGps?: { x: number; y: number; t: number; hacc: number };
  lastTrustedGpsT?: number;
  lastTrustedGpsX?: number;
  lastTrustedGpsY?: number;
  distanceSinceTrustedGps: number;
  lastDisplacementFix?: { x: number; y: number; t: number };
  consecutiveGateRejects: number;
  firstGateRejectT?: number;

  // ---- stationary detection ----
  stationary: boolean;
  stationaryMs: number;
  lastMovementEvidenceT?: number;
  accelWindow: { t: number; a2: number }[];
  accelSum: number;
  stableFixes: { x: number; y: number; t: number }[];

  lastGpsHorizontalAccuracy?: number;
  lastGpsVerticalAccuracy?: number;

  fusionSequence: number;
  nextOutputAt?: number;
  window: FusionWindowV2;
  skippedLateObservations: number;
}

export interface GpsDecision {
  seq: number;
  used: boolean;
  reason: GpsRejectReason | null;
  hacc: number | null;
  vacc: number | null;
  innovation: number | null;
}

export interface FusionWindowV2 {
  anchored: boolean;
  reanchored: boolean;
  gpsCount: number;
  anyGpsUsed: boolean;
  lastDecision: GpsDecision | null;
  pdrDistance: number;
  yawDeltaRad: number;
  dz: number;
}

export function emptyWindowV2(): FusionWindowV2 {
  return { anchored: false, reanchored: false, gpsCount: 0, anyGpsUsed: false, lastDecision: null, pdrDistance: 0, yawDeltaRad: 0, dz: 0 };
}

export function createFusionStateV2(): FusionStateV2 {
  return {
    initialized: false,
    provisionalInit: false,
    x: 0,
    y: 0,
    z: 0,
    horizontalUncertainty: Infinity,
    verticalUncertainty: Infinity,
    headingSource: 'NONE',
    distanceSinceTrustedGps: 0,
    consecutiveGateRejects: 0,
    stationary: false,
    stationaryMs: 0,
    accelWindow: [],
    accelSum: 0,
    stableFixes: [],
    fusionSequence: 0,
    window: emptyWindowV2(),
    skippedLateObservations: 0,
  };
}
