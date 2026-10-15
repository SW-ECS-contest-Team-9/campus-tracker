import { pool, type DbClient } from '../../config/database.js';
import type { MarkerCreateRequest, MarkerView } from './marker.dto.js';

const MARKER_VIEW_COLUMNS = `
  marker_id AS "markerId", session_id AS "sessionId", "timestamp", type, note, latitude, longitude, altitude,
  ellipsoidal_altitude AS "ellipsoidalAltitude", horizontal_accuracy AS "horizontalAccuracy",
  vertical_accuracy AS "verticalAccuracy", node_id AS "nodeId", building_id AS "buildingId", floor, direction,
  from_floor AS "fromFloor", to_floor AS "toFloor"`;

/** A marker that names a node, with the node's position (EPSG:5186, MSL height): a fusion fix point. */
export interface MarkerNodeAnchor {
  markerId: string;
  t: number;
  type: string;
  nodeId: string;
  x: number;
  y: number;
  z: number;
  /** false: the node is gone from the network, the position is the one it had when the marker arrived */
  current: boolean;
}

export const markerRepository = {
  /**
   * Idempotent by marker_id: returns the new marker, or null if it already existed.
   * geom Z policy is the same as location_samples (ellipsoidal → altitude → 0), see telemetry.repository.ts.
   */
  async insert(sessionId: string, m: MarkerCreateRequest, db: DbClient = pool): Promise<MarkerView | null> {
    const { rows } = await db.query<MarkerView>(
      `INSERT INTO event_markers (
         marker_id, session_id, "timestamp", type, note, latitude, longitude, altitude, ellipsoidal_altitude,
         horizontal_accuracy, vertical_accuracy, geom,
         node_id, building_id, floor, direction, from_floor, to_floor, node_geom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               ST_SetSRID(ST_MakePoint($7::float8, $6::float8, COALESCE($9::float8, $8::float8, 0)), 4326),
               $12, $13, $14, $15, $16, $17, (SELECT n.geom FROM mobility.network_nodes n WHERE n.id = $12))
       ON CONFLICT (marker_id) DO NOTHING
       RETURNING ${MARKER_VIEW_COLUMNS}`,
      [
        m.markerId, sessionId, m.timestamp, m.type, m.note ?? null, m.latitude, m.longitude,
        m.altitude ?? null, m.ellipsoidalAltitude ?? null, m.horizontalAccuracy ?? null, m.verticalAccuracy ?? null,
        m.nodeId ?? null, m.buildingId ?? null, m.floor ?? null, m.direction ?? null, m.fromFloor ?? null, m.toFloor ?? null,
      ],
    );
    return rows[0] ?? null;
  },

  async findSessionIdByMarkerId(markerId: string, db: DbClient = pool): Promise<string | null> {
    const { rows } = await db.query<{ session_id: string }>('SELECT session_id FROM event_markers WHERE marker_id = $1', [markerId]);
    return rows[0]?.session_id ?? null;
  },

  async findBySession(sessionId: string, db: DbClient = pool): Promise<MarkerView[]> {
    const { rows } = await db.query<MarkerView>(
      `SELECT ${MARKER_VIEW_COLUMNS},
              CASE WHEN g IS NULL THEN NULL ELSE json_build_object('x', ST_X(g), 'y', ST_Y(g), 'z', ST_Z(g), 'current', n.id IS NOT NULL) END AS "node"
         FROM event_markers m
         LEFT JOIN mobility.network_nodes n ON n.id = m.node_id
         CROSS JOIN LATERAL (SELECT COALESCE(n.geom, m.node_geom) AS g) p
        WHERE m.session_id = $1 ORDER BY m."timestamp"`,
      [sessionId],
    );
    return rows;
  },

  /** Node anchors of a session for fusion: the node's current position, else the one stored with the marker. */
  async nodeAnchors(sessionId: string, db: DbClient = pool): Promise<MarkerNodeAnchor[]> {
    const { rows } = await db.query<MarkerNodeAnchor>(
      `SELECT m.marker_id AS "markerId", (extract(epoch FROM m."timestamp") * 1000)::float8 AS t, m.type, m.node_id AS "nodeId",
              ST_X(g)::float8 AS x, ST_Y(g)::float8 AS y, ST_Z(g)::float8 AS z, n.id IS NOT NULL AS current
         FROM event_markers m
         LEFT JOIN mobility.network_nodes n ON n.id = m.node_id
         CROSS JOIN LATERAL (SELECT COALESCE(n.geom, m.node_geom) AS g) p
        WHERE m.session_id = $1 AND m.node_id IS NOT NULL AND p.g IS NOT NULL
        ORDER BY m."timestamp", m.marker_id`,
      [sessionId],
    );
    return rows;
  },
};
