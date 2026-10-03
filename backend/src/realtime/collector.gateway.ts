import type { Namespace, Server, Socket } from 'socket.io';
import { logger } from '../common/logger.js';
import { collectorService } from '../modules/collectors/collector.service.js';
import { collectorSocketAuth, type CollectorSocketData } from './socket-auth.middleware.js';
import { COLLECTOR_EVENTS, runCollectorEvent } from './collector-events.js';

type Ack = (response: unknown) => void;

/**
 * Registers one event so that the ACK is sent only after the handler (and its DB COMMIT) finished.
 * Error ACK: { ok: false, error: { code, message, status, retryable, details? } }
 */
function on(socket: Socket, event: string) {
  const { identity } = socket.data as CollectorSocketData;
  socket.on(event, async (...args: unknown[]) => {
    const ack = typeof args[args.length - 1] === 'function' ? (args.pop() as Ack) : undefined;
    let payload = args[0];
    if (typeof payload === 'string') {
      // Some Swift clients send Codable JSON as a string; accept both.
      try {
        payload = JSON.parse(payload);
      } catch {
        /* leave as-is, validation will reject it */
      }
    }
    const r = await runCollectorEvent('socket.io', identity, event, payload);
    ack?.(r.ok ? r.result : { ok: false, error: r.error });
  });
}

let collectorNsp: Namespace | null = null;

/** Force-disconnects every socket of a collector (used after the collector ID is deleted). */
export function disconnectCollectorSockets(collectorId: string): number {
  if (!collectorNsp) return 0;
  let count = 0;
  for (const socket of collectorNsp.sockets.values()) {
    if ((socket.data as CollectorSocketData).identity?.collectorId === collectorId) {
      socket.disconnect(true);
      count++;
    }
  }
  return count;
}

export function registerCollectorGateway(io: Server) {
  const nsp = io.of('/collector');
  collectorNsp = nsp;
  nsp.use(collectorSocketAuth);

  nsp.on('connection', (socket) => {
    const { identity } = socket.data as CollectorSocketData;
    logger.info('collector.connected', { collectorId: identity.collectorId, deviceId: identity.clientDeviceId, socketId: socket.id });
    collectorService.socketConnected(identity);

    for (const event of COLLECTOR_EVENTS) {
      on(socket, event);
      on(socket, event.replace(':', '.')); // dot-style alias
    }

    // A disconnect is a network event, NOT the end of a CollectionSession.
    socket.on('disconnect', (reason) => {
      logger.info('collector.disconnected', { collectorId: identity.collectorId, socketId: socket.id, reason });
      collectorService.socketDisconnected(identity);
    });
  });
}
