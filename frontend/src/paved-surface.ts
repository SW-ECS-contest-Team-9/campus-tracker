// Ground surfaces of the preview map as merged, smooth-edged shapes ("pooled water", F04): the carriageways, the paved
// areas and the pedestrian ways that belong to them are ONE black surface, the remaining pedestrian ways one grey
// surface, the sports field one tan surface. Each is the union of its pieces in plan with the outline smoothed like
// settled liquid (no corners, no saw-teeth, no thin spikes), kept out of the building footprints, and drawn at its own
// height: an area at its floor height, a road at its stored height where that agrees with the ground, otherwise on a
// smoothed ground profile (road-surface.ts tells why the stored heights cannot simply be used yet).
// Pure geometry in EPSG:5186 metres (tested in test/paved-surface.test.ts); road-surface-layer.ts draws it.
// Polygon union / difference / offsetting is done by clipper-lib (Clipper 6, integer coordinates), triangles by earcut.
import ClipperLib from 'clipper-lib';
import earcut from 'earcut';
import { ROAD_SURFACE, isUnderground, roadWidthM, smoothCentreline, surfaceKind, type P3, type SurfaceKind } from './road-surface';

/** A polygon ring in metres, not closed. */
export type Ring = number[][];
export type Material = SurfaceKind | 'field';
/** Which material wins where two overlap in plan: the first. The last takes what is left of the merged shape. */
export const MATERIALS: Material[] = ['crossing', 'carriageway', 'stairs', 'pedestrian', 'field'];

/** Every constant of the merged surfaces. Lengths in metres. */
export const PAVED = {
  // --- which pedestrian ways are part of the black paved surface (rule in pavedRoadIds) ---
  /** A pedestrian way with at least this share of its centreline inside a paved area is part of that area. */
  joinInsideShare: 0.5,
  /** A pedestrian way with a written width of at least this (wide enough for a vehicle) that touches the paved surface is part of it. */
  joinMinWidthM: 4,
  // --- the "pooled water" outline (pool) ---
  /** Closing (grow, then shrink by this): notches narrower than twice this fill up, pieces closer than that join, inner corners get this radius. */
  closeRadiusM: 1,
  /** Opening (shrink, then grow by this) of everything at least 3 m wide: outer corners get this radius, a 90° corner loses 0.62 m at its tip. */
  cornerRadiusM: 1.5,
  /** Opening of the narrower parts: a way at least twice this wide survives (the 2 m default of stairs does), thinner spikes vanish. */
  keepRadiusM: 0.8,
  /** Leftovers thinner than twice this are dropped (crescents between the two openings, slivers along a building wall). */
  sliverM: 0.3,
  /** Offset arcs are polygons that stay within this of the true arc. */
  arcToleranceM: 0.005,
  /** After the offsets the outline is resampled at this spacing and corner-cut (Chaikin) this many times. */
  resampleStepM: 0.5,
  chaikinPasses: 2,
  // --- the rim (soft edge) ---
  /** The colour fades from the surface colour to the rim colour over this distance before the outline. */
  rimWidthM: 0.5,
  /** Rim colour = surface colour mixed this far towards the ground colour (1 = the edge dissolves into the ground). */
  rimFade: 0.6,
  /** The ground colour of the campus (campus-map.ts) the rim fades towards, and the slightly darker tone of the skirt. */
  groundColor: '#f3efe0',
  skirtColor: '#ddd6c3',
  // --- height ---
  /** A road is drawn at its stored height when that is within this of the ground along its whole centreline. */
  agreeToleranceM: 0.5,
  /** Otherwise: the ground under the centreline, averaged over this distance to either side (twice). */
  profileWindowM: 6,
  /** Around a level area the height changes over to the road heights within this distance. */
  areaBlendM: 3,
  /** A point takes its height from the roads within their half width plus this (weighted by nearness). */
  roadReachM: 2.5,
  /** No triangle of a sloping surface is longer than about this (the surface is cut into cells of this size). */
  cellM: 4,
  /** Outline points are at most this far apart (heights are read at each). */
  outlineStepM: 1,
  /** The skirt (vertical face from the rim to the ground, in the ground colour) reaches this far into the ground. */
  skirtDepthM: 0.5,
  discSegments: 48,
};

// ---------- Clipper (integers = millimetres around a local origin, which keeps it on its fast number path) ----------
type IPath = { X: number; Y: number }[];
/** Polygons as Clipper paths: outer rings one way round, holes the other. */
type Shape = IPath[];
const MM = 1000;
const NONZERO = ClipperLib.PolyFillType.pftNonZero;
let origin: number[] = [0, 0];

const toPath = (ring: Ring): IPath => ring.map(([x, y]) => ({ X: Math.round((x - origin[0]) * MM), Y: Math.round((y - origin[1]) * MM) }));
const toRing = (path: IPath): Ring => path.map(({ X, Y }) => [X / MM + origin[0], Y / MM + origin[1]]);

function clipper(subject: Shape, other: Shape = [], keepCollinear = false): any {
  const c = new ClipperLib.Clipper();
  c.PreserveCollinear = keepCollinear;
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (other.length) c.AddPaths(other, ClipperLib.PolyType.ptClip, true);
  return c;
}
function run(c: any, type: number, fill = NONZERO): Shape {
  const out = new ClipperLib.Paths();
  c.Execute(type, out, fill, fill);
  return out;
}
const union = (...shapes: Shape[]): Shape => run(clipper(shapes.flat()), ClipperLib.ClipType.ctUnion);
const minus = (a: Shape, b: Shape): Shape => (a.length && b.length ? run(clipper(a, b), ClipperLib.ClipType.ctDifference) : a);
const both = (a: Shape, b: Shape): Shape => (a.length && b.length ? run(clipper(a, b), ClipperLib.ClipType.ctIntersection) : []);
/** One polygon given as rings in any direction (outer first, then holes). */
const polygonShape = (rings: Ring[]): Shape => run(clipper(rings.map(toPath)), ClipperLib.ClipType.ctUnion, ClipperLib.PolyFillType.pftEvenOdd);
/** Outline moved outwards (inwards when negative) with round corners. */
function grow(shape: Shape, deltaM: number): Shape {
  if (!shape.length || deltaM === 0) return shape;
  const co = new ClipperLib.ClipperOffset(2, PAVED.arcToleranceM * MM);
  co.AddPaths(shape, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, deltaM * MM);
  return out;
}
const closing = (shape: Shape, r: number) => grow(grow(shape, r), -r);
const opening = (shape: Shape, r: number) => grow(grow(shape, -r), r);
/** Polygons with their holes. */
function polygons(shape: Shape, cut: Shape | null = null): { outer: IPath; holes: IPath[] }[] {
  const tree = new ClipperLib.PolyTree();
  const c = clipper(shape, cut ?? [], true);
  c.Execute(cut ? ClipperLib.ClipType.ctIntersection : ClipperLib.ClipType.ctUnion, tree, NONZERO, NONZERO);
  return ClipperLib.JS.PolyTreeToExPolygons(tree);
}
function bounds(shape: Shape) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of shape) for (const p of path) { minX = Math.min(minX, p.X); minY = Math.min(minY, p.Y); maxX = Math.max(maxX, p.X); maxY = Math.max(maxY, p.Y); }
  return { minX, minY, maxX, maxY };
}

// ---------- the pieces ----------
/** A road as a band: its centreline widened by half the width to either side, round at the bends, cut square at both ends. */
function band(centre: number[][], widthM: number): Shape {
  const co = new ClipperLib.ClipperOffset(2, PAVED.arcToleranceM * MM);
  co.AddPath(toPath(centre), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenButt);
  const out = new ClipperLib.Paths();
  co.Execute(out, (widthM / 2) * MM);
  return out;
}
const disc = (c: number[], r: number): Shape => [toPath(Array.from({ length: PAVED.discSegments }, (_, k) => {
  const a = (2 * Math.PI * k) / PAVED.discSegments;
  return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
}))];

// ---------- the pooled-water outline ----------
/**
 * The outline of a shape as liquid that settled: closing fills narrow notches and joins near pieces, opening rounds
 * the outer corners and removes thin spikes (a larger radius where the shape is wide, a smaller one where it is a
 * narrow way, so that the way stays), a second closing rounds the inner corners where the two meet.
 */
function pool(shape: Shape): Shape {
  const closed = closing(shape, PAVED.closeRadiusM);
  const wide = opening(closed, PAVED.cornerRadiusM);
  const narrow = opening(minus(opening(closed, PAVED.keepRadiusM), wide), PAVED.sliverM);
  return smooth(closing(union(wide, narrow), PAVED.closeRadiusM));
}

/** Points every `step` metres (or closer, evenly) along a closed ring. */
function resample(ring: Ring, step: number): Ring {
  const lengths = ring.map((p, i) => Math.hypot(ring[(i + 1) % ring.length][0] - p[0], ring[(i + 1) % ring.length][1] - p[1]));
  const total = lengths.reduce((s, l) => s + l, 0);
  const n = Math.max(3, Math.ceil(total / step));
  const out: Ring = [];
  let i = 0, before = 0;
  for (let k = 0; k < n; k++) {
    const d = (k * total) / n;
    while (i < ring.length - 1 && before + lengths[i] < d) before += lengths[i++];
    const t = lengths[i] > 0 ? (d - before) / lengths[i] : 0;
    const a = ring[i], b = ring[(i + 1) % ring.length];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}
/** Chaikin corner cutting of a closed ring: every corner is replaced by two points a quarter along its two edges. */
function chaikin(ring: Ring): Ring {
  return ring.flatMap((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return [[0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]], [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]];
  });
}
/** Curve smoothing of every ring: resample, corner-cut, then drop the points that lie on a straight line again. */
function smooth(shape: Shape): Shape {
  const rings = shape.map((path) => {
    let ring = resample(toRing(path), PAVED.resampleStepM);
    for (let k = 0; k < PAVED.chaikinPasses; k++) ring = chaikin(ring);
    return toPath(ring);
  });
  return union(ClipperLib.Clipper.CleanPolygons(rings, 0.002 * MM));
}
/** Extra points on every ring so that no two neighbours are further apart than `step`. */
function densify(shape: Shape, step: number): Shape {
  return shape.map((path) => path.flatMap((p, i) => {
    const q = path[(i + 1) % path.length];
    const n = Math.max(1, Math.ceil(Math.hypot(q.X - p.X, q.Y - p.Y) / (step * MM)));
    return Array.from({ length: n }, (_, k) => ({ X: Math.round(p.X + ((q.X - p.X) * k) / n), Y: Math.round(p.Y + ((q.Y - p.Y) * k) / n) }));
  }));
}

// ---------- small plan helpers ----------
function ringContains(x: number, y: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Nearest point of segment a-b to (x, y): distance and how far along (0..1). */
function toSegment(x: number, y: number, a: number[], b: number[]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return { d: Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t), t };
}
/** Segments in square buckets, to find the ones near a point without looking at all of them. */
class SegmentGrid<T> {
  private readonly cells = new Map<string, { a: number[]; b: number[]; item: T }[]>();
  constructor(private readonly cellM: number, private readonly reachM: number) {}
  add(a: number[], b: number[], item: T, reachM = this.reachM) {
    const c = this.cellM;
    for (let i = Math.floor((Math.min(a[0], b[0]) - reachM) / c); i <= Math.floor((Math.max(a[0], b[0]) + reachM) / c); i++) {
      for (let j = Math.floor((Math.min(a[1], b[1]) - reachM) / c); j <= Math.floor((Math.max(a[1], b[1]) + reachM) / c); j++) {
        const key = `${i},${j}`;
        const list = this.cells.get(key);
        if (list) list.push({ a, b, item }); else this.cells.set(key, [{ a, b, item }]);
      }
    }
  }
  /** Every segment that may be within its reach of the point. */
  near(x: number, y: number) {
    return this.cells.get(`${Math.floor(x / this.cellM)},${Math.floor(y / this.cellM)}`) ?? [];
  }
}
function ringGrid(rings: Ring[], reachM: number) {
  const grid = new SegmentGrid<null>(Math.max(2, reachM * 2), reachM);
  for (const ring of rings) ring.forEach((p, i) => grid.add(p, ring[(i + 1) % ring.length], null));
  return (x: number, y: number) => grid.near(x, y).reduce((best, s) => Math.min(best, toSegment(x, y, s.a, s.b).d), Infinity);
}

// ---------- which roads, which material ----------
export type SurfaceRoad = {
  id: string; name: string | null; roadClass: string; structure?: string; widthM: number | null; levelId: string | null; buildingId?: string | null;
  fromNodeId: string; toNodeId: string; geometry: { coordinates: number[][] };
};
/** A filled open area: `asphalt` is part of the black paved surface, `field` its own surface. Rings in metres, outer first. */
export type SurfaceArea = { id: number; fill: 'asphalt' | 'field'; elevationM: number | null; rings: Ring[] };

/**
 * The pedestrian ways drawn as part of the black paved surface (the one rule for it):
 *  - at least PAVED.joinInsideShare of the centreline lies inside a paved area, or
 *  - the way has a written width of at least PAVED.joinMinWidthM and touches the paved surface: an end inside (or
 *    within the closing radius of) a paved area, or at a node of a carriageway or of a way that already joined.
 * Only plain outdoor ways above ground (surface kind `pedestrian`): stairs and crossings keep their own tone.
 */
export function pavedRoadIds(roads: SurfaceRoad[], pavedAreas: Ring[][]): string[] {
  if (pavedAreas.length) origin = pavedAreas[0][0][0].map(Math.floor);
  const near = grow(union(...pavedAreas.map(polygonShape)), PAVED.closeRadiusM).map(toRing);
  const inside = (p: number[], rings: Ring[]) => rings.reduce((n, r) => n + (ringContains(p[0], p[1], r) ? 1 : 0), 0) % 2 === 1;
  const exact = pavedAreas.flat();
  const surface = roads.filter((r) => surfaceKind(r) !== null && !isUnderground(r));
  const nodes = new Set(surface.filter((r) => surfaceKind(r) === 'carriageway').flatMap((r) => [r.fromNodeId, r.toNodeId]));
  const joined = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const road of surface) {
      if (joined.has(road.id) || surfaceKind(road) !== 'pedestrian') continue;
      const centre = smoothCentreline(road.geometry.coordinates);
      if (centre.length < 2) continue;
      const share = centre.filter((p) => inside(p, exact)).length / centre.length;
      const touches = nodes.has(road.fromNodeId) || nodes.has(road.toNodeId) || inside(centre[0], near) || inside(centre[centre.length - 1], near);
      if (share >= PAVED.joinInsideShare || ((road.widthM ?? 0) >= PAVED.joinMinWidthM && touches)) {
        joined.add(road.id);
        nodes.add(road.fromNodeId).add(road.toNodeId);
        changed = true;
      }
    }
  }
  return [...joined];
}

// ---------- height ----------
/**
 * The height line of a road along its smoothed centreline: the stored heights where they are within
 * PAVED.agreeToleranceM of the ground everywhere, otherwise the ground under the centreline, smoothed (moving
 * average over PAVED.profileWindowM to either side, twice; both ends keep the ground height, so roads meeting at a
 * node meet at one height).
 */
export function roadProfile(centre: P3[], ground: (x: number, y: number) => number): { line: P3[]; source: 'stored' | 'ground' } {
  const onGround = centre.map((p) => ground(p[0], p[1]));
  if (centre.every((p, i) => Math.abs(p[2] - onGround[i]) <= PAVED.agreeToleranceM)) return { line: centre, source: 'stored' };
  const n = Math.round(PAVED.profileWindowM / ROAD_SURFACE.sampleStepM);
  let zs = onGround;
  for (let pass = 0; pass < 2; pass++) {
    zs = zs.map((_, i) => {
      const half = Math.min(n, i, zs.length - 1 - i);
      let sum = 0;
      for (let k = i - half; k <= i + half; k++) sum += zs[k];
      return sum / (2 * half + 1);
    });
  }
  return { line: centre.map((p, i) => [p[0], p[1], zs[i]] as P3), source: 'ground' };
}

/**
 * Height of the merged surfaces at a plan point. Inside a level area (or within the closing radius of it): its floor
 * height. Elsewhere: the height lines of the roads within reach, weighted by nearness; within PAVED.areaBlendM of a
 * level area the two are mixed, so a road runs into a level area without a step. Nothing in reach: the ground.
 */
export function surfaceHeight(lines: { line: P3[]; halfWidthM: number }[], levels: { ring: Ring; z: number }[], ground: (x: number, y: number) => number) {
  const reachOf = (halfWidthM: number) => halfWidthM + PAVED.closeRadiusM + PAVED.roadReachM;
  const grid = new SegmentGrid<number>(8, 0);
  lines.forEach(({ line, halfWidthM }, road) => { for (let i = 0; i + 1 < line.length; i++) grid.add(line[i], line[i + 1], road, reachOf(halfWidthM)); });
  const fromRoads = (x: number, y: number): number | null => {
    const best = new Map<number, { d: number; z: number }>();
    for (const s of grid.near(x, y)) {
      const { d, t } = toSegment(x, y, s.a, s.b);
      const had = best.get(s.item);
      if (!had || d < had.d) best.set(s.item, { d, z: s.a[2] + (s.b[2] - s.a[2]) * t });
    }
    let sum = 0, weight = 0;
    for (const [road, { d, z }] of best) {
      const w = Math.max(0, 1 - d / reachOf(lines[road].halfWidthM)) ** 2;
      sum += w * z;
      weight += w;
    }
    return weight > 1e-9 ? sum / weight : null;
  };
  return (x: number, y: number): number => {
    let level: { out: number; z: number } | null = null;
    for (const { ring, z } of levels) {
      const out = ringContains(x, y, ring) ? 0 : Math.max(0, ring.reduce((d, p, i) => Math.min(d, toSegment(x, y, p, ring[(i + 1) % ring.length]).d), Infinity) - PAVED.closeRadiusM);
      if (!level || out < level.out) level = { out, z };
    }
    if (level && level.out === 0) return level.z;
    const road = fromRoads(x, y);
    if (level && level.out < PAVED.areaBlendM) {
      const t = level.out / PAVED.areaBlendM;
      const s = t * t * (3 - 2 * t);
      return level.z + ((road ?? level.z) - level.z) * s;
    }
    return road ?? ground(x, y);
  };
}

// ---------- meshes ----------
/** Triangles; `stride` numbers per vertex. */
export type Mesh = { positions: number[]; indices: number[] };

/** The squares of a checkerboard (one colour of it) over a box: cutting a shape with both colours cuts it into cells. */
function checkerboard(box: { minX: number; minY: number; maxX: number; maxY: number }, cell: number, colour: number): Shape {
  const out: Shape = [];
  for (let i = Math.floor(box.minX / cell); i * cell < box.maxX; i++) {
    for (let j = Math.floor(box.minY / cell); j * cell < box.maxY; j++) {
      if (((i + j) % 2 + 2) % 2 !== colour) continue;
      out.push([{ X: i * cell, Y: j * cell }, { X: (i + 1) * cell, Y: j * cell }, { X: (i + 1) * cell, Y: (j + 1) * cell }, { X: i * cell, Y: (j + 1) * cell }]);
    }
  }
  return out;
}

/**
 * Triangles of a shape with x, y, height and `edge` (0 = surface colour ... 1 = rim colour) per vertex.
 * `cellM` > 0 cuts the shape into cells first, so that a sloping surface follows its height everywhere.
 */
function triangulate(shape: Shape, cellM: number, vertex: (x: number, y: number) => [number, number], mesh: Mesh) {
  const index = new Map<string, number>();
  const add = (p: { X: number; Y: number }) => {
    const key = `${p.X},${p.Y}`;
    let i = index.get(key);
    if (i === undefined) {
      i = mesh.positions.length / 4;
      const x = p.X / MM + origin[0], y = p.Y / MM + origin[1];
      mesh.positions.push(x, y, ...vertex(x, y));
      index.set(key, i);
    }
    return i;
  };
  const cells = cellM > 0 ? [0, 1].flatMap((colour) => polygons(shape, checkerboard(bounds(shape), cellM * MM, colour))) : polygons(shape);
  for (const { outer, holes } of cells) {
    const rings = [outer, ...holes];
    const flat = rings.flatMap((r) => r.flatMap((p) => [p.X, p.Y]));
    const starts = rings.slice(0, -1).reduce<number[]>((s, r) => [...s, (s[s.length - 1] ?? 0) + r.length], []);
    const all = rings.flat();
    for (const k of earcut(flat, starts)) mesh.indices.push(add(all[k]));
  }
}

/** Vertical faces from every outline edge down (or up) to the ground, reaching PAVED.skirtDepthM into it. x, y, z per vertex. */
function skirt(shape: Shape, height: (x: number, y: number) => number, ground: (x: number, y: number) => number): Mesh {
  const mesh: Mesh = { positions: [], indices: [] };
  for (const path of shape) {
    const ring = toRing(path).map(([x, y]) => {
      const z = height(x, y), g = ground(x, y);
      return { x, y, top: Math.max(z, g), bottom: Math.min(z, g) - PAVED.skirtDepthM };
    });
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      const at = mesh.positions.length / 3;
      mesh.positions.push(a.x, a.y, a.top, b.x, b.y, b.top, b.x, b.y, b.bottom, a.x, a.y, a.bottom);
      mesh.indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
    });
  }
  return mesh;
}

/** A shape as rings without holes (a polygon with holes is cut into strips through each hole): what a terrain cut-out needs. */
function withoutHoles(shape: Shape): Ring[] {
  const out: Ring[] = [];
  for (const { outer, holes } of polygons(shape)) {
    if (!holes.length) { out.push(toRing(outer)); continue; }
    const box = bounds([outer]);
    const cuts = [...new Set(holes.map((h) => { const b = bounds([h]); return Math.round((b.minX + b.maxX) / 2); }))].sort((a, b) => a - b);
    const xs = [box.minX - 1, ...cuts, box.maxX + 1];
    for (const colour of [0, 1]) {
      const strips = xs.slice(0, -1).flatMap((x, i) => (i % 2 === colour ? [[{ X: x, Y: box.minY - 1 }, { X: xs[i + 1], Y: box.minY - 1 }, { X: xs[i + 1], Y: box.maxY + 1 }, { X: x, Y: box.maxY + 1 }]] : []));
      for (const piece of both([outer, ...holes], strips)) if (ClipperLib.Clipper.Orientation(piece)) out.push(toRing(piece));
    }
  }
  return out;
}

export type PavedSurfaces = {
  /** One entry per material that has anything, in MATERIALS order. */
  surfaces: {
    material: Material;
    /** x, y, height, edge (0 surface colour ... 1 rim colour) per vertex. */
    mesh: Mesh;
    /** x, y, z per vertex: the vertical faces between the outline and the ground. */
    skirt: Mesh;
    /** The outline as rings without holes: the ground inside is hidden. */
    outline: Ring[];
  }[];
  /** Pedestrian ways drawn as part of the black paved surface. */
  joinedRoadIds: string[];
  /** Per surface road: drawn at its stored height, or on the smoothed ground. */
  heightSource: Record<string, 'stored' | 'ground'>;
  /** For checks: the merged outline before smoothing and building clip, and after (rings in metres, holes included). */
  rawOutline: Ring[];
  outline: Ring[];
};

/**
 * All ground surfaces: union per material, one pooled outline for everything (so surfaces that touch stay joined),
 * clipped against the buildings, split by material, triangulated at the surface height with a rim and a skirt.
 * Underground roads are not part of it (road-surface.ts draws them at their stored height).
 */
export function buildPavedSurfaces(input: { roads: SurfaceRoad[]; areas: SurfaceArea[]; buildings: Ring[][]; ground: (x: number, y: number) => number }): PavedSurfaces {
  const roads = input.roads.filter((r) => surfaceKind(r) !== null && !isUnderground(r));
  const first = roads[0]?.geometry.coordinates[0] ?? input.areas[0]?.rings[0][0];
  if (!first) return { surfaces: [], joinedRoadIds: [], heightSource: {}, rawOutline: [], outline: [] };
  const joinedRoadIds = pavedRoadIds(roads, input.areas.filter((a) => a.fill === 'asphalt').map((a) => a.rings));
  origin = [Math.floor(first[0]), Math.floor(first[1])];

  // the pieces of each material: road bands, a disc where two or more roads of one material meet, the areas
  const raw = new Map<Material, Shape>(MATERIALS.map((m) => [m, []]));
  const lines: { line: P3[]; halfWidthM: number }[] = [];
  const heightSource: Record<string, 'stored' | 'ground'> = {};
  const nodes = new Map<string, { at: number[]; radius: number; roads: number }>();
  for (const road of roads) {
    const material: Material = joinedRoadIds.includes(road.id) ? 'carriageway' : surfaceKind(road)!;
    const centre = smoothCentreline(road.geometry.coordinates);
    if (centre.length < 2) continue;
    const width = roadWidthM(road);
    raw.get(material)!.push(...band(centre, width));
    const profile = roadProfile(centre, input.ground);
    lines.push({ line: profile.line, halfWidthM: width / 2 });
    heightSource[road.id] = profile.source;
    for (const [id, at] of [[road.fromNodeId, centre[0]], [road.toNodeId, centre[centre.length - 1]]] as const) {
      const node = nodes.get(`${material}:${id}`) ?? { at, radius: 0, roads: 0 };
      node.radius = Math.max(node.radius, width / 2);
      node.roads++;
      nodes.set(`${material}:${id}`, node);
    }
  }
  for (const [key, node] of nodes) if (node.roads >= 2) raw.get(key.split(':')[0] as Material)!.push(...disc(node.at, node.radius));
  for (const area of input.areas) raw.get(area.fill === 'field' ? 'field' : 'carriageway')!.push(...polygonShape(area.rings));
  for (const m of MATERIALS) raw.set(m, union(raw.get(m)!));

  // one outline for everything, pooled, kept out of the buildings
  const buildings = union(...input.buildings.map(polygonShape));
  const everything = union(...raw.values());
  const whole = opening(minus(pool(everything), buildings), PAVED.sliverM);

  // split by material: each takes its own pooled shape out of the whole, in order; what is left over (the rounded
  // inner corners between two materials, and the field) goes to the field where it lies on the field, otherwise to the pedestrian ways
  const parts = new Map<Material, Shape>();
  let rest = whole;
  for (const m of MATERIALS.slice(0, -1)) {
    const mine = raw.get(m)!.length ? both(rest, grow(pool(raw.get(m)!), 0.05)) : [];
    parts.set(m, mine);
    rest = minus(rest, mine);
  }
  const field = raw.get('field')!;
  const leftovers = polygons(rest).map(({ outer, holes }) => [outer, ...holes]);
  const onField = (piece: Shape) => field.length > 0 && both(piece, field).length > 0;
  parts.set('pedestrian', union(parts.get('pedestrian')!, leftovers.filter((p) => !onField(p)).flat()));
  parts.set('field', leftovers.filter(onField).flat());

  const levels = input.areas.filter((a) => a.elevationM != null).map((a) => ({ ring: a.rings[0], z: a.elevationM! }));
  const height = surfaceHeight(lines, levels, input.ground);
  const fieldZ = input.areas.find((a) => a.fill === 'field' && a.elevationM != null)?.elevationM;
  const inner = grow(whole, -PAVED.rimWidthM);
  const toEdge = ringGrid(whole.map(toRing), PAVED.rimWidthM);

  const surfaces: PavedSurfaces['surfaces'] = [];
  for (const m of MATERIALS) {
    const shape = densify(parts.get(m)!, PAVED.outlineStepM);
    if (!shape.length) continue;
    const level = m === 'field' && fieldZ != null;
    const z = level ? () => fieldZ : height;
    const mesh: Mesh = { positions: [], indices: [] };
    triangulate(both(shape, inner), level ? 0 : PAVED.cellM, (x, y) => [z(x, y), 0], mesh);
    triangulate(minus(shape, inner), level ? 0 : PAVED.cellM, (x, y) => {
      const t = 1 - Math.min(1, toEdge(x, y) / PAVED.rimWidthM);
      return [z(x, y), t * t * (3 - 2 * t)];
    }, mesh);
    surfaces.push({ material: m, mesh, skirt: skirt(shape, z, input.ground), outline: withoutHoles(ClipperLib.Clipper.CleanPolygons(parts.get(m)!, 0.02 * MM)) });
  }
  return { surfaces, joinedRoadIds, heightSource, rawOutline: everything.map(toRing), outline: whole.map(toRing) };
}

/** Test and measuring helpers: the same operations on plain rings in metres. */
export const pavedGeometry = {
  /** Union of polygons (each a list of rings, outer first); rings of the result in metres, holes included. */
  union(polys: Ring[][]): Ring[] {
    origin = polys[0][0][0].map(Math.floor);
    return union(...polys.map(polygonShape)).map(toRing);
  },
  /** The pooled outline of the union of the polygons, with the buildings cut out. */
  pool(polys: Ring[][], buildings: Ring[][] = []): Ring[] {
    origin = polys[0][0][0].map(Math.floor);
    return opening(minus(pool(union(...polys.map(polygonShape))), union(...buildings.map(polygonShape))), PAVED.sliverM).map(toRing);
  },
  /** A road band (centreline widened to the width). */
  band(centre: number[][], widthM: number): Ring[] {
    origin = centre[0].slice(0, 2).map(Math.floor);
    return band(centre, widthM).map(toRing);
  },
  /** Signed area of rings (holes count negative). */
  area: (rings: Ring[]) => Math.abs(rings.reduce((s, r) => s + r.reduce((a, p, i) => a + (p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1]) / 2, 0), 0)),
  /** Area that two sets of rings share. */
  overlap(a: Ring[], b: Ring[]): number {
    origin = a[0][0].map(Math.floor);
    return pavedGeometry.area(both(union(a.map(toPath)), union(b.map(toPath))).map(toRing));
  },
  /** How far the outline `of` is from the outline `from`: every point of `of` (resampled at 0.25 m) to the nearest edge of `from`. */
  deviation(of: Ring[], from: Ring[]): { median: number; p95: number; max: number } {
    const all = from.flatMap((ring) => ring.map((p, i) => [p, ring[(i + 1) % ring.length]]));
    const grid = new SegmentGrid<null>(4, 4);
    for (const [a, b] of all) grid.add(a, b, null);
    const ds = of.flatMap((ring) => resample(ring, 0.25).map(([x, y]) => {
      const near = grid.near(x, y).reduce((best, s) => Math.min(best, toSegment(x, y, s.a, s.b).d), Infinity);
      return near < 4 ? near : all.reduce((best, [a, b]) => Math.min(best, toSegment(x, y, a, b).d), Infinity);
    })).sort((p, q) => p - q);
    return { median: ds[ds.length >> 1], p95: ds[Math.floor(ds.length * 0.95)], max: ds[ds.length - 1] };
  },
};
