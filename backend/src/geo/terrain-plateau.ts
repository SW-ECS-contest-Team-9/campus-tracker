import { rasterizePolygon, type Grid } from './dem.js';
import { blendWeight, type CellMasks } from './terrain-corridor.js';

/** Edge treatment of a plateau. Without it only the cell centres inside the polygon change (hard edge).
 * marginM: cells up to this far outside the polygon are flattened too, so bilinear samples anywhere inside read the plateau height.
 * blendM: beyond the margin the plateau height fades into the source (smoothstep), so open ground gets no step.
 * keep / noBlend: see CellMasks. A wall is kept as a wall by listing it in noBlend (and buildings in keep).
 */
export interface PlateauEdge extends CellMasks { marginM?: number; blendM?: number }

/** Copy a DEM and flatten polygon cell centers. Rings must be a validated EPSG:5186 polygon.
 * Does not change buildings/roads or activate a terrain version.
 * Without edge: no exterior transition, and bilinear samples at the polygon edge may still include exterior cells.
 */
export function applyPlateau(
  grid: Grid, source: Float32Array, rings: [number, number][][], heightM: number, edge?: PlateauEdge,
): Float32Array {
  if (!Number.isFinite(heightM) || !Number.isFinite(Math.fround(heightM))) throw new Error('Invalid plateau height');
  if (source.length !== grid.width * grid.height) throw new Error('DEM dimensions do not match');
  if (!rings.length || rings.some((ring) => ring.length < 4 || ring.some((p) => !p.every(Number.isFinite)))) {
    throw new Error('Invalid plateau rings');
  }
  const mask = rasterizePolygon(grid, rings, 0);
  const heights = source.slice();
  if (!edge) {
    for (let i = 0; i < heights.length; i++) if (mask[i]) heights[i] = heightM;
    return heights;
  }
  const marginM = edge.marginM ?? 0, blendM = edge.blendM ?? 0;
  if (!(marginM >= 0) || !(blendM >= 0)) throw new Error('Invalid plateau edge');
  if ([edge.keep, edge.noBlend].some((m) => m && m.length !== heights.length)) throw new Error('Mask dimensions do not match');
  const g = grid;
  const near = rasterizePolygon(g, rings, marginM + blendM);
  const outsideDistance = (x: number, y: number) => {
    let best = Infinity;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j];
        const [bx, by] = ring[i];
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / Math.max((bx - ax) ** 2 + (by - ay) ** 2, 1e-9)));
        best = Math.min(best, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
      }
    }
    return best;
  };
  for (let i = 0; i < heights.length; i++) {
    if (!near[i] || edge.keep?.[i]) continue;
    if (mask[i]) { heights[i] = heightM; continue; }
    const d = outsideDistance(g.originX + ((i % g.width) + 0.5) * g.resolution, g.originY + (Math.floor(i / g.width) + 0.5) * g.resolution) - marginM;
    if (d <= 0) heights[i] = heightM;
    else if (!edge.noBlend?.[i]) heights[i] = source[i] + (heightM - source[i]) * blendWeight(d, blendM);
  }
  return heights;
}
