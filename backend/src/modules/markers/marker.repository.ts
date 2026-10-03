import { pool, type DbClient } from '../../config/database.js';
import type { MarkerCreateRequest, MarkerView } from './marker.dto.js';

const MARKER_VIEW_COLUMNS = `
  marker_id AS "markerId", session_id AS "sessionId", "timestamp", type, note, latitude, longitude, altitude,
  ellipsoidal_altitude AS "ellipsoidalAltitude", horizontal_accuracy AS "horizontalAccuracy",
  vertical_accuracy AS "verticalAccuracy"`;

export const markerRepository = {
  /**
   * Idempotent by marker_id: returns the new marker, or null if it already existed.
   * geom Z policy is the same as location_samples (ellipsoidal → altitude → 0), see telemetry.repository.ts.
   */
  async insert(sessionId: string, m: MarkerCreateRequest, db: DbClient = pool): Promise<MarkerView | null> {
    const { rows } = await db.query<MarkerView>(
      `INSERT INTO event_markers (
         marker_id, session_id, "timestamp", type, note, latitude, longitude, altitude, ellipsoidal_altitude,
         horizontal_accuracy, vertical_accuracy, geom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               ST_SetSRID(ST_MakePoint($7::float8, $6::float8, COALESCE($9::float8, $8::float8, 0)), 4326))
       ON CONFLICT (marker_id) DO NOTHING
       RETURNING ${MARKER_VIEW_COLUMNS}`,
      [
        m.markerId, sessionId, m.timestamp, m.type, m.note ?? null, m.latitude, m.longitude,
        m.altitude ?? null, m.ellipsoidalAltitude ?? null, m.horizontalAccuracy ?? null, m.verticalAccuracy ?? null,
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
      `SELECT ${MARKER_VIEW_COLUMNS} FROM event_markers WHERE session_id = $1 ORDER BY "timestamp"`,
      [sessionId],
    );
    return rows;
  },
};
