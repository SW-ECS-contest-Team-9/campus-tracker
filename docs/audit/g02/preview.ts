/** G02: run a terrain recipe on a base version WITHOUT saving and write the resulting grid to a file (for offline checks).
 * Read-only, test DB only.   npx tsx ../docs/audit/g02/preview.ts BASE recipe.json OUT.f32 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../../backend/src/config/env.js';
import { pool } from '../../../backend/src/config/database.js';
import { terrain } from '../../../backend/src/geo/terrain.js';
import { applyRecipe, parseRecipe, recipeFiles, recipeId } from '../../../backend/src/geo/terrain-recipe.js';
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
async function main() {
  const [base, file, out] = process.argv.slice(2);
  if (new URL(env.DATABASE_URL).port !== '5544') throw new Error('Refused: not the T05 test database');
  const recipe = parseRecipe(readJson(file));
  const inputs = Object.fromEntries(recipeFiles(recipe).map((f) => [f, readJson(path.resolve(path.dirname(file), f))]));
  const ctx = (await terrain.context(base))!;
  const buildings = ctx.buildings.flatMap((b) => b.polygons);
  const { heights, steps } = applyRecipe(ctx.grid, ctx.heights, recipe, inputs, buildings);
  fs.writeFileSync(out, Buffer.from(heights.buffer));
  const mask = new Uint8Array(heights.length);
  for (const b of ctx.buildings) for (const rings of b.polygons) { /* footprint mask for the offline check */
    const { rasterizePolygon } = await import('../../../backend/src/geo/dem.js');
    const m = rasterizePolygon(ctx.grid, rings, 0); for (let i = 0; i < m.length; i++) if (m[i]) mask[i] = 1;
  }
  fs.writeFileSync(out.replace(/\.f32$/, '.buildings.u8'), Buffer.from(mask));
  console.log(JSON.stringify({ id: recipeId(base, recipe, inputs, buildings), grid: ctx.grid, steps: steps.map((s) => ({ type: s.type, changedCells: s.changedCells, minDelta: s.minDelta, maxDelta: s.maxDelta })) }, null, 1));
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
