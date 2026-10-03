// FusionEngine unit tests: no server, DB or iPhone needed.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, compareObservations, gpsWeight, classifyGps, processObservation, runFusion, type Observation } from '../src/modules/fusion/fusion.engine.js';
import { createFusionState, type FusionState } from '../src/modules/fusion/fusion-state.js';
import { fusionConfigV1 as cfg } from '../src/modules/fusion/fusion.config.js';
import { wgs84ToLocal } from '../src/geo/wgs84-to-local.js';
import { localToWgs84 } from '../src/geo/local-to-wgs84.js';
import { normalizeAngleRad, DEG_TO_RAD, RAD_TO_DEG } from '../src/geo/angles.js';

const ORIGIN = { latitude: 37.2722, longitude: 126.978, height: 90 };
const T0 = Date.parse('2026-10-02T03:00:00.000Z');
let seq = 0;

/** GPS fix at local (x east, y north) meters from ORIGIN. */
function gps(tS: number, x: number, y: number, hacc: number, extra: Partial<Extract<Observation, { kind: 'gps' }>> = {}): Observation {
  const p = localToWgs84(ORIGIN, { x, y, z: 0 });
  return {
    kind: 'gps', t: T0 + tS * 1000, seq: ++seq, latitude: p.latitude, longitude: p.longitude,
    altitude: 66, ellipsoidalAltitude: 90, horizontalAccuracy: hacc, verticalAccuracy: 50, speed: -1, course: -1, ...extra,
  };
}
const ped = (tS: number, distance: number): Observation => ({ kind: 'pedometer', t: T0 + tS * 1000, seq: ++seq, distance, steps: null });
const yaw = (tS: number, deg: number): Observation => ({ kind: 'motion', t: T0 + tS * 1000, seq: ++seq, yaw: deg * DEG_TO_RAD, ax: 0, ay: 0, az: 0 });
const baro = (tS: number, rel: number): Observation => ({ kind: 'altimeter', t: T0 + tS * 1000, seq: ++seq, relativeAltitude: rel });
const headingDeg = (s: FusionState) => (s.headingRad ?? NaN) * RAD_TO_DEG;
const run = (obs: Observation[], s = createFusionState()) => ({ s, r: runFusion(s, obs, cfg, false) });
/** Anchor at origin with a trusted course (degrees). */
const anchorWithCourse = (course: number) => gps(0, 0, 0, 3, { speed: 1.2, course });

test('geo: local <-> WGS84 round trip and axis convention', () => {
  const p = localToWgs84(ORIGIN, { x: 120, y: -80, z: 4 });
  const back = wgs84ToLocal(ORIGIN, p.latitude, p.longitude, p.height);
  assert.ok(Math.abs(back.x - 120) < 1e-6 && Math.abs(back.y + 80) < 1e-6 && Math.abs(back.z - 4) < 1e-9);
  assert.ok(p.longitude > ORIGIN.longitude, '+X is East');
  assert.ok(p.latitude < ORIGIN.latitude, '-Y is South');
});

test('1. accurate GPS stream: fused stays near GPS', () => {
  const obs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => gps(i, i * 1.4, 0, 3));
  const { s } = run(obs);
  assert.ok(Math.abs(s.x - 14) < 1.0, `x=${s.x}`);
  assert.ok(Math.abs(s.y) < 1e-6);
  assert.ok(s.horizontalConfidence > 0.8);
});

test('2. GPS accuracy > 20 m: correction weight is very low', () => {
  assert.equal(classifyGps(25, cfg), 'VERY_POOR');
  assert.equal(gpsWeight('VERY_POOR', cfg), 0.05);
  const { s } = run([gps(0, 0, 0, 3), gps(1, 50, 0, 25)]);
  assert.ok(Math.abs(s.x - 2.5) < 1e-6, `moved only 5% of 50 m, x=${s.x}`);
});

test('3. anchor + pedometer 10 m: moves ~10 m along heading (North)', () => {
  const { s } = run([anchorWithCourse(0), ped(1, 0), ped(8, 10)]);
  assert.ok(Math.abs(s.y - 10) < 1e-6 && Math.abs(s.x) < 1e-6, `x=${s.x} y=${s.y}`);
});

test('4. heading 90°: pedometer moves East', () => {
  const { s } = run([anchorWithCourse(90), ped(1, 0), ped(8, 10)]);
  assert.ok(Math.abs(s.x - 10) < 1e-6 && Math.abs(s.y) < 1e-6, `x=${s.x} y=${s.y}`);
});

test('5. yaw +90° changes heading by ~90° (CoreMotion CCW -> compass CW)', () => {
  const obs: Observation[] = [anchorWithCourse(0)];
  for (let i = 0; i <= 18; i++) obs.push(yaw(1 + i * 0.05, i * 5)); // 0..90° in 5° steps
  const { s } = run(obs);
  const change = normalizeAngleRad(s.headingRad! - 0) * RAD_TO_DEG;
  assert.ok(Math.abs(Math.abs(change) - 90) < 1e-6, `change=${change}`);
  assert.ok(Math.abs(headingDeg(s) - 270) < 1e-6, 'CCW yaw turns the compass heading West');
});

test('6. barometer +3 m: fused z ~ +3 m', () => {
  const { s } = run([gps(0, 0, 0, 3), baro(1, 0), baro(2, 1.5), baro(3, 3)]);
  assert.ok(Math.abs(s.z - 3) < 1e-6, `z=${s.z}`);
});

test('7. yaw 179° -> -179° is a 2° turn, not 358°', () => {
  const { s, r } = run([anchorWithCourse(90), yaw(1, 179), yaw(1.05, -179)]);
  assert.ok(Math.abs(headingDeg(s) - 88) < 1e-6, `heading=${headingDeg(s)}`);
  assert.ok(!r.events.some((e) => e.type === 'yaw-glitch'));
});

test('8. new good GPS pulls accumulated drift back toward GPS', () => {
  // PDR says 20 m North, a good fix says 10 m North -> 70 % of the way back
  const { s } = run([anchorWithCourse(0), ped(1, 0), ped(10, 20), gps(11, 0, 10, 3)]);
  assert.ok(Math.abs(s.y - 13) < 1e-6, `y=${s.y}`);
});

test('pedometer before the first GPS creates no world position', () => {
  const { s, r } = run([ped(0, 0), ped(5, 7), yaw(5, 10)]);
  assert.equal(s.initialized, false);
  assert.equal(r.outputs.length, 0);
});

test('negative or implausible pedometer deltas are ignored / clamped', () => {
  const { s, r } = run([anchorWithCourse(0), ped(1, 10), ped(2, 5), ped(3, 500)]);
  assert.ok(r.events.some((e) => e.type === 'pedometer-ignored'));
  assert.ok(Math.abs(s.y - cfg.maxWalkingSpeed * 1) < 1e-6, `clamped to max walking speed, y=${s.y}`);
});

test('invalid GPS (accuracy < 0) is excluded from fusion', () => {
  const { s, r } = run([gps(0, 0, 0, -1)]);
  assert.equal(s.initialized, false);
  assert.ok(r.events.some((e) => e.type === 'gps-rejected'));
});

test('heading from displacement of trusted fixes when course is invalid', () => {
  const { s } = run([gps(0, 0, 0, 4), gps(5, 10, 0, 4)]);
  assert.ok(Math.abs(headingDeg(s) - 90) < 1e-6, `heading=${headingDeg(s)}`);
});

test('timeline: sorted by time, same timestamp = motion, pedometer, altimeter, GPS', () => {
  const ts = new Date(T0).toISOString();
  const tl = buildTimeline({
    locations: [{ sequence: 1, timestamp: ts, latitude: 37, longitude: 127, horizontalAccuracy: 5 }],
    motion: [{ sequence: 2, timestamp: ts, yaw: 0 }, { sequence: 1, timestamp: ts, yaw: 0 }],
    altimeter: [{ sequence: 1, timestamp: ts, relativeAltitude: 0 }],
    pedometer: [{ timestamp: new Date(T0 - 1).toISOString(), distance: 0 }],
  });
  assert.deepEqual(tl.map((o) => `${o.kind}${o.seq}`), ['pedometer0', 'motion1', 'motion2', 'altimeter1', 'gps1']);
});

test('determinism: realtime chunks == one-shot replay; outputs ~1 Hz', () => {
  const obs: Observation[] = [anchorWithCourse(45)];
  for (let i = 0; i < 600; i++) obs.push(yaw(0.02 + i * 0.02, Math.sin(i / 50) * 30)); // 12 s of 50 Hz motion
  for (let i = 0; i <= 12; i++) obs.push(ped(i, i * 1.3), baro(i + 0.5, i * 0.1));
  for (let i = 1; i <= 12; i++) obs.push(gps(i, i, i, 12));
  const sorted = [...obs].sort(compareObservations);

  const whole = runFusion(createFusionState(), sorted, cfg);
  const chunked = createFusionState();
  const outs = [];
  for (let i = 0; i < sorted.length; i += 37) for (const o of sorted.slice(i, i + 37)) outs.push(...processObservation(chunked, o, cfg).outputs);
  outs.push(...runFusion(chunked, [], cfg).outputs);
  assert.deepEqual(outs, whole.outputs);
  assert.ok(whole.outputs.length >= 11 && whole.outputs.length <= 14, `outputs=${whole.outputs.length}`);
  assert.deepEqual(whole.outputs.map((o) => o.fusionSequence), whole.outputs.map((_, i) => i + 1));
});

test('late observation (older than state) is skipped and counted', () => {
  const s = createFusionState();
  processObservation(s, gps(5, 0, 0, 3), cfg);
  const r = processObservation(s, ped(2, 3), cfg);
  assert.equal(s.skippedLateObservations, 1);
  assert.equal(r.events[0].type, 'late-observation');
});
