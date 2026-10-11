// Entry point (npm run dev / start). The server itself is main.ts; it is loaded only after the installed packages have
// been compared with the lockfile, so that a pull that changed the dependencies ends in one clear line instead of a
// module-not-found stack trace.
import { logger } from './common/logger.js';
import { dependencyDrift } from './deploy/dependencies.js';

const drift = dependencyDrift();
if (drift) logger.error('deploy.dependencies', { hint: drift });
try {
  await import('./main.js');
} catch (err) {
  logger.error('server.load_failed', { message: err instanceof Error ? err.message : String(err), ...(drift ? { hint: drift } : {}) });
  process.exitCode = 1;
}
