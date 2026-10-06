// Base and roof heights of a rough building block on a DEM (same rules as the source QGIS model):
//   samples = the outline densified every 2 m + one interior point
//   base = min(samples) - 1 m (no floating base on slopes), roof = median(samples) + height,
//   roof at least max(samples) + 3 m (a block on a steep slope must not be buried).
export type Ring = [number, number][];

export interface BlockHeights { baseM: number; roofM: number; terrainMinM: number; terrainMaxM: number; roofRaised: boolean }

export function outlineSamples(polygons: Ring[][], stepM = 2): [number, number][] {
  const out: [number, number][] = [];
  for (const poly of polygons) {
    const ring = poly[0];
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1];
      const [bx, by] = ring[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / stepM));
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
  }
  return out;
}

export function blockHeights(samples: number[], heightM: number): BlockHeights {
  if (!samples.length) throw new Error('No terrain samples under the building');
  const s = [...samples].sort((a, b) => a - b);
  const med = s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const min = s[0];
  const max = s.at(-1)!;
  let roof = med + heightM;
  const roofRaised = roof < max + 3;
  if (roofRaised) roof = max + 3;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { baseM: r3(min - 1), roofM: r3(roof), terrainMinM: r3(min), terrainMaxM: r3(max), roofRaised };
}
