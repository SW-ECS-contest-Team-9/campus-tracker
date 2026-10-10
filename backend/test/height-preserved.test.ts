// A clear, consistent measured height difference is never merged into one level or shrunk to a default storey height
// (rule of 2026-10-10). Scenarios use this campus' floor heights (building notes): 북악관 B1 130.5 / 1F 134.1 / 2F 138.0 /
// 3F 140.72 (no 4th floor), 한림관 1F 127.2 / 2F 132.5 / 3F 137.8 / 6F 147.9 and the field path 148.9 six risers above it.
// No database.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corridorCenterline, type TrackPoint as CorridorPoint } from '../src/modules/editor-mcp/corridor.js';
import { resolvePath, type ResolveDeps } from '../src/modules/editor-mcp/path-resolver.js';
import { buildCanonical, type PassInput } from '../src/modules/pathfusion/pathfusion-v1.js';
import { resampleTrack } from '../src/modules/trajectory/resample.js';
import { CLEAR_HEIGHT, calibrateLevels, clearHeightDifference, comparisonNoiseM, heightPlateaus } from '../src/modules/trajectory/height-difference.js';

const PHONE = 1.1, X = 201_040, Y = 557_370, T0 = Date.parse('2026-10-07T02:00:00Z');
const noiseOf = (seed: number) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; }; };

// ---- the definition ----
test('clear and consistent: big enough against the noise, same sign, small spread, enough samples', () => {
  const n = noiseOf(3);
  const step = Array.from({ length: 30 }, () => 1.0 + 0.2 * n()); // six risers, one walk
  assert.equal(CLEAR_HEIGHT.minDifferenceM, 0.9);
  assert.equal(clearHeightDifference(step, 0).clear, true);
  assert.equal(clearHeightDifference(step, 0.57).clear, false, 'two walks whose height zeros are 0.4 m uncertain each: 1.0 m is not clear');
  assert.equal(clearHeightDifference(step.slice(0, 4), 0).clear, false, 'four samples are not a level');
  assert.equal(clearHeightDifference(Array.from({ length: 30 }, () => 0.5 + 0.2 * n()), 0).clear, false, 'hand vs pocket');
  assert.equal(clearHeightDifference(Array.from({ length: 30 }, (_, i) => (i < 15 ? 0 : 2.7)), 0).clear, false, 'only half of the stretch differs: not one offset');
  assert.equal(clearHeightDifference(Array.from({ length: 30 }, () => 2.72 + 0.3 * n()), 0.57).clear, true, 'one ordinary storey between two walks');
});

test('noise of a comparison: drift within one run, both height zeros between runs, unknown is never clear', () => {
  assert.equal(comparisonNoiseM({ run: 'a', t: T0 }, { run: 'a', t: T0 + 9 * 60_000 }), 0.3); // 2 m/h x 9 min
  assert.ok(Math.abs(comparisonNoiseM({ run: 'a', sigmaZ: 0.4 }, { run: 'b', sigmaZ: 0.4 }) - 0.566) < 0.001);
  assert.equal(comparisonNoiseM({ run: 'a' }, { run: 'b', sigmaZ: 0.4 }), Infinity);
  assert.equal(comparisonNoiseM({}, {}), Infinity);
});

// ---- corridor from tracks ----
/** A 40 m east-west walk at floor height `floor` (phone height added), one point per 0.7 m. */
const walk = (floor: number, o: { run?: string; t?: number; sigmaZ?: number; seed?: number; dy?: number } = {}): CorridorPoint[] => {
  const n = noiseOf(o.seed ?? 1);
  return Array.from({ length: 58 }, (_, i) => ({ x: X + i * 0.7, y: Y + (o.dy ?? 0) + 0.2 * n(), h: floor + PHONE + 0.1 * n(),
    ...(o.run ? { run: o.run, t: (o.t ?? T0) + i * 1000 } : {}), ...(o.sigmaZ !== undefined ? { sigmaZ: o.sigmaZ } : {}) }));
};
const heights = (c: { coordinates: number[][] }) => c.coordinates.map((p) => p[2]);

test('corridor: walks on 북악관 2F (138.0) and 3F (140.72) are not blended into a 139.4 m corridor', () => {
  // before the rule: one corridor at 139.36 m, a floor that does not exist
  const tracks = [walk(138.0, { run: 'run-a', sigmaZ: 0.4, seed: 1 }), walk(140.72, { run: 'run-b', sigmaZ: 0.4, seed: 2, dy: 0.5 })];
  assert.throws(() => corridorCenterline(tracks), /clearly different height.*[+-]2\.7 m.*one corridor per level/s);
  // each level on its own keeps its measured height
  const second = corridorCenterline([tracks[0], walk(138.0, { run: 'run-c', sigmaZ: 0.4, seed: 5, dy: -0.4 })]);
  assert.ok(heights(second).every((z) => Math.abs(z - 138.0) < 0.1), `${heights(second)}`);
  const third = corridorCenterline([tracks[1]]);
  assert.ok(heights(third).every((z) => Math.abs(z - 140.72) < 0.1), `${heights(third)}`);
  // terrain heights do not use the walks' heights at all
  assert.equal(corridorCenterline(tracks, { zSource: 'terrain' }, () => 131.4).coordinates[0][2], 131.4);
});

test('corridor: 한림관 6F deck (147.9) and the field path (148.9), six risers apart in one walk, stay two levels', () => {
  // before the rule: one corridor at 148.4 m
  const tracks = [walk(147.9, { run: 'run-a', t: T0, seed: 1 }), walk(148.9, { run: 'run-a', t: T0 + 3 * 60_000, seed: 2 })];
  assert.throws(() => corridorCenterline(tracks), /clearly different height.*1\.0 m/s);
});

test('corridor: when the difference is not clear the walks are merged as before', () => {
  // the same 1.0 m between two different runs (height zeros 0.4 m uncertain each): cannot be told from a zero error
  const unclear = corridorCenterline([walk(147.9, { run: 'run-a', sigmaZ: 0.4, seed: 1 }), walk(148.9, { run: 'run-b', sigmaZ: 0.4, seed: 2 })]);
  assert.ok(heights(unclear).every((z) => Math.abs(z - 148.4) < 0.1), `${heights(unclear)}`);
  // no run / sigma given (older callers): unchanged
  const plain = corridorCenterline([walk(138.0, { seed: 1 }), walk(140.72, { seed: 2 })]);
  assert.ok(heights(plain).every((z) => Math.abs(z - 139.36) < 0.1), `${heights(plain)}`);
  // hand vs pocket in one walk (0.5 m)
  const carried = corridorCenterline([walk(138.0, { run: 'run-a', t: T0, seed: 1 }), walk(138.5, { run: 'run-a', t: T0 + 60_000, seed: 2 })]);
  assert.ok(heights(carried).every((z) => Math.abs(z - 138.25) < 0.1), `${heights(carried)}`);
});

// ---- canonical path of a route ----
const pass = (id: string, floor: number, o: { run?: string; sigmaZ?: number; seed: number }): PassInput => {
  const n = noiseOf(o.seed);
  const pts = Array.from({ length: 41 }, (_, i) => ({ t: T0 + o.seed * 1e6 + i * 1000, x: -20 + i + 0.3 * n(), y: 5 + 0.3 * n(), h: floor + PHONE + 0.2 * n(), sigmaH: 2 }));
  return { id, stations: resampleTrack(pts).stations, ...(o.run ? { run: o.run } : {}), ...(o.sigmaZ !== undefined ? { sigmaZ: o.sigmaZ } : {}) };
};
const medianZ = (c: { points: { z: number | null }[] }) => { const z = c.points.map((p) => p.z!).sort((a, b) => a - b); return z[z.length >> 1]; };

test('canonical path: a pass one storey up (same plan) is excluded as DIFFERENT_LEVEL, not averaged in', () => {
  // before the rule: both ACCEPTED and the path at 140.46 m, between 2F and 3F
  const c = buildCanonical([pass('2F', 138.0, { run: 'run-a', sigmaZ: 0.4, seed: 1 }), pass('3F', 140.72, { run: 'run-b', sigmaZ: 0.4, seed: 2 })]);
  assert.deepEqual(c.passes.map((p) => [p.id, p.status, p.reasons]), [['2F', 'ACCEPTED', []], ['3F', 'REJECTED', ['DIFFERENT_LEVEL']]]);
  assert.ok(Math.abs(medianZ(c) - (138.0 + PHONE)) < 0.15, `${medianZ(c)}`);
  assert.ok(c.points.every((p) => !p.contributors.includes('3F')));
});

test('canonical path: an unclear difference is fused as before', () => {
  const noInfo = buildCanonical([pass('a', 138.0, { seed: 1 }), pass('b', 140.72, { seed: 2 })]);
  assert.deepEqual(noInfo.passes.map((p) => p.status), ['ACCEPTED', 'ACCEPTED']);
  assert.ok(Math.abs(medianZ(noInfo) - (139.36 + PHONE)) < 0.15, `${medianZ(noInfo)}`);
  const zeroError = buildCanonical([pass('a', 138.0, { run: 'run-a', sigmaZ: 0.4, seed: 1 }), pass('b', 139.0, { run: 'run-b', sigmaZ: 0.4, seed: 2 })]);
  assert.deepEqual(zeroError.passes.map((p) => p.status), ['ACCEPTED', 'ACCEPTED']);
});

// ---- a recorded walk as a road ----
/** 북악관 1F corridor (134.1) 20 m, a straight stair 3.9 m up over 6 m, 2F corridor (138.0) 10 m: all on one plan line. */
const stairWalk = Array.from({ length: 37 }, (_, i) => {
  const floor = i <= 20 ? 134.1 : i >= 26 ? 138.0 : 134.1 + (3.9 * (i - 20)) / 6;
  return { seq: i, x: X + i, y: Y, h: floor + PHONE, sigmaZ: 0.4 };
});
const deps = (track: typeof stairWalk, ground: number): ResolveDeps => ({
  road: async () => { throw new Error('unused'); }, node: async () => { throw new Error('unused'); }, place: async () => { throw new Error('unused'); },
  cursorOf: () => null, runTrack: async () => track, canonical: async () => [], ground: () => ground,
});
const RUN = '22222222-2222-4222-8222-222222222222';

test('run heights: a level stretch, stairs and the next level on one straight line keep both floors', async () => {
  // before the rule: two vertices, i.e. one even 36 m ramp, 136.2 m in the middle of the 1F corridor
  const r = await resolvePath([{ run: { runId: RUN, fromSeq: 0, toSeq: 36, simplifyM: 0.5 } }], deps(stairWalk, 131.4), { runZ: 'run_h', zMode: 'explicit', densify: false });
  assert.deepEqual(r.coordinates.map((c) => [c[0] - X, Math.round((c[2] - PHONE) * 100) / 100]), [[0, 134.1], [20, 134.1], [26, 138], [36, 138]]);
});

test('terrain heights for a walk that is clearly off the ground: warned, and no warning on the ground', async () => {
  const floor = stairWalk.slice(26).map((p) => ({ ...p, seq: p.seq - 26 })); // 2F corridor, ground below at 131.4
  const up = await resolvePath([{ run: { runId: RUN, fromSeq: 0, toSeq: 10, simplifyM: 0.5 } }], deps(floor, 131.4), { densify: false });
  assert.ok(up.coordinates.every((c) => c[2] === 131.4), 'terrain heights, as asked');
  assert.ok(up.warnings.some((w) => /MEASURED_HEIGHT_DROPPED.*6\.7 m above the ground/.test(w)), up.warnings.join('\n'));
  const onGround = await resolvePath([{ run: { runId: RUN, fromSeq: 0, toSeq: 10, simplifyM: 0.5 } }], deps(floor, 138.0 + PHONE - 1.0), { densify: false });
  assert.deepEqual(onGround.warnings, []);
  const unknownZero = await resolvePath([{ run: { runId: RUN, fromSeq: 0, toSeq: 10, simplifyM: 0.5 } }], deps(floor.map(({ sigmaZ: _s, ...p }) => p) as typeof stairWalk, 131.4), { densify: false });
  assert.deepEqual(unknownZero.warnings, [], 'no sigma of the height zero: nothing is called clear');
});

// ---- building levels from a field session ----
/** Seconds spent at each phone height (level + 1 m), with a few seconds on the stairs between. */
const session = (levels: [number, number][]) => {
  const n = noiseOf(7), out: number[] = [];
  levels.forEach(([floor, seconds], k) => {
    for (let i = 0; i < seconds; i++) out.push(floor + 1 + 0.3 * n());
    const next = levels[k + 1];
    if (next) for (let i = 1; i <= 4; i++) out.push(floor + 1 + ((next[0] - floor) * i) / 5);
  });
  return out;
};
/** every value within 0.15 m of the expected one (the plateaus are medians of noisy seconds) */
const near = (actual: number[], expected: number[]) => assert.ok(actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]) <= 0.15), `${actual.map((v) => v.toFixed(2))} vs ${expected}`);

test('building levels: 한림관 6F and the field path one metre above stay two levels; tall storeys keep their measured height', () => {
  // before the rule: the 148.9 plateau was dropped (within 2 m of a bigger one), the 5.3 m storeys were not accepted as
  // storeys so the default 3.5 m was used, and 2F became "entrance floor +2", 3F "+3", 6F "+6"
  const values = session([[127.2, 60], [132.5, 40], [137.8, 50], [147.9, 60], [148.9, 30]]);
  const plateaus = heightPlateaus(values);
  near(plateaus.map((p) => p.heightM - 1), [127.2, 132.5, 137.8, 147.9, 148.9]);
  const c = calibrateLevels(plateaus, 127.2 + 1, null, 3.5);
  assert.deepEqual(c.levels.map((l) => l.relativeFloor), [0, 1, 2, 3, 4]);
  near(c.levels.map((l) => l.aboveEntranceM), [0, 5.3, 10.6, 20.7, 21.7]);
  near(c.levelGapsM, [5.3, 5.3, 10.1, 1]);
  assert.equal(c.floorHeightSource, 'BAROMETER_LEVELS');
  assert.ok(Math.abs(c.floorHeightM - 5.3) < 0.1, `${c.floorHeightM}`);
});

test('building levels: 북악관 B1 3.6 m, 1F 3.9 m, then 2.72 m storeys are stored as walked', () => {
  const values = session([[130.5, 40], [134.1, 60], [138.0, 40], [140.72, 40], [143.44, 40]]);
  const c = calibrateLevels(heightPlateaus(values), 134.1 + 1, 55.05 / 12, 3.5);
  assert.deepEqual(c.levels.map((l) => l.relativeFloor), [-1, 0, 1, 2, 3]);
  near(c.levels.map((l) => l.aboveEntranceM), [-3.6, 0, 3.9, 6.62, 9.34]);
  near(c.levelGapsM, [3.6, 3.9, 2.72, 2.72]);
});

test('building levels: one noisy floor is one level, and without measured storeys the register or default is still used', () => {
  const n = noiseOf(11);
  const one = heightPlateaus(Array.from({ length: 120 }, () => 135.1 + 0.9 * n())); // phone moved between hand and pocket
  assert.equal(one.length, 1);
  assert.equal(calibrateLevels(one, 135.1, 4.6, 3.5).floorHeightSource, 'BUILDING_REGISTER');
  assert.equal(calibrateLevels(one, 135.1, null, 3.5).floorHeightM, 3.5);
});
