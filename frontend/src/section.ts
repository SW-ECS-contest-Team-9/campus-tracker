// Cross-section (단면도) of the preview map: a vertical plane through two points A, B. One side is hidden, the other
// kept, and the cut face is drawn with the ground profile and what crosses it.
// This file is the geometry in EPSG:5186 metres (pure functions, tested in test/section.test.ts);
// section-layer.ts applies it to the Cesium scene.
import { tmForward, tmInverse } from './tm';

export type XY = [number, number];
/** `u`: unit direction A→B. `n`: unit normal pointing to the kept side. `length`: |AB|. */
export type SectionPlane = { a: XY; b: XY; u: XY; n: XY; length: number };

/** Plane through A and B. Kept side = left of A→B, or right with `flip`. */
export function sectionPlane(a: XY, b: XY, flip = false): SectionPlane {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u: XY = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const s = flip ? -1 : 1;
  return { a, b, u, n: [-u[1] * s, u[0] * s], length };
}

/** Signed distance from the plane: > 0 kept side, < 0 hidden side. */
export const planeSide = (plane: SectionPlane, p: number[]) => (p[0] - plane.a[0]) * plane.n[0] + (p[1] - plane.a[1]) * plane.n[1];
/** Distance along A→B of the foot of p on the section line (0 at A, `length` at B). */
export const planeAlong = (plane: SectionPlane, p: number[]) => (p[0] - plane.a[0]) * plane.u[0] + (p[1] - plane.a[1]) * plane.u[1];
/** Point on the section line at distance d from A, moved `off` metres towards the kept side. */
export const planePoint = (plane: SectionPlane, d: number, off = 0): XY => [plane.a[0] + plane.u[0] * d + plane.n[0] * off, plane.a[1] + plane.u[1] * d + plane.n[1] * off];

/** Point where p-q meets the plane; every number of the points (x, y, height, ...) is interpolated. */
function cut(plane: SectionPlane, p: number[], q: number[]): number[] {
  const sp = planeSide(plane, p), sq = planeSide(plane, q);
  const t = sp / (sp - sq);
  return p.map((v, i) => v + (q[i] - v) * t);
}

/** The parts of a polyline on the kept side (a point on the plane counts as kept). Cut points are interpolated. */
export function clipPolyline(plane: SectionPlane, points: number[][]): number[][][] {
  const pieces: number[][][] = [];
  let piece: number[][] = [];
  points.forEach((p, i) => {
    const keep = planeSide(plane, p) >= 0;
    if (i > 0 && keep !== planeSide(plane, points[i - 1]) >= 0) piece.push(cut(plane, points[i - 1], p));
    if (keep) piece.push(p);
    else if (piece.length) { if (piece.length > 1) pieces.push(piece); piece = []; }
  });
  if (piece.length > 1) pieces.push(piece);
  return pieces;
}

/**
 * The part of a polygon ring (not closed) on the kept side; [] when nothing is left. A ring that the plane cuts into
 * several parts comes back as one ring joined along the cut line (zero-width bridges, which fill as nothing).
 */
export function clipRing(plane: SectionPlane, ring: number[][]): number[][] {
  const out: number[][] = [];
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    const kp = planeSide(plane, p) >= 0, kq = planeSide(plane, q) >= 0;
    if (kp) out.push(p);
    if (kp !== kq) out.push(cut(plane, p, q));
  });
  return out.length >= 3 ? out : [];
}

export type Mesh = { positions: number[]; indices: number[] };
/** Triangles (x, y, z) cut at the plane: only the kept part remains. */
export function clipMesh(plane: SectionPlane, mesh: Mesh): Mesh {
  const out: Mesh = { positions: [], indices: [] };
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = [0, 1, 2].map((k) => { const j = mesh.indices[i + k] * 3; return [mesh.positions[j], mesh.positions[j + 1], mesh.positions[j + 2]]; });
    const kept = clipRing(plane, tri);
    for (let k = 1; k + 1 < kept.length; k++) {
      for (const p of [kept[0], kept[k], kept[k + 1]]) {
        out.indices.push(out.positions.length / 3);
        out.positions.push(p[0], p[1], p[2]);
      }
    }
  }
  return out;
}

/** WGS84 polygons ([lon, lat] rings, closed, first ring outer) cut at the plane. Polygons with nothing left are dropped. */
export function clipLonLatPolygons(plane: SectionPlane, polygons: number[][][][]): number[][][][] {
  const clip = (ring: number[][]) => {
    const kept = clipRing(plane, ring.slice(0, -1).map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; }));
    const back = kept.map(([x, y]) => { const g = tmInverse(x, y); return [g.longitude, g.latitude]; });
    return back.length ? [...back, back[0]] : back;
  };
  return polygons.flatMap((poly) => {
    const outer = clip(poly[0]);
    return outer.length ? [[outer, ...poly.slice(1).map(clip).filter((r) => r.length)]] : [];
  });
}

/** Ground height along the section line from A to B: a sample every `stepM` (the last step is shorter), both ends included. */
export function terrainProfile(height: (x: number, y: number) => number, plane: SectionPlane, stepM = 1): { d: number; z: number }[] {
  const n = Math.max(1, Math.ceil(plane.length / stepM - 1e-9));
  return Array.from({ length: n + 1 }, (_, i) => {
    const d = i === n ? plane.length : i * stepM;
    const [x, y] = planePoint(plane, d);
    return { d, z: height(x, y) };
  });
}

/** Height of a profile at distance d (linear between samples, the end values outside). */
export function profileHeight(profile: { d: number; z: number }[], d: number): number {
  if (d <= profile[0].d) return profile[0].z;
  for (let i = 1; i < profile.length; i++) {
    if (d <= profile[i].d) return profile[i - 1].z + ((profile[i].z - profile[i - 1].z) * (d - profile[i - 1].d)) / (profile[i].d - profile[i - 1].d);
  }
  return profile[profile.length - 1].z;
}

/**
 * Where a polyline crosses the section line between A and B: distance from A and the interpolated third coordinate
 * (stored height) when the points have one.
 */
export function lineCrossings(plane: SectionPlane, points: number[][], closed = false): { d: number; z: number | undefined }[] {
  const hits: { d: number; z: number | undefined }[] = [];
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    if (planeSide(plane, p) >= 0 === planeSide(plane, q) >= 0) continue;
    const x = cut(plane, p, q);
    const d = planeAlong(plane, x);
    if (d >= 0 && d <= plane.length) hits.push({ d, z: x[2] });
  }
  return hits;
}

/** The stretches [from, to] (distance from A, within A..B) of the section line that lie inside a polygon ring (not closed). */
export function ringIntervals(plane: SectionPlane, ring: number[][]): [number, number][] {
  const whole: SectionPlane = { ...plane, a: planePoint(plane, -1e7), length: 2e7 + plane.length };
  const ds = lineCrossings(whole, ring, true).map((h) => h.d - 1e7).sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ds.length; i += 2) {
    const from = Math.max(0, ds[i]), to = Math.min(plane.length, ds[i + 1]);
    if (to > from) out.push([from, to]);
  }
  return out;
}

/** A and B moved outwards along their line to the edges of a box (the whole cut through the terrain grid). Null when the line misses the box. */
export function extendToBox(a: XY, b: XY, box: { minX: number; minY: number; maxX: number; maxY: number }): { a: XY; b: XY } | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = -Infinity, t1 = Infinity;
  for (const [p, d, lo, hi] of [[a[0], dx, box.minX, box.maxX], [a[1], dy, box.minY, box.maxY]]) {
    if (Math.abs(d) < 1e-12) { if (p < lo || p > hi) return null; continue; }
    t0 = Math.max(t0, Math.min((lo - p) / d, (hi - p) / d));
    t1 = Math.min(t1, Math.max((lo - p) / d, (hi - p) / d));
  }
  return t1 > t0 ? { a: [a[0] + dx * t0, a[1] + dy * t0], b: [a[0] + dx * t1, a[1] + dy * t1] } : null;
}

/** Round heights for the scale on the cut face: every 5 m up to a 60 m range, else every 10 m. */
export function heightTicks(minM: number, maxM: number): number[] {
  const step = maxM - minM <= 60 ? 5 : 10;
  const ticks: number[] = [];
  for (let z = Math.ceil(minM / step) * step; z <= maxM + 1e-9; z += step) ticks.push(z);
  return ticks;
}
