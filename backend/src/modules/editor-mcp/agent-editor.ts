// How an agent edits (docs/EDITOR_MCP_PLAN.md 7.3–7.4): the same service calls a browser makes, but one or many
// operations run in ONE transaction. Leases are taken and consumed inside it, so an agent never blocks a person between
// tool calls, a failing step undoes everything, and a dry run is the real code path followed by ROLLBACK.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { Uuid } from '../../common/dto.js';
import { CAMPUS_FRAME } from '../../geo/campus-frame.js';
import { terrain, type TerrainContext } from '../../geo/terrain.js';
import { editorAgents, editorPresence, type OverlayItem } from '../../realtime/editor.gateway.js';
import { PlaceSave, RoadSave } from '../editor/editor.dto.js';
import { editorOps } from '../editor/editor.ops.js';
import { JUNCTION_RADIUS_M, attrsFromRow, editorService, geoJSONLine, isConnector, roadSelect, withEditorActor, type RoadAttrs, type RoadRow } from '../editor/editor.service.js';
import { projectOnLine, type XYZ } from '../editor/topology.js';
import { fusionRunsRepository } from '../fusion/fusion-runs.repository.js';
import { pathfusionService } from '../pathfusion/pathfusion.service.js';
import { SCOPE_APPROVED, type AgentContext } from './mcp.context.js';
import { lineLength, round2, roundXYZ, simplifyIndices } from './geometry.js';
import { PathItem, resolvePath, type ResolveDeps } from './path-resolver.js';
import { corridorCenterline, sameRoad3D } from './corridor.js';
import { terrainContext } from './terrain-access.js';

export const LIMITS = { vertices: 2000, lengthM: 2000, affectedRoads: 20, mutationsPerMinute: 60, opsPerBatch: 25 };

// ---- operation schemas (shared by the single-purpose tools and apply_changes) ----
const road = RoadSave.shape, place = PlaceSave.shape;
// The REST schema fills omitted attributes with defaults; here "omitted" must stay omitted (presets on create, unchanged on update).
const RoadAttrsInput = z.object({
  name: road.name, structure: road.structure.unwrap().optional(), pedestrianAccess: road.pedestrianAccess.unwrap().optional(), vehicleAccess: road.vehicleAccess.unwrap().optional(),
  pedestrianDirection: road.pedestrianDirection.unwrap().optional(), vehicleDirection: road.vehicleDirection.unwrap().optional(), widthM: road.widthM,
  wheelchairAccess: road.wheelchairAccess.unwrap().optional(), buildingId: road.buildingId, levelId: road.levelId, displayColor: road.displayColor,
});
const PathOptions = {
  zMode: z.enum(['terrain', 'explicit']).default('terrain').describe('terrain: points without z take the ground height. explicit: every xy needs z'),
  terrainOffsetM: z.number().min(-50).max(50).default(0),
  densify: z.boolean().default(true).describe('Add vertices where the ground between two terrain-height vertices deviates more than 0.3 m from a straight line'),
  runZ: z.enum(['terrain', 'run_h']).default('terrain').describe('Heights for run stretches: terrain (default), or the recorded phone heights'),
};
const Position = PathItem.describe('Where: {xy:[x,y]} (terrain height unless z is given) or {at:{...}} for an existing object or a person\'s cursor');

export const CreateRoad = z.object({
  roadClass: road.roadClass,
  ...RoadAttrsInput.shape,
  path: z.array(PathItem).min(1).max(200).describe('Ordered elements; together at least two vertices. Use {at:{roadId,...}} wherever the road must connect to an existing road'),
  ...PathOptions,
});
const VertexOp = z.object({
  op: z.enum(['move', 'insert', 'delete', 'replaceRange']),
  index: z.number().int().min(0).describe('move/delete: the vertex. insert: the new vertex goes AFTER this index. replaceRange: first vertex replaced'),
  toIndex: z.number().int().min(0).optional().describe('replaceRange only: last vertex replaced (inclusive)'),
  point: PathItem.optional().describe('move/insert: the new position'),
  path: z.array(PathItem).max(200).optional().describe('replaceRange: what goes in place of the range'),
});
export const UpdateRoad = z.object({
  id: Uuid, expectedRevision: z.number().int().positive(),
  attrs: RoadAttrsInput.extend({ roadClass: road.roadClass.optional() }).partial().optional().describe('Only the attributes to change'),
  path: z.array(PathItem).min(1).max(200).optional().describe('Replace the whole geometry'),
  vertexOps: z.array(VertexOp).max(100).optional().describe('Edit single vertices, applied in order; indices refer to the geometry as it is after the previous op'),
  reverse: z.boolean().optional().describe('Flip the vertex order; forward/backward directions are flipped too, so the real travel direction is kept'),
  simplifyM: z.number().positive().max(5).optional().describe('Drop vertices closer than this to the simplified line'),
  drapeToTerrain: z.boolean().optional().describe('Reset every vertex height to the ground (end vertices on shared nodes keep theirs)'),
  ...PathOptions,
});
export const ConnectRoads = z.object({ at: Position });
export const CreatePlace = z.object({ name: place.name, category: place.category, description: place.description, buildingId: place.buildingId, levelId: place.levelId, position: Position });
export const UpdatePlace = z.object({
  id: Uuid, expectedRevision: z.number().int().positive(), name: place.name.optional(), category: place.category.optional(),
  description: place.description, buildingId: place.buildingId, levelId: place.levelId, position: Position.optional(),
});
export const RetireFeature = z.object({ type: z.enum(['road', 'place']), id: Uuid, expectedRevision: z.number().int().positive() });
export const MoveNode = z.object({ nodeId: Uuid, to: Position });
export const MergeNodes = z.object({ keepNodeId: Uuid, removeNodeId: Uuid });
export const SplitRoad = z.object({ roadId: Uuid, expectedRevision: z.number().int().positive(),
  measureM: z.number().positive().optional().describe('Distance from the start of the road'), nearest: z.tuple([z.number(), z.number()]).optional().describe('Or: split at the point closest to this [x, y]') });
export const MergeRoads = z.object({ roads: z.tuple([z.object({ id: Uuid, expectedRevision: z.number().int().positive() }), z.object({ id: Uuid, expectedRevision: z.number().int().positive() })]) });
export const RevertChangeSet = z.object({ changeSetId: Uuid });
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((c) => c.toLowerCase());
export const SetRoadStyle = z.object({ id: Uuid, displayColor: HexColor.nullable().describe('"#rrggbb" shown to every editor, or null to go back to the automatic floor/type colour') });
export const CreateCorridor = z.object({
  tracks: z.array(z.object({ runId: Uuid, fromSeq: z.number().int().optional(), toSeq: z.number().int().optional() })).min(1).max(30)
    .describe('Recorded walks of the same passage (fusion runs, optionally a seq range each). Direction does not matter'),
  roadClass: road.roadClass.default('pedestrian'),
  ...RoadAttrsInput.shape,
  zSource: z.enum(['run', 'terrain']).default('run').describe('run: median track height minus phoneHeightM (indoor floors). terrain: ground height'),
  phoneHeightM: z.number().min(0).max(2.5).default(1.1),
  stepM: z.number().min(0.25).max(10).default(1), searchRadiusM: z.number().min(0.5).max(30).default(6), simplifyM: z.number().min(0).max(5).default(0.3),
  startAt: PathItem.optional().describe('Optional exact start, e.g. {at:{roadId,...}} or {at:{nodeId}}, prepended so the corridor connects there'),
  endAt: PathItem.optional().describe('Optional exact end, appended likewise'),
});

export const OP_SCHEMAS = {
  create_road: CreateRoad, update_road: UpdateRoad, connect_roads: ConnectRoads, create_place: CreatePlace, update_place: UpdatePlace,
  retire_feature: RetireFeature, move_node: MoveNode, split_road: SplitRoad, merge_roads: MergeRoads, revert_changeset: RevertChangeSet,
  set_road_style: SetRoadStyle, create_corridor: CreateCorridor, merge_nodes: MergeNodes,
} as const;
export type OpName = keyof typeof OP_SCHEMAS;
export interface Op { op: OpName; args: any }

// ---- helpers ----
interface Run { db: PoolClient; ctx: AgentContext; terrain: TerrainContext; overlay: OverlayItem[]; focus?: XYZ }
class Rollback { constructor(readonly results: unknown[]) {} }

const recent = new Map<string, number[]>();
function rateLimit(ctx: AgentContext, count: number) {
  const now = Date.now(), list = (recent.get(ctx.sessionId) ?? []).filter((t) => now - t < 60_000);
  if (list.length + count > LIMITS.mutationsPerMinute) throw new AppError(429, 'RATE_LIMITED', `At most ${LIMITS.mutationsPerMinute} changes per minute; wait and retry`);
  recent.set(ctx.sessionId, [...list, ...Array<number>(count).fill(now)]);
}

async function loadRoad(db: PoolClient, id: string, active = true): Promise<RoadRow> {
  const { rows } = await db.query<RoadRow>(`${roadSelect} WHERE id=$1`, [id]);
  if (!rows[0] || (active && rows[0].status !== 'DRAFT' && rows[0].status !== 'APPROVED')) throw AppError.notFound('ROAD_NOT_FOUND', `Road ${id} does not exist or was removed/replaced`);
  return rows[0];
}
function expectRevision(kind: string, id: string, current: number, expected: number) {
  if (current !== expected) throw AppError.conflict('REVISION_CONFLICT', `${kind} changed since it was read`, { id, currentRevision: current });
}
function protectApproved(ctx: AgentContext, status: string, what: string) {
  if (status === 'APPROVED' && !ctx.scopes.includes(SCOPE_APPROVED)) throw AppError.forbidden('APPROVED_PROTECTED', `${what} is APPROVED; agents may only change DRAFT objects`);
}
const lease = async (run: Run, objectType: 'road' | 'place', objectId: string) =>
  (await editorService.acquireLease({ objectType, objectId, sessionId: run.ctx.sessionId }, run.ctx.identity, run.db)).leaseToken as string;

function deps(run: Run): ResolveDeps {
  const ox = CAMPUS_FRAME.originE, oy = CAMPUS_FRAME.originN;
  const point = async (table: string, id: string, code: string) => {
    const { rows } = await run.db.query<{ c: XYZ }>(`SELECT (ST_AsGeoJSON(geom)::json->'coordinates') c FROM mobility.${table} WHERE id=$1`, [id]);
    if (!rows[0]) throw AppError.notFound(code, `${id} does not exist`);
    return { coordinate: rows[0].c };
  };
  return {
    road: async (id) => { const r = await loadRoad(run.db, id, false); return { id: r.id, levelId: r.level_id, status: r.status, coordinates: r.coordinates }; },
    node: (id) => point('network_nodes', id, 'NODE_NOT_FOUND'),
    place: (id) => point('places', id, 'PLACE_NOT_FOUND'),
    cursorOf: (collectorId) => editorPresence.snapshot().participants.filter((p) => p.collectorId === collectorId && !p.agent && p.cursor).sort((a, b) => b.at - a.at)[0]?.cursor ?? null,
    runTrack: async (runId) => {
      const rows = await fusionRunsRepository.positions(runId, 'FINAL');
      if (!rows.length) throw AppError.notFound('RUN_HAS_NO_TRACK', `Run ${runId} has no FINAL track`);
      return rows.map((p) => ({ seq: p.seq, x: p.x + ox, y: p.y + oy, h: p.h, t: p.t, sigmaZ: p.zDatumSigma }));
    },
    canonical: async (pathId) => ((await pathfusionService.canonicalPath(pathId)) as any).points.map((p: any) => ({ idx: p.idx, x: p.x + ox, y: p.y + oy })),
    ground: (x, y) => terrain.sampleXY(run.terrain, x, y)?.height ?? null,
  };
}
async function position(run: Run, item: PathItem, levelId: string | null = null): Promise<XYZ> {
  // A position on a road is just a location here, so its level does not have to match anything.
  const resolved = await resolvePath([item], { ...deps(run), road: async (id) => ({ ...(await deps(run).road(id)), levelId }) }, { levelId, densify: false });
  if (resolved.coordinates.length !== 1) throw AppError.badRequest('INVALID_POSITION', 'A position must be a single point (xy or at)');
  return resolved.coordinates[0];
}

/** Do all roads passing through this point end at one shared node there? anyLevel: a connector meeting another level's road. */
async function connectedAt(db: PoolClient, p: XYZ, levelId: string | null, anyLevel = false) {
  const { rows } = await db.query<{ id: string; from: string; to: string; ds: number; de: number }>(
    `SELECT id, from_node_id "from", to_node_id "to", ST_Distance(ST_Force2D(ST_StartPoint(geom)), pt)::float8 ds, ST_Distance(ST_Force2D(ST_EndPoint(geom)), pt)::float8 de
       FROM mobility.road_segments, (SELECT ST_SetSRID(ST_MakePoint($1,$2),5186) pt, ST_SetSRID(ST_MakePoint($1,$2,$3),5186) pz) q
      WHERE status IN ('DRAFT','APPROVED') AND ($5 OR level_id IS NOT DISTINCT FROM $4) AND ST_3DDWithin(geom, q.pz, 0.3) AND ST_DWithin(ST_Force2D(geom), q.pt, 0.03)`, [...p, levelId, anyLevel]);
  const nodes = rows.flatMap((r) => [...(r.ds < 0.16 ? [r.from] : []), ...(r.de < 0.16 ? [r.to] : [])]);
  const through = rows.filter((r) => r.ds >= 0.16 && r.de >= 0.16).map((r) => r.id);
  return { connected: rows.length >= 2 && !through.length && new Set(nodes).size === 1, nodeId: nodes[0] ?? null, roadIds: rows.map((r) => r.id), passingThrough: through };
}

/** Compact account of what a change set did, read back inside the transaction. */
async function summarize(run: Run, result: { changeSetId: string; events?: any[]; event?: any }) {
  const events: any[] = result.events ?? (result.event ? [result.event] : []);
  const ids = (type: string, ...ops: string[]) => events.filter((e) => e.objectType === type && ops.includes(e.operation)).map((e) => e.objectId as string);
  const activeIds = [...new Set(ids('road', 'created', 'updated'))];
  const { rows } = await run.db.query<RoadRow>(`${roadSelect} WHERE id = ANY($1::uuid[]) AND status IN ('DRAFT','APPROVED')`, [activeIds]);
  const { rows: degrees } = await run.db.query<{ node: string; n: number }>(
    `SELECT node, count(*)::int n FROM (SELECT from_node_id node FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED')
       UNION ALL SELECT to_node_id FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED')) t WHERE node = ANY($1::uuid[]) GROUP BY node`,
    [rows.flatMap((r) => [r.from_node_id, r.to_node_id])]);
  const degree = new Map(degrees.map((d) => [d.node, d.n]));
  for (const r of rows) run.overlay.push({ kind: 'line', coordinates: r.coordinates, style: 'proposal', label: r.name ?? undefined });
  if (rows[0]) run.focus = rows[0].coordinates.at(-1);
  return {
    changeSetId: result.changeSetId,
    roads: rows.map((r) => ({ id: r.id, revision: r.revision, status: r.status, name: r.name, lengthM: round2(lineLength(r.coordinates)), vertexCount: r.coordinates.length,
      start: { nodeId: r.from_node_id, at: roundXYZ(r.coordinates[0]), roadsAtNode: degree.get(r.from_node_id) ?? 1 },
      end: { nodeId: r.to_node_id, at: roundXYZ(r.coordinates.at(-1)!), roadsAtNode: degree.get(r.to_node_id) ?? 1 } })),
    replacedRoads: events.filter((e) => e.objectType === 'road' && e.operation === 'replaced').map((e) => ({ id: e.objectId, replacedBy: e.payload?.replacedBy ?? [] })),
    retired: events.filter((e) => e.operation === 'deleted').map((e) => ({ type: e.objectType, id: e.objectId })),
    nodesCreated: ids('node', 'created'),
  };
}

/** Did each {at:{nodeId}} end vertex really land on that node? Interior node references are only positions. */
function nodeRefStates(summary: Awaited<ReturnType<typeof summarize>>, refs: { vertexIndex: number; nodeId: string }[], vertexCount: number) {
  return refs.map((ref) => {
    const used = ref.vertexIndex === 0 ? summary.roads[0]?.start.nodeId : ref.vertexIndex === vertexCount - 1 ? summary.roads.at(-1)?.end.nodeId : undefined;
    return { vertexIndex: ref.vertexIndex, nodeId: ref.nodeId, usedNodeId: used ?? null, connected: used === ref.nodeId || used === undefined };
  });
}

function presets(roadClass: RoadAttrs['roadClass']) {
  // Same starting values the editor UI applies when a drawing tool is picked.
  return roadClass === 'pedestrian' ? { pedestrianAccess: 'allowed', vehicleAccess: 'prohibited' }
    : roadClass === 'vehicle' ? { pedestrianAccess: 'prohibited', vehicleAccess: 'allowed' } : { pedestrianAccess: 'allowed', vehicleAccess: 'allowed' };
}

/** Preview, take the leases the save needs, save. `self` = the road being edited (it must not count as a crossing of itself). */
async function saveRoadGeometry(run: Run, id: string, expectedRevision: number | null, attrs: RoadAttrs, coordinates: XYZ[], anchors: { roadId: string; measureM: number; vertexIndex: number }[]) {
  if (coordinates.length < 2) throw AppError.badRequest('ROAD_TOO_SHORT', 'A road needs at least two distinct vertices');
  if (coordinates.length > LIMITS.vertices) throw AppError.badRequest('TOO_MANY_VERTICES', `At most ${LIMITS.vertices} vertices per road; simplify the path`);
  const length = lineLength(coordinates);
  if (length > LIMITS.lengthM) throw AppError.badRequest('ROAD_TOO_LONG', `At most ${LIMITS.lengthM} m per road; split it into several roads`);
  if (attrs.structure === 'stairs' && attrs.vehicleAccess === 'allowed') throw AppError.badRequest('ATTRIBUTE_CONFLICT', 'Stairs cannot allow vehicles');
  if (attrs.roadClass === 'pedestrian' && attrs.vehicleAccess === 'allowed') throw AppError.badRequest('ATTRIBUTE_CONFLICT', 'A pedestrian road cannot allow vehicles; use roadClass "shared"');
  if (attrs.roadClass === 'vehicle' && attrs.pedestrianAccess === 'allowed') throw AppError.badRequest('ATTRIBUTE_CONFLICT', 'A vehicle road cannot allow pedestrians; use roadClass "shared"');
  const levelId = attrs.levelId ?? null;
  const connector = isConnector(attrs.structure);
  // A duplicate is the same road in 3D, on any level and in either direction. The plan shape alone is not enough:
  // stair flights stacked in one stairwell and elevator pieces of one shaft share it and differ only in height.
  const { rows: planTwins } = await run.db.query<RoadRow>(
    `${roadSelect} WHERE status IN ('DRAFT','APPROVED') AND id<>$1 AND ST_HausdorffDistance(ST_Force2D(geom), ST_Force2D(${geoJSONLine(2)})) < 0.05`,
    [id, JSON.stringify(coordinates)]);
  const twin = planTwins.find((r) => sameRoad3D(r.coordinates, coordinates));
  if (twin) throw AppError.conflict('DUPLICATE_GEOMETRY', 'An active road with the same 3D geometry already exists', { roadId: twin.id, levelId: twin.level_id });

  const preview = await editorService.previewTopology(coordinates, levelId, undefined, anchors, run.db, attrs.structure);
  const crossings = preview.crossings.filter((c) => c.roadId !== id);
  const needsLease = preview.needsLease.filter((n) => n.id !== id);
  if (needsLease.length > LIMITS.affectedRoads) throw AppError.badRequest('TOO_MANY_AFFECTED_ROADS', `This would split ${needsLease.length} existing roads (limit ${LIMITS.affectedRoads}); draw it in shorter pieces`);
  for (const c of crossings) if (c.requiresLease) protectApproved(run.ctx, c.status, `Road ${c.roadId}, which this line would split,`);
  const leaseToken = await lease(run, 'road', id);
  const affected = [];
  for (const n of needsLease) affected.push({ id: n.id, revision: n.revision, leaseToken: await lease(run, 'road', n.id), sessionId: run.ctx.sessionId });
  const saved = await editorService.saveRoad(RoadSave.parse({ id, ...attrs, coordinates, expectedRevision, leaseToken, sessionId: run.ctx.sessionId, anchors, affected, mutationId: randomUUID() }), run.ctx.identity, run.db);

  const connections = [];
  for (const anchor of anchors) {
    const at = coordinates[anchor.vertexIndex];
    const state = await connectedAt(run.db, at, levelId, connector);
    connections.push({ toRoadId: anchor.roadId, at: roundXYZ(at), connected: state.connected, nodeId: state.connected ? state.nodeId : null });
  }
  return { saved, lengthM: round2(length), crossings: crossings.map((c) => ({ roadId: c.roadId, at: roundXYZ(c.coordinate), splitsThatRoad: c.requiresLease, zDeltaM: round2(c.zDeltaM) })),
    selfCrossings: preview.selfCrossings.length, connections };
}

// ---- operations ----
const OPS: { [K in OpName]: (run: Run, args: z.infer<(typeof OP_SCHEMAS)[K]>) => Promise<Record<string, unknown>> } = {
  async create_road(run, a) {
    const { path, zMode, terrainOffsetM, densify, runZ, roadClass, ...given } = a;
    const attrs = { roadClass, structure: 'ordinary', pedestrianDirection: 'both', vehicleDirection: 'both', wheelchairAccess: 'unknown', ...presets(roadClass),
      ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) } as RoadAttrs;
    const resolved = await resolvePath(path, deps(run), { zMode, terrainOffsetM, densify, runZ, levelId: attrs.levelId ?? null, crossLevel: isConnector(attrs.structure) });
    const id = randomUUID();
    const r = await saveRoadGeometry(run, id, null, attrs, resolved.coordinates, resolved.anchors);
    const summary = await summarize(run, r.saved);
    const nodeRefs = nodeRefStates(summary, resolved.nodeRefs, resolved.coordinates.length);
    const failed = r.connections.filter((c) => !c.connected);
    return { ...summary, crossings: r.crossings, selfCrossings: r.selfCrossings, connections: r.connections, nodeRefs, sources: resolved.sources,
      warnings: [...resolved.warnings, ...(failed.length ? [`NOT CONNECTED at ${failed.length} referenced point(s): inspect with find_nearby, then use connect_roads there`] : []),
        ...nodeRefs.filter((n) => !n.connected).map((n) => `NODE_NOT_REUSED: path vertex ${n.vertexIndex} referenced node ${n.nodeId}, but the road ${n.vertexIndex === 0 ? 'starts' : 'ends'} on node ${n.usedNodeId ?? '(interior vertex)'}; it is NOT connected to the referenced node (different level or height?)`),
        ...(summary.roads.length > 1 ? ['The line crosses itself or other roads, so it was saved as several road pieces'] : [])] };
  },

  async create_corridor(run, a) {
    const { tracks, zSource, phoneHeightM, stepM, searchRadiusM, simplifyM, startAt, endAt, roadClass, ...given } = a;
    const loaded = [];
    for (const t of tracks) {
      const lo = Math.min(t.fromSeq ?? -Infinity, t.toSeq ?? Infinity), hi = Math.max(t.fromSeq ?? -Infinity, t.toSeq ?? Infinity);
      const points = (await deps(run).runTrack(t.runId)).filter((q) => q.seq >= lo && q.seq <= hi);
      if (points.length < 2) throw AppError.badRequest('TRACK_RANGE_EMPTY', `Run ${t.runId}: fewer than two track points in that range`);
      loaded.push(points.map((q) => ({ x: q.x, y: q.y, h: q.h, run: t.runId, t: q.t, sigmaZ: q.sigmaZ })));
    }
    let corridor;
    try {
      corridor = corridorCenterline(loaded, { zSource, phoneHeightM, stepM, searchRadiusM, simplifyM }, (x, y) => terrain.sampleXY(run.terrain, x, y)?.height ?? null);
    } catch (err) { throw AppError.badRequest('CORRIDOR_FAILED', (err as Error).message); }
    const attrs = { roadClass, structure: 'indoor_corridor', pedestrianDirection: 'both', vehicleDirection: 'both', wheelchairAccess: 'unknown', ...presets(roadClass),
      ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) } as RoadAttrs;
    if (attrs.widthM == null && corridor.widthM != null) attrs.widthM = corridor.widthM;
    const path: PathItem[] = [...(startAt ? [startAt] : []), ...corridor.coordinates.map((c) => ({ xy: [c[0], c[1]] as [number, number], z: c[2] })), ...(endAt ? [endAt] : [])];
    const resolved = await resolvePath(path, deps(run), { zMode: 'explicit', terrainOffsetM: 0, densify: false, runZ: 'terrain', levelId: attrs.levelId ?? null, crossLevel: isConnector(attrs.structure) });
    const r = await saveRoadGeometry(run, randomUUID(), null, attrs, resolved.coordinates, resolved.anchors);
    const summary = await summarize(run, r.saved);
    const { coordinates: _c, warnings: corridorWarnings, ...stats } = corridor;
    return { ...summary, corridor: { ...stats, widthM: attrs.widthM ?? null, estimatedWidthM: corridor.widthM, vertexCount: resolved.coordinates.length },
      crossings: r.crossings, connections: r.connections,
      warnings: [...corridorWarnings, ...resolved.warnings, ...(corridor.coverage < 0.6 ? [`Only ${Math.round(corridor.coverage * 100)}% of the passage is covered by two or more tracks`] : [])] };
  },

  async set_road_style(run, a) {
    await loadRoad(run.db, a.id);
    const saved = await editorService.setRoadStyle(a.id, { displayColor: a.displayColor, sessionId: run.ctx.sessionId, mutationId: randomUUID() }, run.ctx.identity, run.db);
    return { changeSetId: saved.changeSetId, roadId: a.id, displayColor: a.displayColor, ...(saved.unchanged ? { note: 'The road already had this colour' } : {}) };
  },

  async update_road(run, a) {
    if (a.path && a.vertexOps) throw AppError.badRequest('INVALID_UPDATE', 'Use either path or vertexOps, not both');
    const current = await loadRoad(run.db, a.id);
    expectRevision('Road', a.id, current.revision, a.expectedRevision);
    protectApproved(run.ctx, current.status, 'This road');
    let attrs: RoadAttrs = { ...attrsFromRow(current), ...Object.fromEntries(Object.entries(a.attrs ?? {}).filter(([, v]) => v !== undefined)) } as RoadAttrs;
    const options = { zMode: a.zMode, terrainOffsetM: a.terrainOffsetM, densify: a.densify, runZ: a.runZ, levelId: attrs.levelId ?? null, crossLevel: isConnector(attrs.structure) };
    type V = { p: XYZ; anchor?: { roadId: string; measureM: number } };
    const resolveMany = async (items: PathItem[]): Promise<V[]> => {
      const r = await resolvePath(items, deps(run), options);
      return r.coordinates.map((p, i) => ({ p, anchor: r.anchors.find((x) => x.vertexIndex === i) }));
    };
    let vertices: V[] = current.coordinates.map((p) => ({ p }));
    const warnings: string[] = [];
    if (a.path) vertices = await resolveMany(a.path);
    for (const [n, op] of (a.vertexOps ?? []).entries()) {
      const bad = (message: string) => AppError.badRequest('INVALID_VERTEX_OP', `vertexOps[${n}]: ${message}`);
      if (!vertices[op.index]) throw bad(`index ${op.index} is out of range (0..${vertices.length - 1})`);
      if (op.op === 'delete') { if (vertices.length <= 2) throw bad('a road keeps at least two vertices'); vertices.splice(op.index, 1); continue; }
      if (op.op === 'replaceRange') {
        const to = op.toIndex ?? op.index;
        if (to < op.index || !vertices[to] || !op.path?.length) throw bad('needs toIndex >= index within range and a non-empty path');
        vertices.splice(op.index, to - op.index + 1, ...(await resolveMany(op.path)));
        continue;
      }
      if (!op.point) throw bad('needs point');
      const made = await resolveMany([op.point]);
      if (made.length !== 1) throw bad('point must be a single position (xy or at)');
      if (op.op === 'move') vertices[op.index] = made[0]; else vertices.splice(op.index + 1, 0, made[0]);
    }
    if (a.simplifyM) vertices = simplifyIndices(vertices.map((v) => v.p), a.simplifyM).map((i) => vertices[i]);
    if (a.drapeToTerrain) {
      const { rows: shared } = await run.db.query<{ node: string }>(
        `SELECT n node FROM unnest($1::uuid[]) n WHERE (SELECT count(*) FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED') AND id<>$2 AND (from_node_id=n OR to_node_id=n)) > 0`,
        [[current.from_node_id, current.to_node_id], a.id]);
      const keep = new Set(shared.map((s) => s.node));
      vertices = vertices.map((v, i) => {
        const pinned = v.anchor || (i === 0 && keep.has(current.from_node_id)) || (i === vertices.length - 1 && keep.has(current.to_node_id));
        const g = terrain.sampleXY(run.terrain, v.p[0], v.p[1])?.height;
        return pinned || g === undefined ? v : { ...v, p: [v.p[0], v.p[1], g + a.terrainOffsetM] as XYZ };
      });
      if (keep.size) warnings.push('End vertices on nodes shared with other roads kept their height; use move_node to change those');
    }
    if (a.reverse) {
      const flip = (d: RoadAttrs['pedestrianDirection']) => (d === 'forward' ? 'backward' : d === 'backward' ? 'forward' : d);
      vertices.reverse();
      attrs = { ...attrs, pedestrianDirection: flip(attrs.pedestrianDirection), vehicleDirection: flip(attrs.vehicleDirection) };
    }
    const coordinates = vertices.map((v) => v.p);
    // A moved end leaves the other roads on the old node: warn, because that silently disconnects them.
    for (const [end, node, before, after] of [['start', current.from_node_id, current.coordinates[0], coordinates[0]], ['end', current.to_node_id, current.coordinates.at(-1)!, coordinates.at(-1)!]] as const) {
      if (Math.hypot(before[0] - after[0], before[1] - after[1]) <= 0.15 && Math.abs(before[2] - after[2]) <= 1.25) continue;
      const { rows } = await run.db.query<{ n: number }>(`SELECT count(*)::int n FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED') AND id<>$1 AND (from_node_id=$2 OR to_node_id=$2)`, [a.id, node]);
      if (rows[0].n) warnings.push(`ENDPOINT_DETACHED: the ${end} moved away from a node that ${rows[0].n} other road(s) use; they are no longer connected to this road. Use move_node to move a junction with all its roads`);
    }
    const anchors = vertices.flatMap((v, vertexIndex) => (v.anchor ? [{ ...v.anchor, vertexIndex }] : []));
    const r = await saveRoadGeometry(run, a.id, a.expectedRevision, attrs, coordinates, anchors);
    const summary = await summarize(run, r.saved);
    if (!summary.roads.some((x) => x.id === a.id)) warnings.push('The road now crosses other geometry and was replaced by new road pieces with new ids (see roads)');
    return { ...summary, crossings: r.crossings, selfCrossings: r.selfCrossings, connections: r.connections, warnings };
  },

  async connect_roads(run, a) {
    let at = await position(run, a.at);
    if (a.at.xy && a.at.z === undefined) {
      // The terrain height may be far from roads drawn with measured heights: take the height of the nearest road instead.
      const { rows } = await run.db.query<RoadRow>(`${roadSelect} WHERE status IN ('DRAFT','APPROVED') AND ST_DWithin(ST_Force2D(geom), ST_SetSRID(ST_MakePoint($1,$2),5186), $3)`, [at[0], at[1], JUNCTION_RADIUS_M]);
      const nearest = rows.map((r) => projectOnLine(r.coordinates, at)!).sort((x, y) => x.distance - y.distance)[0];
      if (nearest) at = [at[0], at[1], nearest.point[2]];
    }
    const preview = await editorService.previewJunction(at, run.db);
    if (preview.alreadyConnected) throw AppError.conflict('JUNCTION_UNAVAILABLE', 'These roads already share a node here');
    if (preview.roads.length < 2) throw AppError.conflict('JUNCTION_UNAVAILABLE', `Fewer than two roads within ${JUNCTION_RADIUS_M} m on one level and height here`, { roadsFound: preview.roads.map((r) => r.id) });
    const roads = [];
    for (const r of preview.roads) {
      protectApproved(run.ctx, r.status, `Road ${r.id}`);
      roads.push({ id: r.id, revision: r.revision, leaseToken: await lease(run, 'road', r.id) });
    }
    const saved = await editorService.saveJunction({ coordinate: at, roads, sessionId: run.ctx.sessionId, mutationId: randomUUID() }, run.ctx.identity, run.db);
    run.overlay.push({ kind: 'point', coordinates: [saved.coordinate], style: 'proposal', label: 'junction' });
    return { ...(await summarize(run, saved)), nodeId: saved.nodeId, at: roundXYZ(saved.coordinate), roadsConnected: saved.roadCount };
  },

  async create_place(run, a) {
    const { position: where, ...fields } = a;
    const coordinate = await position(run, where);
    const id = randomUUID();
    const saved = await editorService.savePlace(PlaceSave.parse({ id, ...fields, coordinate, expectedRevision: null, leaseToken: await lease(run, 'place', id), sessionId: run.ctx.sessionId, mutationId: randomUUID() }), run.ctx.identity, run.db);
    run.overlay.push({ kind: 'point', coordinates: [coordinate], style: 'proposal', label: a.name });
    run.focus = coordinate;
    return { changeSetId: saved.changeSetId, placeId: saved.placeId, revision: 1, coordinate: roundXYZ(coordinate) };
  },

  async update_place(run, a) {
    const { rows } = await run.db.query<any>(
      `SELECT name, category, description, building_id "buildingId", level_id "levelId", status, revision, (ST_AsGeoJSON(geom)::json->'coordinates') coordinate
         FROM mobility.places WHERE id=$1 AND status IN ('DRAFT','APPROVED')`, [a.id]);
    const current = rows[0];
    if (!current) throw AppError.notFound('PLACE_NOT_FOUND', `Place ${a.id} does not exist or was removed`);
    expectRevision('Place', a.id, current.revision, a.expectedRevision);
    protectApproved(run.ctx, current.status, 'This place');
    const { id, expectedRevision, position: where, ...changes } = a;
    const coordinate = where ? await position(run, where) : current.coordinate;
    const { status: _s, revision: _r, coordinate: _c, ...fields } = current;
    const saved = await editorService.savePlace(PlaceSave.parse({ id, ...fields, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)), coordinate, expectedRevision,
      leaseToken: await lease(run, 'place', id), sessionId: run.ctx.sessionId, mutationId: randomUUID() }), run.ctx.identity, run.db);
    run.overlay.push({ kind: 'point', coordinates: [coordinate], style: 'proposal', label: a.name ?? current.name });
    return { changeSetId: saved.changeSetId, placeId: saved.placeId, revision: expectedRevision + 1, coordinate: roundXYZ(coordinate) };
  },

  async retire_feature(run, a) {
    const table = a.type === 'road' ? 'road_segments' : 'places';
    const { rows } = await run.db.query<{ status: string; c: any }>(`SELECT status, (ST_AsGeoJSON(geom)::json->'coordinates') c FROM mobility.${table} WHERE id=$1`, [a.id]);
    if (rows[0]) {
      protectApproved(run.ctx, rows[0].status, `This ${a.type}`);
      run.overlay.push(a.type === 'road' ? { kind: 'line', coordinates: rows[0].c, style: 'remove' } : { kind: 'point', coordinates: [rows[0].c], style: 'remove' });
    }
    const saved = await editorService.retire(a.type, a.id, { expectedRevision: a.expectedRevision, sessionId: run.ctx.sessionId, leaseToken: await lease(run, a.type, a.id), mutationId: randomUUID() }, run.ctx.identity, run.db);
    return { changeSetId: saved.changeSetId, retired: { type: a.type, id: a.id }, note: 'The row is kept with status RETIRED; revert_changeset restores it' };
  },

  async move_node(run, a) {
    const { rows } = await run.db.query<{ status: string }>(`SELECT status FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED') AND (from_node_id=$1 OR to_node_id=$1)`, [a.nodeId]);
    for (const r of rows) protectApproved(run.ctx, r.status, 'A road on this node');
    const saved = await editorOps.moveNode({ nodeId: a.nodeId, coordinate: await position(run, a.to), sessionId: run.ctx.sessionId, mutationId: randomUUID() }, run.ctx.identity, run.db);
    return { ...(await summarize(run, saved)), nodeId: saved.nodeId, at: roundXYZ(saved.coordinate), note: 'Crossings created by the move are not connected automatically: run validate_network' };
  },

  async merge_nodes(run, a) {
    const { rows } = await run.db.query<{ status: string }>(`SELECT status FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED') AND (from_node_id=$1 OR to_node_id=$1)`, [a.removeNodeId]);
    for (const r of rows) protectApproved(run.ctx, r.status, 'A road on the removed node');
    const saved = await editorOps.mergeNodes({ ...a, sessionId: run.ctx.sessionId, mutationId: randomUUID() }, run.ctx.identity, run.db);
    return { ...(await summarize(run, saved)), nodeId: saved.nodeId, removedNodeId: saved.removedNodeId, at: roundXYZ(saved.coordinate) };
  },

  async split_road(run, a) {
    if ((a.measureM === undefined) === (a.nearest === undefined)) throw AppError.badRequest('INVALID_SPLIT', 'Give exactly one of measureM or nearest');
    const current = await loadRoad(run.db, a.roadId);
    protectApproved(run.ctx, current.status, 'This road');
    const measureM = a.measureM ?? projectOnLine(current.coordinates, [a.nearest![0], a.nearest![1], 0])!.measure;
    const saved = await editorOps.splitRoad({ roadId: a.roadId, expectedRevision: a.expectedRevision, measureM, sessionId: run.ctx.sessionId, mutationId: randomUUID() }, run.ctx.identity, run.db);
    return { ...(await summarize(run, saved)), nodeId: saved.nodeId, at: roundXYZ(saved.coordinate) };
  },

  async merge_roads(run, a) {
    for (const r of a.roads) protectApproved(run.ctx, (await loadRoad(run.db, r.id)).status, `Road ${r.id}`);
    const saved = await editorOps.mergeRoads({ roads: a.roads, sessionId: run.ctx.sessionId, mutationId: randomUUID() }, run.ctx.identity, run.db);
    return { ...(await summarize(run, saved)), roadId: saved.roadId };
  },

  async revert_changeset(run, a) {
    const saved = await editorOps.revertChangeSet({ changeSetId: a.changeSetId, sessionId: run.ctx.sessionId, mutationId: randomUUID() }, run.ctx.identity, run.db);
    return { changeSetId: saved.changeSetId, revertedChangeSetId: a.changeSetId, restoredObjects: saved.restored,
      changes: (saved.events as any[]).map((e) => ({ type: e.objectType, id: e.objectId, operation: e.operation })) };
  },
};

/**
 * Runs the operations in order inside one transaction. dryRun executes them for real and rolls back, so the returned
 * plan is exactly what a commit would do. Either way the result is shown to people in the editor: a proposal overlay
 * for a dry run, the agent's cursor at the change for a commit.
 */
export async function execute(ctx: AgentContext, ops: Op[], dryRun: boolean) {
  if (!dryRun) rateLimit(ctx, ops.length);
  const terrainCtx = await terrainContext();
  if (!terrainCtx) throw AppError.notFound('TERRAIN_UNAVAILABLE', 'No active terrain version');
  const run: Run = { db: undefined as unknown as PoolClient, ctx, terrain: terrainCtx, overlay: [] };
  const batchId = ops.length > 1 ? randomUUID() : undefined;
  const work = async (db: PoolClient) => {
    run.db = db;
    const results: unknown[] = [];
    for (const [i, op] of ops.entries()) {
      try { results.push({ op: op.op, ...(await (OPS[op.op] as (r: Run, a: unknown) => Promise<Record<string, unknown>>)(run, op.args)) }); }
      catch (err) {
        if (ops.length > 1 && err instanceof AppError) throw new AppError(err.status, err.code, `ops[${i}] (${op.op}): ${err.message}`, err.details);
        throw err;
      }
    }
    if (dryRun) throw new Rollback(results);
    return results;
  };
  let results: unknown[];
  try {
    results = await withEditorActor({ via: 'mcp', agent: ctx.agent, ...(batchId ? { batchId } : {}) }, () => withTransaction(work));
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
    results = err.results;
  }
  const ref = { collectorId: ctx.identity.collectorId, sessionId: ctx.sessionId, agent: ctx.agent };
  editorAgents.touch(ref, run.focus);
  if (dryRun && run.overlay.length) editorAgents.overlay(ref, run.overlay.slice(0, 50), 300);
  if (!dryRun) editorAgents.clearOverlay(ref);
  return { dryRun, ...(dryRun ? { note: 'Nothing was saved. Call again with dryRun=false to apply.' } : {}), ...(batchId && !dryRun ? { batchId } : {}), results };
}
