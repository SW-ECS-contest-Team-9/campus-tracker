import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { GROUND, buildCampusGround } = await import('../src/campus-ground.ts');
const { polygonContains, polygonOps, growPolygons } = await import('../src/polygon-ops.ts');

type P = number[];
const X0 = 201000, Y0 = 557300;
const rect = (x: number, y: number, w: number, h: number): P[] => [[X0 + x, Y0 + y], [X0 + x + w, Y0 + y], [X0 + x + w, Y0 + y + h], [X0 + x, Y0 + y + h]];
const area = (r: P[]) => Math.abs(r.reduce((s, p, i) => s + ((p[0] - r[0][0]) * (r[(i + 1) % r.length][1] - r[0][1]) - (r[(i + 1) % r.length][0] - r[0][0]) * (p[1] - r[0][1])) / 2, 0));
const toSegment = (p: P, a: P, b: P) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
};
const toRing = (p: P, ring: P[]) => Math.min(...ring.map((a, i) => toSegment(p, a, ring[(i + 1) % ring.length])));

// 캠퍼스 100 × 80 m. 서버 지형: 동쪽으로 오르는 비탈 + 가운데에 12 m 솟은 가짜 봉우리(건물을 덮는 지형 흉내)
const CAMPUS = rect(0, 0, 100, 80);
const terrain = (x: number, y: number) => 100 + 0.1 * (x - X0) + 12 * Math.exp(-(((x - X0 - 40) ** 2 + (y - Y0 - 30) ** 2) / 200));
const BUILDINGS = [
  { polygon: [rect(20, 20, 10, 10)], groundM: 105, baseM: 104 }, // A
  { polygon: [rect(34, 20, 10, 10)], groundM: 95, baseM: 94 }, // B: A 옆 4 m, 10 m 낮다
  { polygon: [rect(60, 20, 10, 10)], groundM: 110, baseM: 109 }, // C
  { polygon: [rect(70, 20, 10, 10)], groundM: 100, baseM: 99 }, // D: C 와 벽을 맞댐, 10 m 낮다
];
// 이미 그려진 면: 108 m 평평한 기단(삼각형 둘)
const PLATFORM = rect(20, 50, 30, 10);
const KNOWN = [{ polygons: [[PLATFORM]], mesh: { positions: [...PLATFORM[0], 108, ...PLATFORM[1], 108, ...PLATFORM[2], 108, ...PLATFORM[3], 108], indices: [0, 1, 2, 0, 2, 3] }, stride: 3 }];
const ground = buildCampusGround({ campus: [[CAMPUS]], terrain, buildings: BUILDINGS, known: KNOWN });
const vertices: P[] = [];
for (let i = 0; i < ground.mesh.positions.length; i += 3) vertices.push(ground.mesh.positions.slice(i, i + 3));
const tris: P[][] = [];
for (let i = 0; i < ground.mesh.indices.length; i += 3) tris.push([0, 1, 2].map((k) => vertices[ground.mesh.indices[i + k]]));

test('중립 바닥은 건물 벽에서 그 건물의 지면 높이보다 높지 않다 (벽을 타고 오르지 않는다)', () => {
  let atWalls = 0;
  for (const v of vertices) {
    for (const b of BUILDINGS) {
      if (toRing(v, b.polygon[0]) > GROUND.wallReachM) continue;
      atWalls++;
      assert.ok(v[2] <= b.groundM - GROUND.sinkM + 1e-9, `${v} > ${b.groundM}`);
    }
  }
  assert.ok(atWalls > 40);
  // 떨어져 있는 건물의 벽에서는 정확히 그 지면 높이(낮은 이웃과 맞닿은 모서리만 더 낮다)
  for (const v of vertices) if (toRing(v, BUILDINGS[1].polygon[0]) < 0.01) assert.ok(Math.abs(v[2] - (95 - GROUND.sinkM)) < 1e-9);
  // 가짜 봉우리는 사라졌다: 봉우리 자리(A·B 사이 위쪽)에서 지형은 110 m 를 넘지만 바닥은 건물 지면들 사이
  assert.ok(terrain(X0 + 40, Y0 + 32) > 114);
  assert.ok(ground.height(X0 + 39, Y0 + 33) < 106);
});

test('중립 바닥에는 제 봉우리도 골도 없다: 모든 점이 아는 높이들의 최저와 최고 사이, 안쪽 점은 둘레의 평균', () => {
  const edge = [0, 100].flatMap((x) => [0, 40, 80].map((y) => terrain(X0 + x, Y0 + y)));
  const lo = Math.min(...BUILDINGS.map((b) => b.groundM), 108, ...edge), hi = Math.max(...BUILDINGS.map((b) => b.groundM), 108, ...edge);
  for (const v of vertices) assert.ok(v[2] >= lo - GROUND.sinkM - 1e-6 && v[2] <= hi + 1e-6, `${v}`);
  // 칸 가운데(홀수 m)에서: 네 이웃의 평균
  for (const [x, y] of [[9, 9], [51, 39], [85, 61], [11, 71], [55, 9]]) {
    const h = (dx: number, dy: number) => ground.height(X0 + x + dx, Y0 + y + dy);
    assert.ok(Math.abs(h(0, 0) - (h(2, 0) + h(-2, 0) + h(0, 2) + h(0, -2)) / 4) < 0.01, `${x},${y}`);
  }
});

test('중립 바닥은 그려진 면과 턱 없이 만나고, 캠퍼스 가장자리에서는 바깥 지형 높이다', () => {
  let onPlatform = 0, onEdge = 0;
  for (const v of vertices) {
    if (toRing(v, PLATFORM) < 1e-6) { onPlatform++; assert.ok(Math.abs(v[2] - (108 - GROUND.sinkM)) < 1e-9, `${v}`); }
    if (toRing(v, CAMPUS) < 1e-6) { onEdge++; assert.ok(Math.abs(v[2] - (terrain(v[0], v[1]) - GROUND.sinkM)) < 1e-9, `${v}`); }
  }
  assert.ok(onPlatform >= 20 && onEdge >= 80);
  // 그려진 면 아래에서 높이 함수는 그 면의 높이(단면도가 읽는 값)
  assert.ok(Math.abs(ground.height(X0 + 35, Y0 + 55) - 108) < 1e-6);
  assert.ok(Math.abs(ground.height(X0 + 25, Y0 + 25) - 105) < 1e-6);
  // 가장자리 밖 띠(GROUND.apronM): 바깥 지형 높이 그대로, 캠퍼스 밖에만 있다. 지형은 그 띠의 절반까지 숨긴다
  let band = 0;
  for (let i = 0; i < ground.apron.indices.length; i += 3) {
    const t = [0, 1, 2].map((k) => ground.apron.positions.slice(ground.apron.indices[i + k] * 3, ground.apron.indices[i + k] * 3 + 3));
    band += area(t);
    for (const v of t) assert.ok(Math.abs(v[2] - (terrain(v[0], v[1]) - GROUND.sinkM)) < 1e-9);
    const c = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3];
    assert.ok(!polygonContains(c[0], c[1], [CAMPUS]));
  }
  const a = GROUND.apronM;
  assert.ok(Math.abs(band - ((100 + 2 * a) * (80 + 2 * a) - 8000)) < 1e-3);
  assert.ok(Math.abs(area(ground.clip[0][0]) - (100 + a) * (80 + a)) < 1e-3);
  // 띠 바깥 가장자리 전체를 따라 세로 면이 아래로 GROUND.edgeSkirtM 까지
  let length = 0;
  for (let i = 0; i < ground.skirt.indices.length; i += 6) {
    const p = (k: number) => ground.skirt.positions.slice(ground.skirt.indices[i + k] * 3, ground.skirt.indices[i + k] * 3 + 3);
    length += Math.hypot(p(1)[0] - p(0)[0], p(1)[1] - p(0)[1]);
    assert.ok(Math.abs(p(1)[2] - p(2)[2] - (GROUND.edgeSkirtM - GROUND.sinkM)) < 1e-9);
  }
  assert.ok(Math.abs(length - 2 * (100 + 2 * a + 80 + 2 * a)) < 1e-6, `${length}`);
});

test('중립 바닥은 건물과 그려진 면을 뺀 자리만 덮는다, 삼각형 변은 GROUND.edgeM 이하', () => {
  const taken = [...BUILDINGS.map((b) => b.polygon), [PLATFORM]];
  let total = 0;
  for (const t of tris) {
    total += area(t);
    const c = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3];
    assert.ok(!taken.some((p) => polygonContains(c[0], c[1], p)));
    for (let e = 0; e < 3; e++) assert.ok(Math.hypot(t[e][0] - t[(e + 1) % 3][0], t[e][1] - t[(e + 1) % 3][1]) <= GROUND.edgeM + 1e-9);
  }
  assert.ok(Math.abs(total - (100 * 80 - 4 * 100 - 300)) < 1e-3, `${total}`);
  assert.ok(Math.abs(ground.region.reduce((s: number, p: P[][]) => s + area(p[0]) - p.slice(1).reduce((h, r) => h + area(r), 0), 0) - total) < 1e-3);
});

test('밑동이 뜨는 건물은 옆의 가장 낮은 면까지 내려 그린다 (기초)', () => {
  // C(바닥 109 m)는 D(지면 100 m)와 맞닿아 있다: 맞닿은 모서리에서 바닥이 100 m 이므로 C 를 그 아래까지 내린다
  assert.ok(ground.foundations[2] !== null && ground.foundations[2] <= 100 - GROUND.foundationDepthM + 1e-9, `${ground.foundations}`);
  // 가장 낮은 건물들은 뜨지 않는다 (기초는 건물 바닥보다 낮은 면이 옆에 있을 때만)
  assert.equal(ground.foundations[1], null);
  assert.equal(ground.foundations[3], null);
  ground.foundations.forEach((f: number | null, k: number) => assert.ok(f === null || f < BUILDINGS[k].baseM));
  // 건물 바닥보다 낮은 기단이 벽에 붙어 있으면 그 기단 높이까지
  const low = [{ polygons: [[rect(10, 20, 9.95, 10)]], mesh: { positions: [X0 + 10, Y0 + 20, 101, X0 + 19.95, Y0 + 20, 101, X0 + 19.95, Y0 + 30, 101, X0 + 10, Y0 + 30, 101], indices: [0, 1, 2, 0, 2, 3] }, stride: 3 }];
  const withLow = buildCampusGround({ campus: [[CAMPUS]], terrain, buildings: BUILDINGS, known: low });
  assert.ok(withLow.foundations[0] !== null && withLow.foundations[0] <= 101 - GROUND.foundationDepthM + 1e-9, `${withLow.foundations}`);
});

test('아는 것이 없어도, 캠퍼스가 없어도 깨지지 않는다', () => {
  const bare = buildCampusGround({ campus: [[CAMPUS]], terrain: () => 120, buildings: [], known: [] });
  assert.ok(bare.mesh.indices.length > 0);
  for (let i = 2; i < bare.mesh.positions.length; i += 3) assert.ok(Math.abs(bare.mesh.positions[i] - (120 - GROUND.sinkM)) < 1e-6);
  const none = buildCampusGround({ campus: [], terrain, buildings: BUILDINGS, known: KNOWN });
  assert.equal(none.mesh.indices.length, 0);
  assert.equal(none.height(X0, Y0), terrain(X0, Y0));
  // 다각형 연산: 겹친 것은 합쳐지고, 구멍은 구멍으로 남는다
  const grown = growPolygons([[rect(0, 0, 10, 10), rect(4, 4, 2, 2)]], 0.5);
  assert.equal(grown.length, 1);
  assert.equal(grown[0].length, 2);
  assert.ok(Math.abs(area(grown[0][0]) - 121) < 0.01 && Math.abs(area(grown[0][1]) - 1) < 0.01);
  assert.equal(polygonOps('union', [[rect(0, 0, 10, 10)], [rect(5, 0, 10, 10)]]).length, 1);
});
