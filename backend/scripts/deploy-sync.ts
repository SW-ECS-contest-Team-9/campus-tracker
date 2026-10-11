/**
 * Brings the database to the state the checked-out commit describes (data/deploy/desired-state.json). After `git pull`:
 *
 *   npm run deploy:sync            (repository root or backend/)
 *
 * In order: migrations -> building id corrections -> terrain (build from the recipe; saved and activated only when the id
 * equals the manifest id) -> scene (imported only when its id equals the manifest id). Idempotent: a second run does nothing.
 * A different id is refused and nothing is written (wrong line endings or footprints on this machine: find out why first).
 * The road network is NOT touched: no road re-levelling and no road/place/area writes (separate, approved step).
 * The same code runs at server start-up (DEPLOY_RECONCILE, default dry-run = report only). See src/deploy.
 */
import { pool } from '../src/config/database.js';
import { runReconcile } from '../src/deploy/reconcile-db.js';
import { deployStatus } from '../src/deploy/reconcile-db.js';

async function main() {
  const status = await runReconcile('on');
  const after = (await deployStatus()).active;
  console.table(status.steps);
  console.log(`manifest: terrain ${status.manifest?.terrainId}, scene ${status.manifest?.sceneId}`);
  console.log(`before:   terrain ${status.before?.terrainId}, scene ${status.before?.sceneId}`);
  console.log(`after:    terrain ${after?.terrainId}, scene ${after?.sceneId}`);
  console.log(status.summary);
  if (status.before?.terrainId && status.before.terrainId !== after?.terrainId) {
    console.log(`Rollback: npm run terrain:activate -w backend -- ${status.before.terrainId}   then check out the previous commit and run deploy:sync (or scene:import) for the buildings`);
  }
  if (status.steps.some((s) => s.step === 'terrain' && s.outcome === 'applied')) {
    console.log('Roads were not moved: they keep the heights of the old terrain until the road-network step (terrain:relevel-roads / editor change sets) is approved and run.');
  }
  if (status.result === 'refused' || status.result === 'failed') process.exitCode = 1;
}

main().finally(() => pool.end());
