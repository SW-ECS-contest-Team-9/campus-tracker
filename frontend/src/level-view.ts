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
//  - the first-person walk (first-person.ts): which surface is under the feet;
//  - 사2: the inside of a building (interiors.geojson, from the notes' 실내_구조): the empty spaces carved out of a floor.
import { floorFromLevelId } from './floor-colors';
import { polygonContains, polygonOps, type Polygon } from './polygon-ops';
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
  /** U05: the stub of a carriageway (a vehicle road at least wideRoadM wide) is this long and drawn as a ribbon of its width: the mouth of a tunnel into a parking level must read as a way in. */
  stubWideM: 14, wideRoadM: 4,
  /** Height tolerance of a sloping underground zone's range (a tunnel, a passage) for roads and clicks. */
  rangeSlackM: 0.6,
  /**
   * F10: a level underground zone (a parking storey) holds what stands on its floor: heights from this far below the
   * floor up to (not including) its ceiling. No slack above: with it the storey below took the floor of the one above
   * (B2 ceiling 140.9 + 0.6 reached B1's floor 141.4), and both storeys were drawn on one plate.
   */
  floorSlackM: 0.3,
  /** F10: a solid standing on a lower storey that rises more than this above the floor of this one passes through it (shown faint, as shared). */
  throughM: 0.5,
  /** U08: below an opening in the floor of a level underground zone, what is marked `openAbove` (a ramp going down, its kerbs and guide line) is shown down to this depth. */
  openDepthM: 6,
  /** U08: a sloping solid seen through such an opening is drawn as a slab this thick (not as its fill down to the floor below). */
  openSlabM: 0.4,
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
/**
 * Whether a height belongs to a zone. Ground: always. A level underground zone: floor − floorSlackM … below its ceiling
 * (so two storeys never share a height). A sloping one: its range with rangeSlackM either way.
 */
export const inRange = (zone: Pick<Zone, 'layer' | 'fromM' | 'toM' | 'floorM'>, z: number) => zone.layer === 'ground'
  || (zone.floorM !== undefined ? z >= zone.floorM - LEVEL_VIEW.floorSlackM && z < zone.toM! : z >= zone.fromM! - LEVEL_VIEW.rangeSlackM && z <= zone.toM! + LEVEL_VIEW.rangeSlackM);
/** F10: the level underground zone (other than `but`) that holds a point: what it holds is its own, no sloping zone shows it as well. */
const levelOwner = (zones: Zone[] | undefined, but: Zone, x: number, y: number, z: number) =>
  (zones ?? []).find((o) => o.id !== but.id && o.layer === 'underground' && o.floorM !== undefined && inRange(o, z) && inPolygons(o.polygons, x, y)) ?? null;

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
  /** F10: for each stub, the far end of the part outside it starts (where the road ends or comes back in): what the stub leads to. */
  stubEnds: number[][];
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
export function cutRoad(coordinates: number[][], zone: Pick<Zone, 'polygons' | 'layer' | 'fromM' | 'toM' | 'floorM'>, stubM = LEVEL_VIEW.stubM, taken?: (p: number[]) => boolean): RoadCut {
  const parts: { a: number[]; b: number[]; inside: boolean }[] = [];
  for (let i = 0; i + 1 < coordinates.length; i++) {
    const a = coordinates[i], b = coordinates[i + 1];
    // F10: a level zone also ends where the road passes its floor or ceiling height (a ramp between two storeys)
    const heights = zone.layer === 'underground' && zone.floorM !== undefined && a[2] !== b[2]
      ? [zone.floorM - LEVEL_VIEW.floorSlackM, zone.toM!].map((h) => (h - a[2]) / (b[2] - a[2])).filter((t) => t > 1e-9 && t < 1 - 1e-9) : [];
    const ts = [0, ...[...crossings(a, b, zone.polygons), ...heights].sort((m, n) => m - n), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-9) continue;
      const p = lerp(a, b, ts[k]), q = lerp(a, b, ts[k + 1]);
      const m = lerp(p, q, 0.5);
      parts.push({ a: p, b: q, inside: inPolygons(zone.polygons, m[0], m[1]) && inRange(zone, m[2]) && !taken?.(m) });
    }
  }
  const runs: { inside: boolean; points: number[][] }[] = [];
  for (const part of parts) {
    const last = runs[runs.length - 1];
    if (last && last.inside === part.inside) last.points.push(part.b); else runs.push({ inside: part.inside, points: [part.a, part.b] });
  }
  const length = (points: number[][]) => points.reduce((s, p, i) => (i ? s + dist(points[i - 1], p) : 0), 0);
  const pieces = runs.filter((r) => r.inside).map((r) => r.points);
  const stubs: number[][][] = [], stubEnds: number[][] = [];
  runs.forEach((run, i) => {
    if (run.inside) return;
    if (runs[i - 1]?.inside) { stubs.push(head(run.points, stubM)); stubEnds.push(run.points[run.points.length - 1]); }
    if (runs[i + 1]?.inside) { stubs.push(head([...run.points].reverse(), stubM)); stubEnds.push(run.points[0]); }
  });
  const total = length(coordinates);
  return { pieces, stubs, stubEnds, share: total > 0 ? pieces.reduce((s, p) => s + length(p), 0) / total : 0 };
}

/** U05: a carriageway whose stub into a neighbour is drawn long and as a ribbon. */
export const isWideRoad = (road: Pick<LvRoad, 'roadClass' | 'widthM'>) => road.roadClass === 'vehicle' && (road.widthM ?? 0) >= LEVEL_VIEW.wideRoadM;

// ---------- what a zone holds ----------
const centroid = (ring: number[][]) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
const flag = (solid: Solid, key: string) => solid.props?.[key] === true;

export type ZoneContent = {
  roads: { road: LvRoad; cut: RoadCut }[];
  areas: LvArea[];
  /** Solids with the heights to draw them at (an underground zone shows only the part inside its range). */
  solids: { solid: Solid; bottomM: number; topM: number; below?: true; shared?: true }[];
  /** U08: openings in the floor of a level underground zone (voids that end at its floor: the hole over a ramp going down). */
  openings: Polygon[];
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
 * F10, one owner each: a level underground zone (a parking storey) holds the areas, places and solids whose own height
 * (elevation, base) lies in floor − floorSlackM … below its ceiling, so two storeys never show the same thing, and what
 * a storey holds no sloping zone shows as well (`data.zones`). Shared, and marked so: `below` (the ramp surface seen
 * through an opening in the floor) and `shared` (a solid of the storey below that rises through this one: the wall
 * round the ramp, floor to ceiling). A road between two storeys is cut at the floor and ceiling heights: each storey
 * has its own part and a stub towards the other.
 */
export function zoneContent(zone: Zone, data: { roads: LvRoad[]; areas: LvArea[]; solids: Solid[]; places?: LvPlace[]; zones?: Zone[] }): ZoneContent {
  const ground = zone.layer === 'ground', level = zone.floorM !== undefined;
  const inside = (p: number[]) => inPolygons(zone.polygons, p[0], p[1]);
  // what a storey holds is not shown by a sloping zone as well
  const taken = (p: number[], z = p[2]) => !ground && !level && !!levelOwner(data.zones, zone, p[0], p[1], z);
  const roads = data.roads
    .filter((r) => !r.buildingId && r.structure !== 'elevator' && (ground ? !isUnderground(r) : level || isUnderground(r)))
    .map((road) => ({ road, cut: cutRoad(road.geometry.coordinates, zone, isWideRoad(road) ? LEVEL_VIEW.stubWideM : LEVEL_VIEW.stubM, (p) => taken(p)) }))
    .filter((r) => r.cut.pieces.length);
  const areas = data.areas.filter((a) => a.rings[0]?.length && inside(centroid(open(a.rings[0])))
    && (ground ? !isUndergroundArea(a) : a.elevationM != null && inRange(zone, a.elevationM) && !taken(centroid(open(a.rings[0])), a.elevationM)));
  const solids: ZoneContent['solids'] = [];
  const openings: Polygon[] = [];
  for (const solid of data.solids) {
    if (!inside(centroid(solid.polygon[0]))) continue;
    if (solid.role === 'void') { if (level && Math.abs(solid.topM - zone.floorM!) < 0.01) openings.push(solid.polygon); continue; }
    if (ground) {
      if (flag(solid, 'inVoid') || flag(solid, 'underground')) continue;
      solids.push({ solid, bottomM: solid.bottomM, topM: solid.topM });
    } else if (solid.role !== 'box') {
      continue;
    } else if (level) {
      if (inRange(zone, solid.bottomM)) {
        // its own: it stands on this floor (cut at the ceiling)
        solids.push({ solid, bottomM: solid.bottomM, topM: Math.min(solid.topM, zone.toM!) });
      } else if (solid.bottomM >= zone.toM!) {
        continue;
      } else if (solid.type === 'ramp' && flag(solid, 'openAbove') && solid.topM > zone.floorM! - LEVEL_VIEW.openDepthM) {
        // the ramp surface seen from above through the opening in the floor: a thin slab below the floor plate
        // (its side walls and kerbs stand on the storey below and are that storey's)
        solids.push({ solid, bottomM: solid.profile && !solid.thicknessM ? Math.max(solid.bottomM, lowestTop(solid) - LEVEL_VIEW.openSlabM) : solid.bottomM, topM: solid.topM, below: true });
      } else if (solid.topM > zone.floorM! + LEVEL_VIEW.throughM) {
        // it stands on the storey below and rises through this one: the part in this storey, marked as shared
        solids.push({ solid, bottomM: zone.floorM!, topM: Math.min(solid.topM, zone.toM!), shared: true });
      }
    } else if (solid.topM > zone.fromM! && solid.bottomM < zone.toM! && (flag(solid, 'inVoid') || flag(solid, 'underground')) && !taken(centroid(solid.polygon[0]), solid.bottomM)) {
      solids.push({ solid, bottomM: Math.max(solid.bottomM, zone.fromM!), topM: Math.min(solid.topM, zone.toM!) });
    }
  }
  const places = (data.places ?? []).filter((p) => !p.buildingId && inside([p.x, p.y]) && (ground ? !levelOwner(data.zones, zone, p.x, p.y, p.z) : inRange(zone, p.z) && !taken([p.x, p.y], p.z)));
  const heights = [
    ...roads.flatMap((r) => r.cut.pieces.flat().map((p) => p[2])),
    ...areas.flatMap((a) => (a.elevationM != null ? [a.elevationM] : [])),
    ...solids.filter((s) => (ground ? s.solid.role === 'platform' : !s.below && !s.shared)).flatMap((s) => (ground ? [lowestTop(s.solid)] : [s.bottomM, s.topM])),
    ...(zone.floorM !== undefined ? [zone.floorM] : []),
  ];
  const minM = heights.length ? Math.min(...heights) : zone.fromM ?? 0;
  const maxM = Math.max(minM, ...heights, ...solids.map((s) => s.topM));
  return { roads, areas, solids, places, openings, minM, maxM };
}

// ---------- F10: storeys one above the other ----------
/** The level underground zones that share plan with a zone (itself included), lowest floor first: the storeys of one car park. */
export function levelStack(zones: Zone[], zone: Zone): Zone[] {
  if (zone.layer !== 'underground' || zone.floorM === undefined) return [];
  return zones.filter((z) => z.layer === 'underground' && z.floorM !== undefined && (z.id === zone.id || polygonOps('both', z.polygons, zone.polygons).length > 0))
    .sort((a, b) => a.floorM! - b.floorM!);
}

/**
 * How far above the common lift height the floor of a storey is put: the lowest storey of its stack at 0, each next
 * one its true difference + gapM higher (explode()). So every storey has its own height in the air and stepping
 * through them goes up and down; two storeys are never put at the same height.
 */
export function stackLiftM(stack: Zone[], zone: Zone, gapM = LEVEL_VIEW.floorGapM): number {
  const floors = stack.map((z) => z.floorM!);
  return floors.length && zone.floorM !== undefined ? explode(floors, 0, gapM)(zone.floorM) : 0;
}

/** The point of the zone's outline nearest to a plan point, and the unit direction from the point to it (outwards for a point inside). */
export function nearestOnOutline(polygons: Polygon[], x: number, y: number): { x: number; y: number; dir: [number, number]; distanceM: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const polygon of polygons) for (const ring of polygon) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
    const px = a[0] + dx * t, py = a[1] + dy * t, d = Math.hypot(px - x, py - y);
    if (!best || d < best.d) best = { x: px, y: py, d };
  }
  if (!best) return null;
  return { x: best.x, y: best.y, distanceM: best.d, dir: best.d > 1e-6 ? [(best.x - x) / best.d, (best.y - y) / best.d] : [0, 1] };
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
/** A floor name of a note's table as shown: "B1" -> "지하 1층", "3층" -> "3층"; a name that tells no floor number stays as written. */
export function tableFloorName(name: string): string {
  const n = floorInText(name);
  return n === null ? name : floorText(n);
}

const span = (road: LvRoad) => { const zs = road.geometry.coordinates.map((c) => c[2]); return { min: Math.min(...zs), max: Math.max(...zs) }; };
/** Stairs, a ramp or an elevator between floors (not a level corridor). */
export const isConnector = (road: LvRoad) => { const s = span(road); return road.structure === 'elevator' || s.max - s.min > LEVEL_VIEW.levelSpanM; };

export type Floor = {
  /** Floor height (MSL). */
  m: number;
  /** "3층", "지하 1층": from the note's floor table (scene API) when it names the floor, else what the roads on it say (levelId or name); null otherwise. */
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
export function buildingFloors(blocks: { baseM: number; roofM: number }[], tableM: number[] | null | undefined, roads: LvRoad[], tableNames?: string[] | null): Floor[] {
  const lowest = Math.min(...blocks.map((b) => b.baseM)), highest = Math.max(...blocks.map((b) => b.roofM));
  // F09: the note's own floor names (scene API, in the order of the table) win over what the roads say
  const noted = new Map<number, string>();
  if (tableNames && tableM && tableNames.length === tableM.length) tableM.forEach((m, i) => { if (!noted.has(m)) noted.set(m, tableFloorName(tableNames[i])); });
  const floors: (Floor & { votes: Map<number, number> })[] = [...new Set(tableM ?? [])]
    .filter((m) => m >= lowest - LEVEL_VIEW.belowBaseM && m < highest)
    .map((m) => ({ m, name: noted.get(m) ?? null, fromTable: true, roadIds: [], votes: new Map() }));
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
    return { ...floor, name: floor.name ?? (best ? floorText(best[0]) : null) };
  });
}

/**
 * The blocks (parts) of a building a floor is drawn on: those whose base and roof span it, and those a road of that floor
 * belongs to (은주2관: the scene base follows the server terrain and lies above its lower floors). All when none.
 */
export function blocksOnFloor<T extends { b: { buildingId: string; baseM: number; roofM: number } }>(items: T[], floor: Floor, roads: { id: string; buildingId: string | null }[]): T[] {
  const named = new Set(roads.filter((r) => floor.roadIds.includes(r.id)).map((r) => r.buildingId));
  const here = items.filter(({ b }) => (floor.m >= b.baseM - LEVEL_VIEW.belowBaseM && floor.m < b.roofM) || named.has(b.buildingId));
  return here.length ? here : items;
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

// ---------- F09: the floors of an exploded building fanned out ----------
export const FAN = {
  /** Each floor is moved sideways by the footprint's short width times this (>= 1: no plan of one floor lies over another). */
  stepShare: 1.08,
  /** ... plus this many metres between two plans. */
  stepGapM: 3,
  /** The extra height between two floors grows with the short width (share of it), within these limits. */
  gapShare: 0.22, gapMinM: 4, gapMaxM: 12,
  /** The default camera looks along the fan direction, this far down. */
  pitchDeg: -48,
};

/**
 * The short side of a footprint: the direction (unit vector) across which the rings are narrowest, their width that
 * way and their length along the other. The direction is turned to point north (east when it lies east–west).
 */
export function fanAxis(rings: number[][][]): { dir: [number, number]; widthM: number; lengthM: number } {
  const points = rings.flat();
  let best: { dir: [number, number]; widthM: number; lengthM: number } | null = null;
  const extent = (ux: number, uy: number) => { let lo = Infinity, hi = -Infinity; for (const p of points) { const v = p[0] * ux + p[1] * uy; if (v < lo) lo = v; if (v > hi) hi = v; } return hi - lo; };
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len; // across this edge
    const widthM = extent(nx, ny);
    if (!best || widthM < best.widthM - 1e-9) best = { dir: [nx, ny], widthM, lengthM: extent(-ny, nx) };
  }
  if (!best) return { dir: [0, 1], widthM: 0, lengthM: 0 };
  const [x, y] = best.dir;
  if (y < -1e-9 || (Math.abs(y) <= 1e-9 && x < 0)) best.dir = [-x, -y];
  return best;
}

/** The sideways step and the extra height between two floors for a footprint of this short width. */
export function fanStep(axis: { dir: number[]; widthM: number }): { step: [number, number]; gapM: number } {
  const d = axis.widthM * FAN.stepShare + FAN.stepGapM;
  return { step: [axis.dir[0] * d, axis.dir[1] * d], gapM: Math.min(FAN.gapMaxM, Math.max(FAN.gapMinM, axis.widthM * FAN.gapShare)) };
}

/**
 * The map that fans the floors of a building out: floor i (height m_i) goes to height baseM + (m_i - m_0) + i × gapM
 * and is moved i × step sideways, so every floor's plan lies clear of the others (step longer than the footprint is
 * wide) and each a little higher than the one before. Between two floors both go linearly with the height (stairs
 * and shafts stretch from plate to plate); below the first and above the last floor nothing more is added.
 */
export function fanOut(floorsM: number[], baseM: number, step: number[], gapM = LEVEL_VIEW.floorGapM): (p: number[]) => number[] {
  const up = explode(floorsM, baseM, gapM);
  const index = (z: number) => {
    if (!floorsM.length || z <= floorsM[0]) return 0;
    for (let i = 1; i < floorsM.length; i++) if (z <= floorsM[i]) return i - 1 + (z - floorsM[i - 1]) / (floorsM[i] - floorsM[i - 1] || 1);
    return floorsM.length - 1;
  };
  return (p) => { const k = index(p[2]); return [p[0] + step[0] * k, p[1] + step[1] * k, up(p[2])]; };
}

// ---------- F09: the levels under a click ----------
/**
 * The underground zones under a plan point, highest first: a level zone (parking storey) whose outline holds the
 * point and whose floor lies below the ground there; a sloping one (tunnel, passage) when one of its own underground
 * roads passes within `reachM` of the point below the ground.
 */
export function levelsUnder(zones: Zone[], x: number, y: number, groundM: number, roads: LvRoad[], reachM = 6): Zone[] {
  const out = zones.filter((zone) => {
    if (zone.layer !== 'underground' || !inPolygons(zone.polygons, x, y)) return false;
    if (zone.floorM !== undefined) return zone.floorM < groundM - 1.5;
    return roads.some((r) => {
      if (r.buildingId || !isUnderground(r)) return false;
      const h = roadHeightAt(r.geometry.coordinates, x, y);
      return !!h && h.distanceM <= reachM && h.z < groundM - 1.5 && inRange(zone, h.z);
    });
  });
  const height = (zone: Zone) => zone.floorM ?? zone.toM!;
  return out.sort((a, b) => height(b) - height(a));
}

// ---------- F09: elevators in the walk ----------
/** The heights an elevator stops at near a plan point (the ends of the elevator roads within `reachM`), lowest first; [] when there is none. */
export function elevatorStops(roads: LvRoad[], x: number, y: number, reachM = 2.5): number[] {
  const stops: number[] = [];
  for (const road of roads) {
    if (road.structure !== 'elevator') continue;
    const c = road.geometry.coordinates;
    if (!c.length || Math.hypot(c[0][0] - x, c[0][1] - y) > reachM) continue;
    for (const z of [c[0][2], c[c.length - 1][2]]) if (!stops.some((s) => Math.abs(s - z) < 0.3)) stops.push(z);
  }
  return stops.sort((a, b) => a - b);
}

/** The next stop above (direction 1) or below (-1) the feet; null at the end of the shaft or when the feet are not at a stop (within 1.2 m). */
export function nextStop(stops: number[], feetM: number, direction: 1 | -1): number | null {
  const at = stops.findIndex((s) => Math.abs(s - feetM) <= 1.2);
  if (at < 0) return null;
  return stops[at + direction] ?? null;
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

// ---------- F10: a session's track on what is lifted ----------
export const TRACK = {
  /** A point belongs to a storey from this far below its floor … to this far below the next floor (or to the ceiling of the top storey). */
  belowFloorM: 1.0,
  /** Outdoors: within this of the ground as drawn. */
  outdoorM: 4,
  /** A sloping underground zone (tunnel, passage) holds a point only when it lies this far below the ground. */
  underGroundM: 1.5,
  /** A point of a building may lie this far below its lowest floor or above its roof; further off its height is not believed. */
  buildingSlackM: 3,
  /** A height given with a vertical accuracy worse than this (m) is not believed. */
  maxVerticalAccuracyM: 8,
};

/** A point of a track: plan position (EPSG:5186 m) and height (MSL, the model's datum). `h` null or `reliable` false: the height is not known. */
export type TrackPoint = { x: number; y: number; h: number | null; reliable?: boolean };
/** A track as a lifted view draws it: the raw location samples of a session, or a fused path (a fusion version or run). */
export type LvTrack = { id: string; kind: 'raw' | 'fused'; label: string; points: TrackPoint[] };
/** A point of a track on what is lifted: its index, the height to draw it at (before the lift), `sure` false: 높이 미상 (drawn faint on the nearest plate); `floor`: the floor of a building. */
export type TrackSpot = { index: number; z: number; sure: boolean; floor?: number };
export type TrackContext = {
  zones: Zone[];
  groundAt: (x: number, y: number) => number;
  /** Buildings (footprint rings in metres, base and roof): a point inside one at a height off the ground belongs to the building, not to the zone. */
  buildings?: { rings: number[][][]; baseM: number; roofM: number }[];
  /** For the height of a sloping underground zone at a point (its own roads). */
  roads?: LvRoad[];
};

const knownHeight = (p: TrackPoint): p is TrackPoint & { h: number } => num(p.h) && p.reliable !== false;
const inRings = (rings: number[][][], x: number, y: number) => rings.some((ring) => polygonContains(x, y, [open(ring)]));
/** The height of a sloping underground zone at a plan point: its nearest underground road there, else the middle of its range. */
function slopeHeight(zone: Zone, x: number, y: number, roads: LvRoad[] | undefined): number {
  let best: { distanceM: number; z: number } | null = null;
  for (const road of roads ?? []) {
    if (road.buildingId || !isUnderground(road)) continue;
    const h = roadHeightAt(road.geometry.coordinates, x, y);
    if (h && inRange(zone, h.z) && (!best || h.distanceM < best.distanceM)) best = h;
  }
  return best ? best.z : (zone.fromM! + zone.toM!) / 2;
}

/**
 * Where a track point is, among the zones at its plan position. `sure` false: its height is not known or fits nothing
 * there, and `zone` is then the nearest plate by height (null for an unknown height: it may be any of them).
 *  1. a storey (level underground zone) whose outline holds it and whose band holds its height: floor − 1.0 m … next
 *     floor − 1.0 m, the top storey up to its ceiling;
 *  2. a building: inside a footprint, within the building's heights and more than outdoorM off the ground ('building');
 *  3. a sloping underground zone (tunnel, passage): inside its outline and range and at least 1.5 m under the ground;
 *  4. the ground zone: within ±4 m of the ground as drawn;
 *  5. otherwise the height is implausible: the nearest of those plates, not sure.
 */
export function trackPlace(p: TrackPoint, ctx: TrackContext): { zone: Zone | null; sure: boolean; building?: true; candidates: Zone[] } {
  const here = ctx.zones.filter((z) => inPolygons(z.polygons, p.x, p.y));
  const ground = here.find((z) => z.layer === 'ground') ?? null;
  const levels = here.filter((z) => z.layer === 'underground' && z.floorM !== undefined).sort((a, b) => a.floorM! - b.floorM!);
  const sloping = here.filter((z) => z.layer === 'underground' && z.floorM === undefined);
  const candidates = [...(ground ? [ground] : []), ...levels, ...sloping];
  if (!knownHeight(p)) return { zone: null, sure: false, candidates };
  const h = p.h, g = ctx.groundAt(p.x, p.y);
  for (let i = 0; i < levels.length; i++) {
    const lo = levels[i].floorM! - TRACK.belowFloorM;
    if (h >= lo && (i + 1 < levels.length ? h < levels[i + 1].floorM! - TRACK.belowFloorM : h <= levels[i].toM!)) return { zone: levels[i], sure: true, candidates };
  }
  if (Math.abs(h - g) > TRACK.outdoorM && (ctx.buildings ?? []).some((b) => h >= b.baseM - TRACK.buildingSlackM && h <= b.roofM + TRACK.buildingSlackM && inRings(b.rings, p.x, p.y))) return { zone: null, sure: true, building: true, candidates };
  for (const z of sloping) if (inRange(z, h) && h < g - TRACK.underGroundM) return { zone: z, sure: true, candidates };
  if (ground && Math.abs(h - g) <= TRACK.outdoorM) return { zone: ground, sure: true, candidates };
  let best: Zone | null = null, bestD = Infinity;
  for (const z of candidates) {
    const at = z.layer === 'ground' ? g : z.floorM ?? Math.min(z.toM!, Math.max(z.fromM!, h));
    if (Math.abs(h - at) < bestD) { bestD = Math.abs(h - at); best = z; }
  }
  return { zone: best, sure: false, candidates };
}

/**
 * The points of a track that belong to a zone, each with the height it is drawn at: on the plate (a storey's floor,
 * the ground as drawn), in a sloping zone its own height. A point of unknown height inside the outline is kept, not
 * sure (높이 미상); on a ground zone with nothing underground beneath it is sure (there is only the ground to be on).
 */
export function trackOnZone(points: TrackPoint[], zone: Zone, ctx: TrackContext): TrackSpot[] {
  const out: TrackSpot[] = [];
  points.forEach((p, index) => {
    if (!num(p.x) || !num(p.y) || !inPolygons(zone.polygons, p.x, p.y)) return;
    const place = trackPlace(p, ctx);
    const unknown = !knownHeight(p);
    if (!unknown && place.zone?.id !== zone.id) return;
    const sure = unknown ? zone.layer === 'ground' && place.candidates.every((c) => c.layer === 'ground') : place.sure;
    const z = zone.layer === 'ground' ? ctx.groundAt(p.x, p.y) : zone.floorM ?? (sure ? p.h! : slopeHeight(zone, p.x, p.y, ctx.roads));
    out.push({ index, z, sure });
  });
  return out;
}

/**
 * The points of a track inside a building's footprint, each on a floor: the floor nearest to its height. A height
 * that is not known goes to the floor nearest to the ground there, one more than buildingSlackM outside the building
 * to the nearest floor; both not sure (높이 미상).
 */
export function trackOnBuilding(points: TrackPoint[], rings: number[][][], floorsM: number[], blocks: { baseM: number; roofM: number }, groundAt: (x: number, y: number) => number): TrackSpot[] {
  const out: TrackSpot[] = [];
  if (!floorsM.length) return out;
  const nearest = (h: number) => floorsM.reduce((best, m, i) => (Math.abs(m - h) < Math.abs(floorsM[best] - h) ? i : best), 0);
  points.forEach((p, index) => {
    if (!num(p.x) || !num(p.y) || !inRings(rings, p.x, p.y)) return;
    const known = knownHeight(p);
    const sure = known && p.h >= Math.min(blocks.baseM, floorsM[0]) - TRACK.buildingSlackM && p.h <= blocks.roofM + TRACK.buildingSlackM;
    const floor = nearest(known ? p.h : groundAt(p.x, p.y));
    out.push({ index, z: floorsM[floor], sure, floor });
  });
  return out;
}

/** The spots as runs to join with a line: consecutive points of the track that are alike (sure or not). */
export function trackRuns(spots: TrackSpot[]): TrackSpot[][] {
  const runs: TrackSpot[][] = [];
  for (const s of spots) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1].index === s.index - 1 && last[0].sure === s.sure) last.push(s); else runs.push([s]);
  }
  return runs;
}

// ---------- 사2: the inside of a building, carved (interiors.geojson) ----------
export type InteriorKind = 'corridor' | 'lobby' | 'link' | 'stair' | 'elevator';
/** An empty space of a building (corridor, lobby, link, stairwell, elevator shaft) on the floors of the note it names. */
export type Interior = { building: string; kind: InteriorKind; name: string; floorsM: number[]; grade: string; polygons: Polygon[] };
export const INTERIOR = {
  /** How high the walls of a carved floor stand (a plan cut: an oblique view still sees into the corridors). */
  wallM: 1.2,
  /** ... and never higher than this below the next floor up. */
  belowNextM: 0.3,
  /** The lowest wall drawn. */
  minWallM: 0.8,
};
const KINDS: InteriorKind[] = ['corridor', 'lobby', 'link', 'stair', 'elevator'];

/** The spaces of interiors.geojson; a feature that is not a usable polygon is left out. */
export function parseInteriors(fc: any): Interior[] {
  const out: Interior[] = [];
  for (const f of Array.isArray(fc?.features) ? fc.features : []) {
    const p = f?.properties ?? {};
    const coords: unknown = f?.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f?.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : null;
    if (!Array.isArray(coords) || typeof p.building !== 'string' || !KINDS.includes(p.kind) || !Array.isArray(p.floorsM)) continue;
    const polygons = (coords as number[][][][]).map((poly) => poly.map((ring) => open(ring.map((c) => [c[0], c[1]])))).filter((poly) => poly.length && poly[0].length >= 3);
    const floorsM = (p.floorsM as unknown[]).filter((m): m is number => typeof m === 'number' && Number.isFinite(m));
    if (polygons.length && floorsM.length) out.push({ building: p.building, kind: p.kind, name: String(p.name ?? ''), floorsM, grade: String(p.grade ?? ''), polygons });
  }
  return out;
}

/**
 * Floor i of a building carved: the walls left standing (the footprint without the spaces of that floor, clipped to the
 * footprint), how high they stand, and the spaces (clipped to the footprint) to outline. null when no space of the
 * building lies on that floor (the plate is drawn as before). Only the footprint pieces a space reaches get walls: a part
 * with no space on that floor (은주관: 1관 and 2관 have floors at different heights) stays a plain plate.
 */
export function carvedFloor(interiors: Interior[], buildingId: string, floors: Floor[], i: number, footprint: Polygon[]): { walls: Polygon[]; wallM: number; spaces: { space: Interior; polygons: Polygon[] }[] } | null {
  const floor = floors[i];
  if (!floor || !footprint.length) return null;
  const here = interiors.filter((s) => baseBuildingId(s.building) === buildingId && s.floorsM.some((m) => Math.abs(m - floor.m) <= LEVEL_VIEW.floorMatchM && floorIndexAt(floors, m) === i));
  const spaces = here.map((space) => ({ space, polygons: polygonOps('both', space.polygons, footprint) })).filter((s) => s.polygons.length);
  if (!spaces.length) return null;
  const next = floors[i + 1];
  const wallM = Math.max(INTERIOR.minWallM, Math.min(INTERIOR.wallM, next ? next.m - floor.m - INTERIOR.belowNextM : INTERIOR.wallM));
  const reached = footprint.filter((piece) => spaces.some((s) => polygonOps('both', s.polygons, [piece]).length));
  return { walls: polygonOps('minus', reached, spaces.flatMap((s) => s.polygons), true), wallM, spaces };
}
