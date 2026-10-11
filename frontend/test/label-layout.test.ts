import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { declutter, levelText, mergeLevels, overlaps, place, spread, textWidth } = await import('../src/label-layout.ts');
const { FAN, elevatorStops, fanAxis, fanOut, fanStep, levelsUnder, nextStop, buildingFloors, parseZones, tableFloorName } = await import('../src/level-view.ts');
const { polygonArea, polygonOps } = await import('../src/polygon-ops.ts');
const { LABELS, SECTION_PX, MAP_LINE_SCALE } = await import('../src/view-style.ts');

const box = (x: number, y: number, w = 60, h = 16) => ({ x, y, w, h });

test('이름표 솎기: 겹치면 중요한 것이 남고, 남은 것끼리는 겹치지 않음', () => {
  const tags = [
    { ...box(0, 0), priority: 1 }, { ...box(30, 4), priority: 5 }, { ...box(200, 0), priority: 1 }, { ...box(50, 10), priority: 3 }, { ...box(95, 0), priority: 2 },
  ];
  const shown = declutter(tags);
  assert.deepEqual(shown, [false, true, true, false, true]);
  const kept = tags.filter((_, i) => shown[i]);
  for (const a of kept) for (const b of kept) if (a !== b) assert.ok(!overlaps(a, b), '남은 이름표가 겹침');
});

test('이름표 솎기: 같은 중요도는 먼저 온 것, always 는 겹쳐도 남음', () => {
  assert.deepEqual(declutter([{ ...box(0, 0), priority: 1 }, { ...box(10, 0), priority: 1 }]), [true, false]);
  assert.deepEqual(declutter([{ ...box(0, 0), priority: 9 }, { ...box(10, 0), priority: 1, always: true }]), [false, true]);
  // 무더기 40개(한 자리)에서 하나만 남는다
  const pile = Array.from({ length: 40 }, (_, i) => ({ ...box(100 + (i % 5), 100 + (i % 7)), priority: i }));
  assert.equal(declutter(pile).filter(Boolean).length, 1);
});

test('이름표 줄 세우기: 겹치지 않게 벌리고, 차례는 그대로, 범위 안에', () => {
  const ys = [100, 102, 104, 300, 301];
  const out = spread(ys, 16, 0, 400);
  const sorted = [...out].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= 18 - 1e-9);
  assert.deepEqual(out.map((_, i) => i).sort((a, b) => out[a] - out[b]), [0, 1, 2, 3, 4]);
  assert.equal(out[0], 100); // 맨 위는 제자리
  // 아래 끝에 몰리면 위로 밀어 올림
  const low = spread([390, 392, 394], 16, 0, 400);
  assert.ok(Math.max(...low) <= 384 + 1e-9);
  assert.ok(low[1] - low[0] >= 18 - 1e-9 && low[2] - low[1] >= 18 - 1e-9);
  assert.deepEqual(spread([], 16, 0, 100), []);
});

test('단면 높이 이름표: 한 높이에 하나, 이름은 중요한 것부터 한 번씩', () => {
  const levels = mergeLevels([
    { z: 141.4, d: 10, name: '운동장 지하 1층 통로 면', priority: 5 }, { z: 141.41, d: 40, name: '지하 차도', priority: 2 }, { z: 141.38, d: 60, name: '지하 차도', priority: 2 },
    { z: 133.0, d: 12, name: '', priority: 1 }, { z: 148.9, d: 30, name: '운동장', priority: 6 }, { z: 137.8, d: 5, name: 'a', priority: 1 }, { z: 137.8, d: 6, name: 'b', priority: 2 }, { z: 137.8, d: 7, name: 'c', priority: 3 },
  ]);
  assert.deepEqual(levels.map((l: { z: number }) => +l.z.toFixed(1)), [148.9, 141.4, 137.8, 133.0]);
  assert.deepEqual(levels[1].names, ['운동장 지하 1층 통로 면', '지하 차도']);
  assert.equal(levels[1].items.length, 3);
  assert.equal(levelText(levels[1]), '141.4 m 운동장 지하 1층 통로 면 · 지하 차도');
  assert.equal(levelText(levels[2]), '137.8 m c · b 외 1');
  assert.equal(levelText(levels[3]), '133.0 m');
});

test('이름표 자리 찾기: 비어 있으면 옆에, 막히면 옮기고(지시선), 다 막히면 없음', () => {
  const bounds = { x: 0, y: 0, w: 400, h: 300 };
  const free = place(100, 100, 60, 16, [], bounds)!;
  assert.equal(free.moved, false);
  const moved = place(100, 100, 60, 16, [free], bounds)!;
  assert.ok(moved.moved && !overlaps(moved, free));
  assert.equal(place(100, 100, 60, 16, [{ x: -500, y: -500, w: 2000, h: 2000 }], bounds), null);
  assert.equal(place(100, 100, 600, 16, [], bounds), null); // 화면보다 넓음
});

test('글자 폭: 한글은 한 칸, 영문·숫자는 좁게', () => {
  assert.ok(textWidth('운동장') > textWidth('abc'));
  assert.equal(textWidth('가나', 10), 20);
});

const rect = (x: number, y: number, w: number, h: number) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

test('층 펼치기: 짧은 쪽으로 한 층씩 옮겨 평면이 서로 겹치지 않고, 위층일수록 높다', () => {
  const ring = rect(201100, 557200, 100, 18); // 동서로 긴 건물
  const axis = fanAxis([ring]);
  assert.ok(Math.abs(axis.widthM - 18) < 1e-6 && Math.abs(axis.lengthM - 100) < 1e-6);
  assert.ok(Math.abs(axis.dir[0]) < 1e-9 && axis.dir[1] === 1); // 북쪽으로
  const { step, gapM } = fanStep(axis);
  assert.ok(Math.hypot(step[0], step[1]) > axis.widthM);
  assert.ok(gapM >= FAN.gapMinM && gapM <= FAN.gapMaxM);
  const floors = [131.3, 134.6, 137.8, 141.4, 148.9, 152.9];
  const fan = fanOut(floors, 215, step, gapM);
  const plans = floors.map((m) => ring.map((p) => fan([p[0], p[1], m])));
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const both = polygonOps('both', [[plans[i].map((p: number[]) => [p[0], p[1]])]], [[plans[j].map((p: number[]) => [p[0], p[1]])]]);
      assert.equal(both.reduce((s: number, p: number[][][]) => s + polygonArea(p), 0), 0, `${i}층과 ${j}층 평면이 겹침`);
    }
    if (i) assert.ok(plans[i][0][2] - plans[i - 1][0][2] >= floors[i] - floors[i - 1] + gapM - 1e-9);
  }
  assert.equal(plans[0][0][2], 215); // 맨 아래층이 띄우는 높이
  assert.deepEqual(plans[0][0].slice(0, 2), ring[0]); // 맨 아래층은 제자리 위
});

test('층 펼치기: 층 사이(계단·승강기)는 두 판 사이를 곧게 잇고, 맨 위·맨 아래 밖은 더 벌어지지 않음', () => {
  const fan = fanOut([100, 104], 200, [0, 20], 6);
  assert.deepEqual(fan([5, 5, 100]), [5, 5, 200]);
  assert.deepEqual(fan([5, 5, 104]), [5, 25, 210]);
  assert.deepEqual(fan([5, 5, 102]), [5, 15, 205]);
  assert.deepEqual(fan([5, 5, 106]), [5, 25, 212]);
  assert.deepEqual(fan([5, 5, 99]), [5, 5, 199]);
  assert.deepEqual(fanOut([], 200, [0, 20])([1, 2, 3]), [1, 2, 3]);
});

test('층 펼치기: 비스듬한 건물은 제 짧은 쪽으로', () => {
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const ring = rect(0, 0, 80, 12).map(([x, y]) => [x * c - y * s, x * s + y * c]);
  const axis = fanAxis([ring]);
  assert.ok(Math.abs(axis.widthM - 12) < 1e-6);
  assert.ok(Math.abs(axis.dir[0] + s) < 1e-6 && Math.abs(axis.dir[1] - c) < 1e-6);
});

test('층 이름: 노트 층 표의 이름이 먼저(은주1관은 4층이 있음), 표에 없는 높이는 길이 말한 층', () => {
  const road = (id: string, z: number, more: object = {}) => ({ id, name: null, roadClass: 'pedestrian', structure: 'indoor_corridor', widthM: null, levelId: null, buildingId: 'x', geometry: { coordinates: [[0, 0, z], [5, 0, z]] }, ...more });
  const floors = buildingFloors([{ baseM: 127.8, roofM: 156.8 }], [131.3, 134.6, 137.8, 141.4, 148.9, 152.9], [road('a', 137.8, { levelId: '3F' }), road('b', 145.0, { name: '중간 통로' })], ['1층', '2층', '3층', '4층', '5층', '6층']);
  assert.deepEqual(floors.map((f: { name: string | null; m: number }) => [f.m, f.name]), [[131.3, '1층'], [134.6, '2층'], [137.8, '3층'], [141.4, '4층'], [145, null], [148.9, '5층'], [152.9, '6층']]);
  // 이름 수가 표와 다르면 쓰지 않는다(잘못 맞춘 이름을 만들지 않음)
  assert.equal(buildingFloors([{ baseM: 100, roofM: 120 }], [101, 105], [], ['1층'])[0].name, null);
  assert.equal(tableFloorName('B1'), '지하 1층');
  assert.equal(tableFloorName('옥상'), '옥상');
});

const zoneFeature = (properties: object, ring: number[][]) => ({ type: 'Feature', properties, geometry: { type: 'MultiPolygon', coordinates: [[[...ring, ring[0]]]] } });

test('누른 곳 아래의 지하 층: 높은 것부터, 땅보다 낮은 것만, 경사 구획은 그 지하 길이 지날 때만', () => {
  const zones = parseZones({ features: [
    zoneFeature({ id: 'g', name: '운동장', layer: 'ground' }, rect(0, 0, 100, 100)),
    zoneFeature({ id: 'b1', name: '지하 1층', layer: 'underground', fromM: 141.4, toM: 144.4, floorM: 141.4 }, rect(0, 0, 100, 100)),
    zoneFeature({ id: 'b2', name: '지하 2층', layer: 'underground', fromM: 133, toM: 140.4, floorM: 133 }, rect(0, 0, 100, 100)),
    zoneFeature({ id: 't', name: '지하 차도', layer: 'underground', fromM: 116, toM: 145 }, rect(0, 0, 100, 100)),
  ] });
  const tunnel = { id: 'r', name: '지하 차도', roadClass: 'vehicle', structure: 'ordinary', widthM: 7, levelId: null, buildingId: null, geometry: { coordinates: [[10, 0, 120], [10, 100, 130]] } };
  assert.deepEqual(levelsUnder(zones, 50, 50, 148.9, [tunnel]).map((z: { id: string }) => z.id), ['b1', 'b2']);
  assert.deepEqual(levelsUnder(zones, 12, 50, 148.9, [tunnel]).map((z: { id: string }) => z.id), ['t', 'b1', 'b2']);
  assert.deepEqual(levelsUnder(zones, 50, 50, 142, [tunnel]).map((z: { id: string }) => z.id), ['b2']); // 땅이 141.4 + 1.5 보다 낮으면 지하 1층은 지하가 아님
  assert.deepEqual(levelsUnder(zones, 500, 50, 148.9, [tunnel]), []);
});

test('승강기 정류 높이와 다음 층', () => {
  const lift = (id: string, a: number, b: number, x = 0) => ({ id, name: null, roadClass: 'pedestrian', structure: 'elevator', widthM: null, levelId: null, buildingId: 'x', geometry: { coordinates: [[x, 0, a], [x, 0, b]] } });
  const roads = [lift('a', 121.6, 129.4), lift('b', 129.4, 137.2), lift('far', 100, 110, 50), { ...lift('s', 0, 9), structure: 'stairs' }];
  const stops = elevatorStops(roads, 1, 1);
  assert.deepEqual(stops, [121.6, 129.4, 137.2]);
  assert.equal(nextStop(stops, 121.7, 1), 129.4);
  assert.equal(nextStop(stops, 129.4, -1), 121.6);
  assert.equal(nextStop(stops, 137.2, 1), null);
  assert.equal(nextStop(stops, 125, 1), null); // 정류 높이가 아님
  assert.deepEqual(elevatorStops(roads, 20, 20), []);
});

test('보기 설정 표: 단면 선 굵기와 지도 선 배율이 굵기 차례를 따르고, 이름표 밀도가 단면 종류를 가름', () => {
  assert.ok(SECTION_PX.thick.cut > SECTION_PX.normal.cut && SECTION_PX.normal.cut > SECTION_PX.thin.cut);
  assert.ok(SECTION_PX.thick.mark > SECTION_PX.normal.mark && SECTION_PX.normal.mark > SECTION_PX.thin.mark);
  assert.ok(MAP_LINE_SCALE.thick > MAP_LINE_SCALE.normal && MAP_LINE_SCALE.normal > MAP_LINE_SCALE.thin);
  assert.equal(LABELS.none.floor, false);
  assert.equal(LABELS.main.road, false);
  assert.equal(LABELS.all.road, true);
});
