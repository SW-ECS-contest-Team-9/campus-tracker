// Several recorded walks of the same passage -> one centerline with an estimated width (docs/EDITOR_MCP_PLAN.md, corridor).
// Pure geometry, no database: the caller loads the tracks (fusion run FINAL positions, EPSG:5186) and saves the result as a road.
//
// Method: the longest track is the reference. It is resampled every stepM; at each station the lateral offset of every track
// (nearest point within searchRadiusM, measured along the station normal) is collected. The centre is the median offset,
// the height the median track height minus the phone height (or the terrain), the width a high percentile of the spread
// between tracks plus a margin. The centre line is smoothed and simplified in 3D.
import type { XYZ } from '../editor/topology.js';
import { clearHeightDifference, comparisonNoiseM, type HeightSource } from '../trajectory/height-difference.js';

/** run / t (ms) / sigmaZ (sigma of the run's height zero) are optional: with them, tracks on clearly different levels are refused. */
export interface TrackPoint { x: number; y: number; h: number | null; run?: string | null; t?: number | null; sigmaZ?: number | null }
export interface CorridorOptions {
  stepM: number;
  searchRadiusM: number;
  smoothWindow: number;
  simplifyM: number;
  zSource: 'run' | 'terrain';
  /** Phone height above the floor, subtracted from run heights (zSource "run"). */
  phoneHeightM: number;
  widthMarginM: number;
  minWidthM: number;
  maxWidthM: number;
}
export const DEFAULT_CORRIDOR: CorridorOptions = {
  stepM: 1, searchRadiusM: 6, smoothWindow: 5, simplifyM: 0.3, zSource: 'run', phoneHeightM: 1.1, widthMarginM: 0.8, minWidthM: 1.2, maxWidthM: 12,
};
export interface CorridorResult {
  coordinates: XYZ[];
  /** null when only one track covered the passage (no spread to measure) */
  widthM: number | null;
  stations: number;
  /** share of stations where at least two tracks (or the only one) were found */
  coverage: number;
  usedTracks: number;
  reversedTracks: number;
  zSource: 'run' | 'terrain';
  warnings: string[];
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const percentile = (v: number[], q: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
const heightSource = (t: TrackPoint[]): HeightSource => {
  const mid = (v: (number | null | undefined)[]) => { const f = v.filter((x): x is number => x != null && Number.isFinite(x)); return f.length ? median(f) : null; };
  return { run: t[0].run, t: mid(t.map((p) => p.t)), sigmaZ: mid(t.map((p) => p.sigmaZ)) };
};
const xyLength = (t: TrackPoint[]) => t.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - t[i].x, p.y - t[i].y), 0);

/** Douglas-Peucker on 3D points; always keeps both ends. */
export function simplify3D(points: XYZ[], tolerance: number): XYZ[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = points[a], B = points[b];
    const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const P = points[i], ap = [P[0] - A[0], P[1] - A[1], P[2] - A[2]];
      const t = len2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
      const d = Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Nearest point of a track to (x, y): position, interpolated height and distance. */
function nearestOnTrack(t: TrackPoint[], x: number, y: number) {
  let best: { x: number; y: number; h: number | null; d: number } | null = null;
  for (let i = 1; i < t.length; i++) {
    const a = t[i - 1], b = t[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const f = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    const px = a.x + dx * f, py = a.y + dy * f, d = Math.hypot(x - px, y - py);
    if (!best || d < best.d) best = { x: px, y: py, d, h: a.h !== null && b.h !== null ? a.h + (b.h - a.h) * f : (f < 0.5 ? a.h : b.h) ?? a.h ?? b.h };
  }
  return best;
}

export function corridorCenterline(input: TrackPoint[][], options: Partial<CorridorOptions> = {}, ground?: (x: number, y: number) => number | null): CorridorResult {
  const o = { ...DEFAULT_CORRIDOR, ...options };
  const warnings: string[] = [];
  // drop repeated points; a usable track has some length
  const tracks = input.map((t) => t.filter((p, i) => i === 0 || Math.hypot(p.x - t[i - 1].x, p.y - t[i - 1].y) >= 0.05)).filter((t) => t.length >= 2 && xyLength(t) >= o.stepM);
  if (!tracks.length) throw new Error('No track with at least two distinct points');
  if (tracks.length < input.length) warnings.push(`${input.length - tracks.length} track(s) were too short and ignored`);

  // reference = longest track; the others are flipped to walk the same way
  tracks.sort((a, b) => xyLength(b) - xyLength(a));
  const ref = tracks[0];
  let reversedTracks = 0;
  for (let k = 1; k < tracks.length; k++) {
    const t = tracks[k], s = t[0], e = t.at(-1)!, rs = ref[0], re = ref.at(-1)!;
    const same = Math.hypot(s.x - rs.x, s.y - rs.y) + Math.hypot(e.x - re.x, e.y - re.y);
    const flipped = Math.hypot(s.x - re.x, s.y - re.y) + Math.hypot(e.x - rs.x, e.y - rs.y);
    if (flipped < same) { tracks[k] = [...t].reverse(); reversedTracks++; }
  }

  // stations along the reference
  const total = xyLength(ref), count = Math.max(2, Math.round(total / o.stepM) + 1);
  const cum = [0];
  for (let i = 1; i < ref.length; i++) cum.push(cum[i - 1] + Math.hypot(ref[i].x - ref[i - 1].x, ref[i].y - ref[i - 1].y));
  const at = (m: number) => {
    let i = 1;
    while (i < ref.length - 1 && cum[i] < m) i++;
    const a = ref[i - 1], b = ref[i], seg = cum[i] - cum[i - 1], f = seg > 0 ? Math.max(0, Math.min(1, (m - cum[i - 1]) / seg)) : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };

  const centres: XYZ[] = [];
  const spreads: number[] = [];
  let covered = 0;
  const need = Math.min(2, tracks.length);
  const aboveRef: number[][] = tracks.map(() => []); // height of each track minus the reference, station by station
  for (let k = 0; k < count; k++) {
    const m = (total * k) / (count - 1);
    const p = at(m), p0 = at(Math.max(0, m - o.stepM)), p1 = at(Math.min(total, m + o.stepM));
    let tx = p1.x - p0.x, ty = p1.y - p0.y;
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    const offsets: number[] = [], heights: number[] = [];
    let refH: number | null = null;
    for (const [j, t] of tracks.entries()) {
      const q = nearestOnTrack(t, p.x, p.y);
      if (!q || q.d > o.searchRadiusM) continue;
      // only what lies across the passage; a point far along it belongs to another station
      if (Math.abs((q.x - p.x) * tx + (q.y - p.y) * ty) > Math.max(o.stepM, 1.5)) continue;
      offsets.push((q.x - p.x) * nx + (q.y - p.y) * ny);
      if (q.h !== null && Number.isFinite(q.h)) {
        heights.push(q.h);
        if (j === 0) refH = q.h;
        else if (refH !== null) aboveRef[j].push(q.h - refH);
      }
    }
    if (!offsets.length) continue;
    if (offsets.length >= need) covered++;
    if (offsets.length >= 2) spreads.push(Math.max(...offsets) - Math.min(...offsets));
    const off = median(offsets), cx = p.x + nx * off, cy = p.y + ny * off;
    let z: number | null = null;
    if (o.zSource === 'run' && heights.length) z = median(heights) - o.phoneHeightM;
    else if (ground) z = ground(cx, cy);
    if (z === null || !Number.isFinite(z)) continue;
    centres.push([cx, cy, z]);
  }
  if (o.zSource === 'run') {
    // A clear, consistent height difference between walks is another level (stacked corridors share the plan): never blended into one height.
    const refSource = heightSource(ref);
    const other = tracks.flatMap((t, j) => {
      if (j === 0) return [];
      const d = clearHeightDifference(aboveRef[j], comparisonNoiseM(heightSource(t), refSource));
      return d.clear ? [`${d.medianM! > 0 ? '+' : ''}${d.medianM!.toFixed(1)} m`] : [];
    });
    if (other.length) throw new Error(`${other.length} of ${tracks.length} tracks run at a clearly different height than the longest one (${other.join(', ')} along the shared stretch): `
      + 'they are different levels and are not merged into one. Make one corridor per level; if they are the same floor, the runs disagree in height, so pick the tracks of one run or use zSource "terrain"');
  }
  if (centres.length < 2) throw new Error(o.zSource === 'run' ? 'Not enough stations with a height; the tracks may have no absolute height (try zSource "terrain")' : 'Not enough stations inside the terrain');
  if (centres.length < count) warnings.push(`${count - centres.length} of ${count} stations had no usable track point or height and were skipped`);

  // moving average (ends kept), then 3D simplification
  const w = Math.max(1, Math.floor(o.smoothWindow / 2));
  const smooth = centres.map((c, i) => {
    if (i === 0 || i === centres.length - 1) return c;
    const lo = Math.max(0, i - w), hi = Math.min(centres.length - 1, i + w), n = hi - lo + 1;
    let x = 0, y = 0, z = 0;
    for (let j = lo; j <= hi; j++) { x += centres[j][0]; y += centres[j][1]; z += centres[j][2]; }
    return [x / n, y / n, z / n] as XYZ;
  });
  const coordinates = simplify3D(smooth, o.simplifyM).map((c) => c.map((v) => Math.round(v * 100) / 100) as XYZ);

  let widthM: number | null = null;
  if (spreads.length >= Math.max(3, count * 0.2)) widthM = Math.round(Math.min(o.maxWidthM, Math.max(o.minWidthM, percentile(spreads, 0.8) + o.widthMarginM)) * 10) / 10;
  else warnings.push(tracks.length < 2 ? 'Only one track: width cannot be estimated' : 'Tracks overlap too little to estimate the width');
  if (o.zSource === 'run') warnings.push(`Heights are track heights minus ${o.phoneHeightM} m (assumed phone height); check against the floor`);
  return { coordinates, widthM, stations: count, coverage: Math.round((covered / count) * 100) / 100, usedTracks: tracks.length, reversedTracks, zSource: o.zSource, warnings };
}

/** Is `a` the same road as `b` in 3D (either direction)? Plan shape is assumed close already; compares heights. */
export function sameRoad3D(a: XYZ[], b: XYZ[], toleranceM = 0.3): boolean {
  const plan = (c: XYZ[]) => c.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - c[i][0], p[1] - c[i][1]), 0);
  const zr = (c: XYZ[]) => [Math.min(...c.map((p) => p[2])), Math.max(...c.map((p) => p[2]))];
  const [amin, amax] = zr(a), [bmin, bmax] = zr(b);
  if (Math.abs(amin - bmin) > toleranceM || Math.abs(amax - bmax) > toleranceM) return false;
  if (plan(a) < 0.3 || plan(b) < 0.3) return true; // vertical (elevator): same shaft and same height range
  // every vertex of each line must sit on the other at the same height
  const onOther = (src: XYZ[], dst: XYZ[]) => src.every((p) => {
    let best = Infinity, bz = 0;
    for (let i = 1; i < dst.length; i++) {
      const s = dst[i - 1], e = dst[i], dx = e[0] - s[0], dy = e[1] - s[1], l2 = dx * dx + dy * dy;
      const f = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / l2)) : 0;
      const d = Math.hypot(p[0] - s[0] - dx * f, p[1] - s[1] - dy * f);
      if (d < best) { best = d; bz = s[2] + (e[2] - s[2]) * f; }
    }
    return Math.abs(p[2] - bz) <= toleranceM;
  });
  return onOther(a, b) && onOther(b, a);
}
