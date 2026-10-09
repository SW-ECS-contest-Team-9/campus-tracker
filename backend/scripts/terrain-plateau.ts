/** Preview by default; --save stores an INACTIVE candidate. Never changes buildings or roads.
 * Usage: npx tsx scripts/terrain-plateau.ts BASE_VERSION polygon.geojson [--save]
 * Input: GeoJSON Feature, Polygon in EPSG:5186, properties.heightM and properties.reason.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pool } from '../src/config/database.js';
import { terrain } from '../src/geo/terrain.js';
import { applyPlateau } from '../src/geo/terrain-plateau.js';

async function main() {
  const [baseVersion, file, flag] = process.argv.slice(2);
  if (!baseVersion || !file || (flag !== undefined && flag !== '--save') || process.argv.length > 6) {
    throw new Error('Usage: terrain-plateau.ts BASE_VERSION polygon.geojson [--save]');
  }
  const input = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (input.type !== 'Feature' || input.geometry?.type !== 'Polygon' ||
      input.properties?.srid !== 5186 || !Number.isFinite(input.properties?.heightM) ||
      typeof input.properties?.reason !== 'string' || !input.properties.reason.trim()) {
    throw new Error('Expected Polygon Feature with srid=5186, finite heightM and reason');
  }
  const db = await pool.connect();
  try {
    await db.query(flag === '--save' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ctx = await terrain.context(baseVersion, db);
    if (!ctx) throw new Error('Base terrain does not exist');
    const g = ctx.grid;
    const { rows: [check] } = await db.query<{ valid: boolean }>(
      `WITH p AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),5186) g)
       SELECT ST_IsValid(g) AND NOT ST_IsEmpty(g) AND ST_Area(g)>0
         AND ST_CoveredBy(g,ST_MakeEnvelope($2,$3,$4,$5,5186)) valid FROM p`,
      [JSON.stringify(input.geometry), g.originX, g.originY,
        g.originX + g.width * g.resolution, g.originY + g.height * g.resolution]);
    if (!check.valid) throw new Error('Invalid polygon or outside base grid');
    const heights = applyPlateau(g, ctx.heights, input.geometry.coordinates, input.properties.heightM);
    const modified = ctx.modified.slice();
    let changedCells = 0, minDelta = 0, maxDelta = 0;
    for (let i = 0; i < heights.length; i++) {
      if (!Number.isFinite(heights[i])) throw new Error('Non-finite terrain');
      const delta = heights[i] - ctx.heights[i];
      if (delta !== 0) { changedCells++; modified[i] = 1; }
      minDelta = Math.min(minDelta, delta); maxDelta = Math.max(maxDelta, delta);
    }
    if (!changedCells) throw new Error('Polygon changes no cells');
    const sha = createHash('sha256').update(baseVersion).update(JSON.stringify(input)).update(Buffer.from(heights.buffer)).digest('hex');
    const id = `plateau-${sha.slice(0, 16)}`;
    const metadata = { baseVersion, correction: input, algorithm: 'polygon-cell-centers-v1',
      changedCells, minDelta, maxDelta, status: 'DRAFT',
      uncertainty: 'Sigma inherited from base; correction accuracy is not field validated.',
      qa: { requiresBoundaryAndConnectionReview: true } };
    if (flag === '--save') {
      await db.query(
        `INSERT INTO terrain_versions (id,source_sha256,srid,vertical_datum,geoid_separation_m,geoid_source,
          origin_x,origin_y,resolution_m,width,height,heights,sigma,modified_mask,active,metadata)
         SELECT $1,$2,srid,vertical_datum,geoid_separation_m,geoid_source,origin_x,origin_y,resolution_m,
          width,height,$3,sigma,$4,false,$5::jsonb FROM terrain_versions WHERE id=$6
         ON CONFLICT (id) DO NOTHING`,
        [id, sha, Buffer.from(heights.buffer), Buffer.from(modified), JSON.stringify(metadata), baseVersion]);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    console.log(JSON.stringify({ id, saved: flag === '--save', activationRequested: false, ...metadata }, null, 2));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
