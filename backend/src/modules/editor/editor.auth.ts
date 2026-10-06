import type { RequestHandler } from 'express';
import { verifyAccessToken } from '../../common/auth/jwt.js';
import { AppError } from '../../common/errors/app-error.js';
import { collectorService } from '../collectors/collector.service.js';

/** The editor accepts the same passwordless collector-account JWT issued to the iOS tracker. */
export const editorAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization');
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw AppError.unauthorized('TOKEN_REQUIRED', 'Sign in with an existing tracker account');
  const identity = verifyAccessToken(token);
  await collectorService.touchDevice(identity);
  res.locals.editorIdentity = identity;
  next();
};
