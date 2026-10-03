/**
 * Fusion v2 — conservative heuristic fusion (pure logic: no Express / WebSocket / DB, no clock, no randomness).
 *
 * Pipeline per observation (timestamp-ordered timeline, see fusion.timeline.ts):
 *   input validation -> stationary detection -> PDR prediction -> GPS quality gate -> physical-jump gate
 *   -> innovation gate -> GPS correction -> vertical correction -> confidence (uncertainty) update -> 1 Hz output
 *
 * Differences from v1 (which let every fix pull the position by a fixed weight):
 *   - POOR fixes (> 15 m) never move XY (alpha 0). Raw rows are untouched; only the fusion ignores them.
 *   - Stationary user (no pedometer progress + low userAcceleration RMS) => XY locked against GPS drift,
 *     except a slow pull toward a tight cluster of excellent fixes ("stable anchor").
 *   - Physical jump gate (vs last accepted fix, max human speed) and innovation gate
 *     (vs predicted position, scaled by GPS accuracy AND the state's own uncertainty).
 *   - If good fixes keep being rejected consistently, the state has diverged: re-anchor to GPS.
 *   - Confidence comes from a heuristic uncertainty in meters that grows with PDR distance / moving time
 *     and shrinks with accepted fixes. It is a 0..1 quality score, not a probability.
 *
 * Unchanged principles: yaw is used only as a heading CHANGE (phone orientation != walking direction),
 * heading is anchored by GPS course (or displacement of trusted fixes), pedometer distance is a cumulative
 * value used as deltas, barometer relativeAltitude as deltas. Internal angles are radians.
 * Not map matching: no building/corridor constraints are applied here.
 */
import { localToWgs84 } from '../../geo/local-to-wgs84.js';
import { wgs84ToLocal } from '../../geo/wgs84-to-local.js';
import { blendHeadingRad, DEG_TO_RAD, headingRadToDeg, normalizeAngleRad, RAD_TO_DEG, wrapHeadingRad } from '../../geo/angles.js';
import type { FusionConfigV2 } from './fusion.config.js';
import type { Observation } from './fusion.timeline.js';
import type { FusedOutput, GpsRejectReason, PositionSource } from './fusion.types.js';
import { emptyWindowV2, type FusionStateV2 } from './fusion-state-v2.js';

export type GpsQualityV2 = 'EXCELLENT' | 'GOOD' | 'MARGINAL' | 'POOR';

export type FusionEventV2 =
  | { type: 'initialized'; t: number; horizontalAccuracy: number; provisional: boolean }
  | {
      type: 'gps-decision';
      t: number;
      seq: number;
      used: boolean;
      reason: GpsRejectReason | null;
      quality: GpsQualityV2 | 'INVALID';
      horizontalAccuracy: number | null;
      innovation: number | null;
      allowed: number | null;
      alpha: number;
      mode: 'normal' | 'stable-anchor' | 'reanchor' | 'init';
    }
  | { type: 'stationary'; t: number; stationary: boolean; accelRms: number | null }
  | { type: 'heading-anchor'; t: number; source: 'GPS_COURSE' | 'GPS_DISPLACEMENT'; headingDeg: number }
  | { type: 'pedometer'; t: number; delta: number; clamped: boolean; moved: boolean }
  | { type: 'pedometer-ignored'; t: number; delta: number; reason: 'NEGATIVE' | 'NOT_FINITE' | 'OVERSPEED' }
  | { type: 'yaw-glitch'; t: number; deltaDeg: number }
  | { type: 'late-observation'; t: number; kind: Observation['kind'] }
  | { type: 'output'; output: FusedOutput; yawDeltaDeg: number; pdrDistance: number; dz: number; gpsCount: number };

export interface StepResultV2 {
  outputs: FusedOutput[];
  events: FusionEventV2[];
}

export function classifyGpsV2(hacc: number, c: FusionConfigV2): GpsQualityV2 {
  if (hacc <= c.excellentGpsAccuracy) return 'EXCELLENT';
  if (hacc <= c.goodGpsAccuracy) return 'GOOD';
  if (hacc <= c.marginalGpsAccuracy) return 'MARGINAL';
  return 'POOR';
}

export function gpsAlphaV2(q: GpsQualityV2, c: FusionConfigV2): number {
  return { EXCELLENT: c.gpsAlphaExcellent, GOOD: c.gpsAlphaGood, MARGINAL: c.gpsAlphaMarginal, POOR: c.gpsAlphaPoor }[q];
}

function verticalAlpha(vacc: number, c: FusionConfigV2): number {
  if (vacc <= c.goodVerticalAccuracy) return c.verticalAlphaGood;
  if (vacc <= c.fairVerticalAccuracy) return c.verticalAlphaFair;
  if (vacc <= c.poorVerticalAccuracy) return c.verticalAlphaPoor;
  return c.verticalAlphaVeryPoor;
}

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Variance-style blend of two independent estimates weighted (1 - a) / a. */
const blendUncertainty = (u: number, measurement: number, a: number) => Math.hypot((1 - a) * u, a * measurement);

// ---------------- core ----------------

/** Applies one observation (mutates state). Observations must arrive in compareObservations order. */
export function processObservationV2(state: FusionStateV2, obs: Observation, c: FusionConfigV2): StepResultV2 {
  const r: StepResultV2 = { outputs: [], events: [] };
  if (state.lastObservationT !== undefined && obs.t < state.lastObservationT) {
    state.skippedLateObservations++;
    r.events.push({ type: 'late-observation', t: obs.t, kind: obs.kind });
    return r;
  }

  // Output tick (sensor time, batch-independent): emit the state as of the previous observation.
  if (state.initialized && state.nextOutputAt !== undefined && obs.t >= state.nextOutputAt) {
    emitOutput(state, c, r);
    state.nextOutputAt = (Math.floor(obs.t / c.outputIntervalMs) + 1) * c.outputIntervalMs;
  }

  // Provisional initialization is time-based (any sensor), so a session with a single poor fix still starts.
  if (!state.initialized && state.initCandidate && state.firstValidFixT !== undefined && obs.t - state.firstValidFixT >= c.initGraceMs) {
    initializeFrom(state, state.initCandidate, true, obs.t, c);
    r.events.push({ type: 'initialized', t: obs.t, horizontalAccuracy: state.initCandidate.hacc, provisional: true });
  }

  advanceTime(state, obs.t, c);
  if (obs.kind === 'motion') applyMotion(state, obs, c, r);
  else if (obs.kind === 'pedometer') applyPedometer(state, obs, c, r);
  else if (obs.kind === 'altimeter') applyAltimeter(state, obs, c);
  updateStationary(state, obs.t, c, r);
  if (obs.kind === 'gps') applyGps(state, obs, c, r);

  state.lastObservationT = obs.t;
  return r;
}

/** Emits the current state if anything happened since the last output (end of replay / session finish). */
export function flushFusionV2(state: FusionStateV2, c: FusionConfigV2): StepResultV2 {
  const r: StepResultV2 = { outputs: [], events: [] };
  const w = state.window;
  if (state.initialized && (w.anchored || w.reanchored || w.gpsCount > 0 || w.pdrDistance > 0 || w.dz !== 0 || w.yawDeltaRad !== 0)) {
    emitOutput(state, c, r);
  }
  return r;
}

// ---------------- time / stationary ----------------

function advanceTime(state: FusionStateV2, t: number, c: FusionConfigV2) {
  if (state.lastObservationT === undefined || t <= state.lastObservationT) return;
  const dt = (t - state.lastObservationT) / 1000;
  if (state.stationary) state.stationaryMs += dt * 1000;
  if (!state.initialized) return;
  // Uncertainty only grows from the moment the position exists.
  const since = Math.max(state.lastObservationT, state.initializedAt ?? state.lastObservationT);
  const grow = Math.max(0, (t - since) / 1000);
  if (!state.stationary) state.horizontalUncertainty += c.movingUncertaintyPerSecond * grow;
  if (Number.isFinite(state.verticalUncertainty)) state.verticalUncertainty += c.verticalUncertaintyPerSecond * grow;
}

/**
 * Stationary = no pedometer progress in the window AND userAcceleration RMS (g) below the threshold over
 * enough motion samples. Without motion data the state is unknown and treated as moving (no lock).
 */
function updateStationary(state: FusionStateV2, t: number, c: FusionConfigV2, r: StepResultV2) {
  const from = t - c.stationaryWindowMs;
  let drop = 0;
  while (drop < state.accelWindow.length && state.accelWindow[drop].t < from) drop++;
  if (drop) state.accelWindow.splice(0, drop);
  const n = state.accelWindow.length;
  let rms: number | null = null;
  if (n >= c.minMotionSamplesForStationary) {
    let sum = 0;
    for (const s of state.accelWindow) sum += s.a2;
    rms = Math.sqrt(sum / n);
  }
  const pedometerQuiet = state.lastMovementEvidenceT === undefined || t - state.lastMovementEvidenceT >= c.stationaryWindowMs;
  const stationary = pedometerQuiet && rms !== null && rms <= c.maxStationaryAccelerationRms;
  if (stationary !== state.stationary) {
    state.stationary = stationary;
    if (!stationary) state.stableFixes = [];
    r.events.push({ type: 'stationary', t, stationary, accelRms: rms });
  }
}

// ---------------- sensors ----------------

function applyMotion(state: FusionStateV2, o: Extract<Observation, { kind: 'motion' }>, c: FusionConfigV2, r: StepResultV2) {
  if (finite(o.ax) && finite(o.ay) && finite(o.az)) {
    state.accelWindow.push({ t: o.t, a2: o.ax * o.ax + o.ay * o.ay + o.az * o.az });
  }
  if (!finite(o.yaw)) return;
  if (state.lastYaw !== undefined) {
    // Yaw only as a CHANGE, wrap-safe ([-π, π]): 179° -> -179° is +2°, never 358°.
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
}

function applyPedometer(state: FusionStateV2, o: Extract<Observation, { kind: 'pedometer' }>, c: FusionConfigV2, r: StepResultV2) {
  if (o.distance === null) return;
  if (!Number.isFinite(o.distance)) {
    r.events.push({ type: 'pedometer-ignored', t: o.t, delta: NaN, reason: 'NOT_FINITE' });
    return;
  }
  if (state.lastPedometerDistance === undefined || state.lastPedometerT === undefined) {
    // CMPedometer distance is cumulative: the first sample is only the baseline.
    state.lastPedometerDistance = o.distance;
    state.lastPedometerT = o.t;
    state.lastStepCount = o.steps ?? undefined;
    return;
  }
  let delta = o.distance - state.lastPedometerDistance;
  const dt = (o.t - state.lastPedometerT) / 1000;
  const stepsIncreased = o.steps !== null && state.lastStepCount !== undefined && o.steps > state.lastStepCount;
  state.lastPedometerDistance = o.distance;
  state.lastPedometerT = o.t;
  if (o.steps !== null) state.lastStepCount = o.steps;

  if (delta < 0) {
    r.events.push({ type: 'pedometer-ignored', t: o.t, delta, reason: 'NEGATIVE' });
    return;
  }
  if (delta > c.maxStationaryDistanceDelta || stepsIncreased) state.lastMovementEvidenceT = o.t;
  if (delta === 0) return;

  const maxDelta = c.maxPedestrianSpeed * Math.max(dt, c.minPedometerIntervalS);
  const overspeed = delta > maxDelta;
  if (overspeed && c.pedometerOverspeedPolicy === 'reject') {
    r.events.push({ type: 'pedometer-ignored', t: o.t, delta, reason: 'OVERSPEED' });
    return;
  }
  if (overspeed) delta = maxDelta;

  let moved = false;
  if (state.initialized) {
    state.distanceSinceTrustedGps += delta;
    if (state.headingRad !== undefined) {
      // heading 0 = North (+Y), 90° = East (+X)
      state.x += delta * Math.sin(state.headingRad);
      state.y += delta * Math.cos(state.headingRad);
      state.window.pdrDistance += delta;
      state.horizontalUncertainty += c.pdrUncertaintyPerMeter * delta;
      moved = true;
    } else {
      // Walked, but no trusted heading yet: do not invent a direction; the position just gets less certain.
      state.horizontalUncertainty += c.unheadedUncertaintyPerMeter * delta;
    }
  }
  r.events.push({ type: 'pedometer', t: o.t, delta, clamped: overspeed, moved });
}

function applyAltimeter(state: FusionStateV2, o: Extract<Observation, { kind: 'altimeter' }>, c: FusionConfigV2) {
  if (!finite(o.relativeAltitude)) return;
  if (state.lastRelativeAltitude !== undefined && state.lastAltimeterT !== undefined) {
    // relativeAltitude is cumulative since the start: only its change moves Z.
    const dt = (o.t - state.lastAltimeterT) / 1000;
    const maxDz = c.maxVerticalSpeed * Math.max(dt, 1);
    const dz = Math.max(-maxDz, Math.min(maxDz, o.relativeAltitude - state.lastRelativeAltitude));
    if (state.initialized) {
      state.z += dz;
      state.window.dz += dz;
    }
  }
  state.lastRelativeAltitude = o.relativeAltitude;
  state.lastAltimeterT = o.t;
}

// ---------------- GPS ----------------

type GpsObs = Extract<Observation, { kind: 'gps' }>;

function recordDecision(state: FusionStateV2, o: GpsObs, used: boolean, reason: GpsRejectReason | null, innovation: number | null) {
  const vacc = finite(o.verticalAccuracy) && o.verticalAccuracy > 0 ? o.verticalAccuracy : null;
  state.window.gpsCount++;
  state.window.anyGpsUsed ||= used;
  state.window.lastDecision = { seq: o.seq, used, reason, hacc: o.horizontalAccuracy, vacc, innovation };
}

function initializeFrom(state: FusionStateV2, fix: NonNullable<FusionStateV2['initCandidate']>, provisional: boolean, now: number, c: FusionConfigV2) {
  state.origin = { latitude: fix.latitude, longitude: fix.longitude, height: fix.height };
  state.verticalDatum = fix.ellipsoidalAltitude ?? undefined;
  state.initialized = true;
  state.provisionalInit = provisional;
  state.initializedAt = now;
  state.x = 0;
  state.y = 0;
  state.z = 0;
  state.horizontalUncertainty = fix.hacc;
  state.verticalUncertainty = fix.ellipsoidalAltitude !== null && fix.vacc !== null ? fix.vacc : c.unknownVerticalUncertainty;
  state.lastAcceptedGps = { x: 0, y: 0, t: fix.t, hacc: fix.hacc };
  if (fix.hacc <= c.goodGpsAccuracy) {
    state.lastTrustedGpsT = fix.t;
    state.lastTrustedGpsX = 0;
    state.lastTrustedGpsY = 0;
  }
  state.distanceSinceTrustedGps = 0;
  state.lastDisplacementFix = fix.hacc <= c.displacementHeadingAccuracy ? { x: 0, y: 0, t: fix.t } : undefined;
  state.nextOutputAt = (Math.floor(now / c.outputIntervalMs) + 1) * c.outputIntervalMs;
  state.window.anchored = true;
}

function applyGps(state: FusionStateV2, o: GpsObs, c: FusionConfigV2, r: StepResultV2) {
  const hacc = o.horizontalAccuracy;
  if (!finite(hacc) || !(hacc > 0) || !Number.isFinite(o.latitude) || !Number.isFinite(o.longitude)) {
    if (state.initialized) recordDecision(state, o, false, 'INVALID_ACCURACY', null);
    r.events.push({ type: 'gps-decision', t: o.t, seq: o.seq, used: false, reason: 'INVALID_ACCURACY', quality: 'INVALID', horizontalAccuracy: hacc, innovation: null, allowed: null, alpha: 0, mode: 'normal' });
    return;
  }
  const vacc = finite(o.verticalAccuracy) && o.verticalAccuracy > 0 ? o.verticalAccuracy : null;
  const quality = classifyGpsV2(hacc, c);
  state.lastGpsHorizontalAccuracy = hacc;
  state.lastGpsVerticalAccuracy = vacc ?? undefined;

  // ---- initialization: a good-enough fix immediately, else the best fix after a grace period (provisional) ----
  if (!state.initialized) {
    const fix = {
      latitude: o.latitude,
      longitude: o.longitude,
      height: o.ellipsoidalAltitude ?? o.altitude ?? 0,
      ellipsoidalAltitude: o.ellipsoidalAltitude,
      hacc,
      vacc,
      t: o.t,
    };
    state.firstValidFixT ??= o.t;
    if (!state.initCandidate || hacc < state.initCandidate.hacc) state.initCandidate = fix;
    if (hacc <= c.initMaxAccuracy) {
      initializeFrom(state, fix, false, o.t, c);
      recordDecision(state, o, true, null, 0);
      r.events.push({ type: 'initialized', t: o.t, horizontalAccuracy: hacc, provisional: false });
      r.events.push({ type: 'gps-decision', t: o.t, seq: o.seq, used: true, reason: null, quality, horizontalAccuracy: hacc, innovation: 0, allowed: null, alpha: 1, mode: 'init' });
      applyHeadingAnchors(state, o, hacc, { x: 0, y: 0 }, true, c, r);
      return;
    }
    if (o.t - state.firstValidFixT < c.initGraceMs) return; // keep waiting for a better first fix
    initializeFrom(state, state.initCandidate, true, o.t, c);
    r.events.push({ type: 'initialized', t: o.t, horizontalAccuracy: state.initCandidate.hacc, provisional: true });
    // fall through: the current fix is then judged like any other
  }

  const origin = state.origin!;
  const p = wgs84ToLocal(origin, o.latitude, o.longitude, origin.height);
  const innovation = Math.hypot(p.x - state.x, p.y - state.y);
  let alpha = gpsAlphaV2(quality, c);
  let reason: GpsRejectReason | null = null;
  let mode: 'normal' | 'stable-anchor' | 'reanchor' = 'normal';
  let allowed: number | null = null;
  let target = { x: p.x, y: p.y };

  // 1. quality gate
  if (alpha <= 0) reason = 'POOR_ACCURACY';
  // 2. stationary lock (except a tight cluster of excellent fixes)
  else if (state.stationary) {
    reason = 'STATIONARY_LOCK';
    if (c.stableAnchorEnabled && hacc <= c.stableAnchorAccuracy) {
      state.stableFixes.push({ x: p.x, y: p.y, t: o.t });
      state.stableFixes = state.stableFixes.filter((f) => o.t - f.t <= c.stableAnchorWindowMs);
      if (state.stableFixes.length >= c.stableAnchorMinFixes) {
        const cx = state.stableFixes.reduce((a, f) => a + f.x, 0) / state.stableFixes.length;
        const cy = state.stableFixes.reduce((a, f) => a + f.y, 0) / state.stableFixes.length;
        if (state.stableFixes.every((f) => Math.hypot(f.x - cx, f.y - cy) <= c.stableAnchorRadius)) {
          reason = null;
          mode = 'stable-anchor';
          alpha = c.stableAnchorAlpha;
          target = { x: cx, y: cy };
        }
      }
    }
  }
  // 3. physical jump vs the last accepted fix
  if (reason === null && state.lastAcceptedGps) {
    const last = state.lastAcceptedGps;
    const dt = Math.max(0, (o.t - last.t) / 1000);
    const maxDisplacement = c.jumpBaseTolerance + c.maximumHumanSpeed * dt + hacc + last.hacc;
    if (Math.hypot(p.x - last.x, p.y - last.y) > maxDisplacement) reason = 'PHYSICAL_JUMP';
  }
  // 4. innovation vs the predicted position (GPS accuracy and the state's own uncertainty)
  if (reason === null && mode === 'normal') {
    const u = Number.isFinite(state.horizontalUncertainty) ? state.horizontalUncertainty : 0;
    allowed = Math.max(c.minimumInnovationGate, c.innovationAccuracyMultiplier * Math.hypot(hacc, u));
    if (innovation > allowed) reason = 'INNOVATION_TOO_LARGE';
  }
  // 5. recovery: good fixes rejected again and again => our state is what is wrong
  if ((reason === 'PHYSICAL_JUMP' || reason === 'INNOVATION_TOO_LARGE') && hacc <= c.reanchorMaxAccuracy) {
    state.consecutiveGateRejects++;
    state.firstGateRejectT ??= o.t;
    if (state.consecutiveGateRejects >= c.reanchorAfterRejects && o.t - state.firstGateRejectT >= c.reanchorMinSpanMs) {
      reason = null;
      mode = 'reanchor';
    }
  }

  if (reason === null) {
    if (mode === 'reanchor') {
      state.x = p.x;
      state.y = p.y;
      state.horizontalUncertainty = hacc;
      state.window.reanchored = true;
      alpha = 1;
    } else {
      state.x += (target.x - state.x) * alpha;
      state.y += (target.y - state.y) * alpha;
      state.horizontalUncertainty = blendUncertainty(state.horizontalUncertainty, hacc, alpha);
    }
    state.consecutiveGateRejects = 0;
    state.firstGateRejectT = undefined;
    state.lastAcceptedGps = { x: p.x, y: p.y, t: o.t, hacc };
    if (quality === 'EXCELLENT' || quality === 'GOOD') {
      state.lastTrustedGpsT = o.t;
      state.lastTrustedGpsX = p.x;
      state.lastTrustedGpsY = p.y;
      state.distanceSinceTrustedGps = 0;
    }
  }

  // ---- vertical: GPS ellipsoidal height anchors Z when verticalAccuracy allows; barometer carries it otherwise ----
  if (reason !== 'PHYSICAL_JUMP' && o.ellipsoidalAltitude !== null && vacc !== null) {
    if (state.verticalDatum === undefined) {
      state.verticalDatum = o.ellipsoidalAltitude - state.z;
      state.verticalUncertainty = vacc;
    } else {
      const beta = verticalAlpha(vacc, c);
      if (beta > 0) {
        state.z += (o.ellipsoidalAltitude - state.verticalDatum - state.z) * beta;
        state.verticalUncertainty = blendUncertainty(state.verticalUncertainty, vacc, beta);
      }
    }
  }

  if (reason !== 'PHYSICAL_JUMP') applyHeadingAnchors(state, o, hacc, p, reason === null, c, r);

  recordDecision(state, o, reason === null, reason, innovation);
  r.events.push({
    type: 'gps-decision', t: o.t, seq: o.seq, used: reason === null, reason, quality,
    horizontalAccuracy: hacc, innovation, allowed, alpha: reason === null ? alpha : 0, mode,
  });
}

/** Absolute heading only from GPS: course while moving with good accuracy, else displacement of trusted fixes. */
function applyHeadingAnchors(state: FusionStateV2, o: GpsObs, hacc: number, p: { x: number; y: number }, accepted: boolean, c: FusionConfigV2, r: StepResultV2) {
  if (state.stationary) return;
  if (finite(o.course) && o.course >= 0 && finite(o.speed) && o.speed >= c.trustedCourseMinSpeed && hacc <= c.trustedCourseAccuracy) {
    const course = wrapHeadingRad(o.course * DEG_TO_RAD); // degrees -> radians (internal unit)
    state.headingRad = state.headingRad === undefined ? course : blendHeadingRad(state.headingRad, course, c.headingAlpha);
    state.headingSource = 'GPS_COURSE';
    state.lastDisplacementFix = { x: p.x, y: p.y, t: o.t };
    r.events.push({ type: 'heading-anchor', t: o.t, source: 'GPS_COURSE', headingDeg: headingRadToDeg(state.headingRad) });
    return;
  }
  if (!c.displacementHeadingEnabled || !accepted || hacc > c.displacementHeadingAccuracy) return;
  const last = state.lastDisplacementFix;
  if (!last || (o.t - last.t) / 1000 > c.displacementHeadingMaxInterval) {
    state.lastDisplacementFix = { x: p.x, y: p.y, t: o.t };
  } else if (Math.hypot(p.x - last.x, p.y - last.y) >= c.displacementHeadingMinDistance) {
    state.headingRad = wrapHeadingRad(Math.atan2(p.x - last.x, p.y - last.y)); // atan2(east, north)
    state.headingSource = 'GPS_DISPLACEMENT';
    state.lastDisplacementFix = { x: p.x, y: p.y, t: o.t };
    r.events.push({ type: 'heading-anchor', t: o.t, source: 'GPS_DISPLACEMENT', headingDeg: headingRadToDeg(state.headingRad) });
  }
}

// ---------------- output ----------------

function emitOutput(state: FusionStateV2, c: FusionConfigV2, r: StepResultV2) {
  const geo = localToWgs84(state.origin!, { x: state.x, y: state.y, z: state.z });
  const ellipsoidalAltitude = state.verticalDatum !== undefined ? state.verticalDatum + state.z : null;
  const w = state.window;
  const source: PositionSource = w.anchored
    ? 'GPS_ANCHORED'
    : w.reanchored
      ? 'GPS_REANCHOR'
      : w.anyGpsUsed
        ? w.pdrDistance > 0
          ? 'FUSED'
          : 'GPS_CORRECTED'
        : w.pdrDistance > 0
          ? 'PDR_PREDICTED'
          : state.stationary
            ? 'STATIONARY_HOLD'
            : 'HELD';
  const h = Number.isFinite(state.horizontalUncertainty) ? clamp01(Math.exp(-state.horizontalUncertainty / c.confidenceScaleM)) : 0;
  const v = Number.isFinite(state.verticalUncertainty) ? clamp01(Math.exp(-state.verticalUncertainty / c.verticalConfidenceScaleM)) : 0;
  const d = w.lastDecision;
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
    gpsHorizontalAccuracy: d?.hacc ?? state.lastGpsHorizontalAccuracy ?? null,
    gpsVerticalAccuracy: d?.vacc ?? state.lastGpsVerticalAccuracy ?? null,
    source,
    gpsUsed: w.gpsCount > 0 ? w.anyGpsUsed : null,
    gpsRejectReason: w.gpsCount > 0 && !w.anyGpsUsed ? (d?.reason ?? null) : null,
    gpsSequence: d?.seq ?? null,
    innovationDistance: d?.innovation ?? null,
    stationary: state.stationary,
    headingSource: state.headingSource,
    horizontalUncertainty: Number.isFinite(state.horizontalUncertainty) ? state.horizontalUncertainty : null,
  };
  r.outputs.push(output);
  r.events.push({ type: 'output', output, yawDeltaDeg: w.yawDeltaRad * RAD_TO_DEG, pdrDistance: w.pdrDistance, dz: w.dz, gpsCount: w.gpsCount });
  state.window = emptyWindowV2();
}

// ---------------- summaries for runs / debug ----------------

export function summarizeV2(state: FusionStateV2, events: FusionEventV2[]) {
  const reasons: Record<string, number> = {};
  let accepted = 0;
  let rejected = 0;
  let maxRejectedInnovation: number | null = null;
  for (const e of events) {
    if (e.type !== 'gps-decision') continue;
    if (e.used) accepted++;
    else {
      rejected++;
      if (e.reason) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
      if ((e.reason === 'INNOVATION_TOO_LARGE' || e.reason === 'PHYSICAL_JUMP') && e.innovation !== null) {
        maxRejectedInnovation = Math.max(maxRejectedInnovation ?? 0, e.innovation);
      }
    }
  }
  return { gpsAccepted: accepted, gpsRejected: rejected, rejectReasons: reasons, maxRejectedInnovation, stationaryMs: Math.round(state.stationaryMs) };
}

/** One log line per meaningful event (motion samples are summarized in the 1 Hz output line). */
export function describeEventV2(e: FusionEventV2): { event: string; fields: Record<string, unknown> } | null {
  const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  switch (e.type) {
    case 'initialized':
      return { event: 'fusion.initialized', fields: { accuracy: r1(e.horizontalAccuracy), provisional: e.provisional } };
    case 'gps-decision':
      return e.used
        ? { event: 'fusion.gps_used', fields: { seq: e.seq, quality: e.quality, accuracy: r1(e.horizontalAccuracy), alpha: e.alpha, mode: e.mode, innovation: r1(e.innovation) } }
        : { event: 'fusion.gps_rejected', fields: { seq: e.seq, reason: e.reason, accuracy: r1(e.horizontalAccuracy), innovation: r1(e.innovation), allowed: r1(e.allowed) } };
    case 'stationary':
      return { event: e.stationary ? 'fusion.stationary_entered' : 'fusion.stationary_exited', fields: { accelRmsG: e.accelRms === null ? null : Math.round(e.accelRms * 1000) / 1000 } };
    case 'heading-anchor':
      return { event: 'fusion.heading_anchor', fields: { source: e.source, heading: r1(e.headingDeg) } };
    case 'pedometer':
      return { event: 'fusion.pedometer', fields: { delta: Math.round(e.delta * 100) / 100, clamped: e.clamped, moved: e.moved } };
    case 'pedometer-ignored':
      return { event: 'fusion.pedometer_ignored', fields: { delta: e.delta, reason: e.reason } };
    case 'yaw-glitch':
      return { event: 'fusion.yaw_glitch', fields: { delta: r1(e.deltaDeg) } };
    case 'output':
      return {
        event: 'fusion.output',
        fields: {
          seq: e.output.fusionSequence,
          x: r1(e.output.x),
          y: r1(e.output.y),
          source: e.output.source,
          stationary: e.output.stationary,
          confidence: Math.round(e.output.overallConfidence * 100) / 100,
          heading: e.output.headingDegrees === null ? null : r1(e.output.headingDegrees),
          yawDelta: r1(e.yawDeltaDeg),
          pdr: Math.round(e.pdrDistance * 100) / 100,
          uncertaintyM: r1(e.output.horizontalUncertainty ?? null),
        },
      };
    case 'late-observation':
      return null;
  }
}
