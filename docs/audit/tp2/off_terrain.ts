// validate_network 의 OFF_TERRAIN 만, 지형 판(활성이 아니어도)마다 센다. 시험 DB 에서만, 읽기만.
// 시험 체크아웃 backend/scripts 에 복사해 돌린다: npx tsx scripts/off_terrain.ts <terrain id>... > 결과.json
import { pool } from '../src/config/database.js';
import { terrain } from '../src/geo/terrain.js';
import { editorQueries } from '../src/modules/editor-mcp/editor.queries.js';
import { validateNetwork } from '../src/modules/editor-mcp/network-validate.js';

const [roads, nodes] = await Promise.all([editorQueries.roads({}), editorQueries.nodes({})]);
const out: Record<string, unknown> = {};
for (const id of process.argv.slice(2)) {
  const ctx = await terrain.context(id);
  if (!ctx) throw new Error(`no terrain ${id}`);
  const f = validateNetwork(roads as any, nodes as any, ['OFF_TERRAIN'], { ground: (x, y) => terrain.sampleXY(ctx, x, y)?.height ?? null });
  out[id] = { roads: roads.length, offTerrain: f.length, findings: f.map((x) => ({ road: x.roadIds[0], at: x.location, msg: x.message })) };
  console.error(id, roads.length, f.length);
}
console.log(JSON.stringify(out, null, 1));
await pool.end();
