import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { pool, withTransaction } from '../src/config/database.js';

type Ring = [number, number][];
type Polygon = Ring[];
type Feature = { id: string; name: string | null; rings: Polygon };
const sourceDir = path.resolve(import.meta.dirname, '../data/campus-map/source');

function parseShp(buffer: Buffer): Polygon[] {
  if (buffer.readInt32BE(0) !== 9994) throw new Error('Invalid shapefile header');
  const shapeType = buffer.readInt32LE(32);
  if (shapeType !== 5 && shapeType !== 15 && shapeType !== 25) throw new Error(`Expected polygon shapefile, received type ${shapeType}`);
  const shapes: Polygon[] = [];
  let offset = 100;
  while (offset < buffer.length) {
    const words = buffer.readInt32BE(offset + 4);
    const record = buffer.subarray(offset + 8, offset + 8 + words * 2);
    const type = record.readInt32LE(0);
    if (type === 0) { shapes.push([]); offset += 8 + words * 2; continue; }
    if (type !== 5 && type !== 15 && type !== 25) throw new Error(`Unexpected record type ${type}`);
    const partCount = record.readInt32LE(36);
    const pointCount = record.readInt32LE(40);
    const starts = Array.from({ length: partCount }, (_, i) => record.readInt32LE(44 + i * 4));
    const pointsOffset = 44 + partCount * 4;
    const points = Array.from({ length: pointCount }, (_, i): [number, number] => [record.readDoubleLE(pointsOffset + i * 16), record.readDoubleLE(pointsOffset + i * 16 + 8)]);
    const rings = starts.map((start, i) => points.slice(start, starts[i + 1] ?? pointCount));
    shapes.push(rings);
    offset += 8 + words * 2;
  }
  return shapes;
}

async function parseDbf(buffer: Buffer): Promise<Record<string, string>[]> {
  const count = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const cpg = await fs.readFile(path.join(sourceDir, 'building.cpg'), 'utf8').catch(() => '');
  const encoding = /utf-?8/i.test(cpg) ? 'utf-8' : /1252|latin/i.test(cpg) ? 'windows-1252' : 'euc-kr';
  const decoder = new TextDecoder(encoding);
  const fields: { name: string; length: number }[] = [];
  for (let offset = 32; buffer[offset] !== 13; offset += 32) {
    const field = buffer.subarray(offset, offset + 32);
    fields.push({ name: decoder.decode(field.subarray(0, 11)).replace(/\0.*$/, '').trim(), length: field[16] });
  }
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    const row = buffer.subarray(headerLength + i * recordLength, headerLength + (i + 1) * recordLength);
    if (row[0] === 0x2a) { rows.push({}); continue; }
    let fieldOffset = 1;
    const values: Record<string, string> = {};
    for (const field of fields) {
      values[field.name] = decoder.decode(row.subarray(fieldOffset, fieldOffset + field.length)).trim();
      fieldOffset += field.length;
    }
    rows.push(values);
  }
  return rows;
}

function polygonWkt(rings: Polygon): string {
  const clean = rings.filter((r) => r.length >= 4);
  if (!clean.length) throw new Error('Encountered empty polygon geometry');
  const signedArea = (r: Ring) => r.reduce((sum, p, i) => {
    const next = r[(i + 1) % r.length];
    return sum + p[0] * next[1] - next[0] * p[1];
  }, 0) / 2;
  const contains = (point: number[], ring: Ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  // ESRI polygon rings wind clockwise for shells and counter-clockwise for holes.
  const shells = clean.filter((ring) => signedArea(ring) < 0);
  const holes = clean.filter((ring) => signedArea(ring) >= 0);
  const groups = (shells.length ? shells : clean).map((shell) => [shell]);
  for (const hole of shells.length ? holes : []) {
    groups.find((group) => contains(hole[0], group[0]))?.push(hole);
  }
  return `MULTIPOLYGON(${groups.map((group) => `(${group.map((ring) => `(${ring.map(([x, y]) => `${x} ${y}`).join(',')})`).join(',')})`).join(',')})`;
}

async function readFeatures(stem: string): Promise<Feature[]> {
  const [shp, dbf] = await Promise.all([
    fs.readFile(path.join(sourceDir, `${stem}.shp`)),
    fs.readFile(path.join(sourceDir, `${stem}.dbf`)),
  ]);
  const polygons = parseShp(shp);
  const attrs = await parseDbf(dbf);
  if (polygons.length !== attrs.length) throw new Error(`${stem}: SHP/DBF feature count mismatch`);
  return polygons.map((rings, i) => ({
    id: `${stem}-${i + 1}`,
    name: attrs[i]['건물명']?.trim() || null,
    rings,
  }));
}

async function main() {
  const [campus, buildings] = await Promise.all([readFeatures('campus_area'), readFeatures('building')]);
  if (!(await fs.readFile(path.join(sourceDir, 'campus_area.prj'), 'utf8')).includes('Central_Belt_2010')) {
    throw new Error('Expected KGD2002 Central Belt 2010 (EPSG:5186) projection');
  }
  const hash = createHash('sha256');
  for (const file of ['campus_area.shp', 'campus_area.dbf', 'campus_area.prj', 'building.shp', 'building.dbf', 'building.prj']) {
    hash.update(file).update(await fs.readFile(path.join(sourceDir, file)));
  }
  const sourceHash = hash.digest('hex');
  const mapVersion = sourceHash.slice(0, 16);
  for (const feature of [...campus, ...buildings]) polygonWkt(feature.rings);
  const summary = { mapVersion, sourceSha256: sourceHash, campusFeatures: campus.length, buildingFeatures: buildings.length, buildingNames: buildings.map((f) => f.name ?? '(이름 미등록)') };
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  await withTransaction(async (db) => {
    await db.query('UPDATE spatial_map_versions SET active = false WHERE active');
    await db.query(
      `INSERT INTO spatial_map_versions (id, source_sha256, srid, active, metadata)
       VALUES ($1, $2, 5186, true, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET source_sha256 = EXCLUDED.source_sha256, active = true,
         imported_at = now(), metadata = EXCLUDED.metadata`,
      [mapVersion, sourceHash, JSON.stringify({ campusFeatures: campus.length, buildingFeatures: buildings.length })],
    );
    // Legacy sessions predate spatial maps. Pin them to the first imported release so v3 can be reprocessed.
    await db.query('UPDATE collection_sessions SET spatial_map_version_id = $1 WHERE spatial_map_version_id IS NULL', [mapVersion]);
    await db.query('DELETE FROM campus_areas WHERE map_version_id = $1', [mapVersion]);
    await db.query('DELETE FROM campus_buildings WHERE map_version_id = $1', [mapVersion]);
    for (const feature of campus) {
      const { rows } = await db.query<{ valid: boolean; reason: string }>(
        `SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason FROM
         (SELECT ST_SetSRID(ST_GeomFromText($1), 5186) AS g) q`, [polygonWkt(feature.rings)],
      );
      if (!rows[0].valid) throw new Error(`${feature.id} is invalid: ${rows[0].reason}`);
      await db.query(
        `INSERT INTO campus_areas (map_version_id, feature_id, geom, area_m2)
         VALUES ($1, $2, ST_Multi(ST_SetSRID(ST_GeomFromText($3), 5186)), ST_Area(ST_SetSRID(ST_GeomFromText($3), 5186)))`,
        [mapVersion, feature.id, polygonWkt(feature.rings)],
      );
    }
    const ids = new Set<string>();
    for (const feature of buildings) {
      const normalized = feature.name?.replace(/\s+/g, '') ?? `건물${feature.id.split('-')[1]}`;
      const buildingId = normalized.normalize('NFC');
      if (ids.has(buildingId)) throw new Error(`Duplicate building name/ID: ${buildingId}`);
      ids.add(buildingId);
      const geom = polygonWkt(feature.rings);
      const { rows } = await db.query<{ valid: boolean; reason: string }>(
        `SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason FROM
         (SELECT ST_SetSRID(ST_GeomFromText($1), 5186) AS g) q`, [geom],
      );
      if (!rows[0].valid) throw new Error(`${feature.id} is invalid: ${rows[0].reason}`);
      await db.query(
        `INSERT INTO campus_buildings (map_version_id, building_id, building_name, geom)
         VALUES ($1, $2, $3, ST_Multi(ST_SetSRID(ST_GeomFromText($4), 5186)))`,
        [mapVersion, buildingId, feature.name, geom],
      );
    }
    const checks = await db.query<{ outsideCampus: number; overlaps: number }>(
      `SELECT
         (SELECT count(*) FROM campus_buildings b LEFT JOIN campus_areas a ON a.map_version_id = b.map_version_id
           WHERE b.map_version_id = $1 AND (a.geom IS NULL OR NOT ST_Covers(a.geom, b.geom))) AS "outsideCampus",
         (SELECT count(*) FROM campus_buildings a JOIN campus_buildings b
           ON a.map_version_id = b.map_version_id AND a.building_id < b.building_id AND ST_Overlaps(a.geom, b.geom)
           WHERE a.map_version_id = $1) AS overlaps`, [mapVersion],
    );
    if (checks.rows[0].outsideCampus > 0) console.warn(`Map review needed: ${checks.rows[0].outsideCampus} building footprints extend outside the campus polygon.`);
    if (checks.rows[0].overlaps > 0) console.warn(`Map review needed: ${checks.rows[0].overlaps} building footprint pairs overlap.`);
  });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => pool.end());
