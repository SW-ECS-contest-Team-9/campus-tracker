import { rasterizePolygon, type Grid } from './dem.js';

/** Copy a DEM and flatten polygon cell centers. Rings must be a validated EPSG:5186 polygon.
 * Does not change buildings/roads, add an exterior transition, or activate a terrain version.
 * Bilinear samples at the polygon edge may still include exterior cells.
 */
export function applyPlateau(
  grid: Grid, source: Float32Array, rings: [number, number][][], heightM: number,
): Float32Array {
  if (!Number.isFinite(heightM) || !Number.isFinite(Math.fround(heightM))) throw new Error('Invalid plateau height');
  if (source.length !== grid.width * grid.height) throw new Error('DEM dimensions do not match');
  if (!rings.length || rings.some((ring) => ring.length < 4 || ring.some((p) => !p.every(Number.isFinite)))) {
    throw new Error('Invalid plateau rings');
  }
  const mask = rasterizePolygon(grid, rings, 0);
  const heights = source.slice();
  for (let i = 0; i < heights.length; i++) if (mask[i]) heights[i] = heightM;
  return heights;
}
