/** List terrain versions, or switch the active one (one transaction). Never changes heights, buildings or roads.
 * Usage: npx tsx scripts/terrain-versions.ts list
 *        npx tsx scripts/terrain-versions.ts activate VERSION_ID
 * activate refuses an unknown id and a version whose grid, datum or geoid differs from the active one.
 */
import { pool, withTransaction } from '../src/config/database.js';
import { gridDifferences, type TerrainVersionGrid } from '../src/geo/terrain-versions.js';

const GRID = `srid, vertical_datum "verticalDatum", geoid_separation_m::float8 "geoidSeparationM", origin_x "originX", origin_y "originY",
  resolution_m::float8 "resolutionM", width, height`;

async function list() {
  const { rows } = await pool.query(
    `SELECT id, active, imported_at "importedAt", metadata->>'baseVersion' "baseVersion", metadata->>'algorithm' algorithm,
            COALESCE(metadata->'correction'->>'reason', metadata->'correction'->'properties'->>'reason') reason,
            left(source_sha256, 12) "sourceSha", width || 'x' || height || ' @' || resolution_m || 'm' grid
       FROM terrain_versions ORDER BY imported_at`);
  console.table(rows);
}

async function activate(id: string) {
  const result = await withTransaction(async (db) => {
    const { rows } = await db.query<TerrainVersionGrid & { id: string; active: boolean }>(
      `SELECT id, active, ${GRID} FROM terrain_versions WHERE id = $1 OR active FOR UPDATE`, [id]);
    const target = rows.find((r) => r.id === id);
    const previous = rows.find((r) => r.active);
    if (!target) throw new Error(`Unknown terrain version: ${id}`);
    if (target.active) return { previous: id, scene: null, unchanged: true };
    const diff = previous ? gridDifferences(previous, target) : [];
    if (diff.length) throw new Error(`Refused: ${id} differs from the active version ${previous!.id} in ${diff.join(', ')}`);
    // same order as terrain-import.ts: clear the flag first (unique partial index terrain_one_active_idx)
    await db.query('UPDATE terrain_versions SET active = false WHERE active');
    await db.query('UPDATE terrain_versions SET active = true WHERE id = $1', [id]);
    const { rows: scene } = await db.query<{ id: string; terrainVersionId: string }>(
      'SELECT id, terrain_version_id "terrainVersionId" FROM scene_versions WHERE active');
    return { previous: previous?.id ?? null, scene: scene[0] ?? null, unchanged: false };
  });
  if (result.unchanged) { console.log(`${id} is already active; nothing changed`); return; }
  console.log(`activated terrain version ${id} (was ${result.previous ?? 'none'})`);
  console.log([
    'Follow-up:',
    '- No server restart: the active id is read from the database per request and grids are cached by version id.',
    '- Preview/editor ground: reload the page (GET /terrain/grid now serves this version).',
    result.scene && result.scene.terrainVersionId !== id
      ? `- Buildings: active scene ${result.scene.id} still has base/roof computed on ${result.scene.terrainVersionId}. Recompute with: npm run scene:import -- --dir=<folder with campus.gpkg>`
      : '- Buildings: the active scene already uses this terrain version.',
    '- Roads keep their stored Z. Sessions already pinned to a terrain version keep it; new sessions use this one.',
    result.previous ? `Rollback: npm run terrain:activate -- ${result.previous}   (then scene:import again if you ran it)` : 'Rollback: none (no version was active before)',
  ].join('\n'));
}

async function main() {
  const [command, id, extra] = process.argv.slice(2);
  if (command === 'list' && !id) return list();
  if (command === 'activate' && id && !extra) return activate(id);
  throw new Error('Usage: terrain-versions.ts list | activate VERSION_ID');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
