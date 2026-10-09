/** Read-only reproducibility check. Run from backend: npx tsx scripts/terrain-audit.ts */
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/config/database.js';
import { terrain } from '../src/geo/terrain.js';
import { buildDem, type ContourRun, type SpotHeight } from '../src/geo/dem.js';

const src = path.resolve(import.meta.dirname, '../data/terrain/source');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(src, name), 'utf8'));
const percentile = (v: number[], p: number) => {
  const sorted = [...v].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null;
};
const db = await pool.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const ctx = await terrain.context(await terrain.activeVersion(db), db);
  if (!ctx) throw new Error('No active terrain');
  const contourSource: { height: number; runs: [number, number][][] }[] = read('contours_5174.json').features;
  const spotSource: SpotHeight[] = read('spots_5174.json').features;
  const runs = contourSource.flatMap((c) => c.runs.map((points) => ({ height: c.height, points })));
  const wkts = [...runs.map((r) => `LINESTRING(${r.points.map((p) => p.join(' ')).join(',')})`),
    ...spotSource.map((s) => `POINT(${s.x} ${s.y})`)];
  const { rows } = await db.query<{ geometry: { coordinates: [number, number][] | [number, number] } }>(
    `SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText(w),5174),5186),4)::json geometry
     FROM unnest($1::text[]) WITH ORDINALITY AS t(w,i) ORDER BY i`, [wkts]);
  const contours: ContourRun[] = runs.map((r, i) => ({ height: r.height, points: rows[i].geometry.coordinates as [number, number][] }));
  const spots = spotSource.map((s, i) => {
    const [x, y] = rows[runs.length + i].geometry.coordinates as [number, number];
    return { x, y, height: s.height };
  });
  const rebuilt = buildDem(ctx.grid, contours, spots);
  let maxAbsM = 0, sumAbsM = 0, differingCells = 0;
  for (let i = 0; i < rebuilt.heights.length; i++) {
    const d = Math.abs(rebuilt.heights[i] - ctx.heights[i]);
    if (!Number.isFinite(d)) throw new Error(`Invalid height at cell ${i}`);
    if (d !== 0) differingCells++;
    maxAbsM = Math.max(maxAbsM, d);
    sumAbsM += d;
  }
  console.log(JSON.stringify({ terrainVersion: ctx.versionId, readOnly: true,
    cells: rebuilt.heights.length, differingCells, maxAbsM, meanAbsM: sumAbsM / rebuilt.heights.length,
    usableSpots: rebuilt.spotResiduals.length,
    correctedLooMedianM: percentile(rebuilt.spotLooResiduals, .5),
    correctedLooP90AbsM: percentile(rebuilt.spotLooResiduals.map(Math.abs), .9),
    note: 'Source consistency and held-out spot residuals; not independent field accuracy.' }, null, 2));
  await db.query('ROLLBACK');
} finally {
  db.release();
  await pool.end();
}
