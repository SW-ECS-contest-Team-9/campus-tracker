// Durable editor changes are written inside the same transaction as the geometry, then notified after commit.
// On reconnect/startup, drain the outbox so a process restart cannot silently drop a committed update.
import { pool } from '../../config/database.js';
import { logger } from '../../common/logger.js';
import { editorService } from './editor.service.js';
import { editorBroadcast } from '../../realtime/editor.gateway.js';

export function listenEditorChanges() {
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const pending = await editorService.undeliveredChanges();
        if (!pending.length) break;
        for (const change of pending) {
          editorBroadcast.change(change);
          await editorService.acknowledgeChange(change.id);
        }
      }
    } catch (err) {
      logger.warn('editor.outbox_drain_failed', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      draining = false;
    }
  };
  const connect = async () => {
    try {
      const client = await pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel === 'editor_changed') void drain();
      });
      client.on('error', (err) => {
        logger.warn('editor.listen_error', { message: err.message });
        client.release(true);
        setTimeout(() => void connect(), 5000);
      });
      await client.query('LISTEN editor_changed');
      logger.info('editor.listening');
      await drain();
    } catch (err) {
      logger.warn('editor.listen_failed', { message: err instanceof Error ? err.message : String(err) });
      setTimeout(() => void connect(), 5000);
    }
  };
  void connect();
}
