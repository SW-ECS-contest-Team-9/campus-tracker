// Declared route (사용자 지정 길): contract parsing and the path through the points on a small graph (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeclaredRoute, declaredPath, evaluateDeclaredRoute, type PathRoad } from '../src/modules/mobility/declared-route.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D, LONE] = [1, 2, 3, 4, 9].map(id);

test('declaredRoute: missing legs are walked, text defaults to null, floors are normalized', () => {
  const r = DeclaredRoute.parse({ nodeKeys: [A, B, C], segments: [{ mode: 'stairs', direction: 'up', fromFloor: '1f', toFloor: '3f' }] });
  assert.deepEqual(r.segments, [{ mode: 'stairs', direction: 'up', fromFloor: '1F', toFloor: '3F' }, { mode: 'walk' }]);
  assert.equal(r.text, null);
  assert.deepEqual(DeclaredRoute.parse({ nodeKeys: [A, B], text: ' 본관 앞 ' }).segments, [{ mode: 'walk' }]);
});

test('declaredRoute: invalid routes are rejected with a reason, never thrown (raw capture must not depend on it)', () => {
  assert.deepEqual(evaluateDeclaredRoute(undefined), { route: null, status: 'NONE', reason: null });
  assert.deepEqual(evaluateDeclaredRoute(null), { route: null, status: 'NONE', reason: null });
  assert.equal(evaluateDeclaredRoute({ nodeKeys: [A, B] }).status, 'ACCEPTED');
  for (const bad of [
    { nodeKeys: [A] }, // one point is not a route
    { nodeKeys: [A, 'not-a-uuid'] },
    { nodeKeys: [A, B], segments: [{ mode: 'walk' }, { mode: 'walk' }] }, // more legs than points allow
    { nodeKeys: [A, B], segments: [{ mode: 'stairs' }] }, // stairs without direction
    { nodeKeys: [A, B], segments: [{ mode: 'elevator', fromFloor: '1F' }] }, // elevator without toFloor
    { nodeKeys: [A, B], segments: [{ mode: 'elevator', fromFloor: '0F', toFloor: '2F' }] }, // no 0F
    'A to B',
  ]) {
    const d = evaluateDeclaredRoute(bad);
    assert.equal(d.status, 'REJECTED', JSON.stringify(bad));
    assert.equal(d.route, null);
    assert.ok(d.reason && d.reason.length <= 200);
  }
});

// A —corridor— B —stairs— C ; B —corridor (long)— C as a detour ; D only via an area link from C (2D coordinates)
const road = (rid: string, from: string, to: string, structure: string, coordinates: number[][], lengthM?: number): PathRoad => ({
  id: rid, name: rid, structure, fromNodeId: from, toNodeId: to, coordinates,
  lengthM: lengthM ?? coordinates.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - coordinates[i][0], p[1] - coordinates[i][1]), 0),
  pedestrianAccess: 'allowed', vehicleAccess: 'forbidden', wheelchairAccess: 'unknown', pedestrianDirection: 'both', vehicleDirection: 'unknown',
});
const nodes = [
  { id: A, coordinate: [0, 0, 100] as [number, number, number] },
  { id: B, coordinate: [10, 0, 100] as [number, number, number] },
  { id: C, coordinate: [20, 0, 108] as [number, number, number] },
  { id: D, coordinate: [20, 10, 108] as [number, number, number] },
  { id: LONE, coordinate: [99, 99, 0] as [number, number, number] },
];
const graph = [
  road('ab', A, B, 'indoor_corridor', [[0, 0, 100], [10, 0, 100]]),
  // stored C→B: the path walks it backwards and must come out B→C
  road('cb-stairs', C, B, 'stairs', [[20, 0, 108], [15, 0, 104], [10, 0, 100]]),
  road('bc-detour', B, C, 'indoor_corridor', [[10, 0, 100], [10, 30, 100], [20, 30, 108], [20, 0, 108]]),
  { ...road('area:1:c:d', C, D, 'open_area', [[20, 0], [20, 10]]), coordinates: [[20, 0], [20, 10]] },
];

test('declared path: shortest path per leg, joined, oriented the way the collector walks', () => {
  const route = DeclaredRoute.parse({ nodeKeys: [A, B, C, D], segments: [{ mode: 'walk' }, { mode: 'stairs', direction: 'up' }] });
  const p = declaredPath(graph, nodes, route);
  assert.equal(p.reachable, true);
  assert.equal(p.legs.length, 3);
  assert.deepEqual(p.legs.map((l) => (l.reachable ? l.roads.map((r) => r.roadId) : null)), [['ab'], ['cb-stairs'], ['area:1:c:d']]);
  assert.deepEqual(p.legs.map((l) => l.warnings), [[], [], []]);
  assert.deepEqual(p.coordinates, [[0, 0, 100], [10, 0, 100], [15, 0, 104], [20, 0, 108], [20, 10, 108]]); // area link takes C's height
  assert.ok(Math.abs(p.lengthM! - (10 + Math.hypot(5, 0) * 2 + 10)) < 0.01);
});

test('declared path: a declared elevator the path does not use is reported, not changed', () => {
  const route = DeclaredRoute.parse({ nodeKeys: [B, C], segments: [{ mode: 'elevator', fromFloor: '1F', toFloor: '3F' }] });
  const [leg] = declaredPath(graph, nodes, route).legs;
  assert.equal(leg.reachable, true);
  assert.deepEqual(leg.warnings, ['DECLARED_ELEVATOR_NOT_ON_PATH']);
});

test('declared path: unknown and unconnected nodes fail their leg only', () => {
  const missing = declaredPath(graph, nodes, DeclaredRoute.parse({ nodeKeys: [A, id(77), B] }));
  assert.equal(missing.reachable, false);
  assert.equal(missing.lengthM, null);
  assert.deepEqual(missing.legs.map((l) => (l.reachable ? 'ok' : l.reason)), ['NODE_NOT_IN_NETWORK', 'NODE_NOT_IN_NETWORK']);
  const lone = declaredPath(graph, nodes, DeclaredRoute.parse({ nodeKeys: [A, B, LONE] }));
  assert.deepEqual(lone.legs.map((l) => (l.reachable ? 'ok' : l.reason)), ['ok', 'NOT_CONNECTED']);
  assert.deepEqual(lone.coordinates, [[0, 0, 100], [10, 0, 100]]);
});
