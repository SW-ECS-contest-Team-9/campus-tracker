import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { cellsInside, sampler } = await import('../src/terrain-sampler.ts');

// 10 x 10 cells of 2 m; a platform (top 105) over the cells x 4..7, y 4..7 (centres 9..15 m); the ground 100
const g = { versionId: 't', originX: 0, originY: 0, resolution: 2, width: 10, height: 10, bounds: { west: 0, south: 0, east: 0, north: 0 }, heights: new Float32Array(100).fill(100) };
for (let j = 4; j < 8; j++) for (let i = 4; i < 8; i++) g.heights[j * 10 + i] = 105;
const platform = [[[8, 8], [16, 8], [16, 16], [8, 16]]];

test('terrain sampler: the cells under a platform are found by their centres', () => {
  const hide = cellsInside(g, [platform])!;
  let n = 0;
  for (let k = 0; k < 100; k++) if (hide[k]) { n++; assert.equal(g.heights[k], 105); }
  assert.equal(n, 16);
  assert.equal(cellsInside(g, []), null);
});

test('terrain sampler: beside a platform the ground keeps its height up to the wall (no 2 m slope up it)', () => {
  const plain = sampler(g), walled = sampler(g, cellsInside(g, [platform])!);
  for (const [x, y] of [[7.5, 12], [7.5, 7.5], [16.5, 12], [12, 7.9], [16.5, 16.5]]) {
    assert.ok(plain(x, y) > 100.2, `${x},${y} climbs without hide`);
    assert.equal(walled(x, y), 100, `${x},${y}`);
  }
  for (const [x, y] of [[12, 12], [9, 9], [15, 12]]) assert.equal(walled(x, y), 105); // inside, among platform cells only: its top
  for (const [x, y] of [[3, 3], [12, 18], [4.2, 12]]) assert.equal(walled(x, y), plain(x, y)); // away from it: as before
});
