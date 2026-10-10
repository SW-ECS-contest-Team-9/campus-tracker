/**
 * Brings an existing database in line with data/campus-map/overrides/building-ids.json without re-importing the campus map
 * (spatial:import would drop building_metadata, which only terrain:import rebuilds).
 *
 *   npx tsx scripts/building-ids-rename.ts [--dry-run]
 *
 * - Renames campus_buildings and building_metadata rows of the active map version (both phases in one transaction, so two
 *   footprints can swap ids). Already renamed rows are left alone; a half-renamed state aborts.
 * - scene_buildings follow with the next scene:import (it takes the id from campus_buildings).
 * - Roads and places (mobility.*) are edited through the editor so that the change is in its history; this script only
 *   reports how many still use an old id. Stored fusion results keep the id they were computed with.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pool, withTransaction } from '../src/config/database.js';
import { parseBuildingIdFixes } from '../src/modules/spatial/building-ids.js';

const FILE = path.resolve(import.meta.dirname, '../data/campus-map/overrides/building-ids.json');
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const fixes = parseBuildingIdFixes(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  const { rows: mv } = await pool.query<{ id: string }>('SELECT id FROM spatial_map_versions WHERE active');
  if (!mv.length) throw new Error('No active campus map (npm run spatial:import)');
  const map = mv[0].id;
  const { rows } = await pool.query<{ building_id: string; area: number }>('SELECT building_id, round(ST_Area(geom)) area FROM campus_buildings WHERE map_version_id = $1', [map]);
  const have = new Map(rows.map((r) => [r.building_id, r.area]));
  const olds = new Set(fixes.map((f) => f.from));
  // A fix is done when its old id is gone or has been taken over by another fix; all must be in the same state.
  const pending = fixes.filter((f) => have.has(f.from) && !(have.has(f.id) && !olds.has(f.id)));
  const done = fixes.every((f) => have.has(f.id)) && fixes.every((f) => !have.has(f.from) || fixes.some((g) => g.id === f.from));
  const fresh = fixes.every((f) => have.has(f.from)) && fixes.every((f) => !have.has(f.id) || olds.has(f.id));
  console.table(fixes.map((f) => ({ feature: f.feature, from: f.from, to: f.id, 'area of from (m2)': have.get(f.from) ?? '', state: done && !fresh ? 'already renamed' : 'to rename' })));
  if (done && !fresh) {
    console.log('Nothing to do: the active map already has the corrected ids.');
  } else if (!fresh) {
    throw new Error(`Half-renamed building ids on map ${map}: neither the file's ids nor the corrected ones (${pending.map((f) => f.from).join(', ')})`);
  } else if (!dryRun) {
    await withTransaction(async (db) => {
      const tmp = (i: number) => `__rename_${i}`;
      const move = async (from: string, to: string, name?: string | null) => {
        await db.query(
          `INSERT INTO campus_buildings (map_version_id, building_id, building_name, geom)
           SELECT map_version_id, $3, ${name === undefined ? 'building_name' : '$4'}, geom FROM campus_buildings WHERE map_version_id = $1 AND building_id = $2`,
          name === undefined ? [map, from, to] : [map, from, to, name],
        );
        await db.query('UPDATE building_metadata SET building_id = $3 WHERE map_version_id = $1 AND building_id = $2', [map, from, to]);
        await db.query('DELETE FROM campus_buildings WHERE map_version_id = $1 AND building_id = $2', [map, from]);
      };
      for (const [i, f] of fixes.entries()) await move(f.from, tmp(i));
      for (const [i, f] of fixes.entries()) await move(tmp(i), f.id, f.name);
    });
    console.log(`Renamed ${fixes.length} building id(s) on map ${map}. Run scene:import so that the scene uses them.`);
  } else {
    console.log(`dry run: would rename ${fixes.map((f) => `${f.from} -> ${f.id}`).join(', ')} on map ${map}`);
  }
  for (const f of fixes) {
    const { rows: [left] } = await pool.query<{ roads: number; places: number; scene: number }>(
      `SELECT (SELECT count(*) FROM mobility.road_segments WHERE building_id = $1 AND status IN ('DRAFT', 'APPROVED')) roads,
              (SELECT count(*) FROM mobility.places WHERE building_id = $1 AND status <> 'RETIRED') places,
              (SELECT count(*) FROM scene_buildings b JOIN scene_versions v ON v.id = b.scene_version_id AND v.active WHERE b.building_id = $1) scene`,
      [f.from],
    );
    if (!fixes.some((g) => g.id === f.from) && (left.roads || left.places || left.scene)) {
      console.log(`still under the old id "${f.from}": ${left.roads} road(s), ${left.places} place(s) (rename them to "${f.id}" in the editor), ${left.scene} scene block(s) (scene:import)`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
