import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

/** Identity embedded in the access token and copied to socket.data on /collector. */
export interface CollectorIdentity {
  collectorId: string;          // human code, e.g. C03
  collectorDatabaseId: string;  // collectors.id
  deviceDatabaseId: string;     // devices.id
  clientDeviceId: string;       // iOS identifierForVendor
}

export function signAccessToken(identity: CollectorIdentity): string {
  return jwt.sign({ ...identity }, env.JWT_SECRET, {
    subject: identity.collectorDatabaseId,
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): CollectorIdentity {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload & Partial<CollectorIdentity>;
    if (!payload.collectorId || !payload.collectorDatabaseId || !payload.deviceDatabaseId || !payload.clientDeviceId) {
      throw AppError.unauthorized('INVALID_TOKEN', 'Token payload is incomplete');
    }
    return {
      collectorId: payload.collectorId,
      collectorDatabaseId: payload.collectorDatabaseId,
      deviceDatabaseId: payload.deviceDatabaseId,
      clientDeviceId: payload.clientDeviceId,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) throw AppError.unauthorized('TOKEN_EXPIRED', 'Access token expired, login again');
    throw AppError.unauthorized('INVALID_TOKEN', 'Invalid access token');
  }
}
