import type { DbClient } from '../config/database.js';
import { pool } from '../config/database.js';
import type { Observation } from '../modules/fusion/fusion.timeline.js';

export type Ring = [number, number][];
export type MultiPolygonCoordinates = Ring[][];

export interface SpatialBuilding {
  buildingId: string;
  buildingName: string | null;
  coordinates: MultiPolygonCoordinates;
}

export interface SpatialContext {
  mapVersionId: string;
  campus: MultiPolygonCoordinates[];
  buildings: SpatialBuilding[];
}

export type CoordinateClassification = {
  campus: 'INSIDE' | 'OUTSIDE' | 'BOUNDARY_UNCERTAIN' | 'MAP_UNAVAILABLE';
  mapVersionId: string | null;
  buildingId: string | null;
  buildingName: string | null;
  buildingMatchStatus: 'MATCHED' | 'NONE' | 'BOUNDARY_UNCERTAIN' | 'AMBIGUOUS' | 'MAP_UNAVAILABLE';
  boundaryDistanceM: number | null;
};

const cache = new Map<string, SpatialContext>();

function geometryCoordinates(value: unknown): MultiPolygonCoordinates {
  const parsed = typeof value === 'string' ? JSON.parse(value) as { type: string; coordinates: unknown } : value as { type?: string; coordinates?: unknown };
  if (parsed?.type === 'Polygon') return [parsed.coordinates as Ring[]];
  if (parsed?.type === 'MultiPolygon') return parsed.coordinates as MultiPolygonCoordinates;
  throw new Error(`Unsupported spatial geometry type: ${parsed?.type ?? 'unknown'}`);
}

export const spatial = {
  async activeMapVersion(db: DbClient = pool): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM spatial_map_versions WHERE active LIMIT 1');
    return rows[0]?.id ?? null;
  },

  async sessionMapVersion(sessionId: string, db: DbClient = pool): Promise<string | null> {
    const { rows } = await db.query<{ mapVersionId: string | null }>(
      'SELECT spatial_map_version_id AS "mapVersionId" FROM collection_sessions WHERE id = $1', [sessionId],
    );
    return rows[0]?.mapVersionId ?? null;
  },

  async context(mapVersionId: string | null, db: DbClient = pool): Promise<SpatialContext | null> {
    if (!mapVersionId) return null;
    const cached = cache.get(mapVersionId);
    if (cached) return cached;
    const [areas, buildings] = await Promise.all([
      db.query<{ geometry: unknown }>(
        `SELECT ST_AsGeoJSON(ST_Transform(geom, 4326)) AS geometry
           FROM campus_areas WHERE map_version_id = $1`, [mapVersionId],
      ),
      db.query<{ buildingId: string; buildingName: string | null; geometry: unknown }>(
        `SELECT building_id AS "buildingId", building_name AS "buildingName",
                ST_AsGeoJSON(ST_Transform(geom, 4326)) AS geometry
           FROM campus_buildings WHERE map_version_id = $1 ORDER BY building_id`, [mapVersionId],
      ),
    ]);
    if (areas.rows.length === 0) throw new Error(`Spatial map ${mapVersionId} has no campus polygon`);
    const result: SpatialContext = {
      mapVersionId,
      campus: areas.rows.map((row) => geometryCoordinates(row.geometry)),
      buildings: buildings.rows.map((row) => ({
        buildingId: row.buildingId,
        buildingName: row.buildingName,
        coordinates: geometryCoordinates(row.geometry),
      })),
    };
    cache.set(mapVersionId, result);
    return result;
  },

  classify(latitude: number, longitude: number, accuracy: number | null | undefined, context: SpatialContext | null): CoordinateClassification {
    if (!context) return {
      campus: 'MAP_UNAVAILABLE', mapVersionId: null, buildingId: null, buildingName: null,
      buildingMatchStatus: 'MAP_UNAVAILABLE', boundaryDistanceM: null,
    };
    const campusChecks = context.campus.map((coordinates) => {
      const inside = polygonContains(longitude, latitude, coordinates);
      return { inside, distanceM: polygonDistanceM(longitude, latitude, coordinates) };
    });
    const boundaryDistanceM = Math.min(...campusChecks.map((x) => x.distanceM));
    const inside = campusChecks.some((x) => x.inside || x.distanceM <= 0.02);
    const campusStatus = !inside
      ? 'OUTSIDE'
      : Number.isFinite(accuracy) && accuracy! > 0 && boundaryDistanceM <= accuracy!
        ? 'BOUNDARY_UNCERTAIN'
        : 'INSIDE';
    const hits = context.buildings.filter((b) => polygonContains(longitude, latitude, b.coordinates) || polygonDistanceM(longitude, latitude, b.coordinates) <= 0.02);
    const buildingBoundary = Number.isFinite(accuracy) && accuracy! > 0 && hits.some((b) => polygonDistanceM(longitude, latitude, b.coordinates) <= accuracy!);
    const buildingMatchStatus = hits.length > 1 ? 'AMBIGUOUS' : hits.length === 0 ? 'NONE' : buildingBoundary ? 'BOUNDARY_UNCERTAIN' : 'MATCHED';
    return {
      campus: campusStatus,
      mapVersionId: context.mapVersionId,
      buildingId: hits.length === 1 ? hits[0].buildingId : null,
      buildingName: hits.length === 1 ? hits[0].buildingName : null,
      buildingMatchStatus,
      boundaryDistanceM,
    };
  },

  annotate(observations: Observation[], context: SpatialContext | null): Observation[] {
    return observations.map((observation) => observation.kind === 'gps'
      ? {
          ...observation,
          spatialContext: context,
          spatialClassification: this.classify(observation.latitude, observation.longitude, observation.horizontalAccuracy, context),
        }
      : { ...observation, spatialContext: context });
  },

  async geoJson(mapVersionId: string | null = null, db: DbClient = pool) {
    const id = mapVersionId ?? await this.activeMapVersion(db);
    if (!id) return { mapVersionId: null, campus: [], buildings: [] };
    const context = await this.context(id, db);
    return { mapVersionId: id, campus: context!.campus, buildings: context!.buildings.map(({ buildingId, buildingName, coordinates }) => ({ buildingId, buildingName, coordinates })) };
  },
};

function ringContains(longitude: number, latitude: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > latitude) !== (yj > latitude) && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonContains(longitude: number, latitude: number, polygons: MultiPolygonCoordinates): boolean {
  return polygons.some((rings) => rings.length > 0 && ringContains(longitude, latitude, rings[0]) && !rings.slice(1).some((hole) => ringContains(longitude, latitude, hole)));
}

function pointSegmentDistanceM(lon: number, lat: number, a: [number, number], b: [number, number]) {
  const radians = Math.PI / 180;
  const xScale = 111_320 * Math.cos(lat * radians);
  const yScale = 110_574;
  const px = 0;
  const py = 0;
  const ax = (a[0] - lon) * xScale;
  const ay = (a[1] - lat) * yScale;
  const bx = (b[0] - lon) * xScale;
  const by = (b[1] - lat) * yScale;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-12)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function polygonDistanceM(longitude: number, latitude: number, polygons: MultiPolygonCoordinates): number {
  let distance = Infinity;
  for (const rings of polygons) for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) distance = Math.min(distance, pointSegmentDistanceM(longitude, latitude, ring[i - 1], ring[i]));
  }
  return distance;
}
