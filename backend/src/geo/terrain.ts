// Campus terrain (DEM) as the absolute height reference. Loaded once per version into memory (a few MB);
// fusion samples it per step without DB queries. Heights are orthometric (Incheon MSL); ellipsoidal = H + N.
import { pool, type DbClient } from '../config/database.js';
import { bilinear, type Grid } from './dem.js';
import { tmForward } from './tm.js';

export interface TerrainBuilding {
  buildingId: string;
  name: string | null;
  /** EPSG:5186 multipolygon: polygons -> rings -> [x, y] */
  polygons: [number, number][][][];
  groundFloors: number | null;
  undergroundFloors: number | null;
  heightM: number | null;
  floorLabels: string[];
}

export interface TerrainContext {
  versionId: string;
  grid: Grid;
  heights: Float32Array;
  sigma: Float32Array;
  modified: Uint8Array;
  geoidSeparation: number;
  buildings: TerrainBuilding[];
}

export interface TerrainSample { x: number; y: number; height: number; sigma: number; modified: boolean; slope: number }

const cache = new Map<string, TerrainContext>();

const floats = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));

function ringContains(x: number, y: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function edgeDistance(x: number, y: number, ring: [number, number][]) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / Math.max((bx - ax) ** 2 + (by - ay) ** 2, 1e-9)));
    best = Math.min(best, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
  }
  return best;
}

export const terrain = {
  async activeVersion(db: DbClient = pool): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM terrain_versions WHERE active LIMIT 1');
    return rows[0]?.id ?? null;
  },

  /** The session's pinned terrain version; pins the active one on first use (replays stay reproducible). */
  async sessionVersion(sessionId: string, db: DbClient = pool): Promise<string | null> {
    const { rows } = await db.query<{ id: string | null }>(
      `UPDATE collection_sessions SET terrain_version_id = COALESCE(terrain_version_id, (SELECT id FROM terrain_versions WHERE active LIMIT 1))
        WHERE id = $1 RETURNING terrain_version_id id`,
      [sessionId],
    );
    return rows[0]?.id ?? null;
  },

  async context(versionId: string | null, db: DbClient = pool): Promise<TerrainContext | null> {
    if (!versionId) return null;
    const cached = cache.get(versionId);
    if (cached) return cached;
    const { rows } = await db.query<{
      originX: number; originY: number; resolution: number; width: number; height: number; heights: Buffer; sigma: Buffer; modified: Buffer; geoid: number;
    }>(
      `SELECT origin_x "originX", origin_y "originY", resolution_m resolution, width, height, heights, sigma, modified_mask modified,
              geoid_separation_m geoid FROM terrain_versions WHERE id = $1`,
      [versionId],
    );
    if (!rows.length) return null;
    const r = rows[0];
    const { rows: blds } = await db.query<{
      buildingId: string; name: string | null; geometry: string; ground: number | null; under: number | null; heightM: number | null; floors: string[] | null;
    }>(
      `SELECT b.building_id "buildingId", COALESCE(m.display_name, b.building_name) name, ST_AsGeoJSON(b.geom) geometry,
              m.register_ground_floors ground, m.register_underground_floors under, m.register_height_m "heightM", m.campus_floor_labels floors
         FROM campus_buildings b JOIN spatial_map_versions v ON v.id = b.map_version_id AND v.active
         LEFT JOIN building_metadata m ON m.map_version_id = b.map_version_id AND m.building_id = b.building_id
        ORDER BY b.building_id`,
    );
    const ctx: TerrainContext = {
      versionId,
      grid: { originX: r.originX, originY: r.originY, resolution: r.resolution, width: r.width, height: r.height },
      heights: floats(r.heights),
      sigma: floats(r.sigma),
      modified: new Uint8Array(r.modified),
      geoidSeparation: r.geoid,
      buildings: blds.map((b) => ({
        buildingId: b.buildingId,
        name: b.name,
        polygons: JSON.parse(b.geometry).coordinates,
        groundFloors: b.ground,
        undergroundFloors: b.under,
        heightM: b.heightM,
        floorLabels: b.floors ?? [],
      })),
    };
    cache.set(versionId, ctx);
    return ctx;
  },

  sampleXY(ctx: TerrainContext, x: number, y: number): TerrainSample | null {
    const g = ctx.grid;
    const height = bilinear(g, ctx.heights, x, y);
    const sigma = bilinear(g, ctx.sigma, x, y);
    if (height === null || sigma === null) return null;
    const d = g.resolution;
    const hx0 = bilinear(g, ctx.heights, x - d, y), hx1 = bilinear(g, ctx.heights, x + d, y);
    const hy0 = bilinear(g, ctx.heights, x, y - d), hy1 = bilinear(g, ctx.heights, x, y + d);
    const slope = hx0 !== null && hx1 !== null && hy0 !== null && hy1 !== null ? Math.hypot((hx1 - hx0) / (2 * d), (hy1 - hy0) / (2 * d)) : 0;
    const ix = Math.floor((x - g.originX) / g.resolution);
    const iy = Math.floor((y - g.originY) / g.resolution);
    return { x, y, height, sigma, modified: ctx.modified[iy * g.width + ix] === 1, slope };
  },

  sampleLatLon(ctx: TerrainContext, latitude: number, longitude: number): TerrainSample | null {
    const p = tmForward(latitude, longitude);
    return this.sampleXY(ctx, p.x, p.y);
  },

  /** Building containing the point (or null) and the distance to the nearest footprint edge, meters. */
  buildingAt(ctx: TerrainContext, x: number, y: number): { building: TerrainBuilding | null; distance: number } {
    let best = Infinity;
    let inside: TerrainBuilding | null = null;
    for (const b of ctx.buildings) {
      for (const poly of b.polygons) {
        if (ringContains(x, y, poly[0]) && !poly.slice(1).some((h) => ringContains(x, y, h))) inside = b;
        for (const ring of poly) best = Math.min(best, edgeDistance(x, y, ring));
      }
    }
    return { building: inside, distance: inside ? 0 : best };
  },

  /** Nearest point on a building's outline (EPSG:5186) and whether (x, y) is inside the footprint. */
  nearestEdge(b: TerrainBuilding, x: number, y: number): { x: number; y: number; distance: number; inside: boolean } {
    let best = { x, y, distance: Infinity };
    let inside = false;
    for (const poly of b.polygons) {
      if (ringContains(x, y, poly[0]) && !poly.slice(1).some((h) => ringContains(x, y, h))) inside = true;
      for (const ring of poly) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [ax, ay] = ring[j];
          const [bx, by] = ring[i];
          const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / Math.max((bx - ax) ** 2 + (by - ay) ** 2, 1e-9)));
          const px = ax + t * (bx - ax);
          const py = ay + t * (by - ay);
          const d = Math.hypot(x - px, y - py);
          if (d < best.distance) best = { x: px, y: py, distance: d };
        }
      }
    }
    return { ...best, inside };
  },

  async summary(db: DbClient = pool) {
    const { rows } = await db.query(
      `SELECT id, vertical_datum "verticalDatum", geoid_separation_m "geoidSeparationM", geoid_source "geoidSource", resolution_m "resolutionM",
              width, height, origin_x "originX", origin_y "originY", imported_at "importedAt", metadata->'qa' qa,
              metadata->'modifiedBuildings' "modifiedBuildings" FROM terrain_versions WHERE active`,
    );
    if (!rows.length) return null;
    const { rows: buildings } = await db.query(
      `SELECT m.building_id "buildingId", m.display_name "name", m.register_label "registerLabel", m.register_use "use",
              m.register_ground_floors "groundFloors", m.register_underground_floors "undergroundFloors", m.register_height_m "heightM",
              m.register_approved_on "approvedOn", m.campus_floor_labels "floorLabels", m.metadata->'calibration' calibration
         FROM building_metadata m JOIN spatial_map_versions v ON v.id = m.map_version_id AND v.active ORDER BY m.display_name`,
    );
    return { ...rows[0], buildings };
  },
};
