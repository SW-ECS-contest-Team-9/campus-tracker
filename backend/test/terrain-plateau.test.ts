import test from 'node:test';
import assert from 'node:assert/strict';
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

test('plateau refuses invalid height and mismatched raster', () => {
  const grid = { originX: 0, originY: 0, resolution: 1, width: 2, height: 2 };
  const ring: [number, number][][] = [[[0, 0], [2, 0], [2, 2], [0, 0]]];
  assert.throws(() => applyPlateau(grid, new Float32Array(4), ring, NaN));
  assert.throws(() => applyPlateau(grid, new Float32Array(3), ring, 141.73));
});
