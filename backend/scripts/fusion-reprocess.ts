/**
 * Reprocess stored sessions with a fusion algorithm version (raw tables are only read).
 *
 *   npm run fusion:reprocess -- --all --version=fusion-v2
 *   npm run fusion:reprocess -- --session=<uuid> --version=fusion-v2
 *   npm run fusion:reprocess -- --all --version=fusion-v2 --force
 *   npm run fusion:reprocess:v21          (= --all --version=fusion-v2.1 --force)
 *   npm run fusion:reprocess -- --dirty --version=fusion-v2.1   (only sessions whose fusion is DIRTY/FAILED)
 *
 * Each session is replayed and stored in its own transaction; one failure does not stop the others.
 * Skipped without --force: sessions already processed with the same version + config (fusion_runs),
 * and (even with --force) ACTIVE sessions when reprocessing the live version: the running server owns that live
 * state and replays them at finalization (use the API, or --include-active). Other versions process ACTIVE sessions.
 * The preview is not notified from this process: press ↻ (reload) in the preview afterwards.
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { FUSION_ALGORITHMS, REALTIME_FUSION_VERSION } from '../src/modules/fusion/fusion.algorithms.js';
import { configHash, replaySession } from '../src/modules/fusion/fusion.service.js';
import { fusionRepository } from '../src/modules/fusion/fusion.repository.js';
import { spatial } from '../src/geo/spatial.js';
import { terrain } from '../src/geo/terrain.js';

const { values: args } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    dirty: { type: 'boolean', default: false },
    session: { type: 'string' },
    version: { type: 'string', default: REALTIME_FUSION_VERSION },
    force: { type: 'boolean', default: false },
    'include-active': { type: 'boolean', default: false },
  },
});

async function main() {
  const version = args.version!;
  const algo = FUSION_ALGORITHMS[version];
  if (!algo) throw new Error(`Unknown --version=${version}. Known: ${Object.keys(FUSION_ALGORITHMS).join(', ')}`);
  if (!args.all && !args.session && !args.dirty) throw new Error('Pass --all, --dirty or --session=<uuid>');

  const all = await fusionRepository.listSessions();
  const sessions = args.session
    ? all.filter((s) => s.id === args.session)
    : args.dirty
      ? all.filter((s) => s.needsReprocess || s.fusionState !== 'CLEAN')
      : all;
  if (args.dirty && sessions.length === 0) console.log('No dirty sessions.');
  if (sessions.length === 0 && !args.dirty) throw new Error(`Session ${args.session} not found`);
  console.log(`fusion reprocess: version=${version} sessions=${sessions.length}${args.force ? ' (force)' : ''}\n`);

  const rows: Record<string, unknown>[] = [];
  let failed = 0;
  const totals = { outputs: 0, accepted: 0, rejected: 0, reanchors: 0, divergences: 0, warnings: 0 };
  const warned: string[] = [];
  for (const s of sessions) {
    const hash = configHash(algo, await spatial.sessionMapVersion(s.id), algo.usesTerrain ? await terrain.sessionVersion(s.id) : null);
    const base = { session: s.id.slice(0, 8), collector: s.collectorId, status: s.status };
    // The running server owns the live state of ACTIVE sessions (it replays them itself when they finish).
    if (!args['include-active'] && s.status === 'ACTIVE' && version === REALTIME_FUSION_VERSION) {
      rows.push({ ...base, result: 'skipped (ACTIVE, live version)' });
      continue;
    }
    // --dirty: the raw data changed since the last run, so the "same code + config" shortcut does not apply
    if (!args.force && !args.dirty && (await fusionRepository.hasCompletedRun(s.id, version, hash))) {
      rows.push({ ...base, result: 'skipped (up to date)' });
      continue;
    }
    try {
      const r = await replaySession(s.id, version, 'cli');
      const m = r.metrics;
      totals.outputs += m.fusionOutputCount;
      totals.accepted += m.gpsAccepted;
      totals.rejected += m.gpsRejected;
      totals.reanchors += m.reanchors ?? 0;
      totals.divergences += m.divergences ?? 0;
      totals.warnings += m.validation.warnings.length;
      for (const w of m.validation.warnings) warned.push(`${s.id.slice(0, 8)} ${w.code}: ${w.message}`);
      rows.push({
        ...base,
        result: 'done',
        gps: m.rawGpsCount,
        outputs: m.fusionOutputCount,
        accepted: m.gpsAccepted,
        rejected: m.gpsRejected,
        'rejected%': m.rejectedPct,
        stationaryS: m.stationarySeconds,
        reanchors: m.reanchors,
        fusedMaxM: m.validation.fusedMaxDisplacementM,
        allowedM: m.validation.allowedDisplacementM,
        zRangeM: m.validation.fusedZRangeM,
        baroRangeM: m.validation.altimeterRangeM,
        warnings: m.validation.warnings.map((w) => w.code).join(',') || '',
        ms: r.durationMs,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'FUSION_BUSY') {
        rows.push({ ...base, result: 'busy (being reprocessed by the server)' });
        continue;
      }
      failed++;
      rows.push({ ...base, result: `FAILED: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  console.table(rows);
  const done = rows.filter((r) => r.result === 'done').length;
  const judged = totals.accepted + totals.rejected;
  console.log(`
Fusion ${version} reprocess
  Total:     ${rows.length}
  Success:   ${done}
  Skipped:   ${rows.length - done - failed}
  Failed:    ${failed}
  Outputs:   ${totals.outputs.toLocaleString()}
  GPS used:  ${totals.accepted.toLocaleString()}
  GPS rejected: ${totals.rejected.toLocaleString()}${judged ? ` (${((100 * totals.rejected) / judged).toFixed(1)}%)` : ''}
  Re-anchors: ${totals.reanchors}
  Divergences prevented: ${totals.divergences}
  Validation warnings: ${totals.warnings}${warned.length ? '\n    ' + warned.join('\n    ') : ''}

Reload the preview (↻) to see new results.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
