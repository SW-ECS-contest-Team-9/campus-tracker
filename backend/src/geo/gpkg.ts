// Minimal GeoPackage reader (OGC GeoPackage 1.x) on Node's built-in SQLite: feature rows with their geometry
// decoded from the GeoPackage binary header + standard WKB. Polygons, multipolygons and linestrings (2D; Z/M
// ordinates are read and dropped). Read-only; no external dependency.
import { DatabaseSync } from 'node:sqlite';

export type Ring = [number, number][];
export type GpkgGeometry =
  | { type: 'Polygon'; coordinates: Ring[] }
  | { type: 'MultiPolygon'; coordinates: Ring[][] }
  | { type: 'LineString'; coordinates: Ring }
  | { type: 'MultiLineString'; coordinates: Ring[] }
  | { type: 'Point'; coordinates: [number, number] };

export interface GpkgFeature { fid: number; properties: Record<string, unknown>; geometry: GpkgGeometry | null }
export interface GpkgLayer { name: string; srsId: number; geometryColumn: string; features: GpkgFeature[] }

/** Decodes a GeoPackage geometry blob ("GP" header, optional envelope, then WKB). */
export function decodeGpkgGeometry(blob: Uint8Array): GpkgGeometry | null {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (blob[0] !== 0x47 || blob[1] !== 0x50) throw new Error('Not a GeoPackage geometry (missing GP magic)');
  const flags = blob[3];
  if (flags & 0b10000) return null; // empty geometry
  const envelope = [0, 32, 48, 48, 64][(flags >> 1) & 0b111];
  if (envelope === undefined) throw new Error('Invalid GeoPackage envelope indicator');
  let o = 8 + envelope;
  const read = (): GpkgGeometry => {
    const little = view.getUint8(o) === 1;
    o += 1;
    let type = view.getUint32(o, little);
    o += 4;
    // ISO WKB: 1000 = Z, 2000 = M, 3000 = ZM; EWKB high bits likewise
    let dims = 2;
    if (type & 0x80000000) dims++;
    if (type & 0x40000000) dims++;
    type &= 0x0fffffff;
    if (type >= 3000) { dims = 4; type -= 3000; } else if (type >= 2000) { dims = 3; type -= 2000; } else if (type >= 1000) { dims = 3; type -= 1000; }
    const point = (): [number, number] => {
      const x = view.getFloat64(o, little);
      const y = view.getFloat64(o + 8, little);
      o += 8 * dims;
      return [x, y];
    };
    const count = () => {
      const n = view.getUint32(o, little);
      o += 4;
      return n;
    };
    const ring = (): Ring => Array.from({ length: count() }, point);
    switch (type) {
      case 1: return { type: 'Point', coordinates: point() };
      case 2: return { type: 'LineString', coordinates: ring() };
      case 3: return { type: 'Polygon', coordinates: Array.from({ length: count() }, ring) };
      case 5: return { type: 'MultiLineString', coordinates: Array.from({ length: count() }, () => (read() as { coordinates: Ring }).coordinates) };
      case 6: return { type: 'MultiPolygon', coordinates: Array.from({ length: count() }, () => (read() as { coordinates: Ring[] }).coordinates) };
      default: throw new Error(`Unsupported WKB geometry type ${type}`);
    }
  };
  return read();
}

/** Reads one feature table of a GeoPackage file. */
export function readGpkgLayer(file: string, layer: string): GpkgLayer {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const meta = db.prepare('SELECT column_name AS col, srs_id AS srs FROM gpkg_geometry_columns WHERE table_name = ?').get(layer) as { col: string; srs: number } | undefined;
    if (!meta) throw new Error(`GeoPackage layer ${layer} not found`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(layer)) throw new Error(`Unsupported layer name ${layer}`);
    const rows = db.prepare(`SELECT * FROM "${layer}"`).all() as Record<string, unknown>[];
    const pk = (db.prepare(`PRAGMA table_info("${layer}")`).all() as { name: string; pk: number }[]).find((c) => c.pk === 1)?.name ?? 'fid';
    return {
      name: layer,
      srsId: meta.srs,
      geometryColumn: meta.col,
      features: rows.map((r) => {
        const { [meta.col]: geom, ...props } = r;
        return { fid: Number(r[pk]), properties: props, geometry: geom ? decodeGpkgGeometry(geom as Uint8Array) : null };
      }),
    };
  } finally {
    db.close();
  }
}

export function listGpkgLayers(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT table_name AS t FROM gpkg_contents WHERE data_type = 'features'`).all() as { t: string }[]).map((r) => r.t);
  } finally {
    db.close();
  }
}

/**
 * Registers the geometry functions GeoPackage R-tree triggers call (ST_IsEmpty, ST_MinX/MaxX/MinY/MaxY), so a
 * plain SQLite connection can UPDATE feature tables written by GDAL/QGIS.
 */
export function registerGpkgFunctions(db: DatabaseSync) {
  const bounds = (blob: unknown) => {
    if (!(blob instanceof Uint8Array)) return null;
    const g = decodeGpkgGeometry(blob);
    if (!g) return null;
    const pts: [number, number][] = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates
      : g.type === 'Polygon' || g.type === 'MultiLineString' ? g.coordinates.flat() : g.coordinates.flat(2);
    return { minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])) };
  };
  db.function('ST_IsEmpty', { deterministic: true }, (blob: unknown) => (blob instanceof Uint8Array && decodeGpkgGeometry(blob) ? 0 : 1));
  db.function('ST_MinX', { deterministic: true }, (blob: unknown) => bounds(blob)?.minX ?? null);
  db.function('ST_MaxX', { deterministic: true }, (blob: unknown) => bounds(blob)?.maxX ?? null);
  db.function('ST_MinY', { deterministic: true }, (blob: unknown) => bounds(blob)?.minY ?? null);
  db.function('ST_MaxY', { deterministic: true }, (blob: unknown) => bounds(blob)?.maxY ?? null);
}
