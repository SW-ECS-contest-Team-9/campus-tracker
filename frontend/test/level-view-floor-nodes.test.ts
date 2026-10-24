import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';

// 층별 보기에서 세션 점(트래킹 노드)의 층 판정: ① 기록 = 확정, ② 높이 = 추정, ③ 미상 (2026-10-25)
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { TRACK, beaconRecord, fanOut, markerRecords, parseZones, spotsOnFocus, trackOnBuilding, trackOnZone, trackPlace, trackRuns, zoneAt, zoneFloor } = await import('../src/level-view.ts');

const zones = parseZones(JSON.parse(fs.readFileSync(new URL('../public/zones.geojson', import.meta.url), 'utf8')));
const byId = (id: string) => zones.find((z: any) => z.id === id);
const b1 = byId('b1'), b2 = byId('b2'), field = byId('field');
const groundAt = () => 148.9; // 운동장
const P = (h: number | null, more: object = {}) => ({ x: 201190, y: 557240, h, ...more }); // 운동장 한가운데(지하 1·2층 평면 안)
const rec = (buildingId: string | null, floor: string | null, more: object = {}) => ({ buildingId, floor, source: 'marker' as const, ...more });

// 북악관을 본뜬 건물: 지하 1층 ~ 7층, 4층 없음, 층고 다름
const NAMES = ['지하 1층', '1층', '2층', '3층', '5층', '6층', '7층'];
const FLOORS = [126.0, 130.2, 134.6, 138.4, 142.9, 146.6, 150.4];
const RINGS = [[[0, 0], [40, 0], [40, 15], [0, 15]]];
const BLOCKS = { baseM: 126.0, roofM: 155 };
const OWN = { id: 'bukak', floorNames: NAMES };
const onBuilding = (pts: any[]) => trackOnBuilding(pts, RINGS, FLOORS, BLOCKS, () => 130.2, OWN);

test('층별 노드 기록: 기준점 표시가 준 층(앞뒤 창, 계단 시작 전은 출발 층·끝난 뒤는 도착 층, 같은 층 사이는 전부)', () => {
  const s = 1000, w = TRACK.markerWindowS * s;
  const markers = [
    { type: 'sessionStart', t: 0, buildingId: 'bukak', floor: '1F' },
    { type: 'stairStart', t: 60 * s, buildingId: 'bukak', fromFloor: '1F', toFloor: '3F' },
    { type: 'stairEnd', t: 90 * s, buildingId: 'bukak', fromFloor: '1F', toFloor: '3F' },
    { type: 'elevatorBoard', t: 200 * s, buildingId: 'bukak', fromFloor: '3F', toFloor: 'B1' },
    { type: 'elevatorExit', t: 230 * s, buildingId: 'bukak', fromFloor: '3F', toFloor: 'B1' },
    { type: 'entrance', t: 400 * s, buildingId: 'outdoor' },
  ];
  const floorAt = (t: number | undefined) => { const r = markerRecords([t], markers)[0]; return r ? (r.outdoor ? 'out' : r.floor) : null; };
  assert.equal(floorAt(-1 * s), null); // 시작 전
  assert.equal(floorAt(30 * s), '1F'); // 시작 ~ 계단 시작: 둘 다 1층 → 그 사이 전부
  assert.equal(floorAt(75 * s), null); // 계단 위
  assert.equal(floorAt(150 * s), '3F'); // 계단 끝 ~ 승강기 탑승: 둘 다 3층
  assert.equal(floorAt(215 * s), null); // 승강기 안
  assert.equal(floorAt(230 * s + w), 'B1'); // 하차 뒤 창 안
  assert.equal(floorAt(230 * s + w + 1), null); // 다음 표시(출입구 = 바깥)와 층이 달라 창 밖은 모름
  assert.equal(floorAt(400 * s - w), 'out');
  assert.equal(floorAt(400 * s + w), 'out'); // 출입구 표시는 앞뒤 모두
  assert.equal(floorAt(500 * s), null); // 마지막 표시 뒤 창 밖: 모름
  assert.equal(floorAt(undefined), null);
  assert.deepEqual(markerRecords([1, 2], []), [null, null]);
  // 건물·층이 없는 표시는 아무 층도 주지 않는다
  assert.deepEqual(markerRecords([5 * s], [{ type: 'note', t: 5 * s, buildingId: null, floor: null }]), [null]);
});

test('층별 노드 기록: 퓨전 점은 비콘으로 정한 층만 기록(기압 층은 높이와 같은 근거라 아님)', () => {
  assert.deepEqual(beaconRecord({ floorLabel: 'b2', floorBuildingId: 'bukak', floorSource: 'BEACON' }), { buildingId: 'bukak', floor: 'B2', source: 'beacon' });
  assert.ok(beaconRecord({ floorLabel: '3F', floorBuildingId: 'bukak', floorSource: 'BEACON_BAROMETER' }));
  assert.equal(beaconRecord({ floorLabel: '3F', floorBuildingId: 'bukak', floorSource: 'BAROMETER' }), null);
  assert.equal(beaconRecord({ floorLabel: null, floorBuildingId: 'bukak', floorSource: 'BEACON' }), null);
});

test('층별 노드 판정 순서(건물): ① 기록 층 = 확정 ② 높이에 가장 가까운 층 = 추정 ③ 높이 없음·터무니없음 = 미상', () => {
  const spots = onBuilding([
    { x: 5, y: 5, h: 130.9, record: rec('bukak', '3F') }, // 높이는 1층이지만 기록이 3층
    { x: 6, y: 5, h: 130.9 },
    { x: 7, y: 5, h: null },
    { x: 8, y: 5, h: 90 },
    { x: 9, y: 5, h: 130.9, record: rec('bukak', '4F') }, // 이 건물에 없는 층: 높이로
    { x: 10, y: 5, h: 130.9, record: rec(null, null, { outdoor: true }) }, // 바깥 기록: 이 건물 점이 아님
    { x: 11, y: 5, h: 130.9, record: rec('bonkwan', '1F') }, // 다른 건물 기록
    { x: 12, y: 5, h: null, record: rec('bukak', 'B1') }, // 높이가 없어도 기록이면 확정
  ]);
  assert.deepEqual(spots.map((s: any) => [s.index, NAMES[s.floor], s.grade]), [
    [0, '3층', 'record'], [1, '1층', 'height'], [2, '1층', 'unknown'], [3, '지하 1층', 'unknown'], [4, '1층', 'height'], [7, '지하 1층', 'record'],
  ]);
  assert.deepEqual(spots.map((s: any) => s.z), [138.4, 130.2, 130.2, 126.0, 130.2, 126.0]);
  // 기록이 있어도 own 을 안 주면 예전처럼 높이만
  assert.equal(trackOnBuilding([{ x: 5, y: 5, h: 130.9, record: rec('bukak', '3F') }], RINGS, FLOORS, BLOCKS, () => 130.2)[0].grade, 'height');
});

test('층별 노드: 모든 층에 반복(4층 없는 건물) — 높이로 그 층(추정), 기록으로 그 층(확정)', () => {
  FLOORS.forEach((m, i) => {
    const byHeight = onBuilding([{ x: 5, y: 5, h: m + 1.2 }]);
    assert.deepEqual(byHeight.map((s: any) => [s.floor, s.grade]), [[i, 'height']], `${NAMES[i]} 높이`);
    const name = i === 0 ? 'B1' : `${NAMES[i].replace('층', '')}F`;
    const byRecord = onBuilding([{ x: 5, y: 5, h: 131, record: rec('bukak', name) }]);
    assert.deepEqual(byRecord.map((s: any) => [s.floor, s.grade, s.z]), [[i, 'record', m]], `${NAMES[i]} 기록 ${name}`);
  });
});

test('층별 노드: 한 층 포커싱은 그 층 점만, 전체는 전부', () => {
  const spots = onBuilding(FLOORS.map((m, i) => ({ x: 5 + i, y: 5, h: m + 1 })));
  assert.equal(spotsOnFocus(spots, null).length, FLOORS.length);
  FLOORS.forEach((_, i) => assert.deepEqual(spotsOnFocus(spots, i).map((s: any) => s.index), [i]));
  // 선 묶음은 층이 바뀌면 끊김(펼친 판 사이를 가로지르는 선 없음), 등급이 바뀌어도 끊김
  assert.equal(trackRuns(spots).length, FLOORS.length);
  const mixed = onBuilding([{ x: 5, y: 5, h: 131, record: rec('bukak', '1F') }, { x: 6, y: 5, h: 131 }, { x: 7, y: 5, h: 131 }]);
  assert.deepEqual(trackRuns(mixed).map((r: any[]) => r.map((s) => s.index)), [[0], [1, 2]]);
});

test('층별 노드(구획): 지하 2층 기록 점은 높이가 틀려도 지하 2층 판에, 지하 1층·운동장에는 없음', () => {
  assert.equal(zoneFloor(b2), -2);
  assert.equal(zoneFloor(b1), -1);
  assert.equal(zoneFloor(field), null);
  const ctx = { zones, groundAt };
  const pts = [P(149.5, { record: rec('parking', 'B2') }), P(null, { record: rec('parking', 'B1') }), P(144.7, { record: rec(null, null, { outdoor: true }) }), P(141.2)];
  const on = (zone: any) => trackOnZone(pts, zone, ctx).map((s: any) => [s.index, s.grade, s.z]);
  assert.deepEqual(on(b2), [[0, 'record', 140.0], [3, 'height', 140.0]]);
  assert.deepEqual(on(b1), [[1, 'record', 143.5]]);
  assert.deepEqual(on(field), [[2, 'record', 148.9]]);
  // 기록이 이 자리 판 어디에도 맞지 않으면(지하 3층) 높이로
  assert.equal(trackPlace(P(141.2, { record: rec('parking', 'B3') }), ctx).grade, 'height');
  // 건물 기록은 그 건물 발자국 안이면 건물 점(구획 점 아님)
  const building = { id: 'gym', rings: [[[201185, 557235], [201195, 557235], [201195, 557245], [201185, 557245]]], baseM: 148.9, roofM: 175 };
  const inGym = P(149.5, { record: rec('gym', '1F') });
  assert.deepEqual(trackPlace(inGym, { ...ctx, buildings: [building] }).building, true);
  assert.deepEqual(trackOnZone([inGym], field, { ...ctx, buildings: [building] }), []);
  // 높이 없는 점: 아래 지하가 있는 운동장은 미상, 지하 판에도 미상으로
  assert.deepEqual(trackOnZone([P(null)], b2, ctx).map((s: any) => s.grade), ['unknown']);
});

test('층별 노드(구획): 모든 구획(지상·지하 층·경사 지하)에 제 높이의 점이 그 구획 판에 놓인다', () => {
  for (const zone of zones) {
    const ring = zone.polygons[0][0];
    const level = zone.floorM !== undefined;
    const h = zone.layer === 'ground' ? 150 + 1.2 : level ? zone.floorM + 1.2 : (zone.fromM + zone.toM) / 2;
    const g = zone.layer === 'ground' ? 150 : level ? zone.toM + 5 : zone.toM + 5;
    const ctx = { zones, groundAt: () => g };
    let found: any = null;
    for (let i = 0; i < ring.length && !found; i++) for (let j = i + 2; j < ring.length && !found; j++) {
      const x = (ring[i][0] + ring[j][0]) / 2, y = (ring[i][1] + ring[j][1]) / 2;
      if (zoneAt([zone], x, y, zone.layer === 'ground' ? undefined : h) && trackPlace({ x, y, h }, ctx).zone?.id === zone.id) found = { x, y };
    }
    assert.ok(found, `${zone.id}: 제 높이의 점이 놓일 자리 없음`);
    const spots = trackOnZone([{ ...found, h }], zone, ctx);
    assert.equal(spots.length, 1, zone.id);
    assert.equal(spots[0].grade, 'height', zone.id);
    assert.equal(spots[0].z, zone.layer === 'ground' ? g : level ? zone.floorM : h, zone.id);
    // 같은 자리 다른 구획에는 안 놓임
    for (const other of zones) if (other.id !== zone.id) assert.equal(trackOnZone([{ ...found, h }], other, ctx).length, 0, `${zone.id} → ${other.id}`);
  }
});

test('층별 노드: 펼친 마지막 장면에서 점은 제 층 판과 같이 옮겨진다(판마다 위로·옆으로 한 칸)', () => {
  // 레이어의 점 자리 = onFloor(층)([x, y, 층 높이]) + 0.6 = 그 층 판을 옮기는 것과 같은 fan (화면 확인은 갈무리 스크립트의 trackDots)
  const step = [0, 30], fan = fanOut(FLOORS, 300, step, 6);
  const spots = onBuilding(FLOORS.map((m) => ({ x: 5, y: 5, h: m + 1 })));
  for (const s of spots) {
    const plate = fan([5, 5, FLOORS[s.floor]]);
    if (s.floor > 0) assert.ok(plate[2] > fan([5, 5, FLOORS[s.floor - 1]])[2], '위층 판이 더 높이');
    assert.ok(Math.abs(plate[1] - (5 + step[1] * s.floor)) < 1e-6, '층마다 옆으로 한 칸씩');
  }
});
