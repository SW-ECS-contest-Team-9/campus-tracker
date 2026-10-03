// fusion-v2.1 unit tests (no server / DB / iPhone).  npm test -w backend
import { buildTimeline } from '../src/modules/fusion/fusion.timeline.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareObservations, type Observation } from '../src/modules/fusion/fusion.timeline.js';
import { currentHeightV21, flushFusionV21, processObservationV21, type FusionEventV21 } from '../src/modules/fusion/fusion-v21.engine.js';
import { createFusionStateV21, type FusionStateV21 } from '../src/modules/fusion/fusion-state-v21.js';
import { fusionConfigV21 as cfg } from '../src/modules/fusion/fusion.config.js';
import type { FusedOutput } from '../src/modules/fusion/fusion.types.js';
import { localToWgs84 } from '../src/geo/local-to-wgs84.js';
import { DEG_TO_RAD, RAD_TO_DEG } from '../src/geo/angles.js';
import { validateFusion } from '../src/modules/fusion/fusion.validation.js';

const ORIGIN = { latitude: 37.2722, longitude: 126.978, height: 90 };
const T0 = Date.parse('2026-10-02T03:00:00.000Z');
let seq = 0;
const at = (s: number) => T0 + Math.round(s * 1000);

function gps(tS: number, x: number, y: number, acc: number, extra: Partial<Extract<Observation, { kind: 'gps' }>> = {}): Observation {
  const p = localToWgs84(ORIGIN, { x, y, z: 0 });
  return {
    kind: 'gps', t: at(tS), seq: ++seq, latitude: p.latitude, longitude: p.longitude,
    altitude: 66, ellipsoidalAltitude: 90, horizontalAccuracy: acc, verticalAccuracy: 50, speed: -1, course: -1, ...extra,
  };
}
const ped = (tS: number, distance: number, steps: number | null = null): Observation => ({ kind: 'pedometer', t: at(tS), seq: ++seq, distance, steps });
const baro = (tS: number, rel: number): Observation => ({ kind: 'altimeter', t: at(tS), seq: ++seq, relativeAltitude: rel });
const yawAt = (tS: number, deg: number, g = 0.3): Observation => ({ kind: 'motion', t: at(tS), seq: ++seq, yaw: deg * DEG_TO_RAD, ax: g, ay: 0, az: 0 });
function motion(t0: number, t1: number, rmsG: number, hz = 50): Observation[] {
  const out: Observation[] = [];
  for (let i = 0, t = t0; t < t1 - 1e-9; i++, t = t0 + i / hz) out.push({ kind: 'motion', t: at(t), seq: ++seq, yaw: 0, ax: i % 2 ? rmsG : -rmsG, ay: 0, az: 0 });
  return out;
}

interface Run {
  s: FusionStateV21;
  outputs: FusedOutput[];
  events: FusionEventV21[];
}
function feed(s: FusionStateV21, obs: Observation[], run: Run) {
  for (const o of [...obs].sort(compareObservations)) {
    const r = processObservationV21(s, o, cfg);
    run.outputs.push(...r.outputs);
    run.events.push(...r.events);
  }
}
function run(obs: Observation[], flush = false): Run {
  const s = createFusionStateV21();
  const result: Run = { s, outputs: [], events: [] };
  feed(s, obs, result);
  if (flush) {
    const r = flushFusionV21(s, cfg);
    result.outputs.push(...r.outputs);
    result.events.push(...r.events);
  }
  return result;
}
const decisions = (r: Run) => r.events.filter((e): e is Extract<FusionEventV21, { type: 'gps-decision' }> => e.type === 'gps-decision');
const headingDeg = (s: FusionStateV21) => (s.headingRad ?? NaN) * RAD_TO_DEG;

test('altimeter cumulative regression: 0, 0.1, 0.2, 0.3 -> Z +0.3 m (not +0.6 m)', () => {
  const r = run([gps(0, 0, 0, 4), baro(0.5, 0), baro(1.5, 0.1), baro(2.5, 0.2), baro(3.5, 0.3)]);
  assert.ok(Math.abs(currentHeightV21(r.s) - 90 - 0.3) < 1e-9, `z change = ${currentHeightV21(r.s) - 90}`);
});

test('pedometer cumulative regression: 100, 101, 102 -> 2 m', () => {
  const r = run([gps(0, 0, 0, 3, { speed: 1.4, course: 0 }), ...motion(0, 4, 0.3), ped(1, 100), ped(2, 101), ped(3, 102)]);
  assert.ok(Math.abs(r.s.y - 2) < 1e-9 && Math.abs(r.s.x) < 1e-9, `x=${r.s.x} y=${r.s.y}`);
});

test('no heading: pedometer distance does not move XY and the output says why', () => {
  const r = run([gps(0, 0, 0, 4), ...motion(0, 6, 0.3), ped(1, 0), ped(5, 6)], true);
  assert.equal(r.s.x, 0);
  assert.equal(r.s.y, 0);
  const o = r.outputs.find((x) => x.pdrApplied === false);
  assert.ok(o, 'an output records pdrApplied=false');
  assert.equal(o!.pdrRejectReason, 'NO_HEADING');
});

test('two-point GPS bootstrap: heading from the bearing between two usable fixes', () => {
  const r = run([gps(0, 0, 0, 8), ...motion(0, 16, 0.3), ped(1, 0), ped(14, 20), gps(15, 20, 0, 9)]);
  assert.equal(r.s.headingSource, 'GPS_TWO_POINT');
  assert.ok(Math.abs(headingDeg(r.s) - 90) < 1e-6, `heading=${headingDeg(r.s)}`);
});

test('two-point bootstrap ignores GPS scatter while standing (no pedometer progress)', () => {
  const r = run([gps(0, 0, 0, 20), ped(0.5, 3), ped(1, 3), ...motion(0, 12, 0.3), gps(10, 25, 0, 20)]);
  assert.equal(r.s.headingRad, undefined);
});

test('poor GPS (25 m) never causes a strong correction', () => {
  const r = run([gps(0, 0, 0, 4), ...motion(0, 3, 0.3), gps(2, 20, 0, 25)]);
  const last = decisions(r).at(-1)!;
  assert.equal(last.quality, 'POOR');
  assert.ok(Math.hypot(r.s.x, r.s.y) <= 0.21, `moved ${Math.hypot(r.s.x, r.s.y)} m (alpha 0.01)`);
});

test('GPS cluster re-anchor: PDR drifted 100 m, fixes agree on one area', () => {
  // heading North; pedometer says 100 m, but the person actually walked around near (0, 10)
  const obs: Observation[] = [gps(0, 0, 0, 3, { speed: 1.4, course: 0 }), ...motion(0, 80, 0.3)];
  for (let i = 1; i <= 60; i++) obs.push(ped(i, (i * 100) / 60));
  obs.push(gps(62, 2, 10, 18), gps(66, -3, 12, 16), gps(70, 1, 7, 20), gps(74, -1, 11, 17), gps(78, 0, 9, 18));
  const r = run(obs);
  assert.ok(r.events.some((e) => e.type === 'reanchor' && e.reason === 'GPS_CLUSTER'));
  assert.ok(Math.hypot(r.s.x, r.s.y - 10) < 40, `distance to cluster ${Math.hypot(r.s.x, r.s.y - 10)} m`);
});

test('GPS track re-anchor: consistent fast movement without steps (vehicle) is followed', () => {
  const obs: Observation[] = [gps(0, 0, 0, 15), ...motion(0, 40, 0.05)];
  for (let i = 1; i <= 15; i++) obs.push(gps(i * 2, i * 50, 0, 20, { speed: 25, course: 90 })); // 25 m/s East
  const r = run(obs);
  assert.ok(r.events.some((e) => e.type === 'reanchor' && e.reason === 'GPS_TRACK'));
  assert.ok(Math.hypot(r.s.x - 750, r.s.y) < 120, `x=${r.s.x}`);
});

test('indoor GPS scatter (no steps) does not create a track or cluster jump', () => {
  const offsets = [[18, -5], [-20, 10], [12, 22], [-15, -18], [22, 3], [-8, 20], [5, -24], [-22, -6], [16, 15], [-12, 8]];
  const obs: Observation[] = [gps(0, 0, 0, 12), ...motion(0, 70, 0.02)];
  offsets.forEach(([x, y], i) => obs.push(gps(5 + i * 6, x, y, 25)));
  const r = run(obs);
  assert.ok(!r.events.some((e) => e.type === 'reanchor'));
  assert.ok(Math.hypot(r.s.x, r.s.y) < 1, `moved ${Math.hypot(r.s.x, r.s.y)} m`);
});

test('divergence guard: 100 m walked can never become 4 km', () => {
  const s = createFusionStateV21();
  const r: Run = { s, outputs: [], events: [] };
  const obs: Observation[] = [gps(0, 0, 0, 4, { speed: 1.4, course: 0 }), ...motion(0, 72, 0.3)];
  for (let i = 1; i <= 70; i++) obs.push(ped(i, (i * 100) / 70));
  feed(s, obs.filter((o) => o.t <= at(70)), r);
  s.x += 4000; // simulate a corrupted state (e.g. a future bug)
  feed(s, [yawAt(71.5, 0)], r);
  assert.equal(s.counters.divergences, 1);
  assert.ok(Math.hypot(s.x, s.y) < 150, `state reset near evidence, at ${Math.hypot(s.x, s.y)} m`);
  assert.ok(r.events.some((e) => e.type === 'reanchor' && e.reason === 'DIVERGENCE'));
});

test('Z divergence: barometer range 3 m => fused Z stays within ~3 m (glitch and bad GPS heights ignored)', () => {
  const obs: Observation[] = [gps(0, 0, 0, 4)];
  for (let i = 0; i <= 30; i++) obs.push(baro(i + 0.5, (i / 30) * 3));
  obs.push(baro(15.7, 500)); // sensor glitch: +500 m in 0.2 s
  for (let i = 1; i <= 10; i++) obs.push(gps(i * 3, 0, 0, 4, { ellipsoidalAltitude: 90 + (i % 2 ? 300 : -300), verticalAccuracy: 60 }));
  const r = run(obs, true);
  const hs = r.outputs.map((o) => o.geomZ);
  const range = Math.max(...hs) - Math.min(...hs);
  assert.ok(range <= 3.5, `fused Z range ${range} m`);
  assert.ok(r.events.some((e) => e.type === 'altimeter-glitch'));
});

test('output throttling: 20 Hz motion for 5 s gives ~1 output/s, not one per sample', () => {
  const r = run([gps(0, 0, 0, 4), ...motion(0, 5, 0.3, 20)], true);
  assert.ok(r.outputs.length >= 4 && r.outputs.length <= 8, `outputs=${r.outputs.length}`);
});

test('stationary: GPS drift does not move XY', () => {
  const r = run([gps(0, 0, 0, 4), ...motion(0, 10, 0.01), gps(3, 10, 0, 8), gps(5, -8, 0, 8), gps(7, 15, 0, 8)]);
  assert.ok(Math.hypot(r.s.x, r.s.y) < 0.01);
  assert.ok(decisions(r).filter((d) => !d.used).every((d) => d.reason === 'STATIONARY_LOCK'));
});

test('yaw 179° -> -179° is a 2° turn; heading stays in radians', () => {
  const r = run([gps(0, 0, 0, 3, { speed: 1.4, course: 90 }), yawAt(1, 179), yawAt(1.02, -179)]);
  assert.ok(Math.abs(headingDeg(r.s) - 88) < 1e-6, `heading=${headingDeg(r.s)}`);
});

test('validation flags a 4 km displacement for 100 m of walking', () => {
  const tl: Observation[] = [gps(0, 0, 0, 5), ped(1, 0), ped(60, 100)];
  const pos = (x: number, y: number, height: number) => ({ ...localToWgs84(ORIGIN, { x, y, z: 0 }), height });
  const v = validateFusion(tl, [pos(0, 0, 90), pos(4000, 0, 90)]);
  assert.ok(v.warnings.some((w) => w.code === 'CRITICAL_DIVERGENCE'));
  const ok = validateFusion(tl, [pos(0, 0, 90), pos(80, 20, 92)]);
  assert.equal(ok.warnings.length, 0);
  const z = validateFusion([...tl, baro(1, 0), baro(30, 3)], [pos(0, 0, 90), pos(10, 0, 600)]);
  assert.ok(z.warnings.some((w) => w.code === 'CRITICAL_Z_DIVERGENCE'));
});

test('provisional start: no position from a 500 m fix; a clearly better fix replaces a poor start', () => {
  assert.equal(run([gps(0, 0, 0, 522), gps(20, 0, 0, 846), ...motion(0, 40, 0.02, 5)]).s.initialized, false);
  const r = run([gps(0, 0, 0, 45), ...motion(0, 40, 0.3, 5), gps(31, 0, 0, 45), gps(35, 300, 0, 12)]);
  assert.equal(r.s.initialized, true);
  assert.ok(Math.abs(r.s.x - 300) < 1e-6, `snapped to the better fix, x=${r.s.x}`);
});

test('F. altimeter restart (segment A 0 -> 2.5 m, segment B 0 -> 1.0 m): Z continues, no drop to 0', () => {
  const alt = (t: number, rel: number, segment: string): Observation => ({ kind: 'altimeter', t: at(t), seq: ++seq, relativeAltitude: rel, segment });
  const obs: Observation[] = [gps(0, 0, 0, 4)];
  [0, 0.5, 1, 1.5, 2, 2.5].forEach((v, i) => obs.push(alt(1 + i, v, 'A')));
  [0, 0.25, 0.5, 0.75, 1.0].forEach((v, i) => obs.push(alt(10 + i, v, 'B')));
  const r = run(obs, true);
  const hs = r.outputs.map((o) => o.geomZ - 90);
  for (let i = 1; i < hs.length; i++) assert.ok(hs[i] >= hs[i - 1] - 1e-9, `Z dropped: ${hs[i - 1]} -> ${hs[i]}`);
  assert.ok(Math.abs(currentHeightV21(r.s) - 90 - 3.5) < 1e-9, `total Z = 2.5 + 1.0, got ${currentHeightV21(r.s) - 90}`);
  assert.ok(r.events.some((e) => e.type === 'altimeter-rebase' && e.reason === 'SEGMENT_CHANGE'));
});

test('altimeter long gap without segment ids starts a new baseline', () => {
  const r = run([gps(0, 0, 0, 4), baro(1, 0), baro(2, 2), baro(100, 0), baro(101, 0.5)]);
  assert.ok(Math.abs(currentHeightV21(r.s) - 90 - 2.5) < 1e-9, `z=${currentHeightV21(r.s) - 90}`);
});

test('G. motion gap: yaw 10° then 10 s gap then 150° is not a 140° turn', () => {
  const r = run([gps(0, 0, 0, 3, { speed: 1.4, course: 90 }), yawAt(0.5, 10), yawAt(10.5, 150), yawAt(10.55, 151)]);
  assert.ok(Math.abs(((r.s.headingRad! * 180) / Math.PI) - 89) < 1e-6, `heading=${(r.s.headingRad! * 180) / Math.PI}`);
  assert.equal(r.s.motionGaps, 1);
});

test('motion segment change (CoreMotion restarted => new yaw reference) resets the yaw baseline', () => {
  const m = (t: number, deg: number, segment: string): Observation => ({ kind: 'motion', t: at(t), seq: ++seq, yaw: deg * DEG_TO_RAD, ax: 0.3, ay: 0, az: 0, segment });
  const r = run([gps(0, 0, 0, 3, { speed: 1.4, course: 90 }), m(0.5, 10, 'A'), m(0.55, 12, 'A'), m(0.6, -80, 'B'), m(0.65, -79, 'B')]);
  assert.ok(Math.abs(((r.s.headingRad! * 180) / Math.PI) - 87) < 1e-6, `heading=${(r.s.headingRad! * 180) / Math.PI}`);
});

test('H. delayed pedometer recovery: replay by timestamp counts each meter once', () => {
  // live 0..10 m (t 1-5), app in background t 5-20 (recovered later: cumulative 12..40 m), live again 42 m at t 21
  const live = [ped(1, 0), ped(3, 5), ped(5, 10), ped(21, 42)];
  const recovered = [ped(8, 12), ped(12, 20), ped(16, 30), ped(20, 40)];
  const base = [gps(0, 0, 0, 3, { speed: 1.4, course: 0 }), ...motion(0, 22, 0.3, 5)];
  const replay = run([...base, ...live, ...recovered]); // sorted by sensor timestamp
  assert.ok(Math.abs(replay.s.pedometerTotal - 42) < 1e-9, `walked ${replay.s.pedometerTotal} m`);
  assert.ok(Math.abs(replay.s.y - 42) < 1e-6, `y=${replay.s.y}`);
});

test('pedometer segment change (re-started with a new start date) is a new baseline, not a negative or double count', () => {
  const p = (t: number, d: number, segment: string): Observation => ({ kind: 'pedometer', t: at(t), seq: ++seq, distance: d, steps: null, segment });
  const r = run([gps(0, 0, 0, 3, { speed: 1.4, course: 0 }), ...motion(0, 12, 0.3, 5), p(1, 0, 'A'), p(5, 8, 'A'), p(7, 0, 'B'), p(11, 6, 'B')]);
  assert.ok(Math.abs(r.s.pedometerTotal - 14) < 1e-9, `walked ${r.s.pedometerTotal} m`);
});

test('interleaved 0 pedometer sample (158, 0, 158 in real uploads) is ignored: no phantom walk, no clamp', () => {
  const r = run([gps(0, 0, 0, 3, { speed: 1.4, course: 0 }), ...motion(0, 12, 0.3, 5),
    ped(1, 0, 0), ped(3, 2.5, 3), ped(5, 5, 6), ped(6, 0, 0), ped(7, 5, 6), ped(9, 7.5, 9)]);
  assert.ok(Math.abs(r.s.pedometerTotal - 7.5) < 1e-9, `walked ${r.s.pedometerTotal} m`);
  assert.ok(Math.abs(r.s.y - 7.5) < 1e-6 && Math.abs(r.s.x) < 1e-6, `x=${r.s.x} y=${r.s.y}`);
  const reasons = r.events.flatMap((e) => (e.type === 'pedometer' ? [e.reason] : []));
  assert.ok(reasons.includes('BELOW_HIGH_WATER'));
  assert.ok(!reasons.includes('OVERSPEED_CLAMPED') && !reasons.includes('NEGATIVE_DELTA'), reasons.join(','));
});

test('pedometer counter restarted without a segment id: new baseline once it keeps counting up', () => {
  const r = run([gps(0, 0, 0, 3, { speed: 1.4, course: 0 }), ...motion(0, 16, 0.3, 5),
    ped(1, 0, 0), ped(5, 8, 10), ped(7, 0, 0), ped(9, 2, 3), ped(11, 4, 6), ped(13, 6, 9)]);
  assert.ok(Math.abs(r.s.pedometerTotal - 10) < 1e-9, `walked ${r.s.pedometerTotal} m`); // 8 + (6 - 4)
  assert.ok(r.events.some((e) => e.type === 'pedometer' && e.reason === 'COUNTER_RESTARTED'));
});

test('vertical gate: a GPS height 43 m off (vacc 3 m) does not pull Z when the barometer is flat', () => {
  const obs: Observation[] = [gps(0, 0, 0, 9, { ellipsoidalAltitude: 162.6, verticalAccuracy: 7 })];
  for (let i = 0; i < 20; i++) obs.push(baro(i + 0.5, 0.1));
  for (let i = 1; i <= 4; i++) obs.push(gps(i * 2, 0, 0, 20, { ellipsoidalAltitude: 124.6, verticalAccuracy: 3 }));
  const r = run(obs, true);
  assert.ok(Math.abs(currentHeightV21(r.s) - 162.7) < 1, `z=${currentHeightV21(r.s)}`);
  assert.ok(r.events.filter((e) => e.type === 'vertical-rejected').length === 4);
});

test('vertical gate: several consistent good fixes at another height move the datum', () => {
  const obs: Observation[] = [gps(0, 0, 0, 9, { ellipsoidalAltitude: 100, verticalAccuracy: 7 })];
  for (let i = 1; i <= 6; i++) obs.push(gps(i * 2, 0, 0, 8, { ellipsoidalAltitude: 130 + (i % 2), verticalAccuracy: 4 }));
  const r = run(obs, true);
  assert.ok(r.events.some((e) => e.type === 'vertical-reanchor'));
  assert.ok(Math.abs(currentHeightV21(r.s) - 130.5) < 1.5, `z=${currentHeightV21(r.s)}`);
});

test('pre-session cached GPS fix is rejected, never used as the start position', () => {
  const tl = buildTimeline(
    {
      locations: [
        { sequence: 1, timestamp: '2026-10-02T02:24:47.000Z', latitude: 37.6, longitude: 127.1, horizontalAccuracy: 5 }, // 27 min old cache
        { sequence: 2, timestamp: '2026-10-02T02:51:50.000Z', latitude: 37.5, longitude: 127.0, horizontalAccuracy: 8 },
      ],
      motion: [],
      altimeter: [],
      pedometer: [],
    },
    { sessionStartedAt: '2026-10-02T02:51:43.000Z' },
  );
  assert.deepEqual(tl.map((o) => o.kind === 'gps' && !!o.preSession), [true, false]);
  const r = run(tl, true);
  const d = r.events.filter((e) => e.type === 'gps-decision');
  assert.equal(d[0].type === 'gps-decision' && d[0].reason, 'PRE_SESSION');
  assert.ok(Math.abs(r.s.origin!.latitude - 37.5) < 1e-9, 'origin must come from the in-session fix');
});

test('determinism: realtime chunks == one-shot replay', () => {
  const obs: Observation[] = [gps(0, 0, 0, 6), ...motion(0, 30, 0.25)];
  for (let i = 0; i <= 30; i++) obs.push(ped(i, i * 1.2, i * 2), baro(i + 0.5, i * 0.05), gps(i + 0.3, i * 1.2 + (i % 3), (i % 4) * 2, 6 + (i % 5) * 6));
  obs.push(gps(12.6, 300, 0, 9));
  const sorted = [...obs].sort(compareObservations);
  const whole = run(sorted, true);
  const s = createFusionStateV21();
  const outs: FusedOutput[] = [];
  for (let i = 0; i < sorted.length; i += 37) for (const o of sorted.slice(i, i + 37)) outs.push(...processObservationV21(s, o, cfg).outputs);
  outs.push(...flushFusionV21(s, cfg).outputs);
  assert.deepEqual(outs, whole.outputs);
});
