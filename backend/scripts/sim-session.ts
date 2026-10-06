/**
 * Synthetic sessions with known ground truth for the Lab (docs/MOBILITY_MAP_PLAN.md 4.5). Stored with collector
 * SIM and collection_sessions.synthetic = true (excluded from real statistics, bench and --all by default).
 * Then: fusion (published), qc-v1, and with --route a route "SIM 직선 경로" + passes + canonical path + validation.
 *
 *   npm run sim:session -- --sessions=2 --passes=4 --route
 *   npm run sim:session -- --delete            (removes every synthetic session)
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { concatWalks, reversed, syntheticWalk, type BiasZone } from '../src/sim/synthetic.js';
import { storeSyntheticSession } from '../src/sim/sim-store.js';
import { replaySession } from '../src/modules/fusion/fusion.service.js';
import { qcService } from '../src/modules/qc/qc.service.js';
import { pathfusionService } from '../src/modules/pathfusion/pathfusion.service.js';
import { terrain } from '../src/geo/terrain.js';
import { CAMPUS_FRAME } from '../src/geo/campus-frame.js';

const { values: args } = parseArgs({
  options: {
    sessions: { type: 'string', default: '2' },
    passes: { type: 'string', default: '4' },
    seed: { type: 'string', default: '1' },
    route: { type: 'boolean', default: false },
    delete: { type: 'boolean', default: false },
  },
});

// campus frame (m): a 120 m building-free stretch on campus; a multipath zone biases every pass near its middle
export const SIM_PATH = [{ x: 40, y: -140 }, { x: -2.4, y: -97.6 }, { x: -44.9, y: -55.1 }];
const ZONE: BiasZone = { center: { x: 0, y: -100 }, radiusM: 15, biasM: { x: 4, y: 4 } };

async function main() {
  if (args.delete) {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM collection_sessions WHERE synthetic');
    await pool.query(`DELETE FROM route_passes WHERE session_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM fusion_runs WHERE session_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
    await pool.query('DELETE FROM collection_sessions WHERE synthetic');
    console.log(`deleted ${rows.length} synthetic sessions`);
    return;
  }
  const nSessions = Number(args.sessions);
  const nPasses = Number(args.passes);
  let seed = Number(args.seed) * 1000;
  const ids: string[] = [];
  const day = Date.parse('2026-10-03T01:00:00Z');
  // the synthetic barometer and GPS heights follow the campus DEM (otherwise the terrain datum sees contradictions)
  const ctx = await terrain.context(await terrain.activeVersion());
  const groundAt = (x: number, y: number) => (ctx ? terrain.sampleXY(ctx, x + CAMPUS_FRAME.originE, y + CAMPUS_FRAME.originN)?.height ?? null : null);
  for (let s = 0; s < nSessions; s++) {
    let t = day + s * 3_600_000;
    const walks = [];
    for (let p = 0; p < nPasses; p++) {
      const w = syntheticWalk({ path: p % 2 ? reversed(SIM_PATH) : SIM_PATH, startMs: t, seed: ++seed, thetaRad: 0.7 + s, pauseStartS: p ? 3 : 20, pauseEndS: 8, groundAt,
        gps: { sigmaM: 4, correlatedSigmaM: 4, correlatedTauS: 20, zones: [ZONE], accuracyM: 9 } });
      walks.push(w);
      t = w.endedAt.getTime() + 20;
    }
    const id = await storeSyntheticSession(concatWalks(walks), `${nPasses} passes, seed ${args.seed}`);
    await replaySession(id, 'fusion-v4', 'cli');
    await qcService.run(id);
    ids.push(id);
    console.log(`synthetic session ${id} (${nPasses} passes)`);
  }
  if (args.route) {
    const route = await pathfusionService.createRoute({ name: 'SIM 직선 경로', a: SIM_PATH[0], b: SIM_PATH.at(-1)!, radiusM: 15, widthM: 20, notes: 'synthetic: sim:session' });
    const d = await pathfusionService.detectPasses(route.id, { sessionIds: ids });
    const c = await pathfusionService.buildCanonical(route.id);
    const v = await pathfusionService.validate(route.id);
    console.log('passes', d, '\ncanonical', JSON.stringify(c), '\nvalidation', JSON.stringify(v.pooled));
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
