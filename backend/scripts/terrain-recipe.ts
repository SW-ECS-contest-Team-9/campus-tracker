/** Build one derived terrain candidate from a recipe (ordered steps: local-samples, plateau, corridor) on a base version.
 * Preview by default; --save stores an INACTIVE candidate. Never changes buildings or roads.
 * Usage: npx tsx scripts/terrain-recipe.ts BASE_VERSION recipe.json [--save]
 * File paths in the recipe are relative to the recipe file. See src/geo/terrain-recipe.ts for the format and
 * data/terrain/recipes/ for recipes. The id depends on the base id, the recipe, the default settings and its input contents
 * (and, with protectBuildings, the footprints of the active campus map). Activate a saved candidate with scripts/terrain-versions.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pool } from '../src/config/database.js';
import { terrain } from '../src/geo/terrain.js';
import { changeStats } from '../src/geo/terrain-local-samples.js';
import { applyRecipe, parseRecipe, recipeFiles, recipeId, recipeInputHashes, RECIPE_ALGORITHM, RECIPE_DEFAULTS } from '../src/geo/terrain-recipe.js';

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));

async function main() {
  const [baseVersion, file, flag] = process.argv.slice(2);
  if (!baseVersion || !file || (flag !== undefined && flag !== '--save') || process.argv.length > 5) {
    throw new Error('Usage: terrain-recipe.ts BASE_VERSION recipe.json [--save]');
  }
  const save = flag === '--save';
  const recipe = parseRecipe(readJson(file));
  const inputs = Object.fromEntries(recipeFiles(recipe).map((f) => [f, readJson(path.resolve(path.dirname(file), f))]));
  const db = await pool.connect();
  try {
    await db.query(save ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ctx = await terrain.context(baseVersion, db);
    if (!ctx) throw new Error('Base terrain does not exist');
    const buildings = recipe.protectBuildings ? ctx.buildings.flatMap((b) => b.polygons) : [];
    if (recipe.protectBuildings && !buildings.length) throw new Error('protectBuildings: no active campus map (npm run spatial:import)');
    const { heights, steps } = applyRecipe(ctx.grid, ctx.heights, recipe, inputs, buildings);
    const modified = ctx.modified.slice();
    for (let i = 0; i < heights.length; i++) {
      if (!Number.isFinite(heights[i])) throw new Error('Non-finite terrain');
      if (heights[i] !== ctx.heights[i]) modified[i] = 1;
    }
    const stats = changeStats(ctx.grid, ctx.heights, heights);
    if (!stats.changedCells) throw new Error('Recipe changes no cells');
    const id = recipeId(baseVersion, recipe, inputs, buildings);
    const sha = createHash('sha256').update(id).update(Buffer.from(heights.buffer)).digest('hex');
    const metadata = { baseVersion, correction: { reason: recipe.reason.trim(), recipe, inputSha256: recipeInputHashes(recipe, inputs, buildings) },
      algorithm: RECIPE_ALGORITHM, options: RECIPE_DEFAULTS,
      steps, ...stats, status: 'DRAFT',
      uncertainty: 'Sigma inherited from base; heights are S-MAP values and user-confirmed floor levels, not an independent survey; not field validated.',
      qa: { requiresBoundaryAndConnectionReview: true } };
    if (save) {
      // the id does not hash the grid: refuse to keep a stored candidate that the same recipe no longer reproduces
      const { rows: existing } = await db.query<{ sha: string }>('SELECT source_sha256 sha FROM terrain_versions WHERE id=$1', [id]);
      if (existing.length && existing[0].sha !== sha) throw new Error(`${id} is already stored with a different grid (code or base changed)`);
      await db.query(
        `INSERT INTO terrain_versions (id,source_sha256,srid,vertical_datum,geoid_separation_m,geoid_source,
          origin_x,origin_y,resolution_m,width,height,heights,sigma,modified_mask,active,metadata)
         SELECT $1,$2,srid,vertical_datum,geoid_separation_m,geoid_source,origin_x,origin_y,resolution_m,
          width,height,$3,sigma,$4,false,$5::jsonb FROM terrain_versions WHERE id=$6
         ON CONFLICT (id) DO NOTHING`,
        [id, sha, Buffer.from(heights.buffer), Buffer.from(modified), JSON.stringify(metadata), baseVersion]);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    console.log(JSON.stringify({ id, gridSha256: sha, saved: save, activationRequested: false, ...metadata, correction: { ...metadata.correction, recipe: undefined } }, null, 2));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
