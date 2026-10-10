// Hand-drawn mobility spaces (QGIS edits PostGIS schema "mobility" directly; migration 019) for the preview.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../../config/database.js';

export const mobilityRoutes = Router();

const COMMON = `id, name, kind, elevation_m "elevationM", building_id "buildingId", floor, note, updated_at "updatedAt",
  ST_AsGeoJSON(ST_Transform(geom, 4326), 8)::json geometry`;

// GET /api/v1/mobility — all corridors, open areas and portals (WGS84), with length / area
mobilityRoutes.get('/mobility', async (req: Request, res: Response) => {
  const { rows: stamp } = await pool.query<{ v: string }>(
    `SELECT concat_ws(':', (SELECT max(id) FROM mobility.edits), (SELECT count(*) FROM mobility.corridors),
       (SELECT count(*) FROM mobility.open_areas), (SELECT count(*) FROM mobility.portals)) v`,
  );
  const etag = `"mobility-${stamp[0].v}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  const [corridors, areas, portals] = await Promise.all([
    pool.query(`SELECT ${COMMON}, width_m "widthM", one_way "oneWay", round(ST_Length(geom)::numeric, 1)::float8 "lengthM" FROM mobility.corridors ORDER BY id`),
    pool.query(`SELECT ${COMMON}, round(ST_Area(geom)::numeric, 1)::float8 "areaM2" FROM mobility.open_areas ORDER BY id`),
    pool.query(`SELECT ${COMMON} FROM mobility.portals ORDER BY id`),
  ]);
  res.json({ corridors: corridors.rows, openAreas: areas.rows, portals: portals.rows });
});

// GET /api/v1/mobility/roads — editor road segments (carriageways and pedestrian ways; no elevators), read-only, for the
// preview's road surfaces. Coordinates stay in EPSG:5186 with the stored MSL height (the preview builds metre geometry).
mobilityRoutes.get('/mobility/roads', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, road_class "roadClass", structure, width_m "widthM", level_id "levelId", building_id "buildingId",
            from_node_id "fromNodeId", to_node_id "toNodeId", ST_AsGeoJSON(geom, 3)::json geometry
       FROM mobility.road_segments WHERE status IN ('DRAFT', 'APPROVED') AND structure <> 'elevator' ORDER BY created_at, id`,
  );
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ roads: rows });
});

// GET /api/v1/mobility/edits?limit=50 — latest QGIS edits (audit log)
mobilityRoutes.get('/mobility/edits', async (req, res) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT id, at, table_name "table", op, feature_id "featureId", db_user "user",
            COALESCE(new_row->>'name', old_row->>'name') name, COALESCE(new_row->>'kind', old_row->>'kind') kind
       FROM mobility.edits ORDER BY id DESC LIMIT $1`, [limit],
  );
  res.json(rows);
});
