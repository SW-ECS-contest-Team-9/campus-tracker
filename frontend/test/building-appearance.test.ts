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
  assert.equal(Math.min(...z), 118);
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
