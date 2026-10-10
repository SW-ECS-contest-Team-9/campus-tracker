// V02: 좁은 보정을 몇 번 더 돌려야 차도 띠에서 지형이 차도와 0.2 m 안으로 맞는지 훑어본다(도구 기본값은 4번). 오프라인.
//   (backend 폴더에서) npx tsx ../docs/audit/v02/passes_scan.ts <3d-map-audit-20261009 폴더> <out.json>
import fs from 'node:fs';
import path from 'node:path';
import { bilinear, type Grid } from '../../../backend/src/geo/dem.ts';
import { applyLocalSamples, mergeLocalSampleInputs, parseLocalSamples, LOCAL_SAMPLE_DEFAULTS } from '../../../backend/src/geo/terrain-local-samples.ts';
const [audit, outFile] = process.argv.slice(2);
const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const f32 = (f: string) => { const b = fs.readFileSync(f); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const meta = json(path.join(audit, 'terrain-grid-meta.json'));
const g: Grid = { originX: meta.originX, originY: meta.originY, resolution: meta.resolution, width: meta.width, height: meta.height };
const live = f32(path.join(audit, 'terrain-grid.f32'));
const S = '../backend/data/terrain/samples/';
const all = mergeLocalSampleInputs([json(S + 'smap_samples_5186.json'), json(S + 'smap_samples_roads_5186.json'), json(S + 'smap_samples_roadprofile_5186.json')]);
const checks: any[] = json('../docs/audit/v02/check-points.json').points;
const samples = parseLocalSamples(all, ['field', 'road_profile', 'road_profile_u1', 'gate_road_rest', 's06_rest', 'turnaround_rest']).samples;
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const out: any[] = [];
for (const [k, r] of [[2, 6], [1.5, 4], [1, 3]] as [number, number][]) for (const n of [0, 2, 6, 12, 24]) {
  if (n === 0 && k !== 2) continue;
  const passes = [...LOCAL_SAMPLE_DEFAULTS.passes, ...Array.from({ length: n }, () => [k, r] as [number, number])];
  const h = applyLocalSamples(g, live, samples, { ...LOCAL_SAMPLE_DEFAULTS, passes }).heights;
  const d = (u1: boolean) => checks.filter((c) => (c[3] === 'U1') === u1).map((c) => Math.abs(bilinear(g, h, c[0], c[1])! - c[2]));
  const row = { extraPasses: n, kernelM: k, radiusM: r, mainP90: +pct(d(false), 0.9).toFixed(2), mainMax: +Math.max(...d(false)).toFixed(2), u1P90: +pct(d(true), 0.9).toFixed(2), u1Max: +Math.max(...d(true)).toFixed(2) };
  out.push(row); console.log(JSON.stringify(row));
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
