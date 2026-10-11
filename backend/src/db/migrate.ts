import { pool } from '../config/database.js';
import { logger } from '../common/logger.js';
import { migrate } from './migrator.js';

// npm run db:migrate (the runner is src/db/migrator.ts; npm run deploy:sync runs it too).
migrate()
  .then(({ pending, total }) => logger.info('migration.done', { applied: pending.length, total }))
  .catch((err) => {
    logger.error('migration.failed', { message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
