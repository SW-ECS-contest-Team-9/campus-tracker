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
  // collection / sync / fusion state (separate concepts; see track-display.ts sessionStateLines)
  interrupted?: boolean;
  finishRequestedAt?: string | null;
  finalizedAt?: string | null;
  lastCapturedAt?: string | null;
  lastReceivedAt?: string | null;
  outOfOrderBatches?: number;
  needsReprocess?: boolean;
  fusionState?: string | null;
  syncState?: 'LIVE' | 'DELAYED' | 'OFFLINE' | 'FINALIZED';
  /** null = may be interrupted by hand; otherwise why not (NOT_ACTIVE / COLLECTOR_CONNECTED / RECENTLY_RECEIVED) */
  manualInterruptBlock?: string | null;
  /** only in the session detail (GET /sessions/:id) */
  raw?: { syncManifest?: { synchronized?: boolean; comparedAt?: string; streams?: Record<string, { expected: number | null; server: number | null; synchronized: boolean }> } | null; batches?: number; outOfOrderBatches?: number } | null;
}

/** What a replay did (fusion_runs.metrics.replay, rev 7+): its input boundary and which stages it stored. */
export interface ReplayRecord {
  mode: 'SENSOR_TIME' | 'AS_RECEIVED';
  ordering: 'SENSOR_TIME' | 'ARRIVAL_BATCHES';
  published: boolean;
  continuesLive: boolean;
  finalizeRequested: boolean;
  finalizeApplied: boolean;
  sessionStatusAtRun: string;
  input: { cutoff: string | null; counts: { locations: number; motion: number; altimeter: number; pedometer: number }; firstSensorAt: string | null; lastSensorAt: string | null; hash: string };
  asReceived: { batches: number; outOfOrderBatches: number; skippedLateObservations: number } | null;
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
    /** v4, smoothed runs only: the vertical datum summary */
    terrain?: unknown;
    replay?: ReplayRecord | null;
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


// ---- Lab (docs/MOBILITY_MAP_PLAN.md): run snapshots, qc-v1, routes, canonical paths, validation ----
export interface LabRun {
  id: string;
  sessionId: string;
  algorithmVersion: string;
  revision: number | null;
  variant: string | null;
  overrides: Record<string, unknown> | null;
  mode: 'SENSOR_TIME' | 'AS_RECEIVED';
  codeRef: string | null;
  published: boolean;
  pinned: boolean;
  status: string;
  trigger: string;
  startedAt: string;
  completedAt: string | null;
  outputCount: number | null;
  metrics: { fusedPathLengthM?: number; gpsAccepted?: number; gpsRejected?: number; validation?: { warnings: { code: string }[] }; replay?: ReplayRecord | null; terrain?: unknown } | null;
  error: string | null;
}
export interface RunPosition {
  seq: number; t: number; latitude: number; longitude: number; x: number; y: number; h: number | null; zRel: number | null;
  sigmaH: number | null; heading: number | null; source: string; zDatumSource: string | null; zDatumSigma: number | null;
  heightAboveGround: number | null; buildingName: string | null; gpsUsed: boolean | null; gpsSequence: number | null; stationary: boolean | null;
}
export interface RunFix { seq: number; t: number; forwardUsed: boolean; forwardReason: string | null; innovation: number | null; finalWeight: number | null; finalResidual: number | null }
export interface RunEvent { t: number; type: string; details: Record<string, unknown> }
export interface QcDecision { seq: number; t: number; status: 'ACCEPTED' | 'SUSPECT' | 'REJECTED'; reasons: string[]; details: Record<string, unknown> }
export interface RouteEnd { x: number; y: number; latitude: number; longitude: number }
export interface LabRoute {
  id: string; name: string; frameId: string; a: RouteEnd; b: RouteEnd; radiusM: number; widthM: number;
  fusionVersion: string; fusionVariant: string | null; notes: string | null; passes: number; canonicalPathId: string | null;
}
export interface RoutePass {
  id: string; routeId: string; runId: string; sessionId: string; tStart: number; tEnd: number; direction: 'AB' | 'BA'; source: 'AUTO' | 'MANUAL';
  excluded: boolean; status: string | null; reasons: string[]; flipped: boolean; metrics: Record<string, number | null>;
}
export interface ValidationMetrics {
  method: string; passes: number;
  pooled: { stations: number; medianXY: number | null; p95XY: number | null; maxXY: number | null; medianZ: number | null; p95Z: number | null; corridorCoverage: number | null };
  perPass: { id: string; stations: number; medianXY: number | null; p95XY: number | null; maxXY: number | null; medianZ: number | null; corridorCoverage: number | null }[];
  rejectedPointRatio: number | null; fusionDownweightedRatio: number | null; markerSpreadM: number | null;
  markerClusters: { type: string; count: number; medianSpreadM: number | null }[];
}
export interface RouteDetail extends Omit<LabRoute, 'passes'> { passes: RoutePass[]; reports: { id: string; method: string; metrics: ValidationMetrics; createdAt: string }[] }
export interface CanonicalPoint {
  idx: number; s: number; x: number; y: number; z: number | null; latitude: number; longitude: number; sampleCount: number;
  sigmaXY: number | null; sigmaZ: number | null; seXY: number | null; halfWidthM: number; confidence: number; lowSamples: boolean; contributors: string[];
}
export interface CanonicalSummary {
  algorithm: string; paramsHash: string; points: number; lengthM: number; iterations: number; zRelative: boolean;
  passes: { total: number; accepted: number; partial: number; rejected: number; flipped: number };
  sigmaXY: { median: number | null; p95: number | null }; halfWidthM: { median: number | null }; confidence: { median: number | null }; lowSampleFraction: number | null;
}
export interface CanonicalPath { id: string; routeId: string; algorithm: string; metrics: CanonicalSummary; createdAt: string; codeRef: string | null; points: CanonicalPoint[] }
export interface ValidationReport {
  id: string; metrics: ValidationMetrics;
  errors: { id: string; errors: { s: number; latitude: number; longitude: number; footLatitude: number; footLongitude: number; d: number; dz: number | null; inside: boolean }[] }[];
}


// ---- campus 3D scene (docs/CAMPUS_3D_PREVIEW_PLAN.md) ----
export interface SceneBuilding {
  buildingId: string;
  name: string | null;
  heightM: number;
  heightSource: 'REGISTER' | 'ESTIMATE' | string;
  registerId: string | null;
  groundFloors: number | null;
  baseM: number;
  roofM: number;
  terrainMinM: number | null;
  terrainMaxM: number | null;
  note: string | null;
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
  calibration: BuildingCalibration | null;
  /** How the block looks (walls, window rows, roof), from the building notes; absent or null = a plain block. */
  appearance?: BuildingAppearance | null;
}
export type WindowStyle = 'rows' | 'bands' | 'curtain' | 'arches' | 'bays' | 'archrows' | 'piers' | 'archbays';
/** Display only (building-appearance.ts draws it). Every item carries the note's evidence grade in `grades`. */
export interface BuildingAppearance {
  /** Wall material word: brick, glass, stone, concrete, ivy, panel, metal, white. */
  wall: string;
  wallColor?: string;
  /** Window rows: one per storey at the note's floor heights (MSL), or `count` equal storeys when the note has no floor table. */
  windows?: { style: WindowStyle; floorsM?: number[]; /** F09: the floor names of the note's floor table, in the order of floorsM (absent when the building has no table) */ floorNames?: string[]; count?: number; color?: string; accent?: string; /** the lines go on above the last floor of the table up to the roof (Z07) */ toRoof?: boolean;
    /** Z11 the building's own window instead of the size of the style: width and height of one window, spacing of the windows (or pairs) along the wall, sill above the floor (m); `paired`: two windows side by side at every position. */
    widthM?: number; heightM?: number; pitchM?: number; sillM?: number; paired?: boolean };
  /**
   * Wall faces that differ from the rest (Z07), chosen by the compass direction the wall faces (degrees, north 0, east 90;
   * `spread`: how far off a wall may face, default 45): another wall material or colour, another window style ('none': no
   * windows), `columns`: that many tall columns with a beam in front of the longest wall of the face.
   */
  faces?: { azimuth: number; spread?: number; wall?: string; wallColor?: string; style?: WindowStyle | 'none'; columns?: number; /** the columns stand on this height (default: the lowest storey shown) */ columnsFromM?: number; grade?: string }[];
  /** A band of another colour on the walls above a height (upper storeys clad differently). */
  upper?: { fromM: number; color: string };
  /** B13 bands of the walls between two heights (to the top of the walls without `toM`): another material or colour, and another window style ('none': no windows) for the rows that start inside the band. */
  bands?: { fromM: number; toM?: number; wall?: string; wallColor?: string; style?: 'rows' | 'bands' | 'arches' | 'archrows' | 'none'; /** width of one window of those rows (the spacing stays the building's own) */ widthM?: number; grade?: string }[];
  /** B13 colour panels scattered irregularly over the walls from `fromM` up (cladding of stacked boxes); places and sizes are made up for the drawing. Not drawn on a face whose rule changes the material. */
  panels?: { colors: string[]; fromM?: number };
  roof?: { type: 'flat' | 'hipped' | 'shed'; /** P02 `shed`: the roof is one plane, its height from a profile along a direction ([distance m, height MSL] pairs from `origin`) */ plane?: { origin: number[]; direction: number[]; points: number[][] }; material?: string; color?: string; riseM?: number; runM?: number; eaveM?: number; /** a light band on the walls under the eave, this high (Z07) */ eaveBandM?: number; dormers?: boolean; /** P02 `gable`: every dormer is a small gable standing on the slope (a light triangle), not a panel lying on it */ dormerShape?: 'gable'; rim?: string; /** 2: a second, smaller roof above a low wall band on the first (a double eave, Z09) */ tiers?: number ;
    /** B12: the eave and the ridge as heights (MSL) instead of the stored roof height and a rise; `overhangM`: the footprint is the line of the eave and the walls stand this far inside it (a deep eave with a soffit and rafters). */
    eaveTopM?: number; ridgeM?: number; overhangM?: number };
  /** B12 a giant order: an entablature (`beamM` high) on all walls at `toM` with a dark attic strip above it, and rows of round columns from `fromM` to `toM` in an open porch on the wall whose middle is nearest to `at`. */
  order?: { fromM: number; toM: number; beamM?: number; diameterM?: number; rows?: { at: number[]; count: number }[] };
  /** B12 lower wings inside the footprint (EPSG:5186 ring each) with their own roof and order; the rest of the record applies to them as well. */
  wings?: { polygon: number[][]; roof: { eaveTopM: number; ridgeM: number; overhangM?: number }; order?: BuildingAppearance['order']; grade?: string }[];
  /** The base of the building (Z09): the foundation below the block, and the walls up to `topM` when given, in this colour without windows (a tower that stands on a podium or a retaining wall). */
  plinth?: { color: string; topM?: number };
  grades?: Record<string, string>;
  features?: { what: string; evidence: string; grade: string; drawn: boolean }[];
}
export interface CampusScene {
  id: string;
  terrainVersionId: string;
  heightMode: string;
  geoidSeparationM: number;
  buildings: SceneBuilding[];
  campus: { type: string; coordinates: number[][][][] }[];
}
export interface TerrainGrid {
  versionId: string;
  originX: number;
  originY: number;
  resolution: number;
  width: number;
  height: number;
  bounds: { west: number; south: number; east: number; north: number };
  /** row 0 = south edge, cell centers at origin + (i + 0.5) * resolution (EPSG:5186) */
  heights: Float32Array;
}


// ---- hand-drawn mobility spaces (QGIS -> PostGIS schema mobility) ----
interface MobilityBase { id: number; name: string | null; kind: string; elevationM: number | null; buildingId: string | null; floor: string | null; note: string | null; updatedAt: string }
export interface MobilityCorridor extends MobilityBase { widthM: number; oneWay: boolean; lengthM: number; geometry: { type: 'LineString'; coordinates: number[][] } }
export interface MobilityOpenArea extends MobilityBase { areaM2: number; geometry: { type: 'Polygon'; coordinates: number[][][] } }
export interface MobilityPortal extends MobilityBase { geometry: { type: 'Point'; coordinates: number[] } }
export interface MobilitySpaces { corridors: MobilityCorridor[]; openAreas: MobilityOpenArea[]; portals: MobilityPortal[] }
/** Editor road segment (carriageway or pedestrian way, no elevators), read-only for the preview. Coordinates: EPSG:5186 x, y, MSL height. */
export interface CarriagewayRoad {
  id: string; name: string | null; roadClass: 'vehicle' | 'shared' | 'pedestrian'; structure: string; vehicleAccess?: string | null; widthM: number | null; levelId: string | null; buildingId: string | null;
  fromNodeId: string; toNodeId: string; geometry: { type: 'LineString'; coordinates: number[][] };
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
  interruptSession: (id: string) => send<Session>('POST', `/api/v1/sessions/${id}/interrupt`, {}),
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
  scene: () => get<CampusScene>('/api/v1/scene'),
  mobility: () => get<MobilitySpaces>('/api/v1/mobility'),
  roads: () => get<{ roads: CarriagewayRoad[] }>('/api/v1/mobility/roads'),
  /** F09: the elevator segments (left out of roads()) and the places, read-only, for the lifted floor view and the walk. */
  elevators: () => get<{ roads: CarriagewayRoad[] }>('/api/v1/mobility/elevators'),
  places: () => get<{ places: { id: string; name: string; category: string; buildingId: string | null; levelId: string | null; geometry: { coordinates: number[] } }[] }>('/api/v1/mobility/places'),
  terrainGrid: async (): Promise<TerrainGrid> => {
    const res = await fetch(`${API_BASE_URL}/api/v1/terrain/grid`);
    if (!res.ok) throw new Error(`terrain grid: HTTP ${res.status}`);
    const meta = JSON.parse(res.headers.get('X-Grid') ?? 'null');
    if (!meta) throw new Error('terrain grid: missing X-Grid header');
    return { ...meta, heights: new Float32Array(await res.arrayBuffer()) };
  },
  // Lab
  replay: (sessionId: string, body: { algorithmVersion: string; variant?: string | null; overrides?: Record<string, unknown> | null; mode: 'SENSOR_TIME' | 'AS_RECEIVED'; publish?: boolean; cutoff?: string | null; finalize?: boolean }) =>
    send<{ runId: string; outputs: number; durationMs: number }>('POST', `/api/v1/sessions/${sessionId}/replays`, body),
  runs: (sessionId: string) => get<LabRun[]>(`/api/v1/sessions/${sessionId}/runs`),
  run: (runId: string) => get<LabRun>(`/api/v1/runs/${runId}`),
  runPositions: (runId: string, stage: 'FORWARD' | 'FINAL') => get<RunPosition[]>(`/api/v1/runs/${runId}/positions?stage=${stage}`),
  runFixes: (runId: string) => get<RunFix[]>(`/api/v1/runs/${runId}/fixes`),
  runEvents: (runId: string) => get<RunEvent[]>(`/api/v1/runs/${runId}/events`),
  pinRun: (runId: string, pinned: boolean) => send<{ pinned: boolean }>('POST', `/api/v1/runs/${runId}/pin`, { pinned }),
  qc: (sessionId: string) => get<{ qcVersion: string; decisions: QcDecision[] }>(`/api/v1/sessions/${sessionId}/qc`),
  routes: () => get<LabRoute[]>('/api/v1/routes'),
  route: (id: string) => get<RouteDetail>(`/api/v1/routes/${id}`),
  createRoute: (body: { name: string; a: { latitude: number; longitude: number }; b: { latitude: number; longitude: number }; radiusM?: number; widthM?: number }) =>
    send<LabRoute>('POST', '/api/v1/routes', body),
  deleteRoute: (id: string) => send<{ deleted: string }>('DELETE', `/api/v1/routes/${id}`, {}),
  detectPasses: (id: string, includeSynthetic: boolean) =>
    send<{ sessions: number; passes: number; ab: number; ba: number }>('POST', `/api/v1/routes/${id}/passes/detect`, { includeSynthetic }),
  excludePass: (routeId: string, passId: string, excluded: boolean) => send<{ excluded: boolean }>('POST', `/api/v1/routes/${routeId}/passes/${passId}/exclude`, { excluded }),
  buildCanonical: (id: string) => send<{ canonicalPathId: string } & CanonicalSummary>('POST', `/api/v1/routes/${id}/canonical`, {}),
  validateRoute: (id: string) => send<{ reportId: string } & ValidationMetrics>('POST', `/api/v1/routes/${id}/validate`, {}),
  canonicalPath: (id: string) => get<CanonicalPath>(`/api/v1/canonical-paths/${id}`),
  validationReport: (id: string) => get<ValidationReport>(`/api/v1/validation-reports/${id}`),
};
