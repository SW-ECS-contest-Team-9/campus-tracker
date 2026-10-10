import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { ROAD_SURFACE, buildRoadSurfaces: buildGroups, isUnderground, junctionDisc, ribbon, roadWidthM, smoothCentreline, surfaceKind, usesNameForUnderground } = await import('../src/road-surface.ts');

type P = number[];
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0));
/** 점에서 꺾은선까지 가장 가까운 거리 */
function distanceToLine(p: P, line: P[]) {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
    best = Math.min(best, dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
  }
  return best;
}
/** 닫힌 고리의 넓이(반시계 방향이 +) */
const ringArea = (r: P[]) => r.reduce((s, p, i) => s + (p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1]) / 2, 0);
/** 고리의 변끼리 엇갈리는 곳의 수(이웃 변 제외) */
function selfCrossings(r: P[]) {
  const side = (a: P, b: P, c: P) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  let n = 0;
  for (let i = 0; i < r.length; i++) {
    for (let j = i + 2; j < r.length; j++) {
      if (i === 0 && j === r.length - 1) continue;
      const [a, b, c, d] = [r[i], r[(i + 1) % r.length], r[j], r[(j + 1) % r.length]];
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) n++;
    }
  }
  return n;
}
/** 삼각형들의 평면 넓이(부호 있음) */
function triangleAreas(m: { positions: number[]; indices: number[] }) {
  const areas: number[] = [];
  for (let i = 0; i < m.indices.length; i += 3) areas.push(ringArea([0, 1, 2].map((k) => [m.positions[m.indices[i + k] * 3], m.positions[m.indices[i + k] * 3 + 1]])));
  return areas;
}
const road = (coordinates: P[], extra: object = {}) => ({ name: null, roadClass: 'vehicle', widthM: null, levelId: null, fromNodeId: 'a', toNodeId: 'b', geometry: { coordinates }, ...extra });
const BEND = [[0, 0, 5], [30, 0, 5], [30, 30, 5]];
/** 차도만 있는 입력: 지상 고리 목록과 지하 삼각형(종류별 묶음을 푼 것) */
const buildRoadSurfaces = (roads: object[]) => {
  const s = buildGroups(roads as never);
  return { ground: s.ground.flatMap((g: { rings: P[][] }) => g.rings), underground: s.underground[0]?.mesh ?? { positions: [], indices: [] } };
};

test('폭: 도로에 적힌 값이 먼저, 없으면 유형별 표시 기본값', () => {
  assert.equal(roadWidthM({ widthM: 7.2, roadClass: 'vehicle' }), 7.2);
  assert.equal(roadWidthM({ widthM: null, roadClass: 'vehicle' }), ROAD_SURFACE.defaultWidthM.vehicle);
  assert.equal(roadWidthM({ widthM: null, roadClass: 'shared' }), ROAD_SURFACE.defaultWidthM.shared);
  assert.equal(roadWidthM({ widthM: null, roadClass: 'pedestrian', structure: 'ordinary' }), ROAD_SURFACE.defaultWidthM.pedestrian);
  assert.equal(roadWidthM({ widthM: null, roadClass: 'pedestrian', structure: 'stairs' }), ROAD_SURFACE.defaultWidthM.stairs);
  assert.equal(roadWidthM({ widthM: 4, roadClass: 'pedestrian', structure: 'stairs' }), 4);
});

test('지하 판정: 층이 지하이면 지하, 층이 없으면 이름의 "지하"', () => {
  assert.equal(isUnderground({ levelId: 'B1', name: null }), true);
  assert.equal(isUnderground({ levelId: '1F', name: '지하 차도' }), false);
  assert.equal(isUnderground({ levelId: null, name: '지하 차도 (본관·문예관 사이)' }), true);
  assert.equal(isUnderground({ levelId: null, name: '정문 진입로' }), false);
  assert.equal(isUnderground({ levelId: null, name: null }), false);
  // 층이 없을 때만 이름을 본다: 건물 안 길은 이름의 지하층(B1)도 지하. 층이 적혀 있으면 이름은 안 본다
  assert.equal(isUnderground({ levelId: null, name: '북악관 B1 진입 통로 (추정)', buildingId: '북악관' }), true);
  assert.equal(isUnderground({ levelId: null, name: '청운관 앞–혜인관 B1 지상 연결 (추정)', buildingId: null }), false, '실외 길 이름의 B1은 가는 곳');
  assert.equal(isUnderground({ levelId: '북악관_Z146.18_추정', name: '지하 통로' }), false);
  assert.equal(usesNameForUnderground({ levelId: null, name: '지하 차도' }), true);
  assert.equal(usesNameForUnderground({ levelId: 'B1', name: '지하 차도' }), false);
});

test('면 종류: 차도·보행로·계단·횡단, 실내 지상 길과 승강기는 그리지 않는다', () => {
  const k = (extra: object) => surfaceKind({ roadClass: 'pedestrian', structure: 'ordinary', buildingId: null, levelId: null, name: null, ...extra });
  assert.equal(k({ roadClass: 'vehicle', structure: 'ramp' }), 'carriageway');
  assert.equal(k({ roadClass: 'shared' }), 'carriageway');
  assert.equal(k({}), 'pedestrian');
  assert.equal(k({ structure: 'ramp' }), 'pedestrian');
  assert.equal(k({ structure: 'stairs' }), 'stairs');
  assert.equal(k({ structure: 'crossing' }), 'crossing');
  assert.equal(k({ structure: 'elevator' }), null);
  assert.equal(k({ structure: 'indoor_corridor', buildingId: '북악관' }), null);
  assert.equal(k({ structure: 'stairs', buildingId: '북악관' }), null);
  assert.equal(k({ structure: 'indoor_corridor', buildingId: '북악관', levelId: 'B1' }), 'pedestrian');
  assert.equal(k({ structure: 'stairs', buildingId: '북악관', name: '북악관 B1 진입 계단' }), 'stairs');
});

test('종류별 묶음: 그리는 순서는 보행로·계단·차도·횡단, 지하 보행로는 5 cm 올린다', () => {
  const line = (y: number, extra: object) => road([[0, y, 100], [10, y, 100]], { fromNodeId: `a${y}`, toNodeId: `b${y}`, ...extra });
  const s = buildGroups([
    line(0, { roadClass: 'pedestrian', structure: 'crossing' }), line(10, {}), line(20, { roadClass: 'pedestrian', structure: 'stairs' }), line(30, { roadClass: 'pedestrian', structure: 'ordinary' }),
    line(40, { roadClass: 'pedestrian', structure: 'ordinary', levelId: 'B1' }), line(50, { levelId: 'B1' }), line(60, { roadClass: 'pedestrian', structure: 'indoor_corridor', buildingId: 'x' }),
  ] as never);
  assert.deepEqual(s.ground.map((g: { kind: string }) => g.kind), ['pedestrian', 'stairs', 'carriageway', 'crossing']);
  assert.ok(s.ground.every((g: { rings: P[][] }) => g.rings.length === 1));
  assert.deepEqual(s.underground.map((g: { kind: string }) => g.kind), ['pedestrian', 'carriageway']);
  const zs = (m: { positions: number[] }) => [...new Set(m.positions.filter((_, i) => i % 3 === 2))];
  assert.deepEqual(zs(s.underground[0].mesh), [100 + ROAD_SURFACE.undergroundPedestrianLiftM]);
  assert.deepEqual(zs(s.underground[1].mesh), [100]);
});

test('곧은 길은 폭이 맞는 직사각형이 된다', () => {
  const { ground, underground } = buildRoadSurfaces([road([[0, 0, 10], [20, 0, 10]], { widthM: 7 })]);
  assert.equal(underground.indices.length, 0);
  assert.equal(ground.length, 1);
  assert.ok(Math.abs(ringArea(ground[0]) - 20 * 7) < 1e-9);
  const ys = ground[0].map((p: P) => p[1]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [-3.5, 3.5]);
  const xs = ground[0].map((p: P) => p[0]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 20]);
});

test('직각으로 꺾인 길: 양 끝 그대로, 저장된 꼭짓점에서 0.3 m 안, 1 m 간격', () => {
  const c = smoothCentreline(BEND);
  assert.deepEqual(c[0], BEND[0]);
  assert.deepEqual(c[c.length - 1], BEND[2]);
  // 곡선은 꼭짓점에서 0.3 m 안을 지난다. 1 m 표본을 이은 선은 그보다 조금(1 cm 안) 더 멀 수 있다
  const corner = distanceToLine(BEND[1], c);
  assert.ok(corner > 0.05 && corner <= ROAD_SURFACE.smoothMaxDeviationM + 0.01, `모서리에서 ${corner}`);
  assert.ok(c.every((p: P) => distanceToLine(p, BEND) <= ROAD_SURFACE.smoothMaxDeviationM + 1e-9));
  for (let i = 1; i < c.length; i++) assert.ok(dist(c[i], c[i - 1]) <= ROAD_SURFACE.sampleStepM + 1e-9);
  // 이웃 표본 사이 방향 변화가 작다(바깥 가장자리가 둥글다)
  for (let i = 1; i + 1 < c.length; i++) {
    const a = Math.atan2(c[i][1] - c[i - 1][1], c[i][0] - c[i - 1][0]);
    const b = Math.atan2(c[i + 1][1] - c[i][1], c[i + 1][0] - c[i][0]);
    assert.ok(Math.abs(b - a) <= ROAD_SURFACE.maxTurnPerSampleRad + 1e-9, `방향 변화 ${b - a}`);
  }
});

test('직각으로 꺾인 길의 면은 겹치거나 뒤집히지 않는다(폭 6 m가 모서리 곡선보다 넓다)', () => {
  const c = smoothCentreline(BEND);
  const { left, right } = ribbon(c, 6);
  assert.equal(left.length, c.length);
  assert.equal(right.length, c.length);
  // 왼쪽으로 꺾이므로 안쪽(왼쪽) 가장자리는 두 직선 가장자리가 만나는 점 (27, 3)에 모인다
  assert.ok(left.some((p: P) => Math.hypot(p[0] - 27, p[1] - 3) < 1e-6));
  assert.ok(left.every((p: P) => p[0] <= 27 + 1e-9 && p[1] >= 3 - 1e-9));
  assert.ok(right.every((p: P, i: number) => Math.abs(dist(p, c[i]) - 3) < 1e-9), '바깥 가장자리는 가운데 선에서 폭의 절반');
  const [ring] = buildRoadSurfaces([road(BEND)]).ground;
  assert.equal(selfCrossings(ring), 0);
  const area = ringArea(ring);
  assert.ok(area > 60 * 6 - 6 * 6 && area < 60 * 6, `넓이 ${area}`);
  // 같은 길이 지하일 때 삼각형: 뒤집힌 것이 없고 넓이 합이 같다
  const areas = triangleAreas(buildRoadSurfaces([road(BEND, { levelId: 'B1' })]).underground);
  assert.ok(areas.every((a) => a >= -1e-9), `뒤집힌 삼각형 ${Math.min(...areas)}`);
  assert.ok(Math.abs(areas.reduce((s, a) => s + a, 0) - area) < 1e-6);
});

test('경사로 높이는 계단 없이 한 방향으로만 변한다', () => {
  const c = smoothCentreline([[0, 0, 100], [20, 0, 102], [20, 25, 106], [45, 25, 106.5]]);
  for (let i = 1; i < c.length; i++) {
    assert.ok(c[i][2] >= c[i - 1][2] - 1e-12);
    assert.ok(c[i][2] - c[i - 1][2] <= 0.2, '1 m에 20 cm 넘게 뛰지 않는다(가장 급한 구간 16%)');
  }
  assert.equal(c[0][2], 100);
  assert.equal(c[c.length - 1][2], 106.5);
});

test('만나는 점의 원은 길 기울기를 따른다', () => {
  const rim = junctionDisc([0, 0, 50], 3, [[-3, 0, 49.7], [3, 0, 50.3]]);
  assert.equal(rim.length, ROAD_SURFACE.discSegments);
  for (const p of rim) {
    assert.ok(Math.abs(Math.hypot(p[0], p[1]) - 3) < 1e-9);
    assert.ok(Math.abs(p[2] - (50 + 0.1 * p[0])) < 1e-3, '길 방향으로 10%, 길 가로 방향으로는 수평');
  }
});

test('만나는 점의 원: 거의 한 줄로 만나는 길의 기울기가 달라도 옆으로 치솟지 않는다', () => {
  // 한쪽은 평평, 반대쪽은 급한 계단, 둘이 3도쯤 어긋나 있다(북악관 B1 진입 계단 꼴)
  const rim = junctionDisc([0, 0, 130.5], 1, [[1, 0.05, 130.5], [-1.85, 0, 129.7]]);
  for (const p of rim) assert.ok(Math.abs(p[2] - 130.5) <= 0.45, `원 가장자리 높이 ${p[2]}`);
  // 길 방향 기울기는 남는다: 계단 쪽이 낮고 반대쪽이 높다
  assert.ok(rim[0][2] > 130.5 && rim[ROAD_SURFACE.discSegments / 2][2] < 130.5);
  // 직각으로 만나는 두 길은 그대로 두 방향 기울기를 다 따른다
  const cross = junctionDisc([0, 0, 50], 3, [[3, 0, 50.3], [0, 3, 49.4]]);
  for (const p of cross) assert.ok(Math.abs(p[2] - (50 + 0.1 * p[0] - 0.2 * p[1])) < 1e-3);
});

test('두 차도가 만나는 점에만 원을 채우고, 지상과 지하는 따로 센다', () => {
  const first = road([[0, 0, 0], [10, 0, 0]]);
  const second = road([[10, 0, 0], [10, 10, 0]], { fromNodeId: 'b', toNodeId: 'c' });
  assert.equal(buildRoadSurfaces([first]).ground.length, 1);
  assert.equal(buildRoadSurfaces([first, second]).ground.length, 3);
  // 지상 길과 지하 길이 한 점에서 만나면 원을 만들지 않는다(지하 길은 지상에 그리지 않는다)
  const mixed = buildRoadSurfaces([first, { ...second, name: '지하 차도' }]);
  assert.equal(mixed.ground.length, 1);
  assert.equal(mixed.underground.indices.length, 10 * 2 * 3);
  // 지하 삼각형은 저장된 높이 그대로
  const deep = buildRoadSurfaces([road([[0, 0, 126.8], [10, 0, 126.8]], { levelId: 'B1' })]).underground;
  assert.ok(deep.positions.filter((_, i) => i % 3 === 2).every((z) => z === 126.8));
});
