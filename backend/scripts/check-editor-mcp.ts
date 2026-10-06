/**
 * End-to-end check of the editor MCP endpoint (POST /mcp) against a running backend, the way an MCP client uses it:
 * plain JSON-RPC over HTTP with temporary agent tokens that are revoked at the end.
 *
 * The write checks draw on a private level id in an empty corner of the terrain, so they can never connect to real
 * roads (roads only connect within one level), and every row they create is deleted afterwards.
 *
 *   npm run check:editor-mcp -- --server http://127.0.0.1:3000 --collector SIM
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/database.js';
import { signAgentToken } from '../src/common/auth/jwt.js';
import { collectorRepository } from '../src/modules/collectors/collector.repository.js';
import { SCOPE_READ, SCOPE_WRITE } from '../src/modules/editor-mcp/mcp.context.js';

const { values: args } = parseArgs({
  options: {
    server: { type: 'string', default: `http://127.0.0.1:${env.PORT}` },
    collector: { type: 'string', default: 'SIM' },
  },
});
const LEVEL = '__mcp_check__';

let failures = 0;
function check(name: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 300)}`);
}

let nextId = 1;
async function rpc(token: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${args.server}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await res.text();
  const json = text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) : text;
  return { status: res.status, body: json ? JSON.parse(json) : null };
}

/** fetch() cannot send a forged Host header, so the DNS-rebinding guard is checked with a raw request. */
function statusWithHost(token: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${args.server}/mcp`);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { host, 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end('{}');
  });
}

/** Calls a tool and returns its parsed JSON payload ({ error } for tool-level errors) plus the raw content blocks. */
async function call(token: string, name: string, input: unknown = {}) {
  const { body } = await rpc(token, 'tools/call', { name, arguments: input });
  const content: any[] = body?.result?.content ?? [];
  const text = content.find((c) => c.type === 'text')?.text;
  let data: any = body;
  try { if (text) data = JSON.parse(text); } catch { data = { text }; } // SDK input-validation errors are plain text
  return { isError: !!body?.result?.isError, data, content };
}

async function agent(collector: { id: string; collector_code: string }, name: string, scopes: string[]) {
  const clientDeviceId = `mcp:${name}`;
  const deviceDatabaseId = await collectorRepository.upsertDevice(collector.id, clientDeviceId, { platform: 'mcp', deviceModel: name });
  const identity = { collectorId: collector.collector_code, collectorDatabaseId: collector.id, deviceDatabaseId, clientDeviceId };
  return { deviceDatabaseId, token: signAgentToken(identity, { agent: name, scopes }, '10m') };
}

async function cleanup() {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM mobility.road_segments WHERE level_id=$1 UNION ALL SELECT id FROM mobility.places WHERE level_id=$1 UNION ALL SELECT id FROM mobility.network_nodes WHERE level_id=$1`, [LEVEL]);
  const ids = rows.map((r) => r.id);
  await pool.query(`DELETE FROM mobility.editor_leases WHERE object_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM mobility.editor_changes WHERE object_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM mobility.road_segments WHERE level_id=$1`, [LEVEL]);
  await pool.query(`DELETE FROM mobility.places WHERE level_id=$1`, [LEVEL]);
  await pool.query(`DELETE FROM mobility.network_nodes WHERE level_id=$1`, [LEVEL]);
  return ids.length;
}

async function readChecks(token: string) {
  check('no token -> 401', (await rpc(null, 'tools/list')).status === 401);
  check('foreign Host header -> 403', (await statusWithHost(token, 'evil.example')) === 403);
  check('browser Origin -> 403', (await rpc(token, 'tools/list', undefined, { origin: 'https://evil.example' })).status === 403);

  const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } });
  check('initialize', init.body?.result?.serverInfo?.name === 'campus-editor', init.body?.result?.serverInfo ?? init.body);
  const list = await rpc(token, 'tools/list');
  const toolList: any[] = list.body?.result?.tools ?? [];
  const names = toolList.map((t) => t.name);
  const read = ['get_editor_context', 'list_features', 'get_feature', 'find_nearby', 'get_collaborators', 'get_changes', 'validate_network',
    'sample_terrain', 'list_fusion_runs', 'get_run_track', 'list_routes', 'get_canonical_path', 'list_buildings', 'convert_coordinates', 'check_reachability', 'render_map'];
  const write = ['create_road', 'update_road', 'connect_roads', 'create_place', 'update_place', 'retire_feature', 'move_node', 'split_road', 'merge_roads', 'revert_changeset', 'apply_changes'];
  check('tools/list has every tool', [...read, ...write, 'show_overlay', 'clear_overlay', 'focus_view'].every((n) => names.includes(n)), { count: names.length });
  check('read tools are annotated read-only, write tools are not',
    toolList.filter((t) => read.includes(t.name)).every((t) => t.annotations?.readOnlyHint === true) && toolList.filter((t) => write.includes(t.name)).every((t) => t.annotations?.readOnlyHint === false));

  const context = (await call(token, 'get_editor_context')).data;
  check('get_editor_context', context.coordinates?.crs === 'EPSG:5186' && !!context.terrain && context.you?.canWrite === false, context.you);
  const t = context.terrain;
  const center: [number, number] = [(t.minX + t.maxX) / 2, (t.minY + t.maxY) / 2];

  const roads = (await call(token, 'list_features', { type: 'road', geometry: 'endpoints' })).data;
  check('list_features roads', Array.isArray(roads.items) && roads.items.every((r: any) => r.id && r.revision >= 1 && r.lengthM > 0 && r.start && !r.coordinates), { total: roads.total });
  check('list_features nodes', Array.isArray((await call(token, 'list_features', { type: 'node' })).data.items));
  check('list_features rejects bad input', (await call(token, 'list_features', { type: 'lane' })).isError);
  if (roads.items.length) {
    const road = roads.items[0];
    const detail = (await call(token, 'get_feature', { type: 'road', id: road.id })).data;
    check('get_feature road', detail.vertices?.length === detail.vertexCount && detail.ends?.length === 2 && detail.revision === road.revision, { vertices: detail.vertexCount });
    const [, x, y, z] = detail.vertices[Math.floor(detail.vertices.length / 2)];
    const near = (await call(token, 'find_nearby', { point: [x, y, z], radiusM: 5 })).data;
    check('find_nearby finds the road at its own vertex', near.roads?.some((r: any) => r.roadId === road.id && r.distanceM < 0.05), near.roads?.[0]);
    check('find_nearby reports the ground', typeof near.ground?.z === 'number', near.ground);
  }
  const missing = await call(token, 'get_feature', { type: 'road', id: '00000000-0000-4000-8000-000000000000' });
  check('get_feature unknown id -> ROAD_NOT_FOUND', missing.isError && missing.data.error?.code === 'ROAD_NOT_FOUND', missing.data);
  check('get_collaborators', Array.isArray((await call(token, 'get_collaborators')).data.participants));
  check('get_changes', Array.isArray((await call(token, 'get_changes', { limit: 5 })).data.changeSets));
  const qa = (await call(token, 'validate_network')).data;
  check('validate_network', typeof qa.total === 'number' && qa.roadsChecked === roads.total, { total: qa.total, byCode: qa.byCode });

  const ground = (await call(token, 'sample_terrain', { points: [center, [t.minX - 100, t.minY - 100]] })).data;
  check('sample_terrain inside / outside', typeof ground.samples?.[0]?.z === 'number' && ground.samples?.[1]?.z === null, ground.samples);
  const profile = (await call(token, 'sample_terrain', { line: [center, [center[0] + 20, center[1]]], spacingM: 5 })).data;
  check('sample_terrain profile', profile.samples?.length === 5 && profile.samples[4].measureM === 20);
  const runs = (await call(token, 'list_fusion_runs', { includeSynthetic: true })).data;
  const traceable = runs.sessions?.filter((s: any) => s.traceable) ?? [];
  check('list_fusion_runs', runs.sessions?.length > 0, { sessions: runs.sessions?.length, traceable: traceable.length });
  if (traceable.length) {
    const track = (await call(token, 'get_run_track', { runId: traceable[0].runs[0].runId })).data;
    check('get_run_track capped, in EPSG:5186', track.points?.length > 0 && track.points.length <= 400 && track.points.every((p: any[]) => Math.abs(p[1] - center[0]) < 3000), { points: track.points?.length, of: track.totalPoints });
  }
  const routes = (await call(token, 'list_routes')).data;
  check('list_routes', Array.isArray(routes.routes), { routes: routes.routes?.length });
  const withPath = routes.routes?.find((r: any) => r.canonicalPathId);
  if (withPath) {
    const path = (await call(token, 'get_canonical_path', { pathId: withPath.canonicalPathId, toIdx: 9 })).data;
    check('get_canonical_path', path.points?.length === 10 && path.points[0].length === 5, { total: path.totalPoints });
  }
  check('list_buildings', (await call(token, 'list_buildings')).data.buildings?.length > 0);
  const wgs = (await call(token, 'convert_coordinates', { points: [center], from: 'epsg5186', to: 'wgs84' })).data;
  const back = (await call(token, 'convert_coordinates', { points: wgs.points, from: 'wgs84', to: 'epsg5186' })).data;
  check('convert_coordinates round trip', Math.hypot(back.points[0][0] - center[0], back.points[0][1] - center[1]) < 0.02);

  const denied = await call(token, 'create_road', { roadClass: 'pedestrian', levelId: LEVEL, path: [{ xy: center }, { xy: [center[0] + 5, center[1]] }] });
  check('read-only token cannot write -> SCOPE_REQUIRED', denied.isError && denied.data.error?.code === 'SCOPE_REQUIRED', denied.data.error?.code);
  return t as { minX: number; minY: number; maxX: number; maxY: number };
}

async function writeChecks(token: string, t: { minX: number; minY: number }, other: { collector_code: string }) {
  const o: [number, number] = [t.minX + 60, t.minY + 60]; // an empty corner of the terrain
  const at = (dx: number, dy: number): [number, number] => [o[0] + dx, o[1] + dy];
  const base = { roadClass: 'pedestrian', levelId: LEVEL, densify: false }; // fixed vertex counts; densify has its own check
  const active = async () => (await call(token, 'list_features', { levelId: LEVEL, geometry: 'endpoints', limit: 200 })).data;
  const ok = async (label: string, name: string, input: unknown) => {
    const r = await call(token, name, input);
    if (r.isError) check(label, false, r.data);
    return r.data;
  };

  // ---- dry run saves nothing ----
  const plan = await ok('create_road dryRun', 'create_road', { ...base, path: [{ xy: at(0, 0) }, { xy: at(30, 0) }], dryRun: true });
  check('dry run returns the plan and saves nothing', plan.dryRun === true && plan.roads?.length === 1 && (await active()).total === 0, { roads: plan.roads?.length });

  // ---- create, connect by reference, cross ----
  const a = await ok('create_road A', 'create_road', { ...base, name: 'check A', path: [{ xy: at(0, 0) }, { xy: at(30, 0) }] });
  const roadA = a.roads?.[0];
  check('create_road saves a DRAFT road on the terrain', roadA?.status === 'DRAFT' && Math.abs(roadA.lengthM - 30) < 0.05 && roadA.start.roadsAtNode === 1, roadA);
  const b = await ok('create_road B', 'create_road', { ...base, name: 'check B', path: [{ at: { roadId: roadA.id, measureM: 15 } }, { xy: at(15, 20) }] });
  check('a road referenced mid-way is split and connected (T junction)', b.connections?.[0]?.connected === true && b.replacedRoads?.[0]?.id === roadA.id && b.replacedRoads[0].replacedBy.length === 2
    && b.roads?.find((r: any) => r.name === 'check B')?.start.roadsAtNode === 3, { connections: b.connections, replaced: b.replacedRoads });
  const junctionNode = b.connections[0].nodeId;
  const c = await ok('create_road C', 'create_road', { ...base, name: 'check C', path: [{ xy: at(5, -10) }, { xy: at(5, 10) }] });
  check('crossing an existing road splits both', c.crossings?.length === 1 && c.crossings[0].splitsThatRoad && c.roads?.filter((r: any) => r.name === 'check C').length === 2, { crossings: c.crossings?.length, roads: c.roads?.length });

  const d = await ok('create_road D', 'create_road', { ...base, name: 'check D', pedestrianDirection: 'forward', path: [{ xy: at(0, 40) }, { xy: at(30, 40) }] });
  const roadD = d.roads[0];
  const twin = await call(token, 'create_road', { ...base, path: [{ xy: at(0, 40) }, { xy: at(30, 40) }] });
  check('same geometry again -> DUPLICATE_GEOMETRY', twin.isError && twin.data.error?.code === 'DUPLICATE_GEOMETRY' && twin.data.error.details?.roadId === roadD.id, twin.data.error);
  const levelClash = await call(token, 'create_road', { roadClass: 'pedestrian', levelId: `${LEVEL}2`, path: [{ at: { roadId: roadD.id, vertexIndex: 0 } }, { xy: at(0, 50) }] });
  check('reference on another level -> LEVEL_MISMATCH', levelClash.isError && levelClash.data.error?.code === 'LEVEL_MISMATCH', levelClash.data.error?.code);

  // ---- update: revision, lock, attributes, vertices ----
  const stale = await call(token, 'update_road', { id: roadD.id, expectedRevision: 99, attrs: { name: 'x' } });
  check('wrong revision -> REVISION_CONFLICT with the current revision', stale.isError && stale.data.error?.code === 'REVISION_CONFLICT' && stale.data.error.details?.currentRevision === 1, stale.data.error);
  await pool.query(`INSERT INTO mobility.editor_leases(object_type,object_id,owner_code,session_id,lease_token,expires_at) VALUES('road',$1,$2,gen_random_uuid(),gen_random_uuid(),now()+interval '30 seconds')`, [roadD.id, other.collector_code]);
  const locked = await call(token, 'update_road', { id: roadD.id, expectedRevision: 1, attrs: { name: 'x' } });
  check('object edited by someone else -> EDITOR_OBJECT_LOCKED', locked.isError && locked.data.error?.code === 'EDITOR_OBJECT_LOCKED' && locked.data.error.details?.ownerCode === other.collector_code, locked.data.error);
  await pool.query(`DELETE FROM mobility.editor_leases WHERE object_id=$1`, [roadD.id]);
  const u = await ok('update_road attrs+reverse', 'update_road', { id: roadD.id, expectedRevision: 1, attrs: { name: 'check D2', widthM: 2.5 }, reverse: true });
  const d2 = (await call(token, 'get_feature', { type: 'road', id: roadD.id })).data;
  check('update_road edits in place; reverse flips geometry and direction', u.roads?.[0]?.revision === 2 && d2.name === 'check D2' && d2.widthM === 2.5 && d2.pedestrianDirection === 'backward'
    && Math.abs(d2.vertices[0][1] - at(30, 40)[0]) < 0.01, { rev: d2.revision, dir: d2.pedestrianDirection });
  const v = await ok('update_road vertexOps', 'update_road', { id: roadD.id, expectedRevision: 2, vertexOps: [{ op: 'insert', index: 0, point: { xy: at(15, 41) } }] });
  check('vertexOps insert', v.roads?.[0]?.vertexCount === 3 && v.roads[0].revision === 3, v.roads?.[0]);
  const dense = await ok('update_road drape', 'update_road', { id: roadD.id, expectedRevision: 3, path: [{ xy: at(30, 40) }, { xy: at(15, 41) }, { xy: at(0, 40) }], densify: true, dryRun: true });
  check('densify follows the terrain between vertices (dry run)', dense.dryRun === true && dense.roads?.[0]?.vertexCount >= 3, { vertices: dense.roads?.[0]?.vertexCount });

  // ---- structure: split, merge, move node ----
  const s = await ok('split_road', 'split_road', { roadId: roadD.id, expectedRevision: 3, measureM: 10 });
  check('split_road gives two pieces sharing a node', s.roads?.length === 2 && s.roads.every((r: any) => r.name === 'check D2') && s.replacedRoads?.[0]?.id === roadD.id, { roads: s.roads?.length });
  const m = await ok('merge_roads', 'merge_roads', { roads: s.roads.map((r: any) => ({ id: r.id, expectedRevision: r.revision })) });
  check('merge_roads joins them again', m.roads?.length === 1 && m.roads[0].vertexCount === s.roads[0].vertexCount + s.roads[1].vertexCount - 1 && Math.abs(m.roads[0].lengthM - s.roads[0].lengthM - s.roads[1].lengthM) < 0.02, m.roads?.[0]);
  const roadD3 = m.roads[0];
  const mv = await ok('move_node', 'move_node', { nodeId: junctionNode, to: { xy: at(15, 1) } });
  const nodeAfter = (await call(token, 'get_feature', { type: 'node', id: junctionNode })).data;
  check('move_node keeps every road attached', mv.roads?.length === 3 && nodeAfter.roads?.length === 3 && Math.abs(nodeAfter.coordinate[1] - at(15, 1)[1]) < 0.01, { roads: nodeAfter.roads?.length });

  // ---- connect_roads on a near miss, then QA and reachability ----
  await ok('create_road G', 'create_road', { ...base, name: 'check G', path: [{ xy: at(0, 90) }, { xy: at(30, 90) }] });
  const e = await ok('create_road E', 'create_road', { ...base, name: 'check E', path: [{ xy: at(20, 90.4) }, { xy: at(20, 100) }] });
  const before = (await call(token, 'validate_network', { bbox: [o[0] - 20, o[1] - 20, o[0] + 60, o[1] + 120], checks: ['DANGLING_END_NEAR_ROAD'] })).data;
  check('a hand-typed near miss is not connected, and validate_network reports it', e.roads?.[0]?.start.roadsAtNode === 1 && before.findings?.some((f: any) => f.roadIds.includes(e.roads[0].id)), { findings: before.total });
  const j = await ok('connect_roads', 'connect_roads', { at: { xy: at(20, 90.2) } });
  check('connect_roads joins them in one node', j.roadsConnected === 2 && j.roads?.length === 3, { roads: j.roads?.length, node: j.nodeId });
  const reachVehicle = (await call(token, 'check_reachability', { from: { point: at(0, 0) }, to: { point: at(15, 20) }, mode: 'vehicle' })).data;
  check('check_reachability: pedestrian roads block vehicles, with reasons', reachVehicle.reachable === false && reachVehicle.blockedRoadsAtFrontier?.[0]?.reason?.includes('vehicleAccess'), reachVehicle.blockedRoadsAtFrontier?.[0]);
  const reachWalk = (await call(token, 'check_reachability', { from: { point: at(0, 0) }, to: { point: at(15, 20) }, mode: 'pedestrian' })).data;
  check('check_reachability: A to B on foot', reachWalk.reachable === true && reachWalk.roads?.length >= 2, { lengthM: reachWalk.lengthM, roads: reachWalk.roads?.length });

  // ---- places ----
  const p = await ok('create_place', 'create_place', { name: 'check gate', category: 'building_entrance', levelId: LEVEL, position: { xy: at(15, 22) } });
  const p2 = await ok('update_place', 'update_place', { id: p.placeId, expectedRevision: 1, name: 'check gate 2', position: { at: { roadId: roadD3.id, vertexIndex: 0 } } });
  const placeNow = (await call(token, 'get_feature', { type: 'place', id: p.placeId })).data;
  check('create_place / update_place', placeNow.name === 'check gate 2' && placeNow.revision === 2 && p2.revision === 2 && placeNow.category === 'building_entrance', { name: placeNow.name });

  // ---- atomic batch ----
  const countBefore = (await active()).total;
  const batch = await call(token, 'apply_changes', { ops: [
    { op: 'create_road', args: { ...base, path: [{ xy: at(0, 70) }, { xy: at(10, 70) }] } },
    { op: 'retire_feature', args: { type: 'road', id: randomUUID(), expectedRevision: 1 } },
  ] });
  check('apply_changes rolls everything back when one step fails', batch.isError && /ops\[1\]/.test(batch.data.error?.message ?? '') && (await active()).total === countBefore, batch.data.error?.message);
  const good = await ok('apply_changes', 'apply_changes', { ops: [
    { op: 'create_road', args: { ...base, name: 'check F', path: [{ xy: at(0, 70) }, { xy: at(10, 70) }] } },
    { op: 'create_place', args: { name: 'check F place', category: 'other', levelId: LEVEL, position: { xy: at(5, 72) } } },
  ] });
  check('apply_changes commits all steps', good.results?.length === 2 && (await active()).total === countBefore + 1 && !!good.batchId, { results: good.results?.length });

  // ---- revert ----
  const roadF = good.results[0].roads[0];
  const edit = await ok('update_road F', 'update_road', { id: roadF.id, expectedRevision: 1, attrs: { name: 'check F renamed' }, vertexOps: [{ op: 'move', index: 1, point: { xy: at(12, 71) } }] });
  const blocked = await call(token, 'revert_changeset', { changeSetId: good.results[0].changeSetId });
  check('revert of an older change set is refused while later changes exist -> REVERT_BLOCKED', blocked.isError && blocked.data.error?.code === 'REVERT_BLOCKED', blocked.data.error?.code);
  await ok('revert_changeset (edit)', 'revert_changeset', { changeSetId: edit.changeSetId });
  const restored = (await call(token, 'get_feature', { type: 'road', id: roadF.id })).data;
  check('revert restores the edited road exactly', restored.name === 'check F' && Math.abs(restored.vertices.at(-1)[1] - at(10, 70)[0]) < 0.01 && restored.revision === 3, { name: restored.name, rev: restored.revision });
  const retire = await ok('retire_feature', 'retire_feature', { type: 'place', id: p.placeId, expectedRevision: 2 });
  await ok('revert_changeset (retire)', 'revert_changeset', { changeSetId: retire.changeSetId });
  check('revert brings a retired place back', (await call(token, 'get_feature', { type: 'place', id: p.placeId })).data.status === 'DRAFT');

  // ---- audit, overlay, picture ----
  const log = (await call(token, 'get_changes', { via: 'mcp', limit: 100 })).data;
  check('changes are attributed to the agent', log.changeSets?.length > 5 && log.changeSets.every((s: any) => s.actor?.via === 'mcp' && s.actor.agent === 'mcp-check-w'), { sets: log.changeSets?.length });
  const overlay = (await call(token, 'show_overlay', { items: [{ roadId: roadF.id, label: 'check' }, { point: at(0, 0) }] })).data;
  check('show_overlay / clear_overlay / focus_view', overlay.shown === 2 && (await call(token, 'clear_overlay')).data.cleared === true
    && typeof (await call(token, 'focus_view', { target: { roadId: roadF.id } })).data.viewers === 'number');
  const presence = (await call(token, 'get_collaborators')).data;
  check('the agent appears as a participant', presence.participants?.some((x: any) => x.agent === 'mcp-check-w' && x.cursor), presence.participants?.map((x: any) => x.agent ?? x.collectorId));
  const picture = await call(token, 'render_map', { bbox: [o[0] - 10, o[1] - 20, o[0] + 40, o[1] + 110], widthPx: 400, highlightRoadIds: [roadF.id] });
  const image = picture.content.find((x) => x.type === 'image');
  check('render_map returns a PNG', image?.mimeType === 'image/png' && Buffer.from(image.data, 'base64').subarray(1, 4).toString() === 'PNG' && picture.data.shown?.roads >= 5, picture.data.shown);

  const qa = (await call(token, 'validate_network', { bbox: [o[0] - 20, o[1] - 20, o[0] + 60, o[1] + 120], checks: ['DANGLING_END_NEAR_ROAD', 'UNCONNECTED_CROSSING', 'DUPLICATE_NODES'] })).data;
  check('the drawn test network has no connection errors', qa.total === 0, qa.findings?.map((f: any) => f.message));
}

async function main() {
  const collector = await collectorRepository.findByCode(args.collector!.toUpperCase());
  if (!collector) throw new Error(`Collector ${args.collector} is not registered`);
  const other = (await collectorRepository.listAll()).find((c) => c.id !== collector.id);
  await cleanup(); // leftovers of an interrupted run
  const reader = await agent(collector, 'mcp-check', [SCOPE_READ]);
  const writer = await agent(collector, 'mcp-check-w', [SCOPE_READ, SCOPE_WRITE]);
  try {
    const terrain = await readChecks(reader.token);
    if (other) await writeChecks(writer.token, terrain, other);
    else check('write checks need a second collector for the lock test', false);
  } finally {
    const removed = await cleanup();
    const { rows } = await pool.query(`SELECT count(*)::int n FROM mobility.editor_leases WHERE session_id = ANY($1::uuid[])`, [[reader.deviceDatabaseId, writer.deviceDatabaseId]]);
    check('no leases left behind, test rows removed', rows[0].n === 0, { removedRows: removed });
    await pool.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [[reader.deviceDatabaseId, writer.deviceDatabaseId]]);
  }
  check('revoked token -> rejected', (await rpc(reader.token, 'tools/list')).status === 404);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => pool.end());
