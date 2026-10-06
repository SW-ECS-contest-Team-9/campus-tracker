// Read-only queries for the MCP tools: compact summaries instead of the browser's full snapshot.
import { pool } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { projectOnLine, type XYZ } from '../editor/topology.js';
import { roundXYZ, round2, simplifyIndices } from './geometry.js';

export interface NetworkRoad {
  id: string; name: string | null; roadClass: string; structure: string;
  pedestrianAccess: string; vehicleAccess: string; pedestrianDirection: string; vehicleDirection: string;
  widthM: number | null; wheelchairAccess: string; buildingId: string | null; levelId: string | null;
  status: string; revision: number; fromNodeId: string; toNodeId: string; parentId: string | null;
  createdBy: string; updatedBy: string; updatedAt: string; coordinates: XYZ[];
}
export interface NetworkNode { id: string; kind: string; levelId: string | null; coordinate: XYZ }
export interface NetworkPlace {
  id: string; name: string; category: string; description: string | null; buildingId: string | null; levelId: string | null;
  status: string; revision: number; parentId: string | null; updatedBy: string; updatedAt: string; coordinate: XYZ;
}

const ACTIVE = `status IN ('DRAFT','APPROVED')`;
const ROAD_COLUMNS = `id, name, road_class "roadClass", structure, pedestrian_access "pedestrianAccess", vehicle_access "vehicleAccess",
  pedestrian_direction "pedestrianDirection", vehicle_direction "vehicleDirection", width_m "widthM", wheelchair_access "wheelchairAccess",
  building_id "buildingId", level_id "levelId", status, revision, from_node_id "fromNodeId", to_node_id "toNodeId", parent_id "parentId",
  created_by "createdBy", updated_by "updatedBy", updated_at "updatedAt", (ST_AsGeoJSON(geom)::json->'coordinates') coordinates`;
const PLACE_COLUMNS = `id, name, category, description, building_id "buildingId", level_id "levelId", status, revision, parent_id "parentId",
  updated_by "updatedBy", updated_at "updatedAt", (ST_AsGeoJSON(geom)::json->'coordinates') coordinate`;

export interface FeatureFilter {
  status?: 'DRAFT' | 'APPROVED';
  roadClass?: string;
  /** undefined = any level; null = features without a level */
  levelId?: string | null;
  nameContains?: string;
  bbox?: [number, number, number, number];
  near?: { x: number; y: number; radiusM: number };
}

function where(f: FeatureFilter, extra: { roadClass?: boolean } = {}) {
  const clauses = [f.status ? 'status = $1' : ACTIVE];
  const params: unknown[] = f.status ? [f.status] : [];
  const push = (sql: string, value: unknown) => { params.push(value); clauses.push(sql.replace('?', `$${params.length}`)); };
  if (extra.roadClass && f.roadClass) push('road_class = ?', f.roadClass);
  if (f.levelId !== undefined) push('level_id IS NOT DISTINCT FROM ?', f.levelId);
  if (f.nameContains) push(`name ILIKE '%' || ? || '%'`, f.nameContains);
  if (f.bbox) {
    const [minX, minY, maxX, maxY] = f.bbox;
    params.push(minX, minY, maxX, maxY);
    clauses.push(`geom && ST_MakeEnvelope($${params.length - 3},$${params.length - 2},$${params.length - 1},$${params.length},5186)`);
  }
  if (f.near) {
    params.push(f.near.x, f.near.y, f.near.radiusM);
    clauses.push(`ST_DWithin(ST_Force2D(geom), ST_SetSRID(ST_MakePoint($${params.length - 2},$${params.length - 1}),5186), $${params.length})`);
  }
  return { sql: clauses.join(' AND '), params };
}

export const editorQueries = {
  async roads(f: FeatureFilter = {}): Promise<NetworkRoad[]> {
    const w = where(f, { roadClass: true });
    const { rows } = await pool.query<NetworkRoad>(`SELECT ${ROAD_COLUMNS} FROM mobility.road_segments WHERE ${w.sql} ORDER BY created_at, id`, w.params);
    return rows;
  },

  async places(f: FeatureFilter = {}): Promise<NetworkPlace[]> {
    const w = where(f);
    const { rows } = await pool.query<NetworkPlace>(`SELECT ${PLACE_COLUMNS} FROM mobility.places WHERE ${w.sql} ORDER BY name, id`, w.params);
    return rows;
  },

  /** Nodes that still carry an active road. */
  async nodes(f: Pick<FeatureFilter, 'bbox' | 'near' | 'levelId'> = {}): Promise<NetworkNode[]> {
    const w = where(f);
    const { rows } = await pool.query<NetworkNode>(
      `SELECT id, kind, level_id "levelId", (ST_AsGeoJSON(geom)::json->'coordinates') coordinate FROM mobility.network_nodes n
        WHERE ${w.sql.replace(ACTIVE, 'true')} AND EXISTS (SELECT 1 FROM mobility.road_segments r WHERE r.${ACTIVE} AND (r.from_node_id = n.id OR r.to_node_id = n.id))
        ORDER BY id`, w.params);
    return rows;
  },

  async road(id: string): Promise<NetworkRoad> {
    const { rows } = await pool.query<NetworkRoad & { replacedBy: string[] }>(`SELECT ${ROAD_COLUMNS}, replaced_by "replacedBy" FROM mobility.road_segments WHERE id = $1`, [id]);
    if (!rows[0]) throw AppError.notFound('ROAD_NOT_FOUND', `Road ${id} does not exist`);
    return rows[0];
  },

  async place(id: string): Promise<NetworkPlace> {
    const { rows } = await pool.query<NetworkPlace>(`SELECT ${PLACE_COLUMNS} FROM mobility.places WHERE id = $1`, [id]);
    if (!rows[0]) throw AppError.notFound('PLACE_NOT_FOUND', `Place ${id} does not exist`);
    return rows[0];
  },

  async node(id: string): Promise<NetworkNode> {
    const { rows } = await pool.query<NetworkNode>(`SELECT id, kind, level_id "levelId", (ST_AsGeoJSON(geom)::json->'coordinates') coordinate FROM mobility.network_nodes WHERE id = $1`, [id]);
    if (!rows[0]) throw AppError.notFound('NODE_NOT_FOUND', `Node ${id} does not exist`);
    return rows[0];
  },

  async leases() {
    const { rows } = await pool.query<{ objectType: string; objectId: string; ownerCode: string; sessionId: string; expiresAt: string }>(
      `SELECT object_type "objectType", object_id "objectId", owner_code "ownerCode", session_id "sessionId", expires_at "expiresAt"
         FROM mobility.editor_leases WHERE expires_at > now()`);
    return rows;
  },

  async changes(f: { sinceId?: number; changeSetId?: string; objectId?: string; via?: 'mcp' | 'editor'; limit: number }) {
    const { rows } = await pool.query(
      `SELECT id, change_set_id "changeSetId", object_type "objectType", object_id "objectId", operation, revision, owner_code "ownerCode",
              payload->'actor' actor, payload - 'actor' - 'before' detail, created_at "createdAt"
         FROM mobility.editor_changes
        WHERE ($1::bigint IS NULL OR id > $1) AND ($2::uuid IS NULL OR change_set_id = $2) AND ($3::uuid IS NULL OR object_id = $3)
          AND ($4::text IS NULL OR COALESCE(payload->'actor'->>'via', 'editor') = $4)
        ORDER BY id DESC LIMIT $5`, [f.sinceId ?? null, f.changeSetId ?? null, f.objectId ?? null, f.via ?? null, f.limit]);
    return rows;
  },
};

export type GeometryDetail = 'none' | 'endpoints' | 'full';

export function roadLength(road: Pick<NetworkRoad, 'coordinates'>): number {
  return road.coordinates.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - road.coordinates[i][0], p[1] - road.coordinates[i][1]), 0);
}

export function summarizeRoad(road: NetworkRoad, geometry: GeometryDetail, lockedBy?: string, simplifyM = 0) {
  const { coordinates, createdBy: _c, updatedAt: _u, parentId: _p, ...attrs } = road;
  const shape = geometry === 'full'
    ? { coordinates: simplifyIndices(coordinates, simplifyM).map((i) => simplifyM > 0 ? [i, ...roundXYZ(coordinates[i])] : roundXYZ(coordinates[i])) }
    : geometry === 'endpoints' ? { start: roundXYZ(coordinates[0]), end: roundXYZ(coordinates.at(-1)!) } : {};
  return { ...attrs, lengthM: round2(roadLength(road)), vertexCount: coordinates.length, ...(lockedBy ? { lockedBy } : {}), ...shape };
}

/** Closest point of every nearby road to an XY location. */
export function projectRoads(roads: NetworkRoad[], point: XYZ, radiusM: number) {
  return roads.flatMap((road) => {
    const hit = projectOnLine(road.coordinates, point);
    if (!hit || hit.distance > radiusM) return [];
    let measure = 0, nearestVertex = 0, best = Infinity;
    road.coordinates.forEach((p, i) => {
      if (i > 0) measure += Math.hypot(p[0] - road.coordinates[i - 1][0], p[1] - road.coordinates[i - 1][1]);
      const d = Math.abs(measure - hit.measure);
      if (d < best) { best = d; nearestVertex = i; }
    });
    return [{
      roadId: road.id, name: road.name, roadClass: road.roadClass, levelId: road.levelId, status: road.status, revision: road.revision,
      distanceM: round2(hit.distance), point: roundXYZ(hit.point), measureM: round2(hit.measure), lengthM: round2(hit.total),
      nearestVertexIndex: nearestVertex, nearestVertexOffsetM: round2(best),
    }];
  }).sort((a, b) => a.distanceM - b.distanceM);
}
