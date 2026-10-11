// Database side of a terrain recipe: build the candidate grid from a base version and store it (inactive).
// Used by scripts/terrain-recipe.ts and by the deploy reconcile (src/deploy). The steps themselves are in terrain-recipe.ts.
import { createHash } from 'node:crypto';
import type { DbClient } from '../config/database.js';
import { terrain } from './terrain.js';
import { changeStats } from './terrain-local-samples.js';
import { applyRecipe, readRecipe, recipeId, recipeInputHashes, RECIPE_ALGORITHM, RECIPE_DEFAULTS } from './terrain-recipe.js';

/** Builds the candidate in memory; writes nothing. The id depends on the footprints of the active campus map (protectBuildings). */
export async function buildRecipeTerrain(db: DbClient, baseVersion: string, file: string) {
  const { recipe, inputs } = readRecipe(file);
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
  return { id, sha, baseVersion, heights, modified, metadata };
}

/** Stores the candidate INACTIVE (no-op when the same grid is already stored). */
export async function saveRecipeTerrain(db: DbClient, built: Awaited<ReturnType<typeof buildRecipeTerrain>>) {
  const { id, sha, heights, modified, metadata, baseVersion } = built;
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
}
