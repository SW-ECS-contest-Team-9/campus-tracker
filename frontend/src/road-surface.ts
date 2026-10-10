// Carriageways (editor road segments, road_class vehicle / shared) on the preview map as dark asphalt surfaces:
// a smoothed centreline widened to the road width. Read-only (GET /api/v1/mobility/roads).
// Surface roads are laid on the map's ground, not at their stored height: stored road heights and the terrain model
// differ by several metres in places (2026-10-10 test data: -3 m ... +12 m), so a surface at the stored height would be
// buried or float. Underground roads are drawn at their stored height and only with their own toggle.
// The editor page keeps its own scheme (colour = floor, line shape = road type); this is only the preview.
// This file is the geometry in EPSG:5186 metres (pure functions, tested in test/road-surface.test.ts);
// road-surface-layer.ts draws it with Cesium.
import type { CarriagewayRoad } from './api';
import { floorFromLevelId } from './floor-colors';

export type P3 = [number, number, number];

/** Every display constant of the carriageway surface. Widths are display defaults, not measurements. */
export const ROAD_SURFACE = {
  /** Used when a road has no width_m. vehicle: two 3.0 m lanes; shared: one lane with a walking margin (assumptions). */
  defaultWidthM: { vehicle: 6, shared: 4 } as Record<string, number>,
  /** The smoothed centreline stays within this distance of every stored vertex (end nodes are kept exactly). */
  smoothMaxDeviationM: 0.3,
  /** Spacing of the resampled centreline. */
  sampleStepM: 1,
  /** Aimed-at largest turn between two samples inside a rounded corner (keeps the outer edge round). */
  maxTurnPerSampleRad: Math.PI / 18,
  /** Near-black asphalt. Drawn unlit, so it reads as matte black from any direction. */
  color: '#1b1d20',
  /** Opacity of an underground road where the ground or a building is in front of it (underground toggle on). */
  undergroundHiddenAlpha: 0.45,
  discSegments: 24,
};

/**
 * Underground = the road's level is a basement floor (levelId "B1", "지하1" ...). Roads without a level fall back to
 * the word "지하" in their name, because the underground roads of 2026-10-10 carry no level yet (stopgap, see work log).
 */
export function isUnderground(road: { levelId: string | null; name: string | null }): boolean {
  const floor = floorFromLevelId(road.levelId);
  return floor != null ? floor < 0 : !road.levelId && /지하/.test(road.name ?? '');
}

export function roadWidthM(road: { widthM: number | null; roadClass: string }): number {
  return road.widthM ?? ROAD_SURFACE.defaultWidthM[road.roadClass] ?? ROAD_SURFACE.defaultWidthM.shared;
}

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const along = (a: P3, u: P3, d: number): P3 => [a[0] + u[0] * d, a[1] + u[1] * d, a[2] + u[2] * d];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);

/**
 * Rounds every corner of a 3D polyline with a quadratic curve and resamples it about every `step` metres.
 * First and last point are kept exactly; the curve passes within `maxDeviation` of each inner vertex;
 * height follows the same curve, so a ramp has no steps.
 */
export function smoothCentreline(points: number[][], maxDeviation = ROAD_SURFACE.smoothMaxDeviationM, step = ROAD_SURFACE.sampleStepM): P3[] {
  const pts = points.map((p) => [p[0], p[1], p[2] ?? 0] as P3).filter((p, i, all) => i === 0 || len(sub(p, all[i - 1])) > 1e-6);
  if (pts.length < 2) return pts;
  const out: P3[] = [pts[0]];
  const lineTo = (q: P3) => {
    const from = out[out.length - 1];
    const d = len(sub(q, from));
    if (d < 1e-9) return;
    const n = Math.ceil(d / step);
    for (let k = 1; k <= n; k++) out.push(k === n ? q : along(from, sub(q, from), k / n));
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const inLen = len(sub(p, pts[i - 1]));
    const outLen = len(sub(pts[i + 1], p));
    const u1 = along([0, 0, 0], sub(p, pts[i - 1]), 1 / inLen);
    const u2 = along([0, 0, 0], sub(pts[i + 1], p), 1 / outLen);
    const s = len(sub(u2, u1)) / 2; // sin(turn / 2)
    if (s < 1e-6) { lineTo(p); continue; }
    // curve from p - d*u1 to p + d*u2 with p as control point: its farthest distance from p is d * s / 2
    const d = Math.min(inLen / 2, outLen / 2, (2 * maxDeviation) / s);
    const a = along(p, u1, -d);
    const b = along(p, u2, d);
    lineTo(a);
    // twice the even share of the turn: the curve turns fastest in its middle
    const n = Math.max(2, Math.ceil((2 * d) / step), Math.ceil((4 * Math.asin(Math.min(1, s))) / ROAD_SURFACE.maxTurnPerSampleRad));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push(k === n ? b : [0, 1, 2].map((c) => (1 - t) * (1 - t) * a[c] + 2 * t * (1 - t) * p[c] + t * t * b[c]) as P3);
    }
  }
  lineTo(pts[pts.length - 1]);
  return out;
}

/** Point where segment a-b crosses segment c-d in plan, or null. */
function crossing(a: P3, b: P3, c: P3, d: P3): [number, number] | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + rx * t, a[1] + ry * t] : null;
}

/**
 * Left and right edge of a road: each centre sample moved half the width sideways (horizontally), at the centre height.
 * On a bend tighter than half the width the inner edge would loop over itself; the loop is replaced by its crossing
 * point (the samples in between all sit on that point, so both edges keep one point per centre sample).
 */
export function ribbon(centre: P3[], widthM: number): { left: P3[]; right: P3[] } {
  const left: P3[] = [];
  const right: P3[] = [];
  let tx = 1, ty = 0;
  centre.forEach((p, i) => {
    const a = centre[Math.max(0, i - 1)];
    const b = centre[Math.min(centre.length - 1, i + 1)];
    const h = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (h > 1e-9) { tx = (b[0] - a[0]) / h; ty = (b[1] - a[1]) / h; }
    left.push([p[0] - (ty * widthM) / 2, p[1] + (tx * widthM) / 2, p[2]]);
    right.push([p[0] + (ty * widthM) / 2, p[1] - (tx * widthM) / 2, p[2]]);
  });
  // a loop is no longer than the bend itself plus the edge it swallows on both sides
  const reach = Math.ceil((3 * widthM) / ROAD_SURFACE.sampleStepM) + 40;
  for (const side of [left, right]) {
    for (let i = 0; i + 3 < side.length; i++) {
      for (let j = Math.min(side.length - 2, i + reach); j > i + 1; j--) {
        const x = crossing(side[i], side[i + 1], side[j], side[j + 1]);
        if (!x) continue;
        for (let k = i + 1; k <= j; k++) side[k] = [x[0], x[1], side[k][2]];
        i = j - 1;
        break;
      }
    }
  }
  return { left, right };
}

/**
 * Filled circle that closes the gap where carriageways meet at a node. It is tilted to follow the roads:
 * `arms` are points on each connected centreline near the node (least-squares plane, flat across a single road).
 * Returns the rim.
 */
export function junctionDisc(center: P3, radiusM: number, arms: P3[], segments = ROAD_SURFACE.discSegments): P3[] {
  let sxx = 1e-6, sxy = 0, syy = 1e-6, sxz = 0, syz = 0;
  for (const p of arms) {
    const [dx, dy, dz] = sub(p, center);
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxz += dx * dz; syz += dy * dz;
  }
  const det = sxx * syy - sxy * sxy;
  const gx = (sxz * syy - syz * sxy) / det;
  const gy = (syz * sxx - sxz * sxy) / det;
  return Array.from({ length: segments }, (_, k) => {
    const dx = radiusM * Math.cos((2 * Math.PI * k) / segments);
    const dy = radiusM * Math.sin((2 * Math.PI * k) / segments);
    return [center[0] + dx, center[1] + dy, center[2] + gx * dx + gy * dy] as P3;
  });
}

export type RoadMesh = { positions: number[]; indices: number[] };
type SurfaceRoad = Pick<CarriagewayRoad, 'name' | 'roadClass' | 'widthM' | 'levelId' | 'fromNodeId' | 'toNodeId'> & { geometry: { coordinates: number[][] } };

/** Road bands, and a filled circle at every node where two or more of these roads meet (a dead end keeps its square end). */
function shapes(roads: SurfaceRoad[]) {
  const bands: { left: P3[]; right: P3[] }[] = [];
  const nodes = new Map<string, { center: P3; radius: number; arms: P3[] }>();
  for (const road of roads) {
    const width = roadWidthM(road);
    const centre = smoothCentreline(road.geometry.coordinates);
    if (centre.length < 2) continue;
    bands.push(ribbon(centre, width));
    // the point about half a width along the road from each end tells the circle how the road slopes
    const arm = (line: P3[]) => line.find((p) => Math.hypot(p[0] - line[0][0], p[1] - line[0][1]) >= width / 2) ?? line[line.length - 1];
    for (const [id, line] of [[road.fromNodeId, centre], [road.toNodeId, [...centre].reverse()]] as const) {
      const n = nodes.get(id) ?? { center: line[0], radius: 0, arms: [] };
      n.radius = Math.max(n.radius, width / 2);
      n.arms.push(arm(line));
      nodes.set(id, n);
    }
  }
  const discs = [...nodes.values()].filter((n) => n.arms.length >= 2).map((n) => ({ center: n.center, rim: junctionDisc(n.center, n.radius, n.arms) }));
  return { bands, discs };
}

/**
 * All carriageway surfaces in EPSG:5186. `ground`: outlines (x, y rings, not closed) of the surface roads, to be laid
 * on the map's ground. `underground`: triangles (x, y, stored height) of the underground roads.
 */
export function buildRoadSurfaces(roads: SurfaceRoad[]): { ground: number[][][]; underground: RoadMesh } {
  const above = shapes(roads.filter((r) => !isUnderground(r)));
  const below = shapes(roads.filter(isUnderground));
  const ring = (points: P3[]) => points.map(([x, y]) => [x, y]).filter((p, i, all) => {
    const q = all[(i + all.length - 1) % all.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
  const ground = [...above.bands.map((b) => ring([...b.right, ...[...b.left].reverse()])), ...above.discs.map((d) => ring(d.rim))];
  const underground: RoadMesh = { positions: [], indices: [] };
  const triangle = (...corners: P3[]) => {
    for (const p of corners) {
      underground.indices.push(underground.positions.length / 3);
      underground.positions.push(...p);
    }
  };
  for (const { left, right } of below.bands) {
    for (let i = 0; i + 1 < left.length; i++) {
      triangle(left[i], right[i], left[i + 1]);
      triangle(right[i], right[i + 1], left[i + 1]);
    }
  }
  for (const d of below.discs) d.rim.forEach((p, k) => triangle(d.center, p, d.rim[(k + 1) % d.rim.length]));
  return { ground, underground };
}
