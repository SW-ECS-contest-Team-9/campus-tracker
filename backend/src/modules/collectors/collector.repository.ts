import { pool, type DbClient } from '../../config/database.js';
import type { CollectorSummary, DeviceInfo } from './collector.dto.js';

export interface CollectorRow {
  id: string;
  collector_code: string;
}

export const collectorRepository = {
  async findByCode(code: string, db: DbClient = pool): Promise<CollectorRow | null> {
    const { rows } = await db.query<CollectorRow>(
      'SELECT id, collector_code FROM collectors WHERE collector_code = $1',
      [code],
    );
    return rows[0] ?? null;
  },

  async listAll(db: DbClient = pool): Promise<CollectorRow[]> {
    const { rows } = await db.query<CollectorRow>('SELECT id, collector_code FROM collectors ORDER BY collector_code');
    return rows;
  },

  /** Insert or refresh a device. NULL fields in the request keep the stored value. */
  async upsertDevice(collectorId: string, clientDeviceId: string, info: DeviceInfo, db: DbClient = pool): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO devices (collector_id, client_device_id, platform, device_model, system_version, app_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (collector_id, client_device_id) DO UPDATE SET
         platform       = COALESCE(EXCLUDED.platform, devices.platform),
         device_model   = COALESCE(EXCLUDED.device_model, devices.device_model),
         system_version = COALESCE(EXCLUDED.system_version, devices.system_version),
         app_version    = COALESCE(EXCLUDED.app_version, devices.app_version),
         last_seen_at   = now()
       RETURNING id`,
      [collectorId, clientDeviceId, info.platform ?? null, info.deviceModel ?? null, info.systemVersion ?? null, info.appVersion ?? null],
    );
    return rows[0].id;
  },

  /** Updates last_seen_at; returns false when the device row no longer matches (e.g. DB was reset). */
  async touchDevice(deviceId: string, collectorId: string, db: DbClient = pool): Promise<boolean> {
    const { rowCount } = await db.query(
      'UPDATE devices SET last_seen_at = now() WHERE id = $1 AND collector_id = $2',
      [deviceId, collectorId],
    );
    return rowCount === 1;
  },

  /** Returns null when the code already exists. */
  async insert(code: string, db: DbClient = pool): Promise<CollectorRow | null> {
    const { rows } = await db.query<CollectorRow>(
      `INSERT INTO collectors (collector_code) VALUES ($1)
       ON CONFLICT (collector_code) DO NOTHING
       RETURNING id, collector_code`,
      [code],
    );
    return rows[0] ?? null;
  },

  /** Next auto code: C<max+1>, zero-padded to 2 digits (C01, C02, ... C10, ... C100). */
  async nextAutoCode(db: DbClient = pool): Promise<string> {
    const { rows } = await db.query<{ next: number }>(
      `SELECT COALESCE(MAX(substring(collector_code FROM '^C([0-9]+)$')::int), 0) + 1 AS next FROM collectors`,
    );
    return `C${String(rows[0].next).padStart(2, '0')}`;
  },

  async summary(code: string, db: DbClient = pool): Promise<CollectorSummary | null> {
    const { rows } = await db.query<CollectorSummary>(
      `SELECT c.collector_code AS "collectorId",
              c.created_at     AS "createdAt",
              (SELECT count(*) FROM devices d WHERE d.collector_id = c.id) AS "deviceCount",
              (SELECT count(*) FROM collection_sessions s WHERE s.collector_id = c.id) AS "sessionCount",
              (SELECT count(*) FROM collection_sessions s WHERE s.collector_id = c.id AND s.status = 'ACTIVE') AS "activeSessionCount",
              (SELECT count(*) FROM location_samples l JOIN collection_sessions s ON s.id = l.session_id WHERE s.collector_id = c.id) AS "locationCount",
              (SELECT count(*) FROM event_markers m JOIN collection_sessions s ON s.id = m.session_id WHERE s.collector_id = c.id) AS "markerCount"
         FROM collectors c
        WHERE c.collector_code = $1`,
      [code],
    );
    return rows[0] ?? null;
  },

  /**
   * Deletes a collector and everything it collected. Sessions cascade to received_batches,
   * all *_samples and event_markers (ON DELETE CASCADE); devices and the collector go last.
   * Must run inside a transaction. Returns the deleted session ids.
   */
  async deleteWithData(db: DbClient, collectorDbId: string): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>('DELETE FROM collection_sessions WHERE collector_id = $1 RETURNING id', [collectorDbId]);
    await db.query('DELETE FROM devices WHERE collector_id = $1', [collectorDbId]);
    await db.query('DELETE FROM collectors WHERE id = $1', [collectorDbId]);
    return rows.map((r) => r.id);
  },
};
