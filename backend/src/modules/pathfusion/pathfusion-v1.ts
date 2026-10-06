// pathfusion-v1: canonical path + confidence corridor from repeated passes (docs/MOBILITY_MAP_PLAN.md 4.7–4.10).
// Pure and deterministic. Input passes are already resampled (1 m) and oriented A→B.
//
// Per reference station, each pass gets ONE vote (mean of its points projected there); the new station is the
// MEDIAN of the votes' lateral offsets along the normal (robust: almost half of the passes can be off without
// dragging it). Medians remove errors that differ between passes, NOT a bias every pass shares at the same place
// (multipath): the corridor shows repeatability, accuracy needs anchors.
import { createHash } from 'node:crypto';
import type { Station } from '../trajectory/resample.js';
import { resamplePolyline, reverseStations } from '../trajectory/resample.js';
import { dtwMeanDistance, median, normals, projectMonotone, quantile, robustSigma } from '../trajectory/geometry.js';

export const PATHFUSION_VERSION = 'pathfusion-v1';

export const pathfusionParamsV1 = {
  ds: 1,
  widthM: 20, // similarity: a pass station farther than this from the reference does not "cover" it
  minCoverage: 0.8, // fraction of a pass's stations within widthM of the reference
  minLengthRatio: 0.75,
  maxLengthRatio: 1.33,
  maxDtwMeanM: 10,
  minRange: 0.3, // fraction of the reference a pass must cover (else TOO_SHORT)
  fullRange: 0.8, // below: PARTIAL (contributes where it covers)
  flipRatio: 0.8, // reversed DTW < 0.8 x forward => the pass was walked the other way
  dtwBand: 0.15,
  maxIterations: 8,
  convergenceM: 0.1,
  outlierSigmas: 3,
  outlierMinM: 3,
  runOutlierFraction: 0.3, // a pass whose votes are outliers at > 30 % of its stations is excluded entirely
  smoothWindow: 7, // moving median (stations) between iterations (synthetic grid: 5 passes reach the median-of-5 limit)
  normalHalfWindow: 5, // stations: direction of the reference from the chord over ±5 m
  corridorSigmas: 2, // half-width = max(2 sqrt(sigma² + se²), minHalfWidth)
  minHalfWidthM: 0.5,
  fallbackSigmaM: 5, // stations with < 2 votes: corridor from the engine sigma, or this
  confidenceSigmaScaleM: 5,
  confidenceSampleScale: 3,
  lowSamples: 3,
};
export type PathfusionParams = typeof pathfusionParamsV1;

export const paramsHash = (p: PathfusionParams) => createHash('sha256').update(`${PATHFUSION_VERSION}#${JSON.stringify(p)}`).digest('hex').slice(0, 16);

export interface PassInput {
  id: string;
  stations: Station[];
  /** quality weight (session quality, bundle 4); 1 = full */
  weight?: number;
  /** h of this pass is only relative (no absolute datum): aligned by its median offset */
  hRelative?: boolean;
}

export type PassStatus = 'ACCEPTED' | 'PARTIAL' | 'REJECTED';
export type PassReason = 'DIFFERENT_PATH' | 'LENGTH_MISMATCH' | 'TOO_SHORT' | 'RUN_OUTLIER' | 'TOO_FEW_STATIONS';

export interface PassResult {
  id: string;
  status: PassStatus;
  reasons: PassReason[];
  flipped: boolean;
  coverage: number;
  lengthRatio: number;
  dtwMeanM: number;
  range: number;
  outlierVoteFraction: number | null;
  /** median offset applied to a relative-height pass (m) */
  zOffsetM: number | null;
}

export interface CanonicalPoint {
  s: number;
  x: number;
  y: number;
  z: number | null;
  sampleCount: number;
  sigmaXY: number | null;
  sigmaZ: number | null;
  seXY: number | null;
  /** corridor half-width (m) */
  halfWidthM: number;
  confidence: number;
  lowSamples: boolean;
  contributors: string[];
}

export interface CanonicalResult {
  version: string;
  params: PathfusionParams;
  paramsHash: string;
  points: CanonicalPoint[];
  passes: PassResult[];
  medoid: string | null;
  iterations: number;
  zRelative: boolean;
  lengthM: number;
}

interface Vote { pass: string; lateral: number; h: number | null; sigmaH: number | null; x: number; y: number }

/** Each pass's mean position (and height) per reference station: one vote per pass and station. */
function collectVotes(ref: { x: number; y: number }[], passes: { id: string; stations: Station[]; zOffset: number }[], ds: number, normalHalfWindow: number) {
  const votes: Vote[][] = ref.map(() => []);
  const nrm = normals(ref, normalHalfWindow);
  for (const p of passes) {
    const proj = projectMonotone(p.stations, ref);
    const acc = new Map<number, { x: number; y: number; h: number[]; sig: number[]; n: number }>();
    proj.forEach((r, k) => {
      const i = Math.min(ref.length - 1, Math.max(0, Math.round(r.s / ds)));
      const st = p.stations[k];
      const a = acc.get(i) ?? { x: 0, y: 0, h: [], sig: [], n: 0 };
      a.x += st.x;
      a.y += st.y;
      a.n++;
      if (st.h !== null) a.h.push(st.h + p.zOffset);
      if (st.sigmaH !== null) a.sig.push(st.sigmaH);
      acc.set(i, a);
    });
    for (const [i, a] of acc) {
      const x = a.x / a.n;
      const y = a.y / a.n;
      // offset along the station's (window-smoothed) normal: on a straight stretch exactly the cross-section offset
      const lateral = (x - ref[i].x) * nrm[i].x + (y - ref[i].y) * nrm[i].y;
      votes[i].push({ pass: p.id, lateral, h: a.h.length ? median(a.h) : null, sigmaH: a.sig.length ? median(a.sig) : null, x, y });
    }
  }
  return { votes, nrm };
}

function movingMedian(line: { x: number; y: number }[], window: number) {
  const h = Math.floor(window / 2);
  return line.map((_, i) => {
    if (i === 0 || i === line.length - 1) return line[i]; // keep the ends
    const lo = Math.max(0, i - h);
    const hi = Math.min(line.length - 1, i + h);
    const xs = [], ys = [];
    for (let k = lo; k <= hi; k++) {
      xs.push(line[k].x);
      ys.push(line[k].y);
    }
    return { x: median(xs)!, y: median(ys)! };
  });
}

const len = (st: Station[]) => (st.length ? st.at(-1)!.s - st[0].s : 0);

/** Similarity of a pass to the reference line: coverage, length ratio, DTW mean distance, covered range. */
export function similarity(stations: Station[], ref: { x: number; y: number }[], refLength: number, p: PathfusionParams) {
  const proj = projectMonotone(stations, ref);
  const coverage = proj.filter((r) => r.d <= p.widthM).length / Math.max(stations.length, 1);
  const within = proj.filter((r) => r.d <= p.widthM).map((r) => r.s);
  const range = within.length ? (Math.max(...within) - Math.min(...within)) / Math.max(refLength, 1) : 0;
  const dtw = dtwMeanDistance(stations, ref, p.dtwBand);
  return { coverage, range, dtwMeanM: dtw, lengthRatio: len(stations) / Math.max(refLength, 1) };
}

export function buildCanonical(inputs: PassInput[], params: Partial<PathfusionParams> = {}): CanonicalResult {
  const p: PathfusionParams = { ...pathfusionParamsV1, ...params };
  const results = new Map<string, PassResult>();
  const usable = inputs.filter((x) => {
    if (x.stations.length >= 5) return true;
    results.set(x.id, { id: x.id, status: 'REJECTED', reasons: ['TOO_FEW_STATIONS'], flipped: false, coverage: 0, lengthRatio: 0, dtwMeanM: Infinity, range: 0, outlierVoteFraction: null, zOffsetM: null });
    return false;
  });
  const empty = (): CanonicalResult => ({ version: PATHFUSION_VERSION, params: p, paramsHash: paramsHash(p), points: [], passes: inputs.map((x) => results.get(x.id)!), medoid: null, iterations: 0, zRelative: false, lengthM: 0 });
  if (!usable.length) return empty();

  // medoid: smallest summed DTW distance to the others (the most typical pass)
  const sums = usable.map((a) => usable.reduce((acc, b) => acc + (a === b ? 0 : Math.min(dtwMeanDistance(a.stations, b.stations, p.dtwBand), 1e6)), 0));
  const medoid = usable[sums.indexOf(Math.min(...sums))];
  let ref = resamplePolyline(medoid.stations, p.ds).map(({ x, y }) => ({ x, y }));
  const refLength = len(medoid.stations);

  // similarity + direction against the medoid
  const oriented = new Map<string, Station[]>();
  for (const x of usable) {
    let st = x.stations;
    let sim = similarity(st, ref, refLength, p);
    let flipped = false;
    if (x !== medoid) {
      const rev = reverseStations(st);
      const simRev = similarity(rev, ref, refLength, p);
      if (simRev.dtwMeanM < p.flipRatio * sim.dtwMeanM) {
        st = rev;
        sim = simRev;
        flipped = true;
      }
    }
    const reasons: PassReason[] = [];
    if (sim.coverage < p.minCoverage || sim.dtwMeanM > p.maxDtwMeanM) reasons.push('DIFFERENT_PATH');
    if (sim.range < p.minRange) reasons.push('TOO_SHORT');
    else if (sim.range >= p.fullRange && (sim.lengthRatio < p.minLengthRatio || sim.lengthRatio > p.maxLengthRatio)) reasons.push('LENGTH_MISMATCH');
    // a partial pass is judged by what it covers: DTW over the whole reference does not apply
    if (sim.range < p.fullRange && reasons.length === 1 && reasons[0] === 'DIFFERENT_PATH' && sim.coverage >= p.minCoverage) reasons.length = 0;
    const status: PassStatus = reasons.length ? 'REJECTED' : sim.range < p.fullRange ? 'PARTIAL' : 'ACCEPTED';
    results.set(x.id, { id: x.id, status, reasons, flipped, coverage: sim.coverage, lengthRatio: sim.lengthRatio, dtwMeanM: sim.dtwMeanM, range: sim.range, outlierVoteFraction: null, zOffsetM: null });
    oriented.set(x.id, st);
  }

  const active = () => usable.filter((x) => results.get(x.id)!.status !== 'REJECTED');
  const absolute = () => active().filter((x) => !x.hRelative);
  const zRelative = absolute().length === 0;
  let zOffsets = new Map<string, number>();
  let iterations = 0;
  let votes: Vote[][] = [];
  let nrm: { x: number; y: number }[] = [];

  for (let restart = 0; restart <= usable.length; restart++) {
    // iterate: vote -> median lateral -> smooth -> resample
    for (iterations = 1; iterations <= p.maxIterations; iterations++) {
      ({ votes, nrm } = collectVotes(ref, active().map((x) => ({ id: x.id, stations: oriented.get(x.id)!, zOffset: zOffsets.get(x.id) ?? 0 })), p.ds, p.normalHalfWindow));
      const moved = ref.map((r, i) => {
        const v = keptVotes(votes[i], p);
        const m = v.length ? median(v.map((x) => x.lateral))! : 0;
        return { x: r.x + m * nrm[i].x, y: r.y + m * nrm[i].y };
      });
      const next = resamplePolyline(movingMedian(moved, p.smoothWindow), p.ds).map(({ x, y }) => ({ x, y }));
      const shift = Math.max(...next.map((q, i) => (i < ref.length ? Math.hypot(q.x - ref[i].x, q.y - ref[i].y) : 0)));
      ref = next;
      if (shift < p.convergenceM) break;
    }
    iterations = Math.min(iterations, p.maxIterations);
    ({ votes, nrm } = collectVotes(ref, active().map((x) => ({ id: x.id, stations: oriented.get(x.id)!, zOffset: zOffsets.get(x.id) ?? 0 })), p.ds, p.normalHalfWindow));
    // passes that are outliers at too many of their stations are excluded, then everything is recomputed
    let dropped = false;
    for (const x of active()) {
      let total = 0, out = 0;
      votes.forEach((vs) => {
        const mine = vs.find((v) => v.pass === x.id);
        if (!mine) return;
        total++;
        if (!keptVotes(vs, p).includes(mine)) out++;
      });
      const frac = total ? out / total : 0;
      results.get(x.id)!.outlierVoteFraction = frac;
      if (frac > p.runOutlierFraction && active().length > 2) {
        const r = results.get(x.id)!;
        r.status = 'REJECTED';
        r.reasons.push('RUN_OUTLIER');
        dropped = true;
      }
    }
    // relative-height passes: median offset to the absolute ones (or to the first pass when none is absolute)
    const newOffsets = relativeOffsets(votes, active(), zOffsets);
    const offsetChanged = [...newOffsets].some(([k, v]) => Math.abs(v - (zOffsets.get(k) ?? 0)) > 0.01);
    zOffsets = newOffsets;
    if (!dropped && !offsetChanged) break;
    ref = resamplePolyline(oriented.get(pickMedoid(active(), oriented, p) ?? medoid.id)!, p.ds).map(({ x, y }) => ({ x, y }));
  }
  for (const [k, v] of zOffsets) results.get(k)!.zOffsetM = Math.round(v * 100) / 100;

  const points: CanonicalPoint[] = ref.map((r, i) => {
    const all = votes[i] ?? [];
    const v = keptVotes(all, p);
    const n = v.length;
    // spread from ALL votes: the MAD is robust already; measuring it after removing outliers would shrink it twice
    const sigmaXY = robustSigma(all.map((x) => x.lateral));
    const hs = v.map((x) => x.h).filter((h): h is number => h !== null);
    const engine = median(v.map((x) => x.sigmaH).filter((s): s is number => s !== null));
    const sigmaForWidth = sigmaXY ?? engine ?? p.fallbackSigmaM;
    const confidence = n ? (1 - Math.exp(-n / p.confidenceSampleScale)) * Math.exp(-(sigmaXY ?? sigmaForWidth) / p.confidenceSigmaScaleM) : 0;
    return {
      s: i * p.ds,
      x: r.x,
      y: r.y,
      z: hs.length ? median(hs) : null,
      sampleCount: n,
      sigmaXY,
      sigmaZ: robustSigma(hs),
      seXY: sigmaXY !== null && n > 0 ? (1.2533 * sigmaXY) / Math.sqrt(n) : null,
      // prediction band for a NEW pass: its own spread plus the uncertainty of the canonical point itself
      halfWidthM: Math.max(p.corridorSigmas * Math.sqrt(sigmaForWidth ** 2 + (sigmaXY !== null && n > 0 ? (1.2533 * sigmaXY) ** 2 / n : 0)), p.minHalfWidthM),
      confidence,
      lowSamples: n < p.lowSamples,
      contributors: v.map((x) => x.pass),
    };
  });
  return {
    version: PATHFUSION_VERSION, params: p, paramsHash: paramsHash(p), points, passes: inputs.map((x) => results.get(x.id)!),
    medoid: medoid.id, iterations, zRelative, lengthM: points.length ? points.at(-1)!.s : 0,
  };
}

/** Votes within max(3 sigma, 3 m) of the median lateral offset (all of them below 3 votes). */
function keptVotes(vs: Vote[], p: PathfusionParams): Vote[] {
  if (vs.length < 3) return vs;
  const lat = vs.map((v) => v.lateral);
  const m = median(lat)!;
  const sig = robustSigma(lat, m) ?? 0;
  const lim = Math.max(p.outlierSigmas * sig, p.outlierMinM);
  return vs.filter((v) => Math.abs(v.lateral - m) <= lim);
}

function relativeOffsets(votes: Vote[][], passes: PassInput[], current: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const abs = new Set(passes.filter((x) => !x.hRelative).map((x) => x.id));
  const rel = passes.filter((x) => x.hRelative);
  if (!rel.length) return out;
  const anchorIds = abs.size ? abs : new Set([rel[0].id]);
  for (const x of rel) {
    if (anchorIds.has(x.id)) {
      out.set(x.id, 0);
      continue;
    }
    const diffs: number[] = [];
    for (const vs of votes) {
      const mine = vs.find((v) => v.pass === x.id);
      const ref = vs.filter((v) => anchorIds.has(v.pass) && v.h !== null).map((v) => v.h!);
      if (mine && mine.h !== null && ref.length) diffs.push(median(ref)! - (mine.h - (current.get(x.id) ?? 0)));
    }
    out.set(x.id, diffs.length ? median(diffs)! : 0);
  }
  return out;
}

function pickMedoid(passes: PassInput[], oriented: Map<string, Station[]>, p: PathfusionParams): string | null {
  const full = passes.filter((x) => oriented.get(x.id)!.length >= 5);
  if (!full.length) return null;
  const sums = full.map((a) => full.reduce((acc, b) => acc + (a === b ? 0 : dtwMeanDistance(oriented.get(a.id)!, oriented.get(b.id)!, p.dtwBand)), 0));
  return full[sums.indexOf(Math.min(...sums))].id;
}

// ---------------------------------------------------------------------------------------------
// validation (4.10): leave one pass out
// ---------------------------------------------------------------------------------------------

export interface PassErrors {
  id: string;
  stations: number;
  medianXY: number | null;
  p95XY: number | null;
  maxXY: number | null;
  medianZ: number | null;
  p95Z: number | null;
  /** fraction of the pass's stations inside the corridor built without it */
  corridorCoverage: number | null;
  /** per station: distance to the canonical path (for drawing) */
  errors: { s: number; x: number; y: number; d: number; fx: number; fy: number; inside: boolean; dz: number | null }[];
}

export interface ValidationResult {
  method: 'LEAVE_ONE_OUT';
  passes: PassErrors[];
  pooled: { stations: number; medianXY: number | null; p95XY: number | null; maxXY: number | null; medianZ: number | null; p95Z: number | null; corridorCoverage: number | null };
}

/** Errors of `test` stations against a canonical path (nearest distance in XY, height difference at the foot point). */
export function passErrors(id: string, test: Station[], canonical: CanonicalPoint[], zOffset = 0): PassErrors {
  const line = canonical.map((c) => ({ x: c.x, y: c.y }));
  if (line.length < 2) return { id, stations: test.length, medianXY: null, p95XY: null, maxXY: null, medianZ: null, p95Z: null, corridorCoverage: null, errors: [] };
  const proj = projectMonotone(test, line);
  const errors = proj.map((r, k) => {
    const i = Math.min(canonical.length - 1, Math.max(0, Math.round(r.s / Math.max(canonical[1].s - canonical[0].s, 1e-9))));
    return { s: test[k].s, x: test[k].x, y: test[k].y, d: r.d, fx: r.x, fy: r.y, inside: r.d <= canonical[i].halfWidthM, i };
  });
  const xy = errors.map((e) => e.d);
  const dz = errors.map((e, k) => (test[k].h !== null && canonical[e.i].z !== null ? Math.abs(test[k].h! + zOffset - canonical[e.i].z!) : null));
  const z = dz.filter((v): v is number => v !== null);
  return {
    id, stations: test.length,
    medianXY: median(xy), p95XY: quantile(xy, 0.95), maxXY: xy.length ? Math.max(...xy) : null,
    medianZ: median(z), p95Z: quantile(z, 0.95),
    corridorCoverage: errors.length ? errors.filter((e) => e.inside).length / errors.length : null,
    errors: errors.map(({ i: _i, ...e }, k) => ({ ...e, dz: dz[k] })),
  };
}

/** Leave-one-pass-out: each pass is compared with the canonical path built from the OTHER passes only. */
export function leaveOneOut(inputs: PassInput[], params: Partial<PathfusionParams> = {}): ValidationResult {
  const full = buildCanonical(inputs, params);
  const usable = full.passes.filter((x) => x.status !== 'REJECTED').map((x) => x.id);
  const passes: PassErrors[] = [];
  for (const id of usable) {
    const train = inputs.filter((x) => x.id !== id && usable.includes(x.id));
    if (train.length < 1) continue;
    const c = buildCanonical(train, params);
    const test = inputs.find((x) => x.id === id)!;
    const flipped = full.passes.find((x) => x.id === id)!.flipped;
    const stations = flipped ? reverseStations(test.stations) : test.stations;
    passes.push(passErrors(id, stations, c.points, full.passes.find((x) => x.id === id)!.zOffsetM ?? 0));
  }
  const allXY = passes.flatMap((x) => x.errors.map((e) => e.d));
  const inside = passes.flatMap((x) => x.errors.map((e) => e.inside));
  const zs = passes.flatMap((x) => x.errors.map((e) => e.dz)).filter((v): v is number => v !== null);
  return {
    method: 'LEAVE_ONE_OUT',
    passes,
    pooled: {
      stations: allXY.length, medianXY: median(allXY), p95XY: quantile(allXY, 0.95), maxXY: allXY.length ? Math.max(...allXY) : null,
      medianZ: median(zs), p95Z: quantile(zs, 0.95), corridorCoverage: inside.length ? inside.filter(Boolean).length / inside.length : null,
    },
  };
}
