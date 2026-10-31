// Heights of the server terrain grid between its cell centres (bilinear), and the cells under the platforms.
import type { TerrainGrid } from './api';
import { polygonContains, type Polygon } from './polygon-ops';

/**
 * Bilinear height at an EPSG:5186 point; outside the grid the nearest edge value (no cliff at the border).
 * `hide` (TP2): cells (row-major, like `heights`) that are not interpolated from while one of the four cells around
 * the point is not hidden: the cells under the platforms. A platform is drawn with vertical sides and the terrain is
 * not drawn inside it, but its cells carry its top, so between a platform cell and the ground cell next to it the
 * plain interpolation is a 2 m slope that climbs the wall from outside (saw teeth along the foot of a retaining wall).
 * With `hide` the ground beside a platform has the height of its own cells up to the wall; the grid is unchanged
 * (inside a platform its cells are still its top: the height datum of the server).
 */
export function sampler(g: TerrainGrid, hide?: Uint8Array) {
  return (x: number, y: number): number => {
    let fx = (x - g.originX) / g.resolution - 0.5;
    let fy = (y - g.originY) / g.resolution - 0.5;
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return g.heights[0];
    fx = Math.min(Math.max(fx, 0), g.width - 1.001);
    fy = Math.min(Math.max(fy, 0), g.height - 1.001);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const k = [iy * g.width + ix, iy * g.width + ix + 1, (iy + 1) * g.width + ix, (iy + 1) * g.width + ix + 1];
    const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
    if (hide && k.some((c) => hide[c]) && k.some((c) => !hide[c])) {
      let sum = 0, h = 0;
      for (let n = 0; n < 4; n++) if (!hide[k[n]]) { sum += w[n]; h += w[n] * g.heights[k[n]]; }
      if (sum > 1e-9) return h / sum; // else the point lies on a line of hidden cell centres: as without hide
    }
    return g.heights[k[0]] * w[0] + g.heights[k[1]] * w[1] + g.heights[k[2]] * w[2] + g.heights[k[3]] * w[3];
  };
}

/** Cells of the grid whose centre lies in one of the polygons (EPSG:5186 m), row-major; null when there are none. */
export function cellsInside(g: TerrainGrid, polygons: Polygon[]): Uint8Array | null {
  const cells = new Uint8Array(g.width * g.height);
  let any = false;
  for (const polygon of polygons) {
    const ring = polygon[0];
    if (!ring?.length) continue;
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - g.originX) / g.resolution - 0.5));
    const i1 = Math.min(g.width - 1, Math.ceil((Math.max(...xs) - g.originX) / g.resolution - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - g.originY) / g.resolution - 0.5));
    const j1 = Math.min(g.height - 1, Math.ceil((Math.max(...ys) - g.originY) / g.resolution - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (cells[j * g.width + i]) continue;
      if (polygonContains(g.originX + (i + 0.5) * g.resolution, g.originY + (j + 0.5) * g.resolution, polygon)) { cells[j * g.width + i] = 1; any = true; }
    }
  }
  return any ? cells : null;
}
