// Brings campus_buildings / building_metadata of the active map in line with the building id corrections without
// re-importing the campus map. Used by scripts/building-ids-rename.ts and by the deploy reconcile (src/deploy).
import type { PoolClient } from 'pg';
import type { DbClient } from '../../config/database.js';
import type { BuildingIdFix } from './building-ids.js';

/** done = the map already has the corrected ids; fresh = it has the file's ids (to rename); half = neither (refuse). */
export function renameState(have: Set<string>, fixes: BuildingIdFix[]): 'done' | 'fresh' | 'half' {
  const olds = new Set(fixes.map((f) => f.from));
  // A fix is done when its old id is gone or has been taken over by another fix; all must be in the same state.
  const done = fixes.every((f) => have.has(f.id)) && fixes.every((f) => !have.has(f.from) || fixes.some((g) => g.id === f.from));
  const fresh = fixes.every((f) => have.has(f.from)) && fixes.every((f) => !have.has(f.id) || olds.has(f.id));
  return fresh ? 'fresh' : done ? 'done' : 'half';
}

export async function buildingIdRenamePlan(db: DbClient, fixes: BuildingIdFix[]) {
  const { rows: mv } = await db.query<{ id: string }>('SELECT id FROM spatial_map_versions WHERE active');
  if (!mv.length) throw new Error('No active campus map (npm run spatial:import)');
  const map = mv[0].id;
  const { rows } = await db.query<{ building_id: string; area: number }>('SELECT building_id, round(ST_Area(geom)) area FROM campus_buildings WHERE map_version_id = $1', [map]);
  const have = new Map(rows.map((r) => [r.building_id, r.area]));
  return { map, have, state: fixes.length ? renameState(new Set(have.keys()), fixes) : 'done' as const };
}

/** Both phases in one transaction (the caller's), so two footprints can swap ids. */
export async function renameBuildingIds(db: PoolClient, map: string, fixes: BuildingIdFix[]) {
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
}
