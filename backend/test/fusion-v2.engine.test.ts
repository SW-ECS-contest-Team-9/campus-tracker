// fusion-v2 unit tests (no server / DB / iPhone).  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareObservations, type Observation } from '../src/modules/fusion/fusion.timeline.js';
import { processObservationV2, flushFusionV2, type FusionEventV2 } from '../src/modules/fusion/fusion-v2.engine.js';
import { createFusionStateV2, type FusionStateV2 } from '../src/modules/fusion/fusion-state-v2.js';
import { fusionConfigV2 as cfg } from '../src/modules/fusion/fusion.config.js';
import type { FusedOutput } from '../src/modules/fusion/fusion.types.js';
import { localToWgs84 } from '../src/geo/local-to-wgs84.js';
import { DEG_TO_RAD, RAD_TO_DEG, normalizeAngleRad } from '../src/geo/angles.js';

const ORIGIN = { latitude: 37.2722, longitude: 126.978, height: 90 };
const T0 = Date.parse('2026-10-02T03:00:00.000Z');
let seq = 0;
const at = (s: number) => T0 + Math.round(s * 1000);

function gps(tS: number, x: number, y: number, hacc: number, extra: Partial<Extract<Observation, { kind: 'gps' }>> = {}): Observation {
  const p = localToWgs84(ORIGIN, { x, y, z: 0 });
  return {
    kind: 'gps', t: at(tS), seq: ++seq, latitude: p.latitude, longitude: p.longitude,
    altitude: 66, ellipsoidalAltitude: 90, horizontalAccuracy: hacc, verticalAccuracy: 50, speed: -1, course: -1, ...extra,
  };
}
const ped = (tS: number, distance: number, steps: number | null = null): Observation => ({ kind: 'pedometer', t: at(tS), seq: ++seq, distance, steps });
const baro = (tS: number, rel: number): Observation => ({ kind: 'altimeter', t: at(tS), seq: ++seq, relativeAltitude: rel });
const yawAt = (tS: number, deg: number, rmsG = 0.01): Observation => ({ kind: 'motion', t: at(tS), seq: ++seq, yaw: deg * DEG_TO_RAD, ax: rmsG, ay: 0, az: 0 });
/** Motion at `hz` between t0..t1 with userAcceleration RMS = rmsG (alternating sign), constant yaw. */
function motion(t0: number, t1: number, rmsG: number, yawDeg = 0, hz = 50): Observation[] {
  const out: Observation[] = [];
  for (let i = 0, t = t0; t < t1 - 1e-9; i++, t = t0 + i / hz) {
    out.push({ kind: 'motion', t: at(t), seq: ++seq, yaw: yawDeg * DEG_TO_RAD, ax: i % 2 ? rmsG : -rmsG, ay: 0, az: 0 });
  }
  return out;
}

interface Run {
  s: FusionStateV2;
  outputs: FusedOutput[];
  events: FusionEventV2[];
}
function run(obs: Observation[], flush = false): Run {
  const s = createFusionStateV2();
  const outputs: FusedOutput[] = [];
  const events: FusionEventV2[] = [];
  for (const o of [...obs].sort(compareObservations)) {
    const r = processObservationV2(s, o, cfg);
    outputs.push(...r.outputs);
    events.push(...r.events);
  }
  if (flush) {
    const r = flushFusionV2(s, cfg);
    outputs.push(...r.outputs);
    events.push(...r.events);
  }
  return { s, outputs, events };
}
const decisions = (r: Run) => r.events.filter((e): e is Extract<FusionEventV2, { type: 'gps-decision' }> => e.type === 'gps-decision');
const headingDeg = (s: FusionStateV2) => (s.headingRad ?? NaN) * RAD_TO_DEG;
const anchorEast = (tS = 0) => gps(tS, 0, 0, 3, { speed: 1.4, course: 90 });
const anchorNorth = (tS = 0) => gps(tS, 0, 0, 3, { speed: 1.4, course: 0 });

test('A. stationary GPS drift: fused XY stays put', () => {
  const r = run([
    gps(0, 0, 0, 4),
    ...motion(0, 10, 0.01), // phone at rest
    gps(3, 10, 0, 4),
    gps(5, -8, 0, 4),
    gps(7, 15, 0, 4),
  ]);
  assert.equal(r.s.stationary, true);
  assert.ok(Math.hypot(r.s.x, r.s.y) < 0.01, `moved ${Math.hypot(r.s.x, r.s.y)} m`);
  const rejected = decisions(r).filter((d) => !d.used);
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((d) => d.reason === 'STATIONARY_LOCK'));
  assert.ok(r.outputs.some((o) => o.source === 'STATIONARY_HOLD' && o.stationary === true));
});

test('B. good GPS while walking: fused follows the GPS track', () => {
  const obs: Observation[] = [...motion(0, 20, 0.3, 0)];
  for (let i = 0; i <= 20; i++) {
    obs.push(gps(i, i * 1.4, 0, 3, { speed: 1.4, course: 90 }));
    obs.push(ped(i, i * 1.4, i * 2));
  }
  const r = run(obs);
  assert.ok(Math.abs(r.s.x - 28) < 1.5 && Math.abs(r.s.y) < 1.5, `x=${r.s.x} y=${r.s.y}`);
  const d = decisions(r);
  assert.ok(d.filter((x) => x.used).length / d.length > 0.9);
  assert.equal(r.s.stationary, false);
});

test('C. GPS accuracy 25 m: not used for XY (raw stays raw)', () => {
  const r = run([gps(0, 0, 0, 4), ...motion(0, 3, 0.3), gps(2, 20, 0, 25)]);
  const last = decisions(r).at(-1)!;
  assert.equal(last.used, false);
  assert.equal(last.reason, 'POOR_ACCURACY');
  assert.equal(r.s.x, 0);
});

test('D. pedometer cumulative 100, 101, 102 m moves 2 m (not 203 m)', () => {
  const r = run([anchorNorth(0), ...motion(0, 4, 0.3), ped(1, 100), ped(2, 101), ped(3, 102)]);
  assert.ok(Math.abs(r.s.y - 2) < 1e-6 && Math.abs(r.s.x) < 1e-6, `x=${r.s.x} y=${r.s.y}`);
});

test('E. yaw units: radians internally, degrees only for output', () => {
  const r = run([anchorNorth(0), ...motion(0, 1, 0.3, 0), ...[0, 15, 30, 45, 60, 75, 90].map((d, i) => yawAt(1 + i * 0.05, d, 0.3))]);
  const change = normalizeAngleRad(r.s.headingRad! - 0) * RAD_TO_DEG;
  assert.ok(Math.abs(Math.abs(change) - 90) < 1e-6, `change=${change}`);
  assert.ok(Math.abs(r.s.headingRad! - (3 * Math.PI) / 2) < 1e-9, 'stored in radians (270° = 3π/2)');
  const out = run([anchorEast(0), ...motion(0, 2.5, 0.3, 0)], true).outputs.at(-1)!;
  assert.ok(Math.abs(out.headingDegrees! - 90) < 1e-9, 'output heading in degrees');
});

test('F. yaw 179° -> -179° is a 2° turn', () => {
  const r = run([anchorEast(0), yawAt(1, 179, 0.3), yawAt(1.02, -179, 0.3)]);
  assert.ok(Math.abs(headingDeg(r.s) - 88) < 1e-6, `heading=${headingDeg(r.s)}`);
  assert.ok(!r.events.some((e) => e.type === 'yaw-glitch'));
});

test('G. GPS course 90° with enough speed and accuracy anchors heading East', () => {
  const r = run([anchorEast(0), ...motion(0, 9, 0.3), ped(1, 0), ped(8, 10)]);
  assert.equal(r.s.headingSource, 'GPS_COURSE');
  assert.ok(Math.abs(headingDeg(r.s) - 90) < 1e-6);
  assert.ok(Math.abs(r.s.x - 10) < 1e-6 && Math.abs(r.s.y) < 1e-6, `x=${r.s.x} y=${r.s.y}`);
});

test('H. 50 m GPS jump within 1 s is rejected (PHYSICAL_JUMP)', () => {
  const r = run([gps(0, 0, 0, 3), ...motion(0, 2, 0.3), gps(1, 50, 0, 3)]);
  const last = decisions(r).at(-1)!;
  assert.equal(last.reason, 'PHYSICAL_JUMP');
  assert.equal(r.s.x, 0);
});

test('I. barometer relativeAltitude 0, 1, 2, 3 raises Z by ~3 m', () => {
  const r = run([gps(0, 0, 0, 3), baro(1, 0), baro(2, 1), baro(3, 2), baro(4, 3)]);
  assert.ok(Math.abs(r.s.z - 3) < 1e-6, `z=${r.s.z}`);
});

test('J. output throttling: 100 motion samples at 20 Hz give ~1 output/s, not one per sample', () => {
  const r = run([gps(0, 0, 0, 3), ...motion(0, 5, 0.3, 0, 20)], true);
  assert.ok(r.outputs.length >= 4 && r.outputs.length <= 6, `outputs=${r.outputs.length}`);
});

test('innovation gate: a good fix far from the predicted position is rejected', () => {
  // PDR (heading North) predicts ~14 m North; a 3 m fix says 14 m East: innovation ≈ 20 m
  const r = run([anchorNorth(0), ...motion(0, 11, 0.3), ped(0.5, 0), ped(10, 14), gps(10.5, 14, 0, 3)]);
  const last = decisions(r).at(-1)!;
  assert.equal(last.reason, 'INNOVATION_TOO_LARGE');
  assert.ok(last.innovation! > last.allowed!);
});

test('recovery: repeated consistent rejections of good fixes re-anchor to GPS', () => {
  const obs: Observation[] = [anchorNorth(0), ...motion(0, 17, 0.3), ped(0.5, 0), ped(10, 14)];
  for (let i = 0; i < 6; i++) obs.push(gps(10.5 + i, 14 + i, 0, 3)); // walking East, PDR thought North
  const r = run(obs, true);
  assert.ok(r.events.some((e) => e.type === 'gps-decision' && e.mode === 'reanchor'));
  assert.ok(r.outputs.some((o) => o.source === 'GPS_REANCHOR'));
  assert.ok(Math.hypot(r.s.x - 19, r.s.y) < 1.5, `x=${r.s.x} y=${r.s.y}`);
});

test('stable anchor: tight cluster of excellent fixes slowly corrects a stationary user', () => {
  const r = run([gps(0, 0, 0, 4), ...motion(0, 12, 0.01), gps(4, 6, 0, 3), gps(5, 6.5, 0, 3), gps(6, 5.5, 0, 3), gps(7, 6, 0.5, 3)]);
  const used = decisions(r).filter((d) => d.mode === 'stable-anchor');
  assert.ok(used.length >= 1);
  assert.ok(r.s.x > 0.5 && r.s.x < 6, `slow pull, x=${r.s.x}`);
});

test('walking without a trusted heading does not move XY but grows uncertainty', () => {
  const r = run([gps(0, 0, 0, 4), ...motion(0, 6, 0.3), ped(1, 0), ped(5, 6)]);
  assert.equal(r.s.x, 0);
  assert.equal(r.s.y, 0);
  assert.ok(r.s.horizontalUncertainty > 4 + 5.9, `u=${r.s.horizontalUncertainty}`);
});

test('initialization: poor-only GPS initializes provisionally after the grace period', () => {
  const obs = [gps(0, 0, 0, 40), gps(10, 3, 0, 22), gps(20, 1, 0, 30), gps(31, 2, 0, 25)];
  const r = run(obs);
  assert.equal(r.s.initialized, true);
  assert.equal(r.s.provisionalInit, true);
  assert.equal(r.s.horizontalUncertainty, 22, 'best fix (22 m) became the origin');
  assert.ok(!run(obs.slice(0, 3)).s.initialized, 'not before the grace period');
  const single = run([gps(0, 0, 0, 38), ...motion(0, 35, 0.01, 0, 5)]);
  assert.equal(single.s.initialized, true, 'a single poor fix initializes once the grace period passes (any sensor)');
});

test('determinism: realtime chunks == one-shot replay', () => {
  const obs: Observation[] = [anchorEast(0), ...motion(0, 12, 0.25)];
  for (let i = 0; i <= 12; i++) obs.push(ped(i, i * 1.3, i * 2), baro(i + 0.5, i * 0.1), gps(i + 0.3, i * 1.3 + (i % 3) - 1, (i % 2) * 2, 4 + (i % 4) * 4, { speed: 1.3, course: 90 }));
  obs.push(gps(6.6, 80, 0, 3)); // jump
  const sorted = [...obs].sort(compareObservations);
  const whole = run(sorted, true);
  const s = createFusionStateV2();
  const outs: FusedOutput[] = [];
  for (let i = 0; i < sorted.length; i += 41) for (const o of sorted.slice(i, i + 41)) outs.push(...processObservationV2(s, o, cfg).outputs);
  outs.push(...flushFusionV2(s, cfg).outputs);
  assert.deepEqual(outs, whole.outputs);
  assert.ok(decisions(whole).some((d) => d.reason === 'PHYSICAL_JUMP'));
});
