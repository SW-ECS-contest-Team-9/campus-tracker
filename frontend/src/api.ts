// REST client + shared types (mirrors backend DTOs).

// Empty = same origin as the page (the Vite dev server proxies /api and /socket.io to the backend).
// Set VITE_API_BASE_URL only to point the preview at a backend somewhere else.
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export type SessionStatus = 'ACTIVE' | 'FINISHED' | 'INTERRUPTED';

export interface LocationPoint {
  sequence: number;
  longitude: number;
  latitude: number;
  altitude: number | null;
  ellipsoidalAltitude: number | null;
  horizontalAccuracy: number | null;
  verticalAccuracy: number | null;
  timestamp: string;
}

/** /preview location:update */
export interface LocationUpdate extends LocationPoint {
  collectorId: string;
  sessionId: string;
}

export interface Session {
  sessionId: string;
  clientSessionId: string;
  collectorId: string;
  device: { deviceModel: string | null; clientDeviceId: string; appVersion: string | null; systemVersion: string | null };
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  locationCount: number;
  markerCount: number;
  lastLocationAt: string | null;
}

/** Building level calibration from a field session (buildings:calibrate). Heights are orthometric (Incheon MSL). */
export interface BuildingCalibration { entrancePhoneOrthometricM: number; entranceFloorOrthometricM: number; floorHeightM: number }
export interface TerrainSummary {
  id: string;
  geoidSeparationM: number;
  buildings: { buildingId: string; name: string | null; groundFloors: number | null; undergroundFloors: number | null; calibration: BuildingCalibration | null }[];
}

export interface Marker {
  markerId: string;
  sessionId: string;
  collectorId?: string;
  timestamp: string;
  type: string;
  note: string | null;
  latitude: number;
  longitude: number;
  altitude: number | null;
  ellipsoidalAltitude: number | null;
  horizontalAccuracy: number | null;
  verticalAccuracy: number | null;
  /** fusion-v4 estimate at the marker time: drawn at this height instead of the phone altitude */
  fused?: { algorithmVersion: string; latitude: number; longitude: number; ellipsoidalAltitude: number | null; heightAboveGround: number | null; zDatumSource: string | null; buildingName: string | null } | null;
}

/** Derived sensor-fusion output (fused_positions / position:fused). Raw GPS is never modified. */
export interface FusedPosition {
  fusionSequence: number;
  longitude: number;
  latitude: number;
  ellipsoidalAltitude: number | null;
  heading: number | null;
  horizontalConfidence: number; // heuristic 0..1 score, not a probability
  verticalConfidence: number;
  overallConfidence: number;
  gpsHorizontalAccuracy: number | null;
  gpsVerticalAccuracy?: number | null;
  source: 'GPS_ANCHORED' | 'GPS_CORRECTED' | 'FUSED' | 'PDR_PREDICTED' | 'GPS_REANCHOR' | 'STATIONARY_HOLD' | 'HELD' | string;
  algorithmVersion: string;
  timestamp: string;
  // diagnostics (fusion-v2+; null for v1)
  gpsUsed?: boolean | null;
  gpsRejectReason?: string | null;
  gpsSequence?: number | null;
  innovationDistance?: number | null;
  stationary?: boolean | null;
  headingSource?: string | null;
  horizontalUncertainty?: number | null;
  // v2.1 diagnostics
  localX?: number | null;
  localY?: number | null;
  localZ?: number | null;
  gpsQuality?: string | null;
  pdrApplied?: boolean | null;
  pdrRejectReason?: string | null;
  relativeAltitude?: number | null;
  reanchored?: boolean | null;
  reanchorReason?: string | null;
  divergenceDetected?: boolean | null;
  spatialMapVersionId?: string | null;
  spatialStatus?: string | null;
  buildingId?: string | null;
  buildingName?: string | null;
  buildingMatchStatus?: string | null;
  spatialSegmentId?: number | null;
  // fusion-v4 rev 2: absolute height from the campus terrain (DEM)
  terrainHeight?: number | null; // orthometric (Incheon MSL) ground height under the point
  heightAboveGround?: number | null;
  zDatumSource?: 'TERRAIN' | 'GPS' | 'NONE' | string | null;
  zDatumSigma?: number | null;
}

export interface SpatialMap {
  mapVersionId: string | null;
  campus: number[][][][][];
  buildings: { buildingId: string; buildingName: string | null; coordinates: number[][][][] }[];
}

export interface SpatialGpsDecision {
  sequence: number;
  timestamp: string | number;
  spatialMapVersionId: string | null;
  campusStatus: string;
  anchorAccepted: boolean;
  reason: string;
  horizontalAccuracy: number | null;
  boundaryDistanceM: number | null;
  buildingId: string | null;
  buildingName: string | null;
}

export interface FusionSensorEvent {
  timestamp: string;
  eventType: string;
  details: Record<string, unknown>;
}

export interface FusionVersions {
  active: string;
  versions: { version: string; description: string; configHash: string }[];
}

export interface FusionRun {
  algorithmVersion: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  trigger: string;
  completedAt: string | null;
  outputCount: number | null;
  error: string | null;
  reanchors: number | null;
  divergences: number | null;
  warnings: { code: string; message: string }[] | null;
  metrics: {
    rawGpsCount: number;
    fusionOutputCount: number;
    gpsAccepted: number;
    gpsRejected: number;
    rejectedPct: number | null;
    rejectReasons: Record<string, number>;
    stationarySeconds: number | null;
    medianGpsHorizontalAccuracy: number | null;
    maxRejectedInnovation: number | null;
    fusedPathLengthM: number;
    rawGpsPathLengthM: number;
    sources: Record<string, number>;
    sensorTracking?: { trackingStatus: string; headingStatus: string; fallbackStepDistanceM: number; horizontalUncertaintyM: number | null } | null;
    reanchors?: number | null;
    divergences?: number | null;
    validation?: {
      durationS: number;
      pedometerPathM: number;
      usableGpsMaxDisplacementM: number;
      fusedMaxDisplacementM: number;
      allowedDisplacementM: number;
      displacementRatio: number | null;
      fusedZRangeM: number | null;
      altimeterRangeM: number | null;
      outputsPerMinute: number | null;
      warnings: { code: string; message: string }[];
    };
  } | null;
}

/** /preview position:fused */
export interface FusedUpdate extends FusedPosition {
  collectorId: string;
  sessionId: string;
}

export interface ReprocessSummary {
  algorithmVersion: string;
  observations: number;
  outputs: number;
  metrics: FusionRun['metrics'];
  durationMs: number;
}

export interface CollectorState {
  collectorId: string;
  socketConnected: boolean;
  activeSessionId: string | null;
  lastSeenAt: string | null;
  latestLocation: (LocationPoint & { sessionId: string }) | null;
  latestFused: (FusedPosition & { sessionId: string }) | null;
  collecting: boolean;
  sampleCounts: { location: number; motion: number } | null;
  pendingBatchCount: number | null;
  receivedCounts: { batches: number; locations: number; motion: number; altimeter: number; pedometer: number; markers: number };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `HTTP ${res.status} ${path}`);
  }
  return res.json() as Promise<T>;
}

async function send<T>(method: 'POST' | 'DELETE', path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status} ${path}`);
  return json as T;
}

export interface CollectorSummary {
  collectorId: string;
  createdAt: string;
  deviceCount: number;
  sessionCount: number;
  activeSessionCount: number;
  locationCount: number;
  markerCount: number;
}

/** Must match the backend (COLLECTOR_DELETE_CONFIRM_TEXT). */
export const DELETE_CONFIRM_TEXT = '제거하겠습니다.';

export const api = {
  collectors: () => get<CollectorState[]>('/api/v1/collectors'),
  sessions: (params: { collectorId?: string; status?: SessionStatus; limit?: number } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    return get<Session[]>(`/api/v1/sessions?${q}`);
  },
  session: (id: string) => get<Session>(`/api/v1/sessions/${id}`),
  locations: (id: string) => get<LocationPoint[]>(`/api/v1/sessions/${id}/locations`),
  markers: (id: string) => get<Marker[]>(`/api/v1/sessions/${id}/markers`),
  fusedPositions: (id: string, algorithmVersion: string) =>
    get<FusedPosition[]>(`/api/v1/sessions/${id}/fused-positions?algorithmVersion=${encodeURIComponent(algorithmVersion)}`),
  spatialDecisions: (id: string, algorithmVersion: string) =>
    get<SpatialGpsDecision[]>(`/api/v1/sessions/${id}/spatial-decisions?algorithmVersion=${encodeURIComponent(algorithmVersion)}`),
  fusionSensorEvents: (id: string, algorithmVersion: string) =>
    get<FusionSensorEvent[]>(`/api/v1/sessions/${id}/fusion-events?algorithmVersion=${encodeURIComponent(algorithmVersion)}`),
  reprocessFusion: (id: string, algorithmVersion: string) =>
    send<ReprocessSummary>('POST', `/api/v1/sessions/${id}/fusion/reprocess`, { algorithmVersion, force: true }),
  fusionSummary: (id: string) => get<{ runs: FusionRun[] }>(`/api/v1/sessions/${id}/fusion`),
  fusionVersions: () => get<FusionVersions>('/api/v1/fusion/versions'),
  terrain: () => get<TerrainSummary>('/api/v1/terrain'),
  spatialMap: () => get<SpatialMap>('/api/v1/spatial/map'),
  /** Empty collectorId -> server picks the next free C<nn>. */
  createCollector: (collectorId?: string) => send<CollectorState>('POST', '/api/v1/collectors', { collectorId }),
  collectorSummary: (collectorId: string) => get<CollectorSummary>(`/api/v1/collectors/${encodeURIComponent(collectorId)}`),
  deleteCollector: (collectorId: string, confirmText: string) =>
    send<{ ok: true }>('DELETE', `/api/v1/collectors/${encodeURIComponent(collectorId)}`, { confirmText }),
};
