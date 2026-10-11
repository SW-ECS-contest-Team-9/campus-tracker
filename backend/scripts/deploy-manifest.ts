/**
 * Regenerates data/deploy/desired-state.json from the data files of this checkout. Run before committing a change to the
 * terrain recipe (or its inputs), the scene overrides, the scene source or the building id corrections:
 *
 *   npm run deploy:manifest            write the manifest
 *   npm run deploy:manifest -- check   exit 1 when the committed manifest differs from what would be written
 *
 * Needs a database that has the campus map imported (any test database; read only): the terrain id hashes the building
 * footprints of the active map and the scene id its version id. Which files are used (baseVersion, recipe, sourceDir,
 * overrides, building ids file) is kept from the existing manifest; edit those fields by hand to point at another recipe.
 * The scene id is computed for an LF checkout of the overrides file, which is what the server has.
 * test/deploy-manifest.test.ts (no database) fails when the files no longer match the manifest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/config/database.js';
import { BACKEND_DIR, inputHashes, loadManifest, MANIFEST_PATH, type DesiredState } from '../src/deploy/manifest.js';
import { terrain } from '../src/geo/terrain.js';
import { readRecipe, recipeId } from '../src/geo/terrain-recipe.js';
import { sceneVersionId } from '../src/modules/scene/scene-overrides.js';

async function main() {
  const file = path.join(BACKEND_DIR, MANIFEST_PATH);
  const old = loadManifest();
  const h = inputHashes(old);
  const { rows: mv } = await pool.query<{ id: string }>('SELECT id FROM spatial_map_versions WHERE active');
  const ctx = await terrain.context(old.terrain.baseVersion);
  if (!mv.length || !ctx) throw new Error(`This database has no active campus map or no terrain ${old.terrain.baseVersion}`);
  const { recipe, inputs } = readRecipe(path.join(BACKEND_DIR, old.terrain.recipe));
  const terrainId = recipeId(old.terrain.baseVersion, recipe, inputs, recipe.protectBuildings ? ctx.buildings.flatMap((b) => b.polygons) : []);
  const next: DesiredState = {
    about: old.about,
    mapVersionId: mv[0].id,
    buildingIds: { file: old.buildingIds.file, sha256: h.buildingIds },
    terrain: { baseVersion: old.terrain.baseVersion, recipe: old.terrain.recipe, id: terrainId, inputsSha256: h.terrainInputs, settingsSha256: h.terrainSettings },
    scene: { sourceDir: old.scene.sourceDir, overrides: old.scene.overrides, id: sceneVersionId(h.gpkg, terrainId, mv[0].id, 'RECOMPUTED', h.overrides), gpkgSha256: h.gpkg, overridesSha256: h.overrides },
  };
  const text = JSON.stringify(next, null, 2) + '\n';
  if (process.argv[2] === 'check') {
    if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error(`${MANIFEST_PATH} is stale: run npm run deploy:manifest (terrain ${old.terrain.id} -> ${next.terrain.id}, scene ${old.scene.id} -> ${next.scene.id})`);
    console.log(`${MANIFEST_PATH} is up to date: terrain ${next.terrain.id}, scene ${next.scene.id}`);
  } else {
    fs.writeFileSync(file, text);
    console.log(`wrote ${MANIFEST_PATH}: terrain ${next.terrain.id}, scene ${next.scene.id}, map ${next.mapVersionId}`);
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }).finally(() => pool.end());
