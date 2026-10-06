// Bundle 1 of docs/MOBILITY_MAP_PLAN.md: resampling, passes, canonical path, corridor, validation, qc-v1,
// AS_RECEIVED replay — on synthetic data with known ground truth (no DB).  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { along, pathLength, reversed, rng, syntheticWalk, zoneBias, type BiasZone } from '../src/sim/synthetic.js';
import { resampleTrack, reverseStations, type TrackPoint } from '../src/modules/trajectory/resample.js';
import { extractPasses } from '../src/modules/trajectory/passes.js';
import { project } from '../src/modules/trajectory/geometry.js';
import { buildCanonical, leaveOneOut, type PassInput } from '../src/modules/pathfusion/pathfusion-v1.js';
import { qcLocations } from '../src/modules/qc/qc-v1.js';
import { buildTimeline } from '../src/modules/fusion/fusion.timeline.js';
import { FUSION_ALGORITHMS } from '../src/modules/fusion/fusion.algorithms.js';
import { replayAsReceived, replayInMemory } from '../src/modules/fusion/fusion.pipeline.js';
import { fromCampus } from '../src/geo/campus-frame.js';

const ROUTE = [{ x: -60, y: -20 }, { x: 0, y: -20 }, { x: 40, y: 10 }, { x: 80, y: 10 }];
const T0 = Date.parse('2026-10-04T01:00:00Z');

/** A fused-like pass: truth + per-pass correlated error (+ shared zone bias), 1 Hz, at `speed`. */
function pass(seed: number, opts: { speed?: number; sigma?: number; zones?: BiasZone[]; offset?: { x: number; y: number }; path?: typeof ROUTE; h?: number } = {}): TrackPoint[] {
  const r = rng(seed);
  const path = opts.path ?? ROUTE;
  const L = pathLength(path);
  const speed = opts.speed ?? 1.3;
  const sigma = opts.sigma ?? 1.5;
  let cx = 0, cy = 0;
  const pts: TrackPoint[] = [];
  for (let t = 0; t * speed <= L; t++) {
    const p = along(path, t * speed);
    const a = Math.exp(-1 / 20);
    cx = a * cx + Math.sqrt(1 - a * a) * sigma * r.n();
    cy = a * cy + Math.sqrt(1 - a * a) * sigma * r.n();
    const b = zoneBias(opts.zones ?? [], p.x, p.y);
    pts.push({ t: T0 + seed * 1e6 + t * 1000, x: p.x + cx + b.x + (opts.offset?.x ?? 0), y: p.y + cy + b.y + (opts.offset?.y ?? 0), h: (opts.h ?? 134) + 0.3 * r.n(), sigmaH: 3 });
  }
  return pts;
}
const stationsOf = (pts: TrackPoint[]) => resampleTrack(pts).stations;
const distToRoute = (x: number, y: number) => project({ x, y }, ROUTE).d;
const meanErr = (pts: { x: number; y: number }[]) => pts.reduce((a, p) => a + distToRoute(p.x, p.y), 0) / pts.length;

test('resampling: passes at different speeds become comparable 1 m stations', () => {
  const slow = resampleTrack(pass(1, { speed: 0.8, sigma: 0.01 }));
  const fast = resampleTrack(pass(2, { speed: 1.5, sigma: 0.01 }));
  const L = pathLength(ROUTE);
  for (const r of [slow, fast]) assert.ok(Math.abs(r.stations.length - (Math.floor(r.lengthM) + 1)) <= 1 && Math.abs(r.lengthM - L) < 3, `${r.stations.length} / ${r.lengthM}`);
  const n = Math.min(slow.stations.length, fast.stations.length) - 2;
  for (let i = 0; i < n; i += 10) assert.ok(Math.hypot(slow.stations[i].x - fast.stations[i].x, slow.stations[i].y - fast.stations[i].y) < 1.5);
});

test('resampling: a time gap splits pieces and is not interpolated', () => {
  const pts = pass(3, { sigma: 0.01 });
  for (let i = 40; i < pts.length; i++) pts[i] = { ...pts[i], t: pts[i].t + 60_000 };
  const r = resampleTrack(pts);
  assert.equal(r.pieces, 2);
});

test('pass extraction: a round trip gives A→B and B→A passes', () => {
  const go = pass(4, { sigma: 0.5 });
  const back = pass(5, { sigma: 0.5, path: reversed(ROUTE) }).map((p) => ({ ...p, t: p.t + 1e7 }));
  const passes = extractPasses([...go, ...back], { a: ROUTE[0], b: ROUTE.at(-1)!, radiusM: 15 });
  assert.deepEqual(passes.map((p) => p.direction), ['AB', 'BA']);
});

test('canonical: mixed directions give the same path as one direction; a different path is rejected', () => {
  const ab = [11, 12, 13, 14, 15, 16].map((s) => ({ id: `ab${s}`, stations: stationsOf(pass(s)) }));
  const mixed: PassInput[] = [
    ...ab.slice(0, 3),
    ...[21, 22, 23].map((s) => ({ id: `ba${s}`, stations: reverseStations(stationsOf(pass(s))) })),
    { id: 'other', stations: stationsOf(pass(30, { offset: { x: 0, y: 30 } })) },
  ];
  const a = buildCanonical(ab);
  const m = buildCanonical(mixed);
  assert.deepEqual(m.passes.filter((p) => p.flipped).map((p) => p.id).sort(), ['ba21', 'ba22', 'ba23']);
  assert.ok(m.passes.find((p) => p.id === 'other')!.reasons.includes('DIFFERENT_PATH'));
  assert.ok(Math.abs(meanErr(a.points) - meanErr(m.points)) < 0.5, `${meanErr(a.points)} vs ${meanErr(m.points)}`);
});

test('canonical: independent errors shrink with 5 passes; a bias shared by every pass stays', () => {
  const passes = [41, 42, 43, 44, 45].map((s) => ({ id: String(s), stations: stationsOf(pass(s, { sigma: 3 })) }));
  const single = passes.reduce((a, p) => a + meanErr(p.stations), 0) / passes.length;
  const c = buildCanonical(passes);
  assert.ok(meanErr(c.points) <= 0.7 * single, `canonical ${meanErr(c.points).toFixed(2)} vs pass ${single.toFixed(2)}`);
  const zone: BiasZone = { center: { x: 20, y: -5 }, radiusM: 15, biasM: { x: 0, y: 6 } };
  const biased = buildCanonical([41, 42, 43, 44, 45].map((s) => ({ id: String(s), stations: stationsOf(pass(s, { sigma: 1, zones: [zone] })) })));
  const near = biased.points.filter((p) => Math.hypot(p.x - 20, p.y + 5) < 8);
  assert.ok(near.length && near.every((p) => distToRoute(p.x, p.y) > 3), 'the shared bias is (correctly) not removed');
});

test('canonical: two passes 20 m off are excluded (RUN_OUTLIER) and barely move the path', () => {
  const clean = [51, 52, 53, 54, 55].map((s) => ({ id: String(s), stations: stationsOf(pass(s)) }));
  const off = [56, 57].map((s) => ({ id: `off${s}`, stations: stationsOf(pass(s, { offset: { x: 0, y: 12 } })) }));
  const a = buildCanonical(clean);
  const b = buildCanonical([...clean, ...off]);
  for (const id of ['off56', 'off57']) assert.equal(b.passes.find((p) => p.id === id)!.status, 'REJECTED');
  const shift = Math.max(...a.points.slice(5, -5).map((p) => project(p, b.points).d));
  assert.ok(shift < 1, `max shift ${shift.toFixed(2)} m`);
});

test('corridor: a noisy stretch is wider and less confident; leave-one-out coverage is calibrated', () => {
  // each pass has its own lateral offset (evenly spread normal quantiles): sigma 1 m west of x = 10, 5 m east of it
  const q = [-1.53, -0.89, -0.49, -0.16, 0.16, 0.49, 0.89, 1.53];
  const order = [3, 6, 0, 5, 2, 7, 1, 4];
  const passes: PassInput[] = q.map((z, k) => {
    const calm = z;
    const noisy = 5 * q[order[k]];
    return { id: String(k), stations: stationsOf(pass(61 + k, { sigma: 0.3 }).map((p) => ({ ...p, y: p.y + (p.x > 10 ? noisy : calm) }))) };
  });
  const c = buildCanonical(passes);
  const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const calm = c.points.filter((p) => p.x < -20);
  const noisy = c.points.filter((p) => p.x > 30);
  assert.ok(avg(noisy.map((p) => p.halfWidthM)) > 2 * avg(calm.map((p) => p.halfWidthM)), `${avg(noisy.map((p) => p.halfWidthM))} vs ${avg(calm.map((p) => p.halfWidthM))}`);
  assert.ok(avg(noisy.map((p) => p.confidence)) < avg(calm.map((p) => p.confidence)));
  const v = leaveOneOut(passes);
  assert.equal(v.passes.length, 8);
  assert.ok(v.pooled.corridorCoverage! > 0.75, `coverage ${v.pooled.corridorCoverage}`);
});

test('qc-v1: invalid, pre-session, duplicate, low accuracy, spike and jump are rejected with reasons', () => {
  const at = (i: number) => new Date(T0 + i * 1000).toISOString();
  const ll = (x: number, y: number) => fromCampus(x, y);
  const locations = Array.from({ length: 20 }, (_, i) => ({ sequence: i + 1, timestamp: at(i), ...ll(i * 1.3, 0), horizontalAccuracy: 6, speed: 1.3 }));
  locations[3] = { ...locations[3], horizontalAccuracy: -1 };
  locations[5] = { ...locations[5], horizontalAccuracy: 80 };
  locations[8] = { ...locations[8], ...ll(8 * 1.3, 60) }; // spike
  locations.push({ sequence: 99, timestamp: at(-120), ...ll(0, 0), horizontalAccuracy: 5, speed: 0 }); // cached before start
  locations.push({ sequence: 100, timestamp: at(19), ...ll(19 * 1.3, 0), horizontalAccuracy: 6, speed: 1.3 }); // duplicate time
  locations.push({ sequence: 101, timestamp: at(21), ...ll(400, 0), horizontalAccuracy: 6, speed: 1.3 }); // jump
  const d = qcLocations({ locations, pedometer: [] }, { sessionStartedAt: new Date(T0) });
  const by = new Map(d.map((x) => [x.seq, x]));
  assert.deepEqual(by.get(4)!.reasons, ['INVALID']);
  assert.ok(by.get(6)!.reasons.includes('LOW_ACCURACY'));
  assert.ok(by.get(9)!.reasons.includes('SPIKE'));
  assert.ok(by.get(99)!.reasons.includes('PRE_SESSION'));
  assert.ok(by.get(100)!.reasons.includes('DUPLICATE'));
  assert.ok(by.get(101)!.reasons.includes('JUMP'));
  assert.equal(by.get(2)!.status, 'ACCEPTED');
});

test('qc-v1: a consistent run after a jump is a relocation, not three rejections', () => {
  const at = (i: number) => new Date(T0 + i * 1000).toISOString();
  const locations = Array.from({ length: 10 }, (_, i) => ({ sequence: i + 1, timestamp: at(i), ...fromCampus(i < 5 ? 0 : 300, 0), horizontalAccuracy: 5, speed: 0 }));
  const d = qcLocations({ locations, pedometer: [] }, {});
  assert.equal(d.filter((x) => x.reasons.includes('JUMP')).length, 0);
});

test('AS_RECEIVED replay of in-order batches equals the forward replay (shared pipeline)', () => {
  const w = syntheticWalk({ path: ROUTE, startMs: T0, seed: 9 });
  const timeline = buildTimeline(w.raw, { sessionStartedAt: w.startedAt });
  const algo = FUSION_ALGORITHMS['fusion-v4'];
  const sensor = replayInMemory(algo, timeline, { finalize: false });
  const flushed = [...sensor.forward, ...algo.flush(sensor.state).outputs];
  const batches: typeof timeline[] = [];
  for (let i = 0; i < timeline.length; i += 400) batches.push(timeline.slice(i, i + 400)); // in sensor order
  const asReceived = replayAsReceived(algo, batches, 3500);
  assert.equal(asReceived.skippedLate, 0);
  assert.deepEqual(asReceived.outputs.map((o) => [o.timestamp, o.latitude, o.longitude]), flushed.map((o) => [o.timestamp, o.latitude, o.longitude]));
});
