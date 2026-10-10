// Built structures of the campus as solids (F06): platform solids (기단: the ground itself as built mass, with a flat
// or inclined top and vertical sides down to a bottom), boxes placed on them (stair steps, landings, planters, walls,
// decks, canopies) and voids inside a platform (an underground road). The files and their schema belong to the data
// tasks: frontend/public/structures/*.geojson, docs/audit/g02/STRUCTURES.md (EPSG:5186 metres, heights in properties).
// This file is the pure geometry (tested in test/structures.test.ts); structures-layer.ts draws it.
import earcut from 'earcut';
import { polygonOps, ringArea2, type Polygon, type Ring } from './polygon-ops';
import { planePoint, planeSide, type Mesh, type SectionPlane } from './section';

/** Display and loading constants of the structures. */
export const STRUCTURES = {
  /**
   * /structures/index.json lists the files to read: every *.geojson of frontend/public/structures (vite.config.ts
   * makes the list from the folder, so a new zone file needs no code change). Only when that list cannot be read are
   * these names tried instead (a missing one is simply not there).
   */
  indexFile: 'index.json',
  files: ['g02-way.geojson', 'z02-daeil-front.geojson', 'z03-fountain.geojson'],
  /** Top face colour of a platform by `material`. Paving = the pedestrian paving of the road surfaces (road-surface.ts). */
  materials: { paving: '#9a9388', concrete: '#b9b6ad', rock: '#8d887d', timber: '#a47551', wood: '#a47551', field: '#c9956b', asphalt: '#1b1d20' } as Record<string, string>,
  /** An `asphalt` platform (a public street outside the campus): the carriageway black on top (ROAD_SURFACE.colors.carriageway), these sides. */
  asphaltSide: '#8d887d',
  /** Colour of a box by `type`: light granite steps and landings, grey planter walls, white retaining walls, timber deck, dark tiled canopy, yellow barrier. */
  types: { stair_step: '#d2cdc0', landing: '#c4bfb2', planter: '#a9a59b', wall: '#dfdcd3', deck: '#a47551', canopy: '#7b7068', barrier: '#d8b23f' } as Record<string, string>,
  /** A `planting` platform (a planted bank or a planter band on a wall): its top is the planted green, its sides are this wall colour. */
  plantingSide: '#a9a59b',
  /** A box whose `material` is one of these is drawn in this colour instead of the colour of its `type` (a concrete slab is not a timber deck; `opening` = a dark panel marking a portal in a wall; brick, glass, stone, roof tiles, railings and the trunk and foliage of a simple tree are what the zone files name). */
  boxMaterials: { concrete: '#cfcbc0', opening: '#2f3136', brick: '#9a5f4c', glass: '#5f7482', rail: '#6f675d', roof_tile: '#6a6663', roof_red: '#b5563c', foliage: '#6f8f5c', trunk: '#6b5743', stone: '#bdb7a8', white_stone: '#e6e3da', red_railing: '#a8473a', timber: '#a47551', water: '#7fb9cf', fence: '#5f6a5c' } as Record<string, string>,
  /** The planted top of a planter: a muted green. */
  planterTop: '#7f9a6b',
  /** A material or type this table does not know. */
  unknown: '#b9b4a8',
  /** Voids (shown with the underground ways, and as a hole on the cut face). */
  void: '#5c6470',
  voidFace: '#eef0ec',
  /**
   * Faces are shaded by where they face, without scene lighting (the surfaces around them are unlit too): the top
   * face has the colour itself, a side face is darker, a little less so when it faces the light (from the south-west,
   * as the scene light of campus-map.ts), the underside is darkest.
   */
  light: [-0.646, -0.763],
  sideShade: 0.72,
  sideContrast: 0.12,
  bottomShade: 0.5,
  /** Thin lines along the top edges of these types, so steps read as steps from straight above too (not platforms: two platforms at one height would show a line across one floor). */
  outlined: ['stair_step', 'landing', 'deck', 'canopy'],
  outlineShade: 0.55,
};

/**
 * Who wins where a structure and a merged road / area surface (paved-surface.ts) describe the same ground. The one
 * place for these rules:
 *  1. Inside the outline of a platform the platform is the geometry. A road or an area there is not drawn at its own
 *     height: its material only colours the top of the platform (a carriageway on a platform is a black part of that
 *     platform's plane). Only the materials of `platformTints` do: a pedestrian way does not paint over a platform
 *     (the platform is itself the walking surface, as with the sports field), and a `stairs` ribbon does not either
 *     (a platform top is a plane; a stair on it has to be a structure).
 *     Where one material covers at least `sameSurfaceShare` of a platform, the two describe the same surface: the
 *     whole platform top gets that colour, with the platform's own built outline (not the rounded outline of the area).
 *     Outside the platform a road keeps its own height, except that it runs into the platform top without a step
 *     when the two are within PAVED.platformFlushM of each other at the platform's edge (paved-surface.ts); a larger
 *     difference stays a wall face.
 *  2. Under a structure stair step or landing no road or area surface is drawn (the box is the surface).
 *  3. The flat ribbon of a `stairs` road is also removed within `stairRibbonReachM` of a structure step or landing:
 *     the two are the same stair when they overlap (the schema has no road id to link them), and the ribbon is
 *     usually a little off and wider or narrower than the steps.
 *  4. An open area that is only drawn as a translucent overlay (mobility-map.ts) is not drawn when at least
 *     `areaOnPlatformShare` of it lies on platforms: the platform is that ground.
 */
export const PRECEDENCE = { stairRibbonReachM: 1, platformTints: ['carriageway', 'crossing', 'field'], sameSurfaceShare: 0.8, areaOnPlatformShare: 0.5 };

/** An inclined top: height at a point = the value at its distance along `direction` from `origin` (linear between points, the end values outside). */
export type TopProfile = { origin: number[]; direction: number[]; points: number[][] };
export type Solid = {
  id: string;
  file: string;
  /** platform: ground as built mass; box: anything placed on it; void: empty space inside a platform. */
  role: 'platform' | 'box' | 'void';
  /** `type` of the schema (stair_step, landing, planter, wall, deck, canopy, barrier, platform, void, or one not known yet). */
  type: string;
  /** Plan outline in metres: outer ring counter-clockwise, holes clockwise, not closed. */
  polygon: Polygon;
  bottomM: number;
  /** The top height (with a profile: its highest point). */
  topM: number;
  profile?: TopProfile;
  material?: string;
  /** The stair a step belongs to. */
  stair?: string;
  estimated: boolean;
  /** Every property of the feature as written (for the detail panel). */
  props: Record<string, unknown>;
};

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pair = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 2 && num(v[0]) && num(v[1]);

/** The polygons of a GeoJSON geometry as open rings, outer counter-clockwise and holes clockwise; [] when it is not a valid polygon. */
function polygonsOf(geometry: any): Polygon[] {
  const polys: unknown = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  if (!Array.isArray(polys)) return [];
  const out: Polygon[] = [];
  for (const poly of polys) {
    if (!Array.isArray(poly) || !poly.length) return [];
    const rings: Ring[] = [];
    for (const [k, raw] of poly.entries()) {
      if (!Array.isArray(raw) || !raw.every(pair)) return [];
      let ring: Ring = raw.map((c: number[]) => [c[0], c[1]]);
      if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring = ring.slice(0, -1);
      if (ring.length < 3) return [];
      rings.push(ringArea2(ring) > 0 === (k === 0) ? ring : [...ring].reverse());
    }
    out.push(rings);
  }
  return out;
}

function profileOf(v: any): TopProfile | null {
  if (!v || !pair(v.origin) || !pair(v.direction) || !Array.isArray(v.points) || v.points.length < 2 || !v.points.every(pair)) return null;
  const length = Math.hypot(v.direction[0], v.direction[1]);
  if (!(length > 0)) return null;
  const points = [...(v.points as number[][])].map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0]);
  return { origin: [v.origin[0], v.origin[1]], direction: [v.direction[0] / length, v.direction[1] / length], points };
}

/** Height of the top of a solid at a plan point. */
export function topHeight(solid: Pick<Solid, 'topM' | 'profile'>): (x: number, y: number) => number {
  const p = solid.profile;
  if (!p) return () => solid.topM;
  return (x, y) => {
    const d = (x - p.origin[0]) * p.direction[0] + (y - p.origin[1]) * p.direction[1];
    const pts = p.points;
    if (d <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (d <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (d - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0] || 1);
    }
    return pts[pts.length - 1][1];
  };
}

/** The part of a ring (not closed) where `along` (distance in direction `dir` from `origin`) lies between `from` and `to`. */
function slice(ring: Ring, origin: number[], dir: number[], from: number, to: number): Ring {
  const clip = (r: Ring, at: number, sign: number): Ring => {
    const side = (p: number[]) => sign * ((p[0] - origin[0]) * dir[0] + (p[1] - origin[1]) * dir[1] - at);
    const out: Ring = [];
    r.forEach((p, i) => {
      const q = r[(i + 1) % r.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    });
    return out.length >= 3 ? out : [];
  };
  const kept = clip(ring, from, 1);
  return kept.length ? clip(kept, to, -1) : [];
}

/**
 * A stair between two heights as real steps: the outline is cut across the climbing direction into `risers` equal
 * treads, and tread k (1 = lowest) is a box from `baseM` (default: the foot height) up to fromM + k × rise, where
 * rise = (toM − fromM) / risers. The last tread is exactly at `toM`. With `sideWallM` > 0 each tread also gets a thin
 * wall of that height above it along both sides (thickness `sideWallThicknessM`, default 0.2 m).
 */
export function stairSteps(stair: {
  ring: Ring; direction: number[]; fromM: number; toM: number; risers: number; baseM?: number; sideWallM?: number; sideWallThicknessM?: number;
}): { steps: { ring: Ring; fromM: number; toM: number }[]; walls: { ring: Ring; fromM: number; toM: number }[] } {
  const n = Math.max(1, Math.round(stair.risers));
  const length = Math.hypot(stair.direction[0], stair.direction[1]);
  const dir = [stair.direction[0] / length, stair.direction[1] / length];
  const across = [-dir[1], dir[0]];
  const o = stair.ring[0];
  const along = stair.ring.map((p) => (p[0] - o[0]) * dir[0] + (p[1] - o[1]) * dir[1]);
  const lo = Math.min(...along), hi = Math.max(...along);
  const base = stair.baseM ?? stair.fromM;
  const steps: { ring: Ring; fromM: number; toM: number }[] = [];
  const walls: { ring: Ring; fromM: number; toM: number }[] = [];
  for (let k = 1; k <= n; k++) {
    const ring = slice(stair.ring, o, dir, lo + ((hi - lo) * (k - 1)) / n, lo + ((hi - lo) * k) / n);
    if (!ring.length) continue;
    const top = k === n ? stair.toM : stair.fromM + ((stair.toM - stair.fromM) * k) / n;
    steps.push({ ring, fromM: base, toM: top });
    if (!(stair.sideWallM && stair.sideWallM > 0)) continue;
    const side = ring.map((p) => (p[0] - o[0]) * across[0] + (p[1] - o[1]) * across[1]);
    const left = Math.min(...side), right = Math.max(...side);
    const t = Math.min(stair.sideWallThicknessM ?? 0.2, (right - left) / 2);
    for (const [a, b] of [[left, left + t], [right - t, right]]) {
      const wall = slice(ring, o, across, a, b);
      if (wall.length) walls.push({ ring: wall, fromM: base, toM: top + stair.sideWallM });
    }
  }
  return { steps, walls };
}

/**
 * The solids of one structures file. Read defensively, because the files grow and get new kinds:
 *  - `platform` (or anything with a top (`topM` or `topProfile`) and a `bottomM`): a prism with that top and bottom;
 *  - `void`, `extrude` and any other kind with `fromM` < `toM`: a box between the two heights;
 *  - a `stair` with `risers`, `direction`, `fromM` < `toM`: steps made by stairSteps (not in the files yet);
 *  - everything else is skipped and named in `skipped` (never an exception).
 */
export function parseStructures(file: string, fc: any): { solids: Solid[]; skipped: string[] } {
  const solids: Solid[] = [];
  const skipped: string[] = [];
  const crs = String(fc?.crs?.properties?.name ?? '');
  if (!Array.isArray(fc?.features)) return { solids, skipped: [`${file}: FeatureCollection 아님`] };
  if (crs && !crs.includes('5186')) return { solids, skipped: [`${file}: 좌표계 ${crs} (EPSG:5186 이어야 함)`] };
  fc.features.forEach((f: any, i: number) => {
    const p: Record<string, unknown> = f?.properties && typeof f.properties === 'object' ? f.properties : {};
    const id = String(p.id ?? `${file}#${i}`);
    const kind = String(p.kind ?? '');
    const type = String(p.type ?? (kind || 'unknown'));
    const polygons = polygonsOf(f?.geometry);
    if (!polygons.length) { skipped.push(`${id} (도형 없음·잘못됨)`); return; }
    const base = { file, type, estimated: p.estimated === true, props: p, material: typeof p.material === 'string' ? p.material : undefined, stair: typeof p.stair === 'string' ? p.stair : undefined };
    const profile = profileOf(p.topProfile);
    const top = profile ? Math.max(...profile.points.map((q) => q[1])) : num(p.topM) ? p.topM : null;
    const lowestTop = profile ? Math.min(...profile.points.map((q) => q[1])) : top;
    const box = num(p.fromM) && num(p.toM) && p.toM > p.fromM;
    if (kind === 'void' || type === 'void') {
      if (!box) { skipped.push(`${id} (빈 곳인데 fromM < toM 아님)`); return; }
      for (const polygon of polygons) solids.push({ ...base, id, role: 'void', polygon, bottomM: p.fromM as number, topM: p.toM as number });
    } else if ((kind === 'stair' || type === 'stair') && box && num(p.risers) && p.risers >= 1 && pair(p.direction) && Math.hypot(p.direction[0], p.direction[1]) > 0) {
      const made = stairSteps({ ring: polygons[0][0], direction: p.direction, fromM: p.fromM as number, toM: p.toM as number, risers: p.risers, baseM: num(p.baseM) ? p.baseM : undefined, sideWallM: num(p.sideWallM) ? p.sideWallM : undefined, sideWallThicknessM: num(p.sideWallThicknessM) ? p.sideWallThicknessM : undefined });
      made.steps.forEach((s, k) => solids.push({ ...base, id, type: 'stair_step', stair: id, role: 'box', polygon: [s.ring], bottomM: s.fromM, topM: s.toM, props: { ...p, step: k + 1 } }));
      for (const w of made.walls) solids.push({ ...base, id, type: 'wall', role: 'box', polygon: [w.ring], bottomM: w.fromM, topM: w.toM });
    } else if (top !== null && num(p.bottomM) && p.bottomM < (lowestTop as number)) {
      // a platform, or an unknown kind written like one: it is ground only when it says so
      for (const polygon of polygons) solids.push({ ...base, id, role: kind === 'platform' ? 'platform' : 'box', polygon, bottomM: p.bottomM, topM: top, profile: profile ?? undefined });
    } else if (box) {
      for (const polygon of polygons) solids.push({ ...base, id, role: 'box', polygon, bottomM: p.fromM as number, topM: p.toM as number });
    } else {
      skipped.push(`${id} (kind=${kind || '없음'}: 윗면·바닥 높이 없음)`);
    }
  });
  return { solids, skipped };
}

// ---------- meshes ----------
/** Numbers per vertex of a solid mesh: x, y, height, shade (brightness of the face), top (1 on the top face, else 0). */
export const SOLID_STRIDE = 5;

/** The polygons cut along the kinks of the profile, so that the top of each piece is one true plane. */
function planarPieces(polygons: Polygon[], profile?: TopProfile): Polygon[] {
  const clean = polygonOps('union', polygons);
  if (!profile || !clean.length) return clean;
  const R = 5000;
  const [ox, oy] = profile.origin, [dx, dy] = profile.direction;
  const cuts = [-R, ...profile.points.map((p) => p[0]), R];
  const out: Polygon[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (!(b > a)) continue;
    const at = (d: number, s: number) => [ox + dx * d - dy * s, oy + dy * d + dx * s];
    out.push(...polygonOps('both', clean, [[[at(a, -R), at(b, -R), at(b, R), at(a, R)]]]));
  }
  return out;
}

/** Triangles of the pieces with shared vertices (counter-clockwise), and the outline edges (a → b with the inside on the left). */
function triangles(polygons: Polygon[], profile?: TopProfile) {
  const xy: number[][] = [];
  const index = new Map<string, number>();
  const tris: number[] = [];
  const add = (p: number[]) => {
    const key = `${p[0]},${p[1]}`;
    let i = index.get(key);
    if (i === undefined) { i = xy.length; xy.push(p); index.set(key, i); }
    return i;
  };
  for (const poly of planarPieces(polygons, profile)) {
    const all = poly.flat();
    const starts = poly.slice(0, -1).reduce<number[]>((s, r) => [...s, (s[s.length - 1] ?? 0) + r.length], []);
    const ids = earcut(all.flatMap((p) => [p[0], p[1]]), starts);
    for (let k = 0; k < ids.length; k += 3) {
      const [a, b, c] = [add(all[ids[k]]), add(all[ids[k + 1]]), add(all[ids[k + 2]])];
      if (a === b || b === c || a === c) continue;
      const area2 = ringArea2([xy[a], xy[b], xy[c]]);
      tris.push(a, area2 >= 0 ? b : c, area2 >= 0 ? c : b);
    }
  }
  const directed = new Set<string>();
  for (let k = 0; k < tris.length; k += 3) for (let e = 0; e < 3; e++) directed.add(`${tris[k + e]}>${tris[k + (e + 1) % 3]}`);
  const outline: [number, number][] = [];
  for (const key of directed) {
    const [a, b] = key.split('>').map(Number);
    if (!directed.has(`${b}>${a}`)) outline.push([a, b]);
  }
  return { xy, tris, outline };
}

/**
 * A solid as triangles (SOLID_STRIDE numbers per vertex): the top face (a true plane, or the planes of its profile),
 * the vertical side faces along the whole outline down to the bottom, and the underside. Closed: every edge is shared
 * by two faces. `edges` are the top outline as 3D segments. `bottomAt` may lower the bottom at a point (the sides then
 * reach whatever lies below, so nothing hangs); `polygons` replaces the plan outline (a platform with the buildings cut
 * out); `top: false` leaves the top face out (it is then drawn in pieces with topMesh).
 */
export function solidMesh(solid: Solid, options: {
  bottomAt?: (x: number, y: number) => number; polygons?: Polygon[]; top?: boolean;
  /** A side face is left out when this says so for the point 5 cm outside the middle of its top edge (x, y, top height there): it lies inside a neighbour. */
  hiddenSide?: (x: number, y: number, z: number) => boolean;
} = {}): { mesh: Mesh; edges: number[][][] } {
  const { xy, tris, outline } = triangles(options.polygons ?? [solid.polygon], solid.profile);
  const top = topHeight(solid);
  const bottomAt = options.bottomAt;
  const bottom = (x: number, y: number) => (bottomAt ? Math.min(solid.bottomM, bottomAt(x, y)) : solid.bottomM);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [x, y] of xy) positions.push(x, y, top(x, y), 1, 1);
  if (options.top !== false) indices.push(...tris);
  for (const [x, y] of xy) positions.push(x, y, bottom(x, y), STRUCTURES.bottomShade, 0);
  for (let k = 0; k < tris.length; k += 3) indices.push(xy.length + tris[k], xy.length + tris[k + 2], xy.length + tris[k + 1]);
  const edges: number[][][] = [];
  for (const [i, j] of outline) {
    const a = xy[i], b = xy[j];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    if (options.hiddenSide) {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (options.hiddenSide(mx + ((b[1] - a[1]) / length) * 0.05, my - ((b[0] - a[0]) / length) * 0.05, top(mx, my))) continue;
    }
    const facing = ((b[1] - a[1]) * STRUCTURES.light[0] - (b[0] - a[0]) * STRUCTURES.light[1]) / length; // outward normal · towards the light
    const shade = STRUCTURES.sideShade + STRUCTURES.sideContrast * facing;
    const at = positions.length / SOLID_STRIDE;
    positions.push(a[0], a[1], top(a[0], a[1]), shade, 0, b[0], b[1], top(b[0], b[1]), shade, 0, b[0], b[1], bottom(b[0], b[1]), shade, 0, a[0], a[1], bottom(a[0], a[1]), shade, 0);
    indices.push(at, at + 2, at + 1, at, at + 3, at + 2);
    edges.push([[a[0], a[1], top(a[0], a[1])], [b[0], b[1], top(b[0], b[1])]]);
  }
  return { mesh: { positions, indices }, edges };
}

/** Only the top face of a solid over the given plan polygons (x, y, height per vertex): the part of a platform top a road colours. */
export function topMesh(solid: Solid, polygons: Polygon[]): Mesh {
  const { xy, tris } = triangles(polygons, solid.profile);
  const top = topHeight(solid);
  return { positions: xy.flatMap(([x, y]) => [x, y, top(x, y)]), indices: tris };
}

// ---------- cross-section ----------
/** The stretches [from, to] (distance from A, within A..B) of the section line inside a polygon (holes left out). */
export function polygonIntervals(plane: SectionPlane, polygon: Polygon): [number, number][] {
  const ds: number[] = [];
  for (const ring of polygon) {
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const sp = planeSide(plane, p), sq = planeSide(plane, q);
      if (sp >= 0 === sq >= 0) return;
      const t = sp / (sp - sq);
      ds.push((p[0] + (q[0] - p[0]) * t - plane.a[0]) * plane.u[0] + (p[1] + (q[1] - p[1]) * t - plane.a[1]) * plane.u[1]);
    });
  }
  ds.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ds.length; i += 2) {
    const from = Math.max(0, ds[i]), to = Math.min(plane.length, ds[i + 1]);
    if (to > from) out.push([from, to]);
  }
  return out;
}

/**
 * The face a section plane cuts through a solid: polygons in the plane, each point [distance from A, height]. The
 * voids are taken out of it (an underground road inside a platform is a hole in the cut face).
 */
export function sectionCaps(plane: SectionPlane, solid: Solid, voids: Solid[] = [], polygons: Polygon[] = [solid.polygon]): Polygon[] {
  const top = topHeight(solid);
  const caps: Polygon[] = [];
  for (const polygon of polygons) {
    for (const [from, to] of polygonIntervals(plane, polygon)) {
      const ds = [from, to];
      if (solid.profile) {
        const p = solid.profile;
        const rate = plane.u[0] * p.direction[0] + plane.u[1] * p.direction[1];
        const start = (plane.a[0] - p.origin[0]) * p.direction[0] + (plane.a[1] - p.origin[1]) * p.direction[1];
        if (Math.abs(rate) > 1e-9) for (const [s] of p.points) { const d = (s - start) / rate; if (d > from && d < to) ds.push(d); }
      }
      ds.sort((a, b) => b - a);
      caps.push([[[from, solid.bottomM], [to, solid.bottomM], ...ds.map((d) => { const [x, y] = planePoint(plane, d); return [d, top(x, y)]; })]]);
    }
  }
  const holes = voids.flatMap((v) => polygonIntervals(plane, v.polygon).map(([from, to]): Polygon => [[[from, v.bottomM], [to, v.bottomM], [to, v.topM], [from, v.topM]]]));
  return holes.length ? polygonOps('minus', caps, holes) : polygonOps('union', caps);
}

/** Flat triangles of polygons in any plane coordinates: [a, b] per vertex. */
export function fillPolygons(polygons: Polygon[]): { points: number[][]; indices: number[] } {
  const points: number[][] = [];
  const indices: number[] = [];
  for (const poly of polygons) {
    const all = poly.flat();
    const starts = poly.slice(0, -1).reduce<number[]>((s, r) => [...s, (s[s.length - 1] ?? 0) + r.length], []);
    for (const k of earcut(all.flatMap((p) => [p[0], p[1]]), starts)) indices.push(points.length + k);
    points.push(...all);
  }
  return { points, indices };
}

// ---------- what the road surfaces leave to the structures ----------
/** The plan outlines the merged road surfaces give way to (see PRECEDENCE): the platforms, and the stair steps and landings. */
export function surfaceExclusions(solids: Solid[]): { platforms: { polygon: Polygon; top: (x: number, y: number) => number }[]; treads: Polygon[] } {
  return {
    platforms: solids.filter((s) => s.role === 'platform').map((s) => ({ polygon: s.polygon, top: topHeight(s) })),
    treads: solids.filter((s) => s.role === 'box' && (s.type === 'stair_step' || s.type === 'landing')).map((s) => s.polygon),
  };
}

/** The colour of the sides of a solid and of its top face. */
export function solidColors(solid: Solid): { body: string; top: string } {
  if (solid.role === 'void') return { body: STRUCTURES.void, top: STRUCTURES.void };
  const body = solid.role === 'platform' ? STRUCTURES.materials[solid.material ?? ''] ?? STRUCTURES.unknown
    : STRUCTURES.boxMaterials[solid.material ?? ''] ?? STRUCTURES.types[solid.type] ?? STRUCTURES.materials[solid.material ?? ''] ?? STRUCTURES.unknown;
  if (solid.role === 'platform' && solid.material === 'planting') return { body: STRUCTURES.plantingSide, top: STRUCTURES.planterTop };
  if (solid.role === 'platform' && solid.material === 'asphalt') return { body: STRUCTURES.asphaltSide, top: STRUCTURES.materials.asphalt };
  // Z07: a box may carry its own colour (`color`, and `topColor` for its top face) instead of a material of the table
  const own = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v) ? v : null);
  const color = solid.role === 'box' ? own(solid.props?.color) : null;
  const top = (solid.role === 'box' ? own(solid.props?.topColor) : null) ?? (solid.type === 'planter' ? STRUCTURES.planterTop : color ?? body);
  return { body: color ?? body, top };
}
