// Arc-length resampling (docs/MOBILITY_MAP_PLAN.md 4.6): walks at different speeds / sampling rates become
// stations every `ds` meters. Gaps (time or jump) split the track: stations are never interpolated across them,
// but the arc length keeps counting the straight gap so s stays comparable to the route length.
export interface TrackPoint {
  t: number;
  x: number;
  y: number;
  /** orthometric height (null: unknown) */
  h: number | null;
  sigmaH: number | null;
  /** true: h is only a relative (barometric) height of this track */
  hRelative?: boolean;
}

export interface Station {
  s: number;
  x: number;
  y: number;
  h: number | null;
  t: number;
  sigmaH: number | null;
  /** seconds spent within ±ds/2 of this station (stops collapse here) */
  dwellS: number;
  piece: number;
}

export interface ResampleOptions { ds: number; maxGapS: number; maxJumpM: number; maxSigmaM: number }
export const DEFAULT_RESAMPLE: ResampleOptions = { ds: 1, maxGapS: 10, maxJumpM: 15, maxSigmaM: 15 };

export interface ResampleResult {
  ds: number;
  stations: Station[];
  pieces: number;
  lengthM: number;
  /** input points not used, with the reason */
  excluded: { t: number; reason: 'HIGH_SIGMA' | 'NOT_FINITE' }[];
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerpN = (a: number | null, b: number | null, f: number) => (a === null || b === null ? (f < 0.5 ? a : b) : lerp(a, b, f));

export function resampleTrack(input: TrackPoint[], o: Partial<ResampleOptions> = {}): ResampleResult {
  const opts = { ...DEFAULT_RESAMPLE, ...o };
  const excluded: ResampleResult['excluded'] = [];
  const pts = input.filter((p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.t)) {
      excluded.push({ t: p.t, reason: 'NOT_FINITE' });
      return false;
    }
    if (p.sigmaH !== null && p.sigmaH > opts.maxSigmaM) {
      excluded.push({ t: p.t, reason: 'HIGH_SIGMA' });
      return false;
    }
    return true;
  });
  const stations: Station[] = [];
  if (!pts.length) return { ds: opts.ds, stations, pieces: 0, lengthM: 0, excluded };
  let piece = 0;
  let s = 0; // arc length at pts[i]
  let next = 0; // next station arc length
  const emit = (a: TrackPoint, b: TrackPoint, sa: number, sb: number) => {
    while (next <= sb + 1e-9) {
      const f = sb > sa ? (next - sa) / (sb - sa) : 0;
      stations.push({ s: next, x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), h: lerpN(a.h, b.h, f), t: lerp(a.t, b.t, f), sigmaH: lerpN(a.sigmaH, b.sigmaH, f), dwellS: 0, piece });
      next += opts.ds;
    }
  };
  emit(pts[0], pts[0], 0, 0);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if ((b.t - a.t) / 1000 > opts.maxGapS || len > opts.maxJumpM) {
      // gap: keep counting the arc length; the new piece starts with a station on b itself (no interpolation)
      s += len;
      piece++;
      stations.push({ s, x: b.x, y: b.y, h: b.h, t: b.t, sigmaH: b.sigmaH, dwellS: 0, piece });
      next = s + opts.ds;
      continue;
    }
    emit(a, b, s, s + len);
    s += len;
  }
  // dwell: time spent near each station (points binned by their arc length)
  let k = 0;
  let sp = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) sp += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    while (k + 1 < stations.length && stations[k + 1].s <= sp + opts.ds / 2) k++;
    if (i > 0) stations[k].dwellS += Math.max(0, (pts[i].t - pts[i - 1].t) / 1000);
  }
  return { ds: opts.ds, stations, pieces: piece + 1, lengthM: s, excluded };
}

/** The same stations walked the other way: order reversed, arc length measured from the new start. */
export function reverseStations(stations: Station[]): Station[] {
  if (!stations.length) return [];
  const end = stations.at(-1)!.s;
  return [...stations].reverse().map((st) => ({ ...st, s: end - st.s }));
}

/** Uniform 1 m (ds) resampling of a plain polyline (used to re-resample a canonical path between iterations). */
export function resamplePolyline<T extends { x: number; y: number }>(line: T[], ds: number): { x: number; y: number; s: number }[] {
  const out: { x: number; y: number; s: number }[] = [];
  if (!line.length) return out;
  let s = 0;
  let next = 0;
  out.push({ x: line[0].x, y: line[0].y, s: 0 });
  next = ds;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    while (next <= s + len + 1e-9 && len > 0) {
      const f = (next - s) / len;
      out.push({ x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), s: next });
      next += ds;
    }
    s += len;
  }
  const last = line.at(-1)!;
  if (s - out.at(-1)!.s > ds * 0.25) out.push({ x: last.x, y: last.y, s });
  return out;
}
