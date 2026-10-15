// GET /api/v1/mobility/nodes: the network nodes the collector apps offer for a collection anchor (start, end,
// entrance, stairs, elevator), filtered by building and floor and sorted by distance from the phone.
import { pool, type DbClient } from '../../config/database.js';
import { tmForward, tmInverse } from '../../geo/tm.js';
import { OUTDOOR_BUILDING, floorFromLevelId, floorNumber } from '../markers/marker-anchor.js';

export interface AnchorNodeRow {
  id: string;
  kind: string;
  level_id: string | null;
  x: number;
  y: number;
  z: number;
  road_buildings: string[] | null;
  road_levels: string[] | null;
  structures: string[];
  road_names: string[] | null;
  footprint_building: string | null;
  place_name: string | null;
}

export interface AnchorNode {
  nodeId: string;
  kind: string;
  buildingId: string;
  /** null: the data does not say which floor (most indoor roads outside 북악관 have no levelId yet) */
  floor: string | null;
  /** what the node joins: corridor, stairs, elevator, ... */
  structures: string[];
  /** a short name for the list: the nearest place or a road name, else the structures */
  label: string;
  latitude: number;
  longitude: number;
  /** floor height at the node, metres above MSL (KVD Incheon) */
  heightM: number;
  distanceM: number | null;
}

const STRUCTURE_LABEL: Record<string, string> = {
  ordinary: '길', sidewalk: '인도', crossing: '횡단보도', stairs: '계단', ramp: '경사로', indoor_corridor: '복도', elevator: '승강기',
};

/** One node as the app sees it. The building is the roads' building, else the footprint the node is in, else outdoor. */
export function toAnchorNode(r: AnchorNodeRow, from: { x: number; y: number } | null): AnchorNode {
  const levels = [r.level_id, ...(r.road_levels ?? [])].map(floorFromLevelId).filter((f): f is string => f !== null);
  const floor = levels.length && levels.every((f) => f === levels[0]) ? levels[0] : r.level_id ? floorFromLevelId(r.level_id) : null;
  const structures = [...new Set(r.structures)].sort();
  const ll = tmInverse(r.x, r.y);
  const what = structures.map((s) => STRUCTURE_LABEL[s] ?? s).join('·');
  return {
    nodeId: r.id,
    kind: r.kind,
    buildingId: r.road_buildings?.[0] ?? r.footprint_building ?? OUTDOOR_BUILDING,
    floor,
    structures,
    label: [r.place_name ?? r.road_names?.[0], what].filter(Boolean).join(' · ') || r.kind,
    latitude: ll.latitude,
    longitude: ll.longitude,
    heightM: r.z,
    distanceM: from ? Math.round(Math.hypot(r.x - from.x, r.y - from.y) * 10) / 10 : null,
  };
}

/**
 * Filter and order: the building's nodes; with a floor, the nodes on that floor first and then (unless excluded) the
 * nodes whose floor is unknown; nearest first within each group.
 */
export function pickAnchorNodes(nodes: AnchorNode[], q: { buildingId?: string; floor?: string; includeUnknownFloor: boolean; limit: number }) {
  const inBuilding = q.buildingId ? nodes.filter((n) => n.buildingId === q.buildingId) : nodes;
  const rank = (n: AnchorNode) => (!q.floor || n.floor === q.floor ? 0 : 1);
  const kept = q.floor ? inBuilding.filter((n) => n.floor === q.floor || (q.includeUnknownFloor && n.floor === null)) : inBuilding;
  return kept
    .sort((a, b) => rank(a) - rank(b) || (a.distanceM ?? 0) - (b.distanceM ?? 0) || a.nodeId.localeCompare(b.nodeId))
    .slice(0, q.limit);
}

/** Buildings for the first picker: the active map's footprints plus any building only the roads name, with known floors. */
export function anchorBuildings(nodes: AnchorNode[], footprints: { buildingId: string; buildingName: string | null }[]) {
  const floors = new Map<string, Set<string>>();
  const count = new Map<string, number>();
  for (const n of nodes) {
    count.set(n.buildingId, (count.get(n.buildingId) ?? 0) + 1);
    if (n.floor) floors.set(n.buildingId, (floors.get(n.buildingId) ?? new Set()).add(n.floor));
  }
  const names = new Map(footprints.map((b) => [b.buildingId, b.buildingName]));
  const ids = new Set([...footprints.map((b) => b.buildingId), ...count.keys()]);
  ids.delete(OUTDOOR_BUILDING);
  const order = (f: string) => floorNumber(f) ?? 0;
  return [
    { buildingId: OUTDOOR_BUILDING, buildingName: '바깥', nodeCount: count.get(OUTDOOR_BUILDING) ?? 0, floorsWithNodes: [] as string[] },
    ...[...ids].sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b, 'ko')).map((id) => ({
      buildingId: id,
      buildingName: names.get(id) ?? id,
      nodeCount: count.get(id) ?? 0,
      floorsWithNodes: [...(floors.get(id) ?? [])].sort((a, b) => order(a) - order(b)),
    })),
  ];
}

/** Every node an active (draft or approved) road touches, with what the app needs to name and place it. */
export async function loadAnchorNodes(from: { latitude: number; longitude: number } | null, db: DbClient = pool) {
  const { rows } = await db.query<AnchorNodeRow>(`
    WITH active AS (SELECT * FROM mobility.road_segments WHERE status IN ('DRAFT', 'APPROVED')),
    node AS (
      SELECT n.id, n.kind, n.level_id, n.geom,
             array_agg(DISTINCT r.building_id) FILTER (WHERE r.building_id IS NOT NULL) road_buildings,
             array_agg(DISTINCT r.level_id) FILTER (WHERE r.level_id IS NOT NULL) road_levels,
             array_agg(DISTINCT r.structure) structures,
             array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL AND btrim(r.name) <> '') road_names
        FROM mobility.network_nodes n
        JOIN active r ON r.from_node_id = n.id OR r.to_node_id = n.id
       GROUP BY n.id)
    SELECT node.id, node.kind, node.level_id, ST_X(node.geom)::float8 x, ST_Y(node.geom)::float8 y, ST_Z(node.geom)::float8 z,
           node.road_buildings, node.road_levels, node.structures, node.road_names,
           (SELECT b.building_id FROM campus_buildings b JOIN spatial_map_versions v ON v.id = b.map_version_id AND v.active
             WHERE ST_Covers(b.geom, ST_Force2D(node.geom)) ORDER BY ST_Area(b.geom) LIMIT 1) footprint_building,
           (SELECT p.name FROM mobility.places p WHERE p.status IN ('DRAFT', 'APPROVED') AND ST_DWithin(ST_Force2D(p.geom), ST_Force2D(node.geom), 5)
             ORDER BY ST_Distance(ST_Force2D(p.geom), ST_Force2D(node.geom)) LIMIT 1) place_name
      FROM node`);
  const { rows: footprints } = await db.query<{ buildingId: string; buildingName: string | null }>(
    `SELECT b.building_id "buildingId", b.building_name "buildingName" FROM campus_buildings b
       JOIN spatial_map_versions v ON v.id = b.map_version_id AND v.active`);
  const xy = from ? tmForward(from.latitude, from.longitude) : null;
  return { nodes: rows.map((r) => toAnchorNode(r, xy)), footprints };
}
