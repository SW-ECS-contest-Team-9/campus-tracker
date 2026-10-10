/**
 * Makes the QGIS campus 3D project show the same heights as the web preview (docs/CAMPUS_3D_PREVIEW_PLAN.md):
 *  1. terrain_dem_2m.tif  <- the server terrain DEM (the surface fusion and the preview use), as GeoTIFF EPSG:5186
 *  2. campus.gpkg buildings_3d base_m / roof_m / extrusion_m / terrain_min / terrain_max <- the active scene
 *     (recomputed on the server DEM by scene:import). height_m and its basis are not touched.
 * The original Codex files are kept once as *.codex.* next to them. Close the project in QGIS first.
 * Trajectories: add the PostGIS views in schema "qgis" (qgis.fused_positions, qgis.location_samples,
 * qgis.event_markers, qgis.scene_buildings, qgis.canonical_points) — their Z is MSL like the preview.
 *
 *   npm run qgis:sync -- --dir=/Users/hoshi/Desktop/skuniv_shp/campus_3d [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { pool } from '../src/config/database.js';
import { terrain } from '../src/geo/terrain.js';
import { registerGpkgFunctions } from '../src/geo/gpkg.js';

const { values: args } = parseArgs({ options: { dir: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });

function backupOnce(file: string, suffix: string) {
  const ext = path.extname(file);
  const backup = path.join(path.dirname(file), `${path.basename(file, ext)}.${suffix}${ext}`);
  if (!fs.existsSync(backup) && fs.existsSync(file)) fs.copyFileSync(file, backup);
  return backup;
}

async function main() {
  if (!args.dir) throw new Error('--dir=<QGIS campus_3d folder> is required');
  const gpkg = path.join(args.dir, 'campus.gpkg');
  const tif = path.join(args.dir, 'terrain_dem_2m.tif');
  if (!fs.existsSync(gpkg)) throw new Error(`${gpkg} not found`);

  const ctx = await terrain.context(await terrain.activeVersion());
  if (!ctx) throw new Error('No active terrain version');
  const { rows: buildings } = await pool.query<{ name: string; base_m: number; roof_m: number; terrain_min_m: number; terrain_max_m: number }>(
    `SELECT b.name, b.base_m, b.roof_m, b.terrain_min_m, b.terrain_max_m FROM scene_buildings b JOIN scene_versions v ON v.id = b.scene_version_id AND v.active`,
  );
  if (!buildings.length) throw new Error('No active campus scene (npm run scene:import)');
  // Buildings the scene overrides hide or split into parts have no row of their own name in the scene: their GeoPackage rows are left as they are.
  const { rows: [sv] } = await pool.query<{ metadata: { hiddenBuildings?: { name: string }[]; buildingParts?: { name: string }[] } | null }>('SELECT metadata FROM scene_versions WHERE active');
  const overridden = new Set([...(sv?.metadata?.hiddenBuildings ?? []), ...(sv?.metadata?.buildingParts ?? [])].map((o) => o.name));

  // 1. server DEM -> GeoTIFF (rows north to south; the stored grid's row 0 is the south edge)
  const g = ctx.grid;
  const rows: number[][] = [];
  for (let j = g.height - 1; j >= 0; j--) rows.push(Array.from(ctx.heights.subarray(j * g.width, (j + 1) * g.width), (v) => Math.round(v * 1000) / 1000));
  const client = await pool.connect();
  let geotiff: Buffer;
  try {
    await client.query(`SET postgis.gdal_enabled_drivers = 'GTiff'`);
    const { rows: r } = await client.query<{ tif: Buffer }>(
      `SELECT ST_AsGDALRaster(ST_SetValues(ST_AddBand(ST_MakeEmptyRaster($1::int, $2::int, $3::float8, $4::float8, $5::float8, -$5::float8, 0, 0, 5186),
                '32BF'::text, 0, -9999), 1, 1, 1, $6::float8[][]), 'GTiff', ARRAY['COMPRESS=DEFLATE']) AS tif`,
      [g.width, g.height, g.originX, g.originY + g.height * g.resolution, g.resolution, rows],
    );
    geotiff = r[0].tif;
  } finally {
    client.release();
  }

  // 2. building heights in the GeoPackage
  const db = new DatabaseSync(gpkg, { readOnly: args['dry-run'] });
  registerGpkgFunctions(db); // the GeoPackage R-tree triggers call SpatiaLite-style functions
  const current = db.prepare('SELECT name, base_m, roof_m FROM buildings_3d').all() as { name: string; base_m: number; roof_m: number }[];
  const table = current.map((c) => {
    const s = buildings.find((b) => b.name === c.name);
    return { name: c.name, 'base (gpkg)': c.base_m, 'base (server)': s?.base_m ?? '–', 'roof (gpkg)': c.roof_m, 'roof (server)': s?.roof_m ?? (overridden.has(c.name) ? 'hidden / split (kept)' : '–') };
  });
  console.table(table);
  const synced = buildings.filter((b) => current.some((c) => c.name === b.name)); // rows of parts carry the part's label, not a GeoPackage name
  const missing = current.filter((c) => !overridden.has(c.name) && !buildings.some((b) => b.name === c.name)).map((c) => c.name);
  if (missing.length) throw new Error(`Not in the active scene: ${missing.join(', ')} (run scene:import with this folder first)`);
  if (args['dry-run']) {
    db.close();
    console.log(`dry run: would write ${tif} (${(geotiff.length / 1024).toFixed(0)} KB, terrain ${ctx.versionId}) and update ${synced.length} buildings (${[...overridden].join(', ') || 'none'} left as they are: hidden or split by the scene overrides)`);
    return;
  }
  const gpkgBackup = backupOnce(gpkg, 'codex');
  const tifBackup = backupOnce(tif, 'codex');
  try {
    const update = db.prepare('UPDATE buildings_3d SET base_m = ?, roof_m = ?, extrusion_m = ?, terrain_min = ?, terrain_max = ? WHERE name = ?');
    db.exec('BEGIN');
    for (const b of synced) update.run(b.base_m, b.roof_m, Math.round((b.roof_m - b.base_m) * 1000) / 1000, b.terrain_min_m, b.terrain_max_m, b.name);
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw new Error(`Could not update ${gpkg} (is the project open in QGIS?): ${err instanceof Error ? err.message : err}`);
  } finally {
    db.close();
  }
  fs.writeFileSync(tif, geotiff);
  console.log(`\nwrote ${tif} = server DEM ${ctx.versionId} (${g.width}x${g.height}, ${g.resolution} m)`);
  console.log(`updated ${synced.length} buildings in ${gpkg}${overridden.size ? ` (${[...overridden].join(', ')} left as they are: hidden or split by the scene overrides)` : ''}`);
  console.log(`originals kept: ${path.basename(gpkgBackup)}, ${path.basename(tifBackup)}`);
  console.log('Trajectories in QGIS: add PostGIS layers from schema "qgis" (Z = MSL like the preview), 3D altitude clamping = Absolute.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
