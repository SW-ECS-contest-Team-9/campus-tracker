// Corridor-from-tracks and 3D duplicate detection, without a database.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corridorCenterline, sameRoad3D, simplify3D, type TrackPoint } from '../src/modules/editor-mcp/corridor.js';
import type { XYZ } from '../src/modules/editor/topology.js';

const X = 201_000, Y = 557_300;
/** A straight east-west walk at lateral offset `dy`, phone height h, sampled every 0.7 m with a little noise. */
const walk = (dy: number, h: number, reverse = false, seed = 1): TrackPoint[] => {
  let s = seed;
  const noise = () => { s = (s * 16807) % 2147483647; return (s / 2147483647 - 0.5) * 0.2; };
  const pts = Array.from({ length: 58 }, (_, i) => ({ x: X + i * 0.7, y: Y + dy + noise(), h: h + noise() * 0.2 }));
  return reverse ? pts.reverse() : pts;
};

test('centre of several walks, width from their spread, direction-independent', () => {
  const r = corridorCenterline([walk(-1, 142.1, false, 3), walk(0.2, 142.1, true, 5), walk(1, 142.1, false, 7)], { phoneHeightM: 1.1 });
  assert.equal(r.usedTracks, 3);
  assert.ok([1, 2].includes(r.reversedTracks), 'the walk against the reference direction is flipped (which one is the reference depends on length)');
  assert.ok(r.coverage > 0.9);
  for (const c of r.coordinates) {
    assert.ok(Math.abs(c[1] - (Y + 0.2)) < 0.25, `centre near the median track: ${c[1] - Y}`);
    assert.ok(Math.abs(c[2] - 141.0) < 0.1, 'floor = track height - phone height');
  }
  assert.ok(r.coordinates.length <= 4, 'a straight passage simplifies to few vertices');
  assert.ok(r.widthM! >= 2.4 && r.widthM! <= 3.2, `width ${r.widthM}`);
});

test('one track: centerline but no width', () => {
  const r = corridorCenterline([walk(0, 141)], {});
  assert.equal(r.widthM, null);
  assert.ok(r.warnings.some((w) => /width/.test(w)));
});

test('terrain heights when asked', () => {
  const r = corridorCenterline([walk(0, 999), walk(1, 999)], { zSource: 'terrain' }, () => 130.5);
  assert.ok(r.coordinates.every((c) => c[2] === 130.5));
});

test('simplify3D keeps a height change on a straight plan line', () => {
  const line: XYZ[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 1.5], [4, 0, 1.5]];
  assert.deepEqual(simplify3D(line, 0.1).map((p) => p[0]), [0, 2, 3, 4]);
});

test('sameRoad3D: stacked stairs and elevator pieces differ, reversed copies match', () => {
  const flight: XYZ[] = [[0, 0, 140.6], [5, 3, 142], [0, 6, 143.47]];
  const above = flight.map(([x, y, z]) => [x, y, z + 2.87] as XYZ);
  assert.equal(sameRoad3D(flight, above), false);
  assert.equal(sameRoad3D(flight, [...flight].reverse()), true);
  assert.equal(sameRoad3D([[0, 0, 140.6], [0, 0, 143.47]], [[0, 0, 143.47], [0, 0, 146.34]]), false);
  assert.equal(sameRoad3D([[0, 0, 140.6], [0, 0, 143.47]], [[0.05, 0, 143.47], [0.05, 0, 140.6]]), true);
  // same plan and height range but a different height profile (ramp vs. stairs landing) is not a duplicate
  assert.equal(sameRoad3D([[0, 0, 0], [5, 0, 0], [10, 0, 2]], [[0, 0, 0], [5, 0, 2], [10, 0, 2]]), false);
});
