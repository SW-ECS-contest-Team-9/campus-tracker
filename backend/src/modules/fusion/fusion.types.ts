// Output types shared by all fusion versions (stored in fused_positions, broadcast as position:fused).

/**
 * GPS_ANCHORED   first fix initialized the local frame
 * GPS_CORRECTED  an accepted GPS fix corrected the position (no PDR movement in this output window)
 * FUSED          accepted GPS correction + PDR movement in the same window
 * PDR_PREDICTED  moved by pedometer + heading only
 * GPS_REANCHOR   (v2) hard re-anchor after repeated consistent rejections (state had diverged)
 * STATIONARY_HOLD(v2) user detected as stationary, XY held
 * HELD           (v2) nothing moved the position (e.g. walking but heading not anchored yet)
 */
export type PositionSource = 'GPS_ANCHORED' | 'GPS_CORRECTED' | 'FUSED' | 'PDR_PREDICTED' | 'GPS_REANCHOR' | 'STATIONARY_HOLD' | 'HELD';

export type GpsRejectReason =
  | 'INVALID_ACCURACY'
  | 'POOR_ACCURACY' // v2: > 15 m
  | 'UNUSABLE_ACCURACY' // v2.1: > 35 m
  | 'STATIONARY_LOCK'
  | 'PHYSICAL_JUMP'
  | 'INNOVATION_TOO_LARGE'
  | 'NOT_INITIALIZED'
  | 'PRE_SESSION'; // v2.1 rev 5: cached fix from before session start

/** v2: NONE | GPS_COURSE | GPS_DISPLACEMENT. v2.1: UNKNOWN | GPS_COURSE | GPS_TWO_POINT | YAW_DELTA */
export type HeadingSource = 'NONE' | 'UNKNOWN' | 'GPS_COURSE' | 'GPS_DISPLACEMENT' | 'GPS_TWO_POINT' | 'YAW_DELTA'
  | 'GPS_ANCHOR_DISPLACEMENT' | 'MANUAL_ANCHOR' | 'FIXED_ANCHOR'
  | 'GPS_SHAPE_FIT' | 'CONTINUITY'; // v4: walked shape fitted to GPS fixes / direction carried over a segment change

export interface FusedOutput {
  fusionSequence: number;
  timestamp: number; // ms
  latitude: number;
  longitude: number;
  ellipsoidalAltitude: number | null;
  /** Z stored in geom: ellipsoidal height if known, otherwise the state's height estimate. */
  geomZ: number;
  x: number;
  y: number;
  z: number;
  headingDegrees: number | null;
  horizontalConfidence: number;
  verticalConfidence: number;
  overallConfidence: number;
  gpsHorizontalAccuracy: number | null;
  gpsVerticalAccuracy: number | null;
  source: PositionSource;

  // ---- diagnostics (v2+; null for v1) ----
  /** true/false = a GPS fix in this output window was used / rejected; null = no fix in the window */
  gpsUsed?: boolean | null;
  gpsRejectReason?: GpsRejectReason | null;
  /** location_samples.sequence of the last fix considered in this window */
  gpsSequence?: number | null;
  innovationDistance?: number | null;
  stationary?: boolean | null;
  headingSource?: HeadingSource | null;
  /** heuristic 1-sigma-like horizontal uncertainty of the state, meters */
  horizontalUncertainty?: number | null;

  // ---- v2.1 diagnostics ----
  gpsQuality?: string | null; // EXCELLENT | GOOD | MARGINAL | POOR | UNUSABLE
  /** true = pedometer distance moved XY in this window, false = it could not (see pdrRejectReason), null = no walking */
  pdrApplied?: boolean | null;
  pdrRejectReason?: string | null; // NO_HEADING | NOT_INITIALIZED | NEGATIVE_DELTA | NOT_FINITE | OVERSPEED_CLAMPED
  relativeAltitude?: number | null; // raw CMAltimeter relativeAltitude at this time
  reanchored?: boolean | null;
  reanchorReason?: string | null; // GPS_CLUSTER | GPS_TRACK | DIVERGENCE
  divergenceDetected?: boolean | null;
  spatialMapVersionId?: string | null;
  spatialStatus?: 'INSIDE' | 'OUTSIDE' | 'BOUNDARY_UNCERTAIN' | 'MAP_UNAVAILABLE' | null;
  buildingId?: string | null;
  buildingName?: string | null;
  buildingMatchStatus?: 'MATCHED' | 'NONE' | 'BOUNDARY_UNCERTAIN' | 'AMBIGUOUS' | 'MAP_UNAVAILABLE' | null;
  spatialSegmentId?: number | null;
  // ---- v4 rev 2: absolute height ----
  terrainHeight?: number | null; // DEM orthometric height under the position
  heightAboveGround?: number | null; // orthometric height - terrain height
  zDatumSource?: 'TERRAIN' | 'GPS' | 'NONE' | null;
  zDatumSigma?: number | null;
}

export interface SpatialGpsDecision {
  sequence: number;
  timestamp: number;
  spatialMapVersionId: string | null;
  campusStatus: string;
  anchorAccepted: boolean;
  reason: string;
  horizontalAccuracy: number | null;
  boundaryDistanceM: number | null;
  buildingId: string | null;
  buildingName: string | null;
}
