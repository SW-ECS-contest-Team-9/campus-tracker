import fs from 'node:fs/promises';
import path from 'node:path';
import { pool, withTransaction } from '../config/database.js';
import { logger } from '../common/logger.js';

// Tiny forward-only migration runner.
// Runs every backend/src/db/migrations/*.sql not yet recorded in schema_migrations,
// in filename order, each inside its own transaction.
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    logger.info('migration.applied', { file });
    count++;
  }
  logger.info('migration.done', { applied: count, total: files.length });
}

main()
  .catch((err) => {
    logger.error('migration.failed', { message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
