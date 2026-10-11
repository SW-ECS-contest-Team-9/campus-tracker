import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { PRECEDENCE, SOLID_STRIDE, fillPolygons, parseStructures, sectionCaps, solidMesh, stairSteps, surfaceExclusions, topHeight, topMesh } = await import('../src/structures.ts');
const { clipMesh, sectionPlane } = await import('../src/section.ts');
const { buildPavedSurfaces } = await import('../src/paved-surface.ts');
const { polygonOps } = await import('../src/polygon-ops.ts');

type P = number[];
const X0 = 201000, Y0 = 557300;
const rect = (x: number, y: number, w: number, h: number): P[] => [[X0 + x, Y0 + y], [X0 + x + w, Y0 + y], [X0 + x + w, Y0 + y + h], [X0 + x, Y0 + y + h]];
const closed = (ring: P[]) => [...ring, ring[0]];
const feature = (properties: Record<string, unknown>, ring: P[]) => ({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [closed(ring)] } });
const collection = (features: unknown[]) => ({ type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::5186' } }, features });
// 첫 점 기준으로 잰다(좌표가 수십만이라 그대로 곱하면 자릿수를 잃는다)
const ringArea = (r: P[]) => Math.abs(r.reduce((s, p, i) => s + ((p[0] - r[0][0]) * (r[(i + 1) % r.length][1] - r[0][1]) - (r[(i + 1) % r.length][0] - r[0][0]) * (p[1] - r[0][1])) / 2, 0));
const polygonArea = (poly: P[][]) => ringArea(poly[0]) - poly.slice(1).reduce((s, h) => s + ringArea(h), 0);
/** 삼각형 묶음의 꼭짓점(stride 개씩)과 삼각형 */
const trianglesOf = (mesh: { positions: number[]; indices: number[] }, stride: number) => {
  const out: P[][] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) out.push([0, 1, 2].map((k) => mesh.positions.slice(mesh.indices[i + k] * stride, mesh.indices[i + k] * stride + stride)));
  return out;
};
/** 닫힌 덩어리: 모든 모서리를 정확히 두 면이 쓴다 */
const openEdges = (mesh: { positions: number[]; indices: number[] }, stride: number) => {
  const uses = new Map<string, number>();
  const key = (p: P) => p.slice(0, 3).map((v) => v.toFixed(4)).join(',');
  for (const tri of trianglesOf(mesh, stride)) for (let e = 0; e < 3; e++) {
    const [a, b] = [key(tri[e]), key(tri[(e + 1) % 3])].sort();
    uses.set(`${a}|${b}`, (uses.get(`${a}|${b}`) ?? 0) + 1);
  }
  return [...uses.values()].filter((n) => n !== 2).length;
};

const WAY_PROFILE = { origin: [X0, Y0], direction: [1, 0], points: [[0, 130.6], [20, 133.75], [55, 138.95], [100, 146.68], [110, 148.9]] };
const FILE = collection([
  feature({ id: 'P-WAY', kind: 'platform', type: 'platform', topProfile: WAY_PROFILE, bottomM: 125, material: 'paving', estimated: true, grade: 'S-MAP', source: 's' }, rect(-5, 0, 120, 12)),
  feature({ id: 'P-FLAT', kind: 'platform', type: 'platform', topM: 132.5, bottomM: 128, material: 'concrete', source: 's' }, rect(0, 20, 10, 10)),
  feature({ id: 'V-1', kind: 'void', type: 'void', fromM: 128.5, toM: 131.5, inside: 'P-WAY', source: 's' }, rect(10, 2, 30, 7)),
  feature({ id: 'S-01', kind: 'extrude', type: 'stair_step', stair: 'S', fromM: 130, toM: 130.15, riseM: 0.15, runM: 0.3, widthM: 2, source: 's' }, rect(0, 40, 0.3, 2)),
  feature({ id: 'W-1', kind: 'extrude', type: 'wall', fromM: 130, toM: 131, source: 's' }, rect(0, 50, 4, 0.3)),
  feature({ id: 'NEW-BOX', kind: 'bench', type: 'bench', fromM: 130, toM: 130.45, source: 's' }, rect(0, 60, 2, 0.5)),
  feature({ id: 'NEW-PRISM', kind: 'mound', topM: 133, bottomM: 131, source: 's' }, rect(0, 70, 2, 2)),
  feature({ id: 'NO-HEIGHT', kind: 'tree', source: 's' }, rect(0, 80, 1, 1)),
  feature({ id: 'BAD-BOX', kind: 'extrude', type: 'wall', fromM: 131, toM: 130, source: 's' }, rect(0, 90, 1, 1)),
  { type: 'Feature', properties: { id: 'NO-GEOMETRY', kind: 'extrude', fromM: 1, toM: 2 }, geometry: null },
  { type: 'Feature', properties: { id: 'A-LINE', kind: 'extrude', fromM: 1, toM: 2 }, geometry: { type: 'LineString', coordinates: [[X0, Y0], [X0 + 1, Y0]] } },
  feature({ id: 'GEN', kind: 'stair', type: 'stair', fromM: 130.6, toM: 132.9, risers: 12, direction: [0, 1], sideWallM: 0.9, source: 's' }, rect(20, 40, 3, 3.6)),
]);

test('구조물 파일 읽기: 아는 종류, 모르는 종류는 상자로, 높이 없는 것은 빼고 이름을 남긴다 (예외 없음)', () => {
  const { solids, skipped } = parseStructures('t.geojson', FILE);
  const of = (id: string) => solids.filter((s: any) => s.id === id);
  assert.equal(of('P-WAY')[0].role, 'platform');
  assert.equal(of('P-WAY')[0].topM, 148.9);
  assert.equal(of('P-WAY')[0].estimated, true);
  assert.equal(of('P-FLAT')[0].material, 'concrete');
  assert.equal(of('V-1')[0].role, 'void');
  assert.deepEqual([of('V-1')[0].bottomM, of('V-1')[0].topM], [128.5, 131.5]);
  assert.equal(of('S-01')[0].stair, 'S');
  // 모르는 종류: 높이가 있으면 상자(땅으로 치지는 않는다)
  assert.equal(of('NEW-BOX')[0].role, 'box');
  assert.equal(of('NEW-PRISM')[0].role, 'box');
  assert.deepEqual([of('NEW-PRISM')[0].bottomM, of('NEW-PRISM')[0].topM], [131, 133]);
  assert.equal(skipped.length, 4);
  for (const id of ['NO-HEIGHT', 'BAD-BOX', 'NO-GEOMETRY', 'A-LINE']) assert.ok(skipped.some((s: string) => s.startsWith(id)), id);
  // 망가진 입력
  assert.deepEqual(parseStructures('x', null).solids, []);
  assert.deepEqual(parseStructures('x', { features: [null, 3, {}] }).solids, []);
  assert.deepEqual(parseStructures('x', { ...collection([]), crs: { properties: { name: 'EPSG:4326' } }, features: FILE.features }).solids, []);
  // 길 면이 비켜 줄 곳: 기단과 계단 단
  const ex = surfaceExclusions(solids);
  assert.equal(ex.platforms.length, 2);
  assert.equal(ex.platforms[1].top(X0 + 5, Y0 + 25), 132.5);
  assert.equal(ex.treads.length, 1 + 12);
});

test('계단 만들기: N단 → 상자 N개, 마지막 단이 정확히 위 높이, 단 높이 일정, 평면을 빈틈없이 나눔', () => {
  const ring = rect(0, 0, 3, 3.6);
  for (const n of [1, 5, 12, 17]) {
    const { steps, walls } = stairSteps({ ring, direction: [0, 2], fromM: 130.6, toM: 132.9, risers: n });
    assert.equal(steps.length, n);
    assert.equal(walls.length, 0);
    assert.equal(steps[n - 1].toM, 132.9);
    steps.forEach((s: any, k: number) => {
      assert.ok(Math.abs(s.toM - (130.6 + ((132.9 - 130.6) * (k + 1)) / n)) < 1e-9);
      assert.equal(s.fromM, 130.6); // 아래는 계단 발치까지
      assert.ok(Math.abs(ringArea(s.ring) - (3 * 3.6) / n) < 1e-6);
      // 오르는 방향(+y)으로 차례대로
      assert.ok(Math.abs(Math.min(...s.ring.map((p: P) => p[1])) - (Y0 + (3.6 * k) / n)) < 1e-6);
    });
  }
  // 비스듬한 방향, 옆 벽
  const made = stairSteps({ ring, direction: [1, 1], fromM: 100, toM: 101, risers: 4, sideWallM: 0.9, sideWallThicknessM: 0.2, baseM: 99 });
  assert.equal(made.steps.length, 4);
  assert.ok(Math.abs(made.steps.reduce((s: number, st: any) => s + ringArea(st.ring), 0) - 3 * 3.6) < 1e-6);
  assert.ok(made.walls.length >= 4);
  assert.ok(made.steps.every((s: any) => s.fromM === 99));
  assert.ok(made.walls.every((w: any) => made.steps.some((s: any) => Math.abs(w.toM - s.toM - 0.9) < 1e-9)));
  // 파일에 계단 하나로 적힌 것: 단 12개 + 옆 벽
  const gen = parseStructures('t', FILE).solids.filter((s: any) => s.id === 'GEN');
  assert.equal(gen.filter((s: any) => s.type === 'stair_step').length, 12);
  assert.equal(Math.max(...gen.filter((s: any) => s.type === 'stair_step').map((s: any) => s.topM)), 132.9);
  assert.equal(gen.filter((s: any) => s.type === 'wall').length, 24);
});

test('기운 기단 윗면: 조각마다 참 평면(삼각형 안 어디서나 종단 값), 꺾이는 곳에서 잘림', () => {
  const way = parseStructures('t', FILE).solids.find((s: any) => s.id === 'P-WAY');
  const top = topHeight(way);
  assert.equal(top(X0 - 3, Y0 + 5), 130.6); // 끝 밖은 끝 값
  assert.equal(top(X0 + 500, Y0), 148.9);
  assert.ok(Math.abs(top(X0 + 10, Y0 + 3) - (130.6 + 3.15 / 2)) < 1e-9);
  assert.equal(top(X0 + 10, Y0 + 11), top(X0 + 10, Y0 + 1)); // 폭 방향으로 평평
  const { mesh } = solidMesh(way);
  const tops = trianglesOf(mesh, SOLID_STRIDE).filter((t) => t.every((p) => p[4] === 1));
  assert.ok(tops.length >= 6);
  let area = 0;
  for (const t of tops) {
    area += ringArea(t);
    for (const p of t) assert.ok(Math.abs(p[2] - top(p[0], p[1])) < 1e-9);
    // 삼각형 안의 점(무게중심, 변의 가운데)에서도 면 높이 = 종단 높이
    const mids = [[0, 1], [1, 2], [2, 0]].map(([a, b]) => t[a].map((v, k) => (v + t[b][k]) / 2));
    const centre = t[0].map((v, k) => (v + t[1][k] + t[2][k]) / 3);
    for (const p of [...mids, centre]) assert.ok(Math.abs(p[2] - top(p[0], p[1])) < 1e-6, `${p}`);
  }
  assert.ok(Math.abs(area - 120 * 12) < 1e-3);
  // 길 색을 칠할 조각도 같은 면 위
  const piece = topMesh(way, [[rect(30, 2, 40, 5)]]);
  for (const t of trianglesOf(piece, 3)) for (const p of t) assert.ok(Math.abs(p[2] - top(p[0], p[1])) < 1e-9);
});

test('덩어리는 닫혀 있다: 윗면·옆면·밑면, 옆면은 바닥까지 세로, 구멍 있는 평면도', () => {
  const solids = parseStructures('t', FILE).solids;
  for (const id of ['P-WAY', 'P-FLAT', 'S-01', 'W-1', 'NEW-PRISM']) {
    const solid = solids.find((s: any) => s.id === id);
    const { mesh, edges } = solidMesh(solid);
    assert.equal(openEdges(mesh, SOLID_STRIDE), 0, id);
    const tris = trianglesOf(mesh, SOLID_STRIDE);
    const zs = tris.flat().map((p) => p[2]);
    assert.equal(Math.min(...zs), solid.bottomM);
    assert.equal(Math.max(...zs), solid.topM);
    // 옆면: 평면에서 넓이가 0 (세로), 윗면보다 어둡다
    const sides = tris.filter((t) => t.every((p) => p[4] === 0) && ringArea(t) < 1e-9);
    assert.ok(sides.length >= 8, id);
    assert.ok(sides.every((t) => t[0][3] < 1 && t[0][3] > 0.5));
    assert.ok(edges.length >= 4);
  }
  // 빛(남서)을 보는 옆면이 더 밝다
  const flat = solidMesh(solids.find((s: any) => s.id === 'P-FLAT')).mesh;
  const sides = trianglesOf(flat, SOLID_STRIDE).filter((t) => t.every((p) => p[4] === 0) && ringArea(t) < 1e-9);
  const shadeAt = (test: (p: P) => boolean) => sides.find((t) => t.every(test))![0][3];
  assert.ok(shadeAt((p) => Math.abs(p[1] - (Y0 + 20)) < 1e-6) > shadeAt((p) => Math.abs(p[1] - (Y0 + 30)) < 1e-6)); // 남쪽 면 > 북쪽 면
  // 구멍 있는 덩어리, 낮춘 바닥, 윗면 뺀 덩어리
  const holed = { ...solids.find((s: any) => s.id === 'P-FLAT'), polygon: [rect(0, 0, 10, 10), [...rect(4, 4, 2, 2)].reverse()] };
  assert.equal(openEdges(solidMesh(holed).mesh, SOLID_STRIDE), 0);
  const lowered = solidMesh(holed, { bottomAt: () => 120 }).mesh;
  assert.equal(Math.min(...trianglesOf(lowered, SOLID_STRIDE).flat().map((p) => p[2])), 120);
  const noTop = solidMesh(holed, { top: false }).mesh;
  assert.equal(trianglesOf(noTop, SOLID_STRIDE).filter((t) => t.every((p) => p[4] === 1)).length, 0);
  // 이웃 기단 속에 묻히는 옆면은 뺀다: 동쪽(x = X0 + 10 바깥)에 이웃이 있다고 하면 그 면만 없다
  const sideCount = (m: any) => trianglesOf(m, SOLID_STRIDE).filter((t) => t.every((p) => p[4] === 0) && ringArea(t) < 1e-9).length;
  const solid = solids.find((s: any) => s.id === 'P-FLAT');
  const culled = solidMesh(solid, { hiddenSide: (x: number) => x > X0 + 10 }).mesh;
  assert.equal(sideCount(solidMesh(solid).mesh) - sideCount(culled), 2);
  assert.ok(trianglesOf(culled, SOLID_STRIDE).filter((t) => t.every((p) => p[4] === 0) && ringArea(t) < 1e-9).every((t) => !t.every((p) => Math.abs(p[0] - (X0 + 10)) < 1e-6)));
});

test('단면: 상자를 면에서 정확히 자르고, 자른 면은 [구간] × [아래, 위], 빈 곳은 구멍', () => {
  const solids = parseStructures('t', FILE).solids;
  const flat = solids.find((s: any) => s.id === 'P-FLAT');
  // x = X0 + 4 를 지나 북쪽으로 가는 선: 남는 쪽은 왼쪽(서쪽, x < X0 + 4)
  const plane = sectionPlane([X0 + 4, Y0], [X0 + 4, Y0 + 100]);
  const cut = clipMesh(plane, solidMesh(flat).mesh, SOLID_STRIDE);
  const tris = trianglesOf(cut, SOLID_STRIDE);
  assert.ok(tris.flat().every((p) => p[0] <= X0 + 4 + 1e-9));
  const topArea = tris.filter((t) => t.every((p) => Math.abs(p[2] - 132.5) < 1e-9)).reduce((s, t) => s + ringArea(t), 0);
  assert.ok(Math.abs(topArea - 4 * 10) < 1e-6);
  const caps = sectionCaps(plane, flat);
  assert.equal(caps.length, 1);
  assert.ok(Math.abs(polygonArea(caps[0]) - 10 * (132.5 - 128)) < 1e-6);
  const ds = caps[0][0].map((p: P) => p[0]), zs = caps[0][0].map((p: P) => p[1]);
  assert.deepEqual([Math.min(...ds), Math.max(...ds), Math.min(...zs), Math.max(...zs)], [20, 30, 128, 132.5]);
  assert.deepEqual(sectionCaps(sectionPlane([X0 + 50, Y0], [X0 + 50, Y0 + 100]), flat), []); // 면이 안 지나면 없음

  // 기운 기단을 길이 방향으로 자르면: 윗선이 종단, 지하 차도 자리는 구멍
  const way = solids.find((s: any) => s.id === 'P-WAY');
  const voids = solids.filter((s: any) => s.role === 'void');
  const along = sectionPlane([X0 - 20, Y0 + 5], [X0 + 130, Y0 + 5]);
  const whole = sectionCaps(along, way);
  const holed = sectionCaps(along, way, voids);
  const area = (polys: P[][][]) => polys.reduce((s, p) => s + polygonArea(p), 0);
  // 종단 아래 넓이(사다리꼴 합) − 바닥 125 m
  const pts = WAY_PROFILE.points;
  let under = 5 * (130.6 - 125) + 5 * (148.9 - 125);
  for (let i = 1; i < pts.length; i++) under += (pts[i][0] - pts[i - 1][0]) * ((pts[i][1] + pts[i - 1][1]) / 2 - 125);
  assert.ok(Math.abs(area(whole) - under) < 1e-3, `${area(whole)} ${under}`);
  assert.ok(Math.abs(area(whole) - area(holed) - 30 * 3) < 1e-3);
  assert.equal(holed[0].length, 2); // 바깥 고리 + 구멍 하나
  const filled = fillPolygons(holed);
  let tri = 0;
  for (let i = 0; i < filled.indices.length; i += 3) tri += ringArea([0, 1, 2].map((k) => filled.points[filled.indices[i + k]]));
  assert.ok(Math.abs(tri - area(holed)) < 1e-3);
});

test('우선순위: 기단 안과 계단 단 밑에는 길 면을 그리지 않고, 기단 위 부분은 색칠할 다각형으로 돌려준다', () => {
  const ground = () => 130;
  const road = (id: string, structure: string, roadClass: string, coordinates: P[], widthM: number) => ({ id, name: null, roadClass, structure, widthM, levelId: null, buildingId: null, fromNodeId: `${id}a`, toNodeId: `${id}b`, geometry: { coordinates } });
  const roads = [
    road('car', 'surface', 'vehicle', [[X0 - 40, Y0 + 6, 130], [X0 + 60, Y0 + 6, 130]], 6), // 기단(x 0..40)을 가로지르는 차도
    road('steps', 'stairs', 'pedestrian', [[X0 + 80, Y0 - 10, 130], [X0 + 80, Y0 + 10, 132]], 2), // 구조물 계단과 겹치는 계단 길
    road('far', 'stairs', 'pedestrian', [[X0 + 120, Y0 - 10, 130], [X0 + 120, Y0 + 10, 132]], 2), // 구조물 없는 계단 길
  ];
  const platform = [rect(0, 0, 40, 12)];
  const treads = Array.from({ length: 10 }, (_, k) => [rect(78.7, -4 + k * 0.8, 2.6, 0.8)]); // 길보다 0.3 m 넓은 계단 단, y −4 .. 4
  const plain = buildPavedSurfaces({ roads, areas: [], buildings: [], ground });
  const built = buildPavedSurfaces({ roads, areas: [], buildings: [], ground, exclude: { platforms: [{ polygon: platform, top: () => 130 }], treads, ...PRECEDENCE } });
  // 기단 위를 지나는 보행로·계단 띠는 기단에 색을 칠하지 않는다(기단이 곧 걷는 면)
  const walk = buildPavedSurfaces({ roads: [road('walk', 'surface', 'pedestrian', [[X0 - 40, Y0 + 6, 130], [X0 + 60, Y0 + 6, 130]], 3), road('st', 'stairs', 'pedestrian', [[X0 + 20, Y0 - 20, 130], [X0 + 20, Y0 + 30, 130]], 2)], areas: [], buildings: [], ground, exclude: { platforms: [{ polygon: platform, top: () => 130 }], treads: [], ...PRECEDENCE } });
  assert.deepEqual(walk.covered, []);
  assert.ok(walk.surfaces.every((s: any) => polygonOps('both', s.drawn, [platform]).length === 0));
  const shape = (s: any) => s.drawn as P[][][];
  const overlap = (a: P[][][], b: P[][][]) => polygonOps('both', a, b).reduce((sum: number, p: P[][]) => sum + polygonArea(p), 0);
  const of = (r: any, m: string) => r.surfaces.find((s: any) => s.material === m);
  // 구조물이 없으면 전과 같다: 차도가 기단 자리를 지나고, 색칠 조각은 없다
  assert.deepEqual(plain.covered, []);
  assert.ok(overlap(shape(of(plain, 'carriageway')), [platform]) > 200);
  // 기단 안에는 차도 면이 없고, 그 부분(폭 6 m × 길이 40 m)이 색칠 조각으로 나온다
  assert.ok(overlap(shape(of(built, 'carriageway')), [platform]) < 1e-6);
  const tint = built.covered.find((c: any) => c.material === 'carriageway');
  assert.ok(Math.abs(tint.polygons.reduce((s: number, p: P[][]) => s + polygonArea(p), 0) - 240) < 1, `${JSON.stringify(tint.polygons.map(polygonArea))}`);
  // 기단 밖 차도는 그대로: 기단 가장자리에서 곧게 끝난다
  const points = shape(of(built, 'carriageway')).flat(2);
  assert.ok(points.every((p: P) => p[0] <= X0 + 1e-6 || p[0] >= X0 + 40 - 1e-6));
  for (const x of [X0, X0 + 40]) {
    const ys = points.filter((p: P) => Math.abs(p[0] - x) < 1e-6).map((p: P) => p[1]);
    assert.ok(Math.abs(Math.min(...ys) - (Y0 + 3)) < 0.01 && Math.abs(Math.max(...ys) - (Y0 + 9)) < 0.01, `${x}: ${Math.min(...ys)} ${Math.max(...ys)}`); // 모서리를 둥글리지 않는다
  }
  // 계단 길: 구조물 계단 자리와 그 둘레 1 m 안에는 띠가 없다, 떨어진 계단 길은 그대로
  const stairs = shape(of(built, 'stairs'));
  assert.ok(overlap(stairs, treads) < 1e-6);
  assert.ok(stairs.flat(2).every((p: P) => Math.abs(p[0] - (X0 + 120)) < 2 || p[1] <= Y0 - 5 + 1e-6 || p[1] >= Y0 + 5 - 1e-6));
  assert.ok(overlap(stairs, [[rect(118, -10, 4, 20)]]) > 35);
  // 기단 가장자리에서: 길 높이가 기단 윗면과 0.5 m 안이면 3 m 에 걸쳐 기단 높이로 맞추고(턱 없음), 더 다르면 그대로 둔다(벽면)
  const edgeZ = (top: number) => {
    const r = buildPavedSurfaces({ roads: [roads[0]], areas: [], buildings: [], ground, exclude: { platforms: [{ polygon: platform, top: () => top }], treads: [], ...PRECEDENCE } });
    const vs = trianglesOf(of(r, 'carriageway').mesh, 4).flat();
    return { at: vs.filter((p) => Math.abs(p[0] - X0) < 1e-6).map((p) => p[2]), far: vs.filter((p) => p[0] < X0 - 4).map((p) => p[2]) };
  };
  const near = edgeZ(130.3), wall = edgeZ(131.5);
  assert.ok(near.at.length > 3 && near.at.every((z) => Math.abs(z - 130.3) < 1e-9));
  assert.ok(near.far.every((z) => Math.abs(z - 130) < 1e-9));
  assert.ok(wall.at.every((z) => Math.abs(z - 130) < 1e-9));
  // 구조물 옆에는 치마가 없다(구조물의 옆면이 그 자리다)
  const skirtAt = (r: any, x: number) => trianglesOf(of(r, 'carriageway').skirt, 3).filter((t) => t.every((p) => Math.abs(p[0] - x) < 1e-6)).length;
  assert.equal(skirtAt(built, X0), 0);
  // 바닥을 면에 맞춰 그리는 곳(flush)에서는 치마가 면 아래로만 짧게
  const high = () => 140;
  const up = buildPavedSurfaces({ roads: [roads[0]], areas: [], buildings: [], ground: high });
  const flush = buildPavedSurfaces({ roads: [roads[0]], areas: [], buildings: [], ground: high, flush: () => true });
  const zRange = (r: any) => { const zs = trianglesOf(of(r, 'carriageway').skirt, 3).flat().map((p) => p[2]); return Math.max(...zs) - Math.min(...zs); };
  assert.ok(zRange(up) > 0.4);
  assert.ok(zRange(flush) < 0.6 && zRange(flush) > 0.4);
});

test('실제 구조물 파일(G02)이 있으면: 전부 읽히고 덩어리가 닫혀 있다', (t) => {
  const path = new URL('../public/structures/g02-way.geojson', import.meta.url);
  if (!fs.existsSync(path)) return t.skip('파일 없음');
  const { solids, skipped } = parseStructures('g02-way.geojson', JSON.parse(fs.readFileSync(path, 'utf8')));
  assert.ok(solids.length > 100);
  assert.deepEqual(skipped, []);
  for (const s of solids) {
    const { mesh } = solidMesh(s);
    assert.ok(mesh.indices.length > 0, s.id);
    assert.equal(openEdges(mesh, SOLID_STRIDE), 0, s.id);
  }
  // 같은 계단의 단은 아래에서 위로 높이가 오른다
  const stairs = new Map<string, number[]>();
  for (const s of solids) if (s.stair) stairs.set(s.stair, [...(stairs.get(s.stair) ?? []), s.topM]);
  for (const [name, tops] of stairs) assert.ok(tops.every((z, i) => i === 0 || z > tops[i - 1]), name);
});

test('화단 기단은 윗면만 초록이고 옆면은 벽 색, 상자의 재질 색은 종류 색보다 먼저다', async () => {
  const { STRUCTURES, solidColors } = await import('../src/structures.ts');
  const solid = (role: string, type: string, material?: string) => ({ role, type, material }) as any;
  assert.deepEqual(solidColors(solid('platform', 'platform', 'planting')), { body: STRUCTURES.plantingSide, top: STRUCTURES.planterTop });
  assert.deepEqual(solidColors(solid('platform', 'platform', 'paving')), { body: STRUCTURES.materials.paving, top: STRUCTURES.materials.paving });
  // 캠퍼스 밖 공도(asphalt): 윗면은 차도 색, 옆면은 벽 색. 상자의 material(벽돌·유리 등)은 종류 색보다 먼저다
  assert.deepEqual(solidColors(solid('platform', 'platform', 'asphalt')), { body: STRUCTURES.asphaltSide, top: STRUCTURES.materials.asphalt });
  assert.equal(solidColors(solid('box', 'wall', 'brick')).body, STRUCTURES.boxMaterials.brick);
  assert.equal(solidColors(solid('box', 'deck', 'concrete')).body, STRUCTURES.boxMaterials.concrete);
  assert.equal(solidColors(solid('box', 'deck', 'timber')).body, STRUCTURES.types.deck);
  assert.equal(solidColors(solid('box', 'canopy', 'opening')).top, STRUCTURES.boxMaterials.opening);
});

test('Z07: 상자는 제 색(color, topColor)을 가질 수 있다. 기단은 아니다', async () => {
  const { STRUCTURES, solidColors } = await import('../src/structures.ts');
  const solid = (role: string, type: string, props: Record<string, unknown>, material?: string) => ({ role, type, material, props }) as any;
  assert.deepEqual(solidColors(solid('box', 'wall', { color: '#5f9a86', topColor: '#7f9a6b' })), { body: '#5f9a86', top: '#7f9a6b' });
  assert.deepEqual(solidColors(solid('box', 'wall', { color: '#5f9a86' }, 'brick')), { body: '#5f9a86', top: '#5f9a86' });
  assert.equal(solidColors(solid('box', 'wall', { color: 'green' }, 'brick')).body, STRUCTURES.boxMaterials.brick);
  assert.equal(solidColors(solid('platform', 'platform', { color: '#5f9a86' }, 'paving')).body, STRUCTURES.materials.paving);
});

test('Z09 기운 판(thicknessM): 밑면이 윗면과 나란하다, 닫힌 덩어리, 단면도 평행사변형', () => {
  const profile = { origin: [X0, Y0], direction: [1, 0], points: [[0, 140], [10, 141]] };
  const { solids, skipped } = parseStructures('t.geojson', collection([feature({ id: 'COVER', kind: 'extrude', type: 'canopy', fromM: 139, toM: 141, topProfile: profile, thicknessM: 0.25 }, rect(0, 0, 10, 3))]));
  assert.equal(skipped.length, 0);
  const s = solids[0];
  assert.equal(s.thicknessM, 0.25);
  assert.equal(s.bottomM, 139.75);
  const { mesh } = solidMesh(s);
  assert.equal(openEdges(mesh, SOLID_STRIDE), 0);
  const top = topHeight(s);
  for (let i = 0; i < mesh.positions.length; i += SOLID_STRIDE) {
    const [x, y, z] = mesh.positions.slice(i, i + 3);
    assert.ok(Math.abs(z - top(x, y)) < 1e-9 || Math.abs(z - (top(x, y) - 0.25)) < 1e-9);
  }
  const caps = sectionCaps(sectionPlane([X0 - 1, Y0 + 1.5], [X0 + 11, Y0 + 1.5]), s);
  const heights = caps.flat(2).map((p) => p[1]).sort((a, b) => a - b);
  assert.ok(Math.abs(heights[0] - 139.75) < 1e-6 && Math.abs(heights[heights.length - 1] - 141) < 1e-6);
});

test('U02: 운동장 아래 두 층은 이름 있는 빈 곳이고 슬래브 기단의 자른 면에서 구멍 두 개가 된다', async () => {
  const { voidName } = await import('../src/structures.ts');
  const file = JSON.parse(fs.readFileSync(new URL('../public/structures/u01-field-basement.geojson', import.meta.url), 'utf8'));
  const { solids, skipped } = parseStructures('u01', file);
  assert.deepEqual(skipped, []);
  const b1 = solids.find((s: any) => s.id === 'U02-VOID-B1'), b2 = solids.find((s: any) => s.id === 'U02-VOID-B2');
  assert.deepEqual([b1.role, voidName(b1), b2.role, voidName(b2)], ['void', '운동장 지하 1층', 'void', '운동장 지하 2층']);
  assert.equal(voidName({ props: {} } as any), '빈 곳');
  // 사용자 붉은 선(±1 m): 지하 1층 띠 약 140.1~144.4, 지하 2층 바닥 약 133. 지하 1층 천장 위 4 m 넘게는 빈 층 없이 구조, 두 층 사이는 바닥 판
  assert.ok(Math.abs(b1.topM - 144.4) <= 1 && b1.bottomM >= 140.1 && b1.bottomM <= 141.7 && Math.abs(b2.bottomM - 133) <= 1 && Math.abs(b2.topM - 140.1) <= 1);
  assert.ok(148.9 - b1.topM > 4 && b2.topM < b1.bottomM && b2.bottomM < b2.topM);
  assert.ok(!solids.some((s: any) => s.role === 'void' && s.id !== 'U02-VOID-FIELD-STAIR' && s.topM > 144.7 + 1e-9));
  // 지하 차도 연장의 바닥은 서쪽에서 동쪽으로 내려가지 않는다(계단 없는 한 경사), 끝은 지하 1층 바닥이다(지하 1층으로 들어온다)
  const road = solids.filter((s: any) => /^U02-VOID-ROAD-\d+$/.test(s.id)).sort((a: any, b: any) => a.id.localeCompare(b.id));
  assert.ok(road.length > 5 && road.every((s: any, i: number) => i === 0 || s.bottomM >= road[i - 1].bottomM) && Math.abs(road[road.length - 1].bottomM - b1.bottomM) < 1e-9);
  // 슬래브 기단을 가로로 자른 면: 두 층이 구멍으로 빠져 넓이가 준다
  const field = parseStructures('z02', JSON.parse(fs.readFileSync(new URL('../public/structures/z02-daeil-front.geojson', import.meta.url), 'utf8'))).solids.find((s: any) => s.id === 'Z02-PLATFORM-FIELD');
  assert.equal(topHeight(field)(201190, 557245), 148.9);
  const plane = sectionPlane([201150, 557245], [201230, 557245]);
  const area = (polys: P[][][]) => polys.reduce((s, p) => s + polygonArea(p), 0);
  const whole = area(sectionCaps(plane, field)), holed = area(sectionCaps(plane, field, [b1, b2]));
  assert.ok(whole - holed > 60 * ((b1.topM - b1.bottomM) + (b2.topM - b2.bottomM)), `${whole} ${holed}`);
  // U07 층 사이 경사로: 기운 윗면의 상자들(운동장 면을 가리는 계단·참이 아니다). 지하 1층 바닥에서 지하 2층 바닥까지 끊김 없이 내려가고 15 % 를 넘지 않는다(굽은 조각은 현의 길이로 재므로 0.2 %p 여유)
  const ramp = solids.filter((s: any) => s.id.startsWith('U07-RAMP-SEG-')).sort((a: any, b: any) => a.id.localeCompare(b.id));
  const last = ramp.length - 1;
  assert.ok(ramp.length > 10 && ramp.every((s: any) => s.role === 'box' && s.type === 'ramp' && s.profile));
  const ends = ramp.map((s: any) => s.profile.points.map((q: number[]) => q[1]));
  assert.ok(Math.abs(ends[0][0] - b1.bottomM) < 1e-9 && Math.abs(ends[last][1] - b2.bottomM) < 0.03 && ends.every((q: number[], i: number) => q[1] < q[0] && (i === 0 || Math.abs(q[0] - ends[i - 1][1]) < 0.011)));
  assert.ok(ramp.every((s: any) => (s.profile.points[0][1] - s.profile.points[1][1]) / s.profile.points[1][0] <= 0.152), 'grade');
  const runM = ramp.reduce((t: number, s: any) => t + s.profile.points[1][0], 0);
  assert.ok((b1.bottomM - b2.bottomM) / runM <= 0.152, `${runM}`);
  // 바닥 구멍 = 학교 지하도 지도의 굽은 부채꼴(docs/audit/u07/crescent.json): 모든 꼭짓점이 안쪽·바깥 반지름 사이, 은주관 문(201146.21, 557283.45)의 남쪽
  const cr = JSON.parse(fs.readFileSync(new URL('../../docs/audit/u07/crescent.json', import.meta.url), 'utf8'));
  const hole = solids.find((s: any) => s.id === 'U02-VOID-RAMP-OPENING');
  const radii = hole.polygon[0].map((q: number[]) => Math.hypot(q[0] - cr.centre[0], q[1] - cr.centre[1]));
  assert.ok(radii.every((r: number) => r > cr.innerRadiusM - 0.03 && r < cr.outerRadiusM + 0.03) && Math.abs(Math.max(...radii) - cr.outerRadiusM) < 0.03 && Math.abs(Math.min(...radii) - cr.innerRadiusM) < 0.03, 'opening = crescent');
  assert.ok(Math.max(...hole.polygon[0].map((q: number[]) => q[1])) < 557283.45 - 4, 'opening south of the door');
  assert.ok(!solids.some((s: any) => s.id.startsWith('U06-FORK-') || s.id.startsWith('U06-RAMP-SEG-')), 'U06 의 갈림·옛 경사로 조각은 없다');
  assert.equal(surfaceExclusions(solids).treads.length, 0);
});
