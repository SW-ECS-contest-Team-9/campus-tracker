import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
import * as C from 'cesium';

// src 모듈의 확장자 없는 상대 import('./tm')를 node 테스트에서 .ts로 해석
register('data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith(".")&&!s.endsWith(".ts"))return n(s+".ts",c);throw e}}', import.meta.url);
const { parseCorrections, CORRECTION_FILES } = await import('../src/scene-local-corrections.ts');
const { tmForward, tmInverse } = await import('../src/tm.ts');

const DIR = new URL('../public/corrections/', import.meta.url);
const groupOf = new Map(CORRECTION_FILES.map((c: any) => [c.file, c.group]));
const present = CORRECTION_FILES.map((c: any) => c.file).filter((f: string) => fs.existsSync(new URL(f, DIR)));
const read = (f: string) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));

test('EPSG:5186 1 m = 1 m: 변환 왕복 오차 < 1 mm, 동서·남북 1 m 간격의 측지 거리 1 m ± 1 mm', () => {
  for (const f of present) {
    for (const feat of read(f).features) {
      const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
      for (const [x, y] of (feat.geometry.type === 'LineString' ? feat.geometry.coordinates : polys.flat(2))) {
        const { latitude, longitude } = tmInverse(x, y);
        const back = tmForward(latitude, longitude);
        assert.ok(Math.hypot(back.x - x, back.y - y) < 1e-3, `${f} ${x},${y}`);
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const q = tmInverse(x + dx, y + dy);
          const g = new C.EllipsoidGeodesic(C.Cartographic.fromDegrees(longitude, latitude), C.Cartographic.fromDegrees(q.longitude, q.latitude));
          assert.ok(Math.abs(g.surfaceDistance - 1) < 1e-3, `${g.surfaceDistance}`);
        }
      }
    }
  }
});

test('모든 보정 피처는 source가 있고 거부 없이 읽힌다', () => {
  assert.ok(present.includes('munye-highrise-v2.geojson'));
  for (const f of present) {
    const fc = read(f);
    assert.ok(fc.provenance?.source && /^[0-9a-f]{64}$/.test(fc.provenance.sha256), `${f} provenance`);
    const r = parseCorrections(f, fc, groupOf.get(f));
    assert.deepEqual(r.errors, []);
    assert.equal(r.features.length, fc.features.length);
  }
});

test('source 없는 면, z 없는 surface는 거부', () => {
  const sq = [[[0, 0], [1, 0], [1, 1], [0, 0]]].map((r) => r.map(([a, b]) => [201000 + a, 557000 + b]));
  const r = parseCorrections('t', { features: [
    { properties: { id: 'a', kind: 'extrude', fromM: 1, toM: 2 }, geometry: { type: 'Polygon', coordinates: sq } },
    { properties: { id: 'b', kind: 'surface', source: 's' }, geometry: { type: 'Polygon', coordinates: sq } },
  ] });
  assert.equal(r.features.length, 0);
  assert.equal(r.errors.length, 2);
});

test('문예관 v1: MY-T 하나만, 원천 좌표 원값, 원본 roofM 위로만 압출', () => {
  const fc = read('munye-highrise-v1.geojson');
  assert.deepEqual(fc.features.map((f: any) => f.properties.id), ['MY-T']);
  const p = fc.features[0].properties;
  assert.equal(p.fromM, 153.238); // 원본 scene roofM
  assert.equal(p.toM, 189.4);
  const src = 'C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/문예관고층부/munye-massing-candidate-5186.geojson';
  if (!fs.existsSync(src)) return; // 원천 폴더가 없는 환경에서는 SHA 대조 생략
  const raw = fs.readFileSync(src);
  assert.equal(createHash('sha256').update(raw).digest('hex'), fc.provenance.sha256);
  const orig = JSON.parse(raw.toString('utf8')).features.find((f: any) => f.properties.id === 'MY-T');
  assert.deepEqual(fc.features[0].geometry, orig.geometry);
});

test('문예관 v2: 직선 벽 MY-T-CLEAN(8꼭짓점)과 저층 지붕 면 MY-L-ROOF(148.8, 하부 채움 없음), 둘 다 추정 표시', () => {
  const fc = read('munye-highrise-v2.geojson');
  const byId = new Map(fc.features.map((f: any) => [f.properties.id, f]));
  const t: any = byId.get('MY-T-CLEAN');
  const l: any = byId.get('MY-L-ROOF');
  assert.equal(t.geometry.coordinates[0].length - 1, 8);
  assert.equal(t.properties.toM, 189.4);
  assert.equal(l.properties.kind, 'surface');
  assert.ok(l.geometry.coordinates[0].every((c: number[]) => c[2] === 148.8));
  for (const f of [t, l]) assert.ok(f.properties.estimated === true && f.properties.assumption && f.properties.source);
  assert.ok(/정확도 주장 없음/.test(fc.provenance.limit));
});

test('운동장 표면: 서로 다른 표면이 정점을 공유하지 않음(보간 연결면 없음), 대일관 돌출 지붕 아래 통로 높이 ≥ 2 m', { skip: !present.includes('field-surfaces-v3.geojson') }, () => {
  const fc = read('field-surfaces-v3.geojson');
  const owner = new Map<string, string>();
  const pts = (f: any) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).flat(2) as number[][];
  for (const f of fc.features) {
    for (const [x, y, z] of pts(f)) {
      const k = `${x},${y},${z}`;
      const o = owner.get(k);
      assert.ok(!o || o === f.properties.id, `${k}: ${o} / ${f.properties.id}`);
      owner.set(k, f.properties.id);
    }
  }
  const byId = new Map(fc.features.map((f: any) => [f.properties.id, f]));
  const canopy = Math.min(...pts(byId.get('SF-DAEIL-CANOPY')).map((p) => p[2]));
  const pave = Math.max(...pts(byId.get('SF-DAEIL-ENTRY-PAVE')).map((p) => p[2]));
  assert.ok(canopy - pave >= 2, `${canopy} - ${pave}`);
  assert.equal(byId.get('SF-DAEIL-CANOPY').properties.walkable, false);
});

test('추정 구조: 별도 파일, 모든 피처 estimated=true·assumption·source, 표시 그룹 estimated', { skip: !present.includes('field-structures-est-v1.geojson') }, () => {
  assert.equal(groupOf.get('field-structures-est-v1.geojson'), 'estimated');
  const fc = read('field-structures-est-v1.geojson');
  for (const f of fc.features) assert.ok(f.properties.estimated === true && f.properties.assumption && f.properties.source, f.properties.id);
  const bad = structuredClone(fc);
  delete bad.features[0].properties.assumption;
  assert.equal(parseCorrections('x', bad, 'estimated').errors.length, 1);
});

test('v4: 평지 경계는 참고선만(직선화 면 미사용), 계단 끝점 표지는 계단 z 그대로·미검증 표시', { skip: !fs.existsSync(new URL('stair-endpoints-v4.geojson', DIR)) }, () => {
  const fb = read('field-boundary-v4.geojson');
  assert.deepEqual(fb.features.map((f: any) => [f.properties.id, f.properties.kind]), [['REF-PHOTO15-V4-EDGE', 'line']]);
  const ep = read('stair-endpoints-v4.geojson').features;
  const est = read('field-structures-est-v1.geojson').features;
  const zs = new Set(est.flatMap((f: any) => [f.properties.fromM, f.properties.toM, f.properties.z_bottom, f.properties.z_top]));
  for (const f of ep) assert.ok(zs.has(f.geometry.coordinates[0][2]), `${f.properties.id} z가 추정 계단 z와 다름`);
  assert.ok(ep.some((f: any) => f.properties.type === 'endpoint_unverified'));
});

test('지형 잘라냄: 구역 = 검증된 표면 5개 경계 그대로, 경계 세로 면은 표면 z 원값·DEM z 쌍', () => {
  const fc = read('terrain-clip-v1.geojson');
  const surf = new Map(read('field-surfaces-v3.geojson').features.map((f: any) => [f.properties.id, f]));
  const clips = fc.features.filter((f: any) => f.properties.kind === 'clip');
  assert.deepEqual(clips.map((f: any) => f.properties.id), ['CLIP-SF-FIELD', 'CLIP-SF-CORRIDOR', 'CLIP-SF-ENJU2-UPPER', 'CLIP-SF-ENJU2-LOWER-0', 'CLIP-SF-ENJU2-LOWER-1']);
  for (const c of clips) {
    const s: any = surf.get(c.properties.id.replace('CLIP-', ''));
    assert.deepEqual(c.geometry.coordinates[0], s.geometry.coordinates[0].map((p: number[]) => p.slice(0, 2)));
  }
  const r = parseCorrections('terrain-clip-v1.geojson', fc, 'corrected');
  assert.deepEqual(r.errors, []);
  assert.equal(r.features.filter((f: any) => f.kind === 'skirt').length, 5);
  for (const f of fc.features.filter((f: any) => f.properties.kind === 'skirt')) assert.ok(f.properties.type === 'render_connection_face' && f.properties.verifiedWall === false && /렌더 연결면/.test(f.properties.assumption));
});

test('청운관 분리: 본체 override(직선 절단) + 슬래브·기둥만, 벽 없음', () => {
  const fc = read('cheongun-split-v1.geojson');
  const r = parseCorrections('cheongun-split-v1.geojson', fc, 'estimated');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.features.filter((f: any) => f.kind === 'override').map((f: any) => f.buildingId), ['청운관']);
  assert.ok(fc.features.every((f: any) => ['building_override', 'open_slab', 'column'].includes(f.properties.type)));
});

test('v6: 계단 끝점 상태(표면 후보 대응/미검증) 표지와 제안 계단 선, 기존 추정 계단은 그대로', { skip: !present.includes('stair-endpoints-v6.geojson') }, () => {
  const fc = read('stair-endpoints-v6.geojson');
  const r = parseCorrections('stair-endpoints-v6.geojson', fc, 'estimated');
  assert.deepEqual(r.errors, []);
  const t = fc.features.map((f: any) => f.properties.type);
  assert.ok(t.includes('endpoint_unverified') && t.includes('endpoint_surface_match') && t.includes('stair_proposal'));
  assert.ok(!t.includes('endpoint_confirmed'));
  for (const f of fc.features.filter((f: any) => f.properties.type === 'endpoint_surface_match')) assert.ok(/실제 계단 끝점 확인 아님/.test(f.properties.legend));
  assert.ok(!present.includes('stair-endpoints-v4.geojson') && !present.includes('stair-endpoints-v5.geojson'));
});

test('계단 후보: 사잇길 절단 면은 원 면 대체용, 추정 계단 평면과 겹치지 않음(검사 파일), 출처·가정 있음', () => {
  const fc = read('corridor-stair-cut-v1.geojson');
  const r = parseCorrections('corridor-stair-cut-v1.geojson', fc, 'stairCandidate');
  assert.deepEqual(r.errors, []);
  assert.equal(r.features.find((f: any) => f.kind === 'surface')?.replaces, 'SF-CORRIDOR-TIN');
  const chk = fs.readFileSync(new URL('../../docs/audit/field/corridor-stair-cut-checks.txt', import.meta.url), 'utf8');
  assert.match(chk, /불일치 0/);
  assert.match(chk, /겹침: 0\.000 m²/);
});

test('v6 계단 후보: 새 계단·참·사잇길 대체 면 모두 추정·미검증, DRAFT 계단 숨김 접두어, 청운관 지붕 슬래브가 원 지붕 셀 면 대체', () => {
  const fc = read('stairs-v6-est.geojson');
  const r = parseCorrections('stairs-v6-est.geojson', fc, 'stairV6');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(fc.provenance.hides, ['ST-DAEIL-EXIT-SIDE', 'ST-A14']);
  assert.ok(fc.features.filter((f: any) => ['stair_step', 'landing'].includes(f.properties.type)).every((f: any) => f.properties.status === '미검증'));
  assert.equal(r.features.find((f: any) => f.kind === 'surface')?.replaces, 'SF-CORRIDOR-TIN');
  const ch = read('cheongun-split-v1.geojson').features.filter((f: any) => f.properties.replaces);
  assert.deepEqual(ch.map((f: any) => f.properties.replaces), ['SF-CHEONGUN-CANOPY']);
});

test('렌더 삼각형 검사: 사잇길 절단 면 내부·경계 z가 원 면 렌더 z와 같음(render-z-checks.txt)', () => {
  const chk = fs.readFileSync(new URL('../../docs/audit/field/render-z-checks.txt', import.meta.url), 'utf8');
  const worst = [...chk.matchAll(/절단 면 z − 원 면 렌더 z 최대 ([\d.]+) m/g)].map((m) => Number(m[1]));
  assert.equal(worst.length, 2);
  for (const w of worst) assert.ok(w <= 0.002, `${w}`);
  assert.match(chk, /출구 문턱 면 없음/);
});

test('길 사슬 후보: 상태별 type만(연결/그림만/미검증), 원천 SHA·기준 도로 SHA 일치, 모두 추정 표시', { skip: !present.includes('path-graph-candidate.geojson') }, () => {
  const fc = read('path-graph-candidate.geojson');
  const r = parseCorrections('path-graph-candidate.geojson', fc, 'pathGraph');
  assert.deepEqual(r.errors, []);
  assert.equal(fc.provenance.base_roads_sha_match, true);
  const T = ['path_graph_connected', 'path_drawn_only', 'path_unverified', 'path_candidate_node', 'surface_unverified', 'surface_operational_only'];
  assert.ok(fc.features.every((f: any) => T.includes(f.properties.type) && f.properties.legend));
  const ids = fc.features.map((f: any) => f.properties.id);
  assert.equal(new Set(ids).size, ids.length); // 분할 부품마다 고유 ID, 원 도로 중복 없음
  assert.ok(!ids.some((i: string) => i.startsWith('PG-R-618385b9') || i.startsWith('PG-R-3910b4a5'))); // 분할된 원 도로 전체는 그리지 않음
  assert.ok(ids.includes('PG-P-618385b9#B#A'));
});

test('사잇길 TIN v5: v3 SF-CORRIDOR 대체, 빈칸은 선(미검증)만, 렌더 표본 재현 0, 빈칸·구역 밖·겹침 0', () => {
  const fc = read('corridor-surface-v5.1.geojson');
  const r = parseCorrections('corridor-surface-v5.1.geojson', fc, 'corrected');
  assert.deepEqual(r.errors, []);
  assert.equal(r.features.find((f: any) => f.kind === 'surface')?.replaces, 'SF-CORRIDOR');
  assert.ok(r.features.filter((f: any) => f.type === 'gap_unverified').every((f: any) => f.kind === 'line'));
  const chk = fs.readFileSync(new URL('../../docs/audit/field/render-z-checks.txt', import.meta.url), 'utf8');
  assert.match(chk, /표본 재현\(렌더 삼각형 z vs 꼭짓점 z\): 표본 \d+개, 최대 차 0\.000\d m/);
  const tin = fs.readFileSync(new URL('../../docs/audit/field/corridor-tin-checks.txt', import.meta.url), 'utf8');
  assert.match(tin, /겹침 0\.000 m²/);
  assert.match(tin, /∩ 조각 0\.000 m²/);
  assert.match(tin, /밖 조각 면적 0\.000 m²/);
  for (const f of fc.features) for (const c of (f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat(2))) assert.ok(c.length >= 3);
});
