import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { LEVEL_VIEW, TRACK, cutRoad, inRange, levelStack, nearestOnOutline, parseZones, stackLiftM, trackOnBuilding, trackOnZone, trackPlace, trackRuns, zoneAt, zoneContent } = await import('../src/level-view.ts');
const { parseStructures } = await import('../src/structures.ts');
const { TRACK_PX, VIEW_COLORS } = await import('../src/view-style.ts');

// ---- 실제 구획 파일과 구조물 파일 ----
const zones = parseZones(JSON.parse(fs.readFileSync(new URL('../public/zones.geojson', import.meta.url), 'utf8')));
const dir = new URL('../public/structures/', import.meta.url);
const solids = fs.readdirSync(dir).filter((f) => f.endsWith('.geojson')).flatMap((f) => parseStructures(f, JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'))).solids);
const b1 = zones.find((z: any) => z.id === 'b1'), b2 = zones.find((z: any) => z.id === 'b2'), field = zones.find((z: any) => z.id === 'field');
const underground = zones.filter((z: any) => z.layer === 'underground');
const outline = (z: any) => z.polygons.map((p: number[][][]) => p[0]);
// 두 층의 통로 면·장소(DB 에 있는 것과 같은 높이)와, 두 층을 잇는 경사로·지하 1층의 문 통로
const areas = [{ id: 4, name: '운동장 지하 1층 주차장 통로 면', elevationM: 141.4, rings: outline(b1) }, { id: 5, name: '운동장 지하 2층 주차장 통로 면', elevationM: 137.9, rings: outline(b2) }];
const places = [{ id: 'p1', name: '운동장 지하 1층 주차장', buildingId: null, x: 201190, y: 557240, z: 141.4 }, { id: 'p2', name: '운동장 지하 2층 주차장', buildingId: null, x: 201185, y: 557235, z: 137.9 }];
const road = (id: string, coordinates: number[][], more: object = {}) => ({ id, name: id, roadClass: 'pedestrian', structure: 'ordinary', widthM: null, levelId: null, buildingId: null, geometry: { coordinates }, ...more });
const roads = [
  road('ramp', [[201151.1, 557253.1, 141.4], [201153, 557262, 139.6], [201156.4, 557270.7, 137.9]], { roadClass: 'vehicle', structure: 'ramp', widthM: 6 }),
  road('door', [[201170, 557250, 141.4], [201180, 557250, 141.4]]),
  road('b2-aisle', [[201170, 557240, 137.9], [201180, 557240, 137.9]], { roadClass: 'vehicle' }),
];
const data = { roads, areas, solids, places, zones };

test('F10 원인: 층 사이 틈(0.5 m)보다 큰 높이 여유(0.6 m)가 윗층 바닥을 아래층에 넣었다. 평평한 층은 바닥 − 0.3 m ~ 천장 미만', () => {
  assert.ok(b1.floorM - b2.toM < LEVEL_VIEW.rangeSlackM); // 옛 규칙이면 겹침
  assert.equal(inRange(b2, b1.floorM), false);
  assert.equal(inRange(b2, b2.toM), false);
  assert.equal(inRange(b2, b2.floorM - LEVEL_VIEW.floorSlackM), true);
  assert.equal(inRange(b1, b1.floorM), true);
  assert.equal(inRange(b1, b2.floorM + 2.9), false);
  // 경사 구획(지하 차도)은 그대로 범위 ± 여유
  const tunnel = zones.find((z: any) => z.id === 'tunnel');
  assert.equal(inRange(tunnel, tunnel.toM + LEVEL_VIEW.rangeSlackM), true);
  // 누른 높이로 고르기: 141.4 는 지하 1층, 137.9 는 지하 2층
  assert.equal(zoneAt(zones, 201190, 557240, 141.4)?.id, 'b1');
  assert.equal(zoneAt(zones, 201190, 557240, 137.9)?.id, 'b2');
});

test('F10 지하 1층과 2층은 같은 것을 고르지 않는다: 통로 면·장소·구조물·평평한 길이 한 층에만', () => {
  const c1 = zoneContent(b1, data), c2 = zoneContent(b2, data);
  assert.deepEqual(c1.areas.map((a: any) => a.id), [4]);
  assert.deepEqual(c2.areas.map((a: any) => a.id), [5]);
  assert.deepEqual(c1.places.map((p: any) => p.id), ['p1']);
  assert.deepEqual(c2.places.map((p: any) => p.id), ['p2']);
  // 구조물: 제 것(아래층에서 비쳐 보이는 것·두 층에 걸친 것 표시가 없는 것)은 한 층에만
  const own = (c: any) => new Set(c.solids.filter((s: any) => !s.below && !s.shared).map((s: any) => s.solid));
  const o1 = own(c1), o2 = own(c2);
  assert.ok(o1.size > 300 && o2.size > 300, `구조물 수 ${o1.size}, ${o2.size}`);
  assert.deepEqual([...o1].filter((s) => o2.has(s)).map((s: any) => s.id), []);
  // 제 것은 그 층 바닥 높이 띠에서 시작한다
  for (const [c, z] of [[c1, b1], [c2, b2]] as any[]) for (const s of c.solids) if (!s.below && !s.shared) assert.ok(inRange(z, s.solid.bottomM), `${z.id} ${s.solid.id} ${s.solid.bottomM}`);
  // 나눠 보이는 것은 표시가 붙는다: 지하 1층에서 뚫린 곳 아래로 보이는 경사로 면(below), 두 층에 걸친 경사로 바깥 벽(shared)
  assert.ok(c1.solids.some((s: any) => s.below && s.solid.type === 'ramp'));
  assert.ok(c1.solids.filter((s: any) => s.below).every((s: any) => s.solid.type === 'ramp')); // 아래층의 벽·턱은 안 그림
  assert.deepEqual(c1.solids.filter((s: any) => s.shared).map((s: any) => [s.solid.id, s.bottomM, s.topM]), [['U07-RAMP-OUTERWALL', 141.4, 144.4]]);
  assert.equal(c2.solids.some((s: any) => s.below || s.shared), false);
  // 길: 평평한 길은 제 층에만, 경사로는 두 층이 높이에서 나눠 갖고 서로에게 꼬리
  assert.deepEqual(c1.roads.map((r: any) => r.road.id), ['ramp', 'door']);
  assert.deepEqual(c2.roads.map((r: any) => r.road.id), ['ramp', 'b2-aisle']);
  const r1 = c1.roads[0].cut, r2 = c2.roads[0].cut;
  assert.ok(r1.share > 0 && r2.share > 0 && r1.share + r2.share <= 1 + 1e-9);
  assert.ok(Math.abs(r1.pieces[0].at(-1)[2] - (b1.floorM - LEVEL_VIEW.floorSlackM)) < 1e-6); // 지하 1층 몫은 바닥 띠까지
  assert.ok(Math.abs(r2.pieces[0][0][2] - b2.toM) < 1e-6); // 지하 2층 몫은 천장부터
  assert.equal(zoneAt(zones, r1.stubEnds[0][0], r1.stubEnds[0][1], r1.stubEnds[0][2])?.id, 'b2'); // 꼬리가 가는 곳
  assert.equal(zoneAt(zones, r2.stubEnds[0][0], r2.stubEnds[0][1], r2.stubEnds[0][2])?.id, 'b1');
});

test('F10 지하 구획끼리: 주차장 층이 가진 구조물·면·장소는 지하 차도·보행 구간에 또 나오지 않는다', () => {
  const content = new Map(underground.map((z: any) => [z.id, zoneContent(z, data)]));
  const own = (id: string) => (content.get(id) as any).solids.filter((s: any) => !s.below && !s.shared).map((s: any) => s.solid);
  for (const level of ['b1', 'b2']) for (const other of underground.filter((z: any) => z.floorM === undefined)) {
    const mine = new Set(own(level));
    assert.deepEqual(own(other.id).filter((s: any) => mine.has(s)).map((s: any) => s.id), [], `${level} / ${other.id}`);
    assert.deepEqual((content.get(other.id) as any).areas.map((a: any) => a.id).filter((id: number) => id === 4 || id === 5), []);
    assert.deepEqual((content.get(other.id) as any).places.map((p: any) => p.id), []);
  }
});

test('F10 주차장 두 층은 저마다의 높이에 뜬다: 아래층이 띄우는 높이, 윗층은 제 차이 + 간격만큼 위', () => {
  assert.deepEqual(levelStack(zones, b1).map((z: any) => z.id), ['b2', 'b1']);
  assert.deepEqual(levelStack(zones, b2).map((z: any) => z.id), ['b2', 'b1']);
  assert.deepEqual(levelStack(zones, field), []);
  const stack = levelStack(zones, b1);
  assert.equal(stackLiftM(stack, b2), 0);
  assert.ok(Math.abs(stackLiftM(stack, b1) - (b1.floorM - b2.floorM + LEVEL_VIEW.floorGapM)) < 1e-9);
  assert.equal(stackLiftM([], field), 0);
  // 다른 평평한 지하 구획(연결통로)은 주차장과 평면이 겹치지 않아 묶이지 않는다
  const links = zones.find((z: any) => z.id === 'links');
  if (links) assert.deepEqual(levelStack(zones, links).map((z: any) => z.id), ['links']);
});

test('F10 이어지는 곳 이름표 자리: 판 가장 가까운 테두리, 바깥 방향', () => {
  const square = [[[[0, 0], [10, 0], [10, 10], [0, 10]]]];
  const o = nearestOnOutline(square, 2, 5)!;
  assert.deepEqual([o.x, o.y, o.dir, o.distanceM], [0, 5, [-1, 0], 2]);
  assert.equal(nearestOnOutline([], 0, 0), null);
});

// ---- 세션 점의 층·구획 판정 ----
const groundAt = () => 148.9; // 운동장
const ctx = { zones, groundAt };
const P = (h: number | null, more: object = {}) => ({ x: 201190, y: 557240, h, ...more }); // 운동장 한가운데(지하 1·2층 평면 안)

test('F10 세션 점의 자리: 층은 바닥 − 1.0 m ~ 윗층 바닥 − 1.0 m(맨 위층은 천장), 실외는 지면 ± 4 m', () => {
  const at = (h: number | null, more: object = {}) => { const r = trackPlace(P(h, more), ctx); return [r.zone?.id ?? null, r.sure]; };
  assert.deepEqual(at(137.9 + 1.2), ['b2', true]); // 지하 2층을 걷는 폰
  assert.deepEqual(at(137.9 - TRACK.belowFloorM), ['b2', true]);
  assert.deepEqual(at(141.4 - TRACK.belowFloorM - 0.01), ['b2', true]); // 윗층 바닥 − 1.0 m 바로 아래까지
  assert.deepEqual(at(141.4 - TRACK.belowFloorM), ['b1', true]);
  assert.deepEqual(at(141.4 + 1.2), ['b1', true]);
  assert.deepEqual(at(144.4), ['b1', true]); // 맨 위층은 천장까지
  assert.deepEqual(at(148.9 + 1.2), ['field', true]);
  assert.deepEqual(at(148.9 - TRACK.outdoorM), ['field', true]);
  assert.deepEqual(at(148.9 + TRACK.outdoorM), ['field', true]);
  // 어디에도 맞지 않는 높이: 버리지 않고 가장 가까운 판, 확실하지 않음
  assert.deepEqual(at(144.6), ['b1', false]); // 천장 위 슬래브 속: 지하 1층 바닥(3.2 m)이 운동장(4.3 m)보다 가깝다
  assert.deepEqual(at(125), ['b2', false]);
  assert.deepEqual(at(190), ['field', false]);
  // 높이를 모름(없음, 수직 정확도 나쁨): 어느 판인지 정하지 않음
  assert.deepEqual(at(null), [null, false]);
  assert.deepEqual(at(142.6, { reliable: false }), [null, false]);
  assert.deepEqual(trackPlace(P(null), ctx).candidates.map((z: any) => z.id).sort(), ['b1', 'b2', 'field']);
});

test('F10 구획 위의 세션 점: 평면이 안이고 높이가 맞는 것만, 높이를 모르는 점은 흐리게 남김', () => {
  const points = [P(142.6), P(139.1), P(150.1), P(null), P(125), { x: 200000, y: 550000, h: 142.6 }, P(142.0, { reliable: false })];
  const on = (zone: any) => trackOnZone(points, zone, ctx).map((s: any) => [s.index, s.sure, s.z]);
  assert.deepEqual(on(b1), [[0, true, 141.4], [3, false, 141.4], [6, false, 141.4]]); // 판(바닥) 높이에 그림
  assert.deepEqual(on(b2), [[1, true, 137.9], [3, false, 137.9], [4, false, 137.9], [6, false, 137.9]]);
  assert.deepEqual(on(field), [[2, true, 148.9], [3, false, 148.9], [6, false, 148.9]]); // 아래에 지하 층이 있어 높이 모르는 점은 확실하지 않음
  // 아래에 지하가 없는 지상 구획: 높이 모르는 점도 그 구획의 점(있을 곳이 지면뿐)
  const way = zones.find((z: any) => z.id === 'gate');
  const ring = way.polygons[0][0], c = [ring.reduce((s: number, p: number[]) => s + p[0], 0) / ring.length, ring.reduce((s: number, p: number[]) => s + p[1], 0) / ring.length];
  const inside = zoneAt(zones, c[0], c[1])?.id === 'gate' ? c : ring[0];
  const alone = trackOnZone([{ x: inside[0], y: inside[1], h: null }], way, { zones: zones.filter((z: any) => z.layer === 'ground'), groundAt: () => 107 });
  if (alone.length) assert.deepEqual(alone.map((s: any) => [s.sure, s.z]), [[true, 107]]);
  // 건물 안(발자국 안, 지면에서 4 m 넘게 떨어진 높이)의 점은 구획의 점이 아니다
  const building = { rings: [[[201185, 557235], [201195, 557235], [201195, 557245], [201185, 557245]]], baseM: 148.9, roofM: 175 };
  assert.deepEqual(trackOnZone([P(160)], field, { ...ctx, buildings: [building] }), []);
  assert.deepEqual(trackOnZone([P(160)], field, ctx).map((s: any) => s.sure), [false]); // 건물이 없으면 터무니없는 높이: 흐리게
});

test('F10 경사 지하 구획(지하 차도): 범위 안이고 땅보다 1.5 m 넘게 아래인 점만, 그 높이대로', () => {
  const tunnel = zones.find((z: any) => z.id === 'tunnel');
  const ring = tunnel.polygons[0][0];
  // 구획 안의 한 점: 띠 모양이라 테두리 두 점의 가운데를 찾는다
  let inside: number[] | null = null;
  for (let i = 0; i < ring.length && !inside; i++) for (let j = i + 2; j < ring.length && !inside; j++) {
    const m = [(ring[i][0] + ring[j][0]) / 2, (ring[i][1] + ring[j][1]) / 2];
    if (zoneAt([tunnel], m[0], m[1], 130) && !zoneAt([b1, b2], m[0], m[1], 141.4) && !zoneAt([b1, b2], m[0], m[1], 137.9)) inside = m;
  }
  assert.ok(inside);
  const c = { zones, groundAt: () => 140 };
  const spot = (h: number | null) => trackOnZone([{ x: inside![0], y: inside![1], h }], tunnel, c).map((s: any) => [s.sure, s.z]);
  assert.deepEqual(spot(130), [[true, 130]]);
  assert.deepEqual(spot(141), []); // 지면 근처: 지상 구획의 점
  assert.equal(spot(null)[0][0], false);
});

test('F10 건물 위의 세션 점: 높이가 가장 가까운 층의 판, 모르는 높이는 지면에 가까운 층에 흐리게', () => {
  const rings = [[[0, 0], [20, 0], [20, 10], [0, 10]]], floors = [128.5, 131.6, 134.6, 137.8];
  const blocks = { baseM: 128.5, roofM: 141 };
  const pts = [{ x: 5, y: 5, h: 129.7 }, { x: 6, y: 5, h: 133.0 }, { x: 7, y: 5, h: 133.2 }, { x: 8, y: 5, h: 139 }, { x: 9, y: 5, h: null }, { x: 10, y: 5, h: 100 }, { x: 11, y: 5, h: 160 }, { x: 50, y: 5, h: 131 }];
  const spots = trackOnBuilding(pts, rings, floors, blocks, () => 131);
  assert.deepEqual(spots.map((s: any) => [s.index, s.floor, s.sure]), [[0, 0, true], [1, 1, true], [2, 2, true], [3, 3, true], [4, 1, false], [5, 0, false], [6, 3, false]]);
  assert.deepEqual(spots.map((s: any) => s.z), [128.5, 131.6, 134.6, 137.8, 131.6, 128.5, 137.8]);
  assert.deepEqual(trackOnBuilding(pts, rings, [], blocks, () => 131), []);
});

test('F10 선으로 잇는 묶음: 이어진 점끼리, 확실한 것과 높이 미상은 따로', () => {
  const spot = (index: number, sure = true) => ({ index, z: 0, sure });
  assert.deepEqual(trackRuns([spot(0), spot(1), spot(2, false), spot(3, false), spot(4), spot(7), spot(8)]).map((r: any[]) => r.map((s) => s.index)), [[0, 1], [2, 3], [4], [7, 8]]);
  assert.deepEqual(trackRuns([]), []);
});

test('F10 지어낸 궤적(갈무리용): 운동장·지하 1층·지하 2층에 각각 점이 있고, 한 점이 두 층에 확실하게 들지 않는다', () => {
  const tracks = JSON.parse(fs.readFileSync(new URL('./fixtures/f10-tracks.json', import.meta.url), 'utf8')).tracks;
  assert.deepEqual(tracks.map((t: any) => t.kind), ['raw', 'fused']);
  for (const track of tracks) {
    const sure = (zone: any) => new Set(trackOnZone(track.points, zone, ctx).filter((s: any) => s.sure).map((s: any) => s.index));
    const s1 = sure(b1), s2 = sure(b2), sf = sure(field);
    assert.ok(s1.size > 5 && s2.size > 5 && sf.size > 3, `${track.kind} ${s1.size} ${s2.size} ${sf.size}`);
    assert.deepEqual([...s1].filter((i) => s2.has(i) || sf.has(i)), []);
    assert.deepEqual([...s2].filter((i) => sf.has(i)), []);
    assert.ok(trackOnZone(track.points, b2, ctx).some((s: any) => !s.sure)); // 높이 없는 점·터무니없는 높이의 점
  }
});

test('F10 궤적 굵기는 보기 설정을 따른다: 원본은 가는 선과 작은 점, 퓨전은 더 굵게', () => {
  for (const w of ['thin', 'normal', 'thick'] as const) assert.ok(TRACK_PX[w].fused > TRACK_PX[w].raw * 2 && TRACK_PX[w].dot > 0);
  assert.ok(TRACK_PX.thin.fused < TRACK_PX.normal.fused && TRACK_PX.normal.fused < TRACK_PX.thick.fused);
  assert.notEqual(VIEW_COLORS.trackRaw, VIEW_COLORS.trackFused);
});
