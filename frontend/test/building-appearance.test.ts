import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import 를 node 테스트에서 .ts 로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { decorate, storeys, wallTopM } = await import('../src/building-appearance.ts');

const X0 = 201000, Y0 = 557300;
/** 40 x 12 m 네모(닫힌 고리) */
const block = [[[X0, Y0], [X0 + 40, Y0], [X0 + 40, Y0 + 12], [X0, Y0 + 12], [X0, Y0]]];
const tris = (m: { positions: number[] }) => m.positions.length / 9;
const zs = (m: { positions: number[] }) => m.positions.filter((_, i) => i % 3 === 2);
const brick = { wall: 'brick', windows: { style: 'rows' as const, floorsM: [96, 100, 103.5, 107, 110.5, 114, 117.5] } };

test('창 줄은 노트의 층 바닥 높이에 하나씩: 땅 아래 층과 벽 꼭대기에 2 m 가 안 남는 층은 뺀다', () => {
  const levels = storeys(brick, 100, 120);
  assert.deepEqual(levels.map((l) => l[0]), [100, 103.5, 107, 110.5, 114, 117.5]);
  assert.deepEqual(levels[0], [100, 103.5]);
  assert.equal(levels.at(-1)![1], 120); // 맨 위층의 천장은 벽 꼭대기를 넘지 않는다
  assert.deepEqual(storeys(brick, 100, 119).map((l) => l[0]), [100, 103.5, 107, 110.5, 114]);
  assert.deepEqual(storeys({ wall: 'brick' }, 100, 120), []);
});

test('낱창: 벽마다 층마다 같은 수의 네모, 모두 벽 밖 8 cm, 층 바닥과 천장 사이', () => {
  const mesh = decorate([block], { roofM: 120, groundM: 100 }, brick);
  // 긴 변 40 m: 12칸, 짧은 변 12 m: 3칸 → 한 층 30칸, 여섯 층. 지붕 기록이 없으면 지붕은 안 그린다
  assert.equal(tris(mesh), 30 * 6 * 2);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y, z] = mesh.positions.slice(i, i + 3);
    const out = Math.max(X0 - x, x - (X0 + 40), Y0 - y, y - (Y0 + 12));
    assert.ok(Math.abs(out - 0.08) < 1e-6, `벽에서 ${out}`);
    assert.ok(z > 100.9 && z < 120);
  }
  assert.equal(mesh.normals.length, mesh.positions.length);
  assert.equal(mesh.colors.length, mesh.positions.length);
});

test('단면이 자른 면과 더 높은 이웃이 붙은 벽에는 창을 그리지 않는다', () => {
  const all = tris(decorate([block], { roofM: 120, groundM: 100 }, brick));
  const cut = tris(decorate([block], { roofM: 120, groundM: 100 }, brick, { cut: (x) => Math.abs(x - X0) < 0.05 }));
  assert.equal(all - cut, 3 * 6 * 2); // 서쪽 짧은 변의 3칸 x 6층
  const low = tris(decorate([block], { roofM: 120, groundM: 100 }, brick, { neighbourTop: (x) => (x < X0 ? 107 : -Infinity) }));
  assert.equal(all - low, 3 * 2 * 2); // 이웃 지붕 107 m 아래의 두 층만 빠진다
});

test('모임지붕: 벽은 오름의 절반만큼 낮아지고, 처마는 벽 밖으로, 지붕은 그 위로만', () => {
  const a = { wall: 'brick', roof: { type: 'hipped' as const, material: 'tile', riseM: 4, eaveM: 0.6 } };
  assert.equal(wallTopM(120, a), 118);
  assert.equal(wallTopM(120, { wall: 'brick', roof: { type: 'flat' as const } }), 120);
  const mesh = decorate([block], { roofM: 120, groundM: 100 }, a);
  const z = zs(mesh);
  assert.equal(Math.min(...z), 117.55); // 처마 띠의 아랫면
  assert.equal(Math.max(...z), 122);
  const xs = mesh.positions.filter((_, i) => i % 3 === 0);
  assert.ok(Math.abs(Math.min(...xs) - (X0 - 0.6)) < 1e-6 && Math.abs(Math.max(...xs) - (X0 + 40.6)) < 1e-6);
  // 꼭대기 면은 벽 안쪽으로 들어가 있다
  for (let i = 0; i < mesh.positions.length; i += 3) if (mesh.positions[i + 2] === 122) assert.ok(mesh.positions[i] > X0 + 3 && mesh.positions[i] < X0 + 37);
  // 이웃이 붙은 변은 처마도 경사도 없다(박공)
  const gable = decorate([block], { roofM: 120, groundM: 100 }, a, { neighbourTop: (x) => (x < X0 ? 130 : -Infinity) });
  assert.ok(Math.abs(Math.min(...gable.positions.filter((_, i) => i % 3 === 0)) - X0) < 1e-6);
});

test('평지붕: 지붕 색 뚜껑 한 장, 테두리 띠는 벽 꼭대기 1.2 m', () => {
  const flat = decorate([block], { roofM: 120, groundM: 100 }, { wall: 'glass', roof: { type: 'flat', material: 'concrete' } });
  assert.equal(tris(flat), 2);
  assert.ok(zs(flat).every((z) => Math.abs(z - 120.1) < 1e-9));
  const rim = decorate([block], { roofM: 120, groundM: 100 }, { wall: 'glass', roof: { type: 'flat', rim: '#3b82c4' } });
  assert.equal(tris(rim), 2 + 4 * 2);
  assert.equal(Math.min(...zs(rim)), 118.8);
});

// ---- Z07 ----
test('벽면: 그 방향을 보는 벽만 다른 재질의 판을 받는다(나머지 벽은 그대로)', async () => {
  const { azimuth, faceOf } = await import('../src/building-appearance.ts');
  assert.equal(Math.round(azimuth([0, 1])), 0);
  assert.equal(Math.round(azimuth([1, 0])), 90);
  const a = { wall: 'stone', faces: [{ azimuth: 0, spread: 30, wall: 'ivy' }] };
  assert.equal(faceOf(a, [0.3, 0.95])?.wall, 'ivy');
  assert.equal(faceOf(a, [1, 0]), undefined);
  const mesh = decorate([block], { roofM: 120, groundM: 100 }, a);
  // 북쪽을 보는 긴 벽(y = Y0 + 12) 하나에만 판 하나(삼각형 둘), 담쟁이 색, 벽 밖 3 cm
  assert.equal(tris(mesh), 2);
  for (let i = 0; i < mesh.positions.length; i += 3) assert.ok(Math.abs(mesh.positions[i + 1] - (Y0 + 12.03)) < 1e-6);
  assert.deepEqual(mesh.colors.slice(0, 3), [0x4d, 0x6b, 0x3a]);
});

test('긴 아치: 칸마다 층을 꿰뚫는 유리 한 장과 둥근 머리, 층 바닥마다 벽 띠', () => {
  const a = { wall: 'white', windows: { style: 'bays' as const, floorsM: [100, 104, 108, 112] } };
  const mesh = decorate([[[[X0, Y0], [X0 + 10, Y0], [X0 + 10, Y0 + 0.5], [X0, Y0 + 0.5], [X0, Y0]]]], { roofM: 117, groundM: 100 }, a);
  // 10 m 벽 둘에 칸 둘씩(짧은 벽 0.5 m 는 건너뜀): 칸 하나 = 유리 2 + 머리 8 + 층 띠 3 x 2 삼각형
  assert.equal(tris(mesh), 4 * (2 + 8 + 6));
  assert.ok(Math.max(...zs(mesh)) <= 117 - 0.5 + 1e-6 && Math.min(...zs(mesh)) >= 100.6 - 1e-6);
});

test('지붕까지: 층 표가 끝난 위로 마지막 층 간격의 줄이 벽 꼭대기 2 m 아래까지 이어진다', () => {
  const a = { wall: 'glass', windows: { style: 'curtain' as const, floorsM: [100, 104, 108], toRoof: true } };
  assert.deepEqual(storeys(a, 100, 125).map((l) => l[0]), [100, 104, 108, 112, 116, 120]);
  assert.deepEqual(storeys({ ...a, windows: { ...a.windows, toRoof: false } }, 100, 125).map((l) => l[0]), [100, 104, 108]);
});

test('기둥 열: 그 방향의 가장 긴 벽 가운데에 기둥과 보, 그 뒤에는 창이 없다', () => {
  const rows = { wall: 'stone', windows: { style: 'rows' as const, floorsM: [100, 104, 108] } };
  const plain = decorate([block], { roofM: 113, groundM: 100 }, rows);
  const withColumns = decorate([block], { roofM: 113, groundM: 100 }, { ...rows, faces: [{ azimuth: 180, spread: 30, columns: 4 }] });
  // 남쪽 긴 벽: 들임 판 1 + 기둥 4 + 보 1 (기둥·보는 면 넷씩) = 2 + 5 x 8 삼각형이 더해지고, 가려진 창 칸(층마다)이 빠진다
  const span = 3 * 4.4 + 0.9, hiddenPerLevel = Array.from({ length: 12 }, (_, c) => (40 - 12 * 3.2) / 2 + (3.2 - 1.5) / 2 + c * 3.2).filter((s) => s + 1.5 > (40 - span) / 2 - 0.5 && s < (40 + span) / 2 + 0.5).length;
  assert.equal(tris(withColumns), tris(plain) + 2 + 5 * 8 - hiddenPerLevel * 3 * 2);
  assert.ok(hiddenPerLevel >= 4);
});
