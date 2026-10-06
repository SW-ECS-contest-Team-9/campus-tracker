// Pass extraction and direction (docs/MOBILITY_MAP_PLAN.md 4.7): a route is defined by its two ends A and B;
// every time a track goes from A to B (or back) that stretch is one pass.
import type { CampusPoint } from '../../geo/campus-frame.js';
import type { TrackPoint } from './resample.js';

export interface RouteEnds { a: CampusPoint; b: CampusPoint; radiusM: number }
export interface PassWindow { tStart: number; tEnd: number; direction: 'AB' | 'BA'; startDistanceM: number; endDistanceM: number }

interface Visit { end: 'A' | 'B'; t: number; d: number }

/**
 * Visits = consecutive points within radiusM of an end (the closest moment of each visit is kept).
 * Two consecutive visits of different ends give a pass between their closest moments.
 */
export function extractPasses(points: TrackPoint[], route: RouteEnds): PassWindow[] {
  const visits: Visit[] = [];
  let cur: Visit | null = null;
  for (const p of points) {
    const dA = Math.hypot(p.x - route.a.x, p.y - route.a.y);
    const dB = Math.hypot(p.x - route.b.x, p.y - route.b.y);
    const end: 'A' | 'B' | null = dA <= route.radiusM && dA <= dB ? 'A' : dB <= route.radiusM ? 'B' : null;
    const d = end === 'A' ? dA : dB;
    if (end && cur && cur.end === end) {
      if (d < cur.d) cur = { end, t: p.t, d };
      continue;
    }
    if (cur) visits.push(cur);
    cur = end ? { end, t: p.t, d } : null;
  }
  if (cur) visits.push(cur);
  // merge repeated visits of the same end (wandering at A): keep the LAST closest moment before leaving
  const merged: Visit[] = [];
  for (const v of visits) {
    const last = merged.at(-1);
    if (last && last.end === v.end) merged[merged.length - 1] = v;
    else merged.push(v);
  }
  const passes: PassWindow[] = [];
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1];
    const b = merged[i];
    passes.push({ tStart: a.t, tEnd: b.t, direction: a.end === 'A' ? 'AB' : 'BA', startDistanceM: a.d, endDistanceM: b.d });
  }
  return passes;
}
