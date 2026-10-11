export interface TerrainVersionGrid {
  srid: number; verticalDatum: string; geoidSeparationM: number;
  originX: number; originY: number; resolutionM: number; width: number; height: number;
}

/** Fields in which two terrain versions differ. Switching the active version is only safe when this is empty:
 * roads, sessions and the scene were built on the same grid extent, vertical datum and geoid separation.
 */
export function gridDifferences(a: TerrainVersionGrid, b: TerrainVersionGrid): string[] {
  const keys: (keyof TerrainVersionGrid)[] = ['srid', 'verticalDatum', 'geoidSeparationM', 'originX', 'originY', 'resolutionM', 'width', 'height'];
  return keys.filter((k) => a[k] !== b[k]);
}

export const TERRAIN_GRID_COLUMNS = `srid, vertical_datum "verticalDatum", geoid_separation_m::float8 "geoidSeparationM", origin_x "originX", origin_y "originY",
  resolution_m::float8 "resolutionM", width, height`;

/** Switches the active terrain version inside the caller's transaction. Refuses an unknown id and a version whose grid,
 * datum or geoid differs from the active one. Never changes heights, buildings or roads.
 */
export async function activateTerrainVersion(db: import('pg').PoolClient, id: string): Promise<{ previous: string | null; unchanged: boolean }> {
  const { rows } = await db.query<TerrainVersionGrid & { id: string; active: boolean }>(
    `SELECT id, active, ${TERRAIN_GRID_COLUMNS} FROM terrain_versions WHERE id = $1 OR active FOR UPDATE`, [id]);
  const target = rows.find((r) => r.id === id);
  const previous = rows.find((r) => r.active);
  if (!target) throw new Error(`Unknown terrain version: ${id}`);
  if (target.active) return { previous: id, unchanged: true };
  const diff = previous ? gridDifferences(previous, target) : [];
  if (diff.length) throw new Error(`Refused: ${id} differs from the active version ${previous!.id} in ${diff.join(', ')}`);
  // same order as terrain-import.ts: clear the flag first (unique partial index terrain_one_active_idx)
  await db.query('UPDATE terrain_versions SET active = false WHERE active');
  await db.query('UPDATE terrain_versions SET active = true WHERE id = $1', [id]);
  return { previous: previous?.id ?? null, unchanged: false };
}
