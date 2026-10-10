import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { clipLonLatPolygons, clipMesh, clipPolyline, clipRing, extendToBox, heightTicks, lineCrossings, meshCrossings, planeAlong, planePoint, planeSide, profileHeight, ringIntervals, sectionPlane, terrainProfile } = await import('../src/section.ts');
const { tmForward, tmInverse } = await import('../src/tm.ts');

type P = number[];
const ringArea = (r: P[]) => r.reduce((s, p, i) => s + (p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1]) / 2, 0);
// 동쪽으로 가는 선(y = 10): 남기는 쪽은 왼쪽(북쪽, y > 10)
const EAST = sectionPlane([0, 10], [100, 10]);

test('면의 어느 쪽인지: A→B의 왼쪽이 남는 쪽, flip이면 반대', () => {
  assert.equal(EAST.length, 100);
  assert.equal(planeSide(EAST, [50, 13]), 3);
  assert.equal(planeSide(EAST, [50, 4]), -6);
  assert.equal(planeSide(EAST, [-500, 10]), 0);
  assert.equal(planeSide(sectionPlane([0, 10], [100, 10], true), [50, 13]), -3);
  assert.equal(planeAlong(EAST, [30, 99]), 30);
  assert.deepEqual(planePoint(EAST, 30, 2), [30, 12]);
  // 비스듬한 선: 거리는 선에 수직으로 잰다
  const diagonal = sectionPlane([0, 0], [10, 10]);
  assert.ok(Math.abs(planeSide(diagonal, [0, 10]) - Math.SQRT2 * 5) < 1e-12);
  assert.ok(Math.abs(planeSide(diagonal, [10, 0]) + Math.SQRT2 * 5) < 1e-12);
});

test('꺾은선 자르기: 남는 쪽 조각만, 자른 점의 높이는 비례로', () => {
  // 남쪽에서 북쪽으로 갔다가 다시 남쪽, 다시 북쪽
  const pieces = clipPolyline(EAST, [[0, 0, 100], [0, 20, 120], [10, 20, 120], [10, 0, 100], [20, 0, 100], [20, 30, 130]]);
  assert.deepEqual(pieces, [
    [[0, 10, 110], [0, 20, 120], [10, 20, 120], [10, 10, 110]],
    [[20, 10, 110], [20, 30, 130]],
  ]);
  assert.deepEqual(clipPolyline(EAST, [[0, 0], [5, 5]]), []);
  const kept = [[0, 11], [5, 15]];
  assert.deepEqual(clipPolyline(EAST, kept), [kept]);
});

test('다각형 자르기: 넓이가 남는 쪽만큼, 다 숨는 것은 빈 고리', () => {
  const square = [[0, 0], [20, 0], [20, 20], [0, 20]];
  const kept = clipRing(EAST, square);
  assert.equal(ringArea(kept), 200);
  assert.ok(kept.every((p: P) => p[1] >= 10));
  assert.deepEqual(clipRing(EAST, [[0, 0], [20, 0], [20, 9], [0, 9]]), []);
  assert.deepEqual(clipRing(EAST, [[0, 11], [20, 11], [20, 19]]), [[0, 11], [20, 11], [20, 19]]);
  // ㄷ자(오목)를 가로로 자르면 두 덩어리: 한 고리로 이어져 나오지만 넓이는 두 덩어리의 합
  const u = [[0, 0], [30, 0], [30, 20], [20, 20], [20, 5], [10, 5], [10, 20], [0, 20]];
  assert.equal(ringArea(clipRing(EAST, u)), 200);
  // 높이도 같이 보간
  const sloped = clipRing(EAST, [[0, 0, 100], [20, 0, 100], [20, 20, 120], [0, 20, 120]]);
  assert.ok(sloped.every((p: P) => Math.abs(p[2] - (100 + p[1])) < 1e-9));
});

test('삼각형 묶음 자르기: 남는 넓이, 저장 높이 유지', () => {
  const mesh = { positions: [0, 0, 5, 20, 0, 5, 0, 20, 5, 20, 0, 5, 20, 20, 5, 0, 20, 5], indices: [0, 1, 2, 3, 4, 5] };
  const out = clipMesh(EAST, mesh);
  let area = 0;
  for (let i = 0; i < out.indices.length; i += 3) area += ringArea([0, 1, 2].map((k) => [out.positions[out.indices[i + k] * 3], out.positions[out.indices[i + k] * 3 + 1]]));
  assert.ok(Math.abs(area - 200) < 1e-9);
  assert.ok(out.positions.filter((_: number, i: number) => i % 3 === 2).every((z: number) => z === 5));
  assert.ok(out.positions.filter((_: number, i: number) => i % 3 === 1).every((y: number) => y >= 10));
  assert.equal(clipMesh(sectionPlane([0, 30], [100, 30]), mesh).indices.length, 0);
});

test('합친 길 면 자르기: 꼭짓점마다 값이 넷(x, y, 높이, 가장자리)이어도 잘린 곳에서 함께 보간, 단면선과 만나는 구간', () => {
  // 남→북으로 오르는 면(높이 100 → 120), 가장자리 값은 남쪽 0 → 북쪽 1
  const mesh = { positions: [0, 0, 100, 0, 20, 0, 100, 0, 20, 20, 120, 1, 0, 20, 120, 1], indices: [0, 1, 2, 0, 2, 3] };
  const out = clipMesh(EAST, mesh, 4);
  assert.equal(out.positions.length % 4, 0);
  let area = 0;
  for (let i = 0; i < out.indices.length; i += 3) area += ringArea([0, 1, 2].map((k) => [out.positions[out.indices[i + k] * 4], out.positions[out.indices[i + k] * 4 + 1]]));
  assert.ok(Math.abs(area - 200) < 1e-9);
  for (let i = 0; i < out.positions.length; i += 4) {
    assert.ok(out.positions[i + 1] >= 10);
    assert.ok(Math.abs(out.positions[i + 2] - (100 + out.positions[i + 1])) < 1e-9, '높이');
    assert.ok(Math.abs(out.positions[i + 3] - out.positions[i + 1] / 20) < 1e-9, '가장자리 값');
  }
  // 단면선(y = 10)과 만나는 구간: 삼각형마다 하나, 합치면 x 0~20, 높이 110
  const cuts = meshCrossings(EAST, mesh, 4);
  assert.equal(cuts.length, 2);
  assert.ok(cuts.flat().every(([, z]: P) => Math.abs(z - 110) < 1e-9));
  assert.deepEqual([Math.min(...cuts.flat().map(([d]: P) => d)), Math.max(...cuts.flat().map(([d]: P) => d))], [0, 20]);
  assert.deepEqual(meshCrossings(sectionPlane([0, 30], [100, 30]), mesh, 4), []);
});

test('경위도 건물 평면 자르기: 좌표 변환을 거쳐도 넓이가 맞고, 다 숨는 건물은 빠진다', () => {
  const lonLat = (x: number, y: number) => { const g = tmInverse(x, y); return [g.longitude, g.latitude]; };
  const rect = (x0: number, y0: number, x1: number, y1: number) => [lonLat(x0, y0), lonLat(x1, y0), lonLat(x1, y1), lonLat(x0, y1), lonLat(x0, y0)];
  const plane = sectionPlane([201000, 557010], [201100, 557010]);
  const out = clipLonLatPolygons(plane, [[rect(201000, 557000, 201020, 557020), rect(201005, 557012, 201010, 557016)], [rect(201050, 556990, 201060, 557000)]]);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 2, '구멍은 남는 쪽에 있어 그대로');
  const metres = out[0][0].slice(0, -1).map(([lon, lat]: P) => { const p = tmForward(lat, lon); return [p.x, p.y]; });
  assert.ok(Math.abs(ringArea(metres) - 200) < 0.01);
  assert.deepEqual(out[0][0][0], out[0][0][out[0][0].length - 1], '고리는 닫혀 있다');
});

test('지형 단면: 양 끝 포함, 간격대로, 높이는 그 점의 지형', () => {
  const plane = sectionPlane([0, 0], [10.5, 0]);
  const profile = terrainProfile((x: number) => 100 + 2 * x, plane, 1);
  assert.equal(profile.length, 12);
  assert.deepEqual(profile[0], { d: 0, z: 100 });
  assert.deepEqual(profile[3], { d: 3, z: 106 });
  assert.deepEqual(profile[11], { d: 10.5, z: 121 });
  assert.equal(profileHeight(profile, 2.5), 105);
  assert.equal(profileHeight(profile, -4), 100);
  assert.equal(profileHeight(profile, 99), 121);
  // 비스듬한 선에서도 표본 점은 선 위
  const d = terrainProfile((x: number, y: number) => x - y, sectionPlane([0, 0], [30, 40]), 5);
  assert.equal(d.length, 11);
  assert.ok(d.every((s: { d: number; z: number }) => Math.abs(s.z - (0.6 * s.d - 0.8 * s.d)) < 1e-9));
});

test('단면 선과 만나는 곳: 길은 거리와 높이, 건물은 구간', () => {
  // 길이 x = 40에서 선을 남→북으로 건넌다. 높이 100 → 104, 건너는 곳은 중간
  assert.deepEqual(lineCrossings(EAST, [[40, 0, 100], [40, 20, 104]]), [{ d: 40, z: 102 }]);
  assert.deepEqual(lineCrossings(EAST, [[140, 0, 100], [140, 20, 104]]), [], 'A~B 밖은 세지 않는다');
  assert.deepEqual(lineCrossings(EAST, [[40, 0], [40, 5]]), []);
  assert.deepEqual(ringIntervals(EAST, [[20, 0], [50, 0], [50, 30], [20, 30]]), [[20, 50]]);
  // ㄷ자 건물은 두 구간, A 앞에 걸친 건물은 A에서 잘린다
  assert.deepEqual(ringIntervals(EAST, [[0, 0], [30, 0], [30, 20], [20, 20], [20, 5], [10, 5], [10, 20], [0, 20]].map(([x, y]) => [x + 60, y])), [[60, 70], [80, 90]]);
  assert.deepEqual(ringIntervals(EAST, [[-10, 0], [15, 0], [15, 30], [-10, 30]]), [[0, 15]]);
  assert.deepEqual(ringIntervals(EAST, [[20, 20], [50, 20], [50, 30], [20, 30]]), []);
});

test('선을 지형 범위 끝까지 늘리기, 높이 눈금', () => {
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  assert.deepEqual(extendToBox([40, 10], [60, 10], box), { a: [0, 10], b: [100, 10] });
  assert.deepEqual(extendToBox([60, 10], [40, 10], box), { a: [100, 10], b: [0, 10] }, '방향은 그대로');
  assert.deepEqual(extendToBox([10, 10], [20, 20], box), { a: [0, 0], b: [50, 50] });
  assert.equal(extendToBox([40, 60], [60, 60], box), null);
  assert.deepEqual(heightTicks(118, 141), [120, 125, 130, 135, 140]);
  assert.deepEqual(heightTicks(95, 171), [100, 110, 120, 130, 140, 150, 160, 170]);
});
