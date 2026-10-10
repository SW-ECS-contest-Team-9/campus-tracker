// Open areas as walkable space in the network check, without a database.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaLinks, type WalkArea } from '../src/modules/editor-mcp/area-links.js';
import { checkReachability, type ReachRoad } from '../src/modules/editor-mcp/reachability.js';
import type { XYZ } from '../src/modules/editor/topology.js';

const node = (id: string, x: number, y: number, z = 10, levelId: string | null = null) => ({ id, levelId, coordinate: [x, y, z] as XYZ });
const area = (rings: number[][][], extra: Partial<WalkArea> = {}): WalkArea => ({ id: 1, name: '운동장', elevationM: 10, floor: null, rings, ...extra });
const square = [[0, 0], [100, 0], [100, 60], [0, 60]];
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);

test('area links: two access nodes on a convex area are joined by the straight distance', () => {
  const links = areaLinks([area([square])], [node('a', 0, 0), node('b', 100, 60)]);
  assert.equal(links.length, 1);
  near(links[0].lengthM, Math.hypot(100, 60));
  assert.deepEqual(links[0].coordinates, [[0, 0], [100, 60]]);
  assert.equal(links[0].pedestrianAccess, 'allowed');
});

test('area links: a concave area is walked around the inner corner, never through the outside', () => {
  // L shape: the notch x 40..100, y 20..60 is outside
  const L = [[0, 0], [100, 0], [100, 20], [40, 20], [40, 60], [0, 60]];
  const [link] = areaLinks([area([L])], [node('a', 90, 20), node('b', 40, 55)]);
  near(link.lengthM, 50 + 35);
  assert.deepEqual(link.coordinates, [[90, 20], [40, 20], [40, 55]]);
  const [bent] = areaLinks([area([L])], [node('a', 95, 10), node('b', 20, 55)]);
  near(bent.lengthM, Math.hypot(55, 10) + Math.hypot(20, 35));
});

test('area links: a hole forces a detour around its corners', () => {
  const hole = [[40, 20], [60, 20], [60, 40], [40, 40]];
  const [link] = areaLinks([area([square, hole])], [node('a', 10, 30), node('b', 90, 30)]);
  near(link.lengthM, 2 * Math.hypot(30, 10) + 20);
  assert.equal(link.coordinates.length, 4);
  assert.equal(areaLinks([area([square, hole])], [node('a', 10, 30), node('inside-hole', 50, 30)]).length, 0);
});

test('area links: nothing happens without two access nodes at the floor height', () => {
  const a = area([square]);
  assert.equal(areaLinks([a], []).length, 0);
  assert.equal(areaLinks([a], [node('a', 10, 10)]).length, 0);
  assert.equal(areaLinks([a], [node('a', 10, 10), node('low', 50, 50, 2.8)]).length, 0, '7 m below the floor is not on it');
  assert.equal(areaLinks([a], [node('a', 10, 10), node('far', 101, 30)]).length, 0, '1 m outside the boundary');
  assert.equal(areaLinks([a], [node('a', 10, 10), node('edge', 100.4, 30, 10.4)]).length, 1, 'within the tolerances');
  assert.equal(areaLinks([{ ...a, elevationM: null }], [node('a', 10, 10), node('b', 50, 50)]).length, 0);
  const lobby = area([square], { floor: 'L1' });
  assert.equal(areaLinks([lobby], [node('a', 10, 10, 10, 'L1'), node('b', 50, 50, 10, 'L2')]).length, 0);
  assert.equal(areaLinks([lobby], [node('a', 10, 10, 10, 'L1'), node('b', 50, 50, 10, 'L1')]).length, 1);
});

test('area links: the network check crosses the area instead of walking the stored roads around it', () => {
  const nodes = [node('a', 0, 0), node('b', 100, 0), node('c', 100, 60), node('out', 100, 80, 13)];
  const road = (id: string, from: string, to: string, lengthM: number, extra: Partial<ReachRoad> = {}): ReachRoad => ({
    id, name: id, structure: 'ordinary', fromNodeId: from, toNodeId: to, lengthM, pedestrianAccess: 'allowed', vehicleAccess: 'prohibited',
    wheelchairAccess: 'allowed', pedestrianDirection: 'both', vehicleDirection: 'both', ...extra });
  const roads = [road('ab', 'a', 'b', 100), road('bc', 'b', 'c', 60), road('stairs', 'c', 'out', 20, { structure: 'stairs' })];
  assert.equal(checkReachability(roads, nodes, 'a', 'out', 'pedestrian').lengthM, 180);
  const withArea = checkReachability([...roads, ...areaLinks([area([square])], nodes)], nodes, 'a', 'out', 'pedestrian');
  assert.ok(withArea.reachable);
  near(withArea.lengthM, Math.hypot(100, 60) + 20);
  assert.deepEqual(withArea.roads.map((r) => r.roadId), ['area:1:a:c', 'stairs']);
  assert.equal(checkReachability(areaLinks([area([square])], nodes), nodes, 'a', 'c', 'vehicle').reachable, false, 'vehicles are not assumed on an area');
});
