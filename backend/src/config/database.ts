import pg from 'pg';
import { env } from './env.js';
import { logger } from '../common/logger.js';

// BIGINT (int8) -> number. Sequences and counts stay far below 2^53 in this project.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

pool.on('error', (err) => {
  logger.error('db.pool_error', { message: err.message });
});

export type DbClient = pg.Pool | pg.PoolClient;

/** BEGIN → fn → COMMIT, ROLLBACK on any error. The callback must only use the given client. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
