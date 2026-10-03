import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, toErrorBody } from '../errors/app-error.js';
import { logger } from '../logger.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound('ROUTE_NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Malformed JSON body from express.json()
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
    return;
  }
  const { status, body } = toErrorBody(err);
  if (status >= 500) {
    logger.error('http.error', { method: req.method, path: req.path, message: err?.message, stack: err?.stack });
  }
  res.status(status).json({ error: body });
};
