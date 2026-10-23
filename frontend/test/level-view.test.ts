import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { INTERIOR, LEVEL_VIEW, WALK, baseBuildingId, buildingFloors, carvedFloor, parseInteriors, cutRoad, explode, feetHeight, floorInText, floorIndexAt, floorOfRoad, isWideRoad, parseZones, roadHeightAt, shortName, walkSurfaces, zoneAt, zoneContent } = await import('../src/level-view.ts');
const { parseStructures } = await import('../src/structures.ts');
const { polygonArea, polygonOps } = await import('../src/polygon-ops.ts');
const { LINE_PX, VIEW_STYLE_DEFAULT, normalizeViewStyle, onViewStyle, setViewStyle, viewStyle } = await import('../src/view-style.ts');

const X0 = 201000, Y0 = 557300;
const rect = (x: number, y: number, w: number, h: number) => [[X0 + x, Y0 + y], [X0 + x + w, Y0 + y], [X0 + x + w, Y0 + y + h], [X0 + x, Y0 + y + h]];
const zoneFeature = (properties: object, ring: number[][]) => ({ type: 'Feature', properties, geometry: { type: 'MultiPolygon', coordinates: [[[...ring, ring[0]]]] } });
const road = (id: string, coordinates: number[][], more: object = {}) => ({ id, name: null, roadClass: 'pedestrian', structure: 'ordinary', widthM: null, levelId: null, buildingId: null, geometry: { coordinates }, ...more });
const zones = parseZones({ features: [
  zoneFeature({ id: 'a', name: '가', layer: 'ground' }, rect(0, 0, 20, 20)),
  zoneFeature({ id: 'b', name: '나', layer: 'ground' }, rect(20, 0, 20, 20)),
  zoneFeature({ id: 'u', name: '지하 1층', layer: 'underground', fromM: 141.4, toM: 144.4, floorM: 141.4 }, rect(5, 5, 20, 10)),
  zoneFeature({ id: 'bad', name: '범위 없는 지하', layer: 'underground' }, rect(100, 0, 5, 5)),
  { type: 'Feature', properties: { id: 'x' }, geometry: null },
] });

test('구획 읽기: 지하는 높이 범위가 있어야 지하, 도형 없는 것은 뺌', () => {
  assert.deepEqual(zones.map((z: { id: string; layer: string }) => [z.id, z.layer]), [['a', 'ground'], ['b', 'ground'], ['u', 'underground'], ['bad', 'ground']]);
  assert.equal(zones[0].polygons[0][0].length, 4); // 닫는 점은 뺌
  assert.equal(zones[2].floorM, 141.4);
});

test('점의 구획: 높이가 지하 범위 안이면 지하 구획, 아니면 지상', () => {
  assert.equal(zoneAt(zones, X0 + 10, Y0 + 10)?.id, 'a');
  assert.equal(zoneAt(zones, X0 + 10, Y0 + 10, 142)?.id, 'u');
  assert.equal(zoneAt(zones, X0 + 10, Y0 + 10, 148.9)?.id, 'a'); // 운동장 높이: 지하 범위 밖
  assert.equal(zoneAt(zones, X0 + 30, Y0 + 2, 142)?.id, 'b');
  assert.equal(zoneAt(zones, X0 - 50, Y0), null);
});

test('길을 구획 경계에서 자름: 안쪽 조각, 이웃으로 나가는 꼬리, 안쪽 비율', () => {
  const cut = cutRoad([[X0 + 10, Y0 + 10, 100], [X0 + 30, Y0 + 10, 110]], zones[0]);
  assert.equal(cut.pieces.length, 1);
  assert.deepEqual(cut.pieces[0], [[X0 + 10, Y0 + 10, 100], [X0 + 20, Y0 + 10, 105]]); // 경계에서 높이도 이어짐
  assert.equal(cut.stubs.length, 1);
  assert.deepEqual(cut.stubs[0][0], [X0 + 20, Y0 + 10, 105]);
  assert.ok(Math.abs(cut.stubs[0][1][0] - (X0 + 20 + LEVEL_VIEW.stubM)) < 1e-9);
  assert.ok(Math.abs(cut.share - 0.5) < 1e-9);
  // U05: 차도(폭 4 m 이상의 차량 길)의 꼬리는 길게(터널 들머리가 들어오는 길로 읽히게)
  assert.ok(Math.abs(cutRoad([[X0 + 10, Y0 + 10, 100], [X0 + 60, Y0 + 10, 110]], zones[0], LEVEL_VIEW.stubWideM).stubs[0][1][0] - (X0 + 20 + LEVEL_VIEW.stubWideM)) < 1e-9);
  assert.equal(isWideRoad({ roadClass: 'vehicle', widthM: 7.2 }), true);
  assert.equal(isWideRoad({ roadClass: 'vehicle', widthM: null }), false);
  assert.equal(isWideRoad({ roadClass: 'pedestrian', widthM: 7.2 }), false);
  // 지나가는 길: 조각 하나에 꼬리 둘
  const through = cutRoad([[X0 - 5, Y0 + 3, 1], [X0 + 25, Y0 + 3, 1]], zones[0]);
  assert.equal(through.pieces.length, 1);
  assert.equal(through.stubs.length, 2);
  // 밖에만 있는 길
  assert.equal(cutRoad([[X0 + 50, Y0, 1], [X0 + 60, Y0, 1]], zones[0]).pieces.length, 0);
});

test('지하 구획은 높이 범위 안의 길만: 위를 지나는 지상 길은 아님', () => {
  assert.equal(cutRoad([[X0 + 6, Y0 + 8, 148.9], [X0 + 20, Y0 + 8, 148.9]], zones[2]).pieces.length, 0);
  assert.equal(cutRoad([[X0 + 6, Y0 + 8, 141.4], [X0 + 20, Y0 + 8, 141.4]], zones[2]).pieces.length, 1);
});

test('구획에 속한 것: 지상은 실내·지하 길과 빈 곳 속 구조물을 빼고, 지하는 범위에 걸친 상자만 범위로 잘라', () => {
  const fc = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { id: 'P', kind: 'platform', topM: 148.9, bottomM: 130 }, geometry: { type: 'Polygon', coordinates: [[...rect(0, 0, 20, 20), rect(0, 0, 20, 20)[0]]] } },
    { type: 'Feature', properties: { id: 'PILLAR', kind: 'extrude', type: 'wall', fromM: 133, toM: 144.4, inVoid: true }, geometry: { type: 'Polygon', coordinates: [[...rect(8, 8, 1, 1), rect(8, 8, 1, 1)[0]]] } },
    { type: 'Feature', properties: { id: 'V', kind: 'void', fromM: 141.4, toM: 144.4 }, geometry: { type: 'Polygon', coordinates: [[...rect(5, 5, 20, 10), rect(5, 5, 20, 10)[0]]] } },
    { type: 'Feature', properties: { id: 'TREE', kind: 'extrude', type: 'wall', fromM: 148.9, toM: 152 }, geometry: { type: 'Polygon', coordinates: [[...rect(2, 2, 1, 1), rect(2, 2, 1, 1)[0]]] } },
  ] };
  const solids = parseStructures('t.geojson', fc).solids;
  const roads = [
    road('out', [[X0 + 2, Y0 + 15, 148.9], [X0 + 18, Y0 + 15, 148.9]]),
    road('indoor', [[X0 + 2, Y0 + 16, 150], [X0 + 18, Y0 + 16, 150]], { buildingId: '본관' }),
    road('b1', [[X0 + 6, Y0 + 8, 141.4], [X0 + 18, Y0 + 8, 141.4]], { name: '운동장 지하 1층 차로' }),
  ];
  const areas = [{ id: 1, name: '운동장', elevationM: 148.9, rings: [rect(1, 1, 10, 10)] }, { id: 2, name: '지하 1층 통로', elevationM: 141.4, rings: [rect(6, 6, 4, 4)] }];
  const places = [{ id: 'p1', name: '정류장', buildingId: null, x: X0 + 3, y: Y0 + 3, z: 148.9 }, { id: 'p2', name: '지하 1층 주차장', buildingId: null, x: X0 + 7, y: Y0 + 7, z: 141.4 }];
  const ground = zoneContent(zones[0], { roads, areas, solids, places });
  assert.deepEqual(ground.roads.map((r: any) => r.road.id), ['out']);
  assert.deepEqual(ground.areas.map((a: any) => a.id), [1]);
  assert.deepEqual(ground.solids.map((s: any) => s.solid.id), ['P', 'TREE']);
  assert.equal(ground.minM, 148.9);
  const under = zoneContent(zones[2], { roads, areas, solids, places });
  assert.deepEqual(under.roads.map((r: any) => r.road.id), ['b1']);
  assert.deepEqual(under.areas.map((a: any) => a.id), [2]);
  assert.deepEqual(under.solids.map((s: any) => [s.solid.id, s.bottomM, s.topM]), [['PILLAR', 141.4, 144.4]]);
  assert.deepEqual(under.places.map((p: any) => p.id), ['p2']);
  assert.equal(under.minM, 141.4);
  // U08: 바닥에서 끝나는 빈 곳 = 바닥 구멍. 그 밑의 openAbove 조각(내려가는 경사로)은 자르지 않고 그린다(기운 윗면은 얇은 판으로). 띄우는 높이(minM)는 그대로
  const hole = { id: 'HOLE', file: 'f', role: 'void', type: 'void', polygon: [rect(7, 7, 2, 2)], bottomM: 140.4, topM: 141.4, estimated: true, props: {} };
  const rampDown = { id: 'RAMP', file: 'f', role: 'box', type: 'ramp', polygon: [rect(7, 7, 2, 2)], bottomM: 133, topM: 141.4, estimated: true, props: { openAbove: true, inVoid: true },
    profile: { origin: [X0 + 7, Y0 + 7], direction: [1, 0], points: [[0, 141.4], [2, 141.1]] } };
  const hidden = { ...rampDown, id: 'RAMP-UNDER-SLAB', props: { inVoid: true }, topM: 140.0, profile: undefined };
  const open = zoneContent(zones[2], { roads, areas, solids: [...solids, hole, rampDown, hidden], places });
  assert.equal(open.openings.length, 1);
  assert.deepEqual(open.solids.map((s: any) => [s.solid.id, s.bottomM, s.topM, !!s.below]), [['PILLAR', 141.4, 144.4, false], ['RAMP', 141.1 - LEVEL_VIEW.openSlabM, 141.4, true]]);
  assert.equal(open.minM, 141.4);
  assert.equal(under.openings.length, 0);
  // 바닥이 평평하지 않은 지하 구획(경사 차도): 범위가 넓어 위의 지상 길·구조물이 걸리므로, 지하인 길과 지하 표시가 있는 구조물만
  const tunnel = { ...zones[2], floorM: undefined, fromM: 130, toM: 155 };
  const sloped = zoneContent(tunnel, { roads: [...roads, road('t', [[X0 + 6, Y0 + 9, 136], [X0 + 18, Y0 + 9, 140]], { name: '지하 차도' })], areas: [], solids });
  assert.deepEqual(sloped.roads.map((r: any) => r.road.id), ['b1', 't']);
  assert.deepEqual(sloped.solids.map((s: any) => s.solid.id), ['PILLAR']);
});

test('층 이름 읽기: 길 이름·층 표기에서만', () => {
  assert.equal(floorInText('본관 2층 복도 (승강기 ~ 유리문 앞)'), 2);
  assert.equal(floorInText('북악관 B1 진입 통로'), -1);
  assert.equal(floorInText('북악관 1F 복도 (추정)'), 1);
  assert.equal(floorInText('운동장 지하 1층 차로'), -1);
  assert.equal(floorInText('유담관 1호기 하부 진입 (추정)'), null);
  assert.equal(floorInText('북악관 146.18m 동측 복도'), null);
  assert.equal(floorInText(null), null);
  assert.equal(baseBuildingId('은주관#접합부'), '은주관');
  // 괄호 안의 말(다른 층 이야기)은 그 길의 층이 아님
  assert.equal(floorOfRoad({ levelId: null, name: '한림관 연결 층 통로 (137.8 m, 지도 표기 2층)' }), null);
  assert.equal(floorOfRoad({ levelId: null, name: '은주1관 3층 복도 ~ 계단실 (파란 문 앞)' }), 3);
});

test('건물의 층: 층 표 + 평평한 실내 길. 이름은 길이 말할 때만, 없는 층은 만들지 않음', () => {
  const blocks = [{ baseM: 125.9, roofM: 152.1 }];
  const table = [123.9, 128.5, 133.2, 137.8, 141.8, 145.8, 149.8, 160];
  const roads = [
    road('h2', [[0, 0, 128.5], [5, 0, 128.5]], { buildingId: '본관', name: '본관 2층 홀' }),
    road('c2', [[0, 0, 128.5], [0, 9, 128.5]], { buildingId: '본관', name: '본관 2층 복도' }),
    road('c5', [[0, 0, 137.8], [9, 0, 137.8]], { buildingId: '본관', name: '본관 5층 복도 (동쪽 계단실 ~ 승강기)' }),
    road('st', [[0, 0, 137.8], [3, 0, 139.9]], { buildingId: '본관', structure: 'stairs', name: '본관 5층 계단실 ~ 입구(3) 문' }),
    road('odd', [[0, 0, 131.0], [3, 0, 131.0]], { buildingId: '본관' }),
  ];
  const floors = buildingFloors(blocks, table, roads);
  assert.deepEqual(floors.map((f: any) => f.m), [123.9, 128.5, 131, 133.2, 137.8, 141.8, 145.8, 149.8]); // 160 은 지붕 위라 뺌, 131.0 은 길에서
  assert.deepEqual(floors.map((f: any) => f.name), [null, '2층', null, null, '5층', null, null, null]);
  assert.deepEqual(floors.find((f: any) => f.m === 131).fromTable, false);
  assert.deepEqual(floors[1].roadIds, ['h2', 'c2']); // 계단은 어느 층의 길도 아님
  assert.equal(floorIndexAt(floors, 137.6), 4);
  assert.equal(floorIndexAt(floors, 139.9), -1);
  // 층 표가 없는 건물: 길의 높이만
  assert.deepEqual(buildingFloors(blocks, null, roads).map((f: any) => f.m), [128.5, 131, 137.8]);
  // 층 표기(levelId)가 길 이름보다 먼저
  assert.equal(buildingFloors(blocks, null, [road('x', [[0, 0, 143.6], [1, 0, 143.6]], { levelId: '북악관_5F_추정', name: '북악관 146.18m 홀' })])[0].name, '5층');
});

test('층 벌리기: 층마다 간격을 더하고, 층 사이 높이는 곧게 늘어남', () => {
  const lift = explode([128.5, 133.2, 137.8], 210, 7);
  assert.equal(lift(128.5), 210);
  assert.ok(Math.abs(lift(133.2) - (210 + 4.7 + 7)) < 1e-9);
  assert.ok(Math.abs(lift(137.8) - (210 + 9.3 + 14)) < 1e-9);
  assert.ok(Math.abs(lift((128.5 + 133.2) / 2) - (210 + (4.7 + 7) / 2)) < 1e-9); // 계단 가운데
  assert.ok(Math.abs(lift(127.5) - 209) < 1e-9); // 맨 아래 밑은 실제 차 그대로
  assert.ok(Math.abs(lift(139.8) - (210 + 9.3 + 14 + 2)) < 1e-9);
  assert.ok(lift(133.2) > lift(128.5) && lift(137.8) > lift(133.2)); // 순서 유지
});

test('발밑 높이: 발 + 0.6 m 이하에서 가장 높은 면. 위의 슬래브·운동장으로 튀지 않고, 깊은 낭떠러지로 떨어지지 않음', () => {
  assert.equal(feetHeight([141.4, 148.9], 141.4), 141.4); // 지하 1층에서 운동장으로 안 올라감
  assert.equal(feetHeight([141.4, 141.57], 141.4), 141.57); // 계단 한 칸 오름
  assert.equal(feetHeight([141.4, 141.23], 141.57), 141.4); // 한 칸 내려감: 발 아래 가장 높은 면
  assert.equal(feetHeight([141.4, 142.1], 141.4), 141.4); // 0.7 m 턱은 못 오름
  assert.equal(feetHeight([130], 137.8), 137.8); // 7.8 m 아래 땅뿐: 그대로(바닥 도형이 없는 실내)
  assert.equal(feetHeight([], 137.8), 137.8);
  assert.equal(feetHeight([136.5], 137.8), 136.5); // 1.3 m 는 내려섬
  assert.equal(feetHeight([{ z: 148.9 }, { z: 148.5, sloped: true }], 148.9), 148.5); // 계단 길이 있으면 평면보다 계단을 따름
  assert.equal(feetHeight([{ z: 148.9 }, { z: 141.4, sloped: true }], 148.9), 148.9); // 7.5 m 아래의 경사 길은 발밑이 아님
  assert.equal(WALK.eyeM, 1.6);
});

test('길 위의 높이: 계단·경사 길은 선을 따라 높이를 잇고, 그 길로 지하에 내려감', () => {
  const stair = [[X0, Y0, 148.9], [X0 + 10, Y0, 141.4]];
  const mid = roadHeightAt(stair, X0 + 5, Y0 + 1);
  assert.ok(Math.abs(mid!.z - 145.15) < 1e-9);
  assert.ok(Math.abs(mid!.distanceM - 1) < 1e-9);
  assert.deepEqual(mid!.direction, [1, 0]);
  assert.ok(Math.abs(mid!.slope - 0.75) < 1e-9);
  const data = { roads: [road('s', stair, { structure: 'stairs' })], areas: [{ id: 1, name: '운동장', elevationM: 148.9, rings: [rect(-20, -20, 60, 60)] }], solids: [], zones: [zones[2]] };
  // 계단을 따라 1 m 씩 걸어 내려감: 운동장 면(148.9)이 계속 머리 위에 있어도 계단 높이를 따름
  let feet = 148.9;
  for (let x = 0; x <= 10; x += 0.5) feet = feetHeight(walkSurfaces(X0 + x, Y0, data), feet);
  assert.ok(Math.abs(feet - 141.4) < 1e-9);
  // 계단을 벗어난 지하 구획 안: 구획 바닥 141.4, 위의 운동장으로 튀지 않음
  assert.equal(feetHeight(walkSurfaces(X0 + 12, Y0 + 8, data), feet), 141.4);
});

test('짧은 이름', () => {
  assert.equal(shortName('본관 2층 복도 (승강기 ~ 유리문 앞)'), '본관 2층 복도');
  assert.equal(shortName('가나다라마바사아자차카타파하', 6), '가나다라마…');
  assert.equal(shortName(null), '');
});

test('구획 파일: 지상 구획은 서로 겹치지 않고, 지하 구획은 높이 범위가 있음', () => {
  const file = new URL('../public/zones.geojson', import.meta.url);
  const all = parseZones(JSON.parse(fs.readFileSync(file, 'utf8')));
  const ground = all.filter((z: any) => z.layer === 'ground'), under = all.filter((z: any) => z.layer === 'underground');
  assert.equal(ground.length, 13);
  assert.ok(under.length >= 4);
  assert.equal(new Set(all.map((z: any) => z.id)).size, all.length);
  const area = (polys: number[][][][]) => polys.reduce((s, p) => s + polygonArea(p), 0);
  const sum = ground.reduce((s: number, z: any) => s + area(z.polygons), 0);
  const union = area(polygonOps('union', ground.flatMap((z: any) => z.polygons)));
  assert.ok(Math.abs(sum - union) < 1, `겹침 ${(sum - union).toFixed(2)} ㎡`);
  for (const z of under) assert.ok(z.toM > z.fromM, z.name);
  assert.ok(under.some((z: any) => z.name === '운동장 지하 1층' && z.floorM === 143.5)); // 2026-10-22 사용자 결정(전 141.4)
});

test('보기 설정: 기본값, 모르는 값은 기본으로, 바꾸면 알림', () => {
  assert.deepEqual(viewStyle(), VIEW_STYLE_DEFAULT);
  assert.deepEqual(normalizeViewStyle({ line: 'thick', labels: 'x', extra: 1 }), { line: 'thick', labels: 'main', others: 'dim' });
  const seen: string[] = [];
  const stop = onViewStyle((s: { line: string }) => seen.push(s.line));
  setViewStyle({ line: 'thick' });
  stop();
  setViewStyle({ line: 'thin' });
  assert.deepEqual(seen, ['thick']);
  assert.equal(viewStyle().line, 'thin');
  assert.ok(LINE_PX.thick.road > LINE_PX.normal.road && LINE_PX.normal.road > LINE_PX.thin.road);
  setViewStyle(VIEW_STYLE_DEFAULT);
});

test('사2: interiors.geojson spaces carve a floor (walls = footprint without spaces, plan-cut height)', () => {
  const sq = (x: number, y: number, w: number, h: number) => [...rect(x, y, w, h), rect(x, y, w, h)[0]];
  const spaces = parseInteriors({ features: [
    { type: 'Feature', properties: { building: '가관', kind: 'corridor', name: '복도', floorsM: [100, 103.5], grade: '추정' }, geometry: { type: 'Polygon', coordinates: [sq(0, 4, 40, 2.4)] } },
    { type: 'Feature', properties: { building: '가관', kind: 'elevator', name: '승강기', floorsM: [100], grade: '추정' }, geometry: { type: 'Polygon', coordinates: [sq(50, 0, 2, 2)] } },
    { type: 'Feature', properties: { building: '가관', kind: 'nope', floorsM: [100] }, geometry: { type: 'Polygon', coordinates: [sq(0, 0, 1, 1)] } },
  ] });
  assert.equal(spaces.length, 2);
  const floors = [{ m: 100, name: '1층', fromTable: true, roadIds: [] }, { m: 101.5, name: '2층', fromTable: true, roadIds: [] }, { m: 103.5, name: '3층', fromTable: true, roadIds: [] }, { m: 120, name: '5층', fromTable: true, roadIds: [] }];
  const footprint = [[rect(0, 0, 40, 10)]];
  const one = carvedFloor(spaces, '가관', floors, 0, footprint)!;
  assert.equal(one.spaces.length, 1, 'the elevator lies outside the footprint: clipped away');
  assert.ok(Math.abs(polygonArea(one.walls[0]) + polygonArea(one.walls[1] ?? []) - (400 - 96)) < 0.5, 'walls = 400 m² - corridor 96 m²');
  assert.equal(one.wallM, 1.2, 'low storey: 0.3 m below the next floor');
  assert.equal(carvedFloor(spaces, '가관', floors, 2, footprint)!.wallM, INTERIOR.wallM);
  assert.equal(carvedFloor(spaces, '가관', floors, 1, footprint), null, 'no space on that floor: not carved');
  assert.equal(carvedFloor(spaces, '나관', floors, 0, footprint), null);
  const parts = carvedFloor(spaces, '가관', floors, 0, [...footprint, [rect(0, 20, 10, 10)]])!;
  assert.ok(Math.abs(parts.walls.reduce((t, w) => t + polygonArea(w), 0) - (400 - 96)) < 0.5, 'a part no space reaches gets no walls');
});
