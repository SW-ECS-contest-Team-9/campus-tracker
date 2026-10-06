/**
 * Deletes old run snapshots. Keeps pinned runs, runs used by route passes and the newest --keep (default 5) per
 * (session, version, variant, mode). Raw data and the published fused_positions are never touched.
 *
 *   npm run fusion:prune -- --dry-run
 *   npm run fusion:prune -- --keep=3
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { fusionRunsRepository } from '../src/modules/fusion/fusion-runs.repository.js';

const { values: args } = parseArgs({ options: { keep: { type: 'string', default: '5' }, 'dry-run': { type: 'boolean', default: false } } });

fusionRunsRepository.prune(Math.max(1, Number(args.keep)), args['dry-run'])
  .then((ids) => console.log(`${args['dry-run'] ? 'would delete' : 'deleted'} ${ids.length} run snapshots`))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
