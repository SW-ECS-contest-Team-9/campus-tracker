/** List terrain versions, switch the active one (one transaction), or move draped road heights from one version to another.
 * Usage: npx tsx scripts/terrain-versions.ts list
 *        npx tsx scripts/terrain-versions.ts activate VERSION_ID
 *        npx tsx scripts/terrain-versions.ts relevel-roads FROM_VERSION TO_VERSION [--save --as=COLLECTOR_CODE]
 * activate refuses an unknown id and a version whose grid, datum or geoid differs from the active one. It never changes
 * heights, buildings or roads; it prints relevel-roads as a follow-up when draped roads lie on changed terrain.
 * relevel-roads previews by default. --save needs TO_VERSION to be active and writes one editor change set (same statements
 * as the editor's move_node), so it shows in the editor history and can be reverted there. Swap the versions to undo.
 * Besides draped roads it moves heights copied from the sports-field reference sample (RELEVEL_FIELD) by the change at that sample.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../src/config/database.js';
import { planRelevel, RELEVEL_FIELD } from '../src/geo/terrain-relevel.js';
import { gridDifferences, type TerrainVersionGrid } from '../src/geo/terrain-versions.js';
import { assertNotLockedByOthers } from '../src/modules/editor/editor.ops.js';
import { addChange, geoJSONLine, roadBefore, roadSelect, withEditorActor, type RoadRow } from '../src/modules/editor/editor.service.js';

const GRID = `srid, vertical_datum "verticalDatum", geoid_separation_m::float8 "geoidSeparationM", origin_x "originX", origin_y "originY",
  resolution_m::float8 "resolutionM", width, height`;

async function list() {
  const { rows } = await pool.query(
    `SELECT id, active, imported_at "importedAt", metadata->>'baseVersion' "baseVersion", metadata->>'algorithm' algorithm,
            COALESCE(metadata->'correction'->>'reason', metadata->'correction'->'properties'->>'reason') reason,
            left(source_sha256, 12) "sourceSha", width || 'x' || height || ' @' || resolution_m || 'm' grid
       FROM terrain_versions ORDER BY imported_at`);
  console.table(rows);
}

type XYZ = [number, number, number];
const range = (v: number[]) => [Math.min(...v), Math.max(...v)].map((x) => Math.round(x * 100) / 100);

/** Reads both grids and the active network, and plans the height changes. lock = take the editor topology lock and row locks (for --save). */
async function relevelPlan(db: PoolClient, fromId: string, toId: string, lock = false) {
  const { rows: versions } = await db.query<TerrainVersionGrid & { id: string; active: boolean; heights: Buffer }>(
    `SELECT id, active, ${GRID}, heights FROM terrain_versions WHERE id = ANY($1::text[])`, [[fromId, toId]]);
  const from = versions.find((v) => v.id === fromId), to = versions.find((v) => v.id === toId);
  if (!from || !to || fromId === toId) throw new Error(`Give two different existing terrain versions (got ${fromId}, ${toId})`);
  const diff = gridDifferences(from, to);
  if (diff.length) throw new Error(`Refused: ${fromId} and ${toId} differ in ${diff.join(', ')}`);
  if (lock) await db.query('SELECT pg_advisory_xact_lock(5186001)'); // same lock as the editor: one topology edit at a time
  const { rows: roads } = await db.query<RoadRow>(`${roadSelect} WHERE status IN ('DRAFT','APPROVED') ORDER BY id${lock ? ' FOR UPDATE' : ''}`);
  const { rows: nodes } = await db.query<{ id: string; coordinate: XYZ }>(
    `SELECT id, (ST_AsGeoJSON(geom)::json->'coordinates') coordinate FROM mobility.network_nodes WHERE id = ANY($1::uuid[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [[...new Set(roads.flatMap((r) => [r.from_node_id, r.to_node_id]))]]);
  const floats = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const plan = planRelevel({ originX: from.originX, originY: from.originY, resolution: from.resolutionM, width: from.width, height: from.height },
    floats(from.heights), floats(to.heights),
    roads.map((r) => ({ id: r.id, structure: r.structure, buildingId: r.building_id, levelId: r.level_id, fromNodeId: r.from_node_id, toNodeId: r.to_node_id, coordinates: r.coordinates })), nodes, RELEVEL_FIELD);
  return { plan, roads: new Map(roads.map((r) => [r.id, r])), toActive: to.active };
}

async function relevelRoads(fromId: string, toId: string, owner: string | null) {
  const changeSetId = randomUUID();
  const { plan, roads } = await withTransaction(async (db) => {
    const result = await relevelPlan(db, fromId, toId, owner !== null);
    if (owner === null || (!result.plan.roads.length && !result.plan.nodes.length)) return result;
    if (!result.toActive) throw new Error(`Refused: ${toId} is not the active terrain version; activate it first`);
    const { rows: known } = await db.query('SELECT 1 FROM collectors WHERE collector_code = $1', [owner]);
    if (!known.length) throw new Error(`Unknown collector code: ${owner}`);
    await assertNotLockedByOthers(db, result.plan.roads.map((r) => r.id), owner, changeSetId);
    const relevel = { from: fromId, to: toId };
    // same statements as editorOps.moveNode; the before-images let the editor's revert restore every height
    for (const n of result.plan.nodes) {
      const { rows } = await db.query<{ revision: number }>(
        `UPDATE mobility.network_nodes SET geom=ST_SetSRID(ST_MakePoint($2,$3,$4),5186),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision`, [n.id, ...n.coordinate]);
      await addChange(db, changeSetId, 'node', n.id, 'updated', rows[0].revision, owner, { moved: true, relevel, before: { coordinate: [n.coordinate[0], n.coordinate[1], n.fromZ] } });
    }
    for (const r of result.plan.roads) {
      const road = result.roads.get(r.id)!;
      await db.query(`UPDATE mobility.road_segments SET geom=${geoJSONLine(2)},revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1`,
        [r.id, JSON.stringify(r.coordinates), owner]);
      await addChange(db, changeSetId, 'road', r.id, 'updated', road.revision + 1, owner, { relevel, before: roadBefore(road) });
    }
    return result;
  });
  const saved = owner !== null && (plan.roads.length > 0 || plan.nodes.length > 0);
  const label = (id: string) => `${id.slice(0, 8)} ${roads.get(id)!.name ?? roads.get(id)!.structure}`;
  console.log(JSON.stringify({
    from: fromId, to: toId, saved, changeSetId: saved ? changeSetId : null,
    roads: plan.roads.map((r) => ({ road: label(r.id), vertices: r.vertices.length, shiftM: range(r.vertices.map((v) => v.toZ - v.fromZ)) })),
    nodes: plan.nodes.map((n) => ({ id: n.id, rule: n.rule, shiftM: range([n.coordinate[2] - n.fromZ])[0], roads: n.roadIds.map(label) })),
    keptNodes: plan.refusedNodes.map((n) => ({ id: n.id, reason: n.reason, terrainShiftM: range([n.deltaM])[0], aboveTerrainAfterM: range([n.aboveAfterM])[0],
      drapedRoads: n.drapedRoadIds.map(label), otherRoads: n.otherRoadIds.map(label) })),
    notMovedOwnHeights: plan.refusedRoads.filter((r) => r.reason === 'own-heights').map((r) => ({ road: label(r.id), vertices: r.vertices, copiedReferenceKept: r.referenceCopies, terrainShiftM: range(r.deltaM), aboveTerrainAfterM: range(r.aboveAfterM) })),
    notMovedIndoorRoads: plan.refusedRoads.filter((r) => r.reason === 'indoor').length,
  }, null, 2));
  if (saved) console.log(`Undo: revert change set ${changeSetId} in the editor history, or activate ${fromId} and run relevel-roads ${toId} ${fromId} --save --as=${owner}`);
}

async function activate(id: string) {
  const result = await withTransaction(async (db) => {
    const { rows } = await db.query<TerrainVersionGrid & { id: string; active: boolean }>(
      `SELECT id, active, ${GRID} FROM terrain_versions WHERE id = $1 OR active FOR UPDATE`, [id]);
    const target = rows.find((r) => r.id === id);
    const previous = rows.find((r) => r.active);
    if (!target) throw new Error(`Unknown terrain version: ${id}`);
    if (target.active) return { previous: id, scene: null, unchanged: true, roads: null };
    const diff = previous ? gridDifferences(previous, target) : [];
    if (diff.length) throw new Error(`Refused: ${id} differs from the active version ${previous!.id} in ${diff.join(', ')}`);
    // same order as terrain-import.ts: clear the flag first (unique partial index terrain_one_active_idx)
    await db.query('UPDATE terrain_versions SET active = false WHERE active');
    await db.query('UPDATE terrain_versions SET active = true WHERE id = $1', [id]);
    const { rows: scene } = await db.query<{ id: string; terrainVersionId: string }>(
      'SELECT id, terrain_version_id "terrainVersionId" FROM scene_versions WHERE active');
    const roads = previous ? (await relevelPlan(db, previous.id, id)).plan : null;
    return { previous: previous?.id ?? null, scene: scene[0] ?? null, unchanged: false, roads };
  });
  if (result.unchanged) { console.log(`${id} is already active; nothing changed`); return; }
  console.log(`activated terrain version ${id} (was ${result.previous ?? 'none'})`);
  const ownHeights = result.roads?.refusedRoads.filter((r) => r.reason === 'own-heights') ?? [];
  console.log([
    'Follow-up:',
    '- No server restart: the active id is read from the database per request and grids are cached by version id.',
    '- Preview/editor ground: reload the page (GET /terrain/grid now serves this version).',
    result.scene && result.scene.terrainVersionId !== id
      ? `- Buildings: active scene ${result.scene.id} still has base/roof computed on ${result.scene.terrainVersionId}. Recompute with: npm run scene:import -- --dir=<folder with campus.gpkg>`
      : '- Buildings: the active scene already uses this terrain version.',
    result.roads?.roads.length || result.roads?.nodes.length
      ? `- Roads, REQUIRED: ${result.roads.roads.length} road(s) and ${result.roads.nodes.length} node(s) (draped on the old terrain or copied from the field reference) still have the old heights. Preview: npm run terrain:relevel-roads -- ${result.previous} ${id}   then add --save --as=<collector code>`
      : '- Roads: no draped road or field-reference copy lies on changed terrain.',
    ...(ownHeights.length ? [`- Roads with their own heights on changed terrain: ${ownHeights.length}, lowest ${range(ownHeights.map((r) => r.aboveAfterM[0]))[0]} m relative to the new surface. relevel-roads lists them and does not move them.`] : []),
    '- Sessions already pinned to a terrain version keep it; new sessions use this one.',
    result.previous ? `Rollback: npm run terrain:activate -- ${result.previous}   (then relevel-roads ${id} ${result.previous} --save if you saved it, and scene:import again if you ran it)` : 'Rollback: none (no version was active before)',
  ].join('\n'));
}

async function main() {
  const [command, id, extra, ...flags] = process.argv.slice(2);
  if (command === 'list' && !id) return list();
  if (command === 'activate' && id && !extra) return activate(id);
  const as = flags.find((f) => f.startsWith('--as='))?.slice(5);
  const save = flags.includes('--save');
  if (command === 'relevel-roads' && id && extra && flags.length === (save ? 2 : 0) && save === !!as) {
    // recorded as an automated change (the history panel has no separate kind for scripts)
    return withEditorActor({ via: 'mcp', agent: 'terrain-relevel' }, () => relevelRoads(id, extra, as ?? null));
  }
  throw new Error('Usage: terrain-versions.ts list | activate VERSION_ID | relevel-roads FROM_VERSION TO_VERSION [--save --as=COLLECTOR_CODE]');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
