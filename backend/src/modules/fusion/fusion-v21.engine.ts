/**
 * Fusion v2.1 — fixes fusion-v2 freezing at its first fix (pure logic: no Express / WebSocket / DB, no clock).
 *
 * Root cause in v2 (verified on real sessions): indoor/vehicle GPS was rejected almost entirely (> 15 m => alpha 0)
 * and the heading was never anchored (course needed <= 8 m), so pedometer distance could not move XY either.
 * XY stayed at the first fix while the raw GPS travelled kilometres; with only Z changing (barometer), the fused
 * points looked like a vertical line. There was no cumulative-value bug (Z/pedometer already used deltas).
 *
 * Pipeline per observation (timestamp-ordered, deterministic):
 *   validation -> initialization -> stationary detection -> heading (GPS course / two-point bootstrap / yaw delta)
 *   -> pedometer prediction -> barometer Z (anchor based) -> GPS quality -> gates -> soft correction
 *   -> cluster / track re-anchor -> divergence guard -> confidence -> 1 Hz output (+ important events)
 *
 *  - GPS classes: <=5 EXCELLENT, <=10 GOOD, <=20 MARGINAL, <=35 POOR (tiny weight), >35 UNUSABLE.
 *  - Heading: trusted GPS course, else the bearing between two usable fixes (bootstrap), then yaw DELTAS only.
 *  - Re-anchor to a GPS cluster when PDR drifted away from where recent fixes agree, or to a GPS track when the
 *    fixes describe consistent movement the pedometer cannot explain (e.g. riding a bus) — soft for clusters,
 *    hard for tracks. Rate-limited.
 *  - Divergence guard: displacement from the last anchor may not exceed walked distance + accepted corrections
 *    + tolerance; otherwise the state is reset to GPS evidence. A km-scale drift is impossible by construction.
 *  - Z = heightDatum + (relativeAltitude - baseRelativeAltitude): no integration that could run away; barometer
 *    jumps faster than maxVerticalSpeed are treated as glitches; GPS ellipsoidal height adjusts the datum.
 * Not map matching: no building/corridor constraints here.
 */
import { localToWgs84 } from '../../geo/local-to-wgs84.js';
import { wgs84ToLocal } from '../../geo/wgs84-to-local.js';
import { blendHeadingRad, DEG_TO_RAD, headingRadToDeg, normalizeAngleRad, RAD_TO_DEG, wrapHeadingRad } from '../../geo/angles.js';
import type { FusionConfigV21 } from './fusion.config.js';
import { checkPedometerCounter, restartPedometerCounter } from './fusion.pedometer.js';
import type { Observation } from './fusion.timeline.js';
import type { FusedOutput, PositionSource } from './fusion.types.js';
import {
  emptyWindowV21,
  type EvidenceFix,
  type FusionStateV21,
  type GpsQualityV21,
  type GpsRejectReasonV21,
  type PdrRejectReason,
  type ReanchorReason,
} from './fusion-state-v21.js';

export type FusionEventV21 =
  | { type: 'initialized'; t: number; accuracy: number; provisional: boolean }
  | {
      type: 'gps-decision';
      t: number;
      seq: number;
      used: boolean;
      reason: GpsRejectReasonV21 | null;
      quality: GpsQualityV21 | 'INVALID';
      accuracy: number | null;
      innovation: number | null;
      allowed: number | null;
      alpha: number;
    }
  | { type: 'reanchor'; t: number; reason: ReanchorReason; shift: number }
  | { type: 'stationary'; t: number; stationary: boolean; accelRms: number | null }
  | { type: 'heading'; t: number; source: 'GPS_COURSE' | 'GPS_TWO_POINT'; headingDeg: number; bootstrap: boolean }
  | { type: 'pedometer'; t: number; delta: number; applied: boolean; reason: PdrRejectReason | null }
  | { type: 'altimeter-glitch'; t: number; jump: number }
  | { type: 'altimeter-rebase'; t: number; reason: 'SEGMENT_CHANGE' | 'GAP' }
  | { type: 'vertical-rejected'; t: number; innovation: number; allowed: number }
  | { type: 'vertical-reanchor'; t: number; shift: number }
  | { type: 'yaw-glitch'; t: number; deltaDeg: number }
  | { type: 'late-observation'; t: number; kind: Observation['kind'] }
  | { type: 'output'; output: FusedOutput; yawDeltaDeg: number; pdrDistance: number };

export interface StepResultV21 {
  outputs: FusedOutput[];
  events: FusionEventV21[];
}

export function classifyGpsV21(acc: number, c: FusionConfigV21): GpsQualityV21 {
  if (acc <= c.excellentGpsAccuracy) return 'EXCELLENT';
  if (acc <= c.goodGpsAccuracy) return 'GOOD';
  if (acc <= c.marginalGpsAccuracy) return 'MARGINAL';
  if (acc <= c.poorGpsAccuracy) return 'POOR';
  return 'UNUSABLE';
}

export function gpsAlphaV21(q: GpsQualityV21, c: FusionConfigV21): number {
  return { EXCELLENT: c.gpsAlphaExcellent, GOOD: c.gpsAlphaGood, MARGINAL: c.gpsAlphaMarginal, POOR: c.gpsAlphaPoor, UNUSABLE: c.gpsAlphaUnusable }[q];
}

function verticalAlpha(vacc: number, c: FusionConfigV21): number {
  if (vacc <= c.goodVerticalAccuracy) return c.verticalAlphaGood;
  if (vacc <= c.fairVerticalAccuracy) return c.verticalAlphaFair;
  if (vacc <= c.poorVerticalAccuracy) return c.verticalAlphaPoor;
  return c.verticalAlphaVeryPoor;
}

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const blendUncertainty = (u: number, m: number, a: number) => Math.hypot((1 - a) * u, a * m);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

// ---------------- vertical helpers ----------------

/** Barometer reading with rejected glitches removed. */
function adjustedRelativeAltitude(state: FusionStateV21): number | undefined {
  return state.lastRelativeAltitude === undefined ? undefined : state.lastRelativeAltitude - state.relativeAltitudeOffset;
}

/** Current height estimate (ellipsoidal when the datum came from ellipsoidalAltitude). */
export function currentHeightV21(state: FusionStateV21): number {
  const rel = adjustedRelativeAltitude(state);
  const base = state.baseRelativeAltitude;
  return (state.heightDatum ?? 0) + (rel !== undefined && base !== undefined ? rel - base : 0);
}

// ---------------- core ----------------

export function processObservationV21(state: FusionStateV21, obs: Observation, c: FusionConfigV21): StepResultV21 {
  const r: StepResultV21 = { outputs: [], events: [] };
  if (obs.kind === 'gps' && obs.preSession) {
    // Cached fix from before the session (raw is kept): never an initial position, never a correction.
    r.events.push({ type: 'gps-decision', t: obs.t, seq: obs.seq, used: false, reason: 'PRE_SESSION', quality: 'INVALID', accuracy: obs.horizontalAccuracy, innovation: null, allowed: null, alpha: 0 });
    return r;
  }
  if (state.lastObservationT !== undefined && obs.t < state.lastObservationT) {
    state.skippedLateObservations++;
    r.events.push({ type: 'late-observation', t: obs.t, kind: obs.kind });
    return r;
  }

  // 1 Hz tick (sensor time, batch independent): emit the state as of the previous observation.
  if (state.initialized && state.nextOutputAt !== undefined && obs.t >= state.nextOutputAt) {
    if (state.lastOutputT === undefined || (state.lastObservationT ?? obs.t) - state.lastOutputT >= c.minImmediateOutputIntervalMs) {
      emitOutput(state, c, r);
    }
    state.nextOutputAt = (Math.floor(obs.t / c.outputIntervalMs) + 1) * c.outputIntervalMs;
  }

  // Provisional initialization is time-based, so a session with only poor fixes still starts.
  if (!state.initialized && state.initCandidate && state.firstValidFixT !== undefined && obs.t - state.firstValidFixT >= c.initGraceMs) {
    initializeFrom(state, state.initCandidate, true, obs.t, c);
    r.events.push({ type: 'initialized', t: obs.t, accuracy: state.initCandidate.acc, provisional: true });
  }

  advanceTime(state, obs.t, c);
  if (obs.kind === 'motion') applyMotion(state, obs, c, r);
  else if (obs.kind === 'pedometer') applyPedometer(state, obs, c, r);
  else if (obs.kind === 'altimeter') applyAltimeter(state, obs, c, r);
  updateStationary(state, obs.t, c, r);
  if (obs.kind === 'gps') applyGps(state, obs, c, r);
  if (state.initialized) divergenceGuard(state, obs.t, c, r);

  state.lastObservationT = obs.t;

  // Important events produce an output right away (rate-limited), not only on the next tick.
  if (state.initialized) {
    if (state.lastOutputZ !== undefined && Math.abs(currentHeightV21(state) - state.lastOutputZ) >= c.significantZChange) state.window.immediate = true;
    if (state.window.immediate && (state.lastOutputT === undefined || obs.t - state.lastOutputT >= c.minImmediateOutputIntervalMs)) {
      emitOutput(state, c, r);
    }
  }
  return r;
}

export function flushFusionV21(state: FusionStateV21, c: FusionConfigV21): StepResultV21 {
  const r: StepResultV21 = { outputs: [], events: [] };
  const w = state.window;
  if (state.initialized && (w.anchored || w.immediate || w.gpsCount > 0 || w.pdrDistance > 0 || w.reanchorReason || w.yawDeltaRad !== 0 || w.pdrApplied !== null)) {
    emitOutput(state, c, r);
  }
  return r;
}

// ---------------- time / stationary ----------------

function advanceTime(state: FusionStateV21, t: number, c: FusionConfigV21) {
  if (state.lastObservationT === undefined || t <= state.lastObservationT) return;
  const dt = (t - state.lastObservationT) / 1000;
  if (state.stationary) state.stationaryMs += dt * 1000;
  if (!state.initialized) return;
  const since = Math.max(state.lastObservationT, state.initializedAt ?? state.lastObservationT);
  const grow = Math.max(0, (t - since) / 1000);
  if (!state.stationary) state.horizontalUncertainty += c.movingUncertaintyPerSecond * grow;
  if (Number.isFinite(state.verticalUncertainty)) state.verticalUncertainty += c.verticalUncertaintyPerSecond * grow;
}

function updateStationary(state: FusionStateV21, t: number, c: FusionConfigV21, r: StepResultV21) {
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
    state.window.immediate = true;
    r.events.push({ type: 'stationary', t, stationary, accelRms: rms });
  }
}

// ---------------- sensors ----------------

function applyMotion(state: FusionStateV21, o: Extract<Observation, { kind: 'motion' }>, c: FusionConfigV21, r: StepResultV21) {
  if (finite(o.ax) && finite(o.ay) && finite(o.az)) state.accelWindow.push({ t: o.t, a2: o.ax * o.ax + o.ay * o.ay + o.az * o.az });
  // A long gap (background pause) or a new motion segment (CoreMotion restarted => new arbitrary yaw reference)
  // breaks IMU continuity: start a new yaw baseline instead of applying the whole difference as a turn.
  const segmentChanged = state.lastMotionSegment !== undefined && (o.segment ?? null) !== state.lastMotionSegment;
  const gap = state.lastMotionT !== undefined && o.t - state.lastMotionT > c.motionContinuityThresholdMs;
  state.lastMotionT = o.t;
  state.lastMotionSegment = o.segment ?? null;
  if (!finite(o.yaw)) return;
  if ((gap || segmentChanged) && state.lastYaw !== undefined) {
    state.motionGaps++;
    state.lastYaw = o.yaw; // deltaYaw = 0 for this sample
    return;
  }
  if (state.lastYaw !== undefined) {
    // Yaw only as a CHANGE (radians), wrap-safe in [-π, π]. Never heading = yaw.
    const d = normalizeAngleRad(o.yaw - state.lastYaw);
    if (Math.abs(d) > c.maxYawStepRad) {
      r.events.push({ type: 'yaw-glitch', t: o.t, deltaDeg: d * RAD_TO_DEG });
    } else if (state.headingRad !== undefined) {
      const dh = c.yawToHeadingSign * d;
      state.headingRad = wrapHeadingRad(state.headingRad + dh);
      state.window.yawDeltaRad += dh;
      state.yawSinceAnchorRad += dh;
      if (Math.abs(state.yawSinceAnchorRad) >= c.yawDeltaSourceThresholdRad) state.headingSource = 'YAW_DELTA';
    }
  }
  state.lastYaw = o.yaw;
}

function markPdr(state: FusionStateV21, applied: boolean, reason: PdrRejectReason | null) {
  const w = state.window;
  w.pdrApplied = (w.pdrApplied ?? false) || applied;
  if (reason) w.pdrRejectReason = reason;
}

function applyPedometer(state: FusionStateV21, o: Extract<Observation, { kind: 'pedometer' }>, c: FusionConfigV21, r: StepResultV21) {
  if (o.distance === null) return;
  state.hasPedometer = true;
  if (!Number.isFinite(o.distance)) {
    markPdr(state, false, 'NOT_FINITE');
    r.events.push({ type: 'pedometer', t: o.t, delta: NaN, applied: false, reason: 'NOT_FINITE' });
    return;
  }
  const pedSegmentChanged = state.lastPedometerSegment !== undefined && (o.segment ?? null) !== state.lastPedometerSegment;
  state.lastPedometerSegment = o.segment ?? null;
  if (state.lastPedometerDistance === undefined || state.lastPedometerT === undefined || pedSegmentChanged) {
    // cumulative: the first sample (of the session or of a new pedometer segment) is the baseline only
    state.lastPedometerDistance = o.distance;
    state.lastPedometerT = o.t;
    state.lastStepCount = o.steps ?? undefined;
    restartPedometerCounter(state.pedometerCounter, o.steps, o.distance);
    return;
  }
  // Only values above the run's maximum count; a lower sample (e.g. an interleaved 0) never becomes the baseline.
  const verdict = checkPedometerCounter(state.pedometerCounter, o.steps, o.distance);
  if (verdict !== 'OK') {
    if (verdict === 'COUNTER_RESTARTED') {
      state.lastPedometerDistance = o.distance;
      state.lastPedometerT = o.t;
      state.lastStepCount = o.steps ?? undefined;
    }
    markPdr(state, false, verdict);
    r.events.push({ type: 'pedometer', t: o.t, delta: 0, applied: false, reason: verdict });
    return;
  }
  let delta = o.distance - state.lastPedometerDistance; // deltaDistance = current - previous maximum
  const dt = (o.t - state.lastPedometerT) / 1000;
  const stepsIncreased = o.steps !== null && state.lastStepCount !== undefined && o.steps > state.lastStepCount;
  state.lastPedometerDistance = o.distance;
  state.lastPedometerT = o.t;
  if (o.steps !== null) state.lastStepCount = o.steps;

  if (delta < 0) {
    markPdr(state, false, 'NEGATIVE_DELTA');
    r.events.push({ type: 'pedometer', t: o.t, delta, applied: false, reason: 'NEGATIVE_DELTA' });
    return;
  }
  if (delta > c.maxStationaryDistanceDelta || stepsIncreased) state.lastMovementEvidenceT = o.t;
  if (delta === 0) return;

  let reason: PdrRejectReason | null = null;
  const maxDelta = c.maxPedestrianSpeed * Math.max(dt, c.minPedometerIntervalS);
  if (delta > maxDelta) {
    delta = maxDelta; // physical gate: e.g. 10 m in 0.5 s is clamped to walking speed
    reason = 'OVERSPEED_CLAMPED';
  }
  state.pedometerTotal += delta;

  if (!state.initialized) {
    markPdr(state, false, 'NOT_INITIALIZED');
    r.events.push({ type: 'pedometer', t: o.t, delta, applied: false, reason: 'NOT_INITIALIZED' });
    return;
  }
  state.pedometerSinceAnchor += delta;
  if (state.headingRad === undefined) {
    // No trusted heading: never move in an invented direction; the position only becomes less certain.
    state.horizontalUncertainty += c.unheadedUncertaintyPerMeter * delta;
    markPdr(state, false, 'NO_HEADING');
    r.events.push({ type: 'pedometer', t: o.t, delta, applied: false, reason: 'NO_HEADING' });
    return;
  }
  state.x += delta * Math.sin(state.headingRad); // heading 0 = North (+Y), 90° = East (+X)
  state.y += delta * Math.cos(state.headingRad);
  state.window.pdrDistance += delta;
  state.horizontalUncertainty += c.pdrUncertaintyPerMeter * delta;
  markPdr(state, true, reason);
  r.events.push({ type: 'pedometer', t: o.t, delta, applied: true, reason });
}

function applyAltimeter(state: FusionStateV21, o: Extract<Observation, { kind: 'altimeter' }>, c: FusionConfigV21, r: StepResultV21) {
  if (!finite(o.relativeAltitude)) return;
  const segment = o.segment ?? null;
  const segmentChanged = state.lastAltimeterSegment !== undefined && segment !== state.lastAltimeterSegment;
  // Without segment ids a long gap may hide a CMAltimeter restart (relativeAltitude back to 0): be safe.
  const unknownGap =
    segment === null && state.lastAltimeterSegment === null && state.lastAltimeterT !== undefined && o.t - state.lastAltimeterT > c.altimeterContinuityThresholdMs;
  if ((segmentChanged || unknownGap) && state.lastRelativeAltitude !== undefined) {
    // New relativeAltitude reference: keep the current fused Z and continue from the new segment's first value.
    // z = datum + (rel - base)  =>  datum := current Z, base := new rel  (no jump from 2.5 m back to 0 m)
    if (state.initialized) state.heightDatum = currentHeightV21(state);
    state.relativeAltitudeOffset = 0;
    state.lastRelativeAltitude = o.relativeAltitude;
    state.lastAltimeterT = o.t;
    state.lastAltimeterSegment = segment;
    if (state.initialized) state.baseRelativeAltitude = o.relativeAltitude;
    state.altimeterRebases++;
    r.events.push({ type: 'altimeter-rebase', t: o.t, reason: segmentChanged ? 'SEGMENT_CHANGE' : 'GAP' });
    return;
  }
  state.lastAltimeterSegment = segment;
  if (state.lastRelativeAltitude !== undefined && state.lastAltimeterT !== undefined) {
    const jump = o.relativeAltitude - state.lastRelativeAltitude;
    const dt = (o.t - state.lastAltimeterT) / 1000;
    if (Math.abs(jump) > c.maxVerticalSpeed * Math.max(dt, 1)) {
      // Physically implausible vertical speed: treat as a sensor glitch, it does not move Z (raw stays raw).
      state.relativeAltitudeOffset += jump;
      r.events.push({ type: 'altimeter-glitch', t: o.t, jump });
    }
  }
  state.lastRelativeAltitude = o.relativeAltitude;
  state.lastAltimeterT = o.t;
  if (state.initialized && state.baseRelativeAltitude === undefined) state.baseRelativeAltitude = adjustedRelativeAltitude(state);
}

// ---------------- GPS ----------------

type GpsObs = Extract<Observation, { kind: 'gps' }>;
type InitFix = NonNullable<FusionStateV21['initCandidate']>;

function initializeFrom(state: FusionStateV21, fix: InitFix, provisional: boolean, now: number, c: FusionConfigV21) {
  state.origin = { latitude: fix.latitude, longitude: fix.longitude, height: fix.ellipsoidalAltitude ?? fix.altitude ?? 0 };
  state.initialized = true;
  state.provisionalInit = provisional;
  state.initializedAt = now;
  state.x = 0;
  state.y = 0;
  state.horizontalUncertainty = fix.acc;
  // Z anchor: datum = first usable GPS height, base = barometer reading at that moment.
  state.heightDatum = fix.ellipsoidalAltitude ?? fix.altitude ?? 0;
  state.heightDatumIsEllipsoidal = fix.ellipsoidalAltitude !== null;
  state.baseRelativeAltitude = adjustedRelativeAltitude(state);
  state.verticalUncertainty = fix.ellipsoidalAltitude !== null && fix.vacc !== null ? fix.vacc : c.unknownVerticalUncertainty;
  state.lastAcceptedGps = { x: 0, y: 0, t: fix.t, acc: fix.acc };
  resetAnchor(state);
  state.nextOutputAt = (Math.floor(now / c.outputIntervalMs) + 1) * c.outputIntervalMs;
  state.window.anchored = true;
  state.window.immediate = true;
}

function resetAnchor(state: FusionStateV21) {
  state.anchorX = state.x;
  state.anchorY = state.y;
  state.pedometerSinceAnchor = 0;
  state.correctionSinceAnchor = 0;
}

function recordGps(state: FusionStateV21, o: GpsObs, used: boolean, reason: GpsRejectReasonV21 | null, quality: GpsQualityV21 | null, innovation: number | null) {
  const vacc = finite(o.verticalAccuracy) && o.verticalAccuracy > 0 ? o.verticalAccuracy : null;
  const w = state.window;
  w.gpsCount++;
  w.anyGpsUsed ||= used;
  w.lastGps = { seq: o.seq, used, reason, quality, acc: o.horizontalAccuracy, vacc, innovation };
}

function reanchor(state: FusionStateV21, reason: ReanchorReason, target: { x: number; y: number }, alpha: number, uncertainty: number, t: number, r: StepResultV21) {
  const before = { x: state.x, y: state.y };
  state.x += (target.x - state.x) * alpha;
  state.y += (target.y - state.y) * alpha;
  state.horizontalUncertainty = uncertainty;
  state.lastReanchorT = t;
  state.counters.reanchors += reason === 'DIVERGENCE' ? 0 : 1;
  state.window.reanchorReason = reason;
  state.window.immediate = true;
  resetAnchor(state);
  r.events.push({ type: 'reanchor', t, reason, shift: dist(before, state) });
}

function applyGps(state: FusionStateV21, o: GpsObs, c: FusionConfigV21, r: StepResultV21) {
  const acc = o.horizontalAccuracy;
  const decision = (used: boolean, reason: GpsRejectReasonV21 | null, quality: GpsQualityV21 | 'INVALID', innovation: number | null, allowed: number | null, alpha: number) =>
    r.events.push({ type: 'gps-decision', t: o.t, seq: o.seq, used, reason, quality, accuracy: acc, innovation, allowed, alpha });

  if (!finite(acc) || !(acc > 0) || !Number.isFinite(o.latitude) || !Number.isFinite(o.longitude)) {
    if (state.initialized) recordGps(state, o, false, 'INVALID_ACCURACY', null, null);
    decision(false, 'INVALID_ACCURACY', 'INVALID', null, null, 0);
    return;
  }
  const vacc = finite(o.verticalAccuracy) && o.verticalAccuracy > 0 ? o.verticalAccuracy : null;
  const quality = classifyGpsV21(acc, c);
  state.lastGpsAccuracy = acc;
  state.lastGpsVerticalAccuracy = vacc ?? undefined;

  if (!state.initialized) {
    const fix: InitFix = { latitude: o.latitude, longitude: o.longitude, ellipsoidalAltitude: o.ellipsoidalAltitude, altitude: o.altitude, acc, vacc, t: o.t };
    if (acc <= c.provisionalInitMaxAccuracy) state.firstValidFixT ??= o.t;
    if (acc <= c.provisionalInitMaxAccuracy && (!state.initCandidate || acc < state.initCandidate.acc)) state.initCandidate = fix;
    if (acc > c.initMaxAccuracy) {
      decision(false, 'NOT_INITIALIZED', quality, null, null, 0);
      return;
    }
    initializeFrom(state, fix, false, o.t, c);
    r.events.push({ type: 'initialized', t: o.t, accuracy: acc, provisional: false });
    // fall through: the anchor fix is also evidence / heading candidate (innovation 0)
  }

  const origin = state.origin!;
  const p = wgs84ToLocal(origin, o.latitude, o.longitude, origin.height);
  if (state.provisionalInit && acc * c.provisionalSnapFactor <= state.horizontalUncertainty) {
    // The provisional start came from a poor fix: a clearly better one replaces it (initialization refinement).
    state.x = p.x;
    state.y = p.y;
    state.horizontalUncertainty = acc;
    state.provisionalInit = acc > c.initMaxAccuracy;
    state.lastAcceptedGps = { x: p.x, y: p.y, t: o.t, acc };
    resetAnchor(state);
    state.window.anchored = true;
    state.window.immediate = true;
  }
  const innovation = dist(p, state);
  const fix: EvidenceFix = { x: p.x, y: p.y, t: o.t, acc, pedometerAt: state.pedometerTotal };
  if (acc <= c.evidenceMaxAccuracy) {
    state.evidence.push(fix);
    state.evidence = state.evidence.filter((f) => o.t - f.t <= c.recentGpsWindowMs).slice(-c.recentGpsWindowSize);
  }
  bootstrapHeading(state, fix, c, r);

  let alpha = gpsAlphaV21(quality, c);
  let reason: GpsRejectReasonV21 | null = null;
  let allowed: number | null = null;
  let target = { x: p.x, y: p.y };
  const isInitFix = state.window.anchored && innovation === 0; // the fix that just initialized the state
  let stableAnchor = false;

  if (isInitFix) {
    alpha = 1;
  } else if (alpha <= 0) {
    reason = 'UNUSABLE_ACCURACY';
  } else if (state.stationary) {
    // Stationary: XY locked against GPS drift, except a tight cluster of excellent fixes (slow pull).
    reason = 'STATIONARY_LOCK';
    if (c.stableAnchorEnabled && acc <= c.stableAnchorAccuracy) {
      state.stableFixes.push({ x: p.x, y: p.y, t: o.t });
      state.stableFixes = state.stableFixes.filter((f) => o.t - f.t <= c.stableAnchorWindowMs);
      if (state.stableFixes.length >= c.stableAnchorMinFixes) {
        const cx = state.stableFixes.reduce((a, f) => a + f.x, 0) / state.stableFixes.length;
        const cy = state.stableFixes.reduce((a, f) => a + f.y, 0) / state.stableFixes.length;
        if (state.stableFixes.every((f) => Math.hypot(f.x - cx, f.y - cy) <= c.stableAnchorRadius)) {
          reason = null;
          stableAnchor = true;
          alpha = c.stableAnchorAlpha;
          target = { x: cx, y: cy };
        }
      }
    }
  }
  // physical jump vs the last accepted fix
  if (reason === null && !isInitFix && state.lastAcceptedGps) {
    const last = state.lastAcceptedGps;
    const dt = Math.max(0, (o.t - last.t) / 1000);
    if (dist(p, last) > c.jumpBaseTolerance + c.maximumHumanSpeed * dt + acc + last.acc) reason = 'PHYSICAL_JUMP';
  }
  // innovation vs the predicted position: max(8 m, 2 * sqrt(acc² + stateUncertainty²))
  if (reason === null && !isInitFix && !stableAnchor) {
    const u = Number.isFinite(state.horizontalUncertainty) ? state.horizontalUncertainty : 0;
    allowed = Math.max(c.minimumInnovationGate, c.innovationAccuracyMultiplier * Math.hypot(acc, u));
    if (innovation > allowed) reason = 'INNOVATION_TOO_LARGE';
  }

  if (reason === null) {
    const before = { x: state.x, y: state.y };
    state.x += (target.x - state.x) * alpha;
    state.y += (target.y - state.y) * alpha;
    state.correctionSinceAnchor += dist(before, state);
    state.horizontalUncertainty = blendUncertainty(state.horizontalUncertainty, acc, alpha);
    state.lastAcceptedGps = { x: p.x, y: p.y, t: o.t, acc };
    if (quality === 'EXCELLENT' || quality === 'GOOD') {
      resetAnchor(state); // trusted anchor
      state.window.immediate = true;
    }
    recordGps(state, o, true, null, quality, innovation);
    decision(true, null, quality, innovation, allowed, alpha);
  } else {
    // Rejected for XY. Is the PDR state what is wrong? (moving GPS track first, then a static cluster)
    const reanchored = tryTrackReanchor(state, fix, c, r) || tryClusterReanchor(state, c, o.t, r);
    recordGps(state, o, reanchored, reanchored ? null : reason, quality, innovation);
    decision(reanchored, reanchored ? null : reason, quality, innovation, allowed, reanchored ? 1 : 0);
    if (reanchored) state.lastAcceptedGps = { x: p.x, y: p.y, t: o.t, acc };
  }

  // ---- vertical: GPS ellipsoidal height adjusts the Z datum (barometer carries relative changes) ----
  if (reason !== 'PHYSICAL_JUMP' && o.ellipsoidalAltitude !== null && vacc !== null) {
    if (!state.heightDatumIsEllipsoidal) {
      state.heightDatum = (state.heightDatum ?? 0) + (o.ellipsoidalAltitude - currentHeightV21(state));
      state.heightDatumIsEllipsoidal = true;
      state.verticalUncertainty = vacc;
    } else {
      // Vertical innovation gate: the barometer carries Z reliably over minutes, so a GPS height tens of meters away
      // is an outlier even when it reports a small verticalAccuracy (seen indoors: 43 m jump with vacc 3 m).
      const zNow = currentHeightV21(state);
      const innovationZ = o.ellipsoidalAltitude - zNow;
      const vu = Number.isFinite(state.verticalUncertainty) ? state.verticalUncertainty : 0;
      const allowedZ = Math.max(c.minimumVerticalInnovationGate, c.verticalInnovationMultiplier * Math.hypot(vacc, vu));
      if (Math.abs(innovationZ) > allowedZ) {
        state.verticalRejectedCount++;
        if (vacc <= c.verticalReanchorMaxAccuracy) state.verticalRejects.push(o.ellipsoidalAltitude);
        const recent = state.verticalRejects.slice(-c.verticalReanchorAfterRejects);
        if (recent.length >= c.verticalReanchorAfterRejects && Math.max(...recent) - Math.min(...recent) <= c.verticalReanchorSpread) {
          // Several good fixes agree on another height: our datum was wrong, move it there.
          state.heightDatum = (state.heightDatum ?? 0) + (median(recent) - zNow);
          state.verticalUncertainty = vacc;
          state.verticalRejects = [];
          state.window.immediate = true;
          r.events.push({ type: 'vertical-reanchor', t: o.t, shift: median(recent) - zNow });
        } else {
          r.events.push({ type: 'vertical-rejected', t: o.t, innovation: innovationZ, allowed: allowedZ });
        }
      } else {
        state.verticalRejects = [];
        const beta = verticalAlpha(vacc, c);
        if (beta > 0) {
          state.heightDatum = (state.heightDatum ?? 0) + innovationZ * beta;
          state.verticalUncertainty = blendUncertainty(state.verticalUncertainty, vacc, beta);
        }
      }
    }
  }

  // ---- trusted GPS course: absolute heading anchor (degrees -> radians) ----
  if (
    reason !== 'PHYSICAL_JUMP' &&
    !state.stationary &&
    finite(o.course) && o.course >= 0 &&
    finite(o.speed) && o.speed >= c.trustedCourseMinSpeed &&
    acc <= c.trustedCourseAccuracy
  ) {
    const course = wrapHeadingRad(o.course * DEG_TO_RAD);
    const bootstrap = state.headingRad === undefined;
    state.headingRad = bootstrap ? course : blendHeadingRad(state.headingRad!, course, c.headingAlpha);
    state.headingSource = 'GPS_COURSE';
    state.yawSinceAnchorRad = 0;
    r.events.push({ type: 'heading', t: o.t, source: 'GPS_COURSE', headingDeg: headingRadToDeg(state.headingRad), bootstrap });
  }
}

/** Two-point GPS bearing: bootstraps a missing heading (fixes <= 25 m), refreshes it with good fixes (<= 10 m). */
function bootstrapHeading(state: FusionStateV21, b: EvidenceFix, c: FusionConfigV21, r: StepResultV21) {
  if (b.acc > c.bootstrapMaxAccuracy) return;
  const a = state.lastBootstrapFix;
  if (!a || b.t - a.t > c.bootstrapMaxIntervalMs) {
    state.lastBootstrapFix = b;
    return;
  }
  if (state.stationary) return;
  const d = dist(a, b);
  const needed = Math.max(c.minimumBootstrapDistance, c.bootstrapNoiseFactor * Math.hypot(a.acc, b.acc));
  if (d < needed) return;
  // With a pedometer, the user must actually have walked between A and B (otherwise it is GPS scatter).
  if (state.hasPedometer && b.pedometerAt - a.pedometerAt < c.bootstrapMinPedometerDistance) {
    state.lastBootstrapFix = b;
    return;
  }
  const bearing = wrapHeadingRad(Math.atan2(b.x - a.x, b.y - a.y)); // atan2(east, north) = compass bearing
  const bootstrap = state.headingRad === undefined;
  if (bootstrap) {
    state.headingRad = bearing;
  } else if (a.acc <= c.refreshMaxAccuracy && b.acc <= c.refreshMaxAccuracy) {
    state.headingRad = blendHeadingRad(state.headingRad!, bearing, c.headingAlpha);
  } else {
    state.lastBootstrapFix = b;
    return;
  }
  state.headingSource = 'GPS_TWO_POINT';
  state.yawSinceAnchorRad = 0;
  state.lastBootstrapFix = b;
  r.events.push({ type: 'heading', t: b.t, source: 'GPS_TWO_POINT', headingDeg: headingRadToDeg(state.headingRad), bootstrap });
}

const cooledDown = (state: FusionStateV21, t: number, c: FusionConfigV21) => state.lastReanchorT === undefined || t - state.lastReanchorT >= c.reanchorCooldownMs;

/**
 * GPS track: recent usable fixes form one consistent, mostly straight movement that the pedometer cannot explain
 * (e.g. bus, car). PDR cannot follow it, so jump to the GPS track (hard re-anchor) and take its bearing.
 */
function tryTrackReanchor(state: FusionStateV21, last: EvidenceFix, c: FusionConfigV21, r: StepResultV21): boolean {
  if (!cooledDown(state, last.t, c) || last.acc > c.evidenceMaxAccuracy) return false;
  const fixes = state.evidence;
  if (fixes.length < c.trackMinFixes || fixes.at(-1) !== last) return false;
  const first = fixes[0];
  if (last.t - first.t < c.trackMinSpanMs) return false;
  let path = 0;
  for (let i = 1; i < fixes.length; i++) {
    const d = dist(fixes[i - 1], fixes[i]);
    const dt = Math.max((fixes[i].t - fixes[i - 1].t) / 1000, 0.001);
    if ((d - fixes[i - 1].acc - fixes[i].acc) / dt > c.trackMaxSpeed) return false; // not one physical track
    path += d;
  }
  const displacement = dist(first, last);
  const medAcc = median(fixes.map((f) => f.acc));
  if (displacement < Math.max(c.trackMinDisplacement, 2 * medAcc)) return false;
  if (displacement < 0.6 * path) return false; // scatter zig-zags; a ride is mostly straight
  if (displacement <= last.pedometerAt - first.pedometerAt + c.trackPedometerTolerance) return false; // walking explains it
  reanchor(state, 'GPS_TRACK', last, 1, last.acc, last.t, r);
  state.headingRad = wrapHeadingRad(Math.atan2(last.x - first.x, last.y - first.y));
  state.headingSource = 'GPS_TWO_POINT';
  state.yawSinceAnchorRad = 0;
  return true;
}

/** GPS cluster: recent fixes agree on one area but the PDR state is far away => PDR drifted. Soft reset. */
function tryClusterReanchor(state: FusionStateV21, c: FusionConfigV21, t: number, r: StepResultV21): boolean {
  if (!cooledDown(state, t, c)) return false;
  const fixes = state.evidence.filter((f) => f.acc <= c.clusterMaxAccuracy);
  if (fixes.length < c.clusterMinFixes) return false;
  const cx = fixes.reduce((a, f) => a + f.x, 0) / fixes.length;
  const cy = fixes.reduce((a, f) => a + f.y, 0) / fixes.length;
  const centroid = { x: cx, y: cy };
  if (!fixes.every((f) => dist(f, centroid) <= c.clusterMaxSpread)) return false;
  const medAcc = median(fixes.map((f) => f.acc));
  if (dist(state, centroid) <= Math.max(c.clusterMinOffset, 2 * medAcc)) return false;
  reanchor(state, 'GPS_CLUSTER', centroid, c.clusterReanchorAlpha, medAcc, t, r);
  return true;
}

/**
 * Bug guard: displacement since the last anchor must be explained by walked distance + accepted corrections.
 * If not, the state is reset to GPS evidence (cluster centroid, else last accepted fix, else the anchor).
 */
function divergenceGuard(state: FusionStateV21, t: number, c: FusionConfigV21, r: StepResultV21) {
  const allowed = state.pedometerSinceAnchor + state.correctionSinceAnchor + c.divergenceTolerance;
  if (dist(state, { x: state.anchorX, y: state.anchorY }) <= allowed) return;
  state.counters.divergences++;
  state.window.divergence = true;
  const usable = state.evidence.filter((f) => f.acc <= c.clusterMaxAccuracy);
  const target = usable.length
    ? { x: usable.reduce((a, f) => a + f.x, 0) / usable.length, y: usable.reduce((a, f) => a + f.y, 0) / usable.length }
    : state.lastAcceptedGps ?? { x: state.anchorX, y: state.anchorY };
  const u = usable.length ? median(usable.map((f) => f.acc)) : state.lastAcceptedGps?.acc ?? state.horizontalUncertainty;
  reanchor(state, 'DIVERGENCE', target, 1, u, t, r);
}

// ---------------- output ----------------

function emitOutput(state: FusionStateV21, c: FusionConfigV21, r: StepResultV21) {
  const origin = state.origin!;
  const zAbs = currentHeightV21(state);
  const geo = localToWgs84(origin, { x: state.x, y: state.y, z: zAbs - origin.height });
  const w = state.window;
  const source: PositionSource = w.anchored
    ? 'GPS_ANCHORED'
    : w.reanchorReason
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
  const g = w.lastGps;
  state.fusionSequence++;
  const output: FusedOutput = {
    fusionSequence: state.fusionSequence,
    timestamp: state.lastObservationT ?? 0,
    latitude: geo.latitude,
    longitude: geo.longitude,
    ellipsoidalAltitude: state.heightDatumIsEllipsoidal ? zAbs : null,
    geomZ: zAbs,
    x: state.x,
    y: state.y,
    z: zAbs - origin.height,
    headingDegrees: state.headingRad !== undefined ? headingRadToDeg(state.headingRad) : null,
    horizontalConfidence: h,
    verticalConfidence: v,
    overallConfidence: clamp01(h * c.overallHorizontalWeight + v * (1 - c.overallHorizontalWeight)),
    gpsHorizontalAccuracy: g?.acc ?? state.lastGpsAccuracy ?? null,
    gpsVerticalAccuracy: g?.vacc ?? state.lastGpsVerticalAccuracy ?? null,
    source,
    gpsUsed: w.gpsCount > 0 ? w.anyGpsUsed : null,
    gpsRejectReason: w.gpsCount > 0 && !w.anyGpsUsed ? (g?.reason ?? null) : null,
    gpsSequence: g?.seq ?? null,
    innovationDistance: g?.innovation ?? null,
    stationary: state.stationary,
    headingSource: state.headingSource,
    horizontalUncertainty: Number.isFinite(state.horizontalUncertainty) ? state.horizontalUncertainty : null,
    gpsQuality: g?.quality ?? null,
    pdrApplied: w.pdrApplied,
    pdrRejectReason: w.pdrRejectReason,
    relativeAltitude: state.lastRelativeAltitude ?? null,
    reanchored: w.reanchorReason !== null,
    reanchorReason: w.reanchorReason,
    divergenceDetected: w.divergence,
  };
  r.outputs.push(output);
  r.events.push({ type: 'output', output, yawDeltaDeg: w.yawDeltaRad * RAD_TO_DEG, pdrDistance: w.pdrDistance });
  state.lastOutputT = state.lastObservationT;
  state.lastOutputZ = zAbs;
  state.window = emptyWindowV21();
}

// ---------------- summaries / debug ----------------

export function summarizeV21(state: FusionStateV21, events: FusionEventV21[]) {
  const reasons: Record<string, number> = {};
  let accepted = 0;
  let rejected = 0;
  let maxRejectedInnovation: number | null = null;
  for (const e of events) {
    if (e.type !== 'gps-decision' || e.reason === 'NOT_INITIALIZED') continue;
    if (e.used) accepted++;
    else {
      rejected++;
      if (e.reason) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
      if ((e.reason === 'INNOVATION_TOO_LARGE' || e.reason === 'PHYSICAL_JUMP') && e.innovation !== null) {
        maxRejectedInnovation = Math.max(maxRejectedInnovation ?? 0, e.innovation);
      }
    }
  }
  return {
    gpsAccepted: accepted,
    gpsRejected: rejected,
    rejectReasons: reasons,
    maxRejectedInnovation,
    stationaryMs: Math.round(state.stationaryMs),
    reanchors: state.counters.reanchors,
    divergences: state.counters.divergences,
    motionGaps: state.motionGaps,
    altimeterRebases: state.altimeterRebases,
    verticalRejected: state.verticalRejectedCount,
  };
}

export function describeEventV21(e: FusionEventV21): { event: string; fields: Record<string, unknown> } | null {
  const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  switch (e.type) {
    case 'initialized':
      return { event: 'fusion.initialized', fields: { accuracy: r1(e.accuracy), provisional: e.provisional } };
    case 'gps-decision':
      return e.used
        ? { event: 'fusion.gps_used', fields: { seq: e.seq, quality: e.quality, accuracy: r1(e.accuracy), alpha: e.alpha, innovation: r1(e.innovation) } }
        : { event: 'fusion.gps_rejected', fields: { seq: e.seq, reason: e.reason, accuracy: r1(e.accuracy), innovation: r1(e.innovation), allowed: r1(e.allowed) } };
    case 'reanchor':
      return { event: 'fusion.reanchor', fields: { reason: e.reason, shift: r1(e.shift) } };
    case 'stationary':
      return { event: e.stationary ? 'fusion.stationary_entered' : 'fusion.stationary_exited', fields: { accelRmsG: e.accelRms === null ? null : Math.round(e.accelRms * 1000) / 1000 } };
    case 'heading':
      return { event: 'fusion.heading_anchor', fields: { source: e.source, heading: r1(e.headingDeg), bootstrap: e.bootstrap } };
    case 'pedometer':
      return { event: 'fusion.pedometer', fields: { delta: Math.round(e.delta * 100) / 100, applied: e.applied, reason: e.reason } };
    case 'altimeter-glitch':
      return { event: 'fusion.altimeter_glitch', fields: { jump: r1(e.jump) } };
    case 'altimeter-rebase':
      return { event: 'fusion.altimeter_rebase', fields: { reason: e.reason } };
    case 'vertical-rejected':
      return { event: 'fusion.gps_height_rejected', fields: { innovation: r1(e.innovation), allowed: r1(e.allowed) } };
    case 'vertical-reanchor':
      return { event: 'fusion.gps_height_reanchor', fields: { shift: r1(e.shift) } };
    case 'yaw-glitch':
      return { event: 'fusion.yaw_glitch', fields: { delta: r1(e.deltaDeg) } };
    case 'output':
      return {
        event: 'fusion.output',
        fields: {
          seq: e.output.fusionSequence,
          x: r1(e.output.x),
          y: r1(e.output.y),
          z: r1(e.output.z),
          source: e.output.source,
          stationary: e.output.stationary,
          heading: e.output.headingDegrees === null ? null : r1(e.output.headingDegrees),
          headingSource: e.output.headingSource,
          pdr: Math.round(e.pdrDistance * 100) / 100,
          confidence: Math.round(e.output.overallConfidence * 100) / 100,
        },
      };
    case 'late-observation':
      return null;
  }
}
