// Preview map data (docs/CAMPUS_3D_PREVIEW_PLAN.md): the active rough campus 3D scene and the terrain grid it
// stands on (the same DEM fusion uses). Both are versioned; responses carry an ETag so the browser caches them.
import { Router, type Request, type Response } from 'express';
import { pool } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { terrain } from '../../geo/terrain.js';
import { CAMPUS_FRAME } from '../../geo/campus-frame.js';
import { tmInverse } from '../../geo/tm.js';

export const sceneRoutes = Router();

function cached(req: Request, res: Response, etag: string): boolean {
  res.setHeader('ETag', `"${etag}"`);
  res.setHeader('Cache-Control', 'no-cache'); // revalidate: cheap 304 while the version is unchanged
  if (req.headers['if-none-match'] === `"${etag}"`) {
    res.status(304).end();
    return true;
  }
  return false;
}

// GET /api/v1/scene
sceneRoutes.get('/scene', async (req, res) => {
  const { rows } = await pool.query<{ id: string; terrainVersionId: string; mapVersionId: string; heightMode: string; importedAt: Date }>(
    `SELECT id, terrain_version_id "terrainVersionId", map_version_id "mapVersionId", height_mode "heightMode", imported_at "importedAt"
       FROM scene_versions WHERE active`,
  );
  if (!rows.length) throw AppError.notFound('SCENE_UNAVAILABLE', 'No active campus scene (npm run scene:import)');
  const v = rows[0];
  if (cached(req, res, v.id)) return;
  const [buildings, campus, ctx] = await Promise.all([
    pool.query(
      `SELECT s.building_id "buildingId", s.name, s.height_m "heightM", s.height_source "heightSource", s.register_id "registerId",
              s.ground_floors "groundFloors", s.base_m "baseM", s.roof_m "roofM", s.terrain_min_m "terrainMinM", s.terrain_max_m "terrainMaxM",
              s.note, ST_AsGeoJSON(ST_Transform(s.geom, 4326), 8)::json geometry, md.metadata->'calibration' calibration
         FROM scene_buildings s
         LEFT JOIN building_metadata md ON md.map_version_id = $2 AND md.building_id = s.building_id
        WHERE s.scene_version_id = $1 ORDER BY s.roof_m DESC`,
      [v.id, v.mapVersionId],
    ),
    pool.query(`SELECT ST_AsGeoJSON(ST_Transform(geom, 4326), 8)::json geometry FROM campus_areas WHERE map_version_id = $1`, [v.mapVersionId]),
    terrain.context(v.terrainVersionId),
  ]);
  res.json({
    ...v,
    frame: CAMPUS_FRAME,
    geoidSeparationM: ctx?.geoidSeparation ?? CAMPUS_FRAME.geoidN,
    buildings: buildings.rows,
    campus: campus.rows.map((r) => r.geometry),
  });
});

// GET /api/v1/terrain/grid  — Float32 LE heights (row 0 = south edge, as stored), metadata in headers
sceneRoutes.get('/terrain/grid', async (req, res) => {
  const version = await terrain.activeVersion();
  const ctx = await terrain.context(version);
  if (!ctx) throw AppError.notFound('TERRAIN_UNAVAILABLE', 'No active terrain version (run terrain:import)');
  const g = ctx.grid;
  // WGS84 bounding box of the grid (for draping a ground texture over it)
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => tmInverse(g.originX + u * g.width * g.resolution, g.originY + v * g.height * g.resolution));
  const bounds = { west: Math.min(...corners.map((c) => c.longitude)), east: Math.max(...corners.map((c) => c.longitude)),
    south: Math.min(...corners.map((c) => c.latitude)), north: Math.max(...corners.map((c) => c.latitude)) };
  res.setHeader('X-Grid', JSON.stringify({ versionId: ctx.versionId, crs: 'EPSG:5186', originX: g.originX, originY: g.originY, resolution: g.resolution, width: g.width, height: g.height, bounds }));
  res.setHeader('Access-Control-Expose-Headers', 'X-Grid');
  if (cached(req, res, `grid-${ctx.versionId}`)) return;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.end(Buffer.from(ctx.heights.buffer, ctx.heights.byteOffset, ctx.heights.byteLength));
});
