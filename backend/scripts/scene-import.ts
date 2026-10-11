/**
 * Imports the rough campus 3D model (QGIS GeoPackage, layer buildings_3d) for the preview map and activates it.
 * docs/CAMPUS_3D_PREVIEW_PLAN.md
 *
 *   npm run scene:import -- --dir=/Users/hoshi/Desktop/skuniv_shp/campus_3d [--keep-absolute] [--no-overrides] [--dry-run]
 *
 * - Building heights (height_m, register or estimate) come from the GeoPackage. Base and roof are RECOMPUTED on
 *   the active terrain DEM (the one fusion uses) with the model's rules; --keep-absolute takes roof_m/base_m as given.
 * - Gates (abort, nothing activated): EPSG:5186, valid geometries, every building matches a campus_buildings
 *   footprint of the active campus map (IoU >= 0.99), all under the DEM, roof above and base below the ground.
 * - Roof overrides (data/scene/overrides/building-roofs.json): a listed building takes the given roof elevation and
 *   height source instead of the GeoPackage height; the base is unchanged. They give the scene another version id.
 *   An override may state the floor count ("floors"); without it only a register count is kept (an assumed one is dropped).
 *   One that states "terrace" may have its roof below the highest ground on the outline (above the median), like a terrace part.
 *   The same file can leave a GeoPackage building out of the scene ("hidden") or draw one footprint as several blocks
 *   with their own roofs ("parts": polygons that tile the footprint; the first part keeps the building id, the others
 *   get <id>#<part id>). A split that states "uncovered" may leave part of the footprint undrawn (parts inside it, no
 *   overlaps); a part that states "terrace" may have its roof below the highest ground on its outline (above the median).
 *   "added" puts a building on the map that is in neither the GeoPackage nor the campus map (its own outline, id, name and
 *   roof): scene only, so campus_buildings, building_metadata and the terrain model's buildingAt do not know it. Its id
 *   must not be a campus map building id and its outline must not overlap a campus map footprint; base = lowest ground - 1 m.
 *   --no-overrides (or no file) imports exactly the GeoPackage model, with the id it had before.
 * - The source files are copied to backend/data/scene/source with their SHA-256 (SOURCES.json).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { planSceneImport } from '../src/modules/scene/scene-import.js';

const { values: args } = parseArgs({ options: { dir: { type: 'string' }, 'keep-absolute': { type: 'boolean', default: false }, 'no-overrides': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } } });
const DEST = path.resolve(import.meta.dirname, '../data/scene/source');
const OVERRIDES = path.resolve(import.meta.dirname, '../data/scene/overrides/building-roofs.json');
const FILES = ['campus.gpkg', 'building_heights.csv', 'validation.json', 'README.md', 'build_campus.py', 'campus_3d.qgz'];
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function main() {
  if (!args.dir) throw new Error('--dir=<folder with campus.gpkg> is required');
  const plan = await planSceneImport({ dir: args.dir, overridesFile: args['no-overrides'] ? null : OVERRIDES, keepAbsolute: args['keep-absolute'], table: true });
  if (args['dry-run']) {
    console.log(`\ndry run: would activate ${plan.id} (${plan.summary})`);
    return;
  }

  fs.mkdirSync(DEST, { recursive: true });
  const sources: Record<string, string> = {};
  for (const name of FILES) {
    const src = path.join(args.dir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(DEST, name));
    sources[name] = sha(src);
  }
  fs.writeFileSync(path.join(DEST, 'SOURCES.json'), JSON.stringify({ importedFrom: args.dir, importedAt: new Date().toISOString(), sha256: sources }, null, 2));

  await plan.save();
  console.log(`\nactivated ${plan.id}: ${plan.buildings} buildings (${plan.summary}). Reload the preview.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
