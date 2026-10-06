import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { pool, withTransaction, type DbClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import type { Anchor, BranchFrom, JunctionSave, LeaseReleaseData, LeaseRequestData, PlaceSave, RoadSave } from './editor.dto.js';
import { coincidentVertices, crossings, projectOnLine, splitAt, type Hit, type XYZ } from './topology.js';

const LEASE_MS = 30_000;
export const LEVEL_TOLERANCE_M = 1.25;
export const JUNCTION_ENDPOINT_M = 0.15;
export const JUNCTION_RADIUS_M = 0.75;
export type ObjectType = 'road' | 'place';

/** Who made a change besides the collector account: the browser editor, or an AI agent through MCP. Recorded in editor_changes.payload.actor. */
export interface EditorActor { via: 'editor' | 'mcp'; agent?: string; batchId?: string }
const actorStore = new AsyncLocalStorage<EditorActor>();
export const withEditorActor = <T>(actor: EditorActor, fn: () => Promise<T>): Promise<T> => actorStore.run(actor, fn);

/** Runs inside the caller's transaction when one is given (multi-step changes, dry runs that roll back); otherwise opens its own. */
const inTx = <T>(outer: PoolClient | undefined, fn: (db: PoolClient) => Promise<T>): Promise<T> => (outer ? fn(outer) : withTransaction(fn));

export interface RoadRow {
  id: string; parent_id: string | null; from_node_id: string; to_node_id: string;
  name: string | null; road_class: RoadSave['roadClass']; structure: RoadSave['structure'];
  pedestrian_access: RoadSave['pedestrianAccess']; vehicle_access: RoadSave['vehicleAccess'];
  pedestrian_direction: RoadSave['pedestrianDirection']; vehicle_direction: RoadSave['vehicleDirection'];
  width_m: number | null; wheelchair_access: RoadSave['wheelchairAccess'];
  building_id: string | null; level_id: string | null; status: 'DRAFT' | 'APPROVED'; revision: number;
  created_by: string; coordinates: XYZ[];
}

export type RoadAttrs = Pick<RoadSave, 'name' | 'roadClass' | 'structure' | 'pedestrianAccess' | 'vehicleAccess' | 'pedestrianDirection' | 'vehicleDirection' | 'widthM' | 'wheelchairAccess' | 'buildingId' | 'levelId'>;

export const roadSelect = `SELECT id, parent_id, from_node_id, to_node_id, name, road_class, structure,
  pedestrian_access, vehicle_access, pedestrian_direction, vehicle_direction, width_m, wheelchair_access,
  building_id, level_id, status, revision, created_by,
  (ST_AsGeoJSON(geom)::json->'coordinates') coordinates FROM mobility.road_segments`;

/** What an in-place edit overwrites; enough to restore the road exactly. */
export function roadBefore(r: RoadRow) {
  return { status: r.status, attrs: attrsFromRow(r), coordinates: r.coordinates, fromNodeId: r.from_node_id, toNodeId: r.to_node_id };
}

export function attrsFromRow(r: RoadRow): RoadAttrs {
  return {
    name: r.name,
    roadClass: r.road_class,
    structure: r.structure,
    pedestrianAccess: r.pedestrian_access,
    vehicleAccess: r.vehicle_access,
    pedestrianDirection: r.pedestrian_direction,
    vehicleDirection: r.vehicle_direction,
    widthM: r.width_m,
    wheelchairAccess: r.wheelchair_access,
    buildingId: r.building_id,
    levelId: r.level_id,
  };
}

function branchAnchorHit(road: RoadRow, coordinates: XYZ[], branch: BranchFrom, levelId: string | null): Hit {
  const point = road.coordinates[branch.vertexIndex];
  if (!point || road.level_id !== levelId) throw AppError.conflict('BRANCH_SOURCE_CHANGED', 'The source road or level changed; choose its vertex again');
  if (Math.hypot(point[0] - coordinates[0][0], point[1] - coordinates[0][1]) > 0.02 || Math.abs(point[2] - coordinates[0][2]) > 0.05) {
    throw AppError.conflict('BRANCH_VERTEX_MOVED', 'The branch no longer starts at the selected road vertex');
  }
  let measure = 0;
  for (let i = 1; i <= branch.vertexIndex; i++) measure += Math.hypot(road.coordinates[i][0] - road.coordinates[i - 1][0], road.coordinates[i][1] - road.coordinates[i - 1][1]);
  return { x: point[0], y: point[1], z: point[2], sourceMeasure: 0, otherMeasure: measure, zDelta: 0 };
}

/** Point at an XY distance along a road, with its interpolated height. */
export function pointAtMeasure(points: XYZ[], measure: number): XYZ {
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (walked + length >= measure || i === points.length - 1) {
      const f = length > 0 ? Math.max(0, Math.min(1, (measure - walked) / length)) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    walked += length;
  }
  return [...points[0]] as XYZ;
}

/**
 * An explicit connection: vertex `vertexIndex` of the line being saved sits on `roadId` at `measureM`. Unlike a crossing found
 * geometrically, it also connects a line that only touches the road (a T junction drawn up to it, or leaving it in parallel).
 */
function anchorHit(road: RoadRow, coordinates: XYZ[], anchor: Anchor, levelId: string | null): Hit {
  const source = coordinates[anchor.vertexIndex];
  const total = road.coordinates.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - road.coordinates[i][0], p[1] - road.coordinates[i][1]), 0);
  if (!source || road.level_id !== levelId || anchor.measureM > total + 0.01) throw AppError.conflict('ANCHOR_SOURCE_CHANGED', 'The anchored road or level changed; resolve the connection again', { roadId: road.id });
  const point = pointAtMeasure(road.coordinates, Math.min(anchor.measureM, total));
  if (Math.hypot(point[0] - source[0], point[1] - source[1]) > 0.02 || Math.abs(point[2] - source[2]) > 0.05) {
    throw AppError.conflict('ANCHOR_MOVED', 'The line no longer touches the anchored road at that vertex', { roadId: road.id });
  }
  let sourceMeasure = 0;
  for (let i = 1; i <= anchor.vertexIndex; i++) sourceMeasure += Math.hypot(coordinates[i][0] - coordinates[i - 1][0], coordinates[i][1] - coordinates[i - 1][1]);
  return { x: point[0], y: point[1], z: point[2], sourceMeasure, otherMeasure: Math.min(anchor.measureM, total), zDelta: 0 };
}

/** Geometric hits plus the caller's explicit connections (branch start, anchors) for one existing road. */
function hitsWithAnchors(coordinates: XYZ[], road: RoadRow, levelId: string | null, branchFrom?: BranchFrom, anchors: Anchor[] = []): Hit[] {
  const hits = roadHits(coordinates, road);
  const explicit = [
    ...(branchFrom?.roadId === road.id ? [branchAnchorHit(road, coordinates, branchFrom, levelId)] : []),
    ...anchors.filter((a) => a.roadId === road.id).map((a) => anchorHit(road, coordinates, a, levelId)),
  ];
  for (const anchor of explicit) {
    const duplicate = hits.findIndex((hit) => Math.abs(hit.sourceMeasure - anchor.sourceMeasure) < 0.01 && Math.abs(hit.otherMeasure - anchor.otherMeasure) < 0.01);
    if (duplicate >= 0) hits[duplicate] = anchor;
    else hits.push(anchor);
  }
  return hits;
}

function roadHits(coordinates: XYZ[], road: RoadRow): Hit[] {
  const hits = crossings(coordinates, road.coordinates, LEVEL_TOLERANCE_M);
  for (const exact of coincidentVertices(coordinates, road.coordinates)) {
    const duplicate = hits.findIndex((hit) => Math.abs(hit.sourceMeasure - exact.sourceMeasure) < 0.01
      && Math.abs(hit.otherMeasure - exact.otherMeasure) < 0.01);
    if (duplicate >= 0) hits[duplicate] = exact;
    else hits.push(exact);
  }
  return hits;
}

type JunctionRoad = { road: RoadRow; point: XYZ; measure: number; total: number; distance: number; endpointNodeId: string | null };
function junctionCandidates(rows: RoadRow[], cursor: XYZ) {
  const candidates: JunctionRoad[] = rows.flatMap((road) => {
    const projected = projectOnLine(road.coordinates, cursor);
    if (!projected || projected.distance > JUNCTION_RADIUS_M || Math.abs(projected.point[2] - cursor[2]) > LEVEL_TOLERANCE_M) return [];
    const endpointNodeId = projected.measure <= JUNCTION_ENDPOINT_M && projected.measure <= projected.total / 2 ? road.from_node_id
      : projected.total - projected.measure <= JUNCTION_ENDPOINT_M ? road.to_node_id : null;
    return [{ road, ...projected, endpointNodeId }];
  });
  const groups = new Map<string, JunctionRoad[]>();
  for (const candidate of candidates) {
    const key = candidate.road.level_id ?? '';
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const viable: JunctionRoad[][] = [];
  for (const group of groups.values()) {
    const byHeight = [...group].sort((a, b) => a.point[2] - b.point[2]);
    for (let start = 0; start < byHeight.length; start++) {
      const compatible = byHeight.slice(start).filter((item) => item.point[2] - byHeight[start].point[2] <= LEVEL_TOLERANCE_M);
      if (compatible.length >= 2) viable.push(compatible);
    }
  }
  viable.sort((a, b) => b.length - a.length || a.reduce((sum, p) => sum + p.distance, 0) - b.reduce((sum, p) => sum + p.distance, 0));
  const roads = viable[0] ?? [];
  const coordinate: XYZ = roads.length ? [cursor[0], cursor[1], roads.reduce((sum, p) => sum + p.point[2], 0) / roads.length] : cursor;
  const alreadyConnected = roads.length >= 2 && roads.every((item) => item.endpointNodeId && item.endpointNodeId === roads[0].endpointNodeId);
  return { roads, coordinate, levelId: roads[0]?.road.level_id ?? null, alreadyConnected };
}

async function nearbyJunctionRoads(db: PoolClient, cursor: XYZ, lock = false) {
  const { rows } = await db.query<RoadRow>(`${roadSelect}
    WHERE status IN ('DRAFT','APPROVED')
      AND ST_DWithin(ST_Force2D(geom), ST_SetSRID(ST_MakePoint($1,$2),5186), ${JUNCTION_RADIUS_M})
    ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [cursor[0], cursor[1]]);
  return junctionCandidates(rows, cursor);
}

export function geoJSONLine(coordinateParameter: number) {
  return `ST_SetSRID(ST_MakeLine(ARRAY(SELECT ST_MakePoint((p->>0)::float8,(p->>1)::float8,(p->>2)::float8) FROM jsonb_array_elements($${coordinateParameter}::jsonb) WITH ORDINALITY AS q(p,ord) ORDER BY ord)),5186)`;
}

export async function assertInsideTerrain(coordinates: XYZ[]) {
  const { rows } = await pool.query<{ inside: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM terrain_versions t WHERE t.active AND ST_Covers(
      ST_MakeEnvelope(t.origin_x, t.origin_y, t.origin_x + t.width*t.resolution_m, t.origin_y + t.height*t.resolution_m, 5186),
      ST_SetSRID(ST_MakeLine(ARRAY(SELECT ST_MakePoint((p->>0)::float8,(p->>1)::float8,(p->>2)::float8) FROM jsonb_array_elements($1::jsonb) p)),5186))) inside`,
    [JSON.stringify(coordinates)],
  );
  if (!rows[0]?.inside) throw AppError.badRequest('OUTSIDE_TERRAIN', 'Road must stay inside active campus terrain coverage');
}

export async function assertPointInsideTerrain(c: XYZ) {
  const { rows } = await pool.query<{ inside: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM terrain_versions t WHERE t.active AND ST_Covers(
      ST_MakeEnvelope(t.origin_x, t.origin_y, t.origin_x + t.width*t.resolution_m, t.origin_y + t.height*t.resolution_m, 5186),
      ST_SetSRID(ST_MakePoint($1,$2,$3),5186))) inside`, [c[0], c[1], c[2]],
  );
  if (!rows[0]?.inside) throw AppError.badRequest('OUTSIDE_TERRAIN', 'Point must be inside active campus terrain coverage');
}

export async function requireLease(db: PoolClient, kind: ObjectType, id: string, token: string, owner: string, sessionId: string) {
  const { rows } = await db.query(
    `SELECT 1 FROM mobility.editor_leases WHERE object_type=$1 AND object_id=$2 AND lease_token=$3
      AND owner_code=$4 AND session_id=$5 AND expires_at > now() FOR UPDATE`, [kind, id, token, owner, sessionId],
  );
  if (!rows.length) throw AppError.conflict('EDITOR_LEASE_REQUIRED', `Active ${kind} edit lease is required for ${id}`);
}

export async function ensureNode(db: PoolClient, p: XYZ, levelId: string | null, kind: 'endpoint' | 'junction') {
  const { rows } = await db.query<{ id: string; x: number; y: number; z: number }>(
    `SELECT id, ST_X(geom)::float8 x, ST_Y(geom)::float8 y, ST_Z(geom)::float8 z
       FROM mobility.network_nodes
      WHERE level_id IS NOT DISTINCT FROM $1
        AND ST_DWithin(ST_Force2D(geom), ST_SetSRID(ST_MakePoint($2,$3),5186), 0.15)
        AND abs(ST_Z(geom)-$4) <= $5
      ORDER BY CASE kind WHEN 'junction' THEN 0 ELSE 1 END, ST_Distance(ST_Force2D(geom),ST_SetSRID(ST_MakePoint($2,$3),5186))
      LIMIT 1 FOR UPDATE`, [levelId, p[0], p[1], p[2], LEVEL_TOLERANCE_M],
  );
  if (rows[0]) return { id: rows[0].id, point: [rows[0].x, rows[0].y, rows[0].z] as XYZ, created: false };
  const id = randomUUID();
  await db.query(`INSERT INTO mobility.network_nodes(id,kind,level_id,geom) VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5,$6),5186))`,
    [id, kind, levelId, p[0], p[1], p[2]]);
  return { id, point: p, created: true };
}

export async function snapPieceEndpoints(db: PoolClient, points: XYZ[], levelId: string | null) {
  const from = await ensureNode(db, points[0], levelId, 'endpoint');
  const to = await ensureNode(db, points.at(-1)!, levelId, 'endpoint');
  const coordinates = points.map((p) => [...p] as XYZ);
  coordinates[0] = from.point;
  coordinates[coordinates.length - 1] = to.point;
  const length = coordinates.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - coordinates[i][0], p[1] - coordinates[i][1]), 0);
  if (length < 0.05) throw AppError.badRequest('ROAD_SEGMENT_TOO_SHORT', 'Snapping endpoints would create a road segment shorter than 5 cm');
  return { fromNodeId: from.id, toNodeId: to.id, coordinates };
}

export async function insertRoad(db: PoolClient, p: {
  id: string; parentId: string | null; coordinates: XYZ[]; attrs: RoadAttrs; fromNode: string; toNode: string;
  owner: string; createdBy: string; status: 'DRAFT' | 'APPROVED' | 'REPLACED';
}) {
  await db.query(
    `INSERT INTO mobility.road_segments
      (id,parent_id,from_node_id,to_node_id,name,road_class,structure,pedestrian_access,vehicle_access,
       pedestrian_direction,vehicle_direction,width_m,wheelchair_access,building_id,level_id,status,geom,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,${geoJSONLine(17)},$18,$19)`,
    [p.id, p.parentId, p.fromNode, p.toNode, p.attrs.name ?? null, p.attrs.roadClass, p.attrs.structure,
      p.attrs.pedestrianAccess, p.attrs.vehicleAccess, p.attrs.pedestrianDirection, p.attrs.vehicleDirection,
      p.attrs.widthM ?? null, p.attrs.wheelchairAccess, p.attrs.buildingId ?? null, p.attrs.levelId ?? null,
      p.status, JSON.stringify(p.coordinates), p.createdBy, p.owner],
  );
}

export async function addChange(db: PoolClient, changeSetId: string, kind: 'road' | 'place' | 'node', id: string,
  operation: 'created' | 'updated' | 'replaced' | 'deleted', revision: number | null, owner: string, payload: unknown) {
  const actor = actorStore.getStore() ?? { via: 'editor' as const };
  const { before, ...detail } = (payload ?? {}) as Record<string, unknown>;
  const event = { changeSetId, objectType: kind, objectId: id, operation, revision, ownerCode: owner, payload: { ...detail, actor } };
  // "before" (the state this change replaced) stays in the log for audits and reverts; live notifications do not carry it.
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO mobility.editor_changes(change_set_id,object_type,object_id,operation,revision,owner_code,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
    [changeSetId, kind, id, operation, revision, owner, JSON.stringify(before === undefined ? event.payload : { ...event.payload, before })],
  );
  await db.query(`SELECT pg_notify('editor_changed',$1)`, [String(rows[0].id)]);
  return event;
}

export const editorService = {
  async snapshot(status: 'DRAFT' | 'APPROVED' | 'all' = 'all') {
    const where = status === 'all' ? "status IN ('DRAFT','APPROVED')" : 'status = $1';
    const params = status === 'all' ? [] : [status];
    const [roads, places, nodes, leases] = await Promise.all([
      pool.query(`SELECT id, parent_id "parentId", from_node_id "fromNodeId", to_node_id "toNodeId", name,
        road_class "roadClass", structure, pedestrian_access "pedestrianAccess", vehicle_access "vehicleAccess",
        pedestrian_direction "pedestrianDirection", vehicle_direction "vehicleDirection", width_m "widthM",
        wheelchair_access "wheelchairAccess", building_id "buildingId", level_id "levelId", status, revision,
        ST_AsGeoJSON(geom)::json geometry FROM mobility.road_segments WHERE ${where} ORDER BY created_at,id`, params),
      pool.query(`SELECT id,parent_id "parentId",name,category,description,building_id "buildingId",level_id "levelId",status,revision,
        ST_AsGeoJSON(geom)::json geometry FROM mobility.places WHERE ${status === 'all' ? "status IN ('DRAFT','APPROVED')" : 'status = $1'} ORDER BY name,id`, params),
      pool.query(`SELECT id,kind,level_id "levelId",revision,ST_AsGeoJSON(geom)::json geometry
        FROM mobility.network_nodes WHERE EXISTS (SELECT 1 FROM mobility.road_segments r
          WHERE r.status IN ('DRAFT','APPROVED') AND (r.from_node_id=network_nodes.id OR r.to_node_id=network_nodes.id))`),
      pool.query(`SELECT object_type "objectType",object_id "objectId",owner_code "ownerCode",session_id "sessionId",expires_at "expiresAt"
        FROM mobility.editor_leases WHERE expires_at > now()`),
    ]);
    return { roads: roads.rows, places: places.rows, nodes: nodes.rows, leases: leases.rows, serverTime: new Date().toISOString() };
  },

  async acquireLease(req: LeaseRequestData, identity: CollectorIdentity, outer?: PoolClient) {
    return inTx(outer, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO mobility.editor_leases(object_type,object_id,owner_code,session_id,lease_token,expires_at)
         VALUES($1,$2,$3,$4,gen_random_uuid(),now()+($5::text||' milliseconds')::interval)
         ON CONFLICT(object_type,object_id) DO UPDATE SET owner_code=EXCLUDED.owner_code,session_id=EXCLUDED.session_id,
           lease_token=CASE WHEN mobility.editor_leases.expires_at<=now() THEN gen_random_uuid() ELSE mobility.editor_leases.lease_token END,
           expires_at=now()+($5::text||' milliseconds')::interval,updated_at=now()
         WHERE mobility.editor_leases.expires_at<=now() OR
           (mobility.editor_leases.owner_code=EXCLUDED.owner_code AND mobility.editor_leases.session_id=EXCLUDED.session_id)
         RETURNING object_type "objectType",object_id "objectId",owner_code "ownerCode",session_id "sessionId",lease_token "leaseToken",expires_at "expiresAt"`,
        [req.objectType, req.objectId, identity.collectorId, req.sessionId, LEASE_MS],
      );
      if (!rows.length) {
        const current = await db.query(`SELECT owner_code "ownerCode",expires_at "expiresAt" FROM mobility.editor_leases
          WHERE object_type=$1 AND object_id=$2`, [req.objectType, req.objectId]);
        throw AppError.conflict('EDITOR_OBJECT_LOCKED', 'Another tracker account is editing this object', current.rows[0]);
      }
      return rows[0];
    });
  },

  async renewLease(req: LeaseRequestData, leaseToken: string, identity: CollectorIdentity) {
    const { rows } = await pool.query(
      `UPDATE mobility.editor_leases SET expires_at=now()+($6::text||' milliseconds')::interval,updated_at=now()
       WHERE object_type=$1 AND object_id=$2 AND session_id=$3 AND lease_token=$4 AND owner_code=$5 AND expires_at>now()
       RETURNING object_type "objectType",object_id "objectId",owner_code "ownerCode",session_id "sessionId",lease_token "leaseToken",expires_at "expiresAt"`,
      [req.objectType, req.objectId, req.sessionId, leaseToken, identity.collectorId, LEASE_MS],
    );
    if (!rows.length) throw AppError.conflict('EDITOR_LEASE_LOST', 'Edit lease expired or belongs to another session');
    return rows[0];
  },

  async releaseLease(req: LeaseReleaseData, identity: CollectorIdentity) {
    const { rowCount } = await pool.query(
      `DELETE FROM mobility.editor_leases WHERE object_type=$1 AND object_id=$2 AND session_id=$3 AND lease_token=$4 AND owner_code=$5`,
      [req.objectType, req.objectId, req.sessionId, req.leaseToken, identity.collectorId],
    );
    return { released: rowCount === 1 };
  },

  async previewTopology(coordinates: XYZ[], levelId: string | null, branchFrom?: BranchFrom, anchors: Anchor[] = [], db: DbClient = pool) {
    const xs = coordinates.map((p) => p[0]), ys = coordinates.map((p) => p[1]);
    const { rows } = await db.query<RoadRow>(`${roadSelect}
      WHERE status IN ('DRAFT','APPROVED') AND level_id IS NOT DISTINCT FROM $1
        AND geom && ST_MakeEnvelope($2,$3,$4,$5,5186)`,
      [levelId, Math.min(...xs) - 0.01, Math.min(...ys) - 0.01, Math.max(...xs) + 0.01, Math.max(...ys) + 0.01]);
    const found = rows.flatMap((road) => {
      const total = road.coordinates.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - road.coordinates[i][0], p[1] - road.coordinates[i][1]), 0);
      return roadHits(coordinates, road).map((hit) => ({ roadId: road.id, revision: road.revision, name: road.name, roadClass: road.road_class, status: road.status,
        requiresLease: hit.otherMeasure > 0.01 && hit.otherMeasure < total - 0.01,
        coordinate: [hit.x, hit.y, hit.z] as XYZ, zDeltaM: hit.zDelta }));
    });
    for (const anchor of anchors) {
      const road = rows.find((item) => item.id === anchor.roadId);
      if (!road) throw AppError.conflict('ANCHOR_SOURCE_CHANGED', 'The anchored road is no longer there', { roadId: anchor.roadId });
      const hit = anchorHit(road, coordinates, anchor, levelId);
      const total = road.coordinates.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - road.coordinates[i][0], p[1] - road.coordinates[i][1]), 0);
      const interior = hit.otherMeasure > 0.01 && hit.otherMeasure < total - 0.01;
      if (!found.some((item) => item.roadId === road.id && Math.hypot(item.coordinate[0] - hit.x, item.coordinate[1] - hit.y) < 0.01 && (!interior || item.requiresLease))) {
        found.push({ roadId: road.id, revision: road.revision, name: road.name, roadClass: road.road_class, status: road.status, requiresLease: interior, coordinate: [hit.x, hit.y, hit.z], zDeltaM: 0 });
      }
    }
    if (branchFrom) {
      const road = rows.find((item) => item.id === branchFrom.roadId);
      if (!road) throw AppError.conflict('BRANCH_SOURCE_CHANGED', 'The source road is no longer near the branch vertex');
      const hit = branchAnchorHit(road, coordinates, branchFrom, levelId);
      const total = road.coordinates.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - road.coordinates[i][0], p[1] - road.coordinates[i][1]), 0);
      const anchorRequiresLease = hit.otherMeasure > 0.01 && hit.otherMeasure < total - 0.01;
      if (!found.some((item) => item.roadId === road.id && Math.hypot(item.coordinate[0] - hit.x, item.coordinate[1] - hit.y) < 0.01
        && (!anchorRequiresLease || item.requiresLease))) {
        found.push({ roadId: road.id, revision: road.revision, name: road.name, roadClass: road.road_class, status: road.status,
          requiresLease: anchorRequiresLease,
          coordinate: [hit.x, hit.y, hit.z], zDeltaM: 0 });
      }
    }
    const own = crossings(coordinates, coordinates, LEVEL_TOLERANCE_M)
      .filter((h) => Math.abs(h.sourceMeasure - h.otherMeasure) > 0.02)
      .map((h) => ({ key: `${Math.min(h.sourceMeasure, h.otherMeasure).toFixed(2)}:${Math.max(h.sourceMeasure, h.otherMeasure).toFixed(2)}`, coordinate: [h.x, h.y, h.z] as XYZ }));
    const selfCrossings = [...new Map(own.map((h) => [h.key, h])).values()];
    return { crossings: found, selfCrossings, needsLease: [...new Map(found.filter((h) => h.requiresLease).map((h) => [h.roadId, { id: h.roadId, revision: h.revision }])).values()] };
  },

  async previewJunction(cursor: XYZ, outer?: PoolClient) {
    return inTx(outer, async (db) => {
      const candidate = await nearbyJunctionRoads(db, cursor);
      return { coordinate: candidate.coordinate, levelId: candidate.levelId, alreadyConnected: candidate.alreadyConnected,
        roads: candidate.roads.map(({ road, distance, point }) => ({ id: road.id, revision: road.revision, name: road.name,
          roadClass: road.road_class, distanceM: distance, heightM: point[2], status: road.status })) };
    });
  },

  async saveJunction(body: JunctionSave, identity: CollectorIdentity, outer?: PoolClient) {
    await assertPointInsideTerrain(body.coordinate);
    return inTx(outer, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(5186001)');
      const duplicate = await db.query<{ result: any }>(`SELECT result FROM mobility.editor_mutations WHERE mutation_id=$1 AND owner_code=$2`, [body.mutationId, identity.collectorId]);
      if (duplicate.rows[0]) return duplicate.rows[0].result;
      const candidate = await nearbyJunctionRoads(db, body.coordinate, true);
      if (candidate.roads.length < 2 || candidate.roads.length > 32 || candidate.alreadyConnected) {
        throw AppError.conflict('JUNCTION_UNAVAILABLE', 'At least two unconnected roads on the same level must meet at the cursor');
      }
      const supplied = new Map(body.roads.map((road) => [road.id, road]));
      if (supplied.size !== candidate.roads.length || candidate.roads.some(({ road }) => !supplied.has(road.id))) {
        throw AppError.conflict('TOPOLOGY_REFRESH_REQUIRED', 'Roads near the cursor changed; preview the junction again');
      }
      for (const { road } of candidate.roads) {
        const approved = supplied.get(road.id)!;
        if (road.revision !== approved.revision) throw AppError.conflict('TOPOLOGY_REFRESH_REQUIRED', 'A road changed; preview the junction again', { roadId: road.id });
        await requireLease(db, 'road', road.id, approved.leaseToken, identity.collectorId, body.sessionId);
      }
      const node = await ensureNode(db, candidate.coordinate, candidate.levelId, 'junction');
      const events: unknown[] = [];
      if (node.created) {
        events.push(await addChange(db, body.mutationId, 'node', node.id, 'created', 1, identity.collectorId, { kind: 'junction' }));
      } else {
        const { rows } = await db.query<{ revision: number }>(`UPDATE mobility.network_nodes SET kind='junction',revision=revision+1,updated_at=now()
          WHERE id=$1 AND kind<>'junction' RETURNING revision`, [node.id]);
        if (rows[0]) events.push(await addChange(db, body.mutationId, 'node', node.id, 'updated', rows[0].revision, identity.collectorId, { kind: 'junction' }));
      }
      for (const { road, measure, total } of candidate.roads) {
        const coordinates = road.coordinates.map((p) => [...p] as XYZ);
        const atStart = measure <= JUNCTION_ENDPOINT_M && measure <= total / 2;
        const atEnd = !atStart && total - measure <= JUNCTION_ENDPOINT_M;
        if (atStart) coordinates[0] = node.point;
        if (atEnd) coordinates[coordinates.length - 1] = node.point;
        const pieces = atStart || atEnd ? [coordinates] : splitAt(coordinates, [{ measure, x: node.point[0], y: node.point[1], z: node.point[2] }]);
        if (!atStart && !atEnd && pieces.length < 2) {
          throw AppError.conflict('JUNCTION_SPLIT_FAILED', 'The selected point is too close to a road endpoint');
        }
        await db.query(`UPDATE mobility.road_segments SET status='REPLACED',revision=revision+1,updated_by=$2,updated_at=now(),replaced_by='{}'
          WHERE id=$1`, [road.id, identity.collectorId]);
        const childIds: string[] = [];
        for (const piece of pieces) {
          const snapped = await snapPieceEndpoints(db, piece, road.level_id);
          const id = randomUUID(); childIds.push(id);
          await insertRoad(db, { id, parentId: road.id, coordinates: snapped.coordinates, attrs: attrsFromRow(road),
            fromNode: snapped.fromNodeId, toNode: snapped.toNodeId, owner: identity.collectorId, createdBy: road.created_by, status: road.status });
          events.push(await addChange(db, body.mutationId, 'road', id, 'created', 1, identity.collectorId, { parentId: road.id, junctionNodeId: node.id }));
        }
        await db.query('UPDATE mobility.road_segments SET replaced_by=$2 WHERE id=$1', [road.id, childIds]);
        events.push(await addChange(db, body.mutationId, 'road', road.id, 'replaced', road.revision + 1, identity.collectorId, { replacedBy: childIds, junctionNodeId: node.id, before: { status: road.status } }));
        await db.query(`DELETE FROM mobility.editor_leases WHERE object_type='road' AND object_id=$1 AND lease_token=$2`, [road.id, supplied.get(road.id)!.leaseToken]);
      }
      const result = { changeSetId: body.mutationId, nodeId: node.id, coordinate: node.point, roadCount: candidate.roads.length, events };
      await db.query('INSERT INTO mobility.editor_mutations(mutation_id,owner_code,result) VALUES($1,$2,$3::jsonb)',
        [body.mutationId, identity.collectorId, JSON.stringify(result)]);
      return result;
    });
  },

  async saveRoad(body: RoadSave, identity: CollectorIdentity, outer?: PoolClient) {
    await assertInsideTerrain(body.coordinates);
    return inTx(outer, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(5186001)'); // serialize network topology edits
      const duplicate = await db.query<{ result: any }>(`SELECT result FROM mobility.editor_mutations WHERE mutation_id=$1 AND owner_code=$2`, [body.mutationId, identity.collectorId]);
      if (duplicate.rows[0]) return duplicate.rows[0].result;
      await requireLease(db, 'road', body.id, body.leaseToken, identity.collectorId, body.sessionId);
      const { rows: priorRows } = await db.query<RoadRow>(`${roadSelect} WHERE id=$1 AND status IN ('DRAFT','APPROVED') FOR UPDATE`, [body.id]);
      const prior = priorRows[0];
      if (prior && prior.revision !== body.expectedRevision) throw AppError.conflict('REVISION_CONFLICT', 'Road changed since this edit began', { currentRevision: prior.revision });
      if (!prior && body.expectedRevision != null) throw AppError.conflict('ROAD_NOT_FOUND', 'Road was removed or replaced');
      if (body.branchFrom?.roadId === body.id) throw AppError.badRequest('INVALID_BRANCH_SOURCE', 'A road cannot branch from itself');

      const xs = body.coordinates.map((p) => p[0]), ys = body.coordinates.map((p) => p[1]);
      const { rows: candidates } = await db.query<RoadRow>(`${roadSelect}
        WHERE status IN ('DRAFT','APPROVED') AND id<>$1 AND level_id IS NOT DISTINCT FROM $2
          AND geom && ST_MakeEnvelope($3,$4,$5,$6,5186) FOR UPDATE`,
        [body.id, body.levelId ?? null, Math.min(...xs) - 0.01, Math.min(...ys) - 0.01, Math.max(...xs) + 0.01, Math.max(...ys) + 0.01]);
      if (body.branchFrom && !candidates.some((road) => road.id === body.branchFrom!.roadId)) {
        throw AppError.conflict('BRANCH_SOURCE_CHANGED', 'The source road is no longer near the branch vertex');
      }
      const lostAnchor = body.anchors.find((a) => !candidates.some((road) => road.id === a.roadId));
      if (lostAnchor) throw AppError.conflict('ANCHOR_SOURCE_CHANGED', 'The anchored road is no longer there', { roadId: lostAnchor.roadId });
      const hitsByRoad = new Map<string, { road: RoadRow; hits: Hit[] }>();
      const allCuts: { x: number; y: number; z: number; sourceMeasure: number; roadId: string; otherMeasure: number }[] = [];
      for (const road of candidates) {
        const hits = hitsWithAnchors(body.coordinates, road, body.levelId ?? null, body.branchFrom, body.anchors);
        if (!hits.length) continue;
        const total = road.coordinates.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - road.coordinates[i][0], p[1] - road.coordinates[i][1]), 0);
        const interior = hits.filter((h) => h.otherMeasure > 0.01 && h.otherMeasure < total - 0.01);
        allCuts.push(...hits.map((h) => ({ x: h.x, y: h.y, z: h.z, sourceMeasure: h.sourceMeasure, roadId: road.id, otherMeasure: h.otherMeasure })));
        if (interior.length) hitsByRoad.set(road.id, { road, hits: interior }); // endpoints reuse their existing nodes
      }
      // A newly drawn line can cross itself. Add both route measures at each crossing so
      // the resulting edges share one junction instead of leaving a visual-only X.
      const ownCrossings = crossings(body.coordinates, body.coordinates, LEVEL_TOLERANCE_M)
        .filter((h) => Math.abs(h.sourceMeasure - h.otherMeasure) > 0.02);
      for (const hit of ownCrossings) {
        allCuts.push({ x: hit.x, y: hit.y, z: hit.z, sourceMeasure: hit.sourceMeasure, roadId: 'self', otherMeasure: hit.otherMeasure });
        allCuts.push({ x: hit.x, y: hit.y, z: hit.z, sourceMeasure: hit.otherMeasure, roadId: 'self', otherMeasure: hit.sourceMeasure });
      }
      const supplied = new Map(body.affected.map((a) => [a.id, a]));
      for (const { road } of hitsByRoad.values()) {
        const lease = supplied.get(road.id);
        if (!lease || lease.revision !== road.revision) throw AppError.conflict('TOPOLOGY_REFRESH_REQUIRED', 'Intersected roads changed; refresh the topology preview', { roadId: road.id, revision: road.revision });
        await requireLease(db, 'road', road.id, lease.leaseToken, identity.collectorId, lease.sessionId);
      }

      const changeSetId = body.mutationId;
      const nodesForCuts = new Map<string, { id: string; point: XYZ }>();
      for (const hit of allCuts) {
        const key = `${Math.round(hit.x * 100)}:${Math.round(hit.y * 100)}`;
        if (!nodesForCuts.has(key)) nodesForCuts.set(key, await ensureNode(db, [hit.x, hit.y, hit.z], body.levelId ?? null, 'junction'));
      }
      const events: unknown[] = [];
      for (const { road, hits } of hitsByRoad.values()) {
        const cuts = hits.map((h) => {
          const key = `${Math.round(h.x * 100)}:${Math.round(h.y * 100)}`;
          const node = nodesForCuts.get(key)!;
          return { measure: h.otherMeasure, x: node.point[0], y: node.point[1], z: node.point[2] };
        });
        const pieces = splitAt(road.coordinates, cuts);
        if (pieces.length < 2) continue;
        const lease = supplied.get(road.id)!;
        await db.query(`UPDATE mobility.road_segments SET status='REPLACED',revision=revision+1,updated_by=$2,updated_at=now(),replaced_by='{}'
          WHERE id=$1`, [road.id, identity.collectorId]);
        const childIds: string[] = [];
        for (const piece of pieces) {
          const snapped = await snapPieceEndpoints(db, piece, road.level_id);
          const id = randomUUID(); childIds.push(id);
          await insertRoad(db, { id, parentId: road.id, coordinates: snapped.coordinates, attrs: attrsFromRow(road),
            fromNode: snapped.fromNodeId, toNode: snapped.toNodeId, owner: identity.collectorId, createdBy: road.created_by, status: road.status });
          events.push(await addChange(db, changeSetId, 'road', id, 'created', 1, identity.collectorId, { parentId: road.id }));
        }
        await db.query('UPDATE mobility.road_segments SET replaced_by=$2 WHERE id=$1', [road.id, childIds]);
        events.push(await addChange(db, changeSetId, 'road', road.id, 'replaced', road.revision + 1, identity.collectorId, { replacedBy: childIds, mutationId: body.mutationId, before: { status: road.status } }));
        await db.query(`DELETE FROM mobility.editor_leases WHERE object_type='road' AND object_id=$1 AND lease_token=$2`, [road.id, lease.leaseToken]);
      }

      const ownCuts = allCuts.map((h) => {
        const key = `${Math.round(h.x * 100)}:${Math.round(h.y * 100)}`;
        const node = nodesForCuts.get(key)!;
        return { measure: h.sourceMeasure, x: node.point[0], y: node.point[1], z: node.point[2] };
      });
      // Editing an approved road creates a draft successor and leaves the published
      // geometry intact until a later review/publish workflow promotes the change.
      const preserveApproved = prior?.status === 'APPROVED';
      const resultId = preserveApproved ? randomUUID() : body.id;
      let resultRoadId = resultId;
      const ownPieces = splitAt(body.coordinates, ownCuts);
      if (prior && ownPieces.length === 1 && !preserveApproved) {
        const piece = await snapPieceEndpoints(db, ownPieces[0], body.levelId ?? null);
        await db.query(`UPDATE mobility.road_segments SET from_node_id=$2,to_node_id=$3,name=$4,road_class=$5,structure=$6,
          pedestrian_access=$7,vehicle_access=$8,pedestrian_direction=$9,vehicle_direction=$10,width_m=$11,wheelchair_access=$12,
          building_id=$13,level_id=$14,geom=${geoJSONLine(16)},revision=revision+1,updated_by=$15,updated_at=now()
          WHERE id=$1`, [body.id, piece.fromNodeId, piece.toNodeId, body.name ?? null, body.roadClass, body.structure, body.pedestrianAccess,
          body.vehicleAccess, body.pedestrianDirection, body.vehicleDirection, body.widthM ?? null, body.wheelchairAccess,
          body.buildingId ?? null, body.levelId ?? null, identity.collectorId, JSON.stringify(piece.coordinates)]);
        events.push(await addChange(db, changeSetId, 'road', body.id, 'updated', prior.revision + 1, identity.collectorId, { mutationId: body.mutationId, before: roadBefore(prior) }));
      } else {
        const from = await ensureNode(db, body.coordinates[0], body.levelId ?? null, 'endpoint');
        const to = await ensureNode(db, body.coordinates.at(-1)!, body.levelId ?? null, 'endpoint');
        if (prior && !preserveApproved) {
          await db.query(`UPDATE mobility.road_segments SET status='REPLACED',revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`, [body.id, identity.collectorId]);
        }
        // Keep a non-routable parent row as lineage when one drawn feature becomes several network edges.
        const attrs: RoadAttrs = body;
        if (ownPieces.length > 1 && (!prior || preserveApproved)) {
          await insertRoad(db, { id: resultId, parentId: preserveApproved ? prior!.id : null, coordinates: body.coordinates, attrs, fromNode: from.id, toNode: to.id,
            owner: identity.collectorId, createdBy: identity.collectorId, status: 'REPLACED' });
        }
        const ids: string[] = [];
        for (const piece of ownPieces) {
          const snapped = await snapPieceEndpoints(db, piece, body.levelId ?? null);
          const id = ownPieces.length === 1 ? resultId : randomUUID(); ids.push(id);
          if (ownPieces.length === 1) {
            await insertRoad(db, { id, parentId: preserveApproved ? prior!.id : null, coordinates: snapped.coordinates, attrs, fromNode: snapped.fromNodeId, toNode: snapped.toNodeId,
              owner: identity.collectorId, createdBy: prior?.created_by ?? identity.collectorId, status: 'DRAFT' });
          } else {
            await insertRoad(db, { id, parentId: resultId, coordinates: snapped.coordinates, attrs, fromNode: snapped.fromNodeId, toNode: snapped.toNodeId,
              owner: identity.collectorId, createdBy: identity.collectorId, status: 'DRAFT' });
          }
          events.push(await addChange(db, changeSetId, 'road', id, 'created', 1, identity.collectorId,
            { parentId: ownPieces.length > 1 ? resultId : preserveApproved ? prior!.id : null, mutationId: body.mutationId }));
        }
        if (ownPieces.length > 1) {
          resultRoadId = ids[0];
          await db.query('UPDATE mobility.road_segments SET replaced_by=$2 WHERE id=$1', [resultId, ids]);
          events.push(await addChange(db, changeSetId, 'road', resultId, 'replaced', 1, identity.collectorId, { replacedBy: ids, mutationId: body.mutationId, ...(prior && !preserveApproved ? { before: { status: prior.status } } : {}) }));
        }
      }
      await db.query(`DELETE FROM mobility.editor_leases WHERE object_type='road' AND object_id=$1 AND lease_token=$2`, [body.id, body.leaseToken]);
      const result = { changeSetId, roadId: resultRoadId, events };
      await db.query('INSERT INTO mobility.editor_mutations(mutation_id,owner_code,result) VALUES($1,$2,$3::jsonb)',
        [body.mutationId, identity.collectorId, JSON.stringify(result)]);
      return result;
    });
  },

  async savePlace(body: PlaceSave, identity: CollectorIdentity, outer?: PoolClient) {
    await assertPointInsideTerrain(body.coordinate);
    return inTx(outer, async (db) => {
      const duplicate = await db.query<{ result: any }>(`SELECT result FROM mobility.editor_mutations WHERE mutation_id=$1 AND owner_code=$2`, [body.mutationId, identity.collectorId]);
      if (duplicate.rows[0]) return duplicate.rows[0].result;
      await requireLease(db, 'place', body.id, body.leaseToken, identity.collectorId, body.sessionId);
      const { rows } = await db.query<{ revision: number; created_by: string; status: 'DRAFT' | 'APPROVED'; before: unknown }>(`SELECT revision,created_by,status,
        jsonb_build_object('status',status,'name',name,'category',category,'description',description,'buildingId',building_id,'levelId',level_id,
          'coordinate',ST_AsGeoJSON(geom)::jsonb->'coordinates') before FROM mobility.places WHERE id=$1 AND status IN ('DRAFT','APPROVED') FOR UPDATE`, [body.id]);
      const prior = rows[0];
      if (prior && prior.revision !== body.expectedRevision) throw AppError.conflict('REVISION_CONFLICT', 'Place changed since this edit began', { currentRevision: prior.revision });
      if (!prior && body.expectedRevision != null) throw AppError.conflict('PLACE_NOT_FOUND', 'Place was removed');
      const geom = 'ST_SetSRID(ST_MakePoint($7,$8,$9),5186)';
      const preserveApproved = prior?.status === 'APPROVED';
      const resultId = preserveApproved ? randomUUID() : body.id;
      if (prior && !preserveApproved) await db.query(`UPDATE mobility.places SET name=$2,category=$3,description=$4,building_id=$5,level_id=$6,
        geom=${geom},revision=revision+1,updated_by=$10,updated_at=now() WHERE id=$1`,
      [body.id,body.name,body.category,body.description??null,body.buildingId??null,body.levelId??null,...body.coordinate,identity.collectorId]);
      else await db.query(`INSERT INTO mobility.places(id,parent_id,name,category,description,building_id,level_id,geom,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,ST_SetSRID(ST_MakePoint($8,$9,$10),5186),$11,$12)`,
      [resultId,preserveApproved ? body.id : null,body.name,body.category,body.description??null,body.buildingId??null,body.levelId??null,...body.coordinate,prior?.created_by ?? identity.collectorId,identity.collectorId]);
      const revision = (prior?.revision ?? 0) + 1;
      const event = await addChange(db, body.mutationId, 'place', resultId, prior && !preserveApproved ? 'updated' : 'created', preserveApproved ? 1 : revision, identity.collectorId,
        { parentId: preserveApproved ? body.id : null, mutationId: body.mutationId, ...(prior && !preserveApproved ? { before: prior.before } : {}) });
      await db.query(`DELETE FROM mobility.editor_leases WHERE object_type='place' AND object_id=$1 AND lease_token=$2`, [body.id, body.leaseToken]);
      const result = { changeSetId: body.mutationId, placeId: resultId, event };
      await db.query('INSERT INTO mobility.editor_mutations(mutation_id,owner_code,result) VALUES($1,$2,$3::jsonb)',
        [body.mutationId, identity.collectorId, JSON.stringify(result)]);
      return result;
    });
  },

  async retire(kind: ObjectType, id: string,
    body: { expectedRevision: number; sessionId: string; leaseToken: string; mutationId: string }, identity: CollectorIdentity, outer?: PoolClient) {
    return inTx(outer, async (db) => {
      const duplicate = await db.query<{ result: any }>(`SELECT result FROM mobility.editor_mutations WHERE mutation_id=$1 AND owner_code=$2`, [body.mutationId, identity.collectorId]);
      if (duplicate.rows[0]) return duplicate.rows[0].result;
      await requireLease(db, kind, id, body.leaseToken, identity.collectorId, body.sessionId);
      const table = kind === 'road' ? 'mobility.road_segments' : 'mobility.places';
      const { rows } = await db.query<{ revision: number; status: string }>(`SELECT revision,status FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
      const prior = rows[0];
      if (!prior || !['DRAFT', 'APPROVED'].includes(prior.status)) throw AppError.notFound(`${kind.toUpperCase()}_NOT_FOUND`, `${kind} not found`);
      if (prior.revision !== body.expectedRevision) throw AppError.conflict('REVISION_CONFLICT', `${kind} changed since this edit began`);
      await db.query(`UPDATE ${table} SET status='RETIRED',revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`, [id, identity.collectorId]);
      const event = await addChange(db, body.mutationId, kind, id, 'deleted', prior.revision + 1, identity.collectorId, { mutationId: body.mutationId, before: { status: prior.status } });
      await db.query(`DELETE FROM mobility.editor_leases WHERE object_type=$1 AND object_id=$2 AND lease_token=$3`, [kind, id, body.leaseToken]);
      const result = { changeSetId: body.mutationId, objectType: kind, objectId: id, event };
      await db.query('INSERT INTO mobility.editor_mutations(mutation_id,owner_code,result) VALUES($1,$2,$3::jsonb)',
        [body.mutationId, identity.collectorId, JSON.stringify(result)]);
      return result;
    });
  },

  /** Latest change sets, newest first, for the editor's history panel. */
  async recentChangeSets(limit: number) {
    const { rows } = await pool.query(
      `SELECT change_set_id "changeSetId", max(id) "lastId", min(created_at) "at", max(owner_code) "ownerCode",
              COALESCE((array_agg(payload->'actor') FILTER (WHERE payload ? 'actor'))[1], '{"via":"editor"}'::jsonb) actor,
              (array_agg(payload->>'revertOf') FILTER (WHERE payload ? 'revertOf'))[1] "revertOf",
              count(*) FILTER (WHERE object_type='road')::int roads, count(*) FILTER (WHERE object_type='place')::int places,
              array_agg(DISTINCT operation) operations
         FROM mobility.editor_changes GROUP BY change_set_id ORDER BY max(id) DESC LIMIT $1`, [limit]);
    return rows;
  },

  async pendingChanges(after: number) {
    const { rows } = await pool.query(`SELECT id,change_set_id "changeSetId",object_type "objectType",object_id "objectId",
      operation,revision,owner_code "ownerCode",payload,created_at "createdAt" FROM mobility.editor_changes WHERE id>$1 ORDER BY id LIMIT 1000`, [after]);
    return rows;
  },

  async undeliveredChanges() {
    const { rows } = await pool.query(`SELECT id,change_set_id "changeSetId",object_type "objectType",object_id "objectId",
      operation,revision,owner_code "ownerCode",payload,created_at "createdAt" FROM mobility.editor_changes WHERE delivered_at IS NULL ORDER BY id LIMIT 1000`);
    return rows;
  },

  async acknowledgeChange(id: number) {
    await pool.query('UPDATE mobility.editor_changes SET delivered_at=COALESCE(delivered_at,now()) WHERE id=$1', [id]);
  },
};
