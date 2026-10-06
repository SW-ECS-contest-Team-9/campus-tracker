// Path resolution and reachability for the editor MCP tools, without a database.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath, type ResolveDeps } from '../src/modules/editor-mcp/path-resolver.js';
import { checkReachability, type ReachRoad } from '../src/modules/editor-mcp/reachability.js';
import type { XYZ } from '../src/modules/editor/topology.js';

const ROAD = '11111111-1111-4111-8111-111111111111', RUN = '22222222-2222-4222-8222-222222222222', NODE = '33333333-3333-4333-8333-333333333333';
const road = { id: ROAD, levelId: null, status: 'DRAFT', coordinates: [[0, 0, 10], [10, 0, 12], [10, 10, 12]] as XYZ[] };
const deps = (ground: (x: number, y: number) => number | null = () => 100): ResolveDeps => ({
  road: async () => road,
  node: async () => ({ coordinate: [5, 5, 50] }),
  place: async () => ({ coordinate: [6, 6, 60] }),
  cursorOf: (id) => (id === 'C01' ? [7, 7, 70] : null),
  runTrack: async () => [0, 1, 2, 3, 4].map((seq) => ({ seq, x: seq * 10, y: seq === 2 ? 0.1 : 0, h: seq === 3 ? null : 200 + seq })),
  canonical: async () => [0, 1, 2].map((idx) => ({ idx, x: idx, y: 0 })),
  ground,
});
const code = (p: Promise<unknown>) => p.then(() => 'no error', (e) => e.code);

test('free points take the terrain height unless z is given', async () => {
  const r = await resolvePath([{ xy: [1, 2] }, { xy: [3, 4], z: 7 }], deps(), { densify: false });
  assert.deepEqual(r.coordinates, [[1, 2, 100], [3, 4, 7]]);
  assert.deepEqual(r.anchors, []);
  assert.equal(await code(resolvePath([{ xy: [1, 2] }], deps(), { zMode: 'explicit' })), 'Z_REQUIRED');
  assert.equal(await code(resolvePath([{ xy: [1, 2] }], deps(() => null))), 'OUTSIDE_TERRAIN');
});

test('road references give exact positions and become anchors', async () => {
  const r = await resolvePath([{ at: { roadId: ROAD, vertexIndex: 1 } }, { xy: [20, 0], z: 5 }, { at: { roadId: ROAD, measureM: 15 } }, { at: { roadId: ROAD, nearest: [4, 3] } }], deps(), { densify: false });
  assert.deepEqual(r.coordinates, [[10, 0, 12], [20, 0, 5], [10, 5, 12], [4, 0, 10.8]]);
  assert.deepEqual(r.anchors, [{ roadId: ROAD, measureM: 10, vertexIndex: 0 }, { roadId: ROAD, measureM: 15, vertexIndex: 2 }, { roadId: ROAD, measureM: 4, vertexIndex: 3 }]);
});

test('a road on another level cannot be referenced', async () => {
  assert.equal(await code(resolvePath([{ at: { roadId: ROAD, vertexIndex: 0 } }, { xy: [1, 1] }], deps(), { levelId: 'B1' })), 'LEVEL_MISMATCH');
});

test('node, place and cursor references; an item needs exactly one kind', async () => {
  const r = await resolvePath([{ at: { nodeId: NODE } }, { at: { placeId: NODE } }, { at: { cursorOf: 'c01' } }], deps(), { densify: false });
  assert.deepEqual(r.coordinates, [[5, 5, 50], [6, 6, 60], [7, 7, 70]]);
  assert.equal(await code(resolvePath([{ at: { cursorOf: 'C09' } }], deps())), 'CURSOR_UNAVAILABLE');
  assert.equal(await code(resolvePath([{ xy: [0, 0], at: { nodeId: NODE } }], deps())), 'INVALID_PATH_ITEM');
  assert.equal(await code(resolvePath([{}], deps())), 'INVALID_PATH_ITEM');
});

test('run stretches are simplified, can be walked backwards, and use the terrain by default', async () => {
  const forward = await resolvePath([{ run: { runId: RUN, fromSeq: 0, toSeq: 4, simplifyM: 0.5 } }], deps(), { densify: false });
  assert.deepEqual(forward.coordinates, [[0, 0, 100], [40, 0, 100]]);
  const back = await resolvePath([{ run: { runId: RUN, fromSeq: 3, toSeq: 1, simplifyM: 0 } }], deps(), { densify: false });
  assert.deepEqual(back.coordinates.map((p) => p[0]), [30, 20, 10]);
  const heights = await resolvePath([{ run: { runId: RUN, fromSeq: 0, toSeq: 4, simplifyM: 0 } }], deps(), { densify: false, runZ: 'run_h' });
  assert.deepEqual(heights.coordinates.map((p) => p[2]), [200, 201, 202, 204]); // seq 3 has no absolute height
  assert.equal(heights.warnings.length, 2);
});

test('densify adds vertices only where the ground leaves the straight line; duplicates collapse onto the reference', async () => {
  const hill = (x: number) => (x > 8 && x < 12 ? 103 : 100);
  const r = await resolvePath([{ xy: [0, 0] }, { xy: [20, 0] }], deps(hill));
  assert.ok(r.coordinates.length > 2 && r.coordinates.some((p) => p[2] === 103));
  const flat = await resolvePath([{ xy: [0, 0] }, { xy: [20, 0] }], deps());
  assert.equal(flat.coordinates.length, 2);
  const merged = await resolvePath([{ xy: [10, 0], z: 12 }, { at: { roadId: ROAD, vertexIndex: 1 } }, { xy: [30, 0] }], deps(), { densify: false });
  assert.equal(merged.coordinates.length, 2);
  assert.deepEqual(merged.anchors, [{ roadId: ROAD, measureM: 10, vertexIndex: 0 }]);
});

const seg = (id: string, from: string, to: string, extra: Partial<ReachRoad> = {}): ReachRoad => ({
  id, name: id, structure: 'ordinary', fromNodeId: from, toNodeId: to, lengthM: 10, pedestrianAccess: 'allowed', vehicleAccess: 'prohibited',
  wheelchairAccess: 'allowed', pedestrianDirection: 'both', vehicleDirection: 'both', ...extra,
});
const nodes = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, coordinate: [i * 10, 0, 0] as XYZ }));

test('reachability: shortest connection, one-way roads, and strict handling of unknown access', () => {
  const net = [seg('ab', 'a', 'b'), seg('bc', 'b', 'c', { pedestrianDirection: 'forward' }), seg('cd', 'c', 'd', { pedestrianAccess: 'unknown' })];
  const ac = checkReachability(net, nodes, 'a', 'c', 'pedestrian');
  assert.ok(ac.reachable && ac.lengthM === 20 && ac.roads.map((r) => r.roadId).join() === 'ab,bc');
  assert.equal(checkReachability(net, nodes, 'c', 'a', 'pedestrian').reachable, false); // against the one-way
  const ad = checkReachability(net, nodes, 'a', 'd', 'pedestrian');
  assert.ok(!ad.reachable && ad.blockedRoadsAtFrontier[0].roadId === 'cd' && ad.closestReached?.nodeId === 'c');
  assert.equal(checkReachability(net, nodes, 'a', 'd', 'pedestrian', true).reachable, true);
});

test('reachability: stairs stop wheelchairs, pedestrian roads stop vehicles', () => {
  const net = [seg('ab', 'a', 'b', { structure: 'stairs' })];
  assert.equal(checkReachability(net, nodes, 'a', 'b', 'pedestrian').reachable, true);
  const wheel = checkReachability(net, nodes, 'a', 'b', 'wheelchair');
  assert.ok(!wheel.reachable && wheel.blockedRoadsAtFrontier[0].reason === 'stairs');
  assert.equal(checkReachability(net, nodes, 'a', 'b', 'vehicle').reachable, false);
});
