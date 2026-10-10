/** T06: where a recipe step changes the ground most. Read-only, test DB only.
 *   npx tsx ../docs/audit/t06/big_changes.ts BASE recipe.json STEP_NUMBER [minAbsM=3] */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../../backend/src/config/env.js';
import { pool } from '../../../backend/src/config/database.js';
import { terrain } from '../../../backend/src/geo/terrain.js';
import { applyRecipe, parseRecipe, recipeFiles } from '../../../backend/src/geo/terrain-recipe.js';
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
async function main() {
  const [base, file, stepNo, min] = process.argv.slice(2);
  if (new URL(env.DATABASE_URL).port !== '5544') throw new Error('Refused: not the T05 test database');
  const recipe = parseRecipe(readJson(file));
  const inputs = Object.fromEntries(recipeFiles(recipe).map((f) => [f, readJson(path.resolve(path.dirname(file), f))]));
  const ctx = (await terrain.context(base))!;
  const g = ctx.grid, fp = ctx.buildings.flatMap((b) => b.polygons) as any;
  const k = Number(stepNo);
  const before = k > 1 ? applyRecipe(g, ctx.heights, { ...recipe, steps: recipe.steps.slice(0, k - 1) }, inputs, fp).heights : ctx.heights;
  const after = applyRecipe(g, ctx.heights, { ...recipe, steps: recipe.steps.slice(0, k) }, inputs, fp).heights;
  const rows: any[] = [];
  for (let i = 0; i < after.length; i++) {
    const d = after[i] - before[i];
    if (Math.abs(d) >= Number(min ?? 3)) rows.push([g.originX + ((i % g.width) + 0.5) * g.resolution, g.originY + (Math.floor(i / g.width) + 0.5) * g.resolution, Math.round(before[i] * 10) / 10, Math.round(after[i] * 10) / 10, Math.round(d * 10) / 10, Math.round(ctx.heights[i] * 10) / 10]);
  }
  console.log('x y before after delta base');
  for (const r of rows.sort((a, b) => a[4] - b[4])) console.log(r.join(' '));
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
