// Hand-drawn mobility spaces (QGIS edits PostGIS schema "mobility" directly; migration 019) for the preview.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../../config/database.js';
import { FLOOR_NAME } from '../markers/marker-anchor.js';
import { anchorBuildings, loadAnchorNodes, pickAnchorNodes } from './anchor-nodes.js';
import { tmInverse } from '../../geo/tm.js';
import { areaLinks } from '../editor-mcp/area-links.js';
import { editorQueries, roadLength } from '../editor-mcp/editor.queries.js';
import { DeclaredRoute, declaredPath } from './declared-route.js';

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
    `SELECT id, name, road_class "roadClass", structure, vehicle_access "vehicleAccess", width_m "widthM", level_id "levelId", building_id "buildingId",
            from_node_id "fromNodeId", to_node_id "toNodeId", ST_AsGeoJSON(geom, 3)::json geometry
       FROM mobility.road_segments WHERE status IN ('DRAFT', 'APPROVED') AND structure <> 'elevator' ORDER BY created_at, id`,
  );
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ roads: rows });
});

// GET /api/v1/mobility/elevators — the elevator segments the roads endpoint leaves out (F09: the preview's lifted floor view and
// first-person walk step between floors with them). Same fields as the roads; read-only.
mobilityRoutes.get('/mobility/elevators', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, road_class "roadClass", structure, vehicle_access "vehicleAccess", width_m "widthM", level_id "levelId", building_id "buildingId",
            from_node_id "fromNodeId", to_node_id "toNodeId", ST_AsGeoJSON(geom, 3)::json geometry
       FROM mobility.road_segments WHERE status IN ('DRAFT', 'APPROVED') AND structure = 'elevator' ORDER BY created_at, id`,
  );
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ roads: rows });
});

// GET /api/v1/mobility/places — the places of the editor (entrances, facilities, stops), read-only, for the preview (F09).
// Only what the editor shows on the map: name, category, building, level and the point (EPSG:5186 x, y, MSL height).
// No description, no author, no times.
mobilityRoutes.get('/mobility/places', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, category, building_id "buildingId", level_id "levelId", ST_AsGeoJSON(geom, 3)::json geometry
       FROM mobility.places WHERE status IN ('DRAFT', 'APPROVED') ORDER BY name, id`,
  );
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ places: rows });
});

// GET /api/v1/mobility/nodes?buildingId=&floor=&latitude=&longitude=&limit=&includeUnknownFloor= — the nodes a collector
// can pick for a collection anchor (markers/marker-anchor.ts), nearest first, plus the buildings for the picker.
// buildingId "outdoor" = nodes outside every building. With a floor, the nodes whose floor the data does not know follow
// the ones on that floor (most indoor roads have no levelId yet); includeUnknownFloor=false leaves them out.
const AnchorNodesQuery = z.object({
  buildingId: z.string().trim().min(1).max(24).optional(),
  floor: z.string().trim().toUpperCase().regex(FLOOR_NAME).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  includeUnknownFloor: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
}).refine((q) => (q.latitude === undefined) === (q.longitude === undefined), { message: 'latitude and longitude go together', path: ['latitude'] });

mobilityRoutes.get('/mobility/nodes', async (req, res) => {
  const q = AnchorNodesQuery.parse(req.query);
  const { nodes, footprints } = await loadAnchorNodes(q.latitude !== undefined ? { latitude: q.latitude, longitude: q.longitude! } : null);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ buildings: anchorBuildings(nodes, footprints), nodes: pickAnchorNodes(nodes, q) });
});

// Resolve the identifier on a printed QR code against the current map, not coordinates supplied by the code.
mobilityRoutes.get('/mobility/nodes/:id', async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const { nodes } = await loadAnchorNodes(null);
  const node = nodes.find((n) => n.nodeId.toLowerCase() === id.toLowerCase());
  res.setHeader('Cache-Control', 'no-store');
  if (!node) { res.status(404).json({ error: { code: 'NODE_NOT_FOUND', message: 'The map node is no longer available.' } }); return; }
  res.json(node);
});

// POST /api/v1/mobility/declared-route { nodeKeys, segments?, text?, mode?, assumeUnknownAllowed? } — the declared route
// (session:start declaredRoute) drawn on the active road graph: the shortest path through the points, leg by leg, for
// display and validation. Open areas count as walkable (as in check_reachability). Unknown access counts as passable by
// default: the collector says they walk it. Read-only, no auth (like /mobility/nodes).
const DeclaredRouteQuery = z.object({
  route: DeclaredRoute,
  mode: z.enum(['pedestrian', 'vehicle', 'wheelchair']).default('pedestrian'),
  assumeUnknownAllowed: z.boolean().default(true),
});

mobilityRoutes.post('/mobility/declared-route', async (req, res) => {
  const { mode, assumeUnknownAllowed, ...rest } = (req.body ?? {}) as Record<string, unknown>;
  const q = DeclaredRouteQuery.parse({ route: rest, mode, assumeUnknownAllowed });
  const [roads, nodes, areas] = await Promise.all([editorQueries.roads(), editorQueries.nodes(), editorQueries.areas()]);
  const graph = [...roads.map((r) => ({ ...r, lengthM: roadLength(r) })), ...areaLinks(areas, nodes)];
  const path = declaredPath(graph, nodes, q.route, q.mode, q.assumeUnknownAllowed);
  const wgs84 = (c: number[]) => { const ll = tmInverse(c[0], c[1]); return [ll.longitude, ll.latitude, c[2] ?? null]; };
  res.json({
    ...path,
    route: q.route,
    mode: q.mode,
    legs: path.legs.map((l) => ('coordinates' in l ? { ...l, coordinates: undefined } : l)),
    /** EPSG:5186 [x, y, z] and WGS84 [longitude, latitude, MSL height] of the whole path */
    coordinates: path.coordinates,
    geometry: { type: 'LineString', coordinates: path.coordinates.map(wgs84) },
  });
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
