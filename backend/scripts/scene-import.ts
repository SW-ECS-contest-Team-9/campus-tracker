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
 *   The same file can leave a GeoPackage building out of the scene ("hidden") or draw one footprint as several blocks
 *   with their own roofs ("parts": polygons that tile the footprint; the first part keeps the building id, the others
 *   get <id>#<part id>). --no-overrides (or no file) imports exactly the GeoPackage model, with the id it had before.
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
import { overrideHeights, parseSceneOverrides, partBuildingId, partsAreaProblem, polygonArea, sceneVersionId } from '../src/modules/scene/scene-overrides.js';

const { values: args } = parseArgs({ options: { dir: { type: 'string' }, 'keep-absolute': { type: 'boolean', default: false }, 'no-overrides': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } } });
const DEST = path.resolve(import.meta.dirname, '../data/scene/source');
const OVERRIDES = path.resolve(import.meta.dirname, '../data/scene/overrides/building-roofs.json');
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
  const all = args['no-overrides'] || !fs.existsSync(OVERRIDES) ? { roofs: [], hidden: [], parts: [] } : parseSceneOverrides(JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')));
  const overrides = all.roofs;
  const applied = overrides.length + all.hidden.length + all.parts.length;

  const problems: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const out: { buildingId: string; name: string | null; heightM: number; source: string; registerId: string | null; floors: number | null;
    baseM: number; roofM: number; tMin: number; tMax: number; srcBase: number | null; srcRoof: number | null; note: string | null; geojson: string }[] = [];
  const used = new Set<string>();
  for (const o of [...overrides, ...all.hidden, ...all.parts]) if (!layer.features.some((f) => f.properties.name === o.name)) problems.push(`override ${o.name}: no such building in buildings_3d`);
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
    let roofM = mode === 'ABSOLUTE' && p.roof_m !== null ? p.roof_m : h.roofM;
    let heightM = p.height_m ?? 0;
    const o = overrides.find((x) => x.name === p.name);
    if (o) {
      try {
        ({ heightM, roofM } = overrideHeights(samples as number[], h, o.roofM));
      } catch (err) {
        problems.push(`${p.name}: ${(err as Error).message}`);
      }
    }
    if (!(baseM < h.terrainMinM)) problems.push(`${p.name}: base ${baseM} not below the ground ${h.terrainMinM}`);
    if (!(roofM > h.terrainMaxM)) problems.push(`${p.name}: roof ${roofM} not above the ground ${h.terrainMaxM}`);
    if (p.name && best.display && p.name !== best.display) problems.push(`${p.name}: building metadata calls ${best.building_id} "${best.display}"`);
    const note = [p.note, h.roofRaised && mode === 'RECOMPUTED' && !o ? 'roof raised to DEM max + 3 m on the server DEM' : null,
      o ? `roof ${o.roofM} m from ${o.evidence.source} (${o.evidence.collectedOn}, ${o.evidence.independentSurvey ? 'independent survey' : 'not an independent survey'}); GeoPackage height ${p.height_m} m ${p.height_source}` : null].filter(Boolean).join('; ') || null;
    if (all.hidden.some((x) => x.name === p.name)) { // checked like any building of the model, but not drawn
      rows.push({ name: p.name, building: best.building_id, iou: r2(best.iou), source: 'hidden (override)' });
      continue;
    }
    const split = all.parts.find((x) => x.name === p.name);
    if (split) {
      const area = polygons.reduce((s, poly) => s + polygonArea(poly), 0);
      const bad = partsAreaProblem(split, area);
      if (bad) problems.push(bad);
      for (const [k, part] of split.parts.entries()) {
        const label = `${p.name} part ${part.id}`;
        const ring: Ring[][] = [part.polygon];
        const partJson = JSON.stringify({ type: 'MultiPolygon', coordinates: ring });
        const { rows: [q] } = await pool.query<{ valid: boolean; outside: number; px: number; py: number }>(
          `WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 5186) g, ST_SetSRID(ST_GeomFromGeoJSON($2), 5186) f)
           SELECT ST_IsValid(g) valid, ST_Area(ST_Difference(g, f)) outside, ST_X(ST_PointOnSurface(g)) px, ST_Y(ST_PointOnSurface(g)) py FROM g`,
          [partJson, geojson],
        );
        if (!q.valid) problems.push(`${label}: invalid geometry`);
        if (q.outside > 0.5) problems.push(`${label}: ${q.outside.toFixed(1)} m2 outside the footprint of ${p.name}`);
        const ps = [...outlineSamples(ring), [q.px, q.py] as [number, number]].map(([x, y]) => terrain.sampleXY(ctx, x, y)?.height ?? null);
        if (ps.some((s) => s === null)) {
          problems.push(`${label}: outside the terrain DEM`);
          continue;
        }
        const ph = blockHeights(ps as number[], 0); // base and ground under this part; the roof is the part's own
        let partHeight = 0;
        try {
          partHeight = overrideHeights(ps as number[], ph, part.roofM).heightM;
        } catch (err) {
          problems.push(`${label}: ${(err as Error).message}`);
        }
        const buildingId = partBuildingId(best.building_id, split.parts, k);
        out.push({ buildingId, name: part.name, heightM: partHeight, source: split.heightSource, registerId: p.register_id || null, floors: part.name ? split.floors ?? null : null,
          baseM: ph.baseM, roofM: part.roofM, tMin: ph.terrainMinM, tMax: ph.terrainMaxM, srcBase: p.base_m, srcRoof: p.roof_m, geojson: partJson,
          note: `part "${part.id}" of ${p.name} (${split.parts.length} parts); flat roof ${part.roofM} m from ${split.evidence.source} (${split.evidence.collectedOn}, ${split.evidence.independentSurvey ? 'independent survey' : 'not an independent survey'}); whole building in the GeoPackage: ${p.height_m} m ${p.height_source}, ${p.ground_floors ?? '?'} floors` });
        rows.push({ name: `${p.name} / ${part.id}`, building: buildingId, iou: k === 0 ? r2(best.iou) : '', height: partHeight, source: split.heightSource, base: ph.baseM, roof: part.roofM,
          'gpkg roof': p.roof_m, 'Δroof': p.roof_m === null ? '' : r2(part.roofM - p.roof_m), raised: '' });
      }
      continue;
    }
    out.push({ buildingId: best.building_id, name: p.name, heightM, source: o?.heightSource ?? p.height_source ?? 'ESTIMATE', registerId: p.register_id || null,
      floors: o ? o.floors ?? (p.height_source === 'REGISTER' ? p.ground_floors : null) : p.ground_floors, baseM, roofM, tMin: h.terrainMinM, tMax: h.terrainMaxM, srcBase: p.base_m, srcRoof: p.roof_m, note, geojson });
    rows.push({ name: p.name, building: best.building_id, iou: r2(best.iou), height: heightM, source: o?.heightSource ?? p.height_source, base: baseM, roof: roofM,
      'gpkg roof': p.roof_m, 'Δroof': p.roof_m === null ? '' : r2(roofM - p.roof_m), raised: h.roofRaised ? 'yes' : '' });
  }
  console.table(rows);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    throw new Error('Gates failed: nothing imported');
  }
  const gpkgSha = sha(gpkg);
  const id = sceneVersionId(gpkgSha, terrainVersion, mapVersion, mode, applied ? sha(OVERRIDES) : undefined);
  if (args['dry-run']) {
    console.log(`\ndry run: would activate ${id} (terrain ${terrainVersion}, map ${mapVersion}, ${mode}, roof overrides ${overrides.length}, hidden ${all.hidden.length}, split ${all.parts.length})`);
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
      [id, gpkgSha, terrainVersion, mapVersion, mode, JSON.stringify({ buildings: out.length, estimated: out.filter((b) => b.source !== 'REGISTER').length, rows, ...(overrides.length ? { roofOverrides: overrides } : {}),
        ...(all.hidden.length ? { hiddenBuildings: all.hidden } : {}), ...(all.parts.length ? { buildingParts: all.parts } : {}) })],
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
  console.log(`\nactivated ${id}: ${out.length} buildings on terrain ${terrainVersion} (${mode}, roof overrides ${overrides.length}, hidden ${all.hidden.length}, split ${all.parts.length}). Reload the preview.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
