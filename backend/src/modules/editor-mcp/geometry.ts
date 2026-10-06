// Small pure geometry helpers shared by the MCP tools (EPSG:5186 meters).
import type { XYZ } from '../editor/topology.js';

export type XY = readonly [number, number, ...number[]];

/** Tool outputs carry centimeters; exact stored coordinates never round-trip through the model. */
export const round2 = (v: number) => Math.round(v * 100) / 100;
export const roundXYZ = (p: XYZ): XYZ => [round2(p[0]), round2(p[1]), round2(p[2])];

export const dist2 = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function lineLength(points: XY[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist2(points[i - 1], points[i]);
  return total;
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const f = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * f), p[1] - (a[1] + dy * f));
}

/** Douglas–Peucker in the XY plane; returns the indices that are kept (always the first and last). */
export function simplifyIndices(points: XY[], toleranceM: number): number[] {
  if (points.length <= 2 || toleranceM <= 0) return points.map((_, i) => i);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    let worst = 0, index = -1;
    for (let i = from + 1; i < to; i++) {
      const d = segmentDistance(points[i], points[from], points[to]);
      if (d > worst) { worst = d; index = i; }
    }
    if (index >= 0 && worst > toleranceM) { keep[index] = 1; stack.push([from, index], [index, to]); }
  }
  return points.flatMap((_, i) => (keep[i] ? [i] : []));
}

/** Smallest XY distance between two polylines' segments, with the point on `a` where it occurs. */
export function pointToLine(p: XY, line: XY[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, segmentDistance(p, line[i - 1], line[i]));
  return line.length === 1 ? dist2(p, line[0]) : best;
}
