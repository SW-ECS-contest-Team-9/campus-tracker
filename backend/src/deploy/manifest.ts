// The repository's desired database state (backend/data/deploy/desired-state.json): which terrain and scene version the
// committed data files must produce. Written by scripts/deploy-manifest.ts, compared with the database by reconcile.ts.
// test/deploy-manifest.test.ts fails when a data file changed without the manifest (hashes below).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRecipe, RECIPE_ALGORITHM, RECIPE_DEFAULTS } from '../geo/terrain-recipe.js';

export interface DesiredState {
  about: string;
  /** active campus map the ids were computed with (the terrain id hashes its footprints, the scene id its version id) */
  mapVersionId: string;
  buildingIds: { file: string; sha256: string };
  terrain: { baseVersion: string; recipe: string; id: string; inputsSha256: string; settingsSha256: string };
  scene: { sourceDir: string; overrides: string; id: string; gpkgSha256: string; overridesSha256: string };
}

// backend/ : two levels up from backend/src/deploy (tsx), three from backend/dist/src/deploy (tsc build)
export const BACKEND_DIR = [path.resolve(import.meta.dirname, '../..'), path.resolve(import.meta.dirname, '../../..')]
  .find((d) => fs.existsSync(path.join(d, 'data'))) ?? path.resolve(import.meta.dirname, '../..');
export const MANIFEST_PATH = 'data/deploy/desired-state.json';

export function loadManifest(root = BACKEND_DIR): DesiredState {
  return JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8'));
}

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
/** Hash of a text file as git stores it (LF): a CRLF checkout on Windows gives the same value. */
export const textSha = (file: string) => sha(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
export const rawSha = (file: string) => sha(fs.readFileSync(file));

/** Hashes of everything the manifest ids are made from, read from the files under root. */
export function inputHashes(m: DesiredState, root = BACKEND_DIR) {
  const at = (f: string) => path.join(root, f);
  return {
    buildingIds: textSha(at(m.buildingIds.file)),
    terrainInputs: sha(JSON.stringify(readRecipe(at(m.terrain.recipe)))), // parsed JSON, like the terrain id itself
    terrainSettings: sha(JSON.stringify({ algorithm: RECIPE_ALGORITHM, defaults: RECIPE_DEFAULTS })),
    gpkg: rawSha(path.join(at(m.scene.sourceDir), 'campus.gpkg')),
    overrides: textSha(at(m.scene.overrides)),
  };
}

/** Why the files under root would not give the manifest ids ([] = the files match the manifest). */
export function manifestProblems(m: DesiredState, root = BACKEND_DIR): string[] {
  const h = inputHashes(m, root);
  const out: string[] = [];
  if (h.buildingIds !== m.buildingIds.sha256) out.push(`${m.buildingIds.file} differs from the manifest`);
  if (h.terrainInputs !== m.terrain.inputsSha256) out.push(`the recipe ${m.terrain.recipe} or one of its input files differs from the manifest`);
  if (h.terrainSettings !== m.terrain.settingsSha256) out.push('the terrain recipe code settings differ from the manifest');
  if (h.gpkg !== m.scene.gpkgSha256) out.push(`${m.scene.sourceDir}/campus.gpkg differs from the manifest`);
  if (h.overrides !== m.scene.overridesSha256) out.push(`${m.scene.overrides} differs from the manifest`);
  else if (rawSha(path.join(root, m.scene.overrides)) !== m.scene.overridesSha256) out.push(`${m.scene.overrides} has CRLF line endings (the scene id is made from its bytes; check it out with LF)`);
  return out;
}
