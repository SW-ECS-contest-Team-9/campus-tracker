/** Preview by default; --save stores an INACTIVE candidate. Never changes buildings or roads.
 * Usage: npx tsx scripts/terrain-local-samples.ts BASE_VERSION samples.json[,more.json] [--areas=field,corridor,s06,gate_road,...] [--save]
 * Input: data/terrain/samples/smap_samples_5186.json (areas field, corridor, s06) and, joined with a comma,
 * data/terrain/samples/smap_samples_roads_5186.json (areas gate_road, turnaround, fountain_plaza). EPSG:5186 ground samples with provenance and reason.
 * The id hashes the whole input: ids made from the first file alone stay the same; a two-file input gives new ids.
 * Activate a saved candidate with scripts/terrain-versions.ts.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pool } from '../src/config/database.js';
import { terrain } from '../src/geo/terrain.js';
import { applyLocalSamples, changeStats, mergeLocalSampleInputs, parseLocalSamples, LOCAL_SAMPLE_DEFAULTS } from '../src/geo/terrain-local-samples.js';

async function main() {
  const [baseVersion, file, ...flags] = process.argv.slice(2);
  const save = flags.includes('--save');
  const areasFlag = flags.find((f) => f.startsWith('--areas='));
  if (!baseVersion || !file || flags.some((f) => f !== '--save' && f !== areasFlag)) {
    throw new Error('Usage: terrain-local-samples.ts BASE_VERSION samples.json[,more.json] [--areas=field,corridor,s06,...] [--save]');
  }
  const areas = areasFlag?.slice('--areas='.length).split(',').filter(Boolean);
  const input = mergeLocalSampleInputs(file.split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''))));
  const { reason, samples, groups } = parseLocalSamples(input, areas);
  const db = await pool.connect();
  try {
    await db.query(save ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ctx = await terrain.context(baseVersion, db);
    if (!ctx) throw new Error('Base terrain does not exist');
    const { heights, skipped } = applyLocalSamples(ctx.grid, ctx.heights, samples);
    const modified = ctx.modified.slice();
    for (let i = 0; i < heights.length; i++) {
      if (!Number.isFinite(heights[i])) throw new Error('Non-finite terrain');
      if (heights[i] !== ctx.heights[i]) modified[i] = 1;
    }
    const stats = changeStats(ctx.grid, ctx.heights, heights);
    if (!stats.changedCells) throw new Error('Samples change no cells');
    const inputSha = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const sha = createHash('sha256').update(baseVersion).update(inputSha).update(Buffer.from(heights.buffer)).digest('hex');
    const id = `local-samples-${sha.slice(0, 16)}`;
    const warnings = skipped.map((i) => `sample ${i} (${samples[i].x}, ${samples[i].y}, ${samples[i].z}) skipped: fewer than ` +
      `${LOCAL_SAMPLE_DEFAULTS.minNeighbours} neighbours within ${LOCAL_SAMPLE_DEFAULTS.neighbourRadiusM} m`);
    const metadata = { baseVersion, correction: { reason, inputSha256: inputSha, areas: areas ?? 'all', samples: samples.length, skippedSamples: skipped.length, groups },
      algorithm: 'local-sample-residual-v1', options: LOCAL_SAMPLE_DEFAULTS, ...stats, status: 'DRAFT',
      uncertainty: 'Sigma inherited from base; samples are S-MAP values, not an independent survey; not field validated.',
      qa: { requiresBoundaryAndConnectionReview: true } };
    if (save) {
      await db.query(
        `INSERT INTO terrain_versions (id,source_sha256,srid,vertical_datum,geoid_separation_m,geoid_source,
          origin_x,origin_y,resolution_m,width,height,heights,sigma,modified_mask,active,metadata)
         SELECT $1,$2,srid,vertical_datum,geoid_separation_m,geoid_source,origin_x,origin_y,resolution_m,
          width,height,$3,sigma,$4,false,$5::jsonb FROM terrain_versions WHERE id=$6
         ON CONFLICT (id) DO NOTHING`,
        [id, sha, Buffer.from(heights.buffer), Buffer.from(modified), JSON.stringify(metadata), baseVersion]);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    console.log(JSON.stringify({ id, saved: save, activationRequested: false, warnings, ...metadata }, null, 2));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
