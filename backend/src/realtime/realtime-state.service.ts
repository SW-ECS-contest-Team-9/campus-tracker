// In-memory state of collectors for the live preview. Not persisted on purpose:
// a server restart resets it, the raw data is in PostGIS.

export interface LatestLocation {
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

export interface LatestFused {
  sessionId: string;
  fusionSequence: number;
  longitude: number;
  latitude: number;
  ellipsoidalAltitude: number | null;
  heading: number | null;
  horizontalConfidence: number;
  verticalConfidence: number;
  overallConfidence: number;
  source: string;
  algorithmVersion: string;
  timestamp: string;
}

export interface CollectorRealtimeState {
  collectorId: string;
  socketConnected: boolean;
  connectionCount: number;
  activeSessionId: string | null;
  lastSeenAt: string | null;
  latestLocation: LatestLocation | null;
  /** Latest realtime fusion output (derived) */
  latestFused: LatestFused | null;
  /** As reported by the iPhone via collector:status */
  collecting: boolean;
  sampleCounts: { location: number; motion: number } | null;
  pendingBatchCount: number | null;
  /** Newest sensor timestamp received / server time of the newest batch (delayed upload => they differ). */
  lastCapturedAt: string | null;
  lastReceivedAt: string | null;
  /** Counted by the server from committed batches since server start */
  receivedCounts: { batches: number; locations: number; motion: number; altimeter: number; pedometer: number; markers: number };
}

const states = new Map<string, CollectorRealtimeState>();

function now() {
  return new Date().toISOString();
}

function getOrCreate(collectorId: string): CollectorRealtimeState {
  let state = states.get(collectorId);
  if (!state) {
    state = realtimeState.empty(collectorId);
    states.set(collectorId, state);
  }
  return state;
}

export const realtimeState = {
  empty(collectorId: string): CollectorRealtimeState {
    return {
      collectorId,
      socketConnected: false,
      connectionCount: 0,
      activeSessionId: null,
      lastSeenAt: null,
      latestLocation: null,
      latestFused: null,
      collecting: false,
      sampleCounts: null,
      pendingBatchCount: null,
      lastCapturedAt: null,
      lastReceivedAt: null,
      receivedCounts: { batches: 0, locations: 0, motion: 0, altimeter: 0, pedometer: 0, markers: 0 },
    };
  },

  get(collectorId: string): CollectorRealtimeState | undefined {
    return states.get(collectorId);
  },

  all(): CollectorRealtimeState[] {
    return [...states.values()];
  },

  connected(collectorId: string): CollectorRealtimeState {
    const s = getOrCreate(collectorId);
    s.connectionCount += 1;
    s.socketConnected = true;
    s.lastSeenAt = now();
    return s;
  },

  /** Returns null if the collector is unknown (e.g. deleted while connected). */
  disconnected(collectorId: string): CollectorRealtimeState | null {
    const s = states.get(collectorId);
    if (!s) return null;
    s.connectionCount = Math.max(0, s.connectionCount - 1);
    s.socketConnected = s.connectionCount > 0;
    s.lastSeenAt = now();
    return s;
  },

  sessionStarted(collectorId: string, sessionId: string): CollectorRealtimeState {
    const s = getOrCreate(collectorId);
    s.activeSessionId = sessionId;
    s.collecting = true;
    s.lastSeenAt = now();
    return s;
  },

  sessionEnded(collectorId: string, sessionId: string): CollectorRealtimeState {
    const s = getOrCreate(collectorId);
    if (s.activeSessionId === sessionId) {
      s.activeSessionId = null;
      s.collecting = false;
    }
    s.lastSeenAt = now();
    return s;
  },

  batchCommitted(
    collectorId: string,
    counts: { locations: number; motion: number; altimeter: number; pedometer: number },
    latest: LatestLocation | null,
    maxCapturedAt: string | null = null,
  ): CollectorRealtimeState {
    const s = getOrCreate(collectorId);
    s.lastReceivedAt = now();
    if (maxCapturedAt && (!s.lastCapturedAt || maxCapturedAt > s.lastCapturedAt)) s.lastCapturedAt = maxCapturedAt;
    s.receivedCounts.batches += 1;
    s.receivedCounts.locations += counts.locations;
    s.receivedCounts.motion += counts.motion;
    s.receivedCounts.altimeter += counts.altimeter;
    s.receivedCounts.pedometer += counts.pedometer;
    // Late (recovered) batches must not move the "current position" backwards:
    // ignore points of a session other than the active one, and older sequences of the same session.
    const otherSession = s.activeSessionId !== null && latest?.sessionId !== s.activeSessionId;
    // "older" by SENSOR time (delayed backlog must not move the current point back)
    const older = latest && s.latestLocation?.sessionId === latest.sessionId && Date.parse(latest.timestamp) <= Date.parse(s.latestLocation.timestamp);
    if (latest && !otherSession && !older) {
      s.latestLocation = latest;
    }
    s.lastSeenAt = now();
    return s;
  },

  fusedUpdated(collectorId: string, fused: LatestFused): CollectorRealtimeState {
    const s = getOrCreate(collectorId);
    const otherSession = s.activeSessionId !== null && fused.sessionId !== s.activeSessionId;
    if (!otherSession) s.latestFused = fused;
    return s;
  },

  /** After a server restart: restore collection state from the DB (the DB, not memory, owns sessions). */
  hydrate(rows: { collectorId: string; sessionId: string; lastCapturedAt: Date | null; lastReceivedAt: Date | null }[]) {
    for (const r of rows) {
      const s = getOrCreate(r.collectorId);
      s.activeSessionId ??= r.sessionId;
      s.lastCapturedAt ??= r.lastCapturedAt?.toISOString() ?? null;
      s.lastReceivedAt ??= r.lastReceivedAt?.toISOString() ?? null;
    }
  },

  remove(collectorId: string) {
    states.delete(collectorId);
  },

  markerCreated(collectorId: string): CollectorRealtimeState {
    const s = getOrCreate(collectorId);
    s.receivedCounts.markers += 1;
    s.lastSeenAt = now();
    return s;
  },

  statusReported(
    collectorId: string,
    status: { sessionId?: string | null; collecting: boolean; locationSampleCount?: number | null; motionSampleCount?: number | null; pendingBatchCount?: number | null },
  ): CollectorRealtimeState {
    const s = getOrCreate(collectorId);
    s.collecting = status.collecting;
    if (status.sessionId) s.activeSessionId = status.sessionId;
    s.sampleCounts = { location: status.locationSampleCount ?? 0, motion: status.motionSampleCount ?? 0 };
    s.pendingBatchCount = status.pendingBatchCount ?? null;
    s.lastSeenAt = now();
    return s;
  },
};
