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
import { buildingIdRenamePlan, renameBuildingIds } from '../src/modules/spatial/building-ids-rename.js';

const FILE = path.resolve(import.meta.dirname, '../data/campus-map/overrides/building-ids.json');
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const fixes = parseBuildingIdFixes(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  const { map, have, state } = await buildingIdRenamePlan(pool, fixes);
  console.table(fixes.map((f) => ({ feature: f.feature, from: f.from, to: f.id, 'area of from (m2)': have.get(f.from) ?? '', state: state === 'done' ? 'already renamed' : 'to rename' })));
  if (state === 'done') {
    console.log('Nothing to do: the active map already has the corrected ids.');
  } else if (state === 'half') {
    throw new Error(`Half-renamed building ids on map ${map}: neither the file's ids nor the corrected ones`);
  } else if (!dryRun) {
    await withTransaction((db) => renameBuildingIds(db, map, fixes));
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
