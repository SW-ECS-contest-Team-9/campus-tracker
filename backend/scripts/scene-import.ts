/**
 * Imports the rough campus 3D model (QGIS GeoPackage, layer buildings_3d) for the preview map and activates it.
 * docs/CAMPUS_3D_PREVIEW_PLAN.md
 *
 *   npm run scene:import -- --dir=/Users/hoshi/Desktop/skuniv_shp/campus_3d [--keep-absolute] [--dry-run]
 *
 * - Building heights (height_m, register or estimate) come from the GeoPackage. Base and roof are RECOMPUTED on
 *   the active terrain DEM (the one fusion uses) with the model's rules; --keep-absolute takes roof_m/base_m as given.
 * - Gates (abort, nothing activated): EPSG:5186, valid geometries, every building matches a campus_buildings
 *   footprint of the active campus map (IoU >= 0.99), all under the DEM, roof above and base below the ground.
 * - The source files are copied to backend/data/scene/source with their SHA-256 (SOURCES.json).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pool, withTransaction } from '../src/config/database.js';
import { readGpkgLayer, type Ring } from '../src/geo/gpkg.js';
import { terrain } from '../src/geo/terrain.js';
import { blockHeights, outlineSamples } from '../src/modules/scene/scene-heights.js';

const { values: args } = parseArgs({ options: { dir: { type: 'string' }, 'keep-absolute': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } } });
const DEST = path.resolve(import.meta.dirname, '../data/scene/source');
const FILES = ['campus.gpkg', 'building_heights.csv', 'validation.json', 'README.md', 'build_campus.py', 'campus_3d.qgz'];
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const r2 = (v: number) => Math.round(v * 100) / 100;

async function main() {
  if (!args.dir) throw new Error('--dir=<folder with campus.gpkg> is required');
  const gpkg = path.join(args.dir, 'campus.gpkg');
  if (!fs.existsSync(gpkg)) throw new Error(`${gpkg} not found`);
  const layer = readGpkgLayer(gpkg, 'buildings_3d');
  if (layer.srsId !== 5186) throw new Error(`buildings_3d must be EPSG:5186 (got ${layer.srsId})`);

  const terrainVersion = await terrain.activeVersion();
  const ctx = await terrain.context(terrainVersion);
  if (!ctx || !terrainVersion) throw new Error('No active terrain version (npm run terrain:import)');
  const { rows: mv } = await pool.query<{ id: string }>('SELECT id FROM spatial_map_versions WHERE active');
  if (!mv.length) throw new Error('No active campus map (npm run spatial:import)');
  const mapVersion = mv[0].id;
  const mode = args['keep-absolute'] ? 'ABSOLUTE' : 'RECOMPUTED';

  const problems: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const out: { buildingId: string; name: string | null; heightM: number; source: string; registerId: string | null; floors: number | null;
    baseM: number; roofM: number; tMin: number; tMax: number; srcBase: number | null; srcRoof: number | null; note: string | null; geojson: string }[] = [];
  const used = new Set<string>();
  for (const f of layer.features) {
    const p = f.properties as { name: string | null; height_m: number | null; height_source: string | null; register_id: string | null; ground_floors: number | null; base_m: number | null; roof_m: number | null; note: string | null };
    const g = f.geometry;
    if (!g || (g.type !== 'MultiPolygon' && g.type !== 'Polygon')) {
      problems.push(`fid ${f.fid}: not a polygon`);
      continue;
    }
    const polygons: Ring[][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const geojson = JSON.stringify({ type: 'MultiPolygon', coordinates: polygons });
    const { rows: m } = await pool.query<{ building_id: string; display: string | null; iou: number; valid: boolean; px: number; py: number }>(
      `WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 5186) g)
       SELECT b.building_id, md.display_name display, ST_Area(ST_Intersection(b.geom, g.g)) / NULLIF(ST_Area(ST_Union(b.geom, g.g)), 0) iou,
              ST_IsValid(g.g) valid, ST_X(ST_PointOnSurface(g.g)) px, ST_Y(ST_PointOnSurface(g.g)) py
         FROM g, campus_buildings b LEFT JOIN building_metadata md ON md.map_version_id = b.map_version_id AND md.building_id = b.building_id
        WHERE b.map_version_id = $2 AND ST_Intersects(b.geom, g.g) ORDER BY 3 DESC LIMIT 1`,
      [geojson, mapVersion],
    );
    const best = m[0];
    if (!best) {
      problems.push(`${p.name}: no campus building footprint`);
      continue;
    }
    if (!best.valid) problems.push(`${p.name}: invalid geometry`);
    if (best.iou < 0.99) problems.push(`${p.name}: footprint IoU ${best.iou.toFixed(3)} with ${best.building_id} < 0.99`);
    if (used.has(best.building_id)) problems.push(`${p.name}: ${best.building_id} matched twice`);
    used.add(best.building_id);
    if (!(typeof p.height_m === 'number' && p.height_m > 0)) problems.push(`${p.name}: height_m missing`);
    const samples = [...outlineSamples(polygons), [best.px, best.py] as [number, number]].map(([x, y]) => terrain.sampleXY(ctx, x, y)?.height ?? null);
    if (samples.some((s) => s === null)) {
      problems.push(`${p.name}: outside the terrain DEM`);
      continue;
    }
    const h = blockHeights(samples as number[], p.height_m ?? 0);
    const baseM = mode === 'ABSOLUTE' && p.base_m !== null ? p.base_m : h.baseM;
    const roofM = mode === 'ABSOLUTE' && p.roof_m !== null ? p.roof_m : h.roofM;
    if (!(baseM < h.terrainMinM)) problems.push(`${p.name}: base ${baseM} not below the ground ${h.terrainMinM}`);
    if (!(roofM > h.terrainMaxM)) problems.push(`${p.name}: roof ${roofM} not above the ground ${h.terrainMaxM}`);
    if (p.name && best.display && p.name !== best.display) problems.push(`${p.name}: building metadata calls ${best.building_id} "${best.display}"`);
    const note = [p.note, h.roofRaised && mode === 'RECOMPUTED' ? 'roof raised to DEM max + 3 m on the server DEM' : null].filter(Boolean).join('; ') || null;
    out.push({ buildingId: best.building_id, name: p.name, heightM: p.height_m ?? 0, source: p.height_source ?? 'ESTIMATE', registerId: p.register_id || null,
      floors: p.ground_floors, baseM, roofM, tMin: h.terrainMinM, tMax: h.terrainMaxM, srcBase: p.base_m, srcRoof: p.roof_m, note, geojson });
    rows.push({ name: p.name, building: best.building_id, iou: r2(best.iou), height: p.height_m, source: p.height_source, base: baseM, roof: roofM,
      'gpkg roof': p.roof_m, 'Δroof': p.roof_m === null ? '' : r2(roofM - p.roof_m), raised: h.roofRaised ? 'yes' : '' });
  }
  console.table(rows);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    throw new Error('Gates failed: nothing imported');
  }
  const gpkgSha = sha(gpkg);
  const id = `campus3d-${createHash('sha256').update(`${gpkgSha}#${terrainVersion}#${mapVersion}#${mode}`).digest('hex').slice(0, 8)}`;
  if (args['dry-run']) {
    console.log(`\ndry run: would activate ${id} (terrain ${terrainVersion}, map ${mapVersion}, ${mode})`);
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

  await withTransaction(async (client) => {
    await client.query('DELETE FROM scene_versions WHERE id = $1', [id]);
    await client.query('UPDATE scene_versions SET active = false WHERE active');
    await client.query(
      `INSERT INTO scene_versions (id, source_sha256, terrain_version_id, map_version_id, height_mode, active, metadata) VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [id, gpkgSha, terrainVersion, mapVersion, mode, JSON.stringify({ buildings: out.length, estimated: out.filter((b) => b.source !== 'REGISTER').length, rows })],
    );
    for (const b of out) {
      await client.query(
        `INSERT INTO scene_buildings (scene_version_id, building_id, name, height_m, height_source, register_id, ground_floors, base_m, roof_m,
           terrain_min_m, terrain_max_m, source_base_m, source_roof_m, note, geom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($15), 5186)))`,
        [id, b.buildingId, b.name, b.heightM, b.source, b.registerId, b.floors, b.baseM, b.roofM, b.tMin, b.tMax, b.srcBase, b.srcRoof, b.note, b.geojson],
      );
    }
  });
  console.log(`\nactivated ${id}: ${out.length} buildings on terrain ${terrainVersion} (${mode}). Reload the preview.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
