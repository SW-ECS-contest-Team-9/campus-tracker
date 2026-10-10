import { rasterizePolygon, type Grid } from './dem.js';

/** A road centreline with its height profile: [x, y, z] in EPSG:5186 / metres, dense enough that z is linear between points. */
export interface CorridorLine { name: string; halfWidthM: number; points: [number, number, number][] }
export interface CorridorOptions {
  /** Flat strip added on each side of the carriageway (kerb, gutter, pavement at road level). */
  shoulderM: number;
  /** Outside the flat strip the burned height fades into the existing terrain over this distance (smoothstep). 0 = hard edge. */
  blendM: number;
}
/** The one place for the corridor settings. Shoulder = one cell of the 2 m campus grid: carriageway + 2 x 2 m matches the flat band
 * measured on the S-MAP mesh along the main road (V02: 10.5-13 m for a 7 m carriageway). A wider shoulder cut up to 15 m into the
 * retaining walls beside the road and did not bring the ground any closer to the road profile (T06). */
export const CORRIDOR_DEFAULTS: CorridorOptions = { shoulderM: 2, blendM: 4 };

/** Cells a step must leave alone. keep = never changed (building footprints, earlier plateaus);
 * noBlend = no fade there (a known wall or bank: the step stays at the edge of the flat part instead of being smeared). */
export interface CellMasks { keep?: Uint8Array; noBlend?: Uint8Array }

/** Share of the new height at distance d outside the flat part: 1 at d <= 0, smoothstep down to 0 at d >= blendM. */
export function blendWeight(d: number, blendM: number): number {
  if (d <= 0) return 1;
  if (!(blendM > 0) || d >= blendM) return 0;
  const t = 1 - d / blendM;
  return t * t * (3 - 2 * t);
}

/** Cell-centre mask of several polygons (rings[0] boundary, the rest holes). */
export function polygonsMask(grid: Grid, polygons: [number, number][][][]): Uint8Array {
  const mask = new Uint8Array(grid.width * grid.height);
  for (const rings of polygons) {
    const one = rasterizePolygon(grid, rings, 0);
    for (let i = 0; i < mask.length; i++) if (one[i]) mask[i] = 1;
  }
  return mask;
}

/** Copy a DEM and burn road corridors into it. A cell whose centre lies within halfWidthM + shoulderM of a centreline takes
 * the profile height at the nearest point of that centreline (flat across the width); farther out the height fades into the
 * source over blendM. Where corridors overlap, the one the cell lies deepest in wins (the earlier line on a tie).
 * Beyond a line end the last height continues as a round cap. Does not change buildings/roads or activate a terrain version.
 */
export function burnCorridors(
  grid: Grid, source: Float32Array, lines: CorridorLine[], opts: CorridorOptions = CORRIDOR_DEFAULTS, masks: CellMasks = {},
): Float32Array {
  const g = grid;
  const n = g.width * g.height;
  if (source.length !== n) throw new Error('DEM dimensions do not match');
  if (!(opts.shoulderM >= 0) || !(opts.blendM >= 0)) throw new Error('Invalid corridor options');
  if ([masks.keep, masks.noBlend].some((m) => m && m.length !== n)) throw new Error('Mask dimensions do not match');
  if (!lines.length) throw new Error('No corridor lines');
  for (const line of lines) {
    if (!(line.halfWidthM > 0) || !Array.isArray(line.points) || line.points.length < 2 ||
        line.points.some((p) => p.length !== 3 || !p.every(Number.isFinite) || !Number.isFinite(Math.fround(p[2])))) {
      throw new Error(`Invalid corridor line ${line.name}`);
    }
  }
  // per cell: distance outside the flat strip (negative inside) and the profile height of the corridor it belongs to
  const outside = new Float32Array(n).fill(Infinity);
  const target = new Float32Array(n);
  for (const line of lines) {
    const core = line.halfWidthM + opts.shoulderM;
    const reach = core + opts.blendM;
    for (let k = 0; k + 1 < line.points.length; k++) {
      const [ax, ay, az] = line.points[k];
      const [bx, by, bz] = line.points[k + 1];
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - g.originX) / g.resolution));
      const x1 = Math.min(g.width - 1, Math.ceil((Math.max(ax, bx) + reach - g.originX) / g.resolution));
      const y0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - g.originY) / g.resolution));
      const y1 = Math.min(g.height - 1, Math.ceil((Math.max(ay, by) + reach - g.originY) / g.resolution));
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          const x = g.originX + (ix + 0.5) * g.resolution;
          const y = g.originY + (iy + 0.5) * g.resolution;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0;
          const d = Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) - core;
          const i = iy * g.width + ix;
          if (d < outside[i] && d < opts.blendM) { outside[i] = d; target[i] = az + t * (bz - az); }
        }
      }
    }
  }
  const heights = source.slice();
  for (let i = 0; i < n; i++) {
    if (outside[i] === Infinity || masks.keep?.[i]) continue;
    if (outside[i] <= 0) heights[i] = target[i];
    else if (!masks.noBlend?.[i]) heights[i] = source[i] + (target[i] - source[i]) * blendWeight(outside[i], opts.blendM);
  }
  return heights;
}
