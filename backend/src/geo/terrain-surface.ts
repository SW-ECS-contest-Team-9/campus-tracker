import { rasterizePolygon, type Grid } from './dem.js';

/** A base plane of built ground: a polygon whose cells take either one height (a platform) or the height of a
 * longitudinal profile (a ramp: flat across, graded along `direction` from `origin`; points are [distance, height],
 * linear in between, constant beyond the ends). Built ground is made of planes that meet at wall faces, so a
 * surface step has hard edges only: no margin, no fade. */
export interface SurfacePatch {
  name: string;
  rings: [number, number][][];
  heightM?: number;
  profile?: { origin: [number, number]; direction: [number, number]; points: [number, number][] };
}

const finite32 = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Number.isFinite(Math.fround(v));

/** Patches of a GeoJSON Feature or FeatureCollection (EPSG:5186): Polygon with srid=5186, reason and heightM or profile. */
export function parseSurface(input: any): SurfacePatch[] {
  const features = input?.type === 'FeatureCollection' ? input.features : input?.type === 'Feature' ? [input] : null;
  if (!Array.isArray(features) || !features.length) throw new Error('Expected GeoJSON Feature or FeatureCollection of surface polygons');
  return features.map((f: any, k: number) => {
    const rings = f?.geometry?.type === 'Polygon' ? f.geometry.coordinates : null;
    const p = f?.properties ?? {};
    const pr = p.profile;
    const profileOk = pr !== undefined && [pr?.origin, pr?.direction].every((v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) &&
      Math.hypot(pr.direction[0], pr.direction[1]) > 0 && Array.isArray(pr.points) && pr.points.length >= 2 &&
      pr.points.every((q: any, i: number) => Array.isArray(q) && q.length === 2 && Number.isFinite(q[0]) && finite32(q[1]) && (i === 0 || q[0] > pr.points[i - 1][0]));
    if (!Array.isArray(rings) || !rings.length || rings.some((r: any) => !Array.isArray(r) || r.length < 4 || r.some((c: any) => !Array.isArray(c) || !c.slice(0, 2).every(Number.isFinite))) ||
        p.srid !== 5186 || typeof p.reason !== 'string' || !p.reason.trim() || (p.heightM === undefined) === (pr === undefined) ||
        (p.heightM !== undefined && !finite32(p.heightM)) || (pr !== undefined && !profileOk)) {
      throw new Error(`Surface polygon ${k + 1}: expected Polygon with srid=5186, reason and either heightM or profile`);
    }
    return { name: String(p.name ?? k + 1), rings: rings.map((r: number[][]) => r.map((c) => [c[0], c[1]] as [number, number])), heightM: p.heightM, profile: pr };
  });
}

/** Height of the patch plane at a point (the polygon is not checked). */
export function surfaceHeight(patch: SurfacePatch, x: number, y: number): number {
  if (patch.heightM !== undefined) return patch.heightM;
  const { origin, direction, points } = patch.profile!;
  const s = ((x - origin[0]) * direction[0] + (y - origin[1]) * direction[1]) / Math.hypot(direction[0], direction[1]);
  if (s <= points[0][0]) return points[0][1];
  for (let k = 1; k < points.length; k++) {
    if (s <= points[k][0]) return points[k - 1][1] + (points[k][1] - points[k - 1][1]) * (s - points[k - 1][0]) / (points[k][0] - points[k - 1][0]);
  }
  return points[points.length - 1][1];
}

/** Copy a DEM and set every cell whose centre lies in a patch polygon to that patch's plane (the later patch wins where
 * polygons overlap). Cells of `keep` (building footprints) are not changed. Nothing outside the polygons changes. */
export function applySurface(grid: Grid, source: Float32Array, patches: SurfacePatch[], keep?: Uint8Array): Float32Array {
  const n = grid.width * grid.height;
  if (source.length !== n) throw new Error('DEM dimensions do not match');
  if (keep && keep.length !== n) throw new Error('Mask dimensions do not match');
  if (!patches.length) throw new Error('No surface patches');
  const heights = source.slice();
  for (const patch of patches) {
    const mask = rasterizePolygon(grid, patch.rings, 0);
    for (let i = 0; i < n; i++) {
      if (!mask[i] || keep?.[i]) continue;
      heights[i] = surfaceHeight(patch, grid.originX + ((i % grid.width) + 0.5) * grid.resolution, grid.originY + (Math.floor(i / grid.width) + 0.5) * grid.resolution);
    }
  }
  return heights;
}
