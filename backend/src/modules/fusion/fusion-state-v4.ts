import type { TerrainContext } from '../../geo/terrain.js';
import type { LocalOrigin } from '../../geo/wgs84.js';
import { createPedometerCounter, type PedometerCounter } from './fusion.pedometer.js';
import { diag3, type Mat3, type Vec3 } from './fusion-v4.smoother.js';
import type { StrideCalibration } from './fusion.stride.js';
import type { FusionSessionContext } from './fusion.stride.js';
import type { StartHeightMap, StartHeightSelection } from '../../geo/start-height-map.js';
import type { RoadHeightContact, RoadHeightTracker } from './fusion-road-height.js';
import type { CircularSummary } from './fusion-circular-corridor.js';

/**
 * One detected step: its own time and relative heading (rel = -yaw), not the pedometer's 2.6 s chunk.
 * Vertical movement can be confirmed as stairs (tread) or a slope (full stride), or retained as verticalUnknown
 * until there is enough path evidence; z = barometric Z at the step.
 */
export interface StepV4 {
  t: number; rel: number; length: number; stairs: boolean; slope?: boolean; verticalUnknown?: boolean; segment: number; z?: number;
}
/** A usable GPS fix in local ENU meters (kept for the smoother). */
export interface FixV4 {
  t: number;
  seq: number;
  x: number;
  y: number;
  accuracy: number;
  sigma: number;
  vehicle: boolean;
  forwardUsed: boolean;
  /** rev 13: taken while the motion sensors said the phone was still (one stop's fixes share one error) */
  stationary?: boolean;
}
/** Stretch with one constant device-to-walking-direction offset (theta). */
export interface HeadingSegmentV4 { id: number; startT: number; reason: string; firstStep: number }
/** Ground contact: orthometric zero offset b = DEM + phone height - barometric Z, at time t. */
export interface ContactV4 { t: number; offset: number; variance: number }
/** Absolute height: H = z + b (orthometric) when frame = ORTHO, ellipsoidal = z + b when frame = ELLIPSOIDAL (no DEM). */
export interface DatumV4 { b: number; sigma: number; source: 'TERRAIN' | 'ROAD_ANCHOR' | 'GPS' | 'MAP_START' | 'TERRAIN_FALLBACK' | 'GPS_FALLBACK'; frame: 'ORTHO' | 'ELLIPSOIDAL' }

export type HeadingSourceV4 = 'UNKNOWN' | 'GPS_SHAPE_FIT' | 'CONTINUITY';

export interface SmoothedSummaryV4 {
  datumSource: DatumV4['source'] | 'NONE';
  contacts: number;
  datumSigma: number | null;
  driftRangeM: number | null;
  gpsAccepted: number;
  gpsDownweighted: number;
  segments: number;
  segmentsWithHeading: number;
  steps: number;
  stairSteps: number;
  slopeSteps: number;
  verticalUnknownSteps: number;
  walkedWithoutMotionM: number;
  /** diagnostics (rev 4): robust weight and final residual of every fix (aligned with state.fixes), kept ground contacts */
  fixWeights: number[];
  fixResiduals: (number | null)[];
  contactLog: ContactV4[];
}

export interface FusionStateV4 {
  healthStrideCalibration?: StrideCalibration;
  strideSource?: 'APPLE_HEALTH' | 'SESSION_PEDOMETER' | 'DEFAULT';
  healthStrideBlend?: number;
  strideLevelSteps: number;
  strideEffectiveM?: number;
  origin?: LocalOrigin;
  initialized: boolean;
  /** [x East m, y North m, theta rad] and its covariance */
  x: Vec3;
  P: Mat3;
  headingKnown: boolean;
  headingSource: HeadingSourceV4;
  pendingContinuity?: { thetaPlusRel: number; variance: number };
  lastEventT?: number;
  vehicle: boolean;
  /** consecutive good fixes reporting vehicle speed while the motion sensors were not still */
  vehicleRun: number;
  /** rev 13: current stop (motion-still): state when it began and its fixes, combined into one measurement */
  stop?: { x: Vec3; P: Mat3; fixes: number[] };

  // ---- motion: relative heading, pose, step detection, stationarity ----
  lastMotionT?: number;
  lastMotionSegment?: string | null;
  lastYaw?: number;
  rel: number;
  relInitialized: boolean;
  bq: { x1: number; x2: number; y1: number; y2: number; primed: number };
  /** stepTimeBased: last raw step-signal sample and the next grid time to interpolate at */
  resample?: { t: number; v: number; rel: number; next: number };
  /** last reported reason the current segment's heading fit failed (one event per change, diagnostics only) */
  headingFitFailure?: string;
  f1?: { v: number; t: number; rel: number };
  f2?: number;
  lastPeakT?: number;
  walking: boolean;
  pending: { t: number; rel: number }[];
  lastStepT?: number;
  lastStepRel?: number;
  gSmooth?: Vec3;
  gRef?: Vec3;
  poseOffSince?: number;
  accelWindow: { t: number; m2: number }[];
  stationary: boolean;

  // ---- stride calibration (CMPedometer distance per detected step, from pedometer updates of level walking) ----
  strideA: number;
  strideB: number;
  /** pedometer reading at the last stride sample and the pedometer updates since */
  strideSample?: { steps: number | null; distance: number; updates: number };
  stairStepsSinceUpdate: number;
  slopeStepsSinceUpdate: number;
  verticalUnknownStepsSinceUpdate: number;
  stepsSinceUpdate: number;
  /**
   * current climb: vertical steps in one direction, at most slopeRunGapMs apart (stairs or slope: see slopeFrom),
   * the stride of its slope walking, and the pedometer updates held back because their steps count as stairs
   */
  climb?: {
    first: number;
    dir: number;
    lastT: number;
    mode: 'unknown' | 'stairs' | 'slope';
    strideA: number;
    strideB: number;
    held: { from: number; to: number; distance: number }[];
  };
  /** steps from this index on moved the live position by dead reckoning (not before a fix / heading fit set it) */
  reckonedFrom: number;
  pedometerCounter: PedometerCounter;
  pedometerStarted: boolean;
  lastPedometerSegment?: string | null;

  // ---- barometer: relative Z (continuous over sensor restarts), datum from GPS heights ----
  z?: number;
  zOffset?: number;
  lastAltT?: number;
  lastAltSegment?: string | null;
  altWindow: { t: number; z: number }[];
  zLog: { t: number; z: number }[];
  datumSamples: number[];
  /** Best reported vertical accuracy, used provisionally only when no trusted datum exists. */
  bestGpsDatum?: { b: number; accuracy: number };
  /** Fixed provisional zero: assume the first usable DEM position is at ground level. */
  terrainFallbackDatum?: DatumV4;
  startHeightMap?: StartHeightMap | null;
  startHeightSelection?: StartHeightSelection;
  mapStartDatum?: DatumV4;
  roadHeightTracker: RoadHeightTracker;
  roadHeightContacts: RoadHeightContact[];
  circularCorridor?: CircularSummary;
  /** terrain: session DEM, ground contacts (thinned), GPS heights consistent with the ground (orthometric offsets) */
  terrain?: TerrainContext | null;
  contacts: ContactV4[];
  gpsOffsets: number[];
  datum?: DatumV4;

  // ---- logs for the smoother ----
  segments: HeadingSegmentV4[];
  steps: StepV4[];
  fixes: FixV4[];
  walked: { t: number; distance: number }[];
  stationaryLog: { t: number; stationary: boolean }[];
  rejectRun: number[];

  // ---- outputs / bookkeeping ----
  fusionSequence: number;
  nextOutputAt?: number;
  /** position of the last emitted output (rev 13: a stop emits no further points unless the position moved) */
  lastOutputXY?: [number, number];
  window: {
    gpsUsed: boolean | null;
    gpsReason: string | null;
    gpsSeq: number | null;
    gpsAccuracy: number | null;
    innovation: number | null;
    steps: number;
    unheadedSteps: number;
    anchored: boolean;
    reanchored: boolean;
  };
  lastObservationT?: number;
  skippedLateObservations: number;
  counters: {
    gpsAccepted: number;
    gpsRejected: number;
    reasons: Record<string, number>;
    maxRejectedInnovation: number | null;
    reanchors: number;
    headingFits: number;
    motionGaps: number;
    stationaryMs: number;
    altimeterRebases: number;
  };
  smoothed?: SmoothedSummaryV4;
}

export const emptyWindowV4 = (): FusionStateV4['window'] => ({
  gpsUsed: null, gpsReason: null, gpsSeq: null, gpsAccuracy: null, innovation: null, steps: 0, unheadedSteps: 0, anchored: false, reanchored: false,
});

export function createFusionStateV4(context?: FusionSessionContext): FusionStateV4 {
  return {
    startHeightMap: context?.startHeightMap,
    ...(context?.strideCalibration ? { healthStrideCalibration: context.strideCalibration } : {}),
    ...(context?.strideCalibration ? { strideSource: 'APPLE_HEALTH' as const, healthStrideBlend: 0 } : {}),
    strideLevelSteps: 0,
    strideEffectiveM: context?.strideCalibration?.stepLengthM,
    initialized: false,
    x: [0, 0, 0],
    P: diag3(1e8, 1e8, 1),
    headingKnown: false,
    headingSource: 'UNKNOWN',
    vehicle: false,
    vehicleRun: 0,
    rel: 0,
    relInitialized: false,
    bq: { x1: 0, x2: 0, y1: 0, y2: 0, primed: 0 },
    walking: false,
    pending: [],
    accelWindow: [],
    stationary: false,
    strideA: 0,
    strideB: 0,
    stairStepsSinceUpdate: 0,
    slopeStepsSinceUpdate: 0,
    verticalUnknownStepsSinceUpdate: 0,
    stepsSinceUpdate: 0,
    reckonedFrom: 0,
    pedometerCounter: createPedometerCounter(),
    pedometerStarted: false,
    altWindow: [],
    zLog: [],
    datumSamples: [],
    contacts: [],
    roadHeightTracker: {},
    roadHeightContacts: [],
    gpsOffsets: [],
    segments: [],
    steps: [],
    fixes: [],
    walked: [],
    stationaryLog: [],
    rejectRun: [],
    fusionSequence: 0,
    window: emptyWindowV4(),
    skippedLateObservations: 0,
    counters: { gpsAccepted: 0, gpsRejected: 0, reasons: {}, maxRejectedInnovation: null, reanchors: 0, headingFits: 0, motionGaps: 0, stationaryMs: 0, altimeterRebases: 0 },
  };
}
