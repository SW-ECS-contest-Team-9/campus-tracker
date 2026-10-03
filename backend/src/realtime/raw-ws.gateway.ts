import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { CollectorIdentity } from '../common/auth/jwt.js';
import { AppError, toErrorBody } from '../common/errors/app-error.js';
import { logger } from '../common/logger.js';
import { collectorService } from '../modules/collectors/collector.service.js';
import { authenticateCollector } from './socket-auth.middleware.js';
import { runCollectorEvent } from './collector-events.js';

// Raw RFC 6455 WebSocket endpoint for iPhones using URLSessionWebSocketTask (no Socket.IO protocol).
// Same events, services and ACK-after-COMMIT guarantees as the Socket.IO /collector namespace.
//
// Handshake: GET /ws/collector + Authorization: Bearer <accessToken> + X-Device-ID: <deviceId>
// Request:   { "requestId": "uuid", "type": "telemetry:batch", "payload": { ... } }
// ACK:       { "type": "ack", "requestId": "uuid", "ok": true,  "data": { ... } }
//            { "type": "ack", "requestId": "uuid", "ok": false, "error": { code, message, status, retryable } }

export const RAW_COLLECTOR_WS_PATH = '/ws/collector';
const SOCKET_IO_PATH = '/socket.io/';
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const PING_INTERVAL_MS = 15_000; // dead phones (Wi-Fi off) are detected within ~2 intervals

const Envelope = z.object({
  requestId: z.string().trim().min(1).max(128),
  type: z.string().trim().min(1).max(64),
  payload: z.unknown(),
});

interface Connection {
  identity: CollectorIdentity;
  alive: boolean;
  connectedAt: number;
  messages: Record<string, number>; // per message type, for the disconnect summary
}
const connections = new Map<WebSocket, Connection>();

function clientIp(req: IncomingMessage) {
  return req.socket.remoteAddress;
}

/** Rejects the HTTP upgrade with a normal HTTP response + JSON error body. */
function rejectUpgrade(socket: Duplex, status: number, error: { code: string; message: string }) {
  const body = JSON.stringify({ error });
  if (!socket.writable) return socket.destroy();
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
}

function send(ws: WebSocket, message: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

/** Controller ACK bodies carry `ok: true`; in the raw protocol `ok` lives on the envelope. */
function toAckData(result: unknown) {
  if (result && typeof result === 'object' && 'ok' in result) {
    const { ok: _ok, ...data } = result as Record<string, unknown>;
    return data;
  }
  return result ?? {};
}

async function handleMessage(ws: WebSocket, identity: CollectorIdentity, raw: RawData) {
  const started = Date.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    send(ws, { type: 'ack', requestId: null, ok: false, error: { code: 'INVALID_JSON', message: 'Message must be a UTF-8 JSON object', status: 400, retryable: false } });
    logger.warn('raw_ws.message', { collectorId: identity.collectorId, ok: false, code: 'INVALID_JSON' });
    return;
  }

  const envelope = Envelope.safeParse(parsed);
  if (!envelope.success) {
    const requestId = typeof (parsed as { requestId?: unknown })?.requestId === 'string' ? (parsed as { requestId: string }).requestId : null;
    send(ws, {
      type: 'ack',
      requestId,
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Message needs requestId, type and payload', status: 400, retryable: false, details: z.flattenError(envelope.error) },
    });
    logger.warn('raw_ws.message', { collectorId: identity.collectorId, requestId, ok: false, code: 'VALIDATION_ERROR' });
    return;
  }

  const { requestId, type, payload } = envelope.data;
  const r = await runCollectorEvent('raw_ws', identity, type, payload);
  // ACK only now: for writes the service has already COMMITted.
  // replyTo duplicates requestId for clients that prefer that name (additive)
  send(ws, r.ok ? { type: 'ack', requestId, replyTo: requestId, ok: true, data: toAckData(r.result) } : { type: 'ack', requestId, replyTo: requestId, ok: false, error: r.error });
  logger.info('raw_ws.message', {
    collectorId: identity.collectorId,
    type,
    requestId,
    ok: r.ok,
    code: r.ok ? undefined : r.error.code,
    ms: Date.now() - started,
    delivered: ws.readyState === WebSocket.OPEN, // false: closed before ACK, phone will resend (idempotent)
  });
}

function onConnection(ws: WebSocket, identity: CollectorIdentity, req: IncomingMessage) {
  const conn: Connection = { identity, alive: true, connectedAt: Date.now(), messages: {} };
  connections.set(ws, conn);
  logger.info('raw_ws.collector.connected', { collectorId: identity.collectorId, deviceId: identity.clientDeviceId, ip: clientIp(req) });
  collectorService.socketConnected(identity);

  ws.on('pong', () => {
    conn.alive = true;
  });
  ws.on('message', (data) => {
    conn.alive = true;
    let type = 'unparsed';
    try {
      type = String(JSON.parse(data.toString())?.type ?? 'no-type');
    } catch {
      /* counted as unparsed */
    }
    conn.messages[type] = (conn.messages[type] ?? 0) + 1;
    void handleMessage(ws, identity, data);
  });
  ws.on('error', (err) => {
    logger.warn('raw_ws.collector.error', { collectorId: identity.collectorId, message: err.message });
  });
  // A disconnect is a network event, NOT the end of a CollectionSession.
  ws.on('close', (code, reason) => {
    connections.delete(ws);
    logger.info('raw_ws.collector.disconnected', {
      collectorId: identity.collectorId,
      deviceId: identity.clientDeviceId,
      code,
      reason: reason.toString() || undefined,
      // Diagnostics: an open connection with only a few hundred bytes in means the app sent no data messages.
      seconds: Math.round((Date.now() - conn.connectedAt) / 1000),
      bytesIn: req.socket.bytesRead,
      bytesOut: req.socket.bytesWritten,
      messages: conn.messages,
    });
    collectorService.socketDisconnected(identity);
  });
}

export function registerRawCollectorGateway(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', async (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname.startsWith(SOCKET_IO_PATH)) return; // Socket.IO's own upgrade listener handles it
    socket.on('error', () => undefined);

    if (pathname !== RAW_COLLECTOR_WS_PATH) {
      logger.warn('raw_ws.unknown_path', { path: pathname, ip: clientIp(req) });
      return rejectUpgrade(socket, 404, { code: 'WS_PATH_NOT_FOUND', message: `WebSocket endpoint is ${RAW_COLLECTOR_WS_PATH}` });
    }

    const authorization = req.headers.authorization;
    const bearer = authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
    const deviceHeader = req.headers['x-device-id'];
    const deviceId = (Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader)?.trim() || undefined;
    logger.info('raw_ws.collector.upgrade', {
      ip: clientIp(req),
      authorization: authorization ? (bearer ? 'bearer' : 'malformed') : 'missing', // never the token itself
      deviceId: deviceId ?? null,
    });

    let identity: CollectorIdentity;
    try {
      if (authorization && !bearer) {
        throw AppError.unauthorized('INVALID_TOKEN', 'Authorization header must be "Bearer <accessToken>"');
      }
      identity = await authenticateCollector(bearer, deviceId, { deviceIdRequired: true });
    } catch (err) {
      const { status, body } = toErrorBody(err);
      logger.warn('raw_ws.collector.rejected', { ip: clientIp(req), status, code: body.code, deviceId: deviceId ?? null });
      return rejectUpgrade(socket, status, { code: body.code, message: body.message });
    }

    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, identity, req));
  });

  // Heartbeat: URLSessionWebSocketTask answers pings automatically; a phone that vanished
  // (Wi-Fi off, app killed) is terminated so the preview shows it offline.
  const timer = setInterval(() => {
    for (const [ws, conn] of connections) {
      if (!conn.alive) {
        ws.terminate();
        continue;
      }
      conn.alive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  timer.unref();

  return wss;
}

/** Closes every raw WebSocket of a collector (used after the collector ID is deleted). */
export function closeRawCollectorConnections(collectorId: string): number {
  let count = 0;
  for (const [ws, conn] of connections) {
    if (conn.identity.collectorId === collectorId) {
      ws.close(4004, 'Collector deleted');
      count++;
    }
  }
  return count;
}
