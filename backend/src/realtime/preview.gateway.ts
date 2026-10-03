import type { Namespace, Server } from 'socket.io';
import { logger } from '../common/logger.js';
import { realtimeState, type CollectorRealtimeState } from './realtime-state.service.js';

// /preview namespace: PC browsers, read-only, no login (internal tool; CORS-restricted).
// Services call previewBroadcast.* only AFTER their DB transaction committed.

let nsp: Namespace | null = null;

export interface LocationUpdateEvent {
  collectorId: string;
  sessionId: string;
  sequence: number;
  longitude: number;
  latitude: number;
  altitude: number | null;
  ellipsoidalAltitude: number | null;
  horizontalAccuracy: number | null;
  verticalAccuracy: number | null;
  timestamp: string;
}

export function registerPreviewGateway(io: Server) {
  nsp = io.of('/preview');
  nsp.on('connection', (socket) => {
    logger.info('preview.connected', { socketId: socket.id, clients: nsp?.sockets.size });
    socket.emit('preview:snapshot', { collectors: realtimeState.all(), serverTime: new Date().toISOString() });
    socket.on('disconnect', () => logger.info('preview.disconnected', { socketId: socket.id }));
  });
}

function emit(event: string, payload: unknown) {
  nsp?.emit(event, payload);
}

export const previewBroadcast = {
  collectorConnected: (state: CollectorRealtimeState) => emit('collector:connected', state),
  collectorDisconnected: (state: CollectorRealtimeState) => emit('collector:disconnected', state),
  collectorCreated: (state: CollectorRealtimeState) => emit('collector:created', state),
  collectorRemoved: (payload: { collectorId: string; sessionIds: string[] }) => emit('collector:removed', payload),
  collectorStatus: (state: CollectorRealtimeState) => emit('collector:status', state),
  sessionStarted: (session: unknown) => emit('session:started', session),
  sessionFinished: (session: unknown) => emit('session:finished', session),
  locationUpdate: (location: LocationUpdateEvent) => emit('location:update', location),
  /** Derived fusion output (raw location:update is unchanged). */
  positionFused: (position: unknown) => emit('position:fused', position),
  /** A session's fused results of one version were recomputed: clients reload them via REST. */
  fusionReprocessed: (payload: { sessionId: string; collectorId: string; algorithmVersion: string; count: number }) =>
    emit('fusion:reprocessed', payload),
  spatialGpsDecisions: (payload: { sessionId: string; collectorId: string; algorithmVersion: string; decisions: unknown[] }) =>
    emit('spatial:gps-decisions', payload),
  fusionSensorEvents: (payload: { sessionId: string; collectorId: string; algorithmVersion: string; events: unknown[] }) =>
    emit('fusion:sensor-events', payload),
  markerCreated: (marker: unknown) => emit('marker:created', marker),
};
