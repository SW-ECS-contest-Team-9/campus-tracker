// OFF_TERRAIN of validate_network against the built ground: terrain + walkable structure tops + void floors (structure-surfaces.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNetwork, type QaRoad } from '../src/modules/editor-mcp/network-validate.js';
import { loadStructureSurfaces, surfacesAt, surfacesOf } from '../src/modules/editor-mcp/structure-surfaces.js';
import type { XYZ } from '../src/modules/editor/topology.js';

const X = 201_000, Y = 557_300;
const p = (x: number, y: number, z: number): XYZ => [X + x, Y + y, z];
const road = (c: XYZ[], attrs: Partial<QaRoad> = {}): QaRoad => ({
  id: 'r', name: 'r', structure: 'ordinary', vehicleAccess: 'unknown', wheelchairAccess: 'unknown', levelId: null,
  fromNodeId: 'a', toNodeId: 'b', coordinates: c, ...attrs,
});
const square = (x0: number, y0: number, x1: number, y1: number) => [[[X + x0, Y + y0], [X + x1, Y + y0], [X + x1, Y + y1], [X + x0, Y + y1], [X + x0, Y + y0]]];
const fc = (features: { props: Record<string, unknown>; rings: number[][][] }[]) => ({
  type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', properties: f.props, geometry: { type: 'Polygon', coordinates: f.rings } })),
});
// ground 100 everywhere; a deck at 102.4 over x 0..10; an underground void (floor 95) under x 20..30; a canopy at 104 over x 40..50
const structures = surfacesAt(surfacesOf(fc([
  { props: { id: 'DECK', kind: 'extrude', type: 'deck', fromM: 101.9, toM: 102.4 }, rings: square(0, -2, 10, 2) },
  { props: { id: 'VOID', kind: 'void', type: 'void', fromM: 95, toM: 98 }, rings: square(20, -2, 30, 2) },
  { props: { id: 'CANOPY', kind: 'extrude', type: 'canopy', fromM: 103.7, toM: 104 }, rings: square(40, -2, 50, 2) },
])));
const ground = () => 100;
const check = (r: QaRoad, extra = {}) => validateNetwork([r], [], ['OFF_TERRAIN'], { ground, structures, ...extra });

test('OFF_TERRAIN: a road on a deck is on the deck top, not off the terrain', () => {
  assert.deepEqual(check(road([p(1, 0, 102.4), p(9, 0, 102.4)])), []);
  // without the structures it is 2.4 m above the terrain
  assert.equal(validateNetwork([road([p(1, 0, 102.4), p(9, 0, 102.4)])], [], ['OFF_TERRAIN'], { ground }).length, 1);
});

test('OFF_TERRAIN: a road 2 m above the deck is reported against the deck, by name', () => {
  const [f] = check(road([p(1, 0, 104.4), p(9, 0, 104.4)]));
  assert.equal(f.code, 'OFF_TERRAIN');
  assert.match(f.message, /2 m above the top of structure DECK \(deck\)/);
});

test('OFF_TERRAIN: an underground road on the floor of a void is fine; one in the ground with no void is reported', () => {
  assert.deepEqual(check(road([p(21, 0, 95), p(29, 0, 95)])), []);
  const [f] = check(road([p(31, 0, 95), p(39, 0, 95)]));
  assert.match(f.message, /5 m below the terrain/);
});

test('OFF_TERRAIN: a canopy (not walkable) does not excuse a road at its height', () => {
  assert.equal(check(road([p(41, 0, 104), p(49, 0, 104)])).length, 1);
});

test('OFF_TERRAIN: roads of a building, indoor corridors, elevators and levels are not compared; vertices in a building footprint are skipped', () => {
  const high = [p(60, 0, 106), p(70, 0, 106)];
  assert.deepEqual(check(road(high, { buildingId: 'B1' })), []);
  assert.deepEqual(check(road(high, { levelId: '2F' })), []);
  assert.deepEqual(check(road(high, { structure: 'indoor_corridor' })), []);
  assert.deepEqual(check(road(high, { structure: 'elevator' })), []);
  // a door vertex inside the footprint (x > 65) is not on the ground; the outside vertex still is
  const door = road([p(60, 0, 100.2), p(66, 0, 106)]);
  assert.equal(check(door).length, 1);
  assert.deepEqual(check(door, { inBuilding: (x: number) => x > X + 65 }), []);
});

test('OFF_TERRAIN: outdoor stairs are held against their steps and landings', () => {
  const steps = surfacesAt(surfacesOf(fc([
    { props: { id: 'S1', kind: 'extrude', type: 'stair_step', fromM: 100, toM: 101 }, rings: square(0, -1, 2, 1) },
    { props: { id: 'S2', kind: 'extrude', type: 'stair_step', fromM: 100, toM: 102 }, rings: square(2, -1, 4, 1) },
    { props: { id: 'L', kind: 'extrude', type: 'landing', fromM: 100, toM: 103 }, rings: square(4, -1, 8, 1) },
  ])));
  const stair = road([p(1, 0, 101), p(3, 0, 102), p(6, 0, 103)], { structure: 'stairs' });
  assert.deepEqual(validateNetwork([stair], [], ['OFF_TERRAIN'], { ground, structures: steps }), []);
  assert.equal(validateNetwork([stair], [], ['OFF_TERRAIN'], { ground }).length, 1);
});

test('surfacesOf: heights as the frontend reads them (platform profile, inclined slab, box top, void floor); unwalkable types and holes left out', () => {
  const s = surfacesOf(fc([
    { props: { id: 'P', kind: 'platform', type: 'platform', bottomM: 90, topProfile: { origin: [X, Y], direction: [1, 0], points: [[0, 100], [10, 110]] } }, rings: square(0, 0, 10, 10) },
    { props: { id: 'SLAB', kind: 'extrude', type: 'landing', fromM: 0, toM: 1, thicknessM: 0.3, topProfile: { origin: [X, Y], direction: [0, 1], points: [[0, 120], [10, 130]] } }, rings: square(20, 0, 30, 10) },
    { props: { id: 'TREE', kind: 'extrude', type: 'tree', fromM: 100, toM: 106 }, rings: square(0, 0, 1, 1) },
    { props: { id: 'WALL', kind: 'extrude', type: 'wall', fromM: 100, toM: 101 }, rings: square(0, 0, 1, 1) },
    { props: { id: 'RING', kind: 'platform', type: 'platform', bottomM: 90, topM: 99 }, rings: [square(40, 0, 50, 10)[0], square(44, 4, 46, 6)[0]] },
  ]));
  assert.deepEqual(s.map((x) => x.id), ['P', 'SLAB', 'RING']);
  const at = surfacesAt(s);
  assert.equal(at(X + 5, Y + 5)[0].z, 105);
  assert.equal(at(X + 25, Y + 5)[0].z, 125);
  assert.deepEqual(at(X + 45, Y + 5), []);
  assert.equal(at(X + 42, Y + 5)[0].z, 99);
});

test('loadStructureSurfaces: the repository structures folder is read; a missing folder gives none', () => {
  assert.ok(loadStructureSurfaces().length > 100);
  assert.deepEqual(loadStructureSurfaces('no/such/folder'), []);
});
