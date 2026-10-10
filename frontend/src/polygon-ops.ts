// Polygon union / difference / intersection for the structures and the campus ground (structures.ts, campus-ground.ts).
// clipper-lib (Clipper 6) does the work on integer millimetres around a local origin, as in paved-surface.ts.
// Every vertex that comes back is a whole millimetre: the same point gets the same numbers in every result.
import ClipperLib from 'clipper-lib';

/** A ring in metres (or any plane units), not closed. */
export type Ring = number[][];
/** One polygon: the outer ring first, then its holes. */
export type Polygon = Ring[];

type IPath = { X: number; Y: number }[];
const MM = 1000;
const NONZERO = ClipperLib.PolyFillType.pftNonZero;

/** Twice the signed area of a ring (> 0: counter-clockwise). */
export const ringArea2 = (ring: Ring) => ring.reduce((s, p, i) => s + p[0] * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * p[1], 0);

/** Area of a polygon (its holes left out). Measured from its first point: the coordinates are in the hundreds of thousands. */
export function polygonArea(polygon: Polygon): number {
  const o = polygon[0]?.[0];
  if (!o) return 0;
  const ring = (r: Ring) => Math.abs(ringArea2(r.map((q) => [q[0] - o[0], q[1] - o[1]]))) / 2;
  return ring(polygon[0]) - polygon.slice(1).reduce((sum, h) => sum + ring(h), 0);
}

export function ringContains(x: number, y: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Inside the outer ring and in none of the holes. */
export const polygonContains = (x: number, y: number, polygon: Polygon) => polygon.reduce((n, ring) => n + (ringContains(x, y, ring) ? 1 : 0), 0) % 2 === 1;

/**
 * `a` united (`union`), `a` without `b` (`minus`), or what `a` and `b` share (`both`). The rings of the input may run
 * either way round; overlapping polygons of one side count as their union. Result: outer rings counter-clockwise,
 * holes clockwise, points on a straight edge kept.
 */
export function polygonOps(op: 'union' | 'minus' | 'both', a: Polygon[], b: Polygon[] = []): Polygon[] {
  const first = a[0]?.[0]?.[0] ?? b[0]?.[0]?.[0];
  if (!first || !a.length) return [];
  if (op === 'both' && !b.length) return [];
  const ox = Math.floor(first[0]), oy = Math.floor(first[1]);
  const path = (ring: Ring): IPath => ring.map(([x, y]) => ({ X: Math.round((x - ox) * MM), Y: Math.round((y - oy) * MM) }));
  // each polygon on its own first (outer and holes by even-odd), so that the directions of its rings do not matter
  const shape = (polygons: Polygon[]): IPath[] => polygons.flatMap((polygon) => {
    const c = new ClipperLib.Clipper();
    c.PreserveCollinear = true;
    c.AddPaths(polygon.filter((r) => r.length >= 3).map(path), ClipperLib.PolyType.ptSubject, true);
    const out = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
    return out as IPath[];
  });
  const c = new ClipperLib.Clipper();
  c.PreserveCollinear = true;
  c.AddPaths(shape(a), ClipperLib.PolyType.ptSubject, true);
  const other = shape(b);
  if (other.length) c.AddPaths(other, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  const type = op === 'union' ? ClipperLib.ClipType.ctUnion : op === 'minus' ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctIntersection;
  c.Execute(type, tree, NONZERO, NONZERO);
  const ring = (p: IPath): Ring => p.map(({ X, Y }) => [X / MM + ox, Y / MM + oy]);
  const ccw = (r: Ring, want: boolean) => (ringArea2(r) > 0 === want ? r : [...r].reverse());
  return (ClipperLib.JS.PolyTreeToExPolygons(tree) as { outer: IPath; holes: IPath[] }[])
    .filter((p) => p.outer.length >= 3)
    .map((p) => [ccw(ring(p.outer), true), ...p.holes.filter((h) => h.length >= 3).map((h) => ccw(ring(h), false))]);
}

/** The polygons grown by `deltaM` (shrunk when negative), corners mitred. */
export function growPolygons(polygons: Polygon[], deltaM: number): Polygon[] {
  const clean = polygonOps('union', polygons);
  const first = clean[0]?.[0]?.[0];
  if (!first || deltaM === 0) return clean;
  const ox = Math.floor(first[0]), oy = Math.floor(first[1]);
  const co = new ClipperLib.ClipperOffset(2, 0.005 * MM);
  co.AddPaths(clean.flat().map((r) => r.map(([x, y]) => ({ X: Math.round((x - ox) * MM), Y: Math.round((y - oy) * MM) }))), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, deltaM * MM);
  // the offset rings do not overlap (outer rings and holes): read together by even-odd they are the grown polygons
  const rings = (out as IPath[]).filter((p) => p.length >= 3).map((p) => p.map(({ X, Y }) => [X / MM + ox, Y / MM + oy]));
  return rings.length ? polygonOps('union', [rings]) : [];
}
