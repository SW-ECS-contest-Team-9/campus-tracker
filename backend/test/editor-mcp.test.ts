// Editor MCP building blocks without a database: geometry helpers and network QA.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineLength, simplifyIndices } from '../src/modules/editor-mcp/geometry.js';
import { validateNetwork, type QaNode, type QaRoad } from '../src/modules/editor-mcp/network-validate.js';
import { NEAR_HEIGHT_M, SAME_HEIGHT_M, crossings, isConnector, type XYZ } from '../src/modules/editor/topology.js';

const X = 201_000, Y = 557_300;
const p = (x: number, y: number, z = 100): XYZ => [X + x, Y + y, z];

/** Builds roads with one node per distinct end coordinate unless a node id is given. */
function network(lines: { id: string; c: XYZ[]; from?: string; to?: string; attrs?: Partial<QaRoad> }[]) {
  const nodes = new Map<string, QaNode>();
  const nodeAt = (c: XYZ, forced?: string) => {
    const id = forced ?? `n:${c.join(',')}`;
    if (!nodes.has(id)) nodes.set(id, { id, levelId: null, coordinate: c });
    return id;
  };
  const roads: QaRoad[] = lines.map((l) => ({
    id: l.id, name: l.id, structure: 'ordinary', vehicleAccess: 'unknown', wheelchairAccess: 'unknown', levelId: null,
    fromNodeId: nodeAt(l.c[0], l.from), toNodeId: nodeAt(l.c.at(-1)!, l.to), coordinates: l.c, ...l.attrs,
  }));
  return { roads, nodes: [...nodes.values()] };
}
const codes = (n: ReturnType<typeof network>, options = {}) => validateNetwork(n.roads, n.nodes, undefined, options).map((f) => f.code);

test('simplifyIndices keeps the ends and the corner of an L', () => {
  const line: [number, number][] = [[0, 0], [5, 0.01], [10, 0], [10, 5], [10, 10]];
  assert.deepEqual(simplifyIndices(line, 0.1), [0, 2, 4]);
  assert.deepEqual(simplifyIndices(line, 0), [0, 1, 2, 3, 4]);
  assert.equal(lineLength(line.filter((_, i) => [0, 2, 4].includes(i))), 20);
});

test('a T junction that shares a node is clean', () => {
  const n = network([
    { id: 'main-a', c: [p(0, 0), p(10, 0)] }, { id: 'main-b', c: [p(10, 0), p(20, 0)] }, { id: 'side', c: [p(10, 0), p(10, 8)] },
  ]);
  assert.deepEqual(codes(n), []);
});

test('an end that stops short of another road is reported once', () => {
  const n = network([{ id: 'main', c: [p(0, 0), p(20, 0)] }, { id: 'side', c: [p(10, 0.4), p(10, 8)] }]);
  const found = validateNetwork(n.roads, n.nodes);
  assert.deepEqual(found.map((f) => f.code), ['DANGLING_END_NEAR_ROAD', 'ISOLATED_COMPONENT']);
  assert.match(found[0].suggestion!, /connect_roads/);
});

test('crossing without a node: error at the same height, info when far apart in Z', () => {
  const same = network([{ id: 'a', c: [p(0, 0), p(10, 10)] }, { id: 'b', c: [p(0, 10), p(10, 0)] }]);
  assert.equal(validateNetwork(same.roads, same.nodes, ['UNCONNECTED_CROSSING'])[0].severity, 'error');
  const bridge = network([{ id: 'a', c: [p(0, 0), p(10, 10)] }, { id: 'b', c: [p(0, 10, 106), p(10, 0, 106)] }]);
  assert.equal(validateNetwork(bridge.roads, bridge.nodes, ['UNCONNECTED_CROSSING'])[0].severity, 'info');
});

test('roads on different levels are never compared', () => {
  const n = network([{ id: 'a', c: [p(0, 0), p(10, 10)] }, { id: 'b', c: [p(0, 10), p(10, 0)], attrs: { levelId: 'B1' } }]);
  assert.deepEqual(validateNetwork(n.roads, n.nodes, ['UNCONNECTED_CROSSING', 'OVERLAPPING_ROADS']), []);
});

test('duplicate nodes, overlaps and attribute conflicts', () => {
  const dup = network([{ id: 'a', c: [p(0, 0), p(10, 0)], to: 'n1' }, { id: 'b', c: [p(10.05, 0), p(20, 0)], from: 'n2' }]);
  assert.ok(codes(dup).includes('DUPLICATE_NODES'));
  const overlap = network([{ id: 'a', c: [p(0, 0), p(10, 0), p(20, 0)] }, { id: 'b', c: [p(2, 0.1), p(8, 0.1), p(14, 0.1)] }]);
  assert.ok(codes(overlap).includes('OVERLAPPING_ROADS'));
  const stairs = network([{ id: 'a', c: [p(0, 0), p(10, 0)], attrs: { structure: 'stairs', vehicleAccess: 'allowed' } }]);
  assert.deepEqual(codes(stairs), ['ATTRIBUTE_CONFLICT']);
});

test('outdoor road far above the ground is flagged; indoor levels are not', () => {
  const ground = () => 100;
  const high = network([{ id: 'a', c: [p(0, 0, 100.5), p(10, 0, 104)] }]);
  assert.deepEqual(codes(high, { ground }), ['OFF_TERRAIN']);
  const indoor = network([{ id: 'a', c: [p(0, 0, 100.5), p(10, 0, 104)], attrs: { levelId: '2F' } }]);
  assert.deepEqual(codes(indoor, { ground }), []);
});

// ---- heights are kept: 0.3 m is one point, 0.3-1.25 m is two surfaces (never joined, reported), beyond is unrelated ----
test('crossings: roads 0.2 m apart cross at a shared point, roads 1.0 m apart (a deck beside a path) do not', () => {
  const a = [p(0, 0), p(10, 10)];
  assert.equal(crossings(a, [p(0, 10, 100.2), p(10, 0, 100.2)]).length, 1);
  assert.equal(crossings(a, [p(0, 10, 100.2), p(10, 0, 100.2)])[0].z, 100.1);
  assert.equal(crossings(a, [p(0, 10, 101), p(10, 0, 101)]).length, 0); // 한림관 6F deck 147.9 vs field path 148.9
  assert.equal(crossings(a, [p(0, 10, 100.68), p(10, 0, 100.68)]).length, 0); // four risers
  assert.equal(SAME_HEIGHT_M, 0.3);
  assert.equal(NEAR_HEIGHT_M, 1.25);
});

test('validator: a crossing 1.0 m apart is a warning that names the gap, not a "same height" error', () => {
  const near = network([{ id: 'a', c: [p(0, 0), p(10, 10)] }, { id: 'b', c: [p(0, 10, 101), p(10, 0, 101)] }]);
  const [f] = validateNetwork(near.roads, near.nodes, ['UNCONNECTED_CROSSING']);
  assert.equal(f.severity, 'warning');
  assert.match(f.message, /cross 1 m apart in height and are not joined/);
  assert.match(f.suggestion!, /stairs or a ramp/);
  const same = network([{ id: 'a', c: [p(0, 0), p(10, 10)] }, { id: 'b', c: [p(0, 10, 100.2), p(10, 0, 100.2)] }]);
  assert.equal(validateNetwork(same.roads, same.nodes, ['UNCONNECTED_CROSSING'])[0].severity, 'error');
});

test('validator: two nodes at one place 1.0 m apart are NODES_HEIGHT_GAP, 0.2 m apart DUPLICATE_NODES, 3 m apart nothing', () => {
  const at = (z: number) => network([{ id: 'a', c: [p(0, 0), p(10, 0)], to: 'n1' }, { id: 'b', c: [p(10.05, 0, z), p(20, 0, z)], from: 'n2' }]);
  const gap = validateNetwork(at(101).roads, at(101).nodes, ['DUPLICATE_NODES', 'LEVEL_NODES_NOT_JOINED', 'NODES_HEIGHT_GAP']);
  assert.deepEqual(gap.map((f) => [f.code, f.severity]), [['NODES_HEIGHT_GAP', 'warning']]);
  assert.match(gap[0].message, /1 m apart in height and are not joined/);
  assert.deepEqual(gap[0].nodeIds, ['n1', 'n2']);
  assert.deepEqual(validateNetwork(at(100.68).roads, at(100.68).nodes, ['DUPLICATE_NODES', 'NODES_HEIGHT_GAP']).map((f) => f.code), ['NODES_HEIGHT_GAP']);
  assert.deepEqual(validateNetwork(at(100.2).roads, at(100.2).nodes, ['DUPLICATE_NODES', 'NODES_HEIGHT_GAP']).map((f) => f.code), ['DUPLICATE_NODES']);
  assert.deepEqual(validateNetwork(at(103).roads, at(103).nodes, ['DUPLICATE_NODES', 'NODES_HEIGHT_GAP']), []);
});

test('validator: the two ends of a 0.8 m elevator and of a four-riser stair are not a height-gap finding', () => {
  const lift = network([{ id: 'e', c: [p(0, 0, 100), p(0, 0, 100.8)], attrs: { structure: 'elevator' } }]);
  assert.deepEqual(validateNetwork(lift.roads, lift.nodes, ['DUPLICATE_NODES', 'NODES_HEIGHT_GAP']), []);
  const stair = network([{ id: 's', c: [p(0, 0, 100), p(1.2, 0, 100.68)], attrs: { structure: 'stairs' } }]);
  assert.deepEqual(validateNetwork(stair.roads, stair.nodes, ['DUPLICATE_NODES', 'NODES_HEIGHT_GAP']), []);
});

test('validator: a ramp end and a node of another level at the same place and height are reported as not joined; an ordinary road is not', () => {
  const build = (structure: string, dz = 0) => {
    const n = network([{ id: 'r', c: [p(0, 0, 105), p(20, 0, 100 + dz)], to: 'top', attrs: { structure } }, { id: 'c', c: [p(20, 0.05), p(30, 0)], from: 'b1', attrs: { levelId: 'B1' } }]);
    n.nodes.find((x) => x.id === 'b1')!.levelId = 'B1';
    return validateNetwork(n.roads, n.nodes, ['DUPLICATE_NODES', 'LEVEL_NODES_NOT_JOINED', 'NODES_HEIGHT_GAP']);
  };
  const ramp = build('ramp');
  assert.deepEqual(ramp.map((f) => f.code), ['LEVEL_NODES_NOT_JOINED']);
  assert.match(ramp[0].message, /Stairs\/elevator\/ramp end and a road of level "B1"/);
  assert.deepEqual(build('ordinary'), []);
  // the ramp stops 0.6 m above the floor it should reach: not "the same node", but said
  assert.deepEqual(build('ramp', 0.6).map((f) => f.code), ['NODES_HEIGHT_GAP']);
  assert.match(build('ramp', 0.6)[0].message, /levels null and "B1"/);
  assert.ok(isConnector('ramp') && isConnector('stairs') && isConnector('elevator') && !isConnector('ordinary') && !isConnector('indoor_corridor'));
});

test('validator: an overlap and a dangling end say how far apart in height the two roads are', () => {
  const overlap = network([{ id: 'a', c: [p(0, 0), p(10, 0), p(20, 0)] }, { id: 'b', c: [p(2, 0.1, 100.9), p(8, 0.1, 100.9), p(14, 0.1, 100.9)] }]);
  const [o] = validateNetwork(overlap.roads, overlap.nodes, ['OVERLAPPING_ROADS']);
  assert.match(o.message, /, 0.9 m apart in height$/);
  assert.match(o.suggestion!, /two surfaces at different heights keep both/);
  const level = network([{ id: 'a', c: [p(0, 0), p(10, 0), p(20, 0)] }, { id: 'b', c: [p(2, 0.1), p(8, 0.1), p(14, 0.1)] }]);
  assert.doesNotMatch(validateNetwork(level.roads, level.nodes, ['OVERLAPPING_ROADS'])[0].message, /apart in height/);
  const dangling = network([{ id: 'a', c: [p(0, 0), p(20, 0)] }, { id: 'b', c: [p(10, 0.5, 100.7), p(10, 8, 100.7)] }]);
  assert.match(validateNetwork(dangling.roads, dangling.nodes, ['DANGLING_END_NEAR_ROAD'])[0].message, /without connecting, 0.7 m apart in height/);
});
