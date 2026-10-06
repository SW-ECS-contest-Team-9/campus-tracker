import http from 'node:http';
import os from 'node:os';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { checkDatabase, pool } from './config/database.js';
import { logger } from './common/logger.js';
import { createApp } from './app.js';
import { registerCollectorGateway } from './realtime/collector.gateway.js';
import { registerPreviewGateway } from './realtime/preview.gateway.js';
import { realtimeState } from './realtime/realtime-state.service.js';
import { sessionRepository } from './modules/sessions/session.repository.js';
import { fusionService } from './modules/fusion/fusion.service.js';
import { RAW_COLLECTOR_WS_PATH, registerRawCollectorGateway } from './realtime/raw-ws.gateway.js';
import { listenMobilityChanges } from './modules/mobility/mobility.listener.js';
import { listenEditorChanges } from './modules/editor/editor.listener.js';
import { registerEditorGateway } from './realtime/editor.gateway.js';

const app = createApp();
const httpServer = http.createServer(app);

// Requests that never become valid HTTP (e.g. a client speaking https/wss/TLS to this plain-HTTP port).
// These never reach Express or Socket.IO, so log them here.
httpServer.on('clientError', (err: NodeJS.ErrnoException & { rawPacket?: Buffer }, socket) => {
  const first = err.rawPacket?.[0];
  logger.warn('http.client_error', {
    ip: (socket as import('node:net').Socket).remoteAddress,
    code: err.code,
    message: err.message,
    hint: first === 0x16 ? 'TLS handshake received: the client is using https:// or wss://, but this server is plain http://' : undefined,
  });
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

const io = new Server(httpServer, {
  cors: { origin: env.corsOrigins },
  // Recovered offline batches can be large; default is 1 MB.
  maxHttpBufferSize: 10 * 1024 * 1024,
  pingInterval: 10_000,
  pingTimeout: 10_000,
  // Other upgrade paths (/ws/collector) belong to the raw WebSocket gateway; don't let engine.io close them.
  destroyUpgrade: false,
});

// Low-level handshake failures (wrong path, unsupported protocol version, bad transport...).
io.engine.on('connection_error', (err: { req?: { url?: string; socket?: { remoteAddress?: string } }; code?: number; message?: string }) => {
  logger.warn('socket.engine_error', { url: err.req?.url, ip: err.req?.socket?.remoteAddress, code: err.code, message: err.message });
});

// The default namespace "/" has no handlers. A client connected here looks "connected" but
// nothing it emits is processed -> phones must use /collector, browsers /preview.
io.on('connection', (socket) => {
  logger.warn('socket.default_namespace', {
    ip: socket.handshake.address,
    hint: 'Connect to the /collector namespace (e.g. http://<host>:<port>/collector), not "/"',
  });
  socket.onAny((event) => logger.warn('socket.default_namespace_event_ignored', { event }));
});

registerCollectorGateway(io);
registerPreviewGateway(io);
registerEditorGateway(io);
registerRawCollectorGateway(httpServer);

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
}

async function main() {
  if (await checkDatabase()) {
    logger.info('db.connected', { url: env.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@') });
    // A restart is not the end of any collection session: restore state from the DB.
    const active = await sessionRepository.activeSessionsByCollector();
    realtimeState.hydrate(active);
    await fusionService.recoverPending();
    listenMobilityChanges(); // QGIS edits -> preview
    listenEditorChanges(); // authored network edits -> collaborative editor
    logger.info('sessions.restored', { activeSessions: active.length });
  } else logger.error('db.unavailable', { hint: 'npm run db:up && npm run db:migrate' });

  httpServer.listen(env.PORT, env.HOST, () => {
    const urls = lanAddresses().map((a) => `http://${a}:${env.PORT}`);
    logger.info('server.started', {
      port: env.PORT,
      iphoneServerUrls: urls,
      collectorSocket: urls.map((u) => `${u}/collector`),
      collectorWebSocket: urls.map((u) => `${u.replace(/^http/, 'ws')}${RAW_COLLECTOR_WS_PATH}`),
      preview: 'http://localhost:5173',
    });
  });
}

function shutdown(signal: string) {
  logger.info('server.stopping', { signal });
  io.close();
  httpServer.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void main();
