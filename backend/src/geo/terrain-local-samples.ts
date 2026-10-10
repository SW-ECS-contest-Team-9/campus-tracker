import { bilinear, type Grid } from './dem.js';

export interface LocalSample { x: number; y: number; z: number }
export interface LocalSampleOptions {
  /** [Gaussian kernel m, cutoff radius m] per pass; same residual update as the spot passes of buildDem. */
  passes: [number, number][];
  /** Full correction up to supportM from the nearest used sample, smoothstep to zero at supportM + fadeM. */
  supportM: number;
  fadeM: number;
  /** A sample is used only if at least minNeighbours other samples lie within neighbourRadiusM. */
  minNeighbours: number;
  neighbourRadiusM: number;
}

/** Settings chosen in T01 (docs/audit/t01/results.json). Passes are E01 variant V2e. */
export const LOCAL_SAMPLE_DEFAULTS: LocalSampleOptions = {
  passes: [[6, 15], [3, 8], [2, 6], [2, 6]], supportM: 6, fadeM: 6, minNeighbours: 3, neighbourRadiusM: 6,
};

/** Copy a DEM and pull it towards dense ground samples (EPSG:5186) with narrow Gaussian residual passes.
 * Cells farther than supportM + fadeM (and the first pass radius) from every used sample keep the source value.
 * skipped = indices of samples dropped by the neighbour guard (a lone sample has nothing to check it against).
 * Does not change buildings/roads or activate a terrain version.
 */
export function applyLocalSamples(
  grid: Grid, source: Float32Array, samples: LocalSample[], opts: LocalSampleOptions = LOCAL_SAMPLE_DEFAULTS,
): { heights: Float32Array; skipped: number[] } {
  const g = grid;
  const n = g.width * g.height;
  if (source.length !== n) throw new Error('DEM dimensions do not match');
  if (!opts.passes.length || opts.passes.some((p) => !(p[0] > 0) || !(p[1] > 0)) || !(opts.supportM >= 0) || !(opts.fadeM >= 0) ||
      !(opts.minNeighbours >= 0) || !(opts.neighbourRadiusM >= 0)) throw new Error('Invalid local sample options');
  if (!samples.length) throw new Error('No samples');
  const skipped: number[] = [];
  let usable: (LocalSample & { r: number })[] = [];
  samples.forEach((s, i) => {
    const h = [s.x, s.y, s.z].every(Number.isFinite) ? bilinear(g, source, s.x, s.y) : null;
    if (h === null) throw new Error(`Sample ${i} is not finite or outside the grid`);
    let neighbours = 0;
    for (const o of samples) if (o !== s && (o.x - s.x) ** 2 + (o.y - s.y) ** 2 <= opts.neighbourRadiusM ** 2) neighbours++;
    if (neighbours < opts.minNeighbours) skipped.push(i);
    else usable.push({ ...s, r: s.z - h });
  });

  const heights = source.slice();
  const nearest = new Float32Array(n).fill(Infinity);
  for (const [kernel, radius] of opts.passes) {
    const k2 = 2 * kernel ** 2;
    const reach = Math.ceil(radius / g.resolution);
    const wsum = new Float32Array(n);
    const rsum = new Float32Array(n);
    for (const s of usable) {
      const cx = Math.floor((s.x - g.originX) / g.resolution);
      const cy = Math.floor((s.y - g.originY) / g.resolution);
      for (let iy = Math.max(0, cy - reach); iy <= Math.min(g.height - 1, cy + reach); iy++) {
        for (let ix = Math.max(0, cx - reach); ix <= Math.min(g.width - 1, cx + reach); ix++) {
          const dx = g.originX + (ix + 0.5) * g.resolution - s.x;
          const dy = g.originY + (iy + 0.5) * g.resolution - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > radius ** 2) continue;
          const w = Math.exp(-d2 / k2);
          const i = iy * g.width + ix;
          wsum[i] += w;
          rsum[i] += w * s.r;
          nearest[i] = Math.min(nearest[i], Math.sqrt(d2));
        }
      }
    }
    usable = usable.map((s) => {
      let w = 0, wr = 0;
      for (const o of usable) {
        const d2 = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
        if (d2 > radius ** 2) continue;
        const k = Math.exp(-d2 / k2);
        w += k;
        wr += k * o.r;
      }
      return { ...s, r: s.r - (w > 0 ? wr / (w + 0.3) : 0) };
    });
    for (let i = 0; i < n; i++) if (wsum[i] > 0) heights[i] += rsum[i] / (wsum[i] + 0.3);
  }
  for (let i = 0; i < n; i++) {
    if (heights[i] === source[i] || nearest[i] <= opts.supportM) continue;
    const t = opts.fadeM > 0 ? Math.max(0, 1 - (nearest[i] - opts.supportM) / opts.fadeM) : 0;
    heights[i] = source[i] + (heights[i] - source[i]) * t * t * (3 - 2 * t);
  }
  return { heights, skipped };
}

export interface LocalSampleGroup { area: string; source: string; collected: string; originalFile: string; count: number }

/** Validate a samples file ({ crs, reason, groups: [{ area, source, collected, originalFile, points: [x,y,z][] }] }).
 * areas keeps only the groups of those areas; an area that matches no group is an error.
 */
export function parseLocalSamples(input: any, areas?: string[]): { reason: string; samples: LocalSample[]; groups: LocalSampleGroup[] } {
  if (input?.crs !== 'EPSG:5186' || typeof input.reason !== 'string' || !input.reason.trim() || !Array.isArray(input.groups)) {
    throw new Error('Expected samples file with crs=EPSG:5186, reason and groups');
  }
  const missing = areas?.filter((a) => !input.groups.some((grp: any) => grp.area === a));
  if (missing?.length) throw new Error(`No sample group for area: ${missing.join(', ')}`);
  const samples: LocalSample[] = [];
  const groups: LocalSampleGroup[] = [];
  for (const grp of input.groups) {
    if (![grp?.area, grp?.source, grp?.collected, grp?.originalFile].every((v) => typeof v === 'string' && v) || !Array.isArray(grp.points) ||
        grp.points.some((p: unknown) => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite))) {
      throw new Error('Each group needs area, source, collected, originalFile and finite [x,y,z] points');
    }
    if (areas && !areas.includes(grp.area)) continue;
    for (const [x, y, z] of grp.points) samples.push({ x, y, z });
    groups.push({ area: grp.area, source: grp.source, collected: grp.collected, originalFile: grp.originalFile, count: grp.points.length });
  }
  if (!samples.length) throw new Error('No samples');
  return { reason: input.reason.trim(), samples, groups };
}

/** Join several samples files into one input for parseLocalSamples. A single file is returned as is, so candidate ids
 * made from that file alone (the id hashes the whole input) do not change when another file is added next to it.
 */
export function mergeLocalSampleInputs(inputs: any[]): any {
  if (!inputs.length) throw new Error('No samples file');
  if (inputs.length === 1) return inputs[0];
  if (inputs.some((f) => f?.crs !== 'EPSG:5186' || typeof f.reason !== 'string' || !Array.isArray(f.groups))) {
    throw new Error('Expected samples files with crs=EPSG:5186, reason and groups');
  }
  return { crs: 'EPSG:5186', reason: inputs.map((f) => f.reason.trim()).join(' + '), groups: inputs.flatMap((f) => f.groups) };
}

/** Preview numbers for a corrected grid: changed cells, area (m2) by |delta| bin, cells steeper than 45 degrees. */
export function changeStats(grid: Grid, before: Float32Array, after: Float32Array) {
  const g = grid;
  const steep = (h: Float32Array) => {
    let count = 0;
    for (let iy = 0; iy < g.height; iy++) {
      for (let ix = 0; ix < g.width; ix++) {
        const x0 = h[iy * g.width + Math.max(0, ix - 1)], x1 = h[iy * g.width + Math.min(g.width - 1, ix + 1)];
        const y0 = h[Math.max(0, iy - 1) * g.width + ix], y1 = h[Math.min(g.height - 1, iy + 1) * g.width + ix];
        if (Math.hypot((x1 - x0) / (2 * g.resolution), (y1 - y0) / (2 * g.resolution)) > 1) count++;
      }
    }
    return count;
  };
  const edges = [0, 0.1, 0.5, 1, 2, 5, Infinity];
  const cells = new Array<number>(edges.length - 1).fill(0);
  let changedCells = 0, minDelta = 0, maxDelta = 0;
  for (let i = 0; i < after.length; i++) {
    const delta = after[i] - before[i];
    if (delta === 0) continue;
    changedCells++;
    minDelta = Math.min(minDelta, delta); maxDelta = Math.max(maxDelta, delta);
    cells[edges.findIndex((e) => Math.abs(delta) <= e) - 1]++;
  }
  const areaM2ByAbsDelta = Object.fromEntries(cells.map((c, k) =>
    [Number.isFinite(edges[k + 1]) ? `${edges[k]}-${edges[k + 1]}m` : `>${edges[k]}m`, c * g.resolution ** 2]));
  return { changedCells, minDelta, maxDelta, areaM2ByAbsDelta, steepCellsBefore: steep(before), steepCellsAfter: steep(after) };
}
