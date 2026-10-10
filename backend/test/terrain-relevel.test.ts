import test from 'node:test';
import assert from 'node:assert/strict';
import { bilinear } from '../src/geo/dem.js';
import { planRelevel, type RelevelNode, type RelevelRoad } from '../src/geo/terrain-relevel.js';

type XYZ = [number, number, number];
const grid = { originX: 0, originY: 0, resolution: 2, width: 40, height: 40 };
// old: flat 100. new: raised by a ramp in x (0 at x<=20, +6 at x>=50), irregular so deltas are not round numbers
const oldH = new Float32Array(1600).fill(100);
const newH = oldH.map((h, i) => Math.fround(h + 6 * Math.min(1, Math.max(0, ((i % 40) * 2 + 1 - 20) / 30)) ** 1.3));
const ground = (h: Float32Array, x: number, y: number) => Math.round(bilinear(grid, h, x, y)! * 100) / 100;
const road = (id: string, from: string, to: string, coordinates: XYZ[], extra: Partial<RelevelRoad> = {}): RelevelRoad =>
  ({ id, structure: 'ordinary', buildingId: null, levelId: null, fromNodeId: from, toNodeId: to, coordinates, ...extra });
const nodesOf = (roads: RelevelRoad[]): RelevelNode[] => [...new Map(roads.flatMap((r) => [[r.fromNodeId, r.coordinates[0]], [r.toNodeId, r.coordinates.at(-1)!]] as [string, XYZ][])).entries()]
  .map(([id, coordinate]) => ({ id, coordinate }));
const applied = (roads: RelevelRoad[], plan: ReturnType<typeof planRelevel>) => roads.map((r) => ({ ...r, coordinates: plan.roads.find((p) => p.id === r.id)?.coordinates ?? r.coordinates }));

// draped: every vertex on the old surface. terrace: a level estimated 3 m above it, joined to the draped road at node b.
const draped = road('draped', 'a', 'b', [10, 30, 43.7, 58.2, 70].map((x): XYZ => [x, 30.3, ground(oldH, x, 30.3)]));
const terrace = road('terrace', 'b', 'c', [[70, 30.3, 100], [70, 50, 103]]);
const stairs = road('stairs', 'c', 'd', [[70, 50, 103], [66, 50, 104]], { structure: 'stairs' });
const corridor = road('corridor', 'd', 'e', [[66, 50, 104], [60, 50, 104]], { structure: 'indoor_corridor', buildingId: 'B' });

test('only the interior vertices of a draped road follow the terrain; roads with their own heights are reported', () => {
  const roads = [draped, terrace, stairs, corridor];
  const plan = planRelevel(grid, oldH, newH, roads, nodesOf(roads));
  assert.deepEqual(plan.roads.map((r) => r.id), ['draped']);
  assert.deepEqual(plan.roads[0].vertices.map((v) => v.index), [1, 2, 3]); // x=10 lies outside the change, x=70 is a kept node
  for (const v of plan.roads[0].vertices) {
    const [x, y] = draped.coordinates[v.index];
    assert.ok(Math.abs(v.toZ - bilinear(grid, newH, x, y)!) <= 0.006, 'still on the surface (0.01 m rounding of the input)');
  }
  assert.deepEqual(plan.nodes, []);
  assert.deepEqual(plan.refusedRoads.map((r) => [r.id, r.reason]), [['terrace', 'own-heights'], ['stairs', 'own-heights'], ['corridor', 'indoor']]);
  // the junction stays where it was: no gap, but it is listed with the terrain change underneath
  assert.equal(plan.refusedNodes.length, 1);
  assert.deepEqual([plan.refusedNodes[0].id, plan.refusedNodes[0].reason, plan.refusedNodes[0].otherRoadIds], ['b', 'shared-with-own-heights', ['terrace']]);
  assert.ok(Math.abs(plan.refusedNodes[0].deltaM - 6) < 1e-6 && Math.abs(plan.refusedNodes[0].aboveAfterM + 6) < 1e-6);
  assert.deepEqual(plan.roads[0].coordinates.at(-1), draped.coordinates.at(-1));
});

test('the reverse run restores every height exactly', () => {
  const roads = [draped, terrace, stairs, corridor];
  const there = planRelevel(grid, oldH, newH, roads, nodesOf(roads));
  const moved = applied(roads, there);
  const back = planRelevel(grid, newH, oldH, moved, nodesOf(moved));
  assert.equal(back.roads[0].vertices.length, there.roads[0].vertices.length);
  assert.deepEqual(applied(moved, back), roads);
});

test('a node moves only when it lies on the surface and every road on it is draped', () => {
  const first = road('first', 'a', 'm', [10, 30, 40].map((x): XYZ => [x, 20, ground(oldH, x, 20)]));
  const second = road('second', 'm', 'z', [40, 50, 60].map((x): XYZ => [x, 20, ground(oldH, x, 20)]));
  const free = planRelevel(grid, oldH, newH, [first, second], nodesOf([first, second]));
  assert.deepEqual(free.nodes.map((n) => n.id).sort(), ['m', 'z']);
  assert.deepEqual(free.refusedNodes, []);
  const m = free.nodes.find((n) => n.id === 'm')!;
  assert.equal(free.roads.find((r) => r.id === 'first')!.coordinates.at(-1)![2], m.coordinate[2]);
  assert.equal(free.roads.find((r) => r.id === 'second')!.coordinates[0][2], m.coordinate[2]);
  const after = applied([first, second], free);
  assert.deepEqual(applied(after, planRelevel(grid, newH, oldH, after, nodesOf(after))), [first, second]);

  const door = road('door', 'm', 'x', [[40, 20, 100], [40, 16, 100]], { structure: 'indoor_corridor', buildingId: 'B' });
  const shared = planRelevel(grid, oldH, newH, [first, second, door], nodesOf([first, second, door]));
  assert.deepEqual(shared.nodes.map((n) => n.id), ['z']);
  assert.deepEqual(shared.refusedNodes.map((n) => [n.id, n.reason, n.otherRoadIds]), [['m', 'shared-with-indoor', ['door']]]);
  assert.equal(shared.roads.find((r) => r.id === 'first')!.coordinates.at(-1)![2], 100);
});

test('nothing changes where the two terrains agree, whatever precision the heights have', () => {
  const west = road('west', 'p', 'q', [[4, 10, 100.0000001234], [10, 10, 100.0000004321], [16, 10, 100.01]]);
  const plan = planRelevel(grid, oldH, newH, [west], nodesOf([west]));
  assert.deepEqual(plan, { roads: [], nodes: [], refusedRoads: [], refusedNodes: [] });
});

// Copied reference: old ground is 101.2 (x<30), 100.3 (30..50), 100 (x>=50). The level 100 at R was copied onto p (x=35) and q (x=20).
// New ground: +1 where x<30, +6 elsewhere, so the reference level becomes 106.
const cx = (i: number) => (i % 40) * 2 + 1;
const oldR = new Float32Array(1600).map((_, i) => Math.fround(cx(i) < 30 ? 101.2 : cx(i) < 50 ? 100.3 : 100));
const newR = oldR.map((h, i) => Math.fround(h + (cx(i) < 30 ? 1 : 6)));
const withRef = { onTerrainM: 0.05, minDeltaM: 0.005, references: [[60, 60]] as [number, number][], referenceMatchM: 0.006, referenceNearGroundM: 0.5 };
const flatCopy = road('flatCopy', 'q', 'p', [[20, 20, 100], [26, 20, 100], [35, 20, 100]]);
const fieldPath = road('fieldPath', 'p', 't', [[35, 20, 100], [40, 20, ground(oldR, 40, 20)], [56, 20, ground(oldR, 56, 20)], [70, 20, ground(oldR, 70, 20)]]);
const steps = road('steps', 's', 'p', [[35, 26, 104], [35, 20, 100]], { structure: 'stairs' });

test('a node holding the copied reference level moves by the change at the reference when it is near the ground before and after', () => {
  const roads = [flatCopy, fieldPath, steps];
  const plan = planRelevel(grid, oldR, newR, roads, nodesOf(roads), withRef);
  assert.deepEqual(plan.nodes.map((n) => [n.id, n.rule, n.coordinate[2]]).sort(), [['p', 'reference', 106], ['t', 'draped', 106]]);
  assert.deepEqual(plan.nodes.find((n) => n.id === 'p')!.roadIds.sort(), ['fieldPath', 'flatCopy', 'steps']);
  // every road end on the node follows it; q and the middle vertex are copies too, but 1.2 m off the ground, so they stay
  const moved = applied(roads, plan);
  assert.deepEqual(moved.map((r) => r.coordinates.map((p) => p[2])), [[100, 100, 106], [106, 106.3, 106, 106], [104, 106]]);
  assert.deepEqual(plan.refusedRoads.map((r) => [r.id, r.vertices, r.referenceCopies]), [['flatCopy', 2, 2], ['steps', 1, 0]]);
  assert.deepEqual(plan.refusedNodes, []);

  const nodesAfter = nodesOf(moved);
  const back = planRelevel(grid, newR, oldR, moved, nodesAfter, withRef);
  assert.deepEqual(applied(moved, back), roads);
  assert.deepEqual(back.nodes.map((n) => [n.id, n.coordinate[2]]).sort(), [['p', 100], ['t', 100]]);
});

test('without references, or when an indoor road uses the node, the copied level stays', () => {
  const roads = [flatCopy, fieldPath, steps];
  const plain = planRelevel(grid, oldR, newR, roads, nodesOf(roads));
  assert.deepEqual(plain.nodes.map((n) => n.id), ['t']);
  assert.deepEqual(plain.refusedNodes.map((n) => [n.id, n.reason]), [['p', 'shared-with-own-heights']]);
  const door = road('door', 'p', 'x', [[35, 20, 100], [35, 16, 100]], { structure: 'indoor_corridor', buildingId: 'B' });
  const shared = planRelevel(grid, oldR, newR, [...roads, door], nodesOf([...roads, door]), withRef);
  assert.deepEqual(shared.nodes.map((n) => n.id), ['t']);
  assert.deepEqual(shared.refusedNodes.map((n) => [n.id, n.reason]), [['p', 'shared-with-indoor']]);
  assert.equal(shared.roads.find((r) => r.id === 'steps'), undefined);
});
