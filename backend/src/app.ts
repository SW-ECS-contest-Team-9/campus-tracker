import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { checkDatabase } from './config/database.js';
import { errorHandler, notFoundHandler } from './common/middleware/error-handler.js';
import { logger } from './common/logger.js';
import { collectorRoutes } from './modules/collectors/collector.routes.js';
import { sessionRoutes } from './modules/sessions/session.routes.js';
import { fusionRoutes } from './modules/fusion/fusion.routes.js';
import { spatialRoutes } from './modules/spatial/spatial.routes.js';
import { terrainRoutes } from './modules/terrain/terrain.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Access log: shows whether a phone's request reached the server at all (method, path, status, client IP).
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.info('http', { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ip: req.socket.remoteAddress, ms: Date.now() - started });
    });
    next();
  });
  // Browsers are limited to CORS_ORIGIN. Native iPhone requests carry no Origin header and are unaffected.
  app.use(cors({ origin: env.corsOrigins }));
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', async (_req, res) => {
    const dbOk = await checkDatabase();
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', database: dbOk ? 'ok' : 'error' });
  });

  app.use('/api/v1/collectors', collectorRoutes);
  app.use('/api/v1/sessions', sessionRoutes);
  app.use('/api/v1/fusion', fusionRoutes);
  app.use('/api/v1/spatial', spatialRoutes);
  app.use('/api/v1/terrain', terrainRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
