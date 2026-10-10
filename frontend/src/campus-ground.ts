// The ground inside the campus where no structure describes it yet ("미확정 바닥", F06).
// Why: the server terrain inside the campus is interpolated from the 5 m contours of a 1:5,000 map. It is not a
// surveyed or designed shape, it is wrong by metres wherever it was checked, and it wraps and buries the buildings.
// So inside the campus region the terrain is not drawn. Known ground is drawn by the platform solids (structures.ts)
// and the merged road / area surfaces (paved-surface.ts). What is left gets ONE neutral surface, made by this rule:
//   1. at a building wall it is at that building's own ground level (the lowest ground on its outline, from the scene
//      data), never higher: it cannot rise up a wall or cover a roof;
//   2. where it meets a platform, a road or an area surface it is at that surface's height (flush, no lip);
//   3. at the edge of the campus region it is at the natural terrain there (no step to the terrain outside);
//   4. in between, every point is the average of its surroundings (a membrane stretched between 1–3). Such a surface
//      has no hill and no pit of its own: every point lies between the lowest and the highest of the heights it is
//      stretched between. It is the blandest surface that fits what is known, not a measured one.
// A building whose base ends above the lowest surface next to it is drawn down to that surface (foundation).
// Pure geometry in EPSG:5186 metres (tested in test/campus-ground.test.ts); structures-layer.ts draws it.
import earcut from 'earcut';
import { growPolygons, polygonContains, polygonOps, type Polygon } from './polygon-ops';
import type { Mesh } from './section';

export const GROUND = {
  /** The membrane is solved on cells of this size. */
  cellM: 2,
  /** No triangle edge of the drawn surface is longer than about this. */
  edgeM: 4,
  /** The surface is drawn this far below its heights, so it never lies in the same plane as a surface it meets. */
  sinkM: 0.03,
  /** A point this close to a building wall is at the wall (rule 1). */
  wallReachM: 0.05,
  /**
   * Outside the campus edge a band of this width is drawn here too, at the terrain height and in the colour of the
   * outside ground, and the terrain is hidden to half this width beyond the edge. Why: the map engine hides terrain
   * along a blurred line (about a metre of wobble), which would show as a jagged fringe if the neutral surface ended
   * exactly where the terrain begins. Now the neutral surface ends at the campus edge as a straight line, and the
   * wobble lies between two surfaces of the same colour.
   */
  apronM: 3,
  /** At the outer edge of the apron a vertical face reaches this far down (the drawn terrain is coarser than the grid when seen from afar). */
  edgeSkirtM: 3,
  /** A foundation reaches this far below the lowest surface next to the building. */
  foundationDepthM: 0.5,
  /** Plain, low-contrast, unlit: clearly not a confirmed platform. */
  color: '#e7e5dd',
  /** The outside ground of campus-map.ts (COLORS.outside). */
  outsideColor: '#d6e4be',
  foundationColor: '#cfccc4',
  maxSweeps: 4000,
  toleranceM: 0.0005,
};

/** Ground that is drawn by something else: its plan outline and its triangles (x, y, height first in each vertex). */
export type KnownSurface = { polygons: Polygon[]; mesh: Mesh; stride: number };
/** One drawn building polygon: `groundM` = the lowest ground on its outline, `baseM` = where its walls end. */
export type GroundBuilding = { polygon: Polygon; groundM: number; baseM: number };

export type CampusGround = {
  /** The membrane at a plan point (the terrain outside the campus box). Under a known surface: that surface's height. */
  height: (x: number, y: number) => number;
  /** The neutral surface: x, y, height per vertex. */
  mesh: Mesh;
  /** The band of terrain just outside the campus edge (GROUND.apronM): x, y, height per vertex. */
  apron: Mesh;
  /** Vertical faces along the outer edge of the apron: x, y, height per vertex. */
  skirt: Mesh;
  /** Where the terrain is not drawn: the campus region grown by half the apron. */
  clip: Polygon[];
  /** Per building of the input: the height its walls must be drawn down to, or null when its base does not hang. */
  foundations: (number | null)[];
  /** The plan region the neutral surface covers. */
  region: Polygon[];
};

/** Segments in square buckets: the ones near a point. */
class Buckets<T> {
  private readonly cells = new Map<number, T[]>();
  constructor(private readonly size: number) {}
  private key(i: number, j: number) { return i * 1_000_003 + j; }
  add(minX: number, minY: number, maxX: number, maxY: number, item: T) {
    for (let i = Math.floor(minX / this.size); i <= Math.floor(maxX / this.size); i++) {
      for (let j = Math.floor(minY / this.size); j <= Math.floor(maxY / this.size); j++) {
        const list = this.cells.get(this.key(i, j));
        if (list) list.push(item); else this.cells.set(this.key(i, j), [item]);
      }
    }
  }
  at(x: number, y: number): T[] { return this.cells.get(this.key(Math.floor(x / this.size), Math.floor(y / this.size))) ?? []; }
}

function segmentDistance(x: number, y: number, a: number[], b: number[]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}

/** Height of the known surfaces at a plan point (on or within `tolerance` of a triangle), or null. */
function knownHeight(known: KnownSurface[]) {
  type Tri = { ax: number; ay: number; az: number; bx: number; by: number; bz: number; cx: number; cy: number; cz: number };
  const buckets = new Buckets<Tri>(4);
  for (const { mesh, stride } of known) {
    const p = mesh.positions;
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const [a, b, c] = [mesh.indices[k] * stride, mesh.indices[k + 1] * stride, mesh.indices[k + 2] * stride];
      const t = { ax: p[a], ay: p[a + 1], az: p[a + 2], bx: p[b], by: p[b + 1], bz: p[b + 2], cx: p[c], cy: p[c + 1], cz: p[c + 2] };
      buckets.add(Math.min(t.ax, t.bx, t.cx) - 0.05, Math.min(t.ay, t.by, t.cy) - 0.05, Math.max(t.ax, t.bx, t.cx) + 0.05, Math.max(t.ay, t.by, t.cy) + 0.05, t);
    }
  }
  return (x: number, y: number, tolerance = 0): number | null => {
    let best: number | null = null, bestOut = Infinity;
    for (const t of buckets.at(x, y)) {
      const det = (t.by - t.cy) * (t.ax - t.cx) + (t.cx - t.bx) * (t.ay - t.cy);
      if (Math.abs(det) < 1e-12) continue;
      const u = ((t.by - t.cy) * (x - t.cx) + (t.cx - t.bx) * (y - t.cy)) / det;
      const v = ((t.cy - t.ay) * (x - t.cx) + (t.ax - t.cx) * (y - t.cy)) / det;
      const w = 1 - u - v;
      // how far outside the triangle, in metres (0 inside): the most negative weight times the triangle's size
      const out = Math.max(0, -Math.min(u, v, w)) * Math.sqrt(Math.abs(det));
      if (out > tolerance || out >= bestOut) continue;
      bestOut = out;
      best = u * t.az + v * t.bz + w * t.cz;
      if (out === 0) break;
    }
    return best;
  };
}

/** Calls `cell(i, j)` for every cell of the grid whose centre is inside the polygon. */
function rasterize(polygon: Polygon, minX: number, minY: number, cellM: number, nx: number, ny: number, cell: (i: number, j: number) => void) {
  const ys = polygon[0].map((p) => p[1]);
  const j0 = Math.max(0, Math.floor((Math.min(...ys) - minY) / cellM)), j1 = Math.min(ny - 1, Math.ceil((Math.max(...ys) - minY) / cellM));
  for (let j = j0; j <= j1; j++) {
    const y = minY + (j + 0.5) * cellM;
    const xs: number[] = [];
    for (const ring of polygon) {
      ring.forEach((p, k) => {
        const q = ring[(k + 1) % ring.length];
        if (p[1] > y !== q[1] > y) xs.push(p[0] + ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]));
      });
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - minX) / cellM - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - minX) / cellM - 0.5));
      for (let i = i0; i <= i1; i++) cell(i, j);
    }
  }
}

export function buildCampusGround(input: {
  /** The campus region (where the terrain is not drawn). */
  campus: Polygon[];
  /** The natural terrain (the server grid). */
  terrain: (x: number, y: number) => number;
  buildings: GroundBuilding[];
  known: KnownSurface[];
}): CampusGround {
  const empty: CampusGround = { height: input.terrain, mesh: { positions: [], indices: [] }, apron: { positions: [], indices: [] }, skirt: { positions: [], indices: [] }, clip: [], foundations: input.buildings.map(() => null), region: [] };
  const campus = polygonOps('union', input.campus);
  if (!campus.length) return empty;

  // ----- the membrane on a grid -----
  const c = GROUND.cellM;
  const points = campus.flat(2);
  const minX = Math.floor(Math.min(...points.map((p) => p[0])) / c) * c - 2 * c;
  const minY = Math.floor(Math.min(...points.map((p) => p[1])) / c) * c - 2 * c;
  const nx = Math.ceil((Math.max(...points.map((p) => p[0])) - minX) / c) + 2;
  const ny = Math.ceil((Math.max(...points.map((p) => p[1])) - minY) / c) + 2;
  const v = new Float64Array(nx * ny);
  const free = new Uint8Array(nx * ny);
  const walled = new Uint8Array(nx * ny); // cells inside a building
  const centre = (i: number, j: number) => [minX + (i + 0.5) * c, minY + (j + 0.5) * c];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const [x, y] = centre(i, j); v[j * nx + i] = input.terrain(x, y); }
  for (const polygon of campus) rasterize(polygon, minX, minY, c, nx, ny, (i, j) => { if (i > 0 && j > 0 && i < nx - 1 && j < ny - 1) free[j * nx + i] = 1; });
  const known = knownHeight(input.known);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!free[j * nx + i]) continue;
      const [x, y] = centre(i, j);
      const z = known(x, y);
      if (z !== null) { v[j * nx + i] = z; free[j * nx + i] = 0; }
    }
  }
  for (const b of input.buildings) {
    rasterize(b.polygon, minX, minY, c, nx, ny, (i, j) => {
      const k = j * nx + i;
      v[k] = walled[k] ? Math.min(v[k], b.groundM) : b.groundM;
      walled[k] = 1;
      free[k] = 0;
    });
  }
  // successive over-relaxation: each free cell becomes the average of its four neighbours
  const cells: number[] = [];
  for (let k = 0; k < free.length; k++) if (free[k]) cells.push(k);
  const omega = 1.85;
  for (let sweep = 0; sweep < GROUND.maxSweeps; sweep++) {
    let change = 0;
    for (const k of cells) {
      const d = (v[k - 1] + v[k + 1] + v[k - nx] + v[k + nx]) / 4 - v[k];
      v[k] += omega * d;
      if (Math.abs(d) > change) change = Math.abs(d);
    }
    if (change < GROUND.toleranceM) break;
  }
  const maxX = minX + nx * c, maxY = minY + ny * c;
  const height = (x: number, y: number): number => {
    if (x < minX + c / 2 || y < minY + c / 2 || x > maxX - c / 2 || y > maxY - c / 2) return input.terrain(x, y);
    const fx = (x - minX) / c - 0.5, fy = (y - minY) / c - 0.5;
    const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy));
    const tx = fx - i, ty = fy - j;
    return v[j * nx + i] * (1 - tx) * (1 - ty) + v[j * nx + i + 1] * tx * (1 - ty) + v[(j + 1) * nx + i] * (1 - tx) * ty + v[(j + 1) * nx + i + 1] * tx * ty;
  };

  // ----- the region that is left, and the height of its outline points -----
  const region = polygonOps('minus', polygonOps('minus', campus, input.buildings.map((b) => b.polygon)), input.known.flatMap((k) => k.polygons));
  type Segment = { a: number[]; b: number[]; building: number };
  const walls = new Buckets<Segment>(8);
  input.buildings.forEach((b, building) => {
    for (const ring of b.polygon) ring.forEach((p, k) => {
      const q = ring[(k + 1) % ring.length];
      walls.add(Math.min(p[0], q[0]) - 1, Math.min(p[1], q[1]) - 1, Math.max(p[0], q[0]) + 1, Math.max(p[1], q[1]) + 1, { a: p, b: q, building });
    });
  });
  const edge = new Buckets<Segment>(8);
  for (const ring of campus.flat()) ring.forEach((p, k) => {
    const q = ring[(k + 1) % ring.length];
    edge.add(Math.min(p[0], q[0]) - 1, Math.min(p[1], q[1]) - 1, Math.max(p[0], q[0]) + 1, Math.max(p[1], q[1]) + 1, { a: p, b: q, building: -1 });
  });
  const onEdge = (x: number, y: number) => edge.at(x, y).some((s) => segmentDistance(x, y, s.a, s.b) < 0.01);
  /** The lowest surface seen next to each building (for the foundations). */
  const lowest = input.buildings.map(() => Infinity);
  /** Rule 1: a point at a building wall is never above that building's ground level. */
  const atWalls = (x: number, y: number, z: number): number => {
    const near = walls.at(x, y).filter((s) => segmentDistance(x, y, s.a, s.b) < GROUND.wallReachM);
    for (const s of near) z = Math.min(z, input.buildings[s.building].groundM);
    for (const s of near) lowest[s.building] = Math.min(lowest[s.building], z);
    return z;
  };
  const outlineHeight = (x: number, y: number): number => (onEdge(x, y) ? input.terrain(x, y) : atWalls(x, y, known(x, y, 0.02) ?? height(x, y)));

  // ----- triangles: ear cutting, then every long edge halved until none is longer than GROUND.edgeM -----
  // an outline edge stays straight between its ends (flush with what it runs along), except along the campus edge (the terrain)
  const floor = triangulate(region, outlineHeight, (x, y, p, q, outline) => (outline ? (onEdge(x, y) && onEdge(p[0], p[1]) && onEdge(q[0], q[1]) ? input.terrain(x, y) : atWalls(x, y, (p[2] + q[2]) / 2)) : height(x, y)));

  // ----- the apron: a band of terrain just outside the campus edge, drawn here in the colour of the outside ground -----
  // (the terrain is hidden a little beyond the edge, see `clip`, so the edge of the neutral surface is a clean straight line)
  const outer = growPolygons(campus, GROUND.apronM);
  const band = triangulate(polygonOps('minus', polygonOps('minus', outer, campus), input.known.flatMap((k) => k.polygons)), input.terrain, (x, y) => input.terrain(x, y)); // not over a road that leaves the campus
  const skirt: Mesh = { positions: [], indices: [] };
  for (const [i, j] of band.outline) {
    const a = band.xyz[i], b = band.xyz[j];
    if (onEdge(a[0], a[1]) && onEdge(b[0], b[1])) continue; // the inner edge meets the neutral surface
    const at = skirt.positions.length / 3;
    skirt.positions.push(a[0], a[1], a[2] - GROUND.sinkM, b[0], b[1], b[2] - GROUND.sinkM, b[0], b[1], b[2] - GROUND.edgeSkirtM, a[0], a[1], a[2] - GROUND.edgeSkirtM);
    skirt.indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
  }

  // a building also stands next to the known surfaces: the membrane just outside its walls carries their heights
  input.buildings.forEach((b, k) => {
    for (const ring of b.polygon) ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const out = [(q[1] - p[1]) / length, -(q[0] - p[0]) / length]; // outwards (outer rings run counter-clockwise, holes clockwise)
      for (let s = 0; s <= length; s += c) {
        const x = p[0] + ((q[0] - p[0]) * s) / length, y = p[1] + ((q[1] - p[1]) * s) / length;
        const px = x + out[0] * 0.3, py = y + out[1] * 0.3;
        if (campus.some((poly) => polygonContains(px, py, poly)) && !input.buildings.some((o) => polygonContains(px, py, o.polygon))) lowest[k] = Math.min(lowest[k], known(px, py) ?? height(px, py));
      }
    });
  });
  const foundations = input.buildings.map((b, k) => (lowest[k] < b.baseM ? lowest[k] - GROUND.foundationDepthM : null));

  const sunk = (t: { xyz: number[][]; tris: number[] }): Mesh => ({ positions: t.xyz.flatMap((q) => [q[0], q[1], q[2] - GROUND.sinkM]), indices: t.tris });
  return { height, mesh: sunk(floor), apron: sunk(band), skirt, clip: growPolygons(campus, GROUND.apronM / 2), foundations, region };
}

/**
 * Triangles of a plan region with a height per vertex: ear cutting, then every edge longer than GROUND.edgeM is halved
 * (in every triangle that has it, so the triangles keep fitting together) until none is left. `vertex` gives the height
 * of an outline point, `middle` the height of the middle of an edge p–q (`outline`: the edge lies on the outline).
 * Also returns the outline edges.
 */
function triangulate(
  region: Polygon[], vertex: (x: number, y: number) => number,
  middle: (x: number, y: number, p: number[], q: number[], outline: boolean) => number,
): { xyz: number[][]; tris: number[]; outline: [number, number][] } {
  const xyz: number[][] = [];
  const index = new Map<string, number>();
  let tris: number[] = [];
  for (const poly of region) {
    const pts = poly.flat();
    const starts = poly.slice(0, -1).reduce<number[]>((s, r) => [...s, (s[s.length - 1] ?? 0) + r.length], []);
    for (const k of earcut(pts.flatMap((p) => [p[0], p[1]]), starts)) {
      const p = pts[k];
      const key = `${p[0]},${p[1]}`;
      let i = index.get(key);
      if (i === undefined) { i = xyz.length; xyz.push([p[0], p[1], vertex(p[0], p[1])]); index.set(key, i); }
      tris.push(i);
    }
  }
  const edgeKey = (a: number, b: number) => (a < b ? a * 4_000_000 + b : b * 4_000_000 + a);
  const count = () => {
    const uses = new Map<number, number>();
    for (let k = 0; k < tris.length; k += 3) for (let e = 0; e < 3; e++) { const key = edgeKey(tris[k + e], tris[k + (e + 1) % 3]); uses.set(key, (uses.get(key) ?? 0) + 1); }
    return uses;
  };
  for (let pass = 0; pass < 24; pass++) {
    const uses = count();
    const mids = new Map<number, number>();
    const mid = (a: number, b: number): number | null => {
      const p = xyz[a], q = xyz[b];
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= GROUND.edgeM) return null;
      const key = edgeKey(a, b);
      let m = mids.get(key);
      if (m === undefined) {
        const x = (p[0] + q[0]) / 2, y = (p[1] + q[1]) / 2;
        m = xyz.length;
        xyz.push([x, y, middle(x, y, p, q, uses.get(key) === 1)]);
        mids.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let k = 0; k < tris.length; k += 3) {
      const [a, b, c] = [tris[k], tris[k + 1], tris[k + 2]];
      const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
      const n = (ab !== null ? 1 : 0) + (bc !== null ? 1 : 0) + (ca !== null ? 1 : 0);
      if (n === 0) next.push(a, b, c);
      else if (n === 3) next.push(a, ab!, ca!, ab!, b, bc!, ca!, bc!, c, ab!, bc!, ca!);
      else if (n === 1) {
        if (ab !== null) next.push(a, ab, c, ab, b, c);
        else if (bc !== null) next.push(a, b, bc, a, bc, c);
        else next.push(a, b, ca!, ca!, b, c);
      } else if (ab === null) next.push(a, b, bc!, a, bc!, ca!, ca!, bc!, c);
      else if (bc === null) next.push(a, ab, ca!, ab, b, ca!, b, c, ca!);
      else next.push(a, ab, c, ab, bc!, c, ab, b, bc!);
    }
    tris = next;
    if (!mids.size) break;
  }
  const uses = count();
  const outline: [number, number][] = [];
  for (let k = 0; k < tris.length; k += 3) for (let e = 0; e < 3; e++) if (uses.get(edgeKey(tris[k + e], tris[k + (e + 1) % 3])) === 1) outline.push([tris[k + e], tris[k + (e + 1) % 3]]);
  return { xyz, tris, outline };
}
