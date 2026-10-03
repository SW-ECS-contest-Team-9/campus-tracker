/**
 * Builds the campus terrain DEM (absolute height reference) from backend/data/terrain/source and activates it.
 * Also loads building metadata (building register + university campus map) for the active campus map.
 *
 *   npm run terrain:import [-- --resolution=2 --buffer=300]
 *
 * Quality gates (the import aborts instead of activating a doubtful DEM):
 *  - datum transform: Korean 1985 (Bessel) -> Korea 2000 through PostGIS must match the 7-parameter Helmert
 *    within 0.1 m at the campus (a missing datum shift would silently move everything by ~300 m)
 *  - spot heights vs the contour-only surface: |median| <= 2.5 m (half the 5 m interval), p90 |r| <= 5 m
 *  - building alignment: contours (broken at buildings in city maps) must cross building footprints least at zero shift
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pool, withTransaction } from '../src/config/database.js';
import { buildDem, rasterizePolygon, type ContourRun, type Grid } from '../src/geo/dem.js';

const { values: args } = parseArgs({ options: { resolution: { type: 'string', default: '2' }, buffer: { type: 'string', default: '300' } } });
const SRC = path.resolve(import.meta.dirname, '../data/terrain/source');
const HELMERT_5174 = '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43 +units=m +no_defs';
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};
const r2 = (v: number) => Math.round(v * 100) / 100;

async function transform5174(wkts: string[]): Promise<[number, number][][]> {
  const out: [number, number][][] = [];
  for (let i = 0; i < wkts.length; i += 500) {
    const { rows } = await pool.query<{ g: string }>(
      `SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText(w), 5174), 5186), 4) g
         FROM unnest($1::text[]) WITH ORDINALITY AS t(w, i) ORDER BY i`,
      [wkts.slice(i, i + 500)],
    );
    for (const r of rows) {
      const g = JSON.parse(r.g);
      out.push(g.type === 'Point' ? [g.coordinates] : g.coordinates);
    }
  }
  return out;
}

function geoidAt(lat: number, lon: number): number {
  const nodes: [number, number, number][] = read('kngeoid18_clip.json').nodes;
  const lats = [...new Set(nodes.map((n) => n[0]))].sort((a, b) => a - b);
  const lons = [...new Set(nodes.map((n) => n[1]))].sort((a, b) => a - b);
  const value = new Map(nodes.map((n) => [`${n[0]},${n[1]}`, n[2]]));
  const i = lats.findIndex((v, k) => v <= lat && lats[k + 1] > lat);
  const j = lons.findIndex((v, k) => v <= lon && lons[k + 1] > lon);
  if (i < 0 || j < 0) throw new Error('KNGeoid18 clip does not cover the campus');
  const t = (lat - lats[i]) / (lats[i + 1] - lats[i]);
  const u = (lon - lons[j]) / (lons[j + 1] - lons[j]);
  const at = (a: number, b: number) => value.get(`${lats[a]},${lons[b]}`)!;
  return at(i, j) * (1 - t) * (1 - u) + at(i + 1, j) * t * (1 - u) + at(i, j + 1) * (1 - t) * u + at(i + 1, j + 1) * t * u;
}

async function main() {
  const resolution = Number(args.resolution);
  const buffer = Number(args.buffer);
  const sourceHash = createHash('sha256');
  for (const f of fs.readdirSync(SRC).sort()) sourceHash.update(f).update(fs.readFileSync(path.join(SRC, f)));
  const sha = sourceHash.digest('hex');

  const { rows: camp } = await pool.query<{ mapVersionId: string; xmin: number; ymin: number; xmax: number; ymax: number; lat: number; lon: number; cx: number; cy: number }>(
    `SELECT a.map_version_id "mapVersionId", ST_XMin(a.geom) xmin, ST_YMin(a.geom) ymin, ST_XMax(a.geom) xmax, ST_YMax(a.geom) ymax,
            ST_Y(ST_Transform(ST_Centroid(a.geom), 4326)) lat, ST_X(ST_Transform(ST_Centroid(a.geom), 4326)) lon,
            ST_X(ST_Centroid(a.geom)) cx, ST_Y(ST_Centroid(a.geom)) cy
       FROM campus_areas a JOIN spatial_map_versions v ON v.id = a.map_version_id AND v.active`,
  );
  if (!camp.length) throw new Error('No active campus map');
  const c = camp[0];

  // ---- gate 1: datum transform ----
  const { rows: ctl } = await pool.query<{ d: number }>(
    `SELECT ST_Distance(ST_Transform(ST_Transform(p, 5174), 5186), ST_Transform(ST_Transform(p, $1::text), $1::text, 5186)) d
       FROM (SELECT ST_SetSRID(ST_MakePoint($2, $3), 5186) p) q`,
    [HELMERT_5174, c.cx, c.cy],
  );
  const { rows: noShift } = await pool.query<{ d: number }>(
    `SELECT ST_Distance(ST_Transform(p, 5174),
              ST_SetSRID(ST_Transform(p, '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=0,0,0 +units=m +no_defs'), 5174)) d
       FROM (SELECT ST_SetSRID(ST_MakePoint($1, $2), 5186) p) q`,
    [c.cx, c.cy],
  );
  console.log(`datum transform check: PostGIS vs Helmert ${r2(ctl[0].d)} m (no datum shift would be ${Math.round(noShift[0].d)} m)`);
  if (!(ctl[0].d <= 0.1)) throw new Error('Datum transform check failed: EPSG:5174 -> 5186 does not apply the Korean 1985 datum shift');

  // ---- sources -> EPSG:5186 ----
  const contoursSrc: { height: number; kind: string; runs: [number, number][][] }[] = read('contours_5174.json').features;
  const runsMeta = contoursSrc.flatMap((f) => f.runs.map((run) => ({ height: f.height, run })));
  const runs5186 = await transform5174(runsMeta.map((m) => `LINESTRING(${m.run.map((p) => `${p[0]} ${p[1]}`).join(',')})`));
  const contours: ContourRun[] = runsMeta.map((m, i) => ({ height: m.height, points: runs5186[i] }));
  const spotsSrc: { height: number; x: number; y: number }[] = read('spots_5174.json').features;
  const spots5186 = await transform5174(spotsSrc.map((s) => `POINT(${s.x} ${s.y})`));
  const spots = spotsSrc.map((s, i) => ({ height: s.height, x: spots5186[i][0][0], y: spots5186[i][0][1] }));

  // ---- DEM ----
  const grid: Grid = {
    originX: Math.floor((c.xmin - buffer) / resolution) * resolution,
    originY: Math.floor((c.ymin - buffer) / resolution) * resolution,
    resolution,
    width: Math.ceil((c.xmax - c.xmin + 2 * buffer) / resolution) + 1,
    height: Math.ceil((c.ymax - c.ymin + 2 * buffer) / resolution) + 1,
  };
  const dem = buildDem(grid, contours, spots);
  const res = dem.spotResiduals;
  const loo = dem.spotLooResiduals;
  const spotQa = { count: res.length, median: r2(pct(res, 0.5)), p90Abs: r2(pct(res.map(Math.abs), 0.9)), correctedLooMedian: r2(pct(loo, 0.5)), correctedLooP90Abs: r2(pct(loo.map(Math.abs), 0.9)) };
  console.log(`DEM ${grid.width}x${grid.height} @ ${resolution} m, levels ${dem.levels[0]}-${dem.levels.at(-1)} m; spot residuals (contours only) median ${spotQa.median} m, p90 |r| ${spotQa.p90Abs} m; after spot correction (leave-one-out) median ${spotQa.correctedLooMedian} m, p90 |r| ${spotQa.correctedLooP90Abs} m (n=${spotQa.count})`);
  // gross-error gate (half a contour interval): a misaligned or wrongly transformed source fails by tens of meters
  if (Math.abs(spotQa.median) > 2.5 || spotQa.p90Abs > 5) throw new Error('Spot-height gate failed');

  // ---- gate 3: alignment with the campus building map + buildings crossed by contours ----
  const multi = `MULTILINESTRING(${contours.map((r) => `(${r.points.map((p) => `${p[0]} ${p[1]}`).join(',')})`).join(',')})`;
  const { rows: align } = await pool.query<{ dx: number; dy: number; share: number }>(
    `WITH c AS (SELECT ST_SetSRID(ST_GeomFromText($1), 5186) g),
          b AS (SELECT ST_Union(geom) g FROM campus_buildings WHERE map_version_id = $2),
          a AS (SELECT geom g FROM campus_areas WHERE map_version_id = $2)
     SELECT s.dx, s.dy, ST_Length(ST_Intersection(ST_Translate(c.g, s.dx, s.dy), b.g)) / NULLIF(ST_Length(ST_Intersection(c.g, ST_Buffer(a.g, 100))), 0) share
       FROM c, b, a, (VALUES (0, 0), (10, 0), (-10, 0), (0, 10), (0, -10)) s(dx, dy)`,
    [multi, c.mapVersionId],
  );
  const zero = align.find((a) => a.dx === 0 && a.dy === 0)!.share;
  console.log(`building alignment: contour share inside buildings ${align.map((a) => `(${a.dx},${a.dy}) ${(a.share * 100).toFixed(1)}%`).join('  ')}`);
  if (align.some((a) => a.share < zero)) throw new Error('Alignment gate failed: a shifted DEM fits the building map better');
  const { rows: crossed } = await pool.query<{ buildingId: string; name: string | null; levels: number[]; rings: string }>(
    `SELECT b.building_id "buildingId", b.building_name name, ST_AsGeoJSON(b.geom) rings,
            array_agg(DISTINCT r.h ORDER BY r.h) levels
       FROM campus_buildings b
       JOIN (SELECT h, ST_SetSRID(ST_GeomFromText(w), 5186) g FROM unnest($1::float8[], $2::text[]) t(h, w)) r ON ST_Intersects(b.geom, r.g)
      WHERE b.map_version_id = $3 GROUP BY b.building_id, b.building_name, b.geom`,
    [contours.map((r) => r.height), contours.map((r) => `LINESTRING(${r.points.map((p) => `${p[0]} ${p[1]}`).join(',')})`), c.mapVersionId],
  );
  const modified = new Uint8Array(grid.width * grid.height);
  for (const b of crossed) {
    for (const poly of JSON.parse(b.rings).coordinates) {
      const m = rasterizePolygon(grid, poly, 5);
      for (let i = 0; i < m.length; i++) if (m[i]) modified[i] = 1;
    }
  }
  for (let i = 0; i < modified.length; i++) {
    if (dem.slope[i] > 1) modified[i] = 1; // > 45 deg: cut slopes / retaining walls, contours bunched
    if (modified[i]) dem.sigma[i] *= 2;
  }
  console.log(`terrain likely modified since the survey (contours cross the footprint): ${crossed.map((b) => `${b.name ?? b.buildingId} ${b.levels[0]}-${b.levels.at(-1)} m`).join(', ') || 'none'}`);

  // ---- geoid ----
  const geoid = geoidAt(c.lat, c.lon);
  console.log(`KNGeoid18 N at the campus: ${r2(geoid)} m`);

  // ---- store ----
  const id = `seoul5000-2015-${sha.slice(0, 8)}`;
  const metadata = {
    sources: read('SOURCES.json'),
    qa: { datumCheckM: r2(ctl[0].d), withoutDatumShiftM: Math.round(noShift[0].d), spotResiduals: spotQa, alignment: align, contourLevels: dem.levels },
    modifiedBuildings: crossed.map((b) => ({ buildingId: b.buildingId, name: b.name, contourLevels: b.levels })),
    surveyYear: 2015,
  };
  await withTransaction(async (db) => {
    await db.query('UPDATE terrain_versions SET active = false WHERE active');
    await db.query(
      `INSERT INTO terrain_versions (id, source_sha256, srid, vertical_datum, geoid_separation_m, geoid_source, origin_x, origin_y,
                                     resolution_m, width, height, heights, sigma, modified_mask, active, metadata)
       VALUES ($1, $2, 5186, 'KVD_INCHEON_MSL', $3, 'KNGeoid18', $4, $5, $6, $7, $8, $9, $10, $11, true, $12::jsonb)
       ON CONFLICT (id) DO UPDATE SET source_sha256 = EXCLUDED.source_sha256, geoid_separation_m = EXCLUDED.geoid_separation_m,
         origin_x = EXCLUDED.origin_x, origin_y = EXCLUDED.origin_y, resolution_m = EXCLUDED.resolution_m, width = EXCLUDED.width,
         height = EXCLUDED.height, heights = EXCLUDED.heights, sigma = EXCLUDED.sigma, modified_mask = EXCLUDED.modified_mask,
         active = true, imported_at = now(), metadata = EXCLUDED.metadata`,
      [id, sha, geoid, grid.originX, grid.originY, resolution, grid.width, grid.height,
        Buffer.from(dem.heights.buffer), Buffer.from(dem.sigma.buffer), Buffer.from(modified.buffer), JSON.stringify(metadata)],
    );

    // ---- building metadata: register footprint with the best overlap, campus-map entry whose point is inside ----
    const register: { attributes: Record<string, string>; rings: [number, number][][] }[] = read('buildings_al_d010.json').features;
    const { rows: matches } = await db.query<{ buildingId: string; name: string | null; k: number; iou: number }>(
      `WITH r AS (SELECT k, ST_MakeValid(ST_SetSRID(ST_GeomFromText(w), 5186)) g FROM unnest($1::text[]) WITH ORDINALITY t(w, k))
       SELECT DISTINCT ON (b.building_id) b.building_id "buildingId", b.building_name name, r.k::int k,
              ST_Area(ST_Intersection(b.geom, r.g)) / ST_Area(ST_Union(b.geom, r.g)) iou
         FROM campus_buildings b JOIN r ON ST_Intersects(b.geom, r.g)
        WHERE b.map_version_id = $2
        ORDER BY b.building_id, iou DESC`,
      [register.map((f) => `POLYGON(${f.rings.map((ring) => `(${ring.map((p) => `${p[0]} ${p[1]}`).join(',')})`).join(',')})`), c.mapVersionId],
    );
    const campusMap: { 건물명: string; 위도: string; 경도: string }[] = read('skuniv_buildings.json');
    const places: { 건물: string; 층: string }[] = read('skuniv_places.json');
    // each campus-map entry belongs to the nearest footprint (within 3 m), never to two buildings
    const { rows: pointHits } = await db.query<{ buildingId: string; name: string }>(
      `SELECT DISTINCT ON (t.name) b.building_id "buildingId", t.name
         FROM unnest($1::text[], $2::float8[], $3::float8[]) t(name, lat, lon)
         JOIN campus_buildings b ON b.map_version_id = $4
          AND ST_DWithin(b.geom, ST_Transform(ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326), 5186), CASE WHEN b.building_name = t.name THEN 30 ELSE 3 END)
        ORDER BY t.name, (b.building_name = t.name) DESC NULLS LAST, ST_Distance(b.geom, ST_Transform(ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326), 5186))`,
      [campusMap.map((m) => m.건물명), campusMap.map((m) => Number(m.위도)), campusMap.map((m) => Number(m.경도)), c.mapVersionId],
    );
    const { rows: all } = await db.query<{ buildingId: string; name: string | null }>(
      'SELECT building_id "buildingId", building_name name FROM campus_buildings WHERE map_version_id = $1 ORDER BY building_id', [c.mapVersionId],
    );
    await db.query('DELETE FROM building_metadata WHERE map_version_id = $1', [c.mapVersionId]);
    const campusNames = new Set(campusMap.map((x) => x.건물명));
    const num = (v: string | undefined) => (v === undefined || v === '' || Number(v) === 0 ? null : Number(v));
    const rowsOut = all.map((b) => {
      const m = matches.find((x) => x.buildingId === b.buildingId && x.iou >= 0.5);
      const a = m ? register[m.k - 1].attributes : null;
      const registerName = a ? (/\(([^)]+)\)/.exec(a.dongName || a.name)?.[1] ?? (a.dongName || a.name || null)) : null;
      return { b, m, a, registerName, hits: pointHits.filter((h) => h.buildingId === b.buildingId).map((h) => h.name), names: [] as string[], display: null as string | null };
    });
    // 1) the register's own name claims a university campus-map name (e.g. "J동(혜인관)" -> 혜인관)
    const claimed = new Set<string>();
    for (const r of rowsOut) if (r.registerName && campusNames.has(r.registerName)) { r.display = r.registerName; r.names = [r.registerName]; claimed.add(r.registerName); }
    // 2) otherwise the campus-map entries located on the footprint that nobody claimed, then register / map names
    for (const r of rowsOut) {
      if (r.display) continue;
      const free = r.hits.filter((h) => !claimed.has(h));
      r.names = free;
      r.display = (free.length === 1 ? free[0] : null) ?? r.registerName ?? r.b.name ?? free[0] ?? null;
    }
    console.log('building metadata:');
    for (const { b, m, a, display, names } of rowsOut) {
      const entry = campusMap.find((x) => x.건물명 === display) ?? campusMap.find((x) => names.includes(x.건물명));
      const floors = [...new Set(places.filter((p) => names.includes(p.건물) && p.층).map((p) => p.층.trim()))];
      await db.query(
        `INSERT INTO building_metadata (map_version_id, building_id, display_name, register_label, register_use, register_ground_floors,
            register_underground_floors, register_height_m, register_approved_on, register_source_id, campus_floor_labels,
            campus_latitude, campus_longitude, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
        [c.mapVersionId, b.buildingId, display, a ? [a.name, a.dongName].filter(Boolean).join(' ') || null : null, a?.use || null,
          a ? num(a.groundFloors) : null, a ? num(a.undergroundFloors) ?? (num(a.groundFloors) ? 0 : null) : null, a ? num(a.heightM) : null,
          a?.approvedOn || null, a?.sourceId || null, floors, entry ? Number(entry.위도) : null, entry ? Number(entry.경도) : null,
          JSON.stringify({ campusMapFileName: b.name, campusMapEntries: names, registerIoU: m ? r2(m.iou) : null })],
      );
      const reg = a && num(a.groundFloors) ? `${[a.name, a.dongName].filter(Boolean).join(' ')} ${a.groundFloors}F/B${a.undergroundFloors} ${r2(Number(a.heightM))} m` : '-';
      console.log(`  ${(display ?? b.buildingId).padEnd(6)} file=${(b.name ?? '-').padEnd(4)} register=${reg}  campus-map=${names.join('/') || '-'} floors=[${floors.join(', ')}]`);
    }
  });
  console.log(`activated terrain version ${id}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
