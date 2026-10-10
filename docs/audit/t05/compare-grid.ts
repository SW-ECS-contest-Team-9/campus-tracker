/** T05: compares a terrain version's stored heights with a Float32 grid file (operational snapshot). Read-only.
 * Usage (from backend/): npx tsx ../docs/audit/t05/compare-grid.ts VERSION_ID FILE.f32 */
import fs from 'node:fs';
import { pool } from '../../../backend/src/config/database.js';

async function main() {
const [id, file] = process.argv.slice(2);
const { rows } = await pool.query<{ heights: Buffer; width: number; height: number; originX: number; originY: number }>(
  'SELECT heights, width, height, origin_x "originX", origin_y "originY" FROM terrain_versions WHERE id = $1', [id]);
if (!rows.length) throw new Error(`no terrain version ${id}`);
const b = rows[0].heights, f = fs.readFileSync(file);
const a = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
const c = new Float32Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.length));
let differing = 0, max = 0;
for (let i = 0; i < Math.min(a.length, c.length); i++) { const d = Math.abs(a[i] - c[i]); if (d > 0) differing++; if (d > max) max = d; }
console.log(JSON.stringify({ id, grid: `${rows[0].width}x${rows[0].height}`, origin: [rows[0].originX, rows[0].originY], dbCells: a.length, fileCells: c.length,
  bytesEqual: Buffer.compare(b, f) === 0, differingCells: differing, maxAbsDiffM: max }));
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
