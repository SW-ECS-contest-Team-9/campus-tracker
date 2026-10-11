import fs from 'node:fs/promises';
import path from 'node:path';
import { pool, withTransaction } from '../config/database.js';
import { logger } from '../common/logger.js';

// Tiny forward-only migration runner.
// Runs every backend/src/db/migrations/*.sql not yet recorded in schema_migrations,
// in filename order, each inside its own transaction.
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations');

/** apply = false only lists what is pending (and creates nothing). */
export async function migrate(apply = true): Promise<{ pending: string[]; total: number }> {
  if (apply) {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  }
  const { rows: [exists] } = await pool.query<{ t: string | null }>(`SELECT to_regclass('schema_migrations')::text t`);
  const applied = new Set(
    exists.t ? (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name) : [],
  );
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !applied.has(f));
  if (apply) {
    for (const file of pending) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await withTransaction(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      logger.info('migration.applied', { file });
    }
  }
  return { pending, total: files.length };
}
