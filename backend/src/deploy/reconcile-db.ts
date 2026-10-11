// The deploy reconcile against the real database and the data files of this checkout (decisions: reconcile.ts).
// Run at server start-up (mode from DEPLOY_RECONCILE, default dry-run = compare and report only) and by
// `npm run deploy:sync` (mode on). Reuses the code of db:migrate, building-ids-rename, terrain:recipe --save,
// terrain:activate and scene:import. It does not touch the road network.
import fs from 'node:fs';
import path from 'node:path';
import { pool, withTransaction } from '../config/database.js';
import { logger } from '../common/logger.js';
import { migrate } from '../db/migrator.js';
import { terrain } from '../geo/terrain.js';
import { buildRecipeTerrain, saveRecipeTerrain } from '../geo/terrain-recipe-build.js';
import { activateTerrainVersion } from '../geo/terrain-versions.js';
import { planSceneImport } from '../modules/scene/scene-import.js';
import { parseBuildingIdFixes } from '../modules/spatial/building-ids.js';
import { buildingIdRenamePlan, renameBuildingIds } from '../modules/spatial/building-ids-rename.js';
import { BACKEND_DIR, loadManifest, manifestProblems, MANIFEST_PATH, type DesiredState } from './manifest.js';
import { overall, reconcile, summarize, type ReconcileDeps, type ReconcileMode, type ReconcileResult, type StepResult } from './reconcile.js';

const LOCK_KEY = 5186002; // session advisory lock: one reconcile at a time per database (the editor uses 5186001)

export interface ReconcileStatus {
  mode: ReconcileMode;
  at: string;
  result: ReconcileResult;
  summary: string;
  steps: StepResult[];
  manifest: { terrainId: string; sceneId: string } | null;
  /** active ids before this run (for rolling back) */
  before: { terrainId: string | null; sceneId: string | null } | null;
}

let last: ReconcileStatus | null = null;

const activeScene = async () => (await pool.query<{ id: string }>('SELECT id FROM scene_versions WHERE active LIMIT 1')).rows[0]?.id ?? null;

function dbDeps(m: DesiredState, root: string): ReconcileDeps {
  const at = (f: string) => path.join(root, f);
  const fixes = () => parseBuildingIdFixes(JSON.parse(fs.readFileSync(at(m.buildingIds.file), 'utf8')));
  return {
    migrations: async (apply) => (await migrate(apply)).pending,
    buildingIdState: async () => (await buildingIdRenamePlan(pool, fixes())).state,
    renameBuildingIds: () => withTransaction(async (db) => renameBuildingIds(db, (await buildingIdRenamePlan(db, fixes())).map, fixes())),
    activeTerrain: () => terrain.activeVersion(),
    buildTerrain: async () => {
      const built = await buildRecipeTerrain(pool, m.terrain.baseVersion, at(m.terrain.recipe));
      return { id: built.id, activate: () => withTransaction(async (db) => { await saveRecipeTerrain(db, built); await activateTerrainVersion(db, built.id); }) };
    },
    activeScene,
    // the source folder is read in place: nothing is copied and SOURCES.json is not rewritten (the checkout stays clean)
    planScene: () => planSceneImport({ dir: at(m.scene.sourceDir), overridesFile: at(m.scene.overrides) }),
    preflight: async () => {
      const map = (await pool.query<{ id: string }>('SELECT id FROM spatial_map_versions WHERE active')).rows[0]?.id ?? null;
      return [...manifestProblems(m, root), ...(map === m.mapVersionId ? [] : [`the active campus map is ${map}, the manifest was made with ${m.mapVersionId}`])];
    },
  };
}

/** Never throws. root = the backend folder whose data files and manifest are used. */
export async function runReconcile(mode: ReconcileMode, root = BACKEND_DIR): Promise<ReconcileStatus> {
  const status: ReconcileStatus = { mode, at: new Date().toISOString(), result: 'off', summary: summarize([], 'off'), steps: [], manifest: null, before: null };
  if (mode !== 'off') {
    let lock: import('pg').PoolClient | null = null;
    try {
      const m = loadManifest(root);
      status.manifest = { terrainId: m.terrain.id, sceneId: m.scene.id };
      lock = await pool.connect();
      await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]); // waits for another process that is reconciling
      status.before = await activeIds();
      status.steps = await reconcile(status.manifest, mode, dbDeps(m, root));
      status.result = overall(status.steps, mode);
      status.summary = summarize(status.steps, mode);
    } catch (err) {
      status.result = 'failed';
      status.summary = `실패: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await lock?.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
      lock?.release();
    }
  }
  last = status;
  const fields = { mode, result: status.result, summary: status.summary };
  if (status.result === 'refused' || status.result === 'failed') logger.error('deploy.reconcile', fields);
  else if (status.result === 'pending') logger.warn('deploy.reconcile', fields);
  else logger.info('deploy.reconcile', fields);
  return status;
}

async function activeIds() {
  try {
    return { terrainId: await terrain.activeVersion(), sceneId: await activeScene() };
  } catch {
    return null; // tables not there yet (migrations pending)
  }
}

/** For GET /health: the last reconcile result and the ids that are active right now. */
export async function deployStatus() {
  return { reconcile: last, active: await activeIds() };
}

/** Re-runs the reconcile when a pull changes the manifest while the server keeps running (a pull that changes only data
 * files does not restart `tsx watch`). Waits a few seconds so that the pull has finished writing the other files.
 */
export function watchManifest(mode: ReconcileMode, root = BACKEND_DIR) {
  let timer: NodeJS.Timeout | null = null;
  fs.watchFile(path.join(root, MANIFEST_PATH), { interval: 5000 }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void runReconcile(mode, root), 3000);
  }).unref();
}
