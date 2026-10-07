// All tunable numbers of the fusion algorithm live here (none inline in the engine).
// These are experimental starting values for this project, NOT standards; tune them with real campus data.
// Changing behaviour meaningfully => copy into a new algorithm version instead of editing v1 in place,
// so stored fusion-v1 results stay comparable.

export interface FusionConfig {
  // ---- GPS quality classes (horizontalAccuracy, meters) ----
  goodGpsAccuracy: number; // <= GOOD
  fairGpsAccuracy: number; // <= FAIR
  poorGpsAccuracy: number; // <= POOR, above = VERY_POOR

  // Horizontal correction weight (alpha): fused = predicted * (1 - alpha) + gps * alpha
  gpsWeightGood: number;
  gpsWeightFair: number;
  gpsWeightPoor: number;
  gpsWeightVeryPoor: number;

  // Confidence a single fix of each class justifies (0..1 heuristic score)
  gpsConfidenceGood: number;
  gpsConfidenceFair: number;
  gpsConfidencePoor: number;
  gpsConfidenceVeryPoor: number;

  // ---- vertical (GPS ellipsoidalAltitude anchor vs barometer), verticalAccuracy in meters ----
  goodVerticalAccuracy: number;
  fairVerticalAccuracy: number;
  poorVerticalAccuracy: number;
  verticalWeightGood: number;
  verticalWeightFair: number;
  verticalWeightPoor: number;
  verticalWeightVeryPoor: number;

  // ---- heading anchors ----
  trustedCourseAccuracy: number; // GPS course is used only if horizontalAccuracy <= this
  trustedCourseMinSpeed: number; // ... and speed >= this (m/s)
  courseAnchorWeight: number; // 1 = replace heading, <1 = soft correction toward course
  // Fallback when course is invalid (-1): heading from displacement between two trusted fixes
  displacementHeadingEnabled: boolean;
  displacementHeadingAccuracy: number; // both fixes must be <= this (m)
  displacementHeadingMinDistance: number; // and at least this far apart (m)
  displacementHeadingMaxInterval: number; // and at most this many seconds apart

  // ---- motion yaw ----
  // CMAttitude.yaw grows counter-clockwise seen from above; compass heading grows clockwise.
  // heading += yawToHeadingSign * deltaYaw
  yawToHeadingSign: 1 | -1;
  maxYawStepRad: number; // single-sample yaw jumps larger than this are treated as glitches and skipped

  // ---- pedometer ----
  maxWalkingSpeed: number; // m/s, pedometer deltas faster than this are clamped
  minPedometerIntervalS: number; // dt floor used for the clamp

  // ---- barometer ----
  maxVerticalSpeed: number; // m/s, relativeAltitude jumps faster than this are clamped

  // ---- confidence decay (dead reckoning without GPS) ----
  horizontalDecayTauS: number; // exp(-dt / tau) per second without GPS
  horizontalDecayDistanceM: number; // exp(-distance / d) per meter of PDR movement
  verticalDecayTauS: number;
  overallHorizontalWeight: number; // overall = h * w + v * (1 - w)

  // ---- output ----
  outputIntervalMs: number; // one fused position per this much sensor time (deterministic, batch-independent)
}

export const fusionConfigV1: FusionConfig = {
  goodGpsAccuracy: 5,
  fairGpsAccuracy: 10,
  poorGpsAccuracy: 20,

  gpsWeightGood: 0.7,
  gpsWeightFair: 0.4,
  gpsWeightPoor: 0.15,
  gpsWeightVeryPoor: 0.05,

  gpsConfidenceGood: 0.9,
  gpsConfidenceFair: 0.7,
  gpsConfidencePoor: 0.4,
  gpsConfidenceVeryPoor: 0.15,

  goodVerticalAccuracy: 5,
  fairVerticalAccuracy: 10,
  poorVerticalAccuracy: 20,
  verticalWeightGood: 0.5,
  verticalWeightFair: 0.25,
  verticalWeightPoor: 0.08,
  verticalWeightVeryPoor: 0.02,

  trustedCourseAccuracy: 8,
  trustedCourseMinSpeed: 0.8,
  courseAnchorWeight: 0.8,
  displacementHeadingEnabled: true,
  displacementHeadingAccuracy: 8,
  displacementHeadingMinDistance: 8,
  displacementHeadingMaxInterval: 30,

  yawToHeadingSign: -1,
  maxYawStepRad: 0.6,

  maxWalkingSpeed: 3.0,
  minPedometerIntervalS: 1.0,

  maxVerticalSpeed: 3.0,

  horizontalDecayTauS: 90,
  horizontalDecayDistanceM: 60,
  verticalDecayTauS: 180,
  overallHorizontalWeight: 0.7,

  outputIntervalMs: 1000,
};

// =====================================================================================================
// fusion-v2: conservative. Bad or physically implausible GPS does not move the position; a stationary
// user is held in place; PDR only moves along a GPS-anchored heading. All numbers are experimental
// starting points (tune with real campus walks, then reprocess sessions to compare).
// =====================================================================================================
export interface FusionConfigV2 {
  // ---- GPS quality gate (horizontalAccuracy, m) and correction weight alpha ----
  excellentGpsAccuracy: number; // <= EXCELLENT
  goodGpsAccuracy: number; // <= GOOD
  marginalGpsAccuracy: number; // <= MARGINAL, above = POOR
  gpsAlphaExcellent: number;
  gpsAlphaGood: number;
  gpsAlphaMarginal: number;
  gpsAlphaPoor: number; // 0 = POOR fixes never move XY (raw rows stay stored and visible)

  // ---- initialization ----
  initMaxAccuracy: number; // first fix at or below this initializes immediately
  initGraceMs: number; // otherwise, after this long, initialize provisionally from the best fix seen

  // ---- innovation gate: allowed = max(minimum, multiplier * sqrt(gpsAccuracy² + stateUncertainty²)) ----
  minimumInnovationGate: number;
  innovationAccuracyMultiplier: number;

  // ---- physical jump gate vs the last accepted fix: base + maxHumanSpeed * dt + both accuracies ----
  maximumHumanSpeed: number; // m/s
  jumpBaseTolerance: number; // m

  // ---- recovery: N consecutive gate rejections of good fixes => the state diverged, re-anchor ----
  reanchorAfterRejects: number;
  reanchorMaxAccuracy: number;
  reanchorMinSpanMs: number;

  // ---- uncertainty model (meters, heuristic) -> confidence = exp(-uncertainty / scale) ----
  pdrUncertaintyPerMeter: number; // per meter walked along a known heading
  unheadedUncertaintyPerMeter: number; // per meter walked with unknown heading (position not moved)
  movingUncertaintyPerSecond: number; // per second while not stationary
  confidenceScaleM: number;
  verticalUncertaintyPerSecond: number; // barometer drift
  verticalConfidenceScaleM: number;
  unknownVerticalUncertainty: number; // when no GPS vertical anchor exists yet

  // ---- stationary detection (all must hold over the window) ----
  stationaryWindowMs: number;
  maxStationaryDistanceDelta: number; // m of pedometer distance in the window
  /** CoreMotion userAcceleration is in g. Real data: walking windows RMS p10 0.29 g, still ~0.02–0.06 g. */
  maxStationaryAccelerationRms: number; // g
  minMotionSamplesForStationary: number; // fewer samples in the window => unknown => not stationary

  // ---- stable anchor while stationary (several excellent, tightly clustered fixes) ----
  stableAnchorEnabled: boolean;
  stableAnchorAccuracy: number;
  stableAnchorMinFixes: number;
  stableAnchorRadius: number;
  stableAnchorWindowMs: number;
  stableAnchorAlpha: number;

  // ---- heading (internal unit: radians; course converted from degrees) ----
  trustedCourseAccuracy: number;
  trustedCourseMinSpeed: number;
  headingAlpha: number; // soft re-anchor toward GPS course (circular interpolation)
  displacementHeadingEnabled: boolean;
  displacementHeadingAccuracy: number;
  displacementHeadingMinDistance: number;
  displacementHeadingMaxInterval: number; // s
  yawToHeadingSign: 1 | -1; // CoreMotion yaw is CCW-positive, compass heading CW-positive
  maxYawStepRad: number;

  // ---- pedometer (cumulative -> delta) ----
  maxPedestrianSpeed: number; // m/s
  minPedometerIntervalS: number;
  pedometerOverspeedPolicy: 'clamp' | 'reject';

  // ---- vertical ----
  goodVerticalAccuracy: number;
  fairVerticalAccuracy: number;
  poorVerticalAccuracy: number;
  verticalAlphaGood: number;
  verticalAlphaFair: number;
  verticalAlphaPoor: number;
  verticalAlphaVeryPoor: number;
  maxVerticalSpeed: number; // m/s, barometer deltas faster than this are clamped

  overallHorizontalWeight: number;
  outputIntervalMs: number;
}

export const fusionConfigV2: FusionConfigV2 = {
  excellentGpsAccuracy: 5,
  goodGpsAccuracy: 10,
  marginalGpsAccuracy: 15,
  gpsAlphaExcellent: 0.65,
  gpsAlphaGood: 0.3,
  gpsAlphaMarginal: 0.08,
  gpsAlphaPoor: 0,

  initMaxAccuracy: 15,
  initGraceMs: 30_000,

  minimumInnovationGate: 8,
  innovationAccuracyMultiplier: 2.0,

  maximumHumanSpeed: 3.5,
  jumpBaseTolerance: 5,

  reanchorAfterRejects: 5,
  reanchorMaxAccuracy: 10,
  reanchorMinSpanMs: 4000,

  pdrUncertaintyPerMeter: 0.08,
  unheadedUncertaintyPerMeter: 1.0,
  movingUncertaintyPerSecond: 0.05,
  confidenceScaleM: 15,
  verticalUncertaintyPerSecond: 0.005,
  verticalConfidenceScaleM: 10,
  unknownVerticalUncertainty: 50,

  stationaryWindowMs: 2000,
  maxStationaryDistanceDelta: 0.25,
  maxStationaryAccelerationRms: 0.12,
  minMotionSamplesForStationary: 10,

  stableAnchorEnabled: true,
  stableAnchorAccuracy: 5,
  stableAnchorMinFixes: 3,
  stableAnchorRadius: 3,
  stableAnchorWindowMs: 15_000,
  stableAnchorAlpha: 0.2,

  trustedCourseAccuracy: 8,
  trustedCourseMinSpeed: 0.8,
  headingAlpha: 0.5,
  displacementHeadingEnabled: true,
  displacementHeadingAccuracy: 8,
  displacementHeadingMinDistance: 8,
  displacementHeadingMaxInterval: 30,
  yawToHeadingSign: -1,
  maxYawStepRad: 0.6,

  maxPedestrianSpeed: 3.5,
  minPedometerIntervalS: 1.0,
  pedometerOverspeedPolicy: 'clamp',

  goodVerticalAccuracy: 5,
  fairVerticalAccuracy: 10,
  poorVerticalAccuracy: 20,
  verticalAlphaGood: 0.3,
  verticalAlphaFair: 0.1,
  verticalAlphaPoor: 0.02,
  verticalAlphaVeryPoor: 0,
  maxVerticalSpeed: 3.0,

  overallHorizontalWeight: 0.7,
  outputIntervalMs: 1000,
};

// =====================================================================================================
// fusion-v2.1: fixes v2 freezing at its first fix (indoor / vehicle GPS rejected + no heading ever).
// Wider GPS classes with tiny weights for poor fixes, heading bootstrap from two GPS points, re-anchoring
// to a consistent GPS cluster (PDR drift) or GPS track (transport the pedometer cannot explain),
// a divergence guard, anchor-based Z from the barometer, and event-driven extra outputs.
// =====================================================================================================
export interface FusionConfigV21 {
  // ---- GPS quality classes (horizontalAccuracy, m) -> XY correction weight alpha ----
  excellentGpsAccuracy: number;
  goodGpsAccuracy: number;
  marginalGpsAccuracy: number;
  poorGpsAccuracy: number; // above = UNUSABLE
  gpsAlphaExcellent: number;
  gpsAlphaGood: number;
  gpsAlphaMarginal: number;
  gpsAlphaPoor: number;
  gpsAlphaUnusable: number;

  // ---- initialization ----
  initMaxAccuracy: number;
  initGraceMs: number;
  /** Provisional start only from a fix at least this good: a 500 m fix is not a position at campus scale. */
  provisionalInitMaxAccuracy: number;
  /** While provisional, a fix this many times better than the current uncertainty replaces the start position. */
  provisionalSnapFactor: number;

  // ---- gates ----
  minimumInnovationGate: number;
  innovationAccuracyMultiplier: number; // allowed = max(min, k * sqrt(acc² + stateUncertainty²))
  maximumHumanSpeed: number;
  jumpBaseTolerance: number;

  // ---- GPS evidence buffer (cluster / track re-anchor, two-point bootstrap) ----
  evidenceMaxAccuracy: number; // fixes up to this accuracy are kept as evidence (POOR included)
  recentGpsWindowSize: number;
  recentGpsWindowMs: number;
  reanchorCooldownMs: number;
  // cluster: recent fixes agree on one area, PDR is far from it
  clusterMinFixes: number;
  clusterMaxAccuracy: number;
  clusterMaxSpread: number; // max distance of a fix from the cluster centroid
  clusterMinOffset: number; // state must be at least this far (and 2x median accuracy) from the centroid
  clusterReanchorAlpha: number; // soft reset toward the centroid
  // track: recent fixes form a self-consistent moving track the pedometer cannot explain (transport)
  trackMinFixes: number;
  trackMinSpanMs: number;
  trackMinDisplacement: number;
  trackMaxSpeed: number; // consecutive fixes faster than this are not one track
  trackPedometerTolerance: number; // GPS displacement must exceed pedometer distance + this

  // ---- divergence guard (bug guard: state may not move further than its evidence allows) ----
  divergenceTolerance: number;

  // ---- uncertainty / confidence ----
  pdrUncertaintyPerMeter: number;
  unheadedUncertaintyPerMeter: number;
  movingUncertaintyPerSecond: number;
  confidenceScaleM: number;
  verticalUncertaintyPerSecond: number;
  verticalConfidenceScaleM: number;
  unknownVerticalUncertainty: number;

  // ---- stationary ----
  stationaryWindowMs: number;
  maxStationaryDistanceDelta: number;
  maxStationaryAccelerationRms: number; // g
  minMotionSamplesForStationary: number;
  stableAnchorEnabled: boolean;
  stableAnchorAccuracy: number;
  stableAnchorMinFixes: number;
  stableAnchorRadius: number;
  stableAnchorWindowMs: number;
  stableAnchorAlpha: number;

  // ---- heading (radians internally) ----
  trustedCourseAccuracy: number;
  trustedCourseMinSpeed: number;
  headingAlpha: number;
  bootstrapMaxAccuracy: number; // both fixes at most this inaccurate
  minimumBootstrapDistance: number;
  /** Displacement must also exceed factor * sqrt(accA² + accB²): a 5 m step between two 25 m fixes is noise. */
  bootstrapNoiseFactor: number;
  bootstrapMaxIntervalMs: number;
  bootstrapMinPedometerDistance: number; // when pedometer data exists, the user must have walked between A and B
  refreshMaxAccuracy: number; // two-point bearing also refreshes an existing heading when both fixes are this good
  yawDeltaSourceThresholdRad: number; // heading_source becomes YAW_DELTA once yaw turned it this much since the anchor
  yawToHeadingSign: 1 | -1;
  maxYawStepRad: number;
  /** Motion samples further apart than this are not one continuous IMU stream (background pause): new yaw baseline. */
  motionContinuityThresholdMs: number;

  // ---- pedometer ----
  maxPedestrianSpeed: number;
  minPedometerIntervalS: number;

  // ---- vertical: z = datum + (relativeAltitude - baseRelativeAltitude) ----
  maxVerticalSpeed: number; // m/s; faster relativeAltitude jumps are treated as sensor glitches
  /** Without segment ids, an altimeter gap longer than this starts a new relativeAltitude baseline. */
  altimeterContinuityThresholdMs: number;
  goodVerticalAccuracy: number;
  fairVerticalAccuracy: number;
  poorVerticalAccuracy: number;
  verticalAlphaGood: number;
  verticalAlphaFair: number;
  verticalAlphaPoor: number;
  verticalAlphaVeryPoor: number;
  /** GPS height far from the barometer-carried Z is an outlier even with a small verticalAccuracy. */
  minimumVerticalInnovationGate: number;
  verticalInnovationMultiplier: number; // allowed = max(min, k * sqrt(vacc² + verticalUncertainty²))
  /** ...unless this many consecutive good fixes agree on another height (then the datum moves to them). */
  verticalReanchorAfterRejects: number;
  verticalReanchorSpread: number;
  verticalReanchorMaxAccuracy: number;

  // ---- output ----
  overallHorizontalWeight: number;
  outputIntervalMs: number;
  minImmediateOutputIntervalMs: number; // extra outputs on important events, but not closer than this
  significantZChange: number;

  // ---- post-run validation (warnings stored in fusion_runs) ----
  validationPathTolerance: number; // m added to the allowed horizontal displacement
  validationCriticalRatio: number; // fused displacement > ratio * allowed => CRITICAL_DIVERGENCE
  validationZTolerance: number; // m added to the barometer range
  validationZCriticalRatio: number;
}

export const fusionConfigV21: FusionConfigV21 = {
  excellentGpsAccuracy: 5,
  goodGpsAccuracy: 10,
  marginalGpsAccuracy: 20,
  poorGpsAccuracy: 35,
  gpsAlphaExcellent: 0.65,
  gpsAlphaGood: 0.3,
  gpsAlphaMarginal: 0.08,
  gpsAlphaPoor: 0.01,
  gpsAlphaUnusable: 0,

  initMaxAccuracy: 20,
  initGraceMs: 30_000,
  provisionalInitMaxAccuracy: 50,
  provisionalSnapFactor: 2,

  minimumInnovationGate: 8,
  innovationAccuracyMultiplier: 2.0,
  maximumHumanSpeed: 3.5,
  jumpBaseTolerance: 5,

  evidenceMaxAccuracy: 35,
  recentGpsWindowSize: 5,
  recentGpsWindowMs: 60_000,
  reanchorCooldownMs: 5000,
  clusterMinFixes: 3,
  clusterMaxAccuracy: 30,
  clusterMaxSpread: 20,
  clusterMinOffset: 40,
  clusterReanchorAlpha: 0.5,
  trackMinFixes: 4,
  trackMinSpanMs: 8000,
  trackMinDisplacement: 50,
  trackMaxSpeed: 60,
  trackPedometerTolerance: 30,

  divergenceTolerance: 30,

  pdrUncertaintyPerMeter: 0.08,
  unheadedUncertaintyPerMeter: 1.0,
  movingUncertaintyPerSecond: 0.05,
  confidenceScaleM: 15,
  verticalUncertaintyPerSecond: 0.005,
  verticalConfidenceScaleM: 10,
  unknownVerticalUncertainty: 50,

  stationaryWindowMs: 2000,
  maxStationaryDistanceDelta: 0.25,
  maxStationaryAccelerationRms: 0.12,
  minMotionSamplesForStationary: 10,
  stableAnchorEnabled: true,
  stableAnchorAccuracy: 5,
  stableAnchorMinFixes: 3,
  stableAnchorRadius: 3,
  stableAnchorWindowMs: 15_000,
  stableAnchorAlpha: 0.2,

  trustedCourseAccuracy: 10,
  trustedCourseMinSpeed: 0.8,
  headingAlpha: 0.5,
  bootstrapMaxAccuracy: 25,
  minimumBootstrapDistance: 5,
  bootstrapNoiseFactor: 0.5,
  bootstrapMaxIntervalMs: 30_000,
  bootstrapMinPedometerDistance: 1,
  refreshMaxAccuracy: 10,
  yawDeltaSourceThresholdRad: (10 * Math.PI) / 180,
  yawToHeadingSign: -1,
  maxYawStepRad: 0.6,
  motionContinuityThresholdMs: 2000,

  maxPedestrianSpeed: 3.5,
  minPedometerIntervalS: 1.0,

  maxVerticalSpeed: 4,
  altimeterContinuityThresholdMs: 30_000,
  goodVerticalAccuracy: 5,
  fairVerticalAccuracy: 10,
  poorVerticalAccuracy: 20,
  verticalAlphaGood: 0.3,
  verticalAlphaFair: 0.1,
  verticalAlphaPoor: 0.02,
  verticalAlphaVeryPoor: 0,
  minimumVerticalInnovationGate: 6,
  verticalInnovationMultiplier: 2.5,
  verticalReanchorAfterRejects: 5,
  verticalReanchorSpread: 6,
  verticalReanchorMaxAccuracy: 10,

  overallHorizontalWeight: 0.7,
  outputIntervalMs: 1000,
  minImmediateOutputIntervalMs: 500,
  significantZChange: 1.5,

  validationPathTolerance: 50,
  validationCriticalRatio: 3,
  validationZTolerance: 10,
  validationZCriticalRatio: 3,
};

/** Experimental fusion-v3 trust policy. Thresholds are starting values; compare against field walks. */
export const fusionConfigV3 = {
  anchorAccuracyM: 5,
  anchorStreakCount: 5,
  anchorStreakSpanMs: 3_000,
  anchorMaxGapMs: 2_000,
  walkingSpeedCeilingMps: 3.5,
  boundaryUncertaintyEnabled: true,
  maximumHorizontalUncertaintyM: 20,
};

/** Sensor-led fusion-v3.1. Values are versioned experiment defaults and require field calibration. */
export const fusionConfigV31 = {
  gpsAnchorAccuracyM: 5,
  gpsAnchorStreakCount: 5,
  gpsAnchorStreakSpanMs: 3_000,
  gpsAnchorMaxGapMs: 2_000,
  gpsAnchorMinIntervalMs: 30_000,
  gpsAnchorCorrectionMaxM: 12,
  gpsAnchorCorrectionAlpha: 0.75,
  anchorWalkingSpeedCeilingMps: 3.5,
  headingBootstrapMinWalkM: 4,
  headingBootstrapMinDisplacementM: 5,
  headingBootstrapMaxDistanceRatio: 1.8,
  yawToHeadingSign: -1 as const,
  maxYawStepRad: 0.6,
  motionContinuityMs: 1_500,
  stationaryWindowMs: 2_000,
  stationaryAccelRmsG: 0.035,
  minStationaryMotionSamples: 20,
  stepLengthM: 0.72,
  maxStepRatePerSecond: 4,
  maxWalkingSpeedMps: 3,
  pdrUncertaintyPerMeter: 0.08,
  headingUncertaintyPerMeter: 0.3,
  stepFallbackExtraUncertaintyPerMeter: 0.15,
  unheadedUncertaintyPerMeter: 0.8,
  movingUncertaintyPerSecond: 0.025,
  verticalUncertaintyPerSecond: 0.04,
  maxHorizontalUncertaintyM: 20,
  barometerContinuityMs: 10_000,
  maxVerticalSpeedMps: 2.5,
  outputIntervalMs: 1_000,
  mapBoundaryAccuracyFloorM: 1,
};

// ---- fusion-v4: step-level PDR + Kalman filter (x, y, heading offset) + RTS smoother on replay ----
export const fusionConfigV4 = {
  // step detection on 50 Hz CMDeviceMotion: vertical (gravity-aligned) user acceleration, in g
  stepLowPassHz: 3,
  stepPeakThresholdG: 0.08,
  stepMinIntervalS: 0.3,
  stepMaxIntervalS: 1.3,
  stepConfirmPeaks: 3, // periodic peaks in a row before they count as walking (phone handling is not periodic)
  motionGapMs: 2000, // longer motion gap => new heading segment
  // stride: CMPedometer distance per detected step (level and slope walking), flat-ground default until calibrated
  defaultStrideM: 0.72,
  strideMinM: 0.35,
  strideMaxM: 1.1,
  strideCalibrationMinSteps: 20,
  strideForgetting: 0.97, // per pedometer update
  healthStrideEnabled: true, // optional session-scoped HealthKit prior; false for paired-control variants
  healthStrideBlendSteps: 40, // accepted level steps to transition from the Health prior to this-session pedometer stride
  healthStrideSigmaFloorM: 0.1, // do not treat an aggregate from HealthKit as a precise per-step measurement
  strideStepMismatch: 0.3, // a stride sample needs CMPedometer's step count within this fraction (or 1 step) of ours
  strideSampleMaxUpdates: 3, // ...over at most this many pedometer updates (it reports in bursts: 0, 0, 10 steps)
  stairVerticalSpeedMps: 0.13, // barometric |dz/dt| while stepping => vertical movement; pattern decides stairs/slope
  stairWindowMs: 4000,
  stairTreadM: 0.3, // horizontal progress per stair step
  // slope (ramp / hill road) vs stairs: same barometric speed and rise per step; stairs fold back or end after a storey
  slopeMinClimbM: 5, // a climb longer than this (more than one storey) in one direction, along a straight path, is a slope
  slopeMinStraightness: 0.7, // net / walked length of the steps over that climb (stairwells measured <= 0.35, slopes >= 0.87)
  slopeRunGapMs: 4000, // vertical steps further apart are separate climbs (a landing or level stretch in between)
  slopeMaxRiseM: 0.25, // per step: steeper than a 25-30 % grade is not walked (elevator / escalator with a few steps)
  slopeStrideSigmaFraction: 0.15,
  verticalUnknownStrideSigmaFraction: 0.35,
  stairConfirmMinRiseM: 1.0,
  stairConfirmMaxStraightness: 0.55,
  stairConfirmMinTurnDeg: 120,
  // heading = -yaw + theta (yaw is relative); theta is estimated per heading segment
  poseChangeDeg: 50, // gravity direction change in the phone frame (hand <-> pocket) => new segment
  poseChangeHoldMs: 1000,
  continuityHeadingSigmaDeg: 35, // new segment: walking direction assumed to continue, this uncertain
  headingRandomWalkDegPerStep: 0.5,
  strideSigmaFraction: 0.1,
  stairStrideSigmaFraction: 0.25,
  // heading from the walked shape vs GPS fixes (grid search, robust)
  headingFitMinFixes: 3,
  headingFitMinSteps: 10,
  headingFitMinExtentM: 15,
  headingFitGridDeg: 2,
  headingFitMinCostGap: 2, // best vs best at >= ambiguity distance (log-likelihood units)
  headingFitAmbiguityDeg: 30,
  headingRefitAboveSigmaDeg: 25,
  // GPS (Core Location) as an accuracy-weighted measurement
  gpsMaxAccuracyM: 50,
  gpsSigmaFloorM: 5,
  gpsGateChi2: 13.8, // 2 dof, 99.9 %
  gpsResetRejects: 5,
  gpsResetMinSpanMs: 10_000,
  positionSigmaFloorM: 2,
  idleProcessNoiseM2PerS: 0.05,
  vehicleSpeedMps: 3,
  vehicleNoStepsMs: 10_000,
  vehicleProcessNoiseM2PerS: 225,
  // smoother (replay / finalization)
  smootherIterations: 3,
  smootherCauchyScale: 2, // residual scale in sigmas for the robust re-weighting
  outputIntervalMs: 1000,
  maxOutputSigmaM: 60,
  // stationary / height
  stationaryWindowMs: 2000,
  stationaryAccelRmsG: 0.04,
  datumMaxVerticalAccuracyM: 15,
  altimeterContinuityMs: 30_000,
  altimeterMaxSpeedMps: 4,
  // absolute height from the terrain DEM: "walking outdoors = ground + phone height" (ground contacts)
  phoneHeightM: 1.0,
  phoneHeightSigmaM: 0.3,
  contactMaxPositionSigmaM: 15,
  contactBuildingClearanceM: 3, // also at least half the position sigma away from any footprint
  contactMaxHeightSigmaM: 2.5, // DEM sigma + position sigma x slope (campus DEM sigma median 1.1-1.5 m)
  contactThinningMs: 5000, // consecutive steps share their errors: one contact per 5 s
  contactMinCount: 3, // thinned contacts (5 s apart), checked for agreement (MAD) below
  contactMinSpanMs: 10_000,
  contactMaxMadM: 1.5,
  contactOutlierM: 4, // e.g. a covered walkway misread as outdoors
  baroDriftMPerHour: 2, // random walk of the barometric zero (weather)
  gpsDatumGateM: 10, // GPS height used only when within this of ground + phone height (fixed: vacc was 3 m on -31 m heights)
  gpsDatumMaxAccuracyM: 15,
  gpsDatumMinSamples: 3,
  gpsDatumMaxMadM: 3,
  // indoor stairs: a barometric stair run between two moments inside the same building stays inside it
  indoorStairContextMs: 10_000,
  indoorStairRunGapMs: 4000,
  indoorStairMarginM: 2.5,
  indoorStairSigmaM: 1.0,
};
export type FusionConfigV4 = typeof fusionConfigV4;
