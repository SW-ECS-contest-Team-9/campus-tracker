import test from 'node:test';
import assert from 'node:assert/strict';
import { bilinear } from '../src/geo/dem.js';
import { blendWeight, burnCorridors, polygonsMask, type CorridorLine } from '../src/geo/terrain-corridor.js';

const grid = { originX: 0, originY: 0, resolution: 2, width: 60, height: 40 };
const n = grid.width * grid.height;
// ground that falls 0.5 m per metre northwards: a road along x cuts across the slope
const slope = () => Float32Array.from({ length: n }, (_, i) => 120 - 0.5 * (Math.floor(i / grid.width) * 2 + 1));
// road along y = 40 from x = 20 to x = 100, rising 10 % (z = 100 + 0.1 * (x - 20)), 6 m wide
const road: CorridorLine = { name: 'R', halfWidthM: 3, points: Array.from({ length: 41 }, (_, k) => [20 + 2 * k, 40, 100 + 0.2 * k] as [number, number, number]) };
const opts = { shoulderM: 3, blendM: 4 };
const centre = (i: number) => [(i % grid.width) * 2 + 1, Math.floor(i / grid.width) * 2 + 1];
const fromRoad = (x: number, y: number) => Math.hypot(x - Math.max(20, Math.min(100, x)), y - 40);
const profile = (x: number) => 100 + 0.1 * (Math.max(20, Math.min(100, x)) - 20);

test('corridor cells take the profile height, flat across the width, and the source is untouched', () => {
  const source = slope(), before = source.slice();
  const h = burnCorridors(grid, source, [road], opts);
  assert.deepEqual(source, before);
  for (let i = 0; i < n; i++) {
    const [x, y] = centre(i);
    if (fromRoad(x, y) <= 6) assert.ok(Math.abs(h[i] - profile(x)) < 1e-4);
  }
  // bilinear samples anywhere on the carriageway read the profile (constant grade), not the old slope
  for (let x = 24; x <= 96; x += 0.7) for (const o of [-3, -1.3, 0, 2.2, 3]) assert.ok(Math.abs(bilinear(grid, h, x, 40 + o)! - profile(x)) < 1e-3);
});

test('outside the flat strip the height fades without a step and nothing changes beyond the blend distance', () => {
  const source = slope();
  const h = burnCorridors(grid, source, [road], opts);
  let blended = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = centre(i), d = fromRoad(x, y);
    if (d >= 10) assert.equal(h[i], source[i]);
    else if (d > 6) {
      blended++;
      const z = profile(x);
      assert.ok(Math.abs(h[i] - (source[i] + (z - source[i]) * blendWeight(d - 6, 4))) < 1e-3);
      assert.ok((h[i] - source[i]) * (z - source[i]) >= 0 && Math.abs(h[i] - source[i]) <= Math.abs(z - source[i]) + 1e-4); // between source and profile
    }
  }
  assert.ok(blended > 100);
  // continuity: the weight is 1 at the strip edge, 0 at the blend end, and has no jump in between
  assert.equal(blendWeight(0, 4), 1);
  assert.equal(blendWeight(4, 4), 0);
  assert.equal(blendWeight(0.5, 0), 0);
  for (let d = 0; d < 4; d += 0.01) assert.ok(Math.abs(blendWeight(d, 4) - blendWeight(d + 0.01, 4)) < 0.006);
  assert.ok(1 - blendWeight(0.05, 4) < 1e-3 && blendWeight(3.95, 4) < 1e-3);
});

test('keep cells never change and noBlend cells keep the source outside the flat strip', () => {
  const source = slope();
  const keep = polygonsMask(grid, [[[[50, 30], [60, 30], [60, 44], [50, 44], [50, 30]]]]); // a building over part of the road
  const noBlend = polygonsMask(grid, [[[[0, 46], [120, 46], [120, 80], [0, 80], [0, 46]]]]); // a wall along the north side
  const h = burnCorridors(grid, source, [road], opts, { keep, noBlend });
  const free = burnCorridors(grid, source, [road], opts);
  let kept = 0, wall = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = centre(i), d = fromRoad(x, y);
    if (keep[i]) { kept++; assert.equal(h[i], source[i]); }
    else if (noBlend[i] && d > 6) { if (free[i] !== source[i]) wall++; assert.equal(h[i], source[i]); }
    else assert.equal(h[i], free[i]);
  }
  assert.ok(kept > 20 && wall > 50);
});

test('overlapping corridors: the one a cell lies deepest in wins, and bad input is refused', () => {
  const source = slope();
  const branch: CorridorLine = { name: 'B', halfWidthM: 3, points: [[60, 40, 104], [60, 70, 107]] };
  const h = burnCorridors(grid, source, [road, branch], opts);
  assert.ok(Math.abs(bilinear(grid, h, 60, 60)! - 106) < 1e-3); // on the branch
  assert.ok(Math.abs(bilinear(grid, h, 30, 40)! - 101) < 1e-3); // on the road, away from the branch
  assert.ok(Math.abs(h[20 * grid.width + 30] - 104) < 0.11); // junction cell (61, 41): both profiles are 104 there
  assert.throws(() => burnCorridors(grid, new Float32Array(3), [road], opts));
  assert.throws(() => burnCorridors(grid, source, [], opts));
  assert.throws(() => burnCorridors(grid, source, [{ name: 'x', halfWidthM: 0, points: road.points }], opts));
  assert.throws(() => burnCorridors(grid, source, [{ name: 'x', halfWidthM: 3, points: [[0, 0, NaN], [1, 1, 1]] }], opts));
  assert.throws(() => burnCorridors(grid, source, [road], { shoulderM: -1, blendM: 4 }));
  assert.throws(() => burnCorridors(grid, source, [road], opts, { keep: new Uint8Array(5) }));
});
