// Structural edits and change-set reverts on top of editor.service (docs/EDITOR_MCP_PLAN.md P3): move a node with its
// roads, split a road at a point, merge two roads, undo one change set. Each is one transaction under the topology lock.
// Instead of lease tokens they refuse to touch anything another session currently holds a lease on.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import type { CollectorIdentity } from '../../common/auth/jwt.js';
import {
  addChange, assertPointInsideTerrain, attrsFromRow, ensureNode, geoJSONLine, insertRoad, pointAtMeasure, roadBefore, roadSelect, snapPieceEndpoints,
  type RoadAttrs, type RoadRow,
} from './editor.service.js';
import { splitAt, type XYZ } from './topology.js';

interface OpBase { sessionId: string; mutationId: string }
const inTx = <T>(outer: PoolClient | undefined, fn: (db: PoolClient) => Promise<T>): Promise<T> => (outer ? fn(outer) : withTransaction(fn));
const xyLength = (c: XYZ[]) => c.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - c[i][0], p[1] - c[i][1]), 0);

async function begin(db: PoolClient, mutationId: string, owner: string) {
  await db.query('SELECT pg_advisory_xact_lock(5186001)'); // same lock as saveRoad: one topology edit at a time
  const { rows } = await db.query<{ result: any }>('SELECT result FROM mobility.editor_mutations WHERE mutation_id=$1 AND owner_code=$2', [mutationId, owner]);
  return rows[0]?.result ?? null;
}
async function finish<T>(db: PoolClient, mutationId: string, owner: string, result: T): Promise<T> {
  await db.query('INSERT INTO mobility.editor_mutations(mutation_id,owner_code,result) VALUES($1,$2,$3::jsonb)', [mutationId, owner, JSON.stringify(result)]);
  return result;
}

/** Another session's live lease means someone is editing the object right now. */
export async function assertNotLockedByOthers(db: PoolClient, ids: string[], owner: string, sessionId: string) {
  if (!ids.length) return;
  const { rows } = await db.query(
    `SELECT object_type "objectType", object_id "objectId", owner_code "ownerCode", expires_at "expiresAt" FROM mobility.editor_leases
      WHERE expires_at > now() AND object_id = ANY($1::uuid[]) AND NOT (owner_code = $2 AND session_id = $3)`, [ids, owner, sessionId]);
  if (rows.length) throw AppError.conflict('EDITOR_OBJECT_LOCKED', 'Another worker is editing an affected object', rows[0]);
}

async function activeRoad(db: PoolClient, id: string, expectedRevision: number): Promise<RoadRow> {
  const { rows } = await db.query<RoadRow>(`${roadSelect} WHERE id=$1 AND status IN ('DRAFT','APPROVED') FOR UPDATE`, [id]);
  if (!rows[0]) throw AppError.notFound('ROAD_NOT_FOUND', `Road ${id} was removed or replaced`);
  if (rows[0].revision !== expectedRevision) throw AppError.conflict('REVISION_CONFLICT', 'Road changed since it was read', { roadId: id, currentRevision: rows[0].revision });
  return rows[0];
}

const flip = (d: RoadAttrs['pedestrianDirection']) => (d === 'forward' ? 'backward' : d === 'backward' ? 'forward' : d);
const reversed = (road: { coordinates: XYZ[]; attrs: RoadAttrs; from: string; to: string }) => ({
  coordinates: [...road.coordinates].reverse(), from: road.to, to: road.from,
  attrs: { ...road.attrs, pedestrianDirection: flip(road.attrs.pedestrianDirection), vehicleDirection: flip(road.attrs.vehicleDirection) },
});

async function replaceWith(db: PoolClient, road: RoadRow, childIds: string[], changeSetId: string, owner: string, detail: Record<string, unknown>) {
  await db.query(`UPDATE mobility.road_segments SET status='REPLACED',revision=revision+1,updated_by=$2,updated_at=now(),replaced_by=$3 WHERE id=$1`, [road.id, owner, childIds]);
  return addChange(db, changeSetId, 'road', road.id, 'replaced', road.revision + 1, owner, { replacedBy: childIds, ...detail, before: { status: road.status } });
}

export const editorOps = {
  /** Moves a network node and the end vertex of every road attached to it, so the roads stay connected. */
  async moveNode(body: OpBase & { nodeId: string; coordinate: XYZ }, identity: CollectorIdentity, outer?: PoolClient) {
    await assertPointInsideTerrain(body.coordinate);
    return inTx(outer, async (db) => {
      const owner = identity.collectorId;
      const done = await begin(db, body.mutationId, owner);
      if (done) return done;
      const { rows: nodes } = await db.query<{ id: string; level_id: string | null; revision: number; c: XYZ }>(
        `SELECT id, level_id, revision, (ST_AsGeoJSON(geom)::json->'coordinates') c FROM mobility.network_nodes WHERE id=$1 FOR UPDATE`, [body.nodeId]);
      const node = nodes[0];
      if (!node) throw AppError.notFound('NODE_NOT_FOUND', `Node ${body.nodeId} does not exist`);
      const { rows: roads } = await db.query<RoadRow>(`${roadSelect} WHERE status IN ('DRAFT','APPROVED') AND (from_node_id=$1 OR to_node_id=$1) ORDER BY id FOR UPDATE`, [node.id]);
      if (!roads.length) throw AppError.conflict('NODE_UNUSED', 'No active road uses this node');
      await assertNotLockedByOthers(db, roads.map((r) => r.id), owner, body.sessionId);
      const { rows: clash } = await db.query(
        `SELECT n.id FROM mobility.network_nodes n WHERE n.id<>$1 AND n.level_id IS NOT DISTINCT FROM $2
            AND ST_DWithin(ST_Force2D(n.geom), ST_SetSRID(ST_MakePoint($3,$4),5186), 0.15) AND abs(ST_Z(n.geom)-$5) <= 1.25
            AND EXISTS (SELECT 1 FROM mobility.road_segments r WHERE r.status IN ('DRAFT','APPROVED') AND (r.from_node_id=n.id OR r.to_node_id=n.id)) LIMIT 1`,
        [node.id, node.level_id, ...body.coordinate]);
      if (clash.length) throw AppError.conflict('NODE_COLLISION', 'Another node already sits at the target position; connect the roads there instead of moving onto it', { nodeId: clash[0].id });

      const events: unknown[] = [];
      const { rows: moved } = await db.query<{ revision: number }>(
        `UPDATE mobility.network_nodes SET geom=ST_SetSRID(ST_MakePoint($2,$3,$4),5186),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision`, [node.id, ...body.coordinate]);
      events.push(await addChange(db, body.mutationId, 'node', node.id, 'updated', moved[0].revision, owner, { moved: true, before: { coordinate: node.c } }));
      const result: { id: string; revision: number }[] = [];
      for (const road of roads) {
        const coordinates = road.coordinates.map((p) => [...p] as XYZ);
        if (road.from_node_id === node.id) coordinates[0] = [...body.coordinate];
        if (road.to_node_id === node.id) coordinates[coordinates.length - 1] = [...body.coordinate];
        if (xyLength(coordinates) < 0.05) throw AppError.badRequest('ROAD_SEGMENT_TOO_SHORT', 'Moving the node here would collapse a road', { roadId: road.id });
        await db.query(`UPDATE mobility.road_segments SET geom=${geoJSONLine(2)},revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1`,
          [road.id, JSON.stringify(coordinates), owner]);
        events.push(await addChange(db, body.mutationId, 'road', road.id, 'updated', road.revision + 1, owner, { movedNodeId: node.id, before: roadBefore(road) }));
        result.push({ id: road.id, revision: road.revision + 1 });
      }
      return finish(db, body.mutationId, owner, { changeSetId: body.mutationId, nodeId: node.id, coordinate: body.coordinate, roads: result, events });
    });
  },

  /** Splits one road at an XY distance from its start; both pieces inherit its attributes and share a new node. */
  async splitRoad(body: OpBase & { roadId: string; expectedRevision: number; measureM: number }, identity: CollectorIdentity, outer?: PoolClient) {
    return inTx(outer, async (db) => {
      const owner = identity.collectorId;
      const done = await begin(db, body.mutationId, owner);
      if (done) return done;
      const road = await activeRoad(db, body.roadId, body.expectedRevision);
      await assertNotLockedByOthers(db, [road.id], owner, body.sessionId);
      const total = xyLength(road.coordinates);
      if (body.measureM < 0.05 || body.measureM > total - 0.05) throw AppError.badRequest('SPLIT_OUT_OF_RANGE', `measureM must be between 0.05 and ${(total - 0.05).toFixed(2)}`);
      const node = await ensureNode(db, pointAtMeasure(road.coordinates, body.measureM), road.level_id, 'endpoint');
      const pieces = splitAt(road.coordinates, [{ measure: body.measureM, x: node.point[0], y: node.point[1], z: node.point[2] }]);
      if (pieces.length !== 2) throw AppError.conflict('SPLIT_FAILED', 'The split point is too close to an end of the road');
      const events: unknown[] = [];
      if (node.created) events.push(await addChange(db, body.mutationId, 'node', node.id, 'created', 1, owner, { kind: 'endpoint' }));
      const childIds: string[] = [];
      for (const piece of pieces) {
        const snapped = await snapPieceEndpoints(db, piece, road.level_id);
        const id = randomUUID(); childIds.push(id);
        await insertRoad(db, { id, parentId: road.id, coordinates: snapped.coordinates, attrs: attrsFromRow(road), fromNode: snapped.fromNodeId, toNode: snapped.toNodeId,
          owner, createdBy: road.created_by, status: road.status });
        events.push(await addChange(db, body.mutationId, 'road', id, 'created', 1, owner, { parentId: road.id, splitNodeId: node.id }));
      }
      events.push(await replaceWith(db, road, childIds, body.mutationId, owner, { splitNodeId: node.id }));
      return finish(db, body.mutationId, owner, { changeSetId: body.mutationId, nodeId: node.id, coordinate: node.point, roadIds: childIds, events });
    });
  },

  /** Joins two roads that meet at a node only they use and whose attributes agree, into one road. */
  async mergeRoads(body: OpBase & { roads: [{ id: string; expectedRevision: number }, { id: string; expectedRevision: number }] }, identity: CollectorIdentity, outer?: PoolClient) {
    return inTx(outer, async (db) => {
      const owner = identity.collectorId;
      const done = await begin(db, body.mutationId, owner);
      if (done) return done;
      if (body.roads[0].id === body.roads[1].id) throw AppError.badRequest('MERGE_SAME_ROAD', 'Give two different roads');
      const [a, b] = [await activeRoad(db, body.roads[0].id, body.roads[0].expectedRevision), await activeRoad(db, body.roads[1].id, body.roads[1].expectedRevision)];
      await assertNotLockedByOthers(db, [a.id, b.id], owner, body.sessionId);
      const shared = [a.from_node_id, a.to_node_id].filter((n) => n === b.from_node_id || n === b.to_node_id);
      if (!shared.length) throw AppError.conflict('MERGE_NOT_ADJACENT', 'The roads do not share a node');
      const nodeId = shared[0];
      const { rows: users } = await db.query<{ n: number }>(
        `SELECT count(*)::int n FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED') AND (from_node_id=$1 OR to_node_id=$1)`, [nodeId]);
      if (users[0].n !== 2) throw AppError.conflict('MERGE_AT_JUNCTION', 'Other roads also meet at the shared node, so it must stay a junction');
      const plain = (r: RoadRow) => ({ coordinates: r.coordinates, attrs: attrsFromRow(r), from: r.from_node_id, to: r.to_node_id });
      const first = a.to_node_id === nodeId ? plain(a) : reversed(plain(a));   // ends at the shared node
      const second = b.from_node_id === nodeId ? plain(b) : reversed(plain(b)); // starts at the shared node
      const { name: nameA, ...restA } = first.attrs, { name: nameB, ...restB } = second.attrs;
      const differing = (Object.keys(restA) as (keyof typeof restA)[]).filter((k) => (restA[k] ?? null) !== (restB[k] ?? null));
      if (differing.length || a.status !== b.status) throw AppError.conflict('MERGE_ATTRIBUTES_DIFFER', 'Roads must have the same status and attributes to be merged', { differing });
      if (nameA && nameB && nameA !== nameB) throw AppError.conflict('MERGE_ATTRIBUTES_DIFFER', 'The roads have different names', { differing: ['name'] });
      const id = randomUUID();
      const coordinates = [...first.coordinates, ...second.coordinates.slice(1)];
      await insertRoad(db, { id, parentId: a.id, coordinates, attrs: { ...first.attrs, name: nameA ?? nameB ?? null } as RoadAttrs, fromNode: first.from, toNode: second.to,
        owner, createdBy: a.created_by, status: a.status });
      const events: unknown[] = [await addChange(db, body.mutationId, 'road', id, 'created', 1, owner, { mergedFrom: [a.id, b.id] })];
      for (const road of [a, b]) events.push(await replaceWith(db, road, [id], body.mutationId, owner, { mergedInto: id }));
      return finish(db, body.mutationId, owner, { changeSetId: body.mutationId, roadId: id, removedNodeId: nodeId, events });
    });
  },

  /**
   * Undoes one change set with a new change set. Refuses when any affected object changed afterwards, or when the log has no
   * "before" image to restore (changes saved before before-images were recorded).
   */
  async revertChangeSet(body: OpBase & { changeSetId: string }, identity: CollectorIdentity, outer?: PoolClient) {
    return inTx(outer, async (db) => {
      const owner = identity.collectorId;
      const done = await begin(db, body.mutationId, owner);
      if (done) return done;
      const { rows: changes } = await db.query<{ id: number; objectType: 'road' | 'place' | 'node'; objectId: string; operation: string; payload: any; createdAt: Date }>(
        `SELECT id, object_type "objectType", object_id "objectId", operation, payload, created_at "createdAt" FROM mobility.editor_changes WHERE change_set_id=$1 ORDER BY id`, [body.changeSetId]);
      if (!changes.length) throw AppError.notFound('CHANGESET_NOT_FOUND', 'No such change set');
      const ids = [...new Set(changes.map((c) => c.objectId))];
      const { rows: later } = await db.query(
        `SELECT object_type "objectType", object_id "objectId", change_set_id "changeSetId", operation FROM mobility.editor_changes
          WHERE object_id = ANY($1::uuid[]) AND id > $2 AND change_set_id <> $3 ORDER BY id LIMIT 20`, [ids, changes.at(-1)!.id, body.changeSetId]);
      if (later.length) throw AppError.conflict('REVERT_BLOCKED', 'Objects of this change set were changed again later; revert those change sets first', { later });
      await assertNotLockedByOthers(db, ids, owner, body.sessionId);

      const events: unknown[] = [];
      const log = (c: { objectType: 'road' | 'place' | 'node'; objectId: string }, operation: 'created' | 'updated' | 'deleted', revision: number | null, before?: unknown) =>
        addChange(db, body.mutationId, c.objectType, c.objectId, operation, revision, owner, { revertOf: body.changeSetId, ...(before === undefined ? {} : { before }) }).then((e) => events.push(e));
      const unsupported = (c: { objectType: string; objectId: string }) => AppError.conflict('REVERT_UNSUPPORTED', 'This change was saved without a before-image and cannot be restored automatically', { objectType: c.objectType, objectId: c.objectId });

      for (const c of [...changes].reverse()) {
        const before = c.payload?.before;
        if (c.objectType === 'node') {
          if (c.operation === 'updated' && before?.coordinate) {
            const { rows } = await db.query<{ revision: number; c: XYZ }>(
              `WITH old AS (SELECT (ST_AsGeoJSON(geom)::json->'coordinates') c FROM mobility.network_nodes WHERE id=$1)
               UPDATE mobility.network_nodes n SET geom=ST_SetSRID(ST_MakePoint($2,$3,$4),5186),revision=revision+1,updated_at=now() FROM old WHERE n.id=$1 RETURNING n.revision, old.c`,
              [c.objectId, ...before.coordinate]);
            if (rows[0]) await log(c, 'updated', rows[0].revision, { coordinate: rows[0].c });
          }
          continue; // created nodes simply become unused
        }
        if (c.objectType === 'road') {
          const { rows } = await db.query<RoadRow & { created_at: Date }>(`${roadSelect.replace('created_by,', 'created_by, created_at,')} WHERE id=$1 FOR UPDATE`, [c.objectId]);
          const road = rows[0];
          if (!road) continue;
          if (c.operation === 'created') {
            if (road.status !== 'DRAFT' && road.status !== 'APPROVED') continue;
            await db.query(`UPDATE mobility.road_segments SET status='RETIRED',revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`, [road.id, owner]);
            await log(c, 'deleted', road.revision + 1, { status: road.status });
          } else if (c.operation === 'replaced' || c.operation === 'deleted') {
            if (!before?.status) {
              if (road.created_at < changes[0].createdAt) throw unsupported(c); // existed before this change set, state unknown
              continue; // a lineage parent created inside this change set: stays inactive
            }
            await db.query(`UPDATE mobility.road_segments SET status=$2,replaced_by='{}',revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1`, [road.id, before.status, owner]);
            await log(c, 'created', road.revision + 1, { status: road.status });
          } else if (c.operation === 'updated') {
            if (!before?.coordinates) throw unsupported(c);
            const a: RoadAttrs = before.attrs;
            await db.query(`UPDATE mobility.road_segments SET from_node_id=$2,to_node_id=$3,name=$4,road_class=$5,structure=$6,pedestrian_access=$7,vehicle_access=$8,
                pedestrian_direction=$9,vehicle_direction=$10,width_m=$11,wheelchair_access=$12,building_id=$13,level_id=$14,geom=${geoJSONLine(15)},
                revision=revision+1,updated_by=$16,updated_at=now() WHERE id=$1`,
              [road.id, before.fromNodeId, before.toNodeId, a.name ?? null, a.roadClass, a.structure, a.pedestrianAccess, a.vehicleAccess, a.pedestrianDirection, a.vehicleDirection,
                a.widthM ?? null, a.wheelchairAccess, a.buildingId ?? null, a.levelId ?? null, JSON.stringify(before.coordinates), owner]);
            await log(c, 'updated', road.revision + 1, roadBefore(road));
          }
          continue;
        }
        const { rows } = await db.query<{ revision: number; status: string; before: unknown }>(
          `SELECT revision, status, jsonb_build_object('status',status,'name',name,'category',category,'description',description,'buildingId',building_id,'levelId',level_id,
             'coordinate',ST_AsGeoJSON(geom)::jsonb->'coordinates') before FROM mobility.places WHERE id=$1 FOR UPDATE`, [c.objectId]);
        const place = rows[0];
        if (!place) continue;
        if (c.operation === 'created') {
          if (place.status !== 'DRAFT' && place.status !== 'APPROVED') continue;
          await db.query(`UPDATE mobility.places SET status='RETIRED',revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`, [c.objectId, owner]);
          await log(c, 'deleted', place.revision + 1, { status: place.status });
        } else if (c.operation === 'deleted') {
          if (!before?.status) throw unsupported(c);
          await db.query(`UPDATE mobility.places SET status=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1`, [c.objectId, before.status, owner]);
          await log(c, 'created', place.revision + 1, { status: place.status });
        } else if (c.operation === 'updated') {
          if (!before?.coordinate) throw unsupported(c);
          await db.query(`UPDATE mobility.places SET name=$2,category=$3,description=$4,building_id=$5,level_id=$6,geom=ST_SetSRID(ST_MakePoint($7,$8,$9),5186),
              revision=revision+1,updated_by=$10,updated_at=now() WHERE id=$1`,
            [c.objectId, before.name, before.category, before.description ?? null, before.buildingId ?? null, before.levelId ?? null, ...before.coordinate, owner]);
          await log(c, 'updated', place.revision + 1, place.before);
        }
      }
      if (!events.length) throw AppError.conflict('REVERT_NOTHING_TO_DO', 'Nothing in this change set is still in effect');
      return finish(db, body.mutationId, owner, { changeSetId: body.mutationId, revertedChangeSetId: body.changeSetId, restored: events.length, events });
    });
  },
};
