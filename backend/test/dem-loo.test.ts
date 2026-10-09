import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDem, bilinear, type ContourRun } from '../src/geo/dem.js';

test('DEM leave-one-out residual matches a surface rebuilt without the held-out spot', () => {
  const grid = { originX: 0, originY: 0, resolution: 2, width: 30, height: 30 };
  const contours: ContourRun[] = [
    { height: 100, points: [[1, 1], [1, 59]] },
    { height: 105, points: [[59, 1], [59, 59]] },
  ];
  const spots = [
    { x: 15.4, y: 16.7, height: 108 },
    { x: 30.2, y: 24.3, height: 101 },
    { x: 43.6, y: 40.8, height: 103 },
  ];
  const full = buildDem(grid, contours, spots);
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    const heldOut = buildDem(grid, contours, spots.filter((_, j) => j !== i));
    const expected = s.height - bilinear(grid, heldOut.heights, s.x, s.y)!;
    assert.ok(Math.abs(full.spotLooResiduals[i] - expected) < 1e-4,
      `spot ${i}: reported ${full.spotLooResiduals[i]}, actual held-out ${expected}`);
  }
});
