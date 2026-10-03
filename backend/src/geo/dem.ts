// DEM from contour lines + spot heights (pure; EPSG:5186 meters). Used by scripts/terrain-import.ts.
//
// Height between two adjacent contour levels = linear in the distances to them (distance transforms per level),
// the classic "contour-distance" interpolation; spot heights correct summits / saddles / mid-interval locally.
import { distanceTransform } from './edt.js';

export interface ContourRun { height: number; points: [number, number][] }
export interface SpotHeight { x: number; y: number; height: number }
export interface Grid { originX: number; originY: number; resolution: number; width: number; height: number }

export interface DemResult {
  grid: Grid;
  heights: Float32Array;
  sigma: Float32Array;
  slope: Float32Array; // rise / run
  levels: number[];
  spotResiduals: number[]; // spot height - contour-only DEM (before the spot correction)
  /** spot height - final DEM with that spot left out of the correction: accuracy of the corrected surface */
  spotLooResiduals: number[];
}

const idx = (g: Grid, ix: number, iy: number) => iy * g.width + ix;

export function bilinear(g: Grid, values: Float32Array, x: number, y: number): number | null {
  const fx = (x - g.originX) / g.resolution - 0.5;
  const fy = (y - g.originY) / g.resolution - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  if (ix < 0 || iy < 0 || ix + 1 >= g.width || iy + 1 >= g.height) return null;
  const tx = fx - ix;
  const ty = fy - iy;
  const v00 = values[idx(g, ix, iy)], v10 = values[idx(g, ix + 1, iy)], v01 = values[idx(g, ix, iy + 1)], v11 = values[idx(g, ix + 1, iy + 1)];
  const v = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  return Number.isFinite(v) ? v : null;
}

function rasterize(g: Grid, runs: [number, number][][]): Uint8Array {
  const mask = new Uint8Array(g.width * g.height);
  const mark = (x: number, y: number) => {
    const ix = Math.floor((x - g.originX) / g.resolution);
    const iy = Math.floor((y - g.originY) / g.resolution);
    if (ix >= 0 && iy >= 0 && ix < g.width && iy < g.height) mask[idx(g, ix, iy)] = 1;
  };
  for (const run of runs) {
    for (let k = 0; k + 1 < run.length; k++) {
      const [ax, ay] = run[k];
      const [bx, by] = run[k + 1];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) / (g.resolution / 2)) + 1;
      for (let i = 0; i <= n; i++) mark(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n);
    }
  }
  return mask;
}

export function buildDem(grid: Grid, contours: ContourRun[], spots: SpotHeight[], opts: { passes: [number, number][] } = { passes: [[120, 300], [25, 60]] }): DemResult {
  const g = grid;
  const n = g.width * g.height;
  const levels = [...new Set(contours.map((c) => c.height))].sort((a, b) => a - b);
  const dist = levels.map((h) => {
    const mask = rasterize(g, contours.filter((c) => c.height === h).map((c) => c.points));
    const d = distanceTransform(mask, g.width, g.height);
    for (let i = 0; i < n; i++) d[i] *= g.resolution;
    return d;
  });

  const heights = new Float32Array(n);
  const sigma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0;
    for (let l = 1; l < levels.length; l++) if (dist[l][i] < dist[best][i]) best = l;
    const d1 = dist[best][i];
    const lo = best > 0 ? dist[best - 1][i] : Infinity;
    const hi = best + 1 < levels.length ? dist[best + 1][i] : Infinity;
    const other = hi < lo ? best + 1 : best - 1;
    const d2 = Math.min(lo, hi);
    if (Number.isFinite(d2)) {
      heights[i] = levels[best] + ((levels[other] - levels[best]) * d1) / Math.max(d1 + d2, 1e-6);
      sigma[i] = 0.5 + 4 * (Math.min(d1, d2) / Math.max(d1 + d2, 1e-6)); // 0.5 m on a line .. 2.5 m half way
    } else {
      heights[i] = levels[best];
      sigma[i] = 2.5;
    }
  }

  // spot heights: residuals against the contour-only surface, then a Gaussian-weighted correction in two passes:
  // a broad one for the regional bias (spots are > 60 m apart; plateaus between contours come out ~2 m high),
  // then a local one for summits / saddles near a spot. Leave-one-out residuals measure the corrected surface.
  const spotResiduals: number[] = [];
  let usable: (SpotHeight & { r: number; loo: number })[] = [];
  for (const s of spots) {
    const h = bilinear(g, heights, s.x, s.y);
    if (h === null) continue;
    spotResiduals.push(s.height - h);
    usable.push({ ...s, r: s.height - h, loo: s.height - h });
  }
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
          const i = idx(g, ix, iy);
          wsum[i] += w;
          rsum[i] += w * s.r;
          nearest[i] = Math.min(nearest[i], Math.sqrt(d2));
        }
      }
    }
    const predict = (s: { x: number; y: number }, skip: number, field: 'r' | 'loo') => {
      let w = 0;
      let wr = 0;
      usable.forEach((o, j) => {
        const d2 = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
        if (j === skip || d2 > radius ** 2) return;
        const k = Math.exp(-d2 / k2);
        w += k;
        wr += k * o[field];
      });
      return w > 0 ? wr / (w + 0.3) : 0;
    };
    usable = usable.map((s, i) => ({ ...s, r: s.r - predict(s, -1, 'r'), loo: s.loo - predict(s, i, 'loo') }));
    for (let i = 0; i < n; i++) if (wsum[i] > 0) heights[i] += rsum[i] / (wsum[i] + 0.3);
  }
  const spotLooResiduals = usable.map((s) => s.loo);
  for (let i = 0; i < n; i++) if (Number.isFinite(nearest[i])) sigma[i] = Math.min(sigma[i], 0.5 + nearest[i] / 20);

  // slope (central differences) and its contribution to the height uncertainty (2 m registration error)
  const slope = new Float32Array(n);
  for (let iy = 0; iy < g.height; iy++) {
    for (let ix = 0; ix < g.width; ix++) {
      const x0 = heights[idx(g, Math.max(0, ix - 1), iy)], x1 = heights[idx(g, Math.min(g.width - 1, ix + 1), iy)];
      const y0 = heights[idx(g, ix, Math.max(0, iy - 1))], y1 = heights[idx(g, ix, Math.min(g.height - 1, iy + 1))];
      const s = Math.hypot((x1 - x0) / (2 * g.resolution), (y1 - y0) / (2 * g.resolution));
      slope[idx(g, ix, iy)] = s;
      const i = idx(g, ix, iy);
      sigma[i] = Math.sqrt(sigma[i] ** 2 + (2 * s) ** 2);
    }
  }
  return { grid: g, heights, sigma, slope, levels, spotResiduals, spotLooResiduals };
}

export function rasterizePolygon(g: Grid, rings: [number, number][][], bufferM: number): Uint8Array {
  const mask = new Uint8Array(g.width * g.height);
  const inRing = (x: number, y: number, ring: [number, number][]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const segDist = (x: number, y: number, ring: [number, number][]) => {
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j];
      const [bx, by] = ring[i];
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / Math.max((bx - ax) ** 2 + (by - ay) ** 2, 1e-9)));
      best = Math.min(best, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
    }
    return best;
  };
  const xs = rings.flat().map((p) => p[0]);
  const ys = rings.flat().map((p) => p[1]);
  const x0 = Math.max(0, Math.floor((Math.min(...xs) - bufferM - g.originX) / g.resolution));
  const x1 = Math.min(g.width - 1, Math.ceil((Math.max(...xs) + bufferM - g.originX) / g.resolution));
  const y0 = Math.max(0, Math.floor((Math.min(...ys) - bufferM - g.originY) / g.resolution));
  const y1 = Math.min(g.height - 1, Math.ceil((Math.max(...ys) + bufferM - g.originY) / g.resolution));
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const x = g.originX + (ix + 0.5) * g.resolution;
      const y = g.originY + (iy + 0.5) * g.resolution;
      const inside = inRing(x, y, rings[0]) && !rings.slice(1).some((h) => inRing(x, y, h));
      if (inside || rings.some((r) => segDist(x, y, r) <= bufferM)) mask[idx(g, ix, iy)] = 1;
    }
  }
  return mask;
}
