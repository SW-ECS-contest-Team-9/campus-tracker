// 2026-10-25: the first-person walk draws no translucent box walls; indoors the walls come from the footprint and (사2) interiors.geojson.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM, buildingsToHide, floorWalls, roomDrawing, wayOpenings } from '../src/first-person.ts';
import { inPolygons, type Interior, type LvRoad, type Zone } from '../src/level-view.ts';
import { tmInverse } from '../src/tm.ts';

const X0 = 201100, Y0 = 557300, FLOOR = 150;
const road = (id: string, coordinates: number[][], more: Partial<LvRoad> = {}): LvRoad => ({ id, name: null, roadClass: 'pedestrian', structure: 'ordinary', widthM: null, levelId: null, buildingId: null, geometry: { coordinates }, ...more });
const lonLat = (x: number, y: number) => { const g = tmInverse(x, y); return [g.longitude, g.latitude]; };
/** 본관: a 20 x 10 m block from 140 to 160 m. */
const building = (id = '본관', baseM = 140, roofM = 160) => ({ buildingId: id, name: id, baseM, roofM, geometry: { coordinates: [[[[X0, Y0], [X0 + 20, Y0], [X0 + 20, Y0 + 10], [X0, Y0 + 10], [X0, Y0]].map(([x, y]) => lonLat(x, y))]] } }) as any;
// a corridor that comes in through the west wall, stairs at its east end, and a tunnel well outside
const corridor = road('c', [[X0 - 5, Y0 + 5, FLOOR], [X0 + 15, Y0 + 5, FLOOR]], { buildingId: '본관' });
const stairs = road('s', [[X0 + 15, Y0 + 5, FLOOR], [X0 + 18, Y0 + 5, FLOOR + 3]], { buildingId: '본관', structure: 'stairs' });
const tunnel = road('t', [[X0 + 40, Y0 - 20, 140], [X0 + 40, Y0 + 30, 140]], { name: '지하 통로' });
const roads = [corridor, stairs, tunnel];
const WALL = [0xd9, 0xdd, 0xe2];

/** The vertices of the mesh in the wall colour, and every alpha of the mesh. */
function look(mesh: { points: number[][]; colors: number[] }) {
  const walls: number[][] = [], alphas: number[] = [];
  mesh.points.forEach((p, i) => {
    const c = mesh.colors.slice(i * 4, i * 4 + 4);
    alphas.push(c[3]);
    if (c[0] === WALL[0] && c[1] === WALL[1] && c[2] === WALL[2]) walls.push(p);
  });
  return { walls, alphas };
}

test('indoors without interiors: an opaque outer wall only, no box around the ways, the entrance open', () => {
  const { mesh } = roomDrawing({ x: X0 + 5, y: Y0 + 5, feetM: FLOOR, zone: null, indoor: corridor, roads, buildings: [building()], interiors: [] });
  const { walls, alphas } = look(mesh);
  assert.ok(walls.length > 0);
  assert.ok(alphas.every((a) => a === 255), 'nothing translucent');
  // every wall vertex lies on the outer wall (no wall along the corridor or the stairs inside)
  const onShell = (p: number[]) => p[0] < X0 + ROOM.shellM + 0.01 || p[0] > X0 + 20 - ROOM.shellM - 0.01 || p[1] < Y0 + ROOM.shellM + 0.01 || p[1] > Y0 + 10 - ROOM.shellM - 0.01;
  assert.ok(walls.every(onShell), 'only the outer wall');
  // the corridor goes out through the west wall: no wall across it there
  assert.ok(!walls.some((p) => p[0] < X0 + 1 && p[1] > Y0 + 5 - ROOM.openingM / 2 + 0.05 && p[1] < Y0 + 5 + ROOM.openingM / 2 - 0.05), 'entrance open');
  // nothing drawn about the tunnel 40 m away
  assert.ok(mesh.points.every((p) => p[0] < X0 + 21));
});

test('under the ground outside a storey (a tunnel): no box at all', () => {
  const { mesh, lines } = roomDrawing({ x: X0 + 40, y: Y0, feetM: 140, zone: null, indoor: null, roads, buildings: [building()], interiors: [] });
  assert.equal(mesh.points.length, 0);
  assert.equal(lines.length, 0);
});

test('indoors with interiors: the rooms between the spaces stand as opaque walls, the corridor and its ends open', () => {
  const space = (kind: Interior['kind'], ring: number[][]): Interior => ({ building: '본관', kind, name: kind, floorsM: [FLOOR], grade: '추정', polygons: [[ring]] });
  const interiors = [
    space('corridor', [[X0, Y0 + 4], [X0 + 20, Y0 + 4], [X0 + 20, Y0 + 6], [X0, Y0 + 6]]),
    // a stairwell that nearly touches the corridor (0.1 m apart): no sliver of wall between them
    space('stair', [[X0 + 14, Y0 + 6.1], [X0 + 17, Y0 + 6.1], [X0 + 17, Y0 + 9], [X0 + 14, Y0 + 9]]),
    space('lobby', [[X0, Y0], [X0 + 3, Y0], [X0 + 3, Y0 + 3], [X0, Y0 + 3]]), // another floor: not carved here
  ];
  interiors[2].floorsM = [FLOOR + 4];
  const { mesh } = roomDrawing({ x: X0 + 5, y: Y0 + 5, feetM: FLOOR, zone: null, indoor: corridor, roads, buildings: [building()], interiors });
  const { walls, alphas } = look(mesh);
  assert.ok(alphas.every((a) => a === 255), 'nothing translucent');
  // the room south of the corridor has its wall face along the corridor (widened by the slack)
  const face = walls.filter((p) => Math.abs(p[1] - (Y0 + 4 - ROOM.spaceSlackM)) < 0.02).map((p) => p[0]);
  assert.ok(face.length && Math.max(...face) - Math.min(...face) > 15, 'wall face along the corridor');
  // the same walls as a plan
  const plan = floorWalls([[[[X0, Y0], [X0 + 20, Y0], [X0 + 20, Y0 + 10], [X0, Y0 + 10]]]], interiors.slice(0, 2).flatMap((s) => s.polygons), wayOpenings(roads, FLOOR, true));
  assert.ok(!inPolygons(plan, X0 + 10, Y0 + 5), 'corridor open');
  assert.ok(!inPolygons(plan, X0 + 0.1, Y0 + 5) && !inPolygons(plan, X0 + 19.9, Y0 + 5), 'both corridor ends open');
  assert.ok(!inPolygons(plan, X0 + 15.5, Y0 + 6.05), 'no sliver between the corridor and the stairwell');
  assert.ok(!inPolygons(plan, X0 + 15.5, Y0 + 8), 'stairwell open');
  assert.ok(inPolygons(plan, X0 + 10, Y0 + 2) && inPolygons(plan, X0 + 5, Y0 + 8), 'rooms are wall blocks');
  assert.ok(inPolygons(plan, X0 + 1.5, Y0 + 1.5), 'the lobby of another floor is not carved');
});

test('an underground storey: opaque outline, open where a way leaves it', () => {
  const ring = [[X0, Y0], [X0 + 30, Y0], [X0 + 30, Y0 + 20], [X0, Y0 + 20]];
  const zone: Zone = { id: 'b1', name: '지하 1층', description: '', note: '', layer: 'underground', polygons: [[ring]], fromM: 138, toM: 142, floorM: 138 };
  const passage = road('p', [[X0 + 10, Y0 + 10, 138], [X0 + 50, Y0 + 10, 138]]);
  const { mesh } = roomDrawing({ x: X0 + 10, y: Y0 + 10, feetM: 138, zone, indoor: null, roads: [passage], buildings: [], interiors: [] });
  const { walls, alphas } = look(mesh);
  assert.ok(walls.length > 0 && alphas.every((a) => a === 255));
  assert.ok(!walls.some((p) => p[0] > X0 + 29 && p[1] > Y0 + 10 - ROOM.openingM / 2 + 0.05 && p[1] < Y0 + 10 + ROOM.openingM / 2 - 0.05), 'the passage leaves through an opening');
});

test('the buildings left out while walking: the one indoors, basements at the feet underground, none outdoors', () => {
  const list = [building('본관'), building('본관#2', 140, 150), building('북악관', 125, 160), building('청운관', 150, 170)];
  assert.deepEqual(buildingsToHide(list, { feetM: FLOOR, indoorId: '본관', below: false }), ['본관', '본관#2']);
  assert.deepEqual(buildingsToHide(list, { feetM: 130, indoorId: null, below: true }), ['북악관']);
  assert.deepEqual(buildingsToHide(list, { feetM: 150, indoorId: null, below: false }), []);
});
