import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { PAVED, buildPavedSurfaces, pavedGeometry: geo, pavedRoadIds, roadProfile, surfaceHeight } = await import('../src/paved-surface.ts');

type P = number[];
// 시험 좌표는 캠퍼스 근처(EPSG:5186)로 둔다
const X = 201000, Y = 557000;
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [[X + x0, Y + y0], [X + x1, Y + y0], [X + x1, Y + y1], [X + x0, Y + y1]];
const inside = (x: number, y: number, rings: P[][]) => rings.reduce((n, ring) => {
  let c = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > Y + y !== yj > Y + y && X + x < ((xj - xi) * (Y + y - yi)) / (yj - yi) + xi) c++;
  }
  return n + c;
}, 0) % 2 === 1;
const road = (id: string, coordinates: number[][], more: object = {}) => ({
  id, name: null, roadClass: 'vehicle', structure: 'ordinary', widthM: null, levelId: null, buildingId: null, fromNodeId: `${id}-a`, toNodeId: `${id}-b`,
  geometry: { coordinates: coordinates.map(([x, y, z]) => [X + x, Y + y, z]) }, ...more,
});
/** 삼각형 묶음의 평면 넓이 */
function meshArea(mesh: { positions: number[]; indices: number[] }, stride: number) {
  let area = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => [mesh.positions[mesh.indices[i + k] * stride], mesh.positions[mesh.indices[i + k] * stride + 1]]);
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return area;
}

test('합치기: 겹친 두 네모는 한 고리, 넓이는 겹친 만큼 한 번만', () => {
  const merged = geo.union([[rect(0, 0, 10, 10)], [rect(5, 5, 15, 15)]]);
  assert.equal(merged.length, 1);
  assert.ok(Math.abs(geo.area(merged) - 175) < 1e-3);
  // 떨어진 것은 따로, 방향이 거꾸로인 고리도 같은 면
  assert.equal(geo.union([[rect(0, 0, 10, 10)], [rect(20, 0, 30, 10)]]).length, 2);
  assert.ok(Math.abs(geo.area(geo.union([[rect(0, 0, 10, 10)], [[...rect(5, 5, 15, 15)].reverse()]])) - 175) < 1e-3);
});

test('고인 물 가장자리: 폭 2 m 길은 남고, 가는 가시는 사라지고, 좁은 틈은 메워진다', () => {
  const plaza = rect(0, 0, 20, 20);
  const path = rect(20, 9, 50, 11); // 폭 2 m, 길이 30 m
  const spike = rect(5, 20, 5.8, 30); // 폭 0.8 m 가시
  const pooled = geo.pool([[plaza], [path], [spike]]);
  assert.equal(pooled.length, 1, '광장과 길은 한 면으로 이어진다');
  assert.ok(geo.overlap(pooled, [path]) > 0.97 * 60, '길이 거의 그대로 남는다');
  for (let x = 21; x <= 49; x += 1) assert.ok(inside(x, 10, pooled), `길 가운데 x=${x}`);
  assert.ok(geo.overlap(pooled, [rect(5, 21.5, 5.8, 30)]) < 0.05, '가시는 사라진다');
  // 폭 1.5 m 틈(닫기 반지름의 두 배 2 m보다 좁다)은 메워진다
  const notched = geo.pool([[rect(0, 0, 20, 20)], [rect(21.5, 0, 40, 20)]]);
  assert.equal(notched.length, 1);
  assert.ok(inside(20.75, 10, notched));
  // 3 m 떨어진 것은 따로 남는다
  assert.equal(geo.pool([[rect(0, 0, 20, 20)], [rect(23, 0, 40, 20)]]).length, 2);
});

test('모서리 둥글림: 넓은 면의 바깥 모서리는 반지름 1.5 m 원호', () => {
  const pooled = geo.pool([[rect(0, 0, 20, 20)]]);
  const R = PAVED.cornerRadiusM;
  const near = pooled[0].filter(([x, y]: P) => x - X < R - 0.01 && y - Y < R - 0.01);
  assert.ok(near.length >= 8, '원호 위에 점이 여럿');
  for (const [x, y] of near) assert.ok(Math.abs(Math.hypot(x - X - R, y - Y - R) - R) < 0.05, '원호 중심에서 반지름만큼');
  const tip = Math.min(...pooled[0].map(([x, y]: P) => Math.hypot(x - X, y - Y)));
  assert.ok(Math.abs(tip - (Math.SQRT2 - 1) * R) < 0.05, `모서리 끝에서 ${tip.toFixed(2)} m`);
  // 곧은 변은 그대로
  assert.ok(inside(10, 0.01, pooled) && !inside(10, -0.01, pooled));
  // 좁은 길(폭 2 m) 끝은 작은 반지름으로: 끝 가운데는 남는다
  const lane = geo.pool([[rect(0, 0, 30, 2)]]);
  assert.ok(inside(0.05, 1, lane) && !inside(0.05, 0.05, lane));
});

test('윤곽 차이: 다듬은 윤곽은 원래 윤곽에서 대부분 0.5 m 안, 모서리에서 0.7 m 안', () => {
  const raw = geo.union([[rect(0, 0, 30, 20)], ...geo.band([[X + 30, Y + 10], [X + 60, Y + 10], [X + 80, Y + 30]], 6).map((r: P[]) => [r])]);
  const pooled = geo.pool([raw]);
  const d = geo.deviation(pooled, raw);
  assert.ok(d.median < 0.02, `가운데값 ${d.median}`);
  assert.ok(d.p95 <= 0.5, `95% ${d.p95}`);
  assert.ok(d.max <= 0.7, `최대 ${d.max}`);
  assert.ok(Math.abs(geo.area(pooled) - geo.area(raw)) < 0.02 * geo.area(raw), '넓이는 2% 안');
});

test('건물 안으로 넘치지 않는다', () => {
  const building = rect(15, 5, 30, 15);
  const pooled = geo.pool([[rect(0, 0, 20, 20)]], [[building]]);
  assert.ok(geo.overlap(pooled, [building]) < 0.05);
  assert.ok(inside(10, 10, pooled) && !inside(17, 10, pooled));
  // 건물에 닿는 벽 쪽은 곧게 남는다(벽을 따라 물이 닿은 모양)
  assert.ok(inside(14.9, 10, pooled));
});

test('검은 포장면에 드는 보행로: 포장면 안에 든 길, 폭이 적힌 넓은 길이 포장면·차도에 닿을 때', () => {
  const plaza = [rect(0, 0, 20, 20)];
  const roads = [
    road('in', [[2, 2, 0], [18, 18, 0]], { roadClass: 'pedestrian' }), // 포장면 안
    road('wide', [[20, 10, 0], [50, 10, 0]], { roadClass: 'pedestrian', widthM: 9, toNodeId: 'n1' }), // 포장면에 닿는 폭 9 m
    road('wide2', [[50, 10, 0], [70, 10, 0]], { roadClass: 'pedestrian', widthM: 6, fromNodeId: 'n1' }), // 그 길에 이어진 폭 6 m
    road('narrow', [[20, 5, 0], [50, 5, 0]], { roadClass: 'pedestrian' }), // 닿지만 폭 없음
    road('far', [[100, 100, 0], [130, 100, 0]], { roadClass: 'pedestrian', widthM: 9 }), // 넓지만 안 닿음
    road('stairs', [[5, 5, 0], [15, 5, 0]], { roadClass: 'pedestrian', structure: 'stairs' }), // 계단은 제 색
    road('car', [[200, 0, 0], [230, 0, 0]], { toNodeId: 'n2' }),
    road('byCar', [[230, 0, 0], [260, 0, 0]], { roadClass: 'pedestrian', widthM: 4, fromNodeId: 'n2' }), // 차도 끝에 이어진 폭 4 m
  ];
  assert.deepEqual(pavedRoadIds(roads, [plaza]).sort(), ['byCar', 'in', 'wide', 'wide2']);
  assert.deepEqual(pavedRoadIds(roads, []).sort(), ['byCar']);
});

test('길 높이: 저장 높이가 지면과 0.5 m 안이면 저장 높이, 아니면 다듬은 지면', () => {
  const ground = (x: number) => 100 + 0.1 * (x - X);
  const centre = Array.from({ length: 41 }, (_, i) => [X + i, Y, 100 + 0.1 * i + 0.3] as [number, number, number]);
  assert.equal(roadProfile(centre, ground).source, 'stored');
  assert.equal(roadProfile(centre, ground).line, centre);
  const buried = centre.map(([x, y, z]) => [x, y, z - 3] as [number, number, number]);
  const p = roadProfile(buried, ground);
  assert.equal(p.source, 'ground');
  assert.ok(p.line.every((q: P, i: number) => Math.abs(q[2] - (100 + 0.1 * i)) < 1e-6), '고른 비탈은 그대로');
  // 울퉁불퉁한 지면은 고르게: 양 끝은 지면 높이 그대로, 가운데 톱니는 줄어든다
  const bumpy = (x: number) => 100 + (Math.round(x - X) % 2 === 0 ? 0.6 : -0.6);
  const flat = roadProfile(buried, bumpy).line;
  assert.equal(flat[0][2], bumpy(X));
  assert.ok(Math.max(...flat.slice(8, 32).map((q: P) => Math.abs(q[2] - 100))) < 0.1);
});

test('면 높이: 평평한 영역 안은 바닥 높이, 길 위는 길 높이, 사이는 턱 없이 이어진다', () => {
  const lines = [{ line: [[X + 20, Y + 10, 131], [X + 40, Y + 10, 133]] as [number, number, number][], halfWidthM: 3 }];
  const h = surfaceHeight(lines, [{ ring: rect(0, 0, 20, 20), z: 131 }], () => 99);
  assert.equal(h(X + 10, Y + 10), 131);
  assert.equal(h(X + 20.5, Y + 10), 131, '닫기 반지름 안은 아직 바닥 높이');
  assert.ok(Math.abs(h(X + 35, Y + 10) - 132.5) < 1e-9);
  assert.ok(Math.abs(h(X + 35, Y + 12) - 132.5) < 1e-9, '길 가로 방향은 평평');
  let previous = h(X + 20, Y + 10);
  for (let x = 20.25; x <= 40; x += 0.25) {
    const z = h(X + x, Y + 10);
    assert.ok(z >= previous - 1e-9 && z - previous < 0.2, `x=${x} 에서 턱`);
    previous = z;
  }
  assert.equal(h(X + 300, Y + 300), 99, '길도 영역도 없으면 지면');
});

test('면 만들기: 재질끼리 겹치지 않고, 가장자리 띠·치마·구멍 없는 윤곽이 나온다', () => {
  const ground = () => 100;
  const out = buildPavedSurfaces({
    roads: [
      road('car', [[20, 10, 100.2], [60, 10, 100.2]], { toNodeId: 'n' }),
      road('walk', [[60, 10, 100], [60, 40, 100]], { roadClass: 'pedestrian', fromNodeId: 'n', toNodeId: 'm' }),
      road('walkOnField', [[60, 40, 103], [100, 40, 103]], { roadClass: 'pedestrian', fromNodeId: 'm' }),
      road('under', [[0, 50, 90], [30, 50, 90]], { name: '지하 차도' }),
    ],
    areas: [
      { id: 2, fill: 'asphalt', elevationM: 100.2, rings: [rect(0, 0, 20, 20)] },
      { id: 1, fill: 'field', elevationM: 103, rings: [rect(70, 20, 110, 60)] },
    ],
    buildings: [[rect(30, 12, 40, 30)]],
    ground,
  });
  assert.deepEqual(out.surfaces.map((s: { material: string }) => s.material), ['carriageway', 'pedestrian', 'field']);
  assert.deepEqual(out.heightSource, { car: 'stored', walk: 'stored', walkOnField: 'ground' });
  const [black, grey, field] = out.surfaces;
  // 넓이: 삼각형 넓이의 합 = 다듬은 전체 윤곽의 넓이(겹침도 빈틈도 없다)
  const total = meshArea(black.mesh, 4) + meshArea(grey.mesh, 4) + meshArea(field.mesh, 4);
  assert.ok(Math.abs(total - geo.area(out.outline)) < 0.01 * total, `${total} / ${geo.area(out.outline)}`);
  assert.ok(geo.overlap(out.outline, [rect(30, 12, 40, 30)]) < 0.05, '건물과 안 겹친다');
  // 높이: 포장면·차도는 100.2, 운동장은 103으로 평평. 운동장 위를 지나는 길도 운동장 높이
  const heights = (mesh: { positions: number[] }, pick: (x: number, y: number) => boolean) => mesh.positions.filter((_: number, i: number) => i % 4 === 2 && pick(mesh.positions[i - 2] - X, mesh.positions[i - 1] - Y));
  assert.ok(heights(black.mesh, (x) => x < 55).every((z: number) => Math.abs(z - 100.2) < 1e-6));
  assert.ok(heights(field.mesh, () => true).every((z: number) => z === 103));
  assert.ok(heights(grey.mesh, (x) => x > 72).every((z: number) => z === 103));
  // 가장자리 띠: 바깥 윤곽 위의 점은 1, 띠 폭보다 안쪽은 0, 그 사이만 0~1
  const edgeAt = (x: number, y: number) => {
    let best = Infinity;
    for (const ring of out.outline) ring.forEach((p: P, i: number) => {
      const q = ring[(i + 1) % ring.length];
      const t = Math.max(0, Math.min(1, ((x - p[0]) * (q[0] - p[0]) + (y - p[1]) * (q[1] - p[1])) / ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2)));
      best = Math.min(best, Math.hypot(x - p[0] - (q[0] - p[0]) * t, y - p[1] - (q[1] - p[1]) * t));
    });
    return best;
  };
  let rim = 0, body = 0;
  for (const { mesh } of out.surfaces) {
    for (let i = 0; i < mesh.positions.length; i += 4) {
      const d = edgeAt(mesh.positions[i], mesh.positions[i + 1]), t = mesh.positions[i + 3];
      assert.ok(t >= 0 && t <= 1);
      if (d < 0.005) { assert.ok(t > 0.99, `윤곽 위 ${t}`); rim++; }
      if (d > PAVED.rimWidthM + 0.01) { assert.equal(t, 0); body++; }
      if (t > 0) assert.ok(d < PAVED.rimWidthM + 0.01, '띠는 가장자리에서 띠 폭 안에만');
    }
  }
  assert.ok(rim > 100 && body > 100);
  // 재질이 만나는 안쪽 경계(운동장 위를 지나는 보행로의 양옆)에는 띠가 없다
  const crossing = grey.mesh.positions.filter((_: number, i: number) => i % 4 === 3 && grey.mesh.positions[i - 3] - X > 75 && grey.mesh.positions[i - 3] - X < 95);
  assert.ok(crossing.length > 8 && crossing.every((t: number) => t === 0));
  // 치마: 면이 지면보다 높은 운동장 가장자리에서 지면 아래 0.5 m까지
  const zs = field.skirt.positions.filter((_: number, i: number) => i % 3 === 2);
  assert.equal(Math.max(...zs), 103);
  assert.equal(Math.min(...zs), 100 - PAVED.skirtDepthM);
  // 지형을 숨길 윤곽: 넓이는 그 재질의 삼각형 넓이와 같다
  for (const s of out.surfaces) assert.ok(Math.abs(geo.area(s.outline) - meshArea(s.mesh, 4)) < 0.01 * meshArea(s.mesh, 4));
});

test('지형을 숨길 윤곽은 구멍 없는 고리로 나뉜다(고리 모양 길)', () => {
  const loop = [[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0], [0, 0, 0]];
  const out = buildPavedSurfaces({ roads: [road('loop', loop, { fromNodeId: 'n', toNodeId: 'n' })], areas: [], buildings: [], ground: () => 0 });
  const [black] = out.surfaces;
  assert.equal(out.outline.length, 2, '합친 윤곽에는 구멍이 하나');
  assert.ok(black.outline.length >= 2);
  // 구멍이 없으므로 고리 넓이의 합이 곧 면 넓이이고, 가운데(길 안쪽 땅)는 어느 고리에도 들지 않는다
  const sum = black.outline.reduce((s: number, ring: P[]) => s + geo.area([ring]), 0);
  assert.ok(Math.abs(sum - meshArea(black.mesh, 4)) < 0.01 * sum);
  assert.ok(black.outline.every((ring: P[]) => !inside(20, 20, [ring])));
  assert.ok(black.outline.some((ring: P[]) => inside(20, 0, [ring])));
});
