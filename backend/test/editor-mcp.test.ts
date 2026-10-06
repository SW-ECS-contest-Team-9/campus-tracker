// Editor MCP building blocks without a database: geometry helpers and network QA.  npm test -w backend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineLength, simplifyIndices } from '../src/modules/editor-mcp/geometry.js';
import { validateNetwork, type QaNode, type QaRoad } from '../src/modules/editor-mcp/network-validate.js';
import type { XYZ } from '../src/modules/editor/topology.js';

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
