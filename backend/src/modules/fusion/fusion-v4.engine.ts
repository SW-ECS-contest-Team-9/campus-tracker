/**
 * fusion-v4 — step-level PDR + Kalman filter + RTS smoother (pure logic: no DB, no clock).
 *
 * Why (measured on real sessions, 2026-10-02): campus GPS is 15-60 m (8 of 670 fixes <= 5 m), so v3.x never
 * anchored and v2.1 followed noise; CMPedometer arrives in 2.6 s chunks applied along one heading and uses a
 * flat-ground stride on stairs; yaw is in an arbitrary frame, so the absolute heading is unknown.
 *
 *  - steps:   detected from 50 Hz vertical user acceleration, each applied with the yaw at its own time;
 *             stride = CMPedometer distance per detected level step; barometric |dz/dt| => stair tread
 *  - heading: walking direction = -yaw + theta. theta is one unknown per heading segment (new segment on a
 *             phone pose change / motion gap). It is found by fitting the walked shape to GPS fixes (robust grid
 *             search) or carried over a segment change by assuming the walking direction continues.
 *  - GPS:     an accuracy-weighted measurement in an EKF over [x, y, theta] with a chi-square gate; never a
 *             pass/fail anchor. A run of consistent rejected fixes re-anchors (the state was wrong).
 *  - replay:  finalize() re-estimates every segment's theta with ALL its fixes, runs the filter again and an
 *             RTS backward pass, re-weights GPS by robust residuals (3 iterations). This is the stored result.
 *  - height:  barometer relative Z + a zero b(t). With the campus DEM (rev 2): b comes from ground contacts
 *             (walking outdoors = ground + phone height), smoothed as a slow random walk (weather drift);
 *             fallback = GPS heights consistent with the ground, then the GPS median (no DEM).
 */
import { localToWgs84 } from '../../geo/local-to-wgs84.js';
import { wgs84ToLocal } from '../../geo/wgs84-to-local.js';
import { headingRadToDeg, normalizeAngleRad } from '../../geo/angles.js';
import { terrain as terrainModel } from '../../geo/terrain.js';
import { tmForward } from '../../geo/tm.js';
import type { FusionConfigV4 } from './fusion.config.js';
import { checkPedometerCounter, restartPedometerCounter } from './fusion.pedometer.js';
import type { Observation } from './fusion.timeline.js';
import type { FusedOutput, GpsRejectReason, PositionSource } from './fusion.types.js';
import { createFusionStateV4, emptyWindowV4, type ContactV4, type DatumV4, type FusionStateV4 } from './fusion-state-v4.js';
import {
  applyPrediction,
  diag3,
  fitHeading,
  floorPosition,
  gpsUpdate,
  predictStep,
  predictTime,
  predictUnheaded,
  sigmaXY,
  smoothEvents,
  type Mat3,
  type SmootherEvent,
  type Vec3,
} from './fusion-v4.smoother.js';

export type FusionEventV4 =
  | { type: 'initialized'; t: number; accuracy: number }
  | { type: 'gps'; t: number; seq: number; used: boolean; reason: string | null; accuracy: number | null; innovation: number | null }
  | { type: 'heading-segment'; t: number; reason: string }
  | { type: 'heading'; t: number; source: 'GPS_SHAPE_FIT' | 'CONTINUITY'; headingOffsetDeg: number; sigmaDeg: number }
  | { type: 'reanchor'; t: number; shift: number }
  | { type: 'smoothed'; t: number; iterations: number; steps: number; fixes: number; gpsAccepted: number; gpsDownweighted: number; segments: number; segmentsWithHeading: number };

export interface StepResultV4 { outputs: FusedOutput[]; events: FusionEventV4[] }

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const DEG = Math.PI / 180;
const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// 2nd-order Butterworth low-pass for the step signal (50 Hz CMDeviceMotion)
function biquad(c: FusionConfigV4) {
  const K = Math.tan((Math.PI * c.stepLowPassHz) / 50);
  const q = Math.SQRT1_2;
  const norm = 1 / (1 + K / q + K * K);
  const b0 = K * K * norm;
  return { b0, b1: 2 * b0, b2: b0, a1: 2 * (K * K - 1) * norm, a2: (1 - K / q + K * K) * norm };
}

// ---------------------------------------------------------------------------------------------
// filter helpers
// ---------------------------------------------------------------------------------------------

/** Time-based process noise up to t (slow drift; large in a vehicle). */
function advance(s: FusionStateV4, t: number, c: FusionConfigV4) {
  if (!s.initialized) return;
  if (s.lastEventT !== undefined && t > s.lastEventT) {
    const q = (s.vehicle ? c.vehicleProcessNoiseM2PerS : c.idleProcessNoiseM2PerS) * ((t - s.lastEventT) / 1000);
    const p = predictTime(s.x, q);
    s.P = applyPrediction(s.P, p);
  }
  s.lastEventT = Math.max(s.lastEventT ?? t, t);
}

function setTheta(s: FusionStateV4, theta: number, variance: number) {
  s.x = [s.x[0], s.x[1], theta];
  const P = s.P.slice();
  P[2] = P[5] = P[6] = P[7] = 0;
  P[8] = variance;
  s.P = P;
  s.headingKnown = true;
}

function verticalSpeed(s: FusionStateV4, t: number, c: FusionConfigV4): number {
  const w = s.altWindow.filter((a) => a.t <= t && a.t >= t - c.stairWindowMs);
  if (w.length < 3) return 0;
  const mt = w.reduce((a, b) => a + b.t, 0) / w.length;
  const mz = w.reduce((a, b) => a + b.z, 0) / w.length;
  let num = 0;
  let den = 0;
  for (const a of w) {
    num += (a.t - mt) * (a.z - mz);
    den += (a.t - mt) ** 2;
  }
  return den > 0 ? (num / den) * 1000 : 0;
}

function stride(s: FusionStateV4, c: FusionConfigV4) {
  if (s.strideB < c.strideCalibrationMinSteps) return c.defaultStrideM;
  return Math.min(c.strideMaxM, Math.max(c.strideMinM, s.strideA / s.strideB));
}

function startSegment(s: FusionStateV4, t: number, reason: string, r: StepResultV4, c: FusionConfigV4) {
  s.segments.push({ id: s.segments.length, startT: t, reason, firstStep: s.steps.length });
  r.events.push({ type: 'heading-segment', t, reason });
  if (s.segments.length === 1) return;
  // the walking direction is assumed to continue across the change (phone pocketed, sensor restarted)
  s.pendingContinuity =
    s.headingKnown && s.lastStepRel !== undefined
      ? { thetaPlusRel: s.x[2] + s.lastStepRel, variance: s.P[8] + (c.continuityHeadingSigmaDeg * DEG) ** 2 }
      : undefined;
  s.headingKnown = false;
  s.headingSource = 'UNKNOWN';
}

function resetStepDetector(s: FusionStateV4) {
  s.bq = { x1: 0, x2: 0, y1: 0, y2: 0, primed: 0 };
  s.f1 = undefined;
  s.f2 = undefined;
  s.pending = [];
  s.walking = false;
  s.lastPeakT = undefined;
  s.lastYaw = undefined;
}

// ---------------------------------------------------------------------------------------------
// sensors
// ---------------------------------------------------------------------------------------------

function applyStep(s: FusionStateV4, t: number, rel: number, c: FusionConfigV4, r: StepResultV4) {
  const stairs = Math.abs(verticalSpeed(s, t, c)) >= c.stairVerticalSpeedMps;
  const length = stairs ? c.stairTreadM : stride(s, c);
  s.steps.push({ t, rel, length, stairs, segment: s.segments.length - 1 });
  s.stepsSinceUpdate++;
  if (!stairs) s.levelStepsSinceUpdate++;
  s.lastStepT = t;
  s.vehicle = false;
  if (s.pendingContinuity) {
    setTheta(s, s.pendingContinuity.thetaPlusRel - rel, s.pendingContinuity.variance);
    s.headingSource = 'CONTINUITY';
    r.events.push({ type: 'heading', t, source: 'CONTINUITY', headingOffsetDeg: s.x[2] / DEG, sigmaDeg: Math.sqrt(s.P[8]) / DEG });
    s.pendingContinuity = undefined;
  }
  s.lastStepRel = rel;
  if (!s.initialized) return;
  advance(s, t, c);
  const p = s.headingKnown
    ? predictStep(s.x, length, rel, stairs ? c.stairStrideSigmaFraction : c.strideSigmaFraction, c.headingRandomWalkDegPerStep * DEG)
    : predictUnheaded(s.x, s.P, length);
  s.P = applyPrediction(s.P, p);
  s.x = p.x;
  s.window.steps++;
  if (!s.headingKnown) s.window.unheadedSteps++;
  if (s.terrain && s.headingKnown && !stairs && s.z !== undefined) {
    const k = groundContact(s, t, s.x, s.P, s.z, c);
    if (k) s.contacts.push(k);
  }
}

function onPeak(s: FusionStateV4, t: number, rel: number, c: FusionConfigV4, r: StepResultV4) {
  if (s.lastPeakT !== undefined && t - s.lastPeakT < c.stepMinIntervalS * 1000) return;
  const interval = s.lastPeakT === undefined ? Infinity : t - s.lastPeakT;
  s.lastPeakT = t;
  if (interval > c.stepMaxIntervalS * 1000) {
    s.walking = false;
    s.pending = [];
  }
  if (s.walking) return applyStep(s, t, rel, c, r);
  s.pending.push({ t, rel });
  if (s.pending.length >= c.stepConfirmPeaks) {
    s.walking = true;
    for (const p of s.pending) applyStep(s, p.t, p.rel, c, r);
    s.pending = [];
  }
}

function applyMotion(s: FusionStateV4, o: Extract<Observation, { kind: 'motion' }>, c: FusionConfigV4, r: StepResultV4) {
  const gap = s.lastMotionT === undefined ? 0 : o.t - s.lastMotionT;
  const segChanged = s.lastMotionSegment !== undefined && (o.segment ?? null) !== s.lastMotionSegment;
  if (s.lastMotionT === undefined) startSegment(s, o.t, 'START', r, c);
  else if (gap > c.motionGapMs || segChanged) {
    s.counters.motionGaps++;
    resetStepDetector(s);
    startSegment(s, o.t, segChanged ? 'MOTION_SEGMENT' : 'MOTION_GAP', r, c);
  }
  s.lastMotionT = o.t;
  s.lastMotionSegment = o.segment ?? null;

  if (finite(o.yaw)) {
    if (!s.relInitialized) {
      s.rel = -o.yaw;
      s.relInitialized = true;
    } else if (s.lastYaw !== undefined) s.rel -= normalizeAngleRad(o.yaw - s.lastYaw);
    s.lastYaw = o.yaw;
  }

  // phone pose (gravity direction in the device frame): hand <-> pocket changes the yaw-to-walking offset
  const g: Vec3 | null = finite(o.gx) && finite(o.gy) && finite(o.gz) ? [o.gx, o.gy, o.gz] : null;
  const gNorm = g ? Math.hypot(g[0], g[1], g[2]) : 0;
  if (g && gNorm > 0.5) {
    const a = 0.05;
    s.gSmooth = s.gSmooth ? [s.gSmooth[0] + a * (g[0] - s.gSmooth[0]), s.gSmooth[1] + a * (g[1] - s.gSmooth[1]), s.gSmooth[2] + a * (g[2] - s.gSmooth[2])] : g;
    if (!s.gRef) s.gRef = s.gSmooth;
    else {
      const gs = s.gSmooth;
      const gr = s.gRef;
      const cos = (gs[0] * gr[0] + gs[1] * gr[1] + gs[2] * gr[2]) / Math.max(Math.hypot(...gs) * Math.hypot(...gr), 1e-9);
      if (Math.acos(Math.max(-1, Math.min(1, cos))) > c.poseChangeDeg * DEG) {
        s.poseOffSince ??= o.t;
        if (o.t - s.poseOffSince >= c.poseChangeHoldMs) {
          s.gRef = gs;
          s.poseOffSince = undefined;
          startSegment(s, o.t, 'POSE_CHANGE', r, c);
        }
      } else s.poseOffSince = undefined;
    }
  }

  // stationary: quiet accelerometer and no step for a while
  if (finite(o.ax) && finite(o.ay) && finite(o.az)) {
    s.accelWindow.push({ t: o.t, m2: o.ax * o.ax + o.ay * o.ay + o.az * o.az });
    while (s.accelWindow.length && s.accelWindow[0].t < o.t - c.stationaryWindowMs) s.accelWindow.shift();
    const rms = Math.sqrt(s.accelWindow.reduce((sum, v) => sum + v.m2, 0) / s.accelWindow.length);
    const stationary = s.accelWindow.length >= 20 && rms <= c.stationaryAccelRmsG && (s.lastStepT === undefined || o.t - s.lastStepT >= c.stationaryWindowMs);
    if (stationary !== s.stationary) {
      s.stationary = stationary;
      s.stationaryLog.push({ t: o.t, stationary });
    }
  }

  // step detection on the low-passed vertical user acceleration (+ = up)
  if (!g || gNorm <= 0.5 || !finite(o.ax) || !finite(o.ay) || !finite(o.az)) return;
  const v = -(o.ax * g[0] + o.ay * g[1] + o.az * g[2]) / gNorm;
  const f = biquad(c);
  const b = s.bq;
  const y = f.b0 * v + f.b1 * b.x1 + f.b2 * b.x2 - f.a1 * b.y1 - f.a2 * b.y2;
  b.x2 = b.x1;
  b.x1 = v;
  b.y2 = b.y1;
  b.y1 = y;
  b.primed++;
  if (b.primed > 10 && s.f1 && s.f2 !== undefined && s.f1.v > s.f2 && s.f1.v >= y && s.f1.v > c.stepPeakThresholdG) onPeak(s, s.f1.t, s.f1.rel, c, r);
  s.f2 = s.f1?.v;
  s.f1 = { v: y, t: o.t, rel: s.rel };
}

function applyPedometer(s: FusionStateV4, o: Extract<Observation, { kind: 'pedometer' }>, c: FusionConfigV4) {
  if (!finite(o.distance)) return;
  const steps = finite(o.steps) ? o.steps : null;
  const segChanged = s.lastPedometerSegment !== undefined && (o.segment ?? null) !== s.lastPedometerSegment;
  s.lastPedometerSegment = o.segment ?? null;
  if (!s.pedometerStarted || segChanged) {
    restartPedometerCounter(s.pedometerCounter, steps, o.distance);
    s.pedometerStarted = true;
    s.levelStepsSinceUpdate = 0;
    s.stepsSinceUpdate = 0;
    return;
  }
  const before = s.pedometerCounter.maxDistance ?? o.distance;
  const verdict = checkPedometerCounter(s.pedometerCounter, steps, o.distance);
  if (verdict === 'COUNTER_RESTARTED') {
    s.levelStepsSinceUpdate = 0;
    s.stepsSinceUpdate = 0;
  }
  if (verdict !== 'OK') return;
  const d = o.distance - before;
  if (d <= 0) return;
  const motionMissing = s.lastMotionT === undefined || o.t - s.lastMotionT > c.motionGapMs;
  if (motionMissing || s.stepsSinceUpdate === 0) {
    // walked, but no detected step can carry it (app suspended / steps too soft to detect): only uncertainty grows
    s.walked.push({ t: o.t, distance: d });
    if (s.initialized) {
      advance(s, o.t, c);
      s.P = applyPrediction(s.P, predictUnheaded(s.x, s.P, d));
    }
  } else if (Math.abs(verticalSpeed(s, o.t, c)) < c.stairVerticalSpeedMps && s.levelStepsSinceUpdate > 0) {
    s.strideA = c.strideForgetting * s.strideA + d;
    s.strideB = c.strideForgetting * s.strideB + s.levelStepsSinceUpdate;
  }
  s.levelStepsSinceUpdate = 0;
  s.stepsSinceUpdate = 0;
}

function applyAltimeter(s: FusionStateV4, o: Extract<Observation, { kind: 'altimeter' }>, c: FusionConfigV4) {
  if (!finite(o.relativeAltitude)) return;
  const segChanged = s.lastAltSegment !== undefined && (o.segment ?? null) !== s.lastAltSegment;
  const gap = s.lastAltT === undefined ? 0 : o.t - s.lastAltT;
  if (s.z === undefined) s.zOffset = -o.relativeAltitude;
  else if (segChanged || (o.segment == null && gap > c.altimeterContinuityMs)) {
    s.zOffset = s.z - o.relativeAltitude; // sensor restarted: Z continues, the unknown change during the gap is lost
    s.counters.altimeterRebases++;
  } else if (Math.abs(o.relativeAltitude + s.zOffset! - s.z) > c.altimeterMaxSpeedMps * Math.max(gap / 1000, 1)) return; // glitch
  s.z = o.relativeAltitude + s.zOffset!;
  s.lastAltT = o.t;
  s.lastAltSegment = o.segment ?? null;
  s.altWindow.push({ t: o.t, z: s.z });
  while (s.altWindow.length && s.altWindow[0].t < o.t - c.stairWindowMs - 2000) s.altWindow.shift();
  s.zLog.push({ t: o.t, z: s.z });
}

function rejectGps(s: FusionStateV4, o: Extract<Observation, { kind: 'gps' }>, reason: GpsRejectReason, r: StepResultV4, innovation: number | null = null) {
  s.counters.gpsRejected++;
  s.counters.reasons[reason] = (s.counters.reasons[reason] ?? 0) + 1;
  if (innovation !== null) s.counters.maxRejectedInnovation = Math.max(s.counters.maxRejectedInnovation ?? 0, innovation);
  s.window.gpsUsed = s.window.gpsUsed === true ? true : false;
  s.window.gpsReason = reason;
  s.window.gpsSeq = o.seq;
  s.window.gpsAccuracy = o.horizontalAccuracy;
  s.window.innovation = innovation;
  r.events.push({ type: 'gps', t: o.t, seq: o.seq, used: false, reason, accuracy: o.horizontalAccuracy, innovation });
}

function acceptGps(s: FusionStateV4, o: Extract<Observation, { kind: 'gps' }>, r: StepResultV4, innovation: number) {
  s.counters.gpsAccepted++;
  s.window.gpsUsed = true;
  s.window.gpsReason = null;
  s.window.gpsSeq = o.seq;
  s.window.gpsAccuracy = o.horizontalAccuracy;
  s.window.innovation = innovation;
  r.events.push({ type: 'gps', t: o.t, seq: o.seq, used: true, reason: null, accuracy: o.horizontalAccuracy, innovation });
}

function maybeReanchor(s: FusionStateV4, t: number, c: FusionConfigV4, r: StepResultV4) {
  if (s.rejectRun.length < c.gpsResetRejects) return;
  const run = s.rejectRun.map((i) => s.fixes[i]);
  if (run.at(-1)!.t - run[0].t < c.gpsResetMinSpanMs) return;
  const mx = median(run.map((f) => f.x))!;
  const my = median(run.map((f) => f.y))!;
  const ms = median(run.map((f) => f.sigma))!;
  const spread = Math.max(...run.map((f) => Math.hypot(f.x - mx, f.y - my)));
  if (spread > Math.max(30, 2 * ms)) {
    s.rejectRun.shift(); // not one consistent place: keep sliding
    return;
  }
  const shift = Math.hypot(mx - s.x[0], my - s.x[1]);
  s.x = [mx, my, s.x[2]];
  const theta = s.P[8] + (20 * DEG) ** 2;
  s.P = diag3(ms * ms, ms * ms, theta);
  s.counters.reanchors++;
  s.window.reanchored = true;
  s.rejectRun = [];
  r.events.push({ type: 'reanchor', t, shift });
}

/** Heading offset of the current segment from its walked shape vs the fixes (when unknown or very uncertain). */
function tryHeadingFit(s: FusionStateV4, t: number, c: FusionConfigV4, r: StepResultV4) {
  if (!s.initialized) return;
  if (s.headingKnown && s.P[8] <= (c.headingRefitAboveSigmaDeg * DEG) ** 2) return;
  const seg = s.segments.at(-1);
  if (!seg) return;
  const steps = s.steps.slice(seg.firstStep);
  const fixes = s.fixes.filter((f) => f.t >= seg.startT).map((f) => ({ t: f.t, x: f.x, y: f.y, sigma: f.sigma }));
  const fit = fitHeading(steps, fixes, c);
  if (!fit) return;
  s.x = [fit.endX, fit.endY, fit.theta];
  const pos = Math.max(fit.medianResidual, c.positionSigmaFloorM) ** 2;
  s.P = diag3(pos, pos, fit.sigma ** 2);
  s.headingKnown = true;
  s.headingSource = 'GPS_SHAPE_FIT';
  s.pendingContinuity = undefined;
  s.counters.headingFits++;
  r.events.push({ type: 'heading', t, source: 'GPS_SHAPE_FIT', headingOffsetDeg: fit.theta / DEG, sigmaDeg: fit.sigma / DEG });
}

function applyGps(s: FusionStateV4, o: Extract<Observation, { kind: 'gps' }>, c: FusionConfigV4, r: StepResultV4) {
  if (o.preSession) return rejectGps(s, o, 'PRE_SESSION', r);
  const acc = o.horizontalAccuracy;
  if (!finite(acc) || acc <= 0 || !Number.isFinite(o.latitude) || !Number.isFinite(o.longitude)) return rejectGps(s, o, 'INVALID_ACCURACY', r);
  if (acc > c.gpsMaxAccuracyM) return rejectGps(s, o, 'UNUSABLE_ACCURACY', r);
  const sigma = Math.max(acc, c.gpsSigmaFloorM);
  if (finite(o.ellipsoidalAltitude) && finite(o.verticalAccuracy) && o.verticalAccuracy > 0 && o.verticalAccuracy <= c.datumMaxVerticalAccuracyM) {
    s.datumSamples.push(o.ellipsoidalAltitude - (s.z ?? 0));
    if (s.terrain) {
      // orthometric GPS height, only when it agrees with "on the ground" (indoor GPS heights were off by -31..+16 m)
      // ...and only on flat, unmodified ground with a good horizontal fix: on the campus slopes a 20 m position error
      // moves the ground under the fix by tens of meters, so a wrong GPS height can look like "on the ground"
      const ground = terrainModel.sampleLatLon(s.terrain, o.latitude, o.longitude);
      const H = o.ellipsoidalAltitude - s.terrain.geoidSeparation;
      if (ground && !ground.modified && (acc ?? Infinity) <= c.gpsDatumMaxAccuracyM && (acc ?? 0) * ground.slope <= 2
        && Math.abs(H - (ground.height + c.phoneHeightM)) <= c.gpsDatumGateM) s.gpsOffsets.push(H - (s.z ?? 0));
    }
  }
  if (!s.initialized) {
    s.origin = { latitude: o.latitude, longitude: o.longitude, height: 0 };
    s.initialized = true;
    s.x = [0, 0, s.x[2]];
    s.P = diag3(sigma * sigma, sigma * sigma, s.headingKnown ? s.P[8] : 1);
    s.lastEventT = o.t;
    s.fixes.push({ t: o.t, seq: o.seq, x: 0, y: 0, accuracy: acc, sigma, vehicle: false, forwardUsed: true });
    s.window.anchored = true;
    acceptGps(s, o, r, 0);
    r.events.push({ type: 'initialized', t: o.t, accuracy: acc });
    return;
  }
  const p = wgs84ToLocal(s.origin!, o.latitude, o.longitude, 0);
  if (finite(o.speed) && o.speed >= c.vehicleSpeedMps && (s.lastStepT === undefined || o.t - s.lastStepT >= c.vehicleNoStepsMs)) s.vehicle = true;
  advance(s, o.t, c);
  const u = gpsUpdate(s.x, s.P, p.x, p.y, sigma * sigma);
  const innovation = Math.hypot(p.x - s.x[0], p.y - s.x[1]);
  const used = u.d2 <= c.gpsGateChi2;
  s.fixes.push({ t: o.t, seq: o.seq, x: p.x, y: p.y, accuracy: acc, sigma, vehicle: s.vehicle, forwardUsed: used });
  if (used) {
    s.x = u.x;
    s.P = floorPosition(u.P, c.positionSigmaFloorM);
    s.rejectRun = [];
    acceptGps(s, o, r, innovation);
  } else {
    s.rejectRun.push(s.fixes.length - 1);
    rejectGps(s, o, 'INNOVATION_TOO_LARGE', r, innovation);
    maybeReanchor(s, o.t, c, r);
  }
  tryHeadingFit(s, o.t, c, r);
}

// ---------------------------------------------------------------------------------------------
// outputs
// ---------------------------------------------------------------------------------------------

/** Ground contact: a trustworthy outdoor walking step gives b = DEM + phone height - barometric Z. */
function groundContact(s: FusionStateV4, t: number, x: Vec3, P: Mat3, z: number, c: FusionConfigV4): ContactV4 | null {
  const ctx = s.terrain;
  if (!ctx || !s.origin) return null;
  const sxy = sigmaXY(P);
  if (!(sxy <= c.contactMaxPositionSigmaM)) return null;
  const ll = localToWgs84(s.origin, { x: x[0], y: x[1], z: 0 });
  const g = tmForward(ll.latitude, ll.longitude);
  const ground = terrainModel.sampleXY(ctx, g.x, g.y);
  if (!ground || ground.modified) return null;
  const near = terrainModel.buildingAt(ctx, g.x, g.y);
  if (near.building || near.distance < Math.max(c.contactBuildingClearanceM, sxy / 2)) return null;
  const heightSigma = ground.sigma + sxy * ground.slope;
  if (heightSigma > c.contactMaxHeightSigmaM) return null;
  return { t, offset: ground.height + c.phoneHeightM - z, variance: heightSigma ** 2 + c.phoneHeightSigmaM ** 2 };
}

/** One contact per window (median): consecutive steps share their position error and must not count as independent. */
function thinContacts(contacts: ContactV4[], c: FusionConfigV4): ContactV4[] {
  const out: ContactV4[] = [];
  let bucket: ContactV4[] = [];
  const flush = () => {
    if (!bucket.length) return;
    out.push({
      t: bucket[bucket.length >> 1].t,
      offset: median(bucket.map((k) => k.offset))!,
      variance: bucket.reduce((a, k) => a + k.variance, 0) / bucket.length,
    });
    bucket = [];
  };
  for (const k of contacts) {
    if (bucket.length && k.t - bucket[0].t >= c.contactThinningMs) flush();
    bucket.push(k);
  }
  flush();
  return out;
}

/** Thinned contacts that agree with each other (a misread covered walkway or a floor is dropped), or null. */
function consistentContacts(contacts: ContactV4[], c: FusionConfigV4): ContactV4[] | null {
  const thinned = thinContacts(contacts, c);
  if (thinned.length < c.contactMinCount) return null;
  const m = median(thinned.map((k) => k.offset))!;
  const kept = thinned.filter((k) => Math.abs(k.offset - m) <= c.contactOutlierM);
  if (kept.length < c.contactMinCount || kept.at(-1)!.t - kept[0].t < c.contactMinSpanMs) return null;
  const m2 = median(kept.map((k) => k.offset))!;
  if (median(kept.map((k) => Math.abs(k.offset - m2)))! > c.contactMaxMadM) return null;
  return kept;
}

function gpsDatum(s: FusionStateV4, c: FusionConfigV4): DatumV4 | null {
  const values = s.terrain ? s.gpsOffsets : s.datumSamples;
  const m = median(values);
  if (m === null) return null;
  const mad = median(values.map((v) => Math.abs(v - m)))!;
  if (s.terrain && (values.length < c.gpsDatumMinSamples || mad > c.gpsDatumMaxMadM)) return null;
  return { b: m, sigma: Math.max(3, (1.4826 * mad) / Math.sqrt(values.length)), source: 'GPS', frame: s.terrain ? 'ORTHO' : 'ELLIPSOIDAL' };
}

/** Realtime zero: the recent consistent ground contacts, else GPS. */
function forwardDatum(s: FusionStateV4, c: FusionConfigV4): DatumV4 | null {
  const kept = consistentContacts(s.contacts.slice(-600), c);
  if (!kept) return gpsDatum(s, c);
  const recent = kept.slice(-12);
  const b = median(recent.map((k) => k.offset))!;
  const v = recent.reduce((a, k) => a + k.variance, 0) / recent.length;
  return { b, sigma: Math.sqrt(v / recent.length + 0.2 ** 2), source: 'TERRAIN', frame: 'ORTHO' };
}

/** Replay: the zero as a slow random walk (barometric drift) through the contacts, RTS-smoothed. */
function smoothDatum(kept: ContactV4[], c: FusionConfigV4) {
  const q = c.baroDriftMPerHour ** 2 / 3600; // m^2 per second
  const n = kept.length;
  const xf: number[] = [], pf: number[] = [], xp: number[] = [], pp: number[] = [];
  let x = median(kept.map((k) => k.offset))!;
  let P = 25;
  let lastT = kept[0].t;
  for (const k of kept) {
    P += (q * (k.t - lastT)) / 1000;
    lastT = k.t;
    xp.push(x);
    pp.push(P);
    const K = P / (P + k.variance);
    x += K * (k.offset - x);
    P *= 1 - K;
    xf.push(x);
    pf.push(P);
  }
  const xs = xf.slice();
  const ps = pf.slice();
  for (let i = n - 2; i >= 0; i--) {
    const C = pf[i] / pp[i + 1];
    xs[i] = xf[i] + C * (xs[i + 1] - xp[i + 1]);
    ps[i] = pf[i] + C * C * (ps[i + 1] - pp[i + 1]);
  }
  const at = (t: number): DatumV4 => {
    let i = 0;
    while (i + 1 < n && kept[i + 1].t <= t) i++;
    if (t <= kept[0].t) return { b: xs[0], sigma: Math.sqrt(ps[0] + (q * (kept[0].t - t)) / 1000), source: 'TERRAIN', frame: 'ORTHO' };
    if (i === n - 1) return { b: xs[i], sigma: Math.sqrt(ps[i] + (q * (t - kept[i].t)) / 1000), source: 'TERRAIN', frame: 'ORTHO' };
    const u = (t - kept[i].t) / Math.max(kept[i + 1].t - kept[i].t, 1);
    return { b: xs[i] + u * (xs[i + 1] - xs[i]), sigma: Math.sqrt(ps[i] + u * (ps[i + 1] - ps[i])), source: 'TERRAIN', frame: 'ORTHO' };
  };
  return { at, driftRange: Math.max(...xs) - Math.min(...xs), sigma: Math.sqrt(Math.min(...ps)) };
}

function output(
  s: FusionStateV4,
  t: number,
  x: Vec3,
  sigma: number,
  headingDeg: number | null,
  z: number,
  source: PositionSource,
  diag: Partial<FusedOutput>,
  datum: DatumV4 | null,
): FusedOutput {
  const ll = localToWgs84(s.origin!, { x: x[0], y: x[1], z: 0 });
  let ortho: number | null = null;
  let ellipsoidal: number | null = null;
  if (datum?.frame === 'ORTHO') {
    ortho = z + datum.b;
    ellipsoidal = s.terrain ? ortho + s.terrain.geoidSeparation : null;
  } else if (datum) ellipsoidal = z + datum.b;
  let terrainHeight: number | null = null;
  let building: { buildingId: string; name: string | null } | null = null;
  if (s.terrain) {
    const g = tmForward(ll.latitude, ll.longitude);
    terrainHeight = terrainModel.sampleXY(s.terrain, g.x, g.y)?.height ?? null;
    building = terrainModel.buildingAt(s.terrain, g.x, g.y).building;
  }
  const hc = Math.exp(-sigma / 15);
  const vc = datum ? Math.exp(-datum.sigma / 5) : 0.2;
  s.fusionSequence++;
  return {
    fusionSequence: s.fusionSequence,
    timestamp: t,
    latitude: ll.latitude,
    longitude: ll.longitude,
    ellipsoidalAltitude: ellipsoidal,
    geomZ: ellipsoidal ?? z,
    x: x[0],
    y: x[1],
    z,
    headingDegrees: headingDeg,
    horizontalConfidence: hc,
    verticalConfidence: vc,
    overallConfidence: 0.75 * hc + 0.25 * vc,
    gpsHorizontalAccuracy: null,
    gpsVerticalAccuracy: null,
    source,
    horizontalUncertainty: sigma,
    relativeAltitude: z,
    terrainHeight,
    heightAboveGround: ortho !== null && terrainHeight !== null ? ortho - terrainHeight : null,
    zDatumSource: datum?.source ?? 'NONE',
    zDatumSigma: datum?.sigma ?? null,
    buildingId: building?.buildingId ?? null,
    buildingName: building?.name ?? null,
    ...diag,
  };
}

function makeLiveOutput(s: FusionStateV4, t: number, c: FusionConfigV4): FusedOutput {
  const w = s.window;
  const headed = w.steps - w.unheadedSteps;
  const source: PositionSource = w.anchored ? 'GPS_ANCHORED' : w.reanchored ? 'GPS_REANCHOR' : w.gpsUsed && headed ? 'FUSED' : w.gpsUsed ? 'GPS_CORRECTED' : headed ? 'PDR_PREDICTED' : s.stationary ? 'STATIONARY_HOLD' : 'HELD';
  const out = output(s, t, s.x, sigmaXY(s.P), s.headingKnown ? headingRadToDeg(s.rel + s.x[2]) : null, s.z ?? 0, source, {
    gpsHorizontalAccuracy: w.gpsAccuracy,
    gpsUsed: w.gpsUsed,
    gpsRejectReason: (w.gpsUsed === false ? w.gpsReason : null) as GpsRejectReason | null,
    gpsSequence: w.gpsSeq,
    innovationDistance: w.innovation,
    stationary: s.stationary,
    headingSource: s.headingKnown ? s.headingSource : 'UNKNOWN',
    pdrApplied: w.steps ? headed > 0 : null,
    pdrRejectReason: w.unheadedSteps ? 'NO_HEADING' : null,
    reanchored: w.reanchored,
  }, forwardDatum(s, c));
  s.window = emptyWindowV4();
  return out;
}

// ---------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------

export function processObservationV4(s: FusionStateV4, o: Observation, c: FusionConfigV4): StepResultV4 {
  const r: StepResultV4 = { outputs: [], events: [] };
  if (s.terrain === undefined && o.terrainContext !== undefined) s.terrain = o.terrainContext;
  if (s.lastObservationT !== undefined && o.t < s.lastObservationT) {
    s.skippedLateObservations++;
    return r;
  }
  if (s.lastObservationT !== undefined && s.stationary) s.counters.stationaryMs += o.t - s.lastObservationT;
  if (o.kind === 'motion') applyMotion(s, o, c, r);
  else if (o.kind === 'pedometer') applyPedometer(s, o, c);
  else if (o.kind === 'altimeter') applyAltimeter(s, o, c);
  else applyGps(s, o, c, r);
  s.lastObservationT = o.t;
  if (s.initialized && (s.nextOutputAt === undefined || o.t >= s.nextOutputAt)) {
    r.outputs.push(makeLiveOutput(s, o.t, c));
    s.nextOutputAt = (Math.floor(o.t / c.outputIntervalMs) + 1) * c.outputIntervalMs;
  }
  return r;
}

export function flushFusionV4(s: FusionStateV4, c: FusionConfigV4): StepResultV4 {
  if (!s.initialized || s.lastObservationT === undefined) return { outputs: [], events: [] };
  const w = s.window;
  const pending = w.steps || w.gpsUsed !== null || w.anchored || w.reanchored;
  return { outputs: pending ? [makeLiveOutput(s, s.lastObservationT, c)] : [], events: [] };
}

/**
 * Barometric stair runs whose moments just before and just after are inside the same building footprint are
 * indoor stairs: steps of the run outside (or within the margin of) the outline get a soft anchor just inside it.
 * Outdoor stairs (e.g. up to an entrance from the road) start outside and are left alone.
 */
function indoorStairAnchors(s: FusionStateV4, points: { t: number; x: Vec3; event: SmootherEvent }[], c: FusionConfigV4): SmootherEvent[] {
  const ctx = s.terrain;
  if (!ctx || !s.origin) return [];
  const grid = (x: Vec3) => {
    const ll = localToWgs84(s.origin!, { x: x[0], y: x[1], z: 0 });
    return tmForward(ll.latitude, ll.longitude);
  };
  const runs: number[][] = [];
  points.forEach((p, i) => {
    if (p.event.kind !== 'step' || !p.event.stairs) return;
    const run = runs.at(-1);
    if (run && p.t - points[run.at(-1)!].t <= c.indoorStairRunGapMs) run.push(i);
    else runs.push([i]);
  });
  const anchors: SmootherEvent[] = [];
  let index = s.fixes.length;
  for (const run of runs) {
    const start = points[run[0]].t;
    const end = points[run.at(-1)!].t;
    // inside the same building at some step within the context window before the run and after it
    // (the steps right next to the run may already have drifted out with it)
    const insideOf = (p: { x: Vec3 }) => {
      const g = grid(p.x);
      return terrainModel.buildingAt(ctx, g.x, g.y).building;
    };
    const beforeIds = new Set(points.filter((p) => p.event.kind === 'step' && p.t < start && p.t >= start - c.indoorStairContextMs).map((p) => insideOf(p)?.buildingId).filter(Boolean));
    const afterIn = points.filter((p) => p.event.kind === 'step' && p.t > end && p.t <= end + c.indoorStairContextMs).map((p) => insideOf(p)).find((x) => x && beforeIds.has(x.buildingId));
    if (!afterIn) continue;
    const b = afterIn;
    for (const i of run) {
      const p = points[i];
      const q = grid(p.x);
      const edge = terrainModel.nearestEdge(b, q.x, q.y);
      if (edge.inside && edge.distance >= c.indoorStairMarginM) continue;
      // target: margin meters inside the outline along the line through the nearest edge point
      const dx = edge.inside ? q.x - edge.x : edge.x - q.x;
      const dy = edge.inside ? q.y - edge.y : edge.y - q.y;
      const len = Math.max(Math.hypot(dx, dy), 1e-6);
      const tx = edge.x + (dx / len) * c.indoorStairMarginM;
      const ty = edge.y + (dy / len) * c.indoorStairMarginM;
      // local ENU and EPSG:5186 deltas agree to < 0.1 % here (convergence 0.008 deg, scale ~1)
      anchors.push({ kind: 'fix', t: p.t, index: index++, x: p.x[0] + (tx - q.x), y: p.x[1] + (ty - q.y), sigma: c.indoorStairSigmaM, vehicle: false });
    }
  }
  return anchors;
}

/** Segment heading offsets for the smoother: fitted with all of the segment's fixes, else carried over. */
function segmentHeadings(s: FusionStateV4, weights: number[], c: FusionConfigV4) {
  const segs = s.segments;
  const result: { theta: number | null; variance: number }[] = [];
  const range = (k: number) => [segs[k].firstStep, k + 1 < segs.length ? segs[k + 1].firstStep : s.steps.length] as const;
  for (let k = 0; k < segs.length; k++) {
    const [a, b] = range(k);
    const endT = k + 1 < segs.length ? segs[k + 1].startT : Infinity;
    const fixes = s.fixes
      .map((f, i) => ({ f, w: weights[i] }))
      .filter(({ f, w }) => w > 0.05 && f.t >= segs[k].startT && f.t < endT)
      .map(({ f, w }) => ({ t: f.t, x: f.x, y: f.y, sigma: f.sigma / Math.sqrt(w) }));
    const fit = b - a > 0 ? fitHeading(s.steps.slice(a, b), fixes, c) : null;
    result.push(fit ? { theta: fit.theta, variance: fit.sigma ** 2 } : { theta: null, variance: 1 });
  }
  const cont = (c.continuityHeadingSigmaDeg * DEG) ** 2;
  const hasSteps = (k: number) => range(k)[1] > range(k)[0];
  for (let k = 1; k < segs.length; k++) {
    const p = k - 1;
    if (result[k].theta !== null || result[p].theta === null || !hasSteps(k) || !hasSteps(p)) continue;
    result[k] = { theta: result[p].theta! + s.steps[range(p)[1] - 1].rel - s.steps[range(k)[0]].rel, variance: result[p].variance + cont };
  }
  for (let k = segs.length - 2; k >= 0; k--) {
    const n = k + 1;
    if (result[k].theta !== null || result[n].theta === null || !hasSteps(k) || !hasSteps(n)) continue;
    result[k] = { theta: result[n].theta! + s.steps[range(n)[0]].rel - s.steps[range(k)[1] - 1].rel, variance: result[n].variance + cont };
  }
  return result;
}

const KIND_RANK: Record<SmootherEvent['kind'], number> = { segment: 0, step: 1, walked: 2, fix: 3 };

/**
 * Replay only: the authoritative trajectory. Uses future fixes too (RTS smoother), so a correction is spread
 * along the walk instead of a jump, and bad indoor fixes are down-weighted by their residual to the whole track.
 */
export function finalizeFusionV4(s: FusionStateV4, c: FusionConfigV4): StepResultV4 {
  if (!s.initialized || !s.origin) return { outputs: [], events: [] };
  let weights = s.fixes.map(() => 1);
  let smoothed: ReturnType<typeof smoothEvents> | null = null;
  let headings: ReturnType<typeof segmentHeadings> = [];
  let lastEvents: SmootherEvent[] = [];
  for (let it = 0; it < c.smootherIterations; it++) {
    headings = segmentHeadings(s, weights, c);
    const events: SmootherEvent[] = [
      ...s.segments.map((g, k): SmootherEvent => ({ kind: 'segment', t: g.startT, theta: headings[k].theta, thetaVar: headings[k].variance })),
      ...s.steps.map((p): SmootherEvent => ({ kind: 'step', t: p.t, rel: p.rel, length: p.length, stairs: p.stairs })),
      ...s.walked.map((w): SmootherEvent => ({ kind: 'walked', t: w.t, distance: w.distance })),
      ...s.fixes.map((f, i): SmootherEvent => ({ kind: 'fix', t: f.t, index: i, x: f.x, y: f.y, sigma: f.sigma, vehicle: f.vehicle })),
    ].sort((a, b) => a.t - b.t || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    smoothed = smoothEvents(events, weights, it === 0 ? c.gpsGateChi2 : null, c);
    const residual = new Array<number>(s.fixes.length).fill(0);
    for (const p of smoothed.points) if (p.event.kind === 'fix') residual[p.event.index] = Math.hypot(p.x[0] - p.event.x, p.x[1] - p.event.y);
    weights = s.fixes.map((f, i) => 1 / (1 + (residual[i] / (c.smootherCauchyScale * f.sigma)) ** 2));
    lastEvents = events;
  }
  // indoor stairs: the stair run went outside the building it starts and ends in -> soft anchors just inside, re-smooth
  const anchors = indoorStairAnchors(s, smoothed!.points, c);
  if (anchors.length) {
    const events = [...lastEvents, ...anchors].sort((a, b) => a.t - b.t || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    smoothed = smoothEvents(events, [...weights, ...anchors.map(() => 1)], null, c);
  }
  const points = smoothed!.points;
  const accepted = weights.filter((w) => w >= 0.5).length;

  // absolute height: ground contacts recomputed on the smoothed track, the zero smoothed through them
  const zAt = (t: number) => {
    const log = s.zLog;
    if (!log.length) return null;
    let lo = 0, hi = log.length - 1;
    if (t <= log[0].t) return log[0].z;
    if (t >= log[hi].t) return log[hi].z;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (log[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return log[lo].z + ((log[hi].z - log[lo].z) * (t - log[lo].t)) / Math.max(log[hi].t - log[lo].t, 1);
  };
  const contacts: ContactV4[] = [];
  if (s.terrain) {
    let known = false;
    for (const p of points) {
      if (p.event.kind === 'segment') known = p.event.theta !== null;
      if (p.event.kind !== 'step' || !known || p.event.stairs) continue;
      const z = zAt(p.t);
      if (z === null) continue;
      const k = groundContact(s, p.t, p.x, p.P, z, c);
      if (k) contacts.push(k);
    }
  }
  const kept = consistentContacts(contacts, c);
  const terrainDatum = kept ? smoothDatum(kept, c) : null;
  const fallbackDatum = terrainDatum ? null : gpsDatum(s, c);
  const datumAt = (t: number): DatumV4 | null => (terrainDatum ? terrainDatum.at(t) : fallbackDatum);
  s.smoothed = {
    datumSource: terrainDatum ? 'TERRAIN' : fallbackDatum ? 'GPS' : 'NONE',
    contacts: kept?.length ?? 0,
    datumSigma: terrainDatum ? terrainDatum.sigma : (fallbackDatum?.sigma ?? null),
    driftRangeM: terrainDatum ? terrainDatum.driftRange : null,
    gpsAccepted: accepted,
    gpsDownweighted: weights.length - accepted,
    segments: s.segments.length,
    segmentsWithHeading: headings.filter((h) => h.theta !== null).length,
    steps: s.steps.length,
    stairSteps: s.steps.filter((p) => p.stairs).length,
    walkedWithoutMotionM: s.walked.reduce((a, w) => a + w.distance, 0),
  };

  // 1 Hz outputs from the smoothed states (state of the latest event at or before each tick)
  const outputs: FusedOutput[] = [];
  s.fusionSequence = 0;
  if (!points.length) return { outputs, events: [] };
  const t0 = points[0].t;
  const tEnd = points.at(-1)!.t;
  let k = 0;
  let zi = 0;
  let si = 0;
  let segKnown = false;
  let lastRel: number | null = null;
  let stationary = false;
  let window = { steps: 0, unheaded: 0, fixUsed: null as boolean | null, fix: null as (typeof s.fixes)[number] | null, residual: null as number | null };
  for (let t = Math.ceil(t0 / c.outputIntervalMs) * c.outputIntervalMs; t <= tEnd + c.outputIntervalMs; t += c.outputIntervalMs) {
    const tick = Math.min(t, tEnd);
    while (k + 1 < points.length && points[k + 1].t <= tick) {
      k++;
      const e = points[k].event;
      if (e.kind === 'segment') segKnown = e.theta !== null;
      else if (e.kind === 'step') {
        lastRel = e.rel;
        window.steps++;
        if (!segKnown) window.unheaded++;
      } else if (e.kind === 'fix' && e.index < s.fixes.length) {
        const used = weights[e.index] >= 0.5;
        window.fixUsed = window.fixUsed === true || used;
        window.fix = s.fixes[e.index];
        window.residual = Math.hypot(points[k].x[0] - e.x, points[k].x[1] - e.y);
      }
    }
    if (points[0].event.kind === 'segment' && k === 0) segKnown = points[0].event.theta !== null;
    while (zi + 1 < s.zLog.length && s.zLog[zi + 1].t <= tick) zi++;
    while (si < s.stationaryLog.length && s.stationaryLog[si].t <= tick) stationary = s.stationaryLog[si++].stationary;
    const p = points[k];
    const sigma = sigmaXY(p.P);
    if (p.t <= tick && sigma <= c.maxOutputSigmaM) {
      const headed = window.steps - window.unheaded;
      const source: PositionSource = window.fixUsed && headed ? 'FUSED' : window.fixUsed ? 'GPS_CORRECTED' : headed ? 'PDR_PREDICTED' : stationary ? 'STATIONARY_HOLD' : 'HELD';
      const z = s.zLog.length && s.zLog[zi].t <= tick ? s.zLog[zi].z : 0;
      outputs.push(
        output(s, tick, p.x, sigma, segKnown && lastRel !== null ? headingRadToDeg(lastRel + p.x[2]) : null, z, source, {
          gpsHorizontalAccuracy: window.fix?.accuracy ?? null,
          gpsUsed: window.fixUsed,
          gpsRejectReason: window.fixUsed === false ? 'INNOVATION_TOO_LARGE' : null,
          gpsSequence: window.fix?.seq ?? null,
          innovationDistance: window.residual,
          stationary,
          headingSource: segKnown ? 'GPS_SHAPE_FIT' : 'UNKNOWN',
          pdrApplied: window.steps ? headed > 0 : null,
          pdrRejectReason: window.unheaded ? 'NO_HEADING' : null,
        }, datumAt(tick)),
      );
    }
    window = { steps: 0, unheaded: 0, fixUsed: null, fix: null, residual: null };
    if (tick === tEnd) break;
  }
  return {
    outputs,
    events: [{ type: 'smoothed', t: tEnd, iterations: c.smootherIterations, steps: s.steps.length, fixes: s.fixes.length, gpsAccepted: accepted, gpsDownweighted: weights.length - accepted, segments: s.segments.length, segmentsWithHeading: s.smoothed.segmentsWithHeading }],
  };
}

export function summarizeV4(s: FusionStateV4) {
  const reasons = { ...s.counters.reasons };
  let accepted = s.counters.gpsAccepted;
  let rejected = s.counters.gpsRejected;
  if (s.smoothed) {
    // replay: the smoother's robust weights decide which fixes counted
    delete reasons.INNOVATION_TOO_LARGE;
    const excluded = Object.values(reasons).reduce((a, b) => a + b, 0);
    accepted = s.smoothed.gpsAccepted;
    rejected = excluded + s.smoothed.gpsDownweighted;
    if (s.smoothed.gpsDownweighted) reasons.ROBUST_DOWNWEIGHTED = s.smoothed.gpsDownweighted;
  }
  return {
    gpsAccepted: accepted,
    gpsRejected: rejected,
    rejectReasons: reasons,
    maxRejectedInnovation: s.counters.maxRejectedInnovation,
    stationaryMs: s.counters.stationaryMs,
    reanchors: s.counters.reanchors,
    divergences: 0,
    motionGaps: s.counters.motionGaps,
    altimeterRebases: s.counters.altimeterRebases,
    stepsDetected: s.steps.length,
    stairSteps: s.steps.filter((p) => p.stairs).length,
    headingSegments: s.segments.length,
    headingSegmentsWithHeading: s.smoothed?.segmentsWithHeading ?? null,
    strideM: s.strideB >= 20 ? Math.round((s.strideA / s.strideB) * 100) / 100 : null,
    terrain: s.smoothed
      ? { versionId: s.terrain?.versionId ?? null, datumSource: s.smoothed.datumSource, contacts: s.smoothed.contacts, datumSigmaM: s.smoothed.datumSigma, driftRangeM: s.smoothed.driftRangeM, geoidSeparationM: s.terrain?.geoidSeparation ?? null }
      : null,
  };
}

export function describeEventV4(e: FusionEventV4) {
  const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  switch (e.type) {
    case 'gps':
      return { event: 'fusion.v4.gps', fields: { seq: e.seq, used: e.used, reason: e.reason, accuracy: r1(e.accuracy), innovation: r1(e.innovation) } };
    case 'heading':
      return { event: 'fusion.v4.heading', fields: { source: e.source, offset: r1(e.headingOffsetDeg), sigma: r1(e.sigmaDeg) } };
    case 'reanchor':
      return { event: 'fusion.v4.reanchor', fields: { shift: r1(e.shift) } };
    default:
      return { event: `fusion.v4.${e.type}`, fields: { ...e } };
  }
}

export { createFusionStateV4 };
