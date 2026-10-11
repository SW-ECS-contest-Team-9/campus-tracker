/** Build one derived terrain candidate from a recipe (ordered steps: local-samples, plateau, corridor) on a base version.
 * Preview by default; --save stores an INACTIVE candidate. Never changes buildings or roads.
 * Usage: npx tsx scripts/terrain-recipe.ts BASE_VERSION recipe.json [--save]
 * File paths in the recipe are relative to the recipe file. See src/geo/terrain-recipe.ts for the format and
 * data/terrain/recipes/ for recipes. The id depends on the base id, the recipe, the default settings and its input contents
 * (and, with protectBuildings, the footprints of the active campus map). Activate a saved candidate with scripts/terrain-versions.ts.
 */
import { pool } from '../src/config/database.js';
import { buildRecipeTerrain, saveRecipeTerrain } from '../src/geo/terrain-recipe-build.js';

async function main() {
  const [baseVersion, file, flag] = process.argv.slice(2);
  if (!baseVersion || !file || (flag !== undefined && flag !== '--save') || process.argv.length > 5) {
    throw new Error('Usage: terrain-recipe.ts BASE_VERSION recipe.json [--save]');
  }
  const save = flag === '--save';
  const db = await pool.connect();
  try {
    await db.query(save ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const built = await buildRecipeTerrain(db, baseVersion, file);
    if (save) {
      await saveRecipeTerrain(db, built);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    const { id, sha, metadata } = built;
    console.log(JSON.stringify({ id, gridSha256: sha, saved: save, activationRequested: false, ...metadata, correction: { ...metadata.correction, recipe: undefined } }, null, 2));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
