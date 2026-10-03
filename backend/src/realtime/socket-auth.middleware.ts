import type { Socket } from 'socket.io';
import { verifyAccessToken, type CollectorIdentity } from '../common/auth/jwt.js';
import { AppError, toErrorBody } from '../common/errors/app-error.js';
import { logger } from '../common/logger.js';
import { collectorService } from '../modules/collectors/collector.service.js';

export interface CollectorSocketData {
  identity: CollectorIdentity;
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

/**
 * Shared collector authentication for both transports: verifies the JWT, checks the device id
 * (when given, or required) against the token, and that the device row still exists.
 * Throws AppError: TOKEN_REQUIRED/INVALID_TOKEN/TOKEN_EXPIRED (401), DEVICE_MISMATCH (403), DEVICE_NOT_FOUND (404).
 */
export async function authenticateCollector(
  token: string | undefined,
  deviceId: string | undefined,
  opts: { deviceIdRequired: boolean },
): Promise<CollectorIdentity> {
  if (!token) throw AppError.unauthorized('TOKEN_REQUIRED', 'Missing access token');
  const identity = verifyAccessToken(token);
  if (!deviceId && opts.deviceIdRequired) throw AppError.forbidden('DEVICE_MISMATCH', 'Missing device id');
  if (deviceId && deviceId !== identity.clientDeviceId) {
    throw AppError.forbidden('DEVICE_MISMATCH', 'deviceId does not match the token');
  }
  await collectorService.touchDevice(identity);
  return identity;
}

/**
 * /collector handshake auth. Token sources, in order:
 *   handshake.auth.token      (socket.io-client-swift: connect(withPayload: ["token": ..., "deviceId": ...]))
 *   handshake.query.token     (.connectParams(["token": ...]))
 *   Authorization: Bearer ... (.extraHeaders)
 * The identity comes from the verified token only; client-supplied collector ids are never trusted.
 */
export async function collectorSocketAuth(socket: Socket, next: (err?: Error) => void) {
  const { auth, query, headers } = socket.handshake;
  const bearer = typeof headers.authorization === 'string' ? headers.authorization.replace(/^Bearer\s+/i, '') : undefined;
  const token = pickString(auth?.token, query.token, bearer);
  const deviceId = pickString(auth?.deviceId, query.deviceId);

  logger.info('collector.handshake', {
    ip: socket.handshake.address,
    transport: socket.conn.transport.name,
    tokenFrom: auth?.token ? 'auth' : query.token ? 'query' : bearer ? 'header' : 'none',
    deviceId: deviceId ?? null,
    authKeys: Object.keys(auth ?? {}),
    queryKeys: Object.keys(query).filter((k) => !['EIO', 'transport', 't', 'b64'].includes(k)),
  });

  try {
    const identity = await authenticateCollector(token, deviceId, { deviceIdRequired: false });
    (socket.data as CollectorSocketData).identity = identity;
    next();
  } catch (err) {
    const { body } = toErrorBody(err);
    logger.warn('collector.auth_failed', { code: body.code, address: socket.handshake.address });
    // Socket.IO delivers err.message + err.data to the client's connect_error handler.
    const error = new Error(body.message) as Error & { data?: unknown };
    error.data = { code: body.code, message: body.message };
    next(error);
  }
}
