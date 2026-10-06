/**
 * Regression guard for refactors: replays every session with every version IN MEMORY (nothing is written)
 * and hashes the outputs. --write stores the hashes, --check compares against a stored file.
 *
 *   npm run fusion:golden -- --out=/tmp/golden.json --write
 *   npm run fusion:golden -- --out=/tmp/golden.json --check
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { FUSION_ALGORITHMS } from '../src/modules/fusion/fusion.algorithms.js';
import { fusionRepository } from '../src/modules/fusion/fusion.repository.js';
import { loadReplayInputs, replayInMemory } from '../src/modules/fusion/fusion.pipeline.js';

const { values: args } = parseArgs({ options: { out: { type: 'string' }, write: { type: 'boolean', default: false }, check: { type: 'boolean', default: false }, version: { type: 'string', multiple: true } } });

async function main() {
  if (!args.out || args.write === args.check) throw new Error('Pass --out=<file> and exactly one of --write / --check');
  const versions = args.version ?? Object.keys(FUSION_ALGORITHMS);
  const sessions = (await fusionRepository.listSessions()).filter((s) => s.status !== 'ACTIVE');
  const hashes: Record<string, string> = {};
  for (const s of sessions) {
    for (const v of versions) {
      const algo = FUSION_ALGORITHMS[v];
      try {
        const inputs = await loadReplayInputs(s.id, algo);
        const r = replayInMemory(algo, inputs.timeline, { finalize: true });
        hashes[`${s.id}|${v}`] = createHash('sha256').update(JSON.stringify(r.outputs)).digest('hex').slice(0, 16) + `:${r.outputs.length}`;
      } catch (err) {
        hashes[`${s.id}|${v}`] = `ERROR ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  if (args.write) {
    fs.writeFileSync(args.out, JSON.stringify(hashes, null, 1));
    console.log(`wrote ${Object.keys(hashes).length} hashes`);
    return;
  }
  const ref = JSON.parse(fs.readFileSync(args.out, 'utf8')) as Record<string, string>;
  const diff = Object.keys({ ...ref, ...hashes }).filter((k) => ref[k] !== hashes[k] && (!args.version || args.version.includes(k.split('|')[1])));
  for (const k of diff) console.log(`DIFF ${k.slice(0, 8)} ${k.split('|')[1]}: ${ref[k]} -> ${hashes[k]}`);
  console.log(diff.length ? `${diff.length} differences` : `identical (${Object.keys(hashes).length} replays)`);
  if (diff.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
