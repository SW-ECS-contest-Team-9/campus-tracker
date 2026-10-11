// "층 따로 보기" (F08), the pure part (tested in test/level-view.test.ts; level-view-layer.ts draws it):
//  - 구획 (zones): the partition of the campus in frontend/public/zones.geojson (docs/audit/f08/build_zones.py). It is
//    Claude's working partition, not a fact about the campus. A ground zone has only an outline; an underground zone
//    also has a height range (fromM..toM) and, when its floor is level, floorM.
//  - what belongs to a zone: roads cut at its boundary (with a short stub where a road goes on into a neighbour),
//    areas, structure solids, places;
//  - the floors of a building: the floor table of its note (scene API, appearance.windows.floorsM) plus the heights
//    where level indoor roads actually are. A floor is only named when a road says so (levelId or its name).
//    Nothing is invented: a table floor without a name stays a height.
//  - explode(): the height map that pulls the floors of a building apart;
//  - the first-person walk (first-person.ts): which surface is under the feet.
import { floorFromLevelId } from './floor-colors';
import { polygonContains, type Polygon } from './polygon-ops';
import { isUnderground, isUndergroundArea } from './road-surface';
import { topHeight, type Solid } from './structures';

export const LEVEL_VIEW = {
  /** The lowest point of what is lifted goes this far above the highest roof of the campus model. */
  clearRoofM: 15,
  /** Extra space between two floors of an exploded building (on top of their true difference). */
  floorGapM: 7,
  /** A road whose heights differ by more than this joins two floors (stairs, ramp, elevator); less: it lies on one floor. */
  levelSpanM: 0.9,
  /** A level road belongs to a floor of the table when it is within this of it; else its own height is a floor. */
  floorMatchM: 1.0,
  /** A floor of the table is shown when it is not more than this below the lowest base of the building's blocks. */
  belowBaseM: 2.5,
  /** Length of the stub of a road that goes on into a neighbouring zone. */
  stubM: 6,
  /** Height tolerance of an underground zone's range for roads and clicks. */
  rangeSlackM: 0.6,
};

export type LvRoad = {
  id: string; name: string | null; roadClass: string; structure: string; widthM: number | null; levelId: string | null; buildingId: string | null;
  fromNodeId?: string; toNodeId?: string; geometry: { coordinates: number[][] };
};
/** An open area with its rings in metres (EPSG:5186), closed or not. */
export type LvArea = { id: number | string; name: string | null; elevationM: number | null; buildingId?: string | null; floor?: string | null; rings: number[][][] };
export type LvPlace = { id: string; name: string; category?: string; buildingId: string | null; x: number; y: number; z: number };
export type Zone = {
  id: string; name: string; description: string; note: string; layer: 'ground' | 'underground';
  polygons: Polygon[]; fromM?: number; toM?: number; floorM?: number;
};

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const open = (ring: number[][]) => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);

/** The zones of zones.geojson; a feature that is not a usable polygon is left out. */
export function parseZones(fc: any): Zone[] {
  const zones: Zone[] = [];
  for (const f of Array.isArray(fc?.features) ? fc.features : []) {
    const p = f?.properties ?? {};
    const coords: unknown = f?.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f?.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : null;
    if (!Array.isArray(coords) || typeof p.id !== 'string' || typeof p.name !== 'string') continue;
    const polygons = (coords as number[][][][]).map((poly) => poly.map((ring) => open(ring.map((c) => [c[0], c[1]])))).filter((poly) => poly.length && poly[0].length >= 3);
    if (!polygons.length) continue;
    const underground = p.layer === 'underground' && num(p.fromM) && num(p.toM);
    zones.push({
      id: p.id, name: p.name, description: String(p.description ?? ''), note: String(p.note ?? ''), layer: underground ? 'underground' : 'ground', polygons,
      ...(underground ? { fromM: p.fromM, toM: p.toM } : {}), ...(underground && num(p.floorM) ? { floorM: p.floorM } : {}),
    });
  }
  return zones;
}

export const inPolygons = (polygons: Polygon[], x: number, y: number) => polygons.some((p) => polygonContains(x, y, p));
const inRange = (zone: Zone, z: number) => zone.layer === 'ground' || (z >= zone.fromM! - LEVEL_VIEW.rangeSlackM && z <= zone.toM! + LEVEL_VIEW.rangeSlackM);

/**
 * The zone of a point. With a height: an underground zone whose range holds it wins (the user clicked something
 * underground that was visible); otherwise, and without a height, the ground zone there. null: outside the partition.
 */
export function zoneAt(zones: Zone[], x: number, y: number, z?: number): Zone | null {
  if (z !== undefined) {
    const under = zones.find((zone) => zone.layer === 'underground' && inRange(zone, z) && inPolygons(zone.polygons, x, y));
    if (under) return under;
  }
  return zones.find((zone) => zone.layer === 'ground' && inPolygons(zone.polygons, x, y)) ?? null;
}

// ---------- roads cut at a zone boundary ----------
export type RoadCut = {
  /** The parts inside (x, y, z points). */
  pieces: number[][][];
  /** Where the road goes on outside: up to LEVEL_VIEW.stubM of it, starting at the boundary. */
  stubs: number[][][];
  /** Length inside / length of the whole road. */
  share: number;
};

/** Parameters (0..1, sorted) where segment a-b crosses an edge of the polygons. */
function crossings(a: number[], b: number[], polygons: Polygon[]): number[] {
  const out: number[] = [];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const polygon of polygons) for (const ring of polygon) for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den;
    const s = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
    if (t > 1e-9 && t < 1 - 1e-9 && s >= 0 && s <= 1) out.push(t);
  }
  return out.sort((m, n) => m - n);
}

const lerp = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * t];
const dist = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** The first `length` metres of a line. */
function head(points: number[][], length: number): number[][] {
  const out = [points[0]];
  let left = length;
  for (let i = 1; i < points.length && left > 0; i++) {
    const d = dist(points[i - 1], points[i]);
    if (d <= left) out.push(points[i]); else out.push(lerp(points[i - 1], points[i], left / (d || 1)));
    left -= d;
  }
  return out;
}

/**
 * A road line cut by a zone: the line is split where it crosses the outline; a part is inside when its middle is in
 * the polygons and, for an underground zone, in the height range. Display only: the stored road is not changed.
 */
export function cutRoad(coordinates: number[][], zone: Pick<Zone, 'polygons' | 'layer' | 'fromM' | 'toM'>): RoadCut {
  const parts: { a: number[]; b: number[]; inside: boolean }[] = [];
  for (let i = 0; i + 1 < coordinates.length; i++) {
    const a = coordinates[i], b = coordinates[i + 1];
    const ts = [0, ...crossings(a, b, zone.polygons), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-9) continue;
      const p = lerp(a, b, ts[k]), q = lerp(a, b, ts[k + 1]);
      const m = lerp(p, q, 0.5);
      parts.push({ a: p, b: q, inside: inPolygons(zone.polygons, m[0], m[1]) && inRange(zone as Zone, m[2]) });
    }
  }
  const runs: { inside: boolean; points: number[][] }[] = [];
  for (const part of parts) {
    const last = runs[runs.length - 1];
    if (last && last.inside === part.inside) last.points.push(part.b); else runs.push({ inside: part.inside, points: [part.a, part.b] });
  }
  const length = (points: number[][]) => points.reduce((s, p, i) => (i ? s + dist(points[i - 1], p) : 0), 0);
  const pieces = runs.filter((r) => r.inside).map((r) => r.points);
  const stubs: number[][][] = [];
  runs.forEach((run, i) => {
    if (run.inside) return;
    if (runs[i - 1]?.inside) stubs.push(head(run.points, LEVEL_VIEW.stubM));
    if (runs[i + 1]?.inside) stubs.push(head([...run.points].reverse(), LEVEL_VIEW.stubM));
  });
  const total = length(coordinates);
  return { pieces, stubs, share: total > 0 ? pieces.reduce((s, p) => s + length(p), 0) / total : 0 };
}

// ---------- what a zone holds ----------
const centroid = (ring: number[][]) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
const flag = (solid: Solid, key: string) => solid.props?.[key] === true;

export type ZoneContent = {
  roads: { road: LvRoad; cut: RoadCut }[];
  areas: LvArea[];
  /** Solids with the heights to draw them at (an underground zone shows only the part inside its range). */
  solids: { solid: Solid; bottomM: number; topM: number }[];
  places: LvPlace[];
  /** Lowest and highest height of what is drawn. */
  minM: number; maxM: number;
};

/**
 * Everything of a zone.
 *  Ground zone: the roads that are neither indoor (a building's) nor underground, cut at the outline; the areas and
 *  the solids whose middle is inside, without voids and without what is marked as lying in a void or underground.
 *  Underground zone: the roads of no building inside the outline and the height range; the underground areas; every
 *  solid but platforms and voids whose middle is inside and that reaches into the range (cut to the range). A zone
 *  without a level floor (a sloping tunnel) has a wide range that also holds the ground above it: there only roads
 *  that are underground themselves and solids marked as lying in a void or underground count.
 */
export function zoneContent(zone: Zone, data: { roads: LvRoad[]; areas: LvArea[]; solids: Solid[]; places?: LvPlace[] }): ZoneContent {
  const ground = zone.layer === 'ground', level = zone.floorM !== undefined;
  const inside = (p: number[]) => inPolygons(zone.polygons, p[0], p[1]);
  const roads = data.roads
    .filter((r) => !r.buildingId && r.structure !== 'elevator' && (ground ? !isUnderground(r) : level || isUnderground(r)))
    .map((road) => ({ road, cut: cutRoad(road.geometry.coordinates, zone) }))
    .filter((r) => r.cut.pieces.length);
  const areas = data.areas.filter((a) => a.rings[0]?.length && inside(centroid(open(a.rings[0])))
    && (ground ? !isUndergroundArea(a) : a.elevationM != null && inRange(zone, a.elevationM)));
  const solids: ZoneContent['solids'] = [];
  for (const solid of data.solids) {
    if (solid.role === 'void' || !inside(centroid(solid.polygon[0]))) continue;
    if (ground) {
      if (flag(solid, 'inVoid') || flag(solid, 'underground')) continue;
      solids.push({ solid, bottomM: solid.bottomM, topM: solid.topM });
    } else if (solid.role === 'box' && solid.topM > zone.fromM! && solid.bottomM < zone.toM! && (level || flag(solid, 'inVoid') || flag(solid, 'underground'))) {
      solids.push({ solid, bottomM: Math.max(solid.bottomM, zone.fromM!), topM: Math.min(solid.topM, zone.toM!) });
    }
  }
  const places = (data.places ?? []).filter((p) => !p.buildingId && inside([p.x, p.y]) && (ground ? true : inRange(zone, p.z)));
  const heights = [
    ...roads.flatMap((r) => r.cut.pieces.flat().map((p) => p[2])),
    ...areas.flatMap((a) => (a.elevationM != null ? [a.elevationM] : [])),
    ...solids.filter((s) => ground ? s.solid.role === 'platform' : true).flatMap((s) => (ground ? [lowestTop(s.solid)] : [s.bottomM, s.topM])),
    ...(zone.floorM !== undefined ? [zone.floorM] : []),
  ];
  const minM = heights.length ? Math.min(...heights) : zone.fromM ?? 0;
  const maxM = Math.max(minM, ...heights, ...solids.map((s) => s.topM));
  return { roads, areas, solids, places, minM, maxM };
}

/** The lowest point of the top of a solid. */
export function lowestTop(solid: Pick<Solid, 'topM' | 'profile'>): number {
  return solid.profile ? Math.min(...solid.profile.points.map((p) => p[1])) : solid.topM;
}

// ---------- floors of a building ----------
/** The building a scene block or a road belongs to: the id before '#' ("은주관#접합부" is part of "은주관"). */
export const baseBuildingId = (id: string) => id.split('#')[0];

/** The floor a text names first: "지하 1층" / "B1" -> -1, "3층" / "3F" -> 3; null when it names none. */
export function floorInText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /지하\s*(\d{1,2})\s*층|(?<![A-Za-z0-9])B(\d{1,2})(?![0-9A-Za-z])|(\d{1,2})\s*(?:층|F(?![a-z]))/.exec(text);
  if (!m) return null;
  return m[1] ? -Number(m[1]) : m[2] ? -Number(m[2]) : Number(m[3]) || null;
}
/** The floor a road says it is on: its levelId, else the floor its name names before any bracket (remarks in brackets name other floors). */
export const floorOfRoad = (road: Pick<LvRoad, 'levelId' | 'name'>) => (road.levelId ? floorFromLevelId(road.levelId) : null) ?? floorInText((road.name ?? '').split('(')[0]);
export const floorText = (floor: number) => (floor < 0 ? `지하 ${-floor}층` : `${floor}층`);

const span = (road: LvRoad) => { const zs = road.geometry.coordinates.map((c) => c[2]); return { min: Math.min(...zs), max: Math.max(...zs) }; };
/** Stairs, a ramp or an elevator between floors (not a level corridor). */
export const isConnector = (road: LvRoad) => { const s = span(road); return road.structure === 'elevator' || s.max - s.min > LEVEL_VIEW.levelSpanM; };

export type Floor = {
  /** Floor height (MSL). */
  m: number;
  /** "3층", "지하 1층": only when the roads on it say so (levelId or name); null otherwise. */
  name: string | null;
  /** From the floor table of the building note (false: only the roads are there). */
  fromTable: boolean;
  /** Level roads on this floor. */
  roadIds: string[];
};

/**
 * The floors of a building, lowest first: the heights of the note's floor table that lie within the building's blocks
 * (`blocks`: base and roof of every block of the building), and the heights of its level indoor roads (a road within
 * floorMatchM of a table floor lies on it, otherwise its own height becomes a floor). A floor's name is the floor most
 * of its roads name (levelId first, then the road name).
 */
export function buildingFloors(blocks: { baseM: number; roofM: number }[], tableM: number[] | null | undefined, roads: LvRoad[]): Floor[] {
  const lowest = Math.min(...blocks.map((b) => b.baseM)), highest = Math.max(...blocks.map((b) => b.roofM));
  const floors: (Floor & { votes: Map<number, number> })[] = [...new Set(tableM ?? [])]
    .filter((m) => m >= lowest - LEVEL_VIEW.belowBaseM && m < highest)
    .map((m) => ({ m, name: null, fromTable: true, roadIds: [], votes: new Map() }));
  for (const road of roads) {
    if (isConnector(road)) continue;
    const s = span(road), z = (s.min + s.max) / 2;
    let floor = floors.reduce<(typeof floors)[number] | null>((best, f) => (Math.abs(f.m - z) <= LEVEL_VIEW.floorMatchM && (!best || Math.abs(f.m - z) < Math.abs(best.m - z)) ? f : best), null);
    if (!floor) { floor = { m: Math.round(z * 10) / 10, name: null, fromTable: false, roadIds: [], votes: new Map() }; floors.push(floor); }
    floor.roadIds.push(road.id);
    const named = floorOfRoad(road);
    if (named !== null) floor.votes.set(named, (floor.votes.get(named) ?? 0) + 1);
  }
  return floors.sort((a, b) => a.m - b.m).map(({ votes, ...floor }) => {
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    return { ...floor, name: best ? floorText(best[0]) : null };
  });
}

/** The floor a height is on (nearest within floorMatchM), or -1. */
export function floorIndexAt(floors: Floor[], z: number): number {
  let best = -1;
  floors.forEach((f, i) => { if (Math.abs(f.m - z) <= LEVEL_VIEW.floorMatchM && (best < 0 || Math.abs(f.m - z) < Math.abs(floors[best].m - z))) best = i; });
  return best;
}

/**
 * The height map of an exploded building: floor i (height m_i) is shown at baseM + (m_i - m_0) + i × gapM; between two
 * floors heights go linearly (stairs stretch), below the first and above the last they keep their true distance.
 */
export function explode(floorsM: number[], baseM: number, gapM = LEVEL_VIEW.floorGapM): (z: number) => number {
  const at = floorsM.map((m, i) => baseM + (m - floorsM[0]) + i * gapM);
  return (z) => {
    if (!floorsM.length) return z;
    if (z <= floorsM[0]) return at[0] + (z - floorsM[0]);
    for (let i = 1; i < floorsM.length; i++) {
      if (z <= floorsM[i]) return at[i - 1] + ((z - floorsM[i - 1]) / (floorsM[i] - floorsM[i - 1] || 1)) * (at[i] - at[i - 1]);
    }
    return at[at.length - 1] + (z - floorsM[floorsM.length - 1]);
  };
}

/** A short name for a tag: the text before the first bracket, cut to `max` characters. */
export function shortName(name: string | null | undefined, max = 22): string {
  const s = (name ?? '').split('(')[0].trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------- first-person walk: the surface under the feet ----------
export const WALK = {
  eyeM: 1.6, walkMps: 1.4, runMps: 4.2,
  /** A surface up to this far above the feet can be stepped onto. */
  stepUpM: 0.6,
  /** A drop deeper than this is not taken: the feet keep their height (a floor that has no geometry, an edge). */
  maxDropM: 1.5,
  /** A road steeper than this where the walker stands is a stair or ramp to follow. */
  slopedAt: 0.03,
  /** A road carries the walker within half its width, at least this. */
  roadReachM: 1.5,
};

/** A walkable surface at a plan point; `sloped`: a stair or ramp road there (it leads through whatever level surface covers it in plan). */
export type WalkSurface = { z: number; sloped?: boolean };

/**
 * The height the feet get. Only surfaces at or below feet + stepUpM count (so a slab, a roof or the field above an
 * underground level is never taken). A stair or ramp road within maxDropM below the feet is followed first (the one
 * nearest to the feet): it goes down through the level surface around its head. Otherwise the highest surface,
 * unless that is a drop of more than maxDropM or there is none: then the feet stay.
 */
export function feetHeight(candidates: (number | WalkSurface)[], feetM: number): number {
  let best = -Infinity, slope: number | null = null;
  for (const c of candidates) {
    const s = typeof c === 'number' ? { z: c } : c;
    if (s.z > feetM + WALK.stepUpM) continue;
    if (s.sloped && feetM - s.z <= WALK.maxDropM && (slope === null || Math.abs(s.z - feetM) < Math.abs(slope - feetM))) slope = s.z;
    if (s.z > best) best = s.z;
  }
  if (slope !== null) return slope;
  return best === -Infinity || feetM - best > WALK.maxDropM ? feetM : best;
}

/** The nearest point of a road line to a plan point: its distance and the road's height there (linear along the segment). */
export function roadHeightAt(coordinates: number[][], x: number, y: number): { distanceM: number; z: number; direction: number[]; slope: number } | null {
  let best: { distanceM: number; z: number; direction: number[]; slope: number } | null = null;
  for (let i = 0; i + 1 < coordinates.length; i++) {
    const a = coordinates[i], b = coordinates[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
    const d = Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y);
    if (!best || d < best.distanceM) best = { distanceM: d, z: a[2] + (b[2] - a[2]) * t, direction: len2 > 0 ? [dx / Math.sqrt(len2), dy / Math.sqrt(len2)] : [0, 1], slope: len2 > 0 ? Math.abs(b[2] - a[2]) / Math.sqrt(len2) : 0 };
  }
  return best;
}

/** Box types one walks on (besides platforms). */
const WALKABLE = new Set(['stair_step', 'landing', 'deck', 'ramp']);

/**
 * The heights of every walkable surface at a plan point: roads within reach (their interpolated height), areas and
 * level underground zones containing the point, tops of platforms and of stair steps, landings, decks and ramps.
 */
export function walkSurfaces(x: number, y: number, data: { roads: LvRoad[]; areas: LvArea[]; solids: Solid[]; zones: Zone[] }): WalkSurface[] {
  const out: WalkSurface[] = [];
  for (const road of data.roads) {
    if (road.structure === 'elevator') continue;
    const h = roadHeightAt(road.geometry.coordinates, x, y);
    if (h && h.distanceM <= Math.max(WALK.roadReachM, (road.widthM ?? 0) / 2)) out.push({ z: h.z, sloped: h.slope > WALK.slopedAt });
  }
  for (const area of data.areas) if (area.elevationM != null && area.rings[0] && polygonContains(x, y, area.rings.map(open))) out.push({ z: area.elevationM });
  for (const zone of data.zones) if (zone.floorM !== undefined && inPolygons(zone.polygons, x, y)) out.push({ z: zone.floorM });
  for (const solid of data.solids) {
    if (!(solid.role === 'platform' || (solid.role === 'box' && WALKABLE.has(solid.type)))) continue;
    if (polygonContains(x, y, solid.polygon)) out.push({ z: topHeight(solid)(x, y) });
  }
  return out;
}
