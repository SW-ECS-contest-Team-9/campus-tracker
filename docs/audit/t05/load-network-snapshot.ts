/** T05: loads the read-only operational road-network snapshot (editor MCP list_features output) into a LOCAL TEST database.
 * Usage (from backend/): npx tsx ../docs/audit/t05/load-network-snapshot.ts ROADS.json NODES.json [--reset]
 * Refuses any DATABASE_URL that is not the T05 test container (127.0.0.1/localhost:5544).
 * Loads roads and nodes only: ids, geometry with Z, class/structure/access/direction/width/building/level/name/colour, status, revision.
 * No sessions, samples or positions. Not in the snapshot, so filled in: created_by = updatedBy, node revision = 1, timestamps = now.
 * --reset empties the editor tables (roads, nodes, places, leases, changes, mutations) first.
 * After loading it reads everything back through the editor MCP queries and compares every field with the JSON.
 */
import fs from 'node:fs';
import { env } from '../../../backend/src/config/env.js';
import { pool, withTransaction } from '../../../backend/src/config/database.js';
import { editorQueries } from '../../../backend/src/modules/editor-mcp/editor.queries.js';

type XYZ = [number, number, number];
interface SnapRoad {
  id: string; name: string | null; roadClass: string; structure: string; pedestrianAccess: string; vehicleAccess: string;
  pedestrianDirection: string; vehicleDirection: string; widthM: number | null; wheelchairAccess: string; buildingId: string | null;
  levelId: string | null; status: string; revision: number; fromNodeId: string; toNodeId: string; updatedBy: string;
  displayColor: string | null; vertexCount: number; coordinates: XYZ[];
}
interface SnapNode { id: string; kind: string; levelId: string | null; coordinate: XYZ }

const ROAD_FIELDS = ['name', 'roadClass', 'structure', 'pedestrianAccess', 'vehicleAccess', 'pedestrianDirection', 'vehicleDirection', 'widthM',
  'wheelchairAccess', 'buildingId', 'levelId', 'status', 'revision', 'fromNodeId', 'toNodeId', 'updatedBy', 'displayColor'] as const;

async function main() {
  const [roadsFile, nodesFile, ...flags] = process.argv.slice(2);
  if (!roadsFile || !nodesFile || flags.some((f) => f !== '--reset')) throw new Error('Usage: load-network-snapshot.ts ROADS.json NODES.json [--reset]');
  const url = new URL(env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5544') {
    throw new Error(`Refused: DATABASE_URL points at ${url.hostname}:${url.port}, not the T05 test database (127.0.0.1:5544)`);
  }
  const roads: SnapRoad[] = JSON.parse(fs.readFileSync(roadsFile, 'utf8')).items;
  const nodes: SnapNode[] = JSON.parse(fs.readFileSync(nodesFile, 'utf8')).items;
  for (const r of roads) if (r.coordinates.length !== r.vertexCount) throw new Error(`road ${r.id}: snapshot geometry is simplified (${r.coordinates.length} of ${r.vertexCount} vertices)`);

  await withTransaction(async (db) => {
    if (flags.includes('--reset')) {
      await db.query('TRUNCATE mobility.editor_leases, mobility.editor_changes, mobility.editor_mutations, mobility.places, mobility.road_segments, mobility.network_nodes RESTART IDENTITY');
    }
    const { rows: [existing] } = await db.query<{ n: number }>('SELECT (SELECT count(*) FROM mobility.road_segments) + (SELECT count(*) FROM mobility.network_nodes) n');
    if (existing.n > 0) throw new Error('Refused: the editor tables are not empty (use --reset)');
    for (const n of nodes) {
      await db.query(`INSERT INTO mobility.network_nodes (id, kind, level_id, geom) VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5, $6), 5186))`,
        [n.id, n.kind, n.levelId, ...n.coordinate]);
    }
    for (const r of roads) {
      await db.query(
        `INSERT INTO mobility.road_segments (id, from_node_id, to_node_id, name, road_class, structure, pedestrian_access, vehicle_access,
           pedestrian_direction, vehicle_direction, width_m, wheelchair_access, building_id, level_id, status, revision, display_color, geom, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, ST_SetSRID(ST_GeomFromGeoJSON($18), 5186), $19, $19)`,
        [r.id, r.fromNodeId, r.toNodeId, r.name, r.roadClass, r.structure, r.pedestrianAccess, r.vehicleAccess, r.pedestrianDirection, r.vehicleDirection,
          r.widthM, r.wheelchairAccess, r.buildingId, r.levelId, r.status, r.revision, r.displayColor,
          JSON.stringify({ type: 'LineString', coordinates: r.coordinates }), r.updatedBy]);
    }
  });

  // read back through the same queries the editor MCP uses
  const [dbRoads, dbNodes] = [await editorQueries.roads(), await editorQueries.nodes()];
  const mismatches: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const r of roads) {
    const d = dbRoads.find((x) => x.id === r.id) as unknown as Record<string, unknown> | undefined;
    if (!d) { mismatches.push(`road ${r.id}: missing`); continue; }
    for (const f of ROAD_FIELDS) if (!same(d[f], r[f])) mismatches.push(`road ${r.id}: ${f} ${JSON.stringify(d[f])} != ${JSON.stringify(r[f])}`);
    if (!same(d.coordinates, r.coordinates)) mismatches.push(`road ${r.id}: coordinates differ`);
  }
  for (const n of nodes) {
    const d = dbNodes.find((x) => x.id === n.id);
    if (!d) { mismatches.push(`node ${n.id}: missing (or no active road uses it)`); continue; }
    if (d.kind !== n.kind || d.levelId !== n.levelId || !same(d.coordinate, n.coordinate)) mismatches.push(`node ${n.id}: differs`);
  }
  const count = (key: 'structure' | 'buildingId' | 'levelId') => Object.fromEntries([...new Set(dbRoads.map((r) => r[key] ?? 'null'))].sort().map((v) => [v, dbRoads.filter((r) => (r[key] ?? 'null') === v).length]));
  console.log(JSON.stringify({
    snapshot: { roads: roads.length, nodes: nodes.length, vertices: roads.reduce((s, r) => s + r.coordinates.length, 0) },
    database: { roads: dbRoads.length, nodes: dbNodes.length, vertices: dbRoads.reduce((s, r) => s + r.coordinates.length, 0) },
    byStructure: count('structure'), byBuilding: count('buildingId'), byLevel: count('levelId'),
    endMismatchWithNode: dbRoads.filter((r) => {
      const a = dbNodes.find((n) => n.id === r.fromNodeId)?.coordinate, b = dbNodes.find((n) => n.id === r.toNodeId)?.coordinate;
      return !same(a, r.coordinates[0]) || !same(b, r.coordinates.at(-1));
    }).length,
    mismatches,
  }, null, 2));
  if (mismatches.length) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
