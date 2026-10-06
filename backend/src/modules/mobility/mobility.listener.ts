// Relays PostgreSQL NOTIFY mobility_changed (fired by QGIS saves, migration 019) to the preview, debounced: a QGIS
// "save edits" of many features becomes one mobility:changed event. Reconnects if the listening connection drops.
import { pool } from '../../config/database.js';
import { logger } from '../../common/logger.js';
import { previewBroadcast } from '../../realtime/preview.gateway.js';

export function listenMobilityChanges() {
  let timer: NodeJS.Timeout | null = null;
  let pending: { table: string; op: string; id: number }[] = [];
  const flush = () => {
    timer = null;
    const changes = pending;
    pending = [];
    previewBroadcast.mobilityChanged({ changes: changes.length, tables: [...new Set(changes.map((c) => c.table))] });
    logger.info('mobility.changed', { changes: changes.length });
  };
  const connect = async () => {
    try {
      const client = await pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel !== 'mobility_changed') return;
        try {
          pending.push(JSON.parse(msg.payload ?? '{}'));
        } catch {
          pending.push({ table: 'unknown', op: 'unknown', id: 0 });
        }
        if (!timer) timer = setTimeout(flush, 300);
      });
      client.on('error', (err) => {
        logger.warn('mobility.listen_error', { message: err.message });
        client.release(true);
        setTimeout(() => void connect(), 5000);
      });
      await client.query('LISTEN mobility_changed');
      logger.info('mobility.listening');
    } catch (err) {
      logger.warn('mobility.listen_failed', { message: err instanceof Error ? err.message : String(err) });
      setTimeout(() => void connect(), 5000);
    }
  };
  void connect();
}
