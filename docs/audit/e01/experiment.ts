// E01: S-MAP 지면 표본을 DEM 생성에 넣었을 때의 맞음·손상 비교 (오프라인, DB·서버 접근 없음).
// 사용법(저장소 루트에서):
//   npx tsx docs/audit/e01/experiment.ts <sources-5186-epsg.json> <terrain-grid.f32> <terrain-grid-meta.json> <samples.json> <field-surfaces-v3.geojson> <results.json> [격자 출력 폴더]
//
// backend/src 는 고치지 않는다. buildDem 은 등고선만의 면(표고점 없음)을 얻는 데 쓰고, 표고점 보정 단계는
// dem.ts 와 같은 식을 이 파일의 applyPasses 로 옮겨 쓴다(원 표고점으로 돌리면 보관된 서버 격자와 같은지 먼저 확인한다).
// 이유: buildDem 안의 하나 빼기 검증(spotLooResiduals)은 표고점 수 n 에 대해 n^3 에 비례해 표본 2,500개면 한 번에 수 분 이상(추정) 걸려 반복 검증에 쓸 수 없다.
import fs from 'node:fs';
import path from 'node:path';
import { bilinear, buildDem, type Grid } from '../../../backend/src/geo/dem.ts';
import { distanceTransform } from '../../../backend/src/geo/edt.ts';
import { applyPlateau } from '../../../backend/src/geo/terrain-plateau.ts';

const [srcFile, gridFile, metaFile, samplesFile, fieldFile, outFile, gridOut] = process.argv.slice(2);
type Pt = { x: number; y: number; z: number };
type Sample = Pt & { kind: 'api' | 'mesh'; area: string; src: string; use: boolean };
type Pass = [number, number];
const DEFAULT: Pass[] = [[120, 300], [25, 60]];
const AREAS = ['운동장', '사잇길', 'S06', '기타'];
const r2 = (v: number) => Math.round(v * 100) / 100;
const maxOf = (v: ArrayLike<number>) => { let m = -Infinity; for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i]; return m; };

const src = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^﻿/, ''));
const g: Grid = { originX: meta.originX, originY: meta.originY, resolution: meta.resolution, width: meta.width, height: meta.height };
const n = g.width * g.height;
const lb = fs.readFileSync(gridFile);
const live = new Float32Array(lb.buffer.slice(lb.byteOffset, lb.byteOffset + lb.byteLength));
const all: Sample[] = JSON.parse(fs.readFileSync(samplesFile, 'utf8')).samples;
const used = all.filter((s) => s.use);
const origSpots: Pt[] = src.spots.map((s: any) => ({ x: s.x, y: s.y, z: s.height }));

// ---- dem.ts 의 표고점 보정 단계와 같은 식 ----
function applyPasses(base: Float32Array, spots: Pt[], passes: Pass[]): Float32Array {
  const heights = base.slice();
  let usable: (Pt & { r: number })[] = [];
  for (const s of spots) {
    const h = bilinear(g, heights, s.x, s.y);
    if (h !== null) usable.push({ ...s, r: s.z - h });
  }
  for (const [kernel, radius] of passes) {
    const k2 = 2 * kernel ** 2;
    const reach = Math.ceil(radius / g.resolution);
    const wsum = new Float32Array(n);
    const rsum = new Float32Array(n);
    for (const s of usable) {
      const cx = Math.floor((s.x - g.originX) / g.resolution);
      const cy = Math.floor((s.y - g.originY) / g.resolution);
      for (let iy = Math.max(0, cy - reach); iy <= Math.min(g.height - 1, cy + reach); iy++) {
        for (let ix = Math.max(0, cx - reach); ix <= Math.min(g.width - 1, cx + reach); ix++) {
          const dx = g.originX + (ix + 0.5) * g.resolution - s.x;
          const dy = g.originY + (iy + 0.5) * g.resolution - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > radius ** 2) continue;
          const w = Math.exp(-d2 / k2);
          wsum[iy * g.width + ix] += w;
          rsum[iy * g.width + ix] += w * s.r;
        }
      }
    }
    usable = residualUpdate(usable, kernel, radius);
    for (let i = 0; i < n; i++) if (wsum[i] > 0) heights[i] += rsum[i] / (wsum[i] + 0.3);
  }
  return heights;
}
function residualUpdate<T extends { x: number; y: number; r: number }>(pts: T[], kernel: number, radius: number): T[] {
  const k2 = 2 * kernel ** 2;
  return pts.map((s) => {
    let w = 0, wr = 0;
    for (const o of pts) {
      const d2 = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
      if (d2 > radius ** 2) continue;
      const k = Math.exp(-d2 / k2);
      w += k; wr += k * o.r;
    }
    return { ...s, r: s.r - (w > 0 ? wr / (w + 0.3) : 0) };
  });
}
// 몇 개 점에서만 보정 결과를 구한다(하나 빼기 검증용). values: 점별 기준면 값, 돌려주는 값: 보정 후 값.
function correctPoints(points: { x: number; y: number }[], values: number[], spots: { x: number; y: number; r: number }[], passes: Pass[]): number[] {
  const out = values.slice();
  let tr = spots;
  for (const [kernel, radius] of passes) {
    const k2 = 2 * kernel ** 2;
    points.forEach((p, i) => {
      let w = 0, wr = 0;
      for (const s of tr) {
        const d2 = (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
        if (d2 > radius ** 2) continue;
        const k = Math.exp(-d2 / k2);
        w += k; wr += k * s.r;
      }
      if (w > 0) out[i] += wr / (w + 0.3);
    });
    tr = residualUpdate(tr, kernel, radius);
  }
  return out;
}
const cellsOf = (p: { x: number; y: number }) => {
  const fx = (p.x - g.originX) / g.resolution - 0.5, fy = (p.y - g.originY) / g.resolution - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
  const c = (x: number, y: number) => ({ x: g.originX + (x + 0.5) * g.resolution, y: g.originY + (y + 0.5) * g.resolution, i: y * g.width + x });
  return { cells: [c(ix, iy), c(ix + 1, iy), c(ix, iy + 1), c(ix + 1, iy + 1)], w: [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty] };
};

// ---- 통계 ----
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const stat = (r: number[]) => r.length ? { n: r.length, median: r2(pct(r, 0.5)), p90Abs: r2(pct(r.map(Math.abs), 0.9)), maxAbs: r2(maxOf(r.map(Math.abs))) } : { n: 0 };
function byArea(pts: Sample[], heights: Float32Array) {
  const out: Record<string, unknown> = {};
  for (const a of AREAS) {
    const sel = pts.filter((s) => s.area === a);
    out[a] = stat(sel.map((s) => s.z - bilinear(g, heights, s.x, s.y)!));
  }
  return out;
}

// ---- 1. 재현 확인 ----
const contourOnly = buildDem(g, src.contours, []).heights;
const base0 = applyPasses(contourOnly, origSpots, DEFAULT);
let repMax = 0, repSq = 0;
for (let i = 0; i < n; i++) { const d = base0[i] - live[i]; repMax = Math.max(repMax, Math.abs(d)); repSq += d * d; }
const results: any = { created: '2026-10-10', grid: g, reproduction: { cells: n, maxAbsM: repMax, rmsM: Math.sqrt(repSq / n), note: 'applyPasses(등고선만의 면, 원 표고점) 대 보관된 서버 격자' } };
console.log('재현', results.reproduction);
if (repMax > 0.05) throw new Error('보관 격자를 재현하지 못함');

// ---- 2. 수직 기준 대조 자료 ----
// (a) 원 표고점과 같은 XY 의 S-MAP 조회값 (b) 등고선에서 1 m 안에 있는 api 표본: 표본 z - 등고선 높이
{
  const near: { area: string; d: number; name: string }[] = [];
  for (const s of used.filter((u) => u.kind === 'api')) {
    let best = Infinity, h = 0;
    for (const c of src.contours) {
      for (let k = 0; k + 1 < c.points.length; k++) {
        const [ax, ay] = c.points[k], [bx, by] = c.points[k + 1];
        const t = Math.max(0, Math.min(1, ((s.x - ax) * (bx - ax) + (s.y - ay) * (by - ay)) / Math.max((bx - ax) ** 2 + (by - ay) ** 2, 1e-9)));
        const d = Math.hypot(s.x - ax - t * (bx - ax), s.y - ay - t * (by - ay));
        if (d < best) { best = d; h = c.height; }
      }
    }
    if (best <= 1) near.push({ area: s.area, d: r2(s.z - h), name: (s as any).name });
  }
  const spotTies = origSpots.flatMap((o) => used.filter((u) => u.kind === 'api' && Math.hypot(u.x - o.x, u.y - o.y) < 0.5).map((u) => ({ x: o.x, y: o.y, spot: r2(o.z), smap: r2(u.z), diff: r2(u.z - o.z) })));
  results.datum = { sameXYasOriginalSpot: spotTies, apiWithin1mOfContour: near, apiOtherAreaList: used.filter((u) => u.kind === 'api' && u.area === '기타').map((s) => ({ name: (s as any).name, smap: r2(s.z), smapMinusLive: r2(s.z - bilinear(g, live, s.x, s.y)!) })), apiOtherAreaVsLiveDem: stat(used.filter((u) => u.kind === 'api' && u.area === '기타').map((s) => s.z - bilinear(g, live, s.x, s.y)!)) };
  console.log('수직 기준', JSON.stringify(results.datum));
}

// ---- 3. 기준(현행 DEM) 잔차 ----
results.samples = { used: used.length, perArea: Object.fromEntries(AREAS.map((a) => [a, { api: used.filter((s) => s.area === a && s.kind === 'api').length, mesh: used.filter((s) => s.area === a && s.kind === 'mesh').length }])) };
results.baseline = { all: byArea(used, live), apiOnly: byArea(used.filter((s) => s.kind === 'api'), live) };
console.log('기준', JSON.stringify(results.baseline));

// ---- 4. 변형 ----
// LOCAL: 표본 간격 2 m(mesh 격자)에 맞춘 좁은 단계. [6,15] 는 격자 3칸 폭으로 10 m 안팎의 빈 곳을 메우고, [3,8] 은 1.5칸 폭으로 남은 차이를 줄인다.
const LOCAL: Pass[] = [[6, 15], [3, 8]];
// LOCAL4: 같은 좁은 단계를 격자 한 칸 폭(2 m)으로 두 번 더 돌려 남은 차이를 줄인다(반복할수록 표본값에 가까워진다).
const LOCAL4: Pass[] = [...LOCAL, [2, 6], [2, 6]];
const field = JSON.parse(fs.readFileSync(fieldFile, 'utf8')).features.find((f: any) => f.properties.id === 'SF-FIELD');
const fieldRings: [number, number][][] = field.geometry.coordinates.map((ring: number[][]) => ring.map((p) => [p[0], p[1]] as [number, number]));
type Variant = { id: string; desc: string; build: (train: Sample[]) => Float32Array; gateSpots: (train: Sample[]) => Pt[]; only?: (s: Sample) => boolean };
const variants: Variant[] = [
  { id: 'V1', desc: '표본을 표고점에 합침, 기본 단계 [[120,300],[25,60]]', build: (t) => applyPasses(contourOnly, [...origSpots, ...t], DEFAULT), gateSpots: (t) => [...origSpots, ...t] },
  { id: 'V2a', desc: 'V1 + 좁은 단계 [6,15],[3,8] 추가', build: (t) => applyPasses(contourOnly, [...origSpots, ...t], [...DEFAULT, ...LOCAL]), gateSpots: (t) => [...origSpots, ...t] },
  { id: 'V2b', desc: '원 표고점만으로 기본 단계(=현행 DEM) 뒤, 표본만으로 좁은 단계 [6,15],[3,8]', build: (t) => applyPasses(base0, t, LOCAL), gateSpots: () => origSpots },
  { id: 'V2c', desc: 'V2b 와 같으나 좁은 단계를 [3,8] 하나만', build: (t) => applyPasses(base0, t, [[3, 8]]), gateSpots: () => origSpots },
  { id: 'V2d', desc: 'V2b 에 격자 한 칸 폭 단계 [2,6] 을 두 번 더', build: (t) => applyPasses(base0, t, LOCAL4), gateSpots: () => origSpots },
  { id: 'V2e', desc: 'V2d 와 같으나 기타 구역 표본(흩어진 api 31개)은 넣지 않음', build: (t) => applyPasses(base0, t.filter((s) => s.area !== '기타'), LOCAL4), gateSpots: () => origSpots, only: (s) => s.area !== '기타' },
  { id: 'V3', desc: 'V2b 에서 운동장 평지 칸 표본을 빼고 SF-FIELD 다각형을 148.92 m 로 평탄화', build: (t) => applyPlateau(g, applyPasses(base0, t.filter((s) => !s.src.includes('field_flat')), LOCAL), fieldRings, 148.92), gateSpots: () => origSpots },
];

// 검증 나누기: random = 표본 순서를 고정 난수로 섞어 5등분, block10 = 10 m 정사각 구획 단위 5등분(가까운 이웃이 같이 빠짐)
let seed = 20261010;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const randomFold = used.map(() => Math.floor(rnd() * 5));
const blockFold = used.map((s) => (((Math.floor(s.x / 10) * 7 + Math.floor(s.y / 10) * 13) % 5) + 5) % 5);
function holdout(v: Variant, fold: number[]) {
  const res: Record<string, number[]> = Object.fromEntries(AREAS.map((a) => [a, []]));
  for (let k = 0; k < 5; k++) {
    const h = v.build(used.filter((_, i) => fold[i] !== k));
    used.forEach((s, i) => { if (fold[i] === k) res[s.area].push(s.z - bilinear(g, h, s.x, s.y)!); });
  }
  return Object.fromEntries(AREAS.map((a) => [a, stat(res[a])]));
}

// 표본까지의 거리(칸 단위 최근접, m). 변형마다 실제로 넣은 표본 기준으로 구한다.
function bands(input: Sample[]) {
  const mask = new Uint8Array(n);
  for (const s of input) mask[Math.floor((s.y - g.originY) / g.resolution) * g.width + Math.floor((s.x - g.originX) / g.resolution)] = 1;
  const dist = distanceTransform(mask, g.width, g.height).map((d) => d * g.resolution);
  const band = (lo: number, hi: number) => { const idx: number[] = []; for (let i = 0; i < n; i++) if (dist[i] > lo && dist[i] <= hi) idx.push(i); return idx; };
  return { dist, inside: band(-1, 2), edge: band(2, 30), far: band(30, Infinity) };
}
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
const cellArea = g.resolution ** 2;
const slopeStat = (s: Float32Array, idx: number[]) => { const v = idx.map((i) => s[i]); return { max: r2(maxOf(v)), p99: r2(pct(v, 0.99)), over1: v.filter((x) => x > 1).length }; };

// 원 표고점의 하나 빼기 잔차(그 점을 모든 단계에서 뺌, 표본은 그대로 둠)
const origUsable = origSpots.filter((s) => bilinear(g, contourOnly, s.x, s.y) !== null);
function origLoo(id: string): number[] {
  return origUsable.map((held, hi) => {
    const rest = origUsable.filter((_, i) => i !== hi);
    const hc = cellsOf(held);
    const valAt = (pts: { x: number; y: number; i: number }[]) => pts.map((p) => contourOnly[p.i]);
    const withR = (pts: Pt[]) => pts.map((s) => ({ ...s, r: s.z - bilinear(g, contourOnly, s.x, s.y)! }));
    let cellVals: number[];
    if (id === 'base') cellVals = correctPoints(hc.cells, valAt(hc.cells), withR(rest), DEFAULT);
    else if (id === 'V1' || id === 'V2a') cellVals = correctPoints(hc.cells, valAt(hc.cells), withR([...rest, ...used]), id === 'V1' ? DEFAULT : [...DEFAULT, ...LOCAL]);
    else {
      // 2단계: 그 점을 뺀 기본 단계 면 위에서 표본 잔차를 다시 구해 좁은 단계 적용. 표본이 15 m 안에 없으면 2단계 영향 없음.
      const train = id === 'V3' ? used.filter((s) => !s.src.includes('field_flat')) : id === 'V2e' ? used.filter((s) => s.area !== '기타') : used;
      const nearS = train.filter((s) => Math.hypot(s.x - held.x, s.y - held.y) < 60);
      const sc = nearS.map(cellsOf);
      const pts = [...hc.cells, ...sc.flatMap((c) => c.cells)];
      const stage1 = correctPoints(pts, valAt(pts), withR(rest), DEFAULT);
      const sr = nearS.map((s, k) => ({ x: s.x, y: s.y, r: s.z - sc[k].w.reduce((a, w, j) => a + w * stage1[4 + 4 * k + j], 0) }));
      cellVals = correctPoints(hc.cells, stage1.slice(0, 4), sr, id === 'V2c' ? [[3, 8]] : id === 'V2d' || id === 'V2e' ? LOCAL4 : LOCAL);
      // V3 의 평탄화 다각형 안에 든 원 표고점은 평탄화 값으로 덮인다(아래 fit 에서 따로 본다)
    }
    return held.z - hc.w.reduce((a, w, j) => a + w * cellVals[j], 0);
  });
}
const looBase = origLoo('base');
results.baselineOrigSpotLoo = stat(looBase);
console.log('원 표고점 하나 빼기(현행)', JSON.stringify(results.baselineOrigSpotLoo));

results.variants = {};
for (const v of variants) {
  const t0 = Date.now();
  const input = v.only ? used.filter(v.only) : used;
  const { dist, inside, edge, far } = bands(input);
  const h = v.build(used);
  const dAbs = (idx: number[]) => idx.map((i) => Math.abs(h[i] - live[i]));
  const dFar = dAbs(far), dEdge = dAbs(edge);
  const sl = slopeOf(h);
  const gate = v.gateSpots(used).map((s) => ({ s, h: bilinear(g, contourOnly, s.x, s.y) })).filter((o) => o.h !== null).map((o) => o.s.z - o.h!);
  const gateStat = { n: gate.length, median: r2(pct(gate, 0.5)), p90Abs: r2(pct(gate.map(Math.abs), 0.9)) };
  const loo = origLoo(v.id);
  const out: any = {
    desc: v.desc,
    fit: byArea(used, h), // 모든 표본을 넣고 만든 면이 표본을 얼마나 따르는가(검증 아님)
    origSpotsFit: stat(origUsable.map((s) => s.z - bilinear(g, h, s.x, s.y)!)),
    holdoutRandom5: v.id === 'V3' ? '해당 없음(평탄화 다각형이 같은 칸에서 나옴)' : holdout(v, randomFold),
    holdoutBlock10m: v.id === 'V3' ? '해당 없음' : holdout(v, blockFold),
    changeBeyond30m: { maxAbsM: r2(maxOf(dFar)), areaOver05M2: dFar.filter((d) => d > 0.5).length * cellArea, areaOver01M2: dFar.filter((d) => d > 0.1).length * cellArea },
    changeBand2to30m: { maxAbsM: r2(maxOf(dEdge)), areaOver05M2: dEdge.filter((d) => d > 0.5).length * cellArea },
    origSpotLoo: { ...stat(loo), maxChangeVsBaseline: r2(Math.max(...loo.map((r, i) => Math.abs(r - looBase[i])))) },
    gateSpotResiduals: { ...gateStat, pass: Math.abs(gateStat.median) <= 2.5 && gateStat.p90Abs <= 5 },
    slope: { inside: slopeStat(sl, inside), edge2to30m: slopeStat(sl, edge) },
    slopeBefore: { inside: slopeStat(slope0, inside), edge2to30m: slopeStat(slope0, edge) },
    inputSamples: input.length,
    areasM2: { within2m: inside.length * cellArea, band2to30m: edge.length * cellArea, beyond30m: far.length * cellArea },
    seconds: 0,
  };
  {
    let bi = edge[0];
    for (const i of edge) if (Math.abs(h[i] - live[i]) > Math.abs(h[bi] - live[bi])) bi = i;
    out.changeBand2to30m.maxAt = { x: g.originX + ((bi % g.width) + 0.5) * g.resolution, y: g.originY + (Math.floor(bi / g.width) + 0.5) * g.resolution, deltaM: r2(h[bi] - live[bi]), distToSampleM: r2(dist[bi]) };
    // 표본에서 8 m 안에 있는 원 표고점: 원 표고점 높이 - 새 면(새 면은 그 자리에서 S-MAP 표본을 따른다)
    out.origSpotsNearSamples = origUsable.map((s) => ({ s, d: Math.min(...input.map((u) => Math.hypot(u.x - s.x, u.y - s.y))) })).filter((o) => o.d <= 8)
      .map((o) => ({ x: r2(o.s.x), y: r2(o.s.y), spotZ: r2(o.s.z), newDem: r2(bilinear(g, h, o.s.x, o.s.y)!), liveDem: r2(bilinear(g, live, o.s.x, o.s.y)!), distM: r2(o.d) }));
  }
  // 종류 교차: mesh 만 넣고 api 로 검사, api 만 넣고 mesh 로 검사
  if (v.id !== 'V3') {
    out.trainMeshTestApi = byArea(used.filter((s) => s.kind === 'api'), v.build(used.filter((s) => s.kind === 'mesh')));
    out.trainApiTestMesh = byArea(used.filter((s) => s.kind === 'mesh'), v.build(used.filter((s) => s.kind === 'api')));
  }
  out.seconds = Math.round((Date.now() - t0) / 1000);
  results.variants[v.id] = out;
  console.log(v.id, JSON.stringify(out));
  if (gridOut) fs.writeFileSync(path.join(gridOut, `dem-${v.id}.f32`), Buffer.from(h.buffer, h.byteOffset, h.byteLength));
}
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
