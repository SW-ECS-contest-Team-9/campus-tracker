import test from 'node:test';
import assert from 'node:assert/strict';
import { bilinear } from '../src/geo/dem.js';
import { blendWeight, polygonsMask } from '../src/geo/terrain-corridor.js';
import { applyPlateau } from '../src/geo/terrain-plateau.js';

test('plateau preserves source, exterior terrain and holes', () => {
  const grid = { originX: 0, originY: 0, resolution: 1, width: 6, height: 6 };
  const source = Float32Array.from({ length: 36 }, (_, i) => 120 + i);
  const before = source.slice();
  const rings: [number, number][][] = [
    [[1, 1], [5, 1], [5, 5], [1, 5], [1, 1]],
    [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]],
  ];
  const result = applyPlateau(grid, source, rings, 141.73);
  assert.deepEqual(source, before);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    const inside = x >= 1 && x < 5 && y >= 1 && y < 5;
    const hole = x >= 2 && x < 4 && y >= 2 && y < 4;
    assert.equal(result[y * 6 + x], inside && !hole ? Math.fround(141.73) : source[y * 6 + x]);
  }
});

test('plateau edge: flat margin, smooth fade, nothing beyond, masks respected', () => {
  const grid = { originX: 0, originY: 0, resolution: 2, width: 50, height: 50 };
  const n = 2500;
  const source = Float32Array.from({ length: n }, (_, i) => 150 + 0.1 * (i % 50) - 0.2 * Math.floor(i / 50));
  const before = source.slice();
  const rings: [number, number][][] = [[[30, 30], [70, 30], [70, 70], [30, 70], [30, 30]]];
  const outside = (x: number, y: number) => Math.hypot(Math.max(30 - x, 0, x - 70), Math.max(30 - y, 0, y - 70));
  const h = applyPlateau(grid, source, rings, 148.9, { marginM: 3, blendM: 4 });
  assert.deepEqual(source, before);
  let faded = 0;
  for (let i = 0; i < n; i++) {
    const x = (i % 50) * 2 + 1, y = Math.floor(i / 50) * 2 + 1, d = outside(x, y);
    if (d <= 3) assert.equal(h[i], Math.fround(148.9));
    else if (d >= 7) assert.equal(h[i], source[i]);
    else { faded++; assert.ok(Math.abs(h[i] - (source[i] + (148.9 - source[i]) * blendWeight(d - 3, 4))) < 1e-3); }
  }
  assert.ok(faded > 100);
  // with the margin, bilinear samples anywhere in the polygon (edge included) read the plateau height
  for (let x = 30; x <= 70; x += 0.9) for (const y of [30, 30.4, 50, 69.7, 70]) assert.ok(Math.abs(bilinear(grid, h, x, y)! - 148.9) < 1e-4);
  // without an edge the old behaviour stays: a sample on the edge still mixes in exterior cells
  assert.ok(Math.abs(bilinear(grid, applyPlateau(grid, source, rings, 148.9), 50, 30)! - 148.9) > 0.3);

  const keep = polygonsMask(grid, [[[[60, 20], [80, 20], [80, 40], [60, 40], [60, 20]]]]); // a building on the corner
  const noBlend = polygonsMask(grid, [[[[0, 70], [100, 70], [100, 100], [0, 100], [0, 70]]]]); // a wall along the north edge
  const m = applyPlateau(grid, source, rings, 148.9, { marginM: 3, blendM: 4, keep, noBlend });
  let kept = 0, wall = 0;
  for (let i = 0; i < n; i++) {
    const x = (i % 50) * 2 + 1, y = Math.floor(i / 50) * 2 + 1, d = outside(x, y);
    if (keep[i]) { if (h[i] !== source[i]) kept++; assert.equal(m[i], source[i]); }
    else if (noBlend[i] && d > 3) { if (h[i] !== source[i]) wall++; assert.equal(m[i], source[i]); }
    else assert.equal(m[i], h[i]);
  }
  assert.ok(kept > 10 && wall > 20);
  assert.throws(() => applyPlateau(grid, source, rings, 148.9, { marginM: -1 }));
  assert.throws(() => applyPlateau(grid, source, rings, 148.9, { keep: new Uint8Array(4) }));
});

test('plateau refuses invalid height and mismatched raster', () => {
  const grid = { originX: 0, originY: 0, resolution: 1, width: 2, height: 2 };
  const ring: [number, number][][] = [[[0, 0], [2, 0], [2, 2], [0, 0]]];
  assert.throws(() => applyPlateau(grid, new Float32Array(4), ring, NaN));
  assert.throws(() => applyPlateau(grid, new Float32Array(3), ring, 141.73));
});
