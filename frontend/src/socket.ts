import { io } from 'socket.io-client';
import { API_BASE_URL, type CollectorState, type FusedUpdate, type LocationUpdate, type Marker, type Session } from './api';

export interface PreviewHandlers {
  onConnectionChange(connected: boolean): void;
  /** Called on every (re)connect after the first one: reload REST state. */
  onReconnect(): void;
  onSnapshot(collectors: CollectorState[]): void;
  onCollectorState(state: CollectorState): void;
  onCollectorRemoved(payload: { collectorId: string; sessionIds: string[] }): void;
  onSessionStarted(session: Session): void;
  onSessionFinished(session: Session): void;
  onLocation(update: LocationUpdate): void;
  onMarker(marker: Marker): void;
  onFused(update: FusedUpdate): void;
  onFusionReprocessed(payload: { sessionId: string; collectorId: string; algorithmVersion: string; count: number }): void;
  onSpatialGpsDecisions(payload: { sessionId: string; collectorId: string; algorithmVersion: string; decisions: import('./api').SpatialGpsDecision[] }): void;
  onFusionSensorEvents(payload: { sessionId: string; collectorId: string; algorithmVersion: string; events: import('./api').FusionSensorEvent[] }): void;
}

export function connectPreview(h: PreviewHandlers) {
  const socket = io(`${API_BASE_URL}/preview`, { transports: ['websocket', 'polling'] }); // '/preview' = same origin
  let connectedOnce = false;

  socket.on('connect', () => {
    h.onConnectionChange(true);
    if (connectedOnce) h.onReconnect();
    connectedOnce = true;
  });
  socket.on('disconnect', () => h.onConnectionChange(false));
  socket.on('connect_error', () => h.onConnectionChange(false));

  socket.on('preview:snapshot', (p: { collectors: CollectorState[] }) => h.onSnapshot(p.collectors));
  socket.on('collector:connected', h.onCollectorState);
  socket.on('collector:disconnected', h.onCollectorState);
  socket.on('collector:status', h.onCollectorState);
  socket.on('collector:created', h.onCollectorState);
  socket.on('collector:removed', h.onCollectorRemoved);
  socket.on('session:started', h.onSessionStarted);
  socket.on('session:finished', h.onSessionFinished);
  socket.on('location:update', h.onLocation);
  socket.on('marker:created', h.onMarker);
  socket.on('position:fused', h.onFused);
  socket.on('fusion:reprocessed', h.onFusionReprocessed);
  socket.on('spatial:gps-decisions', h.onSpatialGpsDecisions);
  socket.on('fusion:sensor-events', h.onFusionSensorEvents);
  return socket;
}
