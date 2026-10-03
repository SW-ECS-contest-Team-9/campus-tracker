/** Sensor-led fusion-v3.1. GPS is consumed only as a qualified position-anchor event. */
import { localToWgs84 } from '../../geo/local-to-wgs84.js';
import { wgs84ToLocal } from '../../geo/wgs84-to-local.js';
import { headingRadToDeg, normalizeAngleRad, RAD_TO_DEG, wrapHeadingRad } from '../../geo/angles.js';
import { spatial, type SpatialContext } from '../../geo/spatial.js';
import { fusionConfigV31 } from './fusion.config.js';
import { createFusionStateV31, type FusionStateV31 } from './fusion-state-v31.js';
import { checkPedometerCounter, restartPedometerCounter } from './fusion.pedometer.js';
import type { Observation } from './fusion.timeline.js';
import type { FusedOutput, PositionSource } from './fusion.types.js';

export type AnchorSourceV31 = 'GPS' | 'MANUAL' | 'FIXED';
export interface AnchorInputV31 {
  sequence?: number;
  timestamp: number;
  latitude: number;
  longitude: number;
  horizontalUncertaintyM: number;
  source: AnchorSourceV31;
  headingDegrees?: number | null;
  relativeAltitudeM?: number | null;
}

export type FusionEventV31 =
  | { type: 'tracking-status'; t: number; status: FusionStateV31['trackingStatus']; reason: string }
  | { type: 'heading-status'; t: number; status: FusionStateV31['headingStatus']; reason: string }
  | { type: 'gps-anchor-decision'; t: number; sequence: number; accepted: boolean; reason: string; accuracy: number | null; campus: string; boundaryDistanceM: number | null; buildingId: string | null; buildingName: string | null }
  | { type: 'anchor-applied'; t: number; source: AnchorSourceV31; latitude: number; longitude: number; uncertaintyM: number; correctionM: number; segmentId: number }
  | { type: 'pedometer-delta'; t: number; distanceM: number; source: 'DISTANCE' | 'STEP_FALLBACK'; accepted: boolean; reason: string | null }
  | { type: 'stationary-state'; t: number; stationary: boolean | null; accelerationRmsG: number | null }
  | { type: 'heading-update'; t: number; headingDegrees: number; source: string; confidence: number }
  | { type: 'sensor-gap'; t: number; sensor: 'MOTION' | 'PEDOMETER' | 'ALTIMETER'; gapMs: number }
  | { type: 'altimeter-update'; t: number; relativeAltitudeM: number; accepted: boolean; reason: string | null }
  | { type: 'position-suppressed'; t: number; reason: string; uncertaintyM: number };

export interface StepResultV31 { outputs: FusedOutput[]; events: FusionEventV31[] }
const finite = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const roundConfidence = (uncertainty: number, scale = 20) => Number.isFinite(uncertainty) ? Math.max(0, Math.min(1, Math.exp(-uncertainty / scale))) : 0;
const currentHeight = (s: FusionStateV31) => s.hasRelativeZ ? s.relativeZ : 0;

function setTrackingStatus(s: FusionStateV31, t: number, status: FusionStateV31['trackingStatus'], reason: string, events: FusionEventV31[]) {
  if (s.trackingStatus === status) return;
  s.trackingStatus = status;
  events.push({ type: 'tracking-status', t, status, reason });
}

function setHeadingStatus(s: FusionStateV31, t: number, status: FusionStateV31['headingStatus'], reason: string, events: FusionEventV31[]) {
  if (s.headingStatus === status) return;
  s.headingStatus = status;
  s.headingUsableAfter = status === 'DEGRADED' ? t + fusionConfigV31.motionContinuityMs : undefined;
  events.push({ type: 'heading-status', t, status, reason });
}

function resetForNewSegment(s: FusionStateV31) {
  s.spatialSegmentId++;
  s.origin = undefined;
  s.x = 0;
  s.y = 0;
  s.lastAnchorT = undefined;
  s.lastAnchorAccuracy = undefined;
  s.lastAnchorSequence = undefined;
  s.lastAnchorWasCorrection = false;
  s.anchorCandidates = [];
  s.headingRad = undefined;
  s.headingStatus = 'UNKNOWN';
  s.headingConfidence = 0;
  s.headingSource = 'UNKNOWN';
  s.lastYaw = undefined;
  s.postureUnstableUntil = undefined;
  s.headingUsableAfter = undefined;
  s.headingStatus = 'UNKNOWN';
  s.horizontalUncertainty = Infinity;
  s.pedometerTotal = 0;
}

function applyAnchor(s: FusionStateV31, anchor: AnchorInputV31, events: FusionEventV31[], allowInitialHeading = false, candidates: FusionStateV31['anchorCandidates'] = []) {
  const classification = spatial.classify(anchor.latitude, anchor.longitude, anchor.horizontalUncertaintyM, s.context);
  if (classification.campus !== 'INSIDE') return false;
  const wasAnchored = s.origin !== undefined;
  let correction = 0;
  if (!wasAnchored || s.trackingStatus === 'REACQUIRE_REQUIRED') {
    if (s.trackingStatus === 'REACQUIRE_REQUIRED') resetForNewSegment(s);
    s.origin = { latitude: anchor.latitude, longitude: anchor.longitude, height: 0 };
    s.x = 0;
    s.y = 0;
    s.horizontalUncertainty = Math.max(anchor.horizontalUncertaintyM, 0.5);
    s.anchorCandidates = [];
    s.pedometerTotal = 0;
  } else {
    const target = wgs84ToLocal(s.origin!, anchor.latitude, anchor.longitude, 0);
    const shift = distance(target, s);
    if (shift > fusionConfigV31.gpsAnchorCorrectionMaxM) {
      setTrackingStatus(s, anchor.timestamp, 'REACQUIRE_REQUIRED', 'ANCHOR_CONFLICT', events);
      s.anchorCandidates = [];
      return false;
    }
    correction = shift * fusionConfigV31.gpsAnchorCorrectionAlpha;
    s.x += (target.x - s.x) * fusionConfigV31.gpsAnchorCorrectionAlpha;
    s.y += (target.y - s.y) * fusionConfigV31.gpsAnchorCorrectionAlpha;
    s.horizontalUncertainty = Math.max(0.5, Math.min(s.horizontalUncertainty, anchor.horizontalUncertaintyM, shift + anchor.horizontalUncertaintyM));
  }
  s.lastAnchorT = anchor.timestamp;
  s.lastAnchorAccuracy = anchor.horizontalUncertaintyM;
  s.lastAnchorSequence = anchor.sequence;
  s.lastAnchorWasCorrection = wasAnchored && s.trackingStatus === 'TRACKING';
  if (s.lastAnchorWasCorrection) s.reanchorCount++;
  s.anchorCandidates = [];
  s.lastPedometerDistance = undefined;
  s.lastPedometerT = undefined;
  setTrackingStatus(s, anchor.timestamp, 'TRACKING', wasAnchored ? 'GPS_ANCHOR' : `${anchor.source}_ANCHOR`, events);

  if (anchor.headingDegrees !== undefined && anchor.headingDegrees !== null && Number.isFinite(anchor.headingDegrees)) {
    s.headingRad = wrapHeadingRad(anchor.headingDegrees * Math.PI / 180);
    s.headingConfidence = 0.8;
    s.headingSource = anchor.source === 'GPS' ? 'GPS_COURSE' : anchor.source === 'MANUAL' ? 'MANUAL_ANCHOR' : 'FIXED_ANCHOR';
    s.lastYaw = undefined; // the previous yaw delta predates this absolute direction anchor
    setHeadingStatus(s, anchor.timestamp, 'VALID', 'ANCHOR_HEADING', events);
  } else if (allowInitialHeading && candidates.length >= 2) {
    const first = candidates[0];
    const last = candidates.at(-1)!;
    const walked = last.pedometerTotal - first.pedometerTotal;
    const a = first.observation;
    const b = last.observation;
    const origin = { latitude: a.latitude, longitude: a.longitude, height: 0 };
    const p0 = wgs84ToLocal(origin, a.latitude, a.longitude, 0);
    const p1 = wgs84ToLocal(origin, b.latitude, b.longitude, 0);
    const displacement = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (walked >= fusionConfigV31.headingBootstrapMinWalkM
      && displacement >= fusionConfigV31.headingBootstrapMinDisplacementM
      && displacement <= walked * fusionConfigV31.headingBootstrapMaxDistanceRatio) {
      s.headingRad = wrapHeadingRad(Math.atan2(p1.x - p0.x, p1.y - p0.y));
      s.headingConfidence = 0.55;
      s.headingSource = 'GPS_ANCHOR_DISPLACEMENT';
      setHeadingStatus(s, anchor.timestamp, 'VALID', 'WALKING_DISPLACEMENT', events);
    }
  }
  events.push({ type: 'anchor-applied', t: anchor.timestamp, source: anchor.source,
    latitude: anchor.latitude, longitude: anchor.longitude, uncertaintyM: anchor.horizontalUncertaintyM,
    correctionM: correction, segmentId: s.spatialSegmentId });
  return true;
}

/** Explicit anchor seam for future QR/fixed-point and user-selected anchors. */
export function applyExternalAnchorV31(state: FusionStateV31, anchor: AnchorInputV31): StepResultV31 {
  const events: FusionEventV31[] = [];
  const applied = applyAnchor(state, anchor, events);
  if (!applied) events.push({ type: 'tracking-status', t: anchor.timestamp, status: state.trackingStatus, reason: 'ANCHOR_REJECTED' });
  return { outputs: [], events };
}

function recordGpsDecision(s: FusionStateV31, o: Extract<Observation, { kind: 'gps' }>, accepted: boolean, reason: string, events: FusionEventV31[]) {
  if (accepted) s.gpsAccepted++;
  else {
    s.gpsRejected++;
    s.rejectReasons[reason] = (s.rejectReasons[reason] ?? 0) + 1;
  }
  const c = o.spatialClassification;
  events.push({ type: 'gps-anchor-decision', t: o.t, sequence: o.seq, accepted, reason,
    accuracy: o.horizontalAccuracy, campus: c?.campus ?? 'MAP_UNAVAILABLE', boundaryDistanceM: c?.boundaryDistanceM ?? null,
    buildingId: c?.buildingId ?? null, buildingName: c?.buildingName ?? null });
}

function rejectGps(s: FusionStateV31, o: Extract<Observation, { kind: 'gps' }>, reason: string, events: FusionEventV31[]) {
  s.anchorCandidates = [];
  recordGpsDecision(s, o, false, reason, events);
}

function applyGpsObservation(s: FusionStateV31, o: Extract<Observation, { kind: 'gps' }>, events: FusionEventV31[]) {
  const c = o.spatialClassification;
  if (o.preSession) return rejectGps(s, o, 'PRE_SESSION', events);
  if (!c || c.campus !== 'INSIDE') return rejectGps(s, o, c?.campus ?? 'MAP_UNAVAILABLE', events);
  if (!finite(o.horizontalAccuracy) || o.horizontalAccuracy <= 0 || o.horizontalAccuracy > fusionConfigV31.gpsAnchorAccuracyM) {
    return rejectGps(s, o, 'POOR_ACCURACY', events);
  }
  const previous = s.anchorCandidates.at(-1);
  if (previous) {
    const dt = o.t - previous.observation.t;
    const p = wgs84ToLocal({ latitude: previous.observation.latitude, longitude: previous.observation.longitude, height: 0 }, o.latitude, o.longitude, 0);
    const allowance = fusionConfigV31.anchorWalkingSpeedCeilingMps * (dt / 1000)
      + previous.observation.horizontalAccuracy! + o.horizontalAccuracy + 2;
    if (dt <= 0 || dt > fusionConfigV31.gpsAnchorMaxGapMs || Math.hypot(p.x, p.y) > allowance) s.anchorCandidates = [];
  }
  s.anchorCandidates.push({ observation: o, pedometerTotal: s.pedometerTotal });
  s.anchorCandidates = s.anchorCandidates.slice(-fusionConfigV31.gpsAnchorStreakCount);
  const first = s.anchorCandidates[0];
  const spanMs = o.t - first.observation.t;
  const qualified = s.anchorCandidates.length === fusionConfigV31.gpsAnchorStreakCount && spanMs >= fusionConfigV31.gpsAnchorStreakSpanMs;
  if (!qualified) return recordGpsDecision(s, o, false, 'WAITING_FOR_STREAK', events);

  const fixes = s.anchorCandidates.slice();
  const needsHeadingBootstrap = s.origin === undefined || s.trackingStatus === 'REACQUIRE_REQUIRED'
    || s.headingRad === undefined || s.headingStatus === 'DEGRADED';
  if (s.origin && s.trackingStatus === 'TRACKING' && s.lastAnchorT !== undefined
    && o.t - s.lastAnchorT < fusionConfigV31.gpsAnchorMinIntervalMs) {
    s.anchorCandidates = [];
    return recordGpsDecision(s, o, false, 'ANCHOR_COOLDOWN', events);
  }
  const applied = applyAnchor(s, {
    sequence: o.seq,
    timestamp: o.t, latitude: o.latitude, longitude: o.longitude,
    horizontalUncertaintyM: o.horizontalAccuracy!, source: 'GPS',
  }, events, needsHeadingBootstrap, fixes);
  recordGpsDecision(s, o, applied, applied ? 'ANCHOR_APPLIED' : 'ANCHOR_CONFLICT', events);
}

function updateStationary(s: FusionStateV31, t: number, events: FusionEventV31[]) {
  const from = t - fusionConfigV31.stationaryWindowMs;
  while (s.accelWindow.length && s.accelWindow[0].t < from) s.accelWindow.shift();
  const previous = s.stationary;
  const enough = s.accelWindow.length >= fusionConfigV31.minStationaryMotionSamples;
  const rms = enough ? Math.sqrt(s.accelWindow.reduce((sum, x) => sum + x.magnitudeG ** 2, 0) / s.accelWindow.length) : null;
  const quietSteps = s.lastMovementT === undefined || t - s.lastMovementT >= fusionConfigV31.stationaryWindowMs;
  s.stationary = rms === null ? null : quietSteps && rms <= fusionConfigV31.stationaryAccelRmsG;
  if (s.stationary !== previous) events.push({ type: 'stationary-state', t, stationary: s.stationary, accelerationRmsG: rms });
}

function applyMotion(s: FusionStateV31, o: Extract<Observation, { kind: 'motion' }>, events: FusionEventV31[]) {
  if (finite(o.ax) && finite(o.ay) && finite(o.az)) {
    s.accelWindow.push({ t: o.t, magnitudeG: Math.hypot(o.ax, o.ay, o.az) });
  }
  const changed = s.lastMotionSegment !== undefined && (o.segment ?? null) !== s.lastMotionSegment;
  const gap = s.lastMotionT === undefined ? 0 : o.t - s.lastMotionT;
  if (gap > fusionConfigV31.motionContinuityMs || changed) {
    if (s.lastMotionT !== undefined) events.push({ type: 'sensor-gap', t: o.t, sensor: 'MOTION', gapMs: gap });
    s.motionGaps++;
    s.lastYaw = undefined;
    if (s.headingRad !== undefined) setHeadingStatus(s, o.t, 'DEGRADED', 'MOTION_GAP', events);
  }
  s.lastMotionT = o.t;
  s.lastMotionSegment = o.segment ?? null;
  const tiltChanged = finite(o.roll) && finite(o.pitch) && s.lastRoll !== undefined && s.lastPitch !== undefined
    && Math.hypot(normalizeAngleRad(o.roll - s.lastRoll), normalizeAngleRad(o.pitch - s.lastPitch)) > 0.8;
  let gravityChanged = false;
  if (finite(o.gx) && finite(o.gy) && finite(o.gz)) {
    const current = { x: o.gx, y: o.gy, z: o.gz };
    if (s.lastGravity) {
      const a = Math.hypot(s.lastGravity.x, s.lastGravity.y, s.lastGravity.z);
      const b = Math.hypot(current.x, current.y, current.z);
      const cosine = (s.lastGravity.x * current.x + s.lastGravity.y * current.y + s.lastGravity.z * current.z) / Math.max(a * b, 1e-9);
      gravityChanged = Math.acos(Math.max(-1, Math.min(1, cosine))) > 0.8;
    }
    s.lastGravity = current;
  }
  const rotationRate = finite(o.rx) && finite(o.ry) && finite(o.rz) ? Math.hypot(o.rx, o.ry, o.rz) : null;
  if (finite(o.roll)) s.lastRoll = o.roll;
  if (finite(o.pitch)) s.lastPitch = o.pitch;
  if (tiltChanged || gravityChanged || (rotationRate !== null && rotationRate > 8)) {
    if (s.headingRad !== undefined) setHeadingStatus(s, o.t, 'DEGRADED', tiltChanged || gravityChanged ? 'PHONE_POSE_CHANGED' : 'FAST_PHONE_ROTATION', events);
    s.postureUnstableUntil = o.t + fusionConfigV31.stationaryWindowMs;
    s.lastYaw = finite(o.yaw) ? o.yaw : undefined;
    return;
  }
  if (s.postureUnstableUntil !== undefined) {
    s.lastYaw = finite(o.yaw) ? o.yaw : undefined;
    if (o.t < s.postureUnstableUntil) return;
    s.postureUnstableUntil = undefined;
    if (s.headingRad !== undefined) setHeadingStatus(s, o.t, 'VALID', 'PHONE_POSE_STABLE', events);
    return; // establish a clean yaw baseline; never integrate the pose-change interval
  }
  if (!finite(o.yaw)) return;
  if (s.headingStatus === 'DEGRADED') {
    s.lastYaw = o.yaw;
    if (s.headingUsableAfter !== undefined && o.t >= s.headingUsableAfter) {
      setHeadingStatus(s, o.t, 'VALID', 'MOTION_CONTINUITY_RESTORED', events);
    }
    return; // collect a fresh baseline before allowing yaw to move the track
  }
  if (s.lastYaw !== undefined && s.headingRad !== undefined) {
    const d = normalizeAngleRad(o.yaw - s.lastYaw) * fusionConfigV31.yawToHeadingSign;
    if (Math.abs(d) <= fusionConfigV31.maxYawStepRad) {
      s.headingRad = wrapHeadingRad(s.headingRad + d);
      s.headingSource = 'YAW_DELTA';
    } else {
      events.push({ type: 'sensor-gap', t: o.t, sensor: 'MOTION', gapMs: 0 });
      setHeadingStatus(s, o.t, 'DEGRADED', 'YAW_GLITCH', events);
      s.lastYaw = o.yaw;
      return;
    }
  }
  s.lastYaw = o.yaw;
}

function applyPedometer(s: FusionStateV31, o: Extract<Observation, { kind: 'pedometer' }>, events: FusionEventV31[]) {
  const segmentChanged = s.lastPedometerSegment !== undefined && (o.segment ?? null) !== s.lastPedometerSegment;
  const steps = finite(o.steps) ? o.steps : null;
  const cumulativeDistance = finite(o.distance) ? o.distance : null;
  if (s.lastPedometerT !== undefined && !segmentChanged) {
    // Only values above the run's maximum count; a lower sample (e.g. an interleaved 0) is ignored entirely:
    // it is never the baseline and does not count as a sensor gap or as the last pedometer time.
    const verdict = checkPedometerCounter(s.pedometerCounter, steps, cumulativeDistance);
    if (verdict !== 'OK') {
      if (verdict === 'COUNTER_RESTARTED') {
        s.lastPedometerDistance = cumulativeDistance ?? undefined;
        s.lastStepCount = steps ?? undefined;
        s.lastPedometerT = o.t;
      }
      events.push({ type: 'pedometer-delta', t: o.t, distanceM: 0, source: 'DISTANCE', accepted: false, reason: verdict });
      return;
    }
  }
  const gapMs = s.lastPedometerT === undefined ? 0 : o.t - s.lastPedometerT;
  if (gapMs > 5_000 || segmentChanged) {
    if (s.lastPedometerT !== undefined) events.push({ type: 'sensor-gap', t: o.t, sensor: 'PEDOMETER', gapMs });
    s.lastPedometerDistance = undefined;
    s.lastStepCount = undefined;
  }
  if (s.lastPedometerT === undefined || segmentChanged) {
    restartPedometerCounter(s.pedometerCounter, steps, cumulativeDistance);
    s.lastPedometerDistance = finite(o.distance) ? o.distance : undefined;
    s.lastStepCount = finite(o.steps) ? o.steps : undefined;
    s.lastPedometerT = o.t;
    s.lastPedometerSegment = o.segment ?? null;
    return;
  }
  const dt = Math.max(0, gapMs / 1000);
  const stepDelta = finite(o.steps) && s.lastStepCount !== undefined ? o.steps - s.lastStepCount : null;
  let delta: number | null = null;
  let source: 'DISTANCE' | 'STEP_FALLBACK' = 'DISTANCE';
  let reason: string | null = null;
  if (finite(o.distance) && s.lastPedometerDistance !== undefined) delta = o.distance - s.lastPedometerDistance;
  else if (stepDelta !== null && stepDelta > 0 && dt > 0) {
    source = 'STEP_FALLBACK';
    if (stepDelta > dt * fusionConfigV31.maxStepRatePerSecond) reason = 'STEP_RATE_LIMIT';
    delta = Math.min(stepDelta, dt * fusionConfigV31.maxStepRatePerSecond) * fusionConfigV31.stepLengthM;
    s.fallbackStepDistance += delta;
  } else if (finite(o.distance) && s.lastPedometerDistance === undefined) reason = 'DISTANCE_REBASE_AFTER_FALLBACK';

  if (delta !== null && Number.isFinite(delta) && delta > 0 && reason === null) {
    const cap = fusionConfigV31.maxWalkingSpeedMps * Math.max(dt, 0.25);
    if (delta > cap) { delta = cap; reason = 'WALKING_SPEED_CLAMPED'; }
    s.pedometerTotal += delta;
    s.lastMovementT = o.t;
    if (s.trackingStatus === 'TRACKING') {
      if (s.headingRad !== undefined && s.headingStatus !== 'DEGRADED') {
        s.x += delta * Math.sin(s.headingRad);
        s.y += delta * Math.cos(s.headingRad);
        s.horizontalUncertainty += delta * (fusionConfigV31.pdrUncertaintyPerMeter
          + (1 - s.headingConfidence) * fusionConfigV31.headingUncertaintyPerMeter
          + (source === 'STEP_FALLBACK' ? fusionConfigV31.stepFallbackExtraUncertaintyPerMeter : 0));
      } else {
        s.horizontalUncertainty += delta * (fusionConfigV31.unheadedUncertaintyPerMeter
          + (source === 'STEP_FALLBACK' ? fusionConfigV31.stepFallbackExtraUncertaintyPerMeter : 0));
      }
    }
    events.push({ type: 'pedometer-delta', t: o.t, distanceM: delta, source, accepted: true, reason });
  } else if (delta !== null && delta < 0) {
    events.push({ type: 'pedometer-delta', t: o.t, distanceM: delta, source, accepted: false, reason: 'NEGATIVE_DELTA' });
  } else if (reason) events.push({ type: 'pedometer-delta', t: o.t, distanceM: 0, source, accepted: false, reason });

  // Returning distance after step fallback establishes a fresh baseline; already applied steps are not counted twice.
  s.lastPedometerDistance = finite(o.distance) ? o.distance : undefined;
  s.lastStepCount = finite(o.steps) ? o.steps : undefined;
  s.lastPedometerT = o.t;
  s.lastPedometerSegment = o.segment ?? null;
}

function applyAltimeter(s: FusionStateV31, o: Extract<Observation, { kind: 'altimeter' }>, events: FusionEventV31[]) {
  if (!finite(o.relativeAltitude)) return;
  const changed = s.lastAltimeterSegment !== undefined && (o.segment ?? null) !== s.lastAltimeterSegment;
  const gap = s.lastAltimeterT === undefined ? 0 : o.t - s.lastAltimeterT;
  if (s.lastAltimeterT !== undefined && (changed || (o.segment == null && gap > fusionConfigV31.barometerContinuityMs))) {
    s.altimeterRebases++;
    s.lastRelativeAltitude = o.relativeAltitude;
    s.lastAltimeterT = o.t;
    s.lastAltimeterSegment = o.segment ?? null;
    events.push({ type: 'sensor-gap', t: o.t, sensor: 'ALTIMETER', gapMs: gap });
    events.push({ type: 'altimeter-update', t: o.t, relativeAltitudeM: o.relativeAltitude, accepted: false, reason: 'BASELINE_REBASED' });
    return;
  }
  if (s.lastRelativeAltitude === undefined) {
    s.lastRelativeAltitude = o.relativeAltitude;
    s.lastAltimeterT = o.t;
    s.lastAltimeterSegment = o.segment ?? null;
    s.relativeZ = 0;
    s.hasRelativeZ = true;
    s.verticalUncertainty = 0.5;
    events.push({ type: 'altimeter-update', t: o.t, relativeAltitudeM: 0, accepted: true, reason: 'BASELINE' });
    return;
  }
  const delta = o.relativeAltitude - s.lastRelativeAltitude;
  const dt = Math.max(0, gap / 1000);
  s.lastAltimeterT = o.t;
  s.lastAltimeterSegment = o.segment ?? null;
  if (Math.abs(delta) > fusionConfigV31.maxVerticalSpeedMps * Math.max(dt, 1)) {
    events.push({ type: 'altimeter-update', t: o.t, relativeAltitudeM: delta, accepted: false, reason: 'VERTICAL_SPEED_LIMIT' });
    return;
  }
  s.relativeZ += delta;
  s.lastRelativeAltitude = o.relativeAltitude;
  s.hasRelativeZ = true;
  events.push({ type: 'altimeter-update', t: o.t, relativeAltitudeM: delta, accepted: true, reason: null });
}

function spatialGate(s: FusionStateV31, t: number, events: FusionEventV31[]) {
  if (s.trackingStatus !== 'TRACKING' || !s.origin) return;
  if (s.horizontalUncertainty > fusionConfigV31.maxHorizontalUncertaintyM) {
    events.push({ type: 'position-suppressed', t, reason: 'UNCERTAINTY_LIMIT', uncertaintyM: s.horizontalUncertainty });
    setTrackingStatus(s, t, 'REACQUIRE_REQUIRED', 'UNCERTAINTY_LIMIT', events);
    s.anchorCandidates = [];
    return;
  }
  const ll = localToWgs84(s.origin, { x: s.x, y: s.y, z: currentHeight(s) });
  const c = spatial.classify(ll.latitude, ll.longitude, Math.max(s.horizontalUncertainty, fusionConfigV31.mapBoundaryAccuracyFloorM), s.context);
  if (c.campus !== 'INSIDE') {
    events.push({ type: 'position-suppressed', t, reason: c.campus, uncertaintyM: s.horizontalUncertainty });
    setTrackingStatus(s, t, 'REACQUIRE_REQUIRED', c.campus, events);
    s.anchorCandidates = [];
  }
}

function makeOutput(s: FusionStateV31, t: number): FusedOutput | null {
  if (s.trackingStatus !== 'TRACKING' || !s.origin || s.horizontalUncertainty > fusionConfigV31.maxHorizontalUncertaintyM) return null;
  const p = localToWgs84(s.origin, { x: s.x, y: s.y, z: currentHeight(s) });
  const c = spatial.classify(p.latitude, p.longitude, Math.max(s.horizontalUncertainty, 0.5), s.context);
  if (c.campus !== 'INSIDE') return null;
  const h = roundConfidence(s.horizontalUncertainty);
  const v = s.hasRelativeZ ? roundConfidence(s.verticalUncertainty, 10) : 0;
  const now = t;
  const source: PositionSource = s.lastAnchorT === now ? (s.lastAnchorWasCorrection ? 'GPS_CORRECTED' : 'GPS_ANCHORED') : s.stationary ? 'STATIONARY_HOLD' : s.headingRad === undefined ? 'HELD' : 'PDR_PREDICTED';
  s.fusionSequence++;
  return {
    fusionSequence: s.fusionSequence, timestamp: now, latitude: p.latitude, longitude: p.longitude,
    ellipsoidalAltitude: null, geomZ: currentHeight(s), x: s.x, y: s.y, z: currentHeight(s),
    headingDegrees: s.headingRad === undefined ? null : headingRadToDeg(s.headingRad),
    horizontalConfidence: h, verticalConfidence: v, overallConfidence: h * 0.75 + v * 0.25,
    gpsHorizontalAccuracy: s.lastAnchorAccuracy ?? null, gpsVerticalAccuracy: null, source,
    gpsUsed: s.lastAnchorT === now, gpsRejectReason: null, gpsSequence: s.lastAnchorT === now ? s.lastAnchorSequence ?? null : null, innovationDistance: null,
    stationary: s.stationary, headingSource: s.headingRad === undefined ? 'UNKNOWN' : s.headingSource,
    horizontalUncertainty: s.horizontalUncertainty, gpsQuality: null,
    pdrApplied: s.lastMovementT === now, pdrRejectReason: null, relativeAltitude: s.hasRelativeZ ? s.relativeZ : null,
    reanchored: s.lastAnchorT === now && s.lastAnchorWasCorrection, reanchorReason: null, divergenceDetected: false,
    spatialMapVersionId: s.mapVersionId, spatialStatus: c.campus, buildingId: c.buildingId,
    buildingName: c.buildingName, buildingMatchStatus: c.buildingMatchStatus, spatialSegmentId: s.spatialSegmentId,
  };
}

export function processObservationV31(s: FusionStateV31, o: Observation): StepResultV31 {
  const result: StepResultV31 = { outputs: [], events: [] };
  if (o.spatialContext !== undefined) { s.context = o.spatialContext; s.mapVersionId = o.spatialContext?.mapVersionId ?? null; }
  if (s.lastObservationT === undefined) {
    result.events.push({ type: 'tracking-status', t: o.t, status: s.trackingStatus, reason: 'INITIAL' });
    result.events.push({ type: 'heading-status', t: o.t, status: s.headingStatus, reason: 'INITIAL' });
  }
  if (s.lastObservationT !== undefined && o.t < s.lastObservationT) {
    s.skippedLateObservations++;
    return result;
  }
  if (s.lastObservationT !== undefined && s.trackingStatus === 'TRACKING') {
    const dt = Math.max(0, (o.t - s.lastObservationT) / 1000);
    if (s.stationary !== true) s.horizontalUncertainty += dt * fusionConfigV31.movingUncertaintyPerSecond;
    s.verticalUncertainty += dt * fusionConfigV31.verticalUncertaintyPerSecond;
    if (s.stationary === true) s.stationaryMs += dt * 1000;
  }
  if (o.kind === 'motion') applyMotion(s, o, result.events);
  else if (o.kind === 'pedometer') applyPedometer(s, o, result.events);
  else if (o.kind === 'altimeter') applyAltimeter(s, o, result.events);
  updateStationary(s, o.t, result.events);
  if (o.kind === 'gps') applyGpsObservation(s, o, result.events);
  spatialGate(s, o.t, result.events);
  s.lastObservationT = o.t;

  if (s.trackingStatus === 'TRACKING' && (s.nextOutputAt === undefined || o.t >= s.nextOutputAt)) {
    const out = makeOutput(s, o.t);
    if (out) {
      result.outputs.push(out);
      s.lastOutputT = o.t;
      s.lastEmittedHeight = currentHeight(s);
    } else result.events.push({ type: 'position-suppressed', t: o.t, reason: 'NO_VALID_POSITION', uncertaintyM: s.horizontalUncertainty });
    s.nextOutputAt = (Math.floor(o.t / fusionConfigV31.outputIntervalMs) + 1) * fusionConfigV31.outputIntervalMs;
  }
  return result;
}

export function flushFusionV31(s: FusionStateV31): StepResultV31 {
  const result: StepResultV31 = { outputs: [], events: [] };
  if (s.trackingStatus === 'TRACKING' && s.lastObservationT !== undefined && s.lastOutputT !== s.lastObservationT) {
    const out = makeOutput(s, s.lastObservationT);
    if (out) { result.outputs.push(out); s.lastOutputT = s.lastObservationT; }
  }
  return result;
}

export function summarizeV31(s: FusionStateV31): {
  gpsAccepted: number; gpsRejected: number; rejectReasons: Record<string, number>; maxRejectedInnovation: null;
  stationaryMs: number; motionGaps: number; altimeterRebases: number; reanchors: number; divergences: number;
  trackingStatus: string; headingStatus: string; fallbackStepDistance: number; horizontalUncertainty: number;
} {
  return { gpsAccepted: s.gpsAccepted, gpsRejected: s.gpsRejected, rejectReasons: s.rejectReasons,
    maxRejectedInnovation: null, stationaryMs: s.stationaryMs, motionGaps: s.motionGaps,
    altimeterRebases: s.altimeterRebases, reanchors: s.reanchorCount, divergences: 0,
    trackingStatus: s.trackingStatus, headingStatus: s.headingStatus,
    fallbackStepDistance: s.fallbackStepDistance, horizontalUncertainty: s.horizontalUncertainty };
}

export function describeEventV31(e: FusionEventV31) {
  return { event: `fusion.v31.${e.type.replaceAll('-', '_')}`, fields: { ...e } };
}

export { createFusionStateV31, fusionConfigV31 };
