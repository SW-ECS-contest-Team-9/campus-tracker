/** T05: writes every active road's vertices and every node's coordinate (full stored precision) to a JSON file and prints a hash,
 * or compares the database with an earlier dump. Read-only.
 * Usage (from backend/): npx tsx ../docs/audit/t05/dump-network.ts write OUT.json
 *                        npx tsx ../docs/audit/t05/dump-network.ts compare EARLIER.json
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pool } from '../../../backend/src/config/database.js';

type XYZ = [number, number, number];
interface Dump { roads: Record<string, XYZ[]>; nodes: Record<string, XYZ> }

async function read(): Promise<Dump> {
  // ST_AsText with 15 digits: more than ST_AsGeoJSON's default 9 decimals, so a restore is checked at stored precision
  const { rows: roads } = await pool.query<{ id: string; c: XYZ[] }>(
    `SELECT id, (ST_AsGeoJSON(geom, 15)::json->'coordinates') c FROM mobility.road_segments WHERE status IN ('DRAFT','APPROVED') ORDER BY id`);
  const { rows: nodes } = await pool.query<{ id: string; c: XYZ }>(`SELECT id, (ST_AsGeoJSON(geom, 15)::json->'coordinates') c FROM mobility.network_nodes ORDER BY id`);
  return { roads: Object.fromEntries(roads.map((r) => [r.id, r.c])), nodes: Object.fromEntries(nodes.map((n) => [n.id, n.c])) };
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (!file || (command !== 'write' && command !== 'compare')) throw new Error('Usage: dump-network.ts write OUT.json | compare EARLIER.json');
  const now = await read();
  const sha = createHash('sha256').update(JSON.stringify(now)).digest('hex').slice(0, 16);
  if (command === 'write') {
    fs.writeFileSync(file, JSON.stringify(now));
    console.log(JSON.stringify({ wrote: file, roads: Object.keys(now.roads).length, nodes: Object.keys(now.nodes).length, sha }));
    return;
  }
  const then: Dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  let vertices = 0, changedVertices = 0, maxDz = 0, maxDxy = 0;
  const changedRoads: string[] = [], changedNodes: string[] = [], missing: string[] = [];
  for (const [id, before] of Object.entries(then.roads)) {
    const after = now.roads[id];
    if (!after || after.length !== before.length) { missing.push(`road ${id}`); continue; }
    let changed = false;
    before.forEach((p, i) => {
      vertices++;
      const dz = Math.abs(after[i][2] - p[2]), dxy = Math.hypot(after[i][0] - p[0], after[i][1] - p[1]);
      if (dz > 0 || dxy > 0) { changedVertices++; changed = true; }
      maxDz = Math.max(maxDz, dz); maxDxy = Math.max(maxDxy, dxy);
    });
    if (changed) changedRoads.push(id.slice(0, 8));
  }
  for (const [id, before] of Object.entries(then.nodes)) {
    const after = now.nodes[id];
    if (!after) { missing.push(`node ${id}`); continue; }
    const dz = Math.abs(after[2] - before[2]), dxy = Math.hypot(after[0] - before[0], after[1] - before[1]);
    if (dz > 0 || dxy > 0) changedNodes.push(`${id.slice(0, 8)} ${before[2]} -> ${after[2]}`);
    maxDz = Math.max(maxDz, dz); maxDxy = Math.max(maxDxy, dxy);
  }
  const added = [...Object.keys(now.roads).filter((id) => !then.roads[id]).map((id) => `road ${id}`), ...Object.keys(now.nodes).filter((id) => !then.nodes[id]).map((id) => `node ${id}`)];
  console.log(JSON.stringify({ comparedWith: file, sha, identical: !changedVertices && !changedNodes.length && !missing.length && !added.length,
    vertices, changedVertices, changedRoads, changedNodes, maxDzM: maxDz, maxDxyM: maxDxy, missing, added }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
