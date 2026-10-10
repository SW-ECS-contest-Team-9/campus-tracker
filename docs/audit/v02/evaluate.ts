// V02: 차도 띠 표본을 넣은 지형이 차도 높이와 맞는지 순수 함수(applyLocalSamples)로 오프라인 점검. DB·서버 접근 없음.
// 사용법(backend 폴더에서):
//   npx tsx ../docs/audit/v02/evaluate.ts <3d-map-audit-20261009 폴더> <results-terrain.json> <격자 출력 폴더>
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bilinear, type Grid } from '../../../backend/src/geo/dem.ts';
import { applyPlateau } from '../../../backend/src/geo/terrain-plateau.ts';
import { applyLocalSamples, changeStats, mergeLocalSampleInputs, parseLocalSamples, LOCAL_SAMPLE_DEFAULTS } from '../../../backend/src/geo/terrain-local-samples.ts';

const [audit, outFile, gridOut] = process.argv.slice(2);
const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const f32 = (f: string) => { const b = fs.readFileSync(f); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const meta = json(path.join(audit, 'terrain-grid-meta.json'));
const g: Grid = { originX: meta.originX, originY: meta.originY, resolution: meta.resolution, width: meta.width, height: meta.height };
const live = f32(path.join(audit, 'terrain-grid.f32'));
const S = '../backend/data/terrain/samples/';
const files = [json(S + 'smap_samples_5186.json'), json(S + 'smap_samples_roads_5186.json'), json(S + 'smap_samples_roadprofile_5186.json')];
const all = mergeLocalSampleInputs(files);
const checks: any[] = json('../docs/audit/v02/check-points.json').points;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const stat = (r: number[]) => r.length ? { n: r.length, median: r2(pct(r, 0.5)), p90Abs: r2(pct(r.map(Math.abs), 0.9)), maxAbs: r2(Math.max(...r.map(Math.abs))), over0_2: r.filter((d) => Math.abs(d) > 0.2).length } : { n: 0 };
const SEGS = ['V1', 'V2', 'V3', 'V4a', 'V4b', 'P-LOW', 'P-UP', 'U1'];
const agree = (h: Float32Array) => {
  const by: Record<string, number[]> = {}; const worst: any[] = [];
  for (const [x, y, z, seg, s, o] of checks) { const d = bilinear(g, h, x, y)! - z; (by[seg] ??= []).push(d); worst.push([seg, s, o, r2(d)]); }
  const main = ['V1', 'V2', 'V3', 'V4a', 'V4b', 'P-LOW', 'P-UP'].flatMap((k) => by[k] ?? []);
  return { bySegment: Object.fromEntries(SEGS.map((k) => [k, stat(by[k] ?? [])])), allButU1: stat(main), worst: worst.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3])).slice(0, 8) };
};
const id = (input: any, h: Float32Array) => `local-samples-${createHash('sha256').update(meta.versionId).update(createHash('sha256').update(JSON.stringify(input)).digest('hex')).update(Buffer.from(h.buffer, h.byteOffset, h.byteLength)).digest('hex').slice(0, 16)}`;
const COMBOS: Record<string, { input: any; areas: string[]; passes?: [number, number][] }> = {
  // 시험용 DB 에서 지금 켜져 있는 조합(N02): 운동장 + S06 + 정문 차도 + 회차 공간
  'active-f5f1dbc4': { input: mergeLocalSampleInputs(files.slice(0, 2)), areas: ['field', 's06', 'gate_road', 'turnaround'] },
  // 위에 차도 띠 표본을 그냥 더함(같은 자리에 메시 표본과 종단 표본이 같이 있음)
  'add': { input: all, areas: ['field', 's06', 'gate_road', 'turnaround', 'road_profile'] },
  // 차도 띠와 겹치는 기존 표본을 종단 표본으로 바꿈(권고)
  'replace': { input: all, areas: ['field', 'road_profile', 'gate_road_rest', 's06_rest', 'turnaround_rest'] },
  // 권고 + 윗길 U1
  'replace+u1': { input: all, areas: ['field', 'road_profile', 'road_profile_u1', 'gate_road_rest', 's06_rest', 'turnaround_rest'] },
  // 권고 + 좁은 보정을 두 번 더(도구 설정을 바꿔야 함: 참고용)
  'replace+2passes': { input: all, areas: ['field', 'road_profile', 'gate_road_rest', 's06_rest', 'turnaround_rest'], passes: [...LOCAL_SAMPLE_DEFAULTS.passes, [1.5, 4], [1.5, 4]] },
  'replace+u1+2passes': { input: all, areas: ['field', 'road_profile', 'road_profile_u1', 'gate_road_rest', 's06_rest', 'turnaround_rest'], passes: [...LOCAL_SAMPLE_DEFAULTS.passes, [1.5, 4], [1.5, 4]] },
};
// 띠 새기기: 길 따라 1 m 조각마다 기존 순수 함수 applyPlateau(다각형 평탄화)를 이어 돌린다. 갈래 먼저, 본선 나중(겹치면 본선 높이). 건물 외곽 안 칸은 되돌린다.
const slices: any[] = json('../docs/audit/v02/ribbon-slices.json').slices;
const outlines: [number, number][][] = json(path.join(audit, 'building-outlines-5186.json')).map((b: any) => b.coordinates[0][0]);
const inPoly = (p: [number, number][], x: number, y: number) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > y) !== (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) c = !c; return c; };
const building = new Uint8Array(g.width * g.height);
for (let iy = 0; iy < g.height; iy++) for (let ix = 0; ix < g.width; ix++) { const x = g.originX + (ix + 0.5) * g.resolution, y = g.originY + (iy + 0.5) * g.resolution; if (x > 200950 && x < 201290 && y > 557070 && y < 557440 && outlines.some((p) => inPoly(p, x, y))) building[iy * g.width + ix] = 1; }
const ORDER = ['U1', 'P-UP', 'P-LOW', 'V1', 'V2', 'V3', 'V4a', 'V4b'];
const burn = (base: Float32Array, withU1: boolean) => {
  let h = base; let n = 0;
  for (const seg of ORDER) { if (seg === 'U1' && !withU1) continue; for (const s of slices) if (s.seg === seg) { h = applyPlateau(g, h, [s.ring], s.z); n++; } }
  const out = h.slice(); let cells = 0, restored = 0;
  for (let i = 0; i < out.length; i++) if (out[i] !== base[i]) { if (building[i]) { out[i] = base[i]; restored++; } else cells++; }
  return { heights: out, slices: n, cells, restoredInBuildings: restored };
};
const results: any = { created: '2026-10-11', settings: LOCAL_SAMPLE_DEFAULTS, checkPoints: checks.length, oldTerrain: agree(live), combos: {} };
for (const [name, c] of Object.entries(COMBOS)) {
  const parsed = parseLocalSamples(c.input, c.areas);
  const r = applyLocalSamples(g, live, parsed.samples, c.passes ? { ...LOCAL_SAMPLE_DEFAULTS, passes: c.passes } : LOCAL_SAMPLE_DEFAULTS);
  const st = changeStats(g, live, r.heights);
  results.combos[name] = { areas: c.areas, samples: parsed.samples.length, guardSkipped: r.skipped.length, passes: c.passes ?? 'default', previewIdIfTheseThreeFiles: c.passes ? null : id(c.input, r.heights),
    changedCells: st.changedCells, steepCellsBefore: st.steepCellsBefore, steepCellsAfter: st.steepCellsAfter, areaM2ByAbsDelta: st.areaM2ByAbsDelta, terrainMinusRoad: agree(r.heights) };
  fs.writeFileSync(path.join(gridOut, `dem-${name.replace(/\+/g, '-')}.f32`), Buffer.from(r.heights.buffer, r.heights.byteOffset, r.heights.byteLength));
  if (name === 'replace' || name === 'replace+u1') {
    const b = burn(r.heights, name === 'replace+u1'); const st2 = changeStats(g, live, b.heights); const nm = name + '>ribbon';
    results.combos[nm] = { areas: c.areas, then: 'applyPlateau per 1 m slice (' + b.slices + ' slices)', ribbonCells: b.cells, restoredInBuildings: b.restoredInBuildings, changedCells: st2.changedCells,
      steepCellsBefore: st2.steepCellsBefore, steepCellsAfter: st2.steepCellsAfter, areaM2ByAbsDelta: st2.areaM2ByAbsDelta, terrainMinusRoad: agree(b.heights) };
    fs.writeFileSync(path.join(gridOut, `dem-${nm.replace(/[+>]/g, '-')}.f32`), Buffer.from(b.heights.buffer, b.heights.byteOffset, b.heights.byteLength));
    console.log(nm, 'cells', b.cells, JSON.stringify(results.combos[nm].terrainMinusRoad.allButU1), 'U1', JSON.stringify(results.combos[nm].terrainMinusRoad.bySegment.U1), JSON.stringify(results.combos[nm].terrainMinusRoad.worst.slice(0, 4)));
  }
  console.log(name, parsed.samples.length, 'skip', r.skipped.length, JSON.stringify(results.combos[name].terrainMinusRoad.allButU1), 'U1', JSON.stringify(results.combos[name].terrainMinusRoad.bySegment.U1));
}
console.log('old', JSON.stringify(results.oldTerrain.allButU1));
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
