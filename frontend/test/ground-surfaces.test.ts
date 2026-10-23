// 아2 지표면 면·경계석(a2-ground-surfaces.geojson, docs/audit/registry/ground.py 가 만든다)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';

register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { STRUCTURES, boxPattern, parseStructures, solidColors, solidMesh, surfaceSeam, topHeight } = await import('../src/structures.ts');
const { polygonContains } = await import('../src/polygon-ops.ts');

const dir = new URL('../public/structures/', import.meta.url);
const read = (name: string) => JSON.parse(fs.readFileSync(new URL(name, dir), 'utf8'));
const a2 = read('a2-ground-surfaces.geojson');
const solidsOf = (name: string) => parseStructures(name, read(name)).solids;

test('A2 파일: 전부 읽히고(빠진 것 없음) 면·경계석은 상자, 재질마다 제 색과 무늬', () => {
  const { solids, skipped } = parseStructures('a2-ground-surfaces.geojson', a2);
  assert.deepEqual(skipped, []);
  assert.ok(solids.length >= a2.features.length);
  for (const s of solids) {
    assert.equal(s.role, 'box');
    assert.ok(s.type === 'surface' || s.type === 'curb', s.id);
    assert.ok(STRUCTURES.boxMaterials[s.material!], `${s.id}: ${s.material} 색 없음`);
    assert.equal(solidColors(s).top, STRUCTURES.boxMaterials[s.material!]);
  }
  const by = (m: string) => solids.find((s: any) => s.material === m)!;
  assert.equal(boxPattern(by('tile')), 2);   // 0.9 m 판석
  assert.equal(boxPattern(by('ring_block')), 3);
  assert.equal(boxPattern(by('asphalt')), 0);
  assert.ok(STRUCTURES.outlined.includes('surface') && STRUCTURES.outlined.includes('curb')); // 경계선
});

test('A2 면은 제 기단 윗면 바로 위(띄움 0.02 m)에 있다: 기운 기단도 같은 기울기, z 싸움 없음', () => {
  const platforms = new Map<string, any>();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.geojson') && f !== 'a2-ground-surfaces.geojson')) {
    for (const s of solidsOf(f)) if (s.role === 'platform') platforms.set(s.id, s);
  }
  const { solids } = parseStructures('a2', a2);
  for (const s of solids) {
    const base = platforms.get(String(s.props.basePlane));
    assert.ok(base, `${s.id}: 기단 ${s.props.basePlane} 없음`);
    const lift = s.type === 'curb' ? 0.06 : 0.02;
    const ring = s.polygon[0];
    for (const [x, y] of ring.filter((_: number[], i: number) => i % Math.max(1, Math.floor(ring.length / 8)) === 0)) {
      const dz = topHeight(s)(x, y) - topHeight(base)(x, y);
      assert.ok(Math.abs(dz - lift) < 0.002, `${s.id} (${x}, ${y}): 기단 위 ${dz.toFixed(3)} m`);
    }
    // 판의 밑은 기단 윗면(그 아래로 파고들지 않는다)
    const [x, y] = ring[0];
    assert.ok(Math.abs(topHeight(s)(x, y) - (s.thicknessM ?? s.topM - s.bottomM) - topHeight(base)(x, y)) < 0.002, `${s.id}: 밑면`);
  }
});

test('A2 면은 기단 위에 선 상자(계단 단·화단)와 겹치지 않는다: 계단 자리를 덮지 않는다', () => {
  const { solids } = parseStructures('a2', a2);
  const treads = ['g02-way.geojson', 'x36-remaining.geojson', 'z03-fountain.geojson', 'x40-parts.geojson']
    .filter((f) => fs.existsSync(new URL(f, dir))).flatMap(solidsOf).filter((s: any) => s.type === 'stair_step' || s.type === 'planter');
  let checked = 0;
  for (const t of treads) {
    const ring = t.polygon[0];
    const cx = ring.reduce((a: number, p: number[]) => a + p[0], 0) / ring.length, cy = ring.reduce((a: number, p: number[]) => a + p[1], 0) / ring.length;
    if (!polygonContains(cx, cy, t.polygon)) continue;
    for (const s of solids) {
      if (s.type !== 'surface' || !polygonContains(cx, cy, s.polygon)) continue;
      assert.fail(`${s.id} 가 ${t.id} 의 가운데 (${cx.toFixed(1)}, ${cy.toFixed(1)}) 를 덮는다`);
    }
    checked++;
  }
  assert.ok(checked > 50);
});

test('A2 경계석: 아스팔트 면 안쪽 가장자리의 좁은 띠, 아스팔트 면과 겹치지 않는다', () => {
  const { solids } = parseStructures('a2', a2);
  const curbs = solids.filter((s: any) => s.type === 'curb');
  assert.ok(curbs.length > 0);
  for (const c of curbs) {
    const face = solids.find((s: any) => s.id === c.id.replace(/-CURB$/, ''));
    assert.equal(face?.material, 'asphalt');
    // 띠 가운데는 아스팔트 면 밖
    const ring = c.polygon[0];
    const mid = ring.map((p: number[], i: number) => [(p[0] + ring[(i + 2) % ring.length][0]) / 2, (p[1] + ring[(i + 2) % ring.length][1]) / 2])
      .find(([x, y]: number[]) => polygonContains(x, y, c.polygon));
    if (mid) assert.ok(!polygonContains(mid[0], mid[1], face!.polygon), `${c.id}: 아스팔트 면과 겹침`);
  }
});

test('A2 무늬: 나무 데크는 무늬를 말하지 않아도 널, 콘크리트 데크는 아님, 제 무늬가 먼저', () => {
  assert.equal(boxPattern({ type: 'deck', props: {}, material: 'timber' }), 4);
  assert.equal(boxPattern({ type: 'deck', props: {}, material: undefined }), 4);
  assert.equal(boxPattern({ type: 'deck', props: {}, material: 'concrete' }), 0);
  assert.equal(boxPattern({ type: 'deck', props: { pattern: 'rings' }, material: 'concrete' }), 3);
  assert.equal(boxPattern({ type: 'wall', props: {}, material: 'brick' }), 0);
});

test('A2 경계선: 같은 재질·같은 높이 면끼리 맞닿은 이음매에는 선이 없고, 재질이나 높이가 다르면 있다', () => {
  const sq = (x: number, props: Record<string, unknown>) => ({ type: 'Feature', properties: { kind: 'extrude', type: 'surface', fromM: 100, toM: 100.02, ...props },
    geometry: { type: 'Polygon', coordinates: [[[201000 + x, 557000], [201010 + x, 557000], [201010 + x, 557010], [201000 + x, 557010], [201000 + x, 557000]]] } });
  const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features });
  const lines = (solids: any[]) => solidMesh(solids[0]).edges.filter((e: number[][]) => !surfaceSeam(e, solids[0], solids)).length;
  const same = parseStructures('t', fc([sq(0, { id: 'A', material: 'tile' }), sq(10, { id: 'B', material: 'tile' })])).solids;
  const other = parseStructures('t', fc([sq(0, { id: 'A', material: 'tile' }), sq(10, { id: 'B', material: 'asphalt' })])).solids;
  const higher = parseStructures('t', fc([sq(0, { id: 'A', material: 'tile' }), sq(10, { id: 'B', material: 'tile', fromM: 100.3, toM: 100.32 })])).solids;
  const all = solidMesh(same[0]).edges.length;
  assert.equal(lines(same), all - 1);
  assert.equal(lines(other), all);
  assert.equal(lines(higher), all);
});
