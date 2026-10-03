import type { LocalOrigin } from '../../geo/wgs84.js';
import type { SpatialContext } from '../../geo/spatial.js';
import { createPedometerCounter, type PedometerCounter } from './fusion.pedometer.js';
import type { Observation } from './fusion.timeline.js';
import type { HeadingSource } from './fusion.types.js';

export type FusionTrackingStatusV31 = 'UNANCHORED' | 'TRACKING' | 'REACQUIRE_REQUIRED';
export type FusionHeadingStatusV31 = 'UNKNOWN' | 'VALID' | 'DEGRADED';

export interface GpsAnchorCandidateV31 {
  observation: Extract<Observation, { kind: 'gps' }>;
  pedometerTotal: number;
}

export interface FusionStateV31 {
  trackingStatus: FusionTrackingStatusV31;
  headingStatus: FusionHeadingStatusV31;
  context: SpatialContext | null;
  mapVersionId: string | null;
  spatialSegmentId: number;
  origin?: LocalOrigin;
  x: number;
  y: number;
  relativeZ: number;
  hasRelativeZ: boolean;
  horizontalUncertainty: number;
  verticalUncertainty: number;
  headingRad?: number;
  headingConfidence: number;
  headingSource: HeadingSource;
  lastYaw?: number;
  lastMotionT?: number;
  lastMotionSegment?: string | null;
  lastRoll?: number;
  lastPitch?: number;
  lastGravity?: { x: number; y: number; z: number };
  postureUnstableUntil?: number;
  headingUsableAfter?: number;
  motionGaps: number;
  accelWindow: { t: number; magnitudeG: number }[];
  stationary: boolean | null;
  lastMovementT?: number;
  lastPedometerDistance?: number;
  lastStepCount?: number;
  lastPedometerT?: number;
  lastPedometerSegment?: string | null;
  /** high-water marks of the cumulative pedometer run (fusion.pedometer.ts) */
  pedometerCounter: PedometerCounter;
  pedometerTotal: number;
  fallbackStepDistance: number;
  lastRelativeAltitude?: number;
  lastAltimeterT?: number;
  lastAltimeterSegment?: string | null;
  altimeterRebases: number;
  anchorCandidates: GpsAnchorCandidateV31[];
  lastAnchorT?: number;
  lastAnchorAccuracy?: number;
  lastAnchorSequence?: number;
  lastAnchorWasCorrection: boolean;
  reanchorCount: number;
  gpsAccepted: number;
  gpsRejected: number;
  rejectReasons: Record<string, number>;
  fusionSequence: number;
  nextOutputAt?: number;
  lastOutputT?: number;
  lastObservationT?: number;
  skippedLateObservations: number;
  stationaryMs: number;
  lastEmittedHeight?: number;
}

export function createFusionStateV31(): FusionStateV31 {
  return {
    trackingStatus: 'UNANCHORED', headingStatus: 'UNKNOWN', context: null, mapVersionId: null,
    spatialSegmentId: 0, x: 0, y: 0, relativeZ: 0, hasRelativeZ: false,
    horizontalUncertainty: Infinity, verticalUncertainty: Infinity, headingConfidence: 0,
    headingSource: 'UNKNOWN', motionGaps: 0, accelWindow: [], stationary: null,
    pedometerTotal: 0, pedometerCounter: createPedometerCounter(), fallbackStepDistance: 0, altimeterRebases: 0,
    anchorCandidates: [], lastAnchorWasCorrection: false, reanchorCount: 0,
    gpsAccepted: 0, gpsRejected: 0, rejectReasons: {},
    fusionSequence: 0, skippedLateObservations: 0, stationaryMs: 0,
  };
}
