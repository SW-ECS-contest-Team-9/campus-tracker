import { pool } from '../config/database.js';
import { logger } from '../common/logger.js';

// Development collectors. Re-running is safe (ON CONFLICT DO NOTHING).
const COLLECTOR_CODES = ['C01', 'C02', 'C03', 'C04', 'C05'];

async function main() {
  const { rows } = await pool.query<{ collector_code: string }>(
    `INSERT INTO collectors (collector_code)
     SELECT unnest($1::text[])
     ON CONFLICT (collector_code) DO NOTHING
     RETURNING collector_code`,
    [COLLECTOR_CODES],
  );
  logger.info('seed.collectors', { created: rows.map((r) => r.collector_code), requested: COLLECTOR_CODES });
}

main()
  .catch((err) => {
    logger.error('seed.failed', { message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
