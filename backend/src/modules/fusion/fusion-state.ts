import type { LocalOrigin } from '../../geo/wgs84.js';

/**
 * Per-session fusion state. Lives in memory for realtime processing; it is fully reproducible from the
 * raw tables (replay), so losing it on a server restart is fine.
 * Local frame: +X = East, +Y = North, +Z = Up, meters relative to `origin` (first usable GPS fix).
 * Heading: radians, 0 = North, clockwise (π/2 = East).
 */
export interface FusionState {
  initialized: boolean;
  origin?: LocalOrigin;
  /** Ellipsoidal height at local z = 0, known once any fix reported ellipsoidalAltitude. */
  verticalDatum?: number;

  x: number;
  y: number;
  z: number;
  headingRad?: number;

  /** Timestamp (ms) of the newest observation applied. Older observations are skipped in realtime. */
  lastObservationT?: number;
  lastGpsTimestamp?: number;
  lastMotionTimestamp?: number;
  lastPedometerTimestamp?: number;
  lastAltimeterTimestamp?: number;

  lastPedometerDistance?: number;
  lastStepCount?: number;
  lastRelativeAltitude?: number;
  lastYaw?: number;

  /** Last trusted raw fix (local meters) for the displacement-heading fallback. */
  lastTrustedFix?: { x: number; y: number; t: number };
  lastGpsHorizontalAccuracy?: number;
  lastGpsVerticalAccuracy?: number;

  horizontalConfidence: number;
  verticalConfidence: number;
  lastDecayT?: number;

  fusionSequence: number;
  nextOutputAt?: number;
  /** What happened since the previous output (drives position_source and the debug summary). */
  window: FusionWindow;
  /** Realtime only: observations dropped because they were older than lastObservationT. */
  skippedLateObservations: number;
}

export interface FusionWindow {
  anchored: boolean;
  gpsCount: number;
  maxGpsWeight: number;
  pdrDistance: number;
  unheadedDistance: number;
  yawDeltaRad: number;
  dz: number;
}

export function emptyWindow(): FusionWindow {
  return { anchored: false, gpsCount: 0, maxGpsWeight: 0, pdrDistance: 0, unheadedDistance: 0, yawDeltaRad: 0, dz: 0 };
}

/** New session: nothing is known until the first usable GPS fix (no world coordinates from PDR alone). */
export function createFusionState(): FusionState {
  return {
    initialized: false,
    x: 0,
    y: 0,
    z: 0,
    horizontalConfidence: 0,
    verticalConfidence: 0,
    fusionSequence: 0,
    window: emptyWindow(),
    skippedLateObservations: 0,
  };
}
