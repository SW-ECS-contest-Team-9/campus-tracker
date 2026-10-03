/**
 * Cuts the campus area out of the large national / city source files into backend/data/terrain/source
 * (small, versionable). Run once per new source delivery; terrain:import then builds the DEM from these files.
 *
 *   npm run terrain:extract -- \
 *     --contours="/Users/hoshi/Downloads/서울시 경사도/등고선 5000" \
 *     --spots="/Users/hoshi/Downloads/서울시 경사도/표고 5000" \
 *     --geoid=/Users/hoshi/Downloads/KNGeoid18/KNGeoid18.dat \
 *     --buildings=/Users/hoshi/Downloads/AL_D010_11_20260909 \
 *     [--campus-map=<dir with skuniv_buildings.json / skuniv_places.json>] [--buffer=400]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pool } from '../src/config/database.js';
import { DbfReader, readShp, type Point2 } from '../src/geo/shapefile.js';

const { values: args } = parseArgs({
  options: {
    contours: { type: 'string' },
    spots: { type: 'string' },
    geoid: { type: 'string' },
    buildings: { type: 'string' },
    'campus-map': { type: 'string' },
    buffer: { type: 'string', default: '400' },
  },
});
const OUT = path.resolve(import.meta.dirname, '../data/terrain/source');
const BELT_1985 = 'Korean_1985_Modified_Korea_Central_Belt';

function only(dir: string, ext: string) {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext));
  if (files.length !== 1) throw new Error(`${dir}: expected exactly one *${ext}, found ${files.length}`);
  return path.join(dir, files[0]);
}

function sha256(file: string) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 << 20);
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

type Box = [number, number, number, number];
const intersects = (a: Box, b: Box) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
const inside = (p: Point2, b: Box) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** Keeps the vertices inside the box (plus one neighbour on each side); every kept stretch is its own run. */
function clipRuns(parts: Point2[][], box: Box): Point2[][] {
  const runs: Point2[][] = [];
  for (const part of parts) {
    let run: Point2[] = [];
    part.forEach((p, k) => {
      if (inside(p, box) || (k > 0 && inside(part[k - 1], box)) || (k + 1 < part.length && inside(part[k + 1], box))) run.push(p);
      else if (run.length) {
        if (run.length >= 2) runs.push(run);
        run = [];
      }
    });
    if (run.length >= 2) runs.push(run);
  }
  return runs;
}

const round = (p: Point2): Point2 => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];

async function main() {
  for (const k of ['contours', 'spots', 'geoid', 'buildings'] as const) if (!args[k]) throw new Error(`--${k} is required`);
  const buffer = Number(args.buffer);
  fs.mkdirSync(OUT, { recursive: true });

  // campus extent (EPSG:5186) and the same extent in the Bessel belt of the topographic map (EPSG:5174)
  const { rows } = await pool.query<{ b5186: string; b5174: string }>(
    `SELECT ST_AsText(ST_Envelope(ST_Expand(ST_Envelope(a.geom), $1))) b5186,
            ST_AsText(ST_Envelope(ST_Transform(ST_Expand(ST_Envelope(a.geom), $1 + 50), 5174))) b5174
       FROM campus_areas a JOIN spatial_map_versions v ON v.id = a.map_version_id AND v.active`,
    [buffer],
  );
  if (!rows.length) throw new Error('No active campus map (run spatial:import first)');
  const box = (wkt: string): Box => {
    const n = wkt.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const xs = n.filter((_, i) => i % 2 === 0);
    const ys = n.filter((_, i) => i % 2 === 1);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const box5186 = box(rows[0].b5186);
  const box5174 = box(rows[0].b5174);
  const sources: Record<string, unknown> = {};

  // ---- contours (PolyLine, CONT = height) ----
  {
    const shp = only(args.contours!, '.shp');
    const prj = fs.readFileSync(only(args.contours!, '.prj'), 'utf8');
    if (!prj.includes(BELT_1985)) throw new Error(`Contours: expected ${BELT_1985} (EPSG:5174), got ${prj.slice(0, 80)}`);
    const dbf = new DbfReader(only(args.contours!, '.dbf'));
    const out: { height: number; kind: string; runs: Point2[][] }[] = [];
    for (const r of readShp(shp, (b) => intersects(b, box5174))) {
      const a = dbf.record(r.index);
      const runs = clipRuns(r.parts, box5174);
      if (runs.length) out.push({ height: Number(a.CONT), kind: a.DIVI, runs: runs.map((run) => run.map(round)) });
    }
    dbf.close();
    fs.writeFileSync(path.join(OUT, 'contours_5174.json'), JSON.stringify({ srid: 5174, extent: box5174, features: out }));
    sources.contours = { file: path.basename(shp), sha256: sha256(shp), dbfSha256: sha256(only(args.contours!, '.dbf')), features: out.length };
    console.log(`contours: ${out.length} features, ${out.reduce((n, f) => n + f.runs.reduce((m, r) => m + r.length, 0), 0)} vertices`);
  }

  // ---- spot heights (Point, NUME = height) ----
  {
    const shp = only(args.spots!, '.shp');
    const prj = fs.readFileSync(only(args.spots!, '.prj'), 'utf8');
    if (!prj.includes(BELT_1985)) throw new Error(`Spot heights: expected ${BELT_1985} (EPSG:5174)`);
    const dbf = new DbfReader(only(args.spots!, '.dbf'));
    const out: { height: number; x: number; y: number }[] = [];
    for (const r of readShp(shp, (b) => intersects(b, box5174))) {
      const p = round(r.parts[0][0]);
      out.push({ height: Number(dbf.record(r.index).NUME), x: p[0], y: p[1] });
    }
    dbf.close();
    fs.writeFileSync(path.join(OUT, 'spots_5174.json'), JSON.stringify({ srid: 5174, extent: box5174, features: out }));
    sources.spots = { file: path.basename(shp), sha256: sha256(shp), dbfSha256: sha256(only(args.spots!, '.dbf')), features: out.length };
    console.log(`spot heights: ${out.length}`);
  }

  // ---- KNGeoid18 (text grid: latitude longitude N) around the campus ----
  {
    const { rows: c } = await pool.query<{ lat: number; lon: number }>(
      `SELECT ST_Y(p) lat, ST_X(p) lon FROM (SELECT ST_Transform(ST_Centroid(a.geom), 4326) p
         FROM campus_areas a JOIN spatial_map_versions v ON v.id = a.map_version_id AND v.active) q`,
    );
    const nodes: [number, number, number][] = [];
    for (const line of fs.readFileSync(args.geoid!, 'utf8').split('\n')) {
      const [lat, lon, n] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(n) && Math.abs(lat - c[0].lat) <= 0.05 && Math.abs(lon - c[0].lon) <= 0.05) nodes.push([lat, lon, n]);
    }
    if (nodes.length < 4) throw new Error('KNGeoid18: no grid nodes around the campus');
    fs.writeFileSync(path.join(OUT, 'kngeoid18_clip.json'), JSON.stringify({ model: 'KNGeoid18', columns: ['latitude', 'longitude', 'N'], nodes }));
    sources.geoid = { file: path.basename(args.geoid!), sha256: sha256(args.geoid!), nodes: nodes.length };
    console.log(`KNGeoid18: ${nodes.length} nodes around the campus`);
  }

  // ---- building register AL_D010 (EPSG:5186 polygons) ----
  {
    const shp = only(args.buildings!, '.shp');
    const prj = fs.readFileSync(only(args.buildings!, '.prj'), 'utf8');
    if (!prj.includes('5186')) throw new Error('Buildings: expected EPSG:5186');
    const near: Box = [box5186[0] + buffer - 50, box5186[1] + buffer - 50, box5186[2] - buffer + 50, box5186[3] - buffer + 50];
    const dbf = new DbfReader(only(args.buildings!, '.dbf'));
    const names: Record<string, string> = {
      A0: 'sourceId', A5: 'jibun', A9: 'use', A12: 'footprintM2', A13: 'approvedOn', A16: 'heightM', A22: 'dataDate',
      A24: 'name', A25: 'dongName', A26: 'groundFloors', A27: 'undergroundFloors',
    };
    const out: { attributes: Record<string, string>; rings: Point2[][] }[] = [];
    for (const r of readShp(shp, (b) => intersects(b, near))) {
      const a = dbf.record(r.index);
      out.push({ attributes: Object.fromEntries(Object.entries(names).map(([k, v]) => [v, a[k] ?? ''])), rings: r.parts.map((ring) => ring.map(round)) });
    }
    dbf.close();
    fs.writeFileSync(path.join(OUT, 'buildings_al_d010.json'), JSON.stringify({ srid: 5186, dataset: 'GIS건물통합정보 AL_D010', features: out }));
    sources.buildings = { file: path.basename(shp), sha256: sha256(shp), features: out.length };
    console.log(`building register: ${out.length} footprints near the campus`);
  }

  // ---- university campus map (building list + rooms with floor names) ----
  if (args['campus-map']) {
    for (const f of ['skuniv_buildings.json', 'skuniv_places.json']) fs.copyFileSync(path.join(args['campus-map'], f), path.join(OUT, f));
    sources.campusMap = { url: 'https://www.skuniv.ac.kr/campus-map', files: ['skuniv_buildings.json', 'skuniv_places.json'] };
  }

  fs.writeFileSync(path.join(OUT, 'SOURCES.json'), JSON.stringify({ extractedAt: new Date().toISOString(), bufferM: buffer, extent5186: box5186, extent5174: box5174, sources }, null, 2));
  console.log(`written to ${OUT}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
