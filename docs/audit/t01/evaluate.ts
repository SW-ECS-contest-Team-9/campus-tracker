// T01: 국소 표본 보정(applyLocalSamples)의 E01 V2e 재현 확인과, 가장자리 줄임(support/fade)·외톨이 표본 가드 설정 비교.
// 오프라인. DB·서버 접근 없음.
// 사용법(저장소 루트에서):
//   npx tsx docs/audit/t01/evaluate.ts <terrain-grid.f32> <terrain-grid-meta.json> <backend/data/terrain/samples/smap_samples_5186.json> <e01/samples.json> <e01/dem-V2e.f32> <results.json> <격자 출력 폴더>
import fs from 'node:fs';
import path from 'node:path';
import { bilinear, type Grid } from '../../../backend/src/geo/dem.ts';
import { distanceTransform } from '../../../backend/src/geo/edt.ts';
import { applyLocalSamples, LOCAL_SAMPLE_DEFAULTS, type LocalSampleOptions } from '../../../backend/src/geo/terrain-local-samples.ts';

const [gridFile, metaFile, samplesFile, e01SamplesFile, v2eFile, outFile, gridOut] = process.argv.slice(2);
type S = { x: number; y: number; z: number; area: string };
const f32 = (f: string) => { const b = fs.readFileSync(f); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^﻿/, ''));
const g: Grid = { originX: meta.originX, originY: meta.originY, resolution: meta.resolution, width: meta.width, height: meta.height };
const n = g.width * g.height, cellArea = g.resolution ** 2;
const live = f32(gridFile), v2e = f32(v2eFile);
const samples: S[] = JSON.parse(fs.readFileSync(samplesFile, 'utf8')).groups.flatMap((grp: any) => grp.points.map((p: number[]) => ({ x: p[0], y: p[1], z: p[2], area: grp.areaName })));
const e01: S[] = JSON.parse(fs.readFileSync(e01SamplesFile, 'utf8')).samples.filter((s: any) => s.use && s.area !== '기타');
const AREAS = ['운동장', '사잇길', 'S06'];
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const stat = (r: number[]) => ({ n: r.length, median: r2(pct(r, 0.5)), p90Abs: r2(pct(r.map(Math.abs), 0.9)), maxAbs: r2(Math.max(...r.map(Math.abs))) });
const maxOf = (v: ArrayLike<number>) => { let m = -Infinity; for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i]; return m; };
const maxDiff = (a: Float32Array, b: Float32Array) => { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const E01: LocalSampleOptions = { ...LOCAL_SAMPLE_DEFAULTS, supportM: Infinity, fadeM: 0, minNeighbours: 0, neighbourRadiusM: 0 };
const results: any = { created: '2026-10-10', samples: samples.length };

// ---- 1. E01 V2e 재현 ----
results.reproduction = {
  note: '가장자리 줄임·가드를 끈 applyLocalSamples 대 E01 dem-V2e.f32, 최대 |차| m',
  e01Samples: maxDiff(applyLocalSamples(g, live, e01, E01).heights, v2e),
  committedSamplesRounded: maxDiff(applyLocalSamples(g, live, samples, E01).heights, v2e),
};
console.log('재현', results.reproduction);

// ---- 2. 가드: 반경 r 안 이웃 수 분포 ----
const nbr = (r: number) => samples.map((s) => samples.filter((o) => o !== s && Math.hypot(o.x - s.x, o.y - s.y) <= r).length);
results.neighbours = Object.fromEntries([4, 6, 8].map((r) => { const c = nbr(r); return [`within${r}m`, { min: Math.min(...c), lt2: c.filter((v) => v < 2).length, lt3: c.filter((v) => v < 3).length, lt5: c.filter((v) => v < 5).length }]; }));
console.log('이웃 수', JSON.stringify(results.neighbours));

// ---- 3. 설정 비교 ----
const mask = new Uint8Array(n);
for (const s of samples) mask[Math.floor((s.y - g.originY) / g.resolution) * g.width + Math.floor((s.x - g.originX) / g.resolution)] = 1;
const dist = distanceTransform(mask, g.width, g.height).map((d) => d * g.resolution); // 표본 칸까지 거리(E01 과 같은 띠 정의)
const band = (lo: number, hi: number) => { const o: number[] = []; for (let i = 0; i < n; i++) if (dist[i] > lo && dist[i] <= hi) o.push(i); return o; };
const inside = band(-1, 2), edge = band(2, 30), far = band(30, Infinity);
function slopeOf(h: Float32Array) {
  const s = new Float32Array(n);
  for (let iy = 0; iy < g.height; iy++) for (let ix = 0; ix < g.width; ix++) {
    const x0 = h[iy * g.width + Math.max(0, ix - 1)], x1 = h[iy * g.width + Math.min(g.width - 1, ix + 1)];
    const y0 = h[Math.max(0, iy - 1) * g.width + ix], y1 = h[Math.min(g.height - 1, iy + 1) * g.width + ix];
    s[iy * g.width + ix] = Math.hypot((x1 - x0) / (2 * g.resolution), (y1 - y0) / (2 * g.resolution));
  }
  return s;
}
const slope0 = slopeOf(live);
const centre = Object.fromEntries(AREAS.map((a) => { const p = samples.filter((s) => s.area === a); return [a, { x: p.reduce((t, s) => t + s.x, 0) / p.length, y: p.reduce((t, s) => t + s.y, 0) / p.length }]; }));
const cellXY = (i: number) => ({ x: g.originX + ((i % g.width) + 0.5) * g.resolution, y: g.originY + (Math.floor(i / g.width) + 0.5) * g.resolution });
// 새로 45° 를 넘은 칸이 어느 구역의 어느 쪽 가장자리인지(구역 표본 중심에서 본 방위), 표본에서 얼마나 떨어졌는지
function whereSteep(idx: number[], h: Float32Array) {
  const groups: Record<string, { cells: number; maxAbsDeltaM: number; distToSampleM: number[]; xs: number[]; ys: number[] }> = {};
  for (const i of idx) {
    const p = cellXY(i);
    let best = samples[0], bd = Infinity;
    for (const s of samples) { const d = (s.x - p.x) ** 2 + (s.y - p.y) ** 2; if (d < bd) { bd = d; best = s; } }
    const c = centre[best.area], ang = Math.atan2(p.y - c.y, p.x - c.x) * 180 / Math.PI;
    const side = ang > -45 && ang <= 45 ? '동' : ang > 45 && ang <= 135 ? '북' : ang > -135 && ang <= -45 ? '남' : '서';
    const k = `${best.area} ${side}쪽`;
    const o = groups[k] ??= { cells: 0, maxAbsDeltaM: 0, distToSampleM: [], xs: [], ys: [] };
    o.cells++; o.maxAbsDeltaM = Math.max(o.maxAbsDeltaM, Math.abs(h[i] - live[i])); o.distToSampleM.push(Math.sqrt(bd)); o.xs.push(p.x); o.ys.push(p.y);
  }
  return Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].cells - a[1].cells).map(([k, o]) => [k, {
    cells: o.cells, maxAbsDeltaM: r2(o.maxAbsDeltaM), distToSampleMedianM: r2(pct(o.distToSampleM, 0.5)), distToSampleMaxM: r2(Math.max(...o.distToSampleM)),
    bbox: [Math.min(...o.xs), Math.min(...o.ys), Math.max(...o.xs), Math.max(...o.ys)],
  }]));
}
const blockFold = samples.map((s) => (((Math.floor(s.x / 10) * 7 + Math.floor(s.y / 10) * 13) % 5) + 5) % 5); // E01 과 같은 10 m 구획 5등분
const settings: [string, LocalSampleOptions][] = [
  ['E01 V2e (줄임 없음, 가드 없음)', E01],
  ['줄임 없음 + 가드 3/6m', { ...E01, minNeighbours: 3, neighbourRadiusM: 6 }],
  ['support 10 fade 5', { ...LOCAL_SAMPLE_DEFAULTS, supportM: 10, fadeM: 5 }],
  ['support 6 fade 6', { ...LOCAL_SAMPLE_DEFAULTS, supportM: 6, fadeM: 6 }],
  ['support 4 fade 4', { ...LOCAL_SAMPLE_DEFAULTS, supportM: 4, fadeM: 4 }],
  ['support 2 fade 4', { ...LOCAL_SAMPLE_DEFAULTS, supportM: 2, fadeM: 4 }],
];
results.settings = {};
for (const [name, opts] of settings) {
  const { heights: h, skipped } = applyLocalSamples(g, live, samples, opts);
  const res: Record<string, number[]> = Object.fromEntries(AREAS.map((a) => [a, []]));
  for (let k = 0; k < 5; k++) {
    const hk = applyLocalSamples(g, live, samples.filter((_, i) => blockFold[i] !== k), opts).heights;
    samples.forEach((s, i) => { if (blockFold[i] === k) res[s.area].push(s.z - bilinear(g, hk, s.x, s.y)!); });
  }
  const sl = slopeOf(h);
  const dAbs = (idx: number[]) => idx.map((i) => Math.abs(h[i] - live[i]));
  const dEdge = dAbs(edge), dFar = dAbs(far);
  const newSteep = edge.filter((i) => sl[i] > 1 && slope0[i] <= 1), goneSteep = edge.filter((i) => sl[i] <= 1 && slope0[i] > 1);
  const out = {
    options: { ...opts, supportM: Number.isFinite(opts.supportM) ? opts.supportM : '무한' },
    skippedSamples: skipped.length,
    fitAllIn: Object.fromEntries(AREAS.map((a) => [a, stat(samples.filter((s) => s.area === a).map((s) => s.z - bilinear(g, h, s.x, s.y)!))])),
    holdoutBlock10m: Object.fromEntries(AREAS.map((a) => [a, stat(res[a])])),
    changedCells: dAbs([...inside, ...edge, ...far]).filter((d) => d > 0).length,
    beyond30mMaxAbsM: r2(maxOf(dFar)),
    band2to30m: { maxAbsM: r2(maxOf(dEdge)), areaOver05M2: dEdge.filter((d) => d > 0.5).length * cellArea, areaOver01M2: dEdge.filter((d) => d > 0.1).length * cellArea },
    steepOver45deg: {
      within2m: [inside.filter((i) => slope0[i] > 1).length, inside.filter((i) => sl[i] > 1).length],
      band2to30m: [edge.filter((i) => slope0[i] > 1).length, edge.filter((i) => sl[i] > 1).length],
      bandNew: newSteep.length, bandGone: goneSteep.length, bandMaxSlope: r2(maxOf(edge.map((i) => sl[i]))),
      bandNewWhere: whereSteep(newSteep, h),
    },
  };
  results.settings[name] = out;
  console.log(name, JSON.stringify(out));
  if (opts.supportM === LOCAL_SAMPLE_DEFAULTS.supportM && opts.fadeM === LOCAL_SAMPLE_DEFAULTS.fadeM) {
    fs.writeFileSync(path.join(gridOut, 'dem-T01.f32'), Buffer.from(h.buffer, h.byteOffset, h.byteLength));
  }
}

// ---- 4. 외톨이 표본: E01 V2d 에서 문제였던 기타 구역 api 한 점을 넣었을 때 ----
{
  const all = JSON.parse(fs.readFileSync(e01SamplesFile, 'utf8')).samples.filter((s: any) => s.use);
  const others = all.filter((s: any) => s.area === '기타');
  const run = (opts: LocalSampleOptions) => {
    const r = applyLocalSamples(g, live, [...samples, ...others], opts);
    const base = applyLocalSamples(g, live, samples, opts).heights;
    return { skipped: r.skipped.length, maxAbsChangeFromOthersM: r2(maxDiff(r.heights, base)) };
  };
  results.loneSamples = { note: '세 구역 표본에 기타 구역 흩어진 api 31개를 더했을 때, 그 31개 때문에 달라지는 최대값', others: others.length,
    noGuard: run({ ...LOCAL_SAMPLE_DEFAULTS, minNeighbours: 0 }), guard: run(LOCAL_SAMPLE_DEFAULTS) };
  console.log('외톨이', JSON.stringify(results.loneSamples));
}
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
