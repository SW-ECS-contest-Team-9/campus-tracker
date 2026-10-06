// Planar geometry in the campus frame (meters): polylines, projection, DTW. Pure functions.
import type { CampusPoint } from '../../geo/campus-frame.js';

export interface Projection {
  /** distance from the point to the polyline */
  d: number;
  /** signed lateral offset: + = left of the polyline direction */
  lateral: number;
  /** arc length of the foot point along the polyline */
  s: number;
  segment: number;
  x: number;
  y: number;
}

export function cumulativeLength(line: CampusPoint[]): number[] {
  const s = [0];
  for (let i = 1; i < line.length; i++) s.push(s[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y));
  return s;
}

function projectOnSegment(p: CampusPoint, a: CampusPoint, b: CampusPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const f = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  const x = a.x + f * dx;
  const y = a.y + f * dy;
  const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
  const d = Math.hypot(p.x - x, p.y - y);
  return { f, x, y, d, lateral: cross >= 0 ? d : -d };
}

/** Nearest point on a polyline (optionally restricted to segments [from, to]). */
export function project(p: CampusPoint, line: CampusPoint[], cum = cumulativeLength(line), from = 0, to = line.length - 2): Projection {
  let best: Projection = { d: Infinity, lateral: 0, s: 0, segment: 0, x: line[0].x, y: line[0].y };
  if (line.length === 1) return { d: Math.hypot(p.x - line[0].x, p.y - line[0].y), lateral: 0, s: 0, segment: 0, x: line[0].x, y: line[0].y };
  for (let i = Math.max(0, from); i <= Math.min(to, line.length - 2); i++) {
    const r = projectOnSegment(p, line[i], line[i + 1]);
    if (r.d < best.d) best = { d: r.d, lateral: r.lateral, s: cum[i] + r.f * (cum[i + 1] - cum[i]), segment: i, x: r.x, y: r.y };
  }
  return best;
}

/**
 * Projects a sequence of points onto a polyline keeping the order (no jumping back across a loop): each point
 * searches segments near the previous foot point (from `backM` behind to `aheadM` ahead).
 */
export function projectMonotone(points: CampusPoint[], line: CampusPoint[], opts: { backM?: number; aheadM?: number } = {}): Projection[] {
  const cum = cumulativeLength(line);
  const back = opts.backM ?? 10;
  const ahead = opts.aheadM ?? 40;
  const segAt = (s: number) => {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < s) i++;
    return i;
  };
  const out: Projection[] = [];
  let prev: Projection | null = null;
  for (const p of points) {
    const r: Projection = prev === null ? project(p, line, cum) : project(p, line, cum, segAt(prev.s - back), segAt(prev.s + ahead));
    out.push(r);
    prev = r;
  }
  return out;
}

/**
 * Unit normal pointing left of the direction at each vertex, from the chord over ±halfWindow vertices: on a
 * densely sampled noisy line, neighbor-to-neighbor directions swing wildly and would mix along-track offsets in.
 */
export function normals(line: CampusPoint[], halfWindow = 1): CampusPoint[] {
  return line.map((_, i) => {
    const a = line[Math.max(0, i - halfWindow)];
    const b = line[Math.min(line.length - 1, i + halfWindow)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: -dy / l, y: dx / l };
  });
}

/**
 * Dynamic time warping of two point sequences with a Sakoe-Chiba band (fraction of the longer length, at least
 * the length difference). Returns the mean matched distance (cost / path length).
 */
export function dtwMeanDistance(a: CampusPoint[], b: CampusPoint[], bandFraction = 0.15): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return Infinity;
  const band = Math.max(Math.ceil(bandFraction * Math.max(n, m)), Math.abs(n - m) + 1);
  const INF = Infinity;
  let prev = new Float64Array(m + 1).fill(INF);
  let prevLen = new Float64Array(m + 1).fill(0);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1).fill(INF);
    const curLen = new Float64Array(m + 1).fill(0);
    const center = Math.round((i * m) / n);
    for (let j = Math.max(1, center - band); j <= Math.min(m, center + band); j++) {
      const d = Math.hypot(a[i - 1].x - b[j - 1].x, a[i - 1].y - b[j - 1].y);
      // predecessors: (i-1, j-1), (i-1, j), (i, j-1)
      let best = prev[j - 1];
      let len = prevLen[j - 1];
      if (prev[j] < best) { best = prev[j]; len = prevLen[j]; }
      if (cur[j - 1] < best) { best = cur[j - 1]; len = curLen[j - 1]; }
      if (best === INF) continue;
      cur[j] = best + d;
      curLen[j] = len + 1;
    }
    prev = cur;
    prevLen = curLen;
  }
  return prev[m] === INF ? Infinity : prev[m] / prevLen[m];
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/** Robust standard deviation: 1.4826 x median absolute deviation. */
export function robustSigma(values: number[], center = median(values)): number | null {
  if (values.length < 2 || center === null) return null;
  return 1.4826 * median(values.map((v) => Math.abs(v - center)))!;
}

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
