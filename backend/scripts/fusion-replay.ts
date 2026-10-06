/**
 * Replays sessions into run snapshots (docs/MOBILITY_MAP_PLAN.md 4.2–4.3). Unlike fusion:reprocess, the default is
 * an EXPERIMENT run: nothing published, fused_positions and the session's fusion state stay untouched.
 *
 *   npm run fusion:replay -- --session=<uuid> --version=fusion-v4
 *   npm run fusion:replay -- --all --version=fusion-v4 --set gpsGateChi2=9 --set smootherIterations=5 --variant=chi9
 *   npm run fusion:replay -- --session=<uuid> --mode=as-received        (what realtime showed, incl. late drops)
 *   npm run fusion:replay -- --all --publish                            (= reprocess, also keeps a snapshot)
 *
 * Synthetic sessions are skipped with --all unless --include-synthetic.
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { REALTIME_FUSION_VERSION } from '../src/modules/fusion/fusion.algorithms.js';
import { replaySession } from '../src/modules/fusion/fusion.service.js';
import { parseOverrides } from './fusion-replay-args.js';

const { values: args } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    session: { type: 'string', multiple: true },
    version: { type: 'string', default: REALTIME_FUSION_VERSION },
    set: { type: 'string', multiple: true },
    variant: { type: 'string' },
    mode: { type: 'string', default: 'sensor-time' },
    publish: { type: 'boolean', default: false },
    'include-synthetic': { type: 'boolean', default: false },
  },
});

async function main() {
  const mode = args.mode === 'as-received' ? 'AS_RECEIVED' : args.mode === 'sensor-time' ? 'SENSOR_TIME' : null;
  if (!mode) throw new Error('--mode is sensor-time or as-received');
  const overrides = parseOverrides(args.set);
  const { rows } = await pool.query<{ id: string; status: string; synthetic: boolean }>('SELECT id, status, synthetic FROM collection_sessions ORDER BY started_at');
  // --session accepts a full id or a unique prefix (e.g. the 8 characters the tables print)
  const ids = args.all
    ? rows.filter((r) => args['include-synthetic'] || !r.synthetic).map((r) => r.id)
    : (args.session ?? []).map((p) => {
        const hits = rows.filter((r) => r.id.startsWith(p));
        if (hits.length !== 1) throw new Error(`--session=${p} matches ${hits.length} sessions`);
        return hits[0].id;
      });
  if (!ids.length) throw new Error('Pass --all or --session=<uuid>');
  console.log(`fusion replay: ${args.version}${args.variant ? ` variant=${args.variant}` : ''}${overrides ? ` overrides=${JSON.stringify(overrides)}` : ''} mode=${mode}${args.publish ? ' (publish)' : ''}, ${ids.length} sessions\n`);
  const table: Record<string, unknown>[] = [];
  let failed = 0;
  for (const id of ids) {
    try {
      const r = await replaySession(id, args.version!, 'cli', { variant: args.variant ?? null, overrides, mode, publish: args.publish });
      table.push({ session: id.slice(0, 8), run: r.runId.slice(0, 8), outputs: r.outputs.length, gpsUsed: r.metrics.gpsAccepted, gpsRejected: r.metrics.gpsRejected,
        pathM: r.metrics.fusedPathLengthM, warnings: r.metrics.validation.warnings.map((w) => w.code).join(','), ms: r.durationMs });
    } catch (err) {
      failed++;
      table.push({ session: id.slice(0, 8), result: `FAILED: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  console.table(table);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
