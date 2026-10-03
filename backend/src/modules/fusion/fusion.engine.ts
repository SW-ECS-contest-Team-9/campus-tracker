/**
 * Fusion v1 — heuristic, complementary sensor fusion (pure logic: no Express / WebSocket / DB).
 *
 *   GPS        -> absolute position anchor, corrected with an accuracy-dependent weight
 *   Pedometer  -> horizontal distance (delta of the cumulative CMPedometer distance)
 *   Motion yaw -> heading CHANGE only (CMAttitude yaw is relative to an arbitrary reference frame)
 *   GPS course -> absolute heading anchor when moving with good accuracy (fallback: displacement of trusted fixes)
 *   Barometer  -> relative Z change (delta of relativeAltitude)
 *   GPS ellipsoidalAltitude -> absolute Z anchor, weighted by verticalAccuracy
 *
 * Known limits (this is NOT a complete indoor localization):
 *   - The phone's orientation is not the walking direction: holding it differently, putting it in a pocket
 *     or turning it without turning the body changes yaw but not the path.
 *   - Pedometer distance error (stride model), yaw drift (no magnetometer in xArbitraryZVertical),
 *     magnetic/environment interference, GPS multipath indoors, barometer drift (weather, HVAC).
 *   - Euler yaw degrades when the phone is held near vertical (pitch ≈ ±90°).
 * Future versions can add step-heading estimation, magnetometer heading and map matching as separate steps.
 *
 * Determinism: the same observations in the same order always give the same outputs. Outputs are emitted on
 * sensor-time ticks (outputIntervalMs), not per network batch, so realtime processing and offline replay of
 * the same session produce the same fused_positions.
 */
import { localToWgs84 } from '../../geo/local-to-wgs84.js';
import { wgs84ToLocal } from '../../geo/wgs84-to-local.js';
import { blendHeadingRad, DEG_TO_RAD, headingRadToDeg, normalizeAngleRad, RAD_TO_DEG, wrapHeadingRad } from '../../geo/angles.js';
import type { FusionConfig } from './fusion.config.js';
import { emptyWindow, type FusionState } from './fusion-state.js';

// Timeline and output types are shared with later versions (fusion.timeline.ts / fusion.types.ts).
import { buildTimeline, compareObservations, type Observation, type RawSamples } from './fusion.timeline.js';
import type { FusedOutput, PositionSource } from './fusion.types.js';
export { buildTimeline, compareObservations, type Observation, type RawSamples, type FusedOutput, type PositionSource };

// ---------------- outputs / events ----------------

/** Debug events. Per-sample motion/barometer changes are summarized in the `output` event, not logged one by one. */
export type FusionEvent =
  | { type: 'initialized'; t: number; horizontalAccuracy: number; confidence: number }
  | { type: 'gps-correction'; t: number; quality: GpsQuality; horizontalAccuracy: number; weight: number; shift: number }
  | { type: 'gps-rejected'; t: number; reason: string }
  | { type: 'heading-anchor'; t: number; source: 'course' | 'displacement'; headingDeg: number }
  | { type: 'pedometer'; t: number; delta: number; clamped: boolean; moved: boolean }
  | { type: 'pedometer-ignored'; t: number; delta: number }
  | { type: 'yaw-glitch'; t: number; deltaDeg: number }
  | { type: 'late-observation'; t: number; kind: Observation['kind'] }
  | { type: 'output'; output: FusedOutput; yawDeltaDeg: number; pdrDistance: number; dz: number; gpsCount: number };

export interface StepResult {
  outputs: FusedOutput[];
  events: FusionEvent[];
}

// ---------------- helpers ----------------

export type GpsQuality = 'GOOD' | 'FAIR' | 'POOR' | 'VERY_POOR';

export function classifyGps(hacc: number, c: FusionConfig): GpsQuality {
  if (hacc <= c.goodGpsAccuracy) return 'GOOD';
  if (hacc <= c.fairGpsAccuracy) return 'FAIR';
  if (hacc <= c.poorGpsAccuracy) return 'POOR';
  return 'VERY_POOR';
}

export function gpsWeight(q: GpsQuality, c: FusionConfig): number {
  return { GOOD: c.gpsWeightGood, FAIR: c.gpsWeightFair, POOR: c.gpsWeightPoor, VERY_POOR: c.gpsWeightVeryPoor }[q];
}

function gpsConfidence(q: GpsQuality, c: FusionConfig): number {
  return { GOOD: c.gpsConfidenceGood, FAIR: c.gpsConfidenceFair, POOR: c.gpsConfidencePoor, VERY_POOR: c.gpsConfidenceVeryPoor }[q];
}

function verticalWeight(vacc: number, c: FusionConfig): number {
  if (vacc <= c.goodVerticalAccuracy) return c.verticalWeightGood;
  if (vacc <= c.fairVerticalAccuracy) return c.verticalWeightFair;
  if (vacc <= c.poorVerticalAccuracy) return c.verticalWeightPoor;
  return c.verticalWeightVeryPoor;
}

function verticalConfidenceFor(vacc: number, c: FusionConfig): number {
  if (vacc <= c.goodVerticalAccuracy) return c.gpsConfidenceGood;
  if (vacc <= c.fairVerticalAccuracy) return c.gpsConfidenceFair;
  if (vacc <= c.poorVerticalAccuracy) return c.gpsConfidencePoor;
  return c.gpsConfidenceVeryPoor;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ---------------- core ----------------

/**
 * Applies one observation to `state` (mutated in place) and returns any outputs/events it produced.
 * Observations must be fed in compareObservations order; older ones are skipped (counted in the state).
 */
export function processObservation(state: FusionState, obs: Observation, c: FusionConfig): StepResult {
  const result: StepResult = { outputs: [], events: [] };

  if (state.lastObservationT !== undefined && obs.t < state.lastObservationT) {
    state.skippedLateObservations++;
    result.events.push({ type: 'late-observation', t: obs.t, kind: obs.kind });
    return result;
  }

  // Output tick: the state as of the previous observation is emitted when sensor time crosses a tick.
  if (state.initialized && state.nextOutputAt !== undefined && obs.t >= state.nextOutputAt) {
    emitOutput(state, c, result);
    state.nextOutputAt = (Math.floor(obs.t / c.outputIntervalMs) + 1) * c.outputIntervalMs;
  }

  decayConfidence(state, obs.t, c);

  switch (obs.kind) {
    case 'motion':
      applyMotion(state, obs, c, result);
      break;
    case 'pedometer':
      applyPedometer(state, obs, c, result);
      break;
    case 'altimeter':
      applyAltimeter(state, obs, c);
      break;
    case 'gps':
      applyGps(state, obs, c, result);
      break;
  }
  state.lastObservationT = obs.t;
  return result;
}

/** Emits the current state if anything happened since the last output (end of replay / session finish). */
export function flushFusion(state: FusionState, c: FusionConfig): StepResult {
  const result: StepResult = { outputs: [], events: [] };
  const w = state.window;
  const changed = w.anchored || w.gpsCount > 0 || w.pdrDistance > 0 || w.dz !== 0 || w.yawDeltaRad !== 0;
  if (state.initialized && changed) emitOutput(state, c, result);
  return result;
}

/** Replays a full, sorted timeline from a fresh or given state (offline reprocess and tests). */
export function runFusion(state: FusionState, observations: Observation[], c: FusionConfig, flush = true): StepResult {
  const all: StepResult = { outputs: [], events: [] };
  for (const o of observations) {
    const r = processObservation(state, o, c);
    all.outputs.push(...r.outputs);
    all.events.push(...r.events);
  }
  if (flush) {
    const r = flushFusion(state, c);
    all.outputs.push(...r.outputs);
    all.events.push(...r.events);
  }
  return all;
}

// ---------------- per-sensor updates ----------------

function decayConfidence(state: FusionState, t: number, c: FusionConfig) {
  if (state.lastDecayT !== undefined && t > state.lastDecayT) {
    const dt = (t - state.lastDecayT) / 1000;
    state.horizontalConfidence *= Math.exp(-dt / c.horizontalDecayTauS);
    state.verticalConfidence *= Math.exp(-dt / c.verticalDecayTauS);
  }
  state.lastDecayT = t;
}

function applyMotion(state: FusionState, o: Extract<Observation, { kind: 'motion' }>, c: FusionConfig, r: StepResult) {
  if (o.yaw === null || !Number.isFinite(o.yaw)) return;
  if (state.lastYaw !== undefined) {
    // Yaw is used as a CHANGE only, wrap-safe: 179° -> -179° is +2°.
    const d = normalizeAngleRad(o.yaw - state.lastYaw);
    if (Math.abs(d) > c.maxYawStepRad) {
      r.events.push({ type: 'yaw-glitch', t: o.t, deltaDeg: d * RAD_TO_DEG });
    } else if (state.headingRad !== undefined) {
      const dh = c.yawToHeadingSign * d;
      state.headingRad = wrapHeadingRad(state.headingRad + dh);
      state.window.yawDeltaRad += dh;
    }
  }
  state.lastYaw = o.yaw;
  state.lastMotionTimestamp = o.t;
}

function applyPedometer(state: FusionState, o: Extract<Observation, { kind: 'pedometer' }>, c: FusionConfig, r: StepResult) {
  if (o.distance === null || !Number.isFinite(o.distance)) return;
  if (state.lastPedometerDistance === undefined || state.lastPedometerTimestamp === undefined) {
    // First sample is the baseline; no movement is inferred from it.
    state.lastPedometerDistance = o.distance;
    state.lastPedometerTimestamp = o.t;
    state.lastStepCount = o.steps ?? undefined;
    return;
  }
  let delta = o.distance - state.lastPedometerDistance;
  const dt = (o.t - state.lastPedometerTimestamp) / 1000;
  state.lastPedometerDistance = o.distance;
  state.lastPedometerTimestamp = o.t;
  state.lastStepCount = o.steps ?? state.lastStepCount;

  if (delta < 0) {
    r.events.push({ type: 'pedometer-ignored', t: o.t, delta });
    return;
  }
  if (delta === 0) return;
  const maxDelta = c.maxWalkingSpeed * Math.max(dt, c.minPedometerIntervalS);
  const clamped = delta > maxDelta;
  if (clamped) delta = maxDelta;

  let moved = false;
  if (state.initialized && state.headingRad !== undefined) {
    // heading 0 = North (+Y), 90° = East (+X)
    state.x += delta * Math.sin(state.headingRad);
    state.y += delta * Math.cos(state.headingRad);
    state.window.pdrDistance += delta;
    state.horizontalConfidence *= Math.exp(-delta / c.horizontalDecayDistanceM);
    moved = true;
  } else if (state.initialized) {
    state.window.unheadedDistance += delta; // walked, but direction unknown yet: position not moved
  }
  r.events.push({ type: 'pedometer', t: o.t, delta, clamped, moved });
}

function applyAltimeter(state: FusionState, o: Extract<Observation, { kind: 'altimeter' }>, c: FusionConfig) {
  if (o.relativeAltitude === null || !Number.isFinite(o.relativeAltitude)) return;
  if (state.lastRelativeAltitude !== undefined && state.lastAltimeterTimestamp !== undefined) {
    let dz = o.relativeAltitude - state.lastRelativeAltitude;
    const dt = (o.t - state.lastAltimeterTimestamp) / 1000;
    const maxDz = c.maxVerticalSpeed * Math.max(dt, 1);
    dz = Math.max(-maxDz, Math.min(maxDz, dz));
    if (state.initialized) {
      state.z += dz;
      state.window.dz += dz;
    }
  }
  state.lastRelativeAltitude = o.relativeAltitude;
  state.lastAltimeterTimestamp = o.t;
}

function applyGps(state: FusionState, o: Extract<Observation, { kind: 'gps' }>, c: FusionConfig, r: StepResult) {
  const hacc = o.horizontalAccuracy;
  // Invalid fixes are excluded from fusion only (raw rows stay untouched in the DB).
  if (hacc === null || !(hacc > 0) || !Number.isFinite(o.latitude) || !Number.isFinite(o.longitude)) {
    r.events.push({ type: 'gps-rejected', t: o.t, reason: `horizontalAccuracy=${hacc}` });
    return;
  }
  const quality = classifyGps(hacc, c);
  const vacc = o.verticalAccuracy !== null && o.verticalAccuracy > 0 ? o.verticalAccuracy : null;
  state.lastGpsTimestamp = o.t;
  state.lastGpsHorizontalAccuracy = hacc;
  state.lastGpsVerticalAccuracy = vacc ?? undefined;

  if (!state.initialized) {
    // First usable fix becomes the local origin, even indoors; a poor fix just starts with low confidence.
    state.origin = { latitude: o.latitude, longitude: o.longitude, height: o.ellipsoidalAltitude ?? o.altitude ?? 0 };
    state.verticalDatum = o.ellipsoidalAltitude ?? undefined;
    state.initialized = true;
    state.x = 0;
    state.y = 0;
    state.z = 0;
    state.horizontalConfidence = gpsConfidence(quality, c);
    state.verticalConfidence = o.ellipsoidalAltitude !== null && vacc !== null ? verticalConfidenceFor(vacc, c) : 0;
    state.nextOutputAt = (Math.floor(o.t / c.outputIntervalMs) + 1) * c.outputIntervalMs;
    state.window.anchored = true;
    state.window.gpsCount++;
    state.lastTrustedFix = hacc <= c.displacementHeadingAccuracy ? { x: 0, y: 0, t: o.t } : undefined;
    r.events.push({ type: 'initialized', t: o.t, horizontalAccuracy: hacc, confidence: state.horizontalConfidence });
    applyCourseAnchor(state, o, hacc, c, r);
    return;
  }

  // ---- horizontal correction: fused = predicted * (1 - alpha) + gps * alpha (local meters) ----
  const p = wgs84ToLocal(state.origin!, o.latitude, o.longitude, state.origin!.height);
  const alpha = gpsWeight(quality, c);
  const shift = Math.hypot(p.x - state.x, p.y - state.y) * alpha;
  state.x += (p.x - state.x) * alpha;
  state.y += (p.y - state.y) * alpha;
  state.horizontalConfidence = clamp01(state.horizontalConfidence + (gpsConfidence(quality, c) - state.horizontalConfidence) * alpha);
  state.window.gpsCount++;
  state.window.maxGpsWeight = Math.max(state.window.maxGpsWeight, alpha);
  r.events.push({ type: 'gps-correction', t: o.t, quality, horizontalAccuracy: hacc, weight: alpha, shift });

  // ---- vertical: GPS ellipsoidal height anchors Z; barometer carries it in between ----
  if (o.ellipsoidalAltitude !== null) {
    if (state.verticalDatum === undefined) {
      state.verticalDatum = o.ellipsoidalAltitude - state.z;
      state.verticalConfidence = vacc !== null ? verticalConfidenceFor(vacc, c) : c.gpsConfidenceVeryPoor;
    } else if (vacc !== null) {
      const beta = verticalWeight(vacc, c);
      const gz = o.ellipsoidalAltitude - state.verticalDatum;
      state.z += (gz - state.z) * beta;
      state.verticalConfidence = clamp01(state.verticalConfidence + (verticalConfidenceFor(vacc, c) - state.verticalConfidence) * beta);
    }
  }

  // ---- heading anchors ----
  if (!applyCourseAnchor(state, o, hacc, c, r) && c.displacementHeadingEnabled && hacc <= c.displacementHeadingAccuracy) {
    const last = state.lastTrustedFix;
    if (!last || (o.t - last.t) / 1000 > c.displacementHeadingMaxInterval) {
      state.lastTrustedFix = { x: p.x, y: p.y, t: o.t };
    } else if (Math.hypot(p.x - last.x, p.y - last.y) >= c.displacementHeadingMinDistance) {
      // atan2(east, north) = heading from North, clockwise
      state.headingRad = wrapHeadingRad(Math.atan2(p.x - last.x, p.y - last.y));
      state.lastTrustedFix = { x: p.x, y: p.y, t: o.t };
      r.events.push({ type: 'heading-anchor', t: o.t, source: 'displacement', headingDeg: headingRadToDeg(state.headingRad) });
    }
  }
}

/** CLLocation.course is degrees clockwise from true North (same convention). Returns true if applied. */
function applyCourseAnchor(state: FusionState, o: Extract<Observation, { kind: 'gps' }>, hacc: number, c: FusionConfig, r: StepResult): boolean {
  if (o.course === null || o.course < 0 || o.speed === null || o.speed < c.trustedCourseMinSpeed || hacc > c.trustedCourseAccuracy) {
    return false;
  }
  const course = wrapHeadingRad(o.course * DEG_TO_RAD);
  state.headingRad = state.headingRad === undefined ? course : blendHeadingRad(state.headingRad, course, c.courseAnchorWeight);
  r.events.push({ type: 'heading-anchor', t: o.t, source: 'course', headingDeg: headingRadToDeg(state.headingRad) });
  return true;
}

function emitOutput(state: FusionState, c: FusionConfig, r: StepResult) {
  const origin = state.origin!;
  const geo = localToWgs84(origin, { x: state.x, y: state.y, z: state.z });
  const ellipsoidalAltitude = state.verticalDatum !== undefined ? state.verticalDatum + state.z : null;
  const w = state.window;
  const source: PositionSource = w.anchored
    ? 'GPS_ANCHORED'
    : w.gpsCount > 0
      ? w.pdrDistance > 0
        ? 'FUSED'
        : 'GPS_CORRECTED'
      : 'PDR_PREDICTED';
  const h = clamp01(state.horizontalConfidence);
  const v = clamp01(state.verticalConfidence);
  state.fusionSequence++;
  const output: FusedOutput = {
    fusionSequence: state.fusionSequence,
    timestamp: state.lastObservationT ?? 0,
    latitude: geo.latitude,
    longitude: geo.longitude,
    ellipsoidalAltitude,
    geomZ: ellipsoidalAltitude ?? geo.height,
    x: state.x,
    y: state.y,
    z: state.z,
    headingDegrees: state.headingRad !== undefined ? headingRadToDeg(state.headingRad) : null,
    horizontalConfidence: h,
    verticalConfidence: v,
    overallConfidence: clamp01(h * c.overallHorizontalWeight + v * (1 - c.overallHorizontalWeight)),
    gpsHorizontalAccuracy: state.lastGpsHorizontalAccuracy ?? null,
    gpsVerticalAccuracy: state.lastGpsVerticalAccuracy ?? null,
    source,
  };
  r.outputs.push(output);
  r.events.push({ type: 'output', output, yawDeltaDeg: w.yawDeltaRad * RAD_TO_DEG, pdrDistance: w.pdrDistance, dz: w.dz, gpsCount: w.gpsCount });
  state.window = emptyWindow();
}
