import './styles.css';
import {
  api,
  DELETE_CONFIRM_TEXT,
  type CollectorState,
  type FusedPosition,
  type FusedUpdate,
  type FusionRun,
  type FusionSensorEvent,
  type LocationPoint,
  type LocationUpdate,
  type Marker,
  type Session,
} from './api';
import { connectPreview } from './socket';
import { Lab } from './lab';
import { initVWorld, type Viewer } from './vworld';
import { initCampusMap, type BuildingPick, type CampusSceneLayer } from './campus-map';
import { MobilityLayer, MOBILITY_KIND_LABELS, type MobilityPick } from './mobility-map';

/** campus (default): Cesium + campus 3D model + server DEM; vworld: the former VWorld WebGL map (VITE_MAP_ENGINE). */
const MAP_ENGINE: 'campus' | 'vworld' = import.meta.env.VITE_MAP_ENGINE === 'vworld' ? 'vworld' : 'campus';
import {
  CollectorVisualization,
  describeFloor,
  setFloorLabel,
  setGeoidSeparation,
  SessionTrack,
  SpatialMapOverlay,
  accuracyColor,
  collectorColor,
  heightOf,
  horizontalOffsetMeters,
  type LayerVisibility,
  type PickId,
} from './trajectory';

// ---------------- state ----------------
type Selection = { kind: 'collector'; id: string } | { kind: 'session'; id: string } | { kind: 'point'; pick: PickId } | { kind: 'building'; id: string } | { kind: 'mobility'; pick: MobilityPick } | null;

const state = {
  mode: 'live' as 'live' | 'history' | 'lab',
  selected: null as Selection,
  layers: { rawPoints: true, rawTrajectory: true, fusedPosition: true, fusedTrajectory: true, accuracy: true, markers: true, fusedVersions: {} } as LayerVisibility,
  /** From GET /api/v1/fusion/versions: the live (realtime) version and all versions available for comparison. */
  fusion: { active: 'fusion-v2', versions: [] as string[] },
  runs: new Map<string, FusionRun[]>(), // sessionId -> latest run per version
  sensorEvents: new Map<string, FusionSensorEvent[]>(), // `${sessionId}|${version}`
  reprocessing: new Set<string>(), // `${sessionId}|${version}`
  reprocessResult: new Map<string, string>(),
  connected: false,
  collectors: new Map<string, CollectorState>(),
  sessions: [] as Session[],
};

let viewer: Viewer | null = null;
const lab = new Lab(document.getElementById('lab-panel')!, () => viewer);
let spatialMapOverlay: SpatialMapOverlay | null = null;
let campusScene: CampusSceneLayer | null = null;
let mobilityLayer: MobilityLayer | null = null;
const tracks = new Map<string, SessionTrack>(); // sessionId -> track
const trackLoads = new Map<string, Promise<void>>();
const liveSessionIds = new Set<string>(); // sessions drawn in Live mode
const collectorViz = new Map<string, CollectorVisualization>(); // collectorId -> current points

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const shortVersion = (v: string) => v.replace(/^fusion-/, '');
const versionEnabled = (v: string) => state.layers.fusedVersions[v] ?? v === state.fusion.active;
const usesSpatialPolicy = (v: string) => v === 'fusion-v3' || v === 'fusion-v3.1';

// ---------------- map entities ----------------
function getCollectorViz(collectorId: string): CollectorVisualization | null {
  if (!viewer) return null;
  let v = collectorViz.get(collectorId);
  if (!v) {
    v = new CollectorVisualization(viewer, collectorId);
    v.setRequireFusedCurrent(usesSpatialPolicy(state.fusion.active));
    collectorViz.set(collectorId, v);
    applyVisibility();
  }
  return v;
}

/** Raw + fused current points from a CollectorState (snapshot / status events). */
function syncCollectorViz(c: CollectorState) {
  const v = getCollectorViz(c.collectorId);
  if (!v) return;
  if (c.latestLocation) v.updateRaw(c.latestLocation);
  if (c.latestFused) v.updateFused(c.latestFused);
}

/** Creates the track and loads its history once (REST). Live points arriving meanwhile are merged by sequence. */
function ensureTrack(sessionId: string, collectorId: string): Promise<void> {
  if (!viewer) return Promise.resolve();
  if (!tracks.has(sessionId)) {
    tracks.set(sessionId, new SessionTrack(viewer, sessionId, collectorId, state.fusion.active, state.fusion.versions));
    applyVisibility();
  }
  let load = trackLoads.get(sessionId);
  if (!load) {
    load = reloadTrack(sessionId);
    trackLoads.set(sessionId, load);
  }
  return load;
}

async function loadFused(track: SessionTrack, version: string, replace: boolean) {
  const [fused, decisions, sensorEvents] = await Promise.all([
    api.fusedPositions(track.sessionId, version),
    version === 'fusion-v3' ? api.spatialDecisions(track.sessionId, version) : Promise.resolve([]),
    version === 'fusion-v3.1' ? api.fusionSensorEvents(track.sessionId, version) : Promise.resolve([]),
  ]);
  if (version === 'fusion-v3') track.setSpatialGpsDecisions(decisions, version);
  if (version === 'fusion-v3.1') {
    state.sensorEvents.set(`${track.sessionId}|${version}`, sensorEvents);
    track.setSpatialGpsDecisions(toSpatialDecisions(sensorEvents), version);
  }
  if (replace) track.replaceFused(version, fused);
  else track.addFused(version, fused);
}

function toSpatialDecisions(events: FusionSensorEvent[]) {
  return events.flatMap((event) => {
    if (event.eventType !== 'gps-anchor-decision') return [];
    const d = event.details;
    return [{ sequence: Number(d.sequence), timestamp: event.timestamp, spatialMapVersionId: null,
      campusStatus: String(d.campus ?? 'MAP_UNAVAILABLE'), anchorAccepted: Boolean(d.accepted), reason: String(d.reason ?? 'UNKNOWN'),
      horizontalAccuracy: typeof d.accuracy === 'number' ? d.accuracy : null,
      boundaryDistanceM: typeof d.boundaryDistanceM === 'number' ? d.boundaryDistanceM : null,
      buildingId: typeof d.buildingId === 'string' ? d.buildingId : null,
      buildingName: typeof d.buildingName === 'string' ? d.buildingName : null }];
  });
}

/** Raw locations + fused positions (enabled versions) + markers. replace: after reprocess/reconnect the stored result wins. */
async function reloadTrack(sessionId: string, replace = false) {
  const track = tracks.get(sessionId);
  if (!track) return;
  try {
    const [points, markers] = await Promise.all([api.locations(sessionId), api.markers(sessionId)]);
    track.addPoints(points);
    track.replaceMarkers(markers);
    await Promise.all(state.fusion.versions.filter(versionEnabled).map((v) => loadFused(track, v, replace)));
  } catch (err) {
    console.error('track load failed', sessionId, err);
    trackLoads.delete(sessionId); // allow retry
  }
  scheduleRender();
}

function applyVisibility() {
  for (const [id, track] of tracks) {
    track.setLayers(state.layers);
    const selectedSession = state.selected?.kind === 'session' ? state.selected.id : state.selected?.kind === 'point' ? state.selected.pick.sessionId : null;
    track.setVisible(state.mode === 'live' ? liveSessionIds.has(id) : state.mode === 'history' && selectedSession === id);
  }
  for (const v of collectorViz.values()) v.setVisible(state.mode === 'live', state.layers);
  document.body.classList.toggle('lab-mode', state.mode === 'lab');
  void lab.setActive(state.mode === 'lab', state.fusion.versions);
}

async function loadRuns(sessionId: string) {
  try {
    state.runs.set(sessionId, (await api.fusionSummary(sessionId)).runs);
  } catch (err) {
    console.error(err);
  }
  scheduleRender();
}

// ---------------- data loading ----------------
function upsertSession(s: Session) {
  const i = state.sessions.findIndex((x) => x.sessionId === s.sessionId);
  if (i >= 0) state.sessions[i] = s;
  else state.sessions.unshift(s);
}

async function loadInitial() {
  try {
    const [collectors, sessions] = await Promise.all([api.collectors(), api.sessions({ limit: 100 })]);
    state.collectors.clear(); // drop collectors deleted while we were disconnected
    for (const c of collectors) state.collectors.set(c.collectorId, c);
    state.sessions = sessions;
    for (const c of collectors) syncCollectorViz(c);
    for (const s of sessions.filter((s) => s.status === 'ACTIVE')) {
      liveSessionIds.add(s.sessionId);
      void ensureTrack(s.sessionId, s.collectorId);
    }
    applyVisibility();
  } catch (err) {
    console.error(err);
    showMessage(`Backend not reachable: ${(err as Error).message}`);
  }
  scheduleRender();
}

/** After a preview socket reconnect: reload lists and re-fetch loaded tracks (fills any gap). */
async function onReconnect() {
  void mobilityLayer?.reload().catch(() => undefined); // QGIS edits made while disconnected
  await loadInitial();
  await Promise.all([...tracks.keys()].map((id) => reloadTrack(id, true)));
}

// ---------------- realtime handlers ----------------
function startRealtime() {
  connectPreview({
    onConnectionChange(connected) {
      state.connected = connected;
      scheduleRender();
    },
    onReconnect: () => void onReconnect(),
    onSnapshot(collectors) {
      for (const c of collectors) {
        state.collectors.set(c.collectorId, c);
        syncCollectorViz(c);
      }
      scheduleRender();
    },
    onCollectorState(c) {
      state.collectors.set(c.collectorId, c);
      syncCollectorViz(c);
      scheduleRender();
    },
    onCollectorRemoved({ collectorId, sessionIds }) {
      removeCollectorLocally(collectorId, sessionIds);
    },
    onSessionStarted(s) {
      upsertSession(s);
      liveSessionIds.add(s.sessionId);
      void ensureTrack(s.sessionId, s.collectorId);
      applyVisibility();
      scheduleRender();
    },
    onSessionFinished(s) {
      upsertSession(s);
      scheduleRender();
    },
    onLocation(u: LocationUpdate) {
      getCollectorViz(u.collectorId)?.updateRaw(u);
      const session = state.sessions.find((s) => s.sessionId === u.sessionId);
      if (session) {
        session.locationCount += 1;
        session.lastLocationAt = u.timestamp;
      }
      const track = tracks.get(u.sessionId);
      if (track) track.addPoints([u]);
      else if (state.mode === 'live') {
        liveSessionIds.add(u.sessionId);
        void ensureTrack(u.sessionId, u.collectorId); // history fetch includes this point
      }
      scheduleRender();
    },
    /** Live fusion output (realtime version only): appended, no full refetch. */
    onFused(u: FusedUpdate) {
      getCollectorViz(u.collectorId)?.updateFused(u);
      const track = tracks.get(u.sessionId);
      if (track) track.addFused(u.algorithmVersion, [u]);
      else if (state.mode === 'live') {
        liveSessionIds.add(u.sessionId);
        void ensureTrack(u.sessionId, u.collectorId);
      }
      scheduleRender();
    },
    onFusionReprocessed({ sessionId, algorithmVersion }) {
      const track = tracks.get(sessionId);
      if (track && (algorithmVersion === 'fusion-v3.1' || track.hasVersion(algorithmVersion) || versionEnabled(algorithmVersion))) {
        void loadFused(track, algorithmVersion, true).then(scheduleRender);
      }
      // markers snap to the finished fusion-v4 track: re-read them when it changes
      if (track && algorithmVersion === 'fusion-v4') void api.markers(sessionId).then((m) => track.replaceMarkers(m)).catch(() => undefined);
      if (state.runs.has(sessionId)) void loadRuns(sessionId);
    },
    onSpatialGpsDecisions({ sessionId, algorithmVersion, decisions }) {
      if (algorithmVersion === 'fusion-v3') tracks.get(sessionId)?.setSpatialGpsDecisions(decisions, algorithmVersion);
    },
    onMobilityChanged() {
      void mobilityLayer?.reload().then(() => scheduleRender()).catch((err) => console.error('mobility reload failed', err));
    },
    onFusionSensorEvents({ sessionId, algorithmVersion, events }) {
      if (algorithmVersion !== 'fusion-v3.1') return;
      const key = `${sessionId}|${algorithmVersion}`;
      const allEvents = [...(state.sensorEvents.get(key) ?? []), ...events].slice(-5000);
      state.sensorEvents.set(key, allEvents);
      const track = tracks.get(sessionId);
      if (track) track.setSpatialGpsDecisions(toSpatialDecisions(allEvents), algorithmVersion);
      scheduleRender();
    },
    onMarker(m: Marker) {
      const track = tracks.get(m.sessionId);
      if (track) track.addMarker(m);
      else if (state.mode === 'live' && m.collectorId) {
        // Marker for a session not drawn yet (e.g. a backlog session): load it; the REST fetch includes the marker.
        liveSessionIds.add(m.sessionId);
        void ensureTrack(m.sessionId, m.collectorId);
        applyVisibility();
      }
      const session = state.sessions.find((s) => s.sessionId === m.sessionId);
      if (session) session.markerCount += 1;
      scheduleRender();
    },
  });
}

// ---------------- rendering ----------------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  // setTimeout instead of requestAnimationFrame: rAF is paused in background tabs.
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 100);
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (v: number | null | undefined, digits = 1, unit = '') => (v == null ? '–' : `${v.toFixed(digits)}${unit}`);
function ago(iso: string | null) {
  if (!iso) return '–';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '–');
const dot = (color: string) => `<span class="dot" style="background:${color}"></span>`;
const row = (label: string, value: string) => `<tr><th>${label}</th><td>${value}</td></tr>`;
const section = (label: string) => `<tr class="section"><th colspan="2">${label}</th></tr>`;
const OFFSET_NOTE = '<span class="muted" title="How far the fusion result is from the raw GPS fix nearest in time. A debug metric, not an accuracy.">(debug, not accuracy)</span>';

/** Closest element by timestamp (lists are small enough for a linear scan). */
function nearestByTime<T extends { timestamp: string }>(list: T[], iso: string): T | null {
  const t = Date.parse(iso);
  let best: T | null = null;
  let bestDt = Infinity;
  for (const x of list) {
    const dt = Math.abs(Date.parse(x.timestamp) - t);
    if (dt < bestDt) {
      bestDt = dt;
      best = x;
    }
  }
  return best;
}

/** Raw fixes worse than this are not positions at campus scale (same limit as the fusion evidence). */
const USABLE_GPS_ACCURACY = 35;

/** Last raw fix that is usable (<= 35 m); a 1.8 km-accuracy fix says nothing about an offset. */
function lastUsableRaw(points: LocationPoint[]): LocationPoint | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const a = points[i].horizontalAccuracy;
    if (a != null && a > 0 && a <= USABLE_GPS_ACCURACY) return points[i];
  }
  return null;
}

/** Raw-vs-fused offset using the fused point (live version) nearest in time to the given raw fix. */
function offsetText(track: SessionTrack | undefined, raw: LocationPoint | null, fallback: FusedPosition | null) {
  if (!raw) return '–';
  const f = (track && nearestByTime(track.fused(state.fusion.active), raw.timestamp)) ?? fallback;
  if (!f) return '–';
  const acc = raw.horizontalAccuracy;
  const unusable = acc == null || acc <= 0 || acc > USABLE_GPS_ACCURACY;
  return `<b>${horizontalOffsetMeters(raw, f).toFixed(1)} m</b> <span class="${unusable ? 'warn-text' : 'muted'}">(raw ±${num(acc, 0)} m${unusable ? ', not a usable fix' : ''})</span> ${OFFSET_NOTE}`;
}

/** Fusion diagnostics rows shared by the collector and point views. */
function fusedRows(f: FusedPosition) {
  // fusion-v1 stores no diagnostics (all null); v2+ always records the motion state and heading source.
  const hasDiagnostics = f.stationary != null || f.headingSource != null;
  const hasV21 = f.reanchored != null || f.gpsQuality != null || f.divergenceDetected != null;
  const na = `<span class="muted">not recorded by ${esc(f.algorithmVersion)}</span>`;
  const gps = !hasDiagnostics
    ? na
    : f.gpsUsed == null
      ? '<span class="muted">no fix in this output window</span>'
      : f.gpsUsed
        ? '<span class="tag active">used</span>'
        : '<span class="tag warn">rejected</span>';
  return [
    row('Algorithm', esc(f.algorithmVersion)),
    row('Time', `${time(f.timestamp)} (${ago(f.timestamp)})`),
    row('Lon / Lat', `${f.longitude.toFixed(6)}, ${f.latitude.toFixed(6)}`),
    row('Ellipsoidal', num(f.ellipsoidalAltitude, 1, ' m')),
    ...(f.zDatumSource != null
      ? [
          row(
            'Height reference',
            f.zDatumSource === 'TERRAIN'
              ? `<span class="tag active">TERRAIN</span> ground contacts ±${num(f.zDatumSigma, 1, ' m')}`
              : f.zDatumSource === 'GPS'
                ? `<span class="tag warn">GPS</span> ±${num(f.zDatumSigma, 1, ' m')} (no outdoor ground contact)`
                : '<span class="tag warn">NONE</span> no ground contact or consistent GPS height — drawn on the terrain',
          ),
          row('Ground (DEM, MSL)', num(f.terrainHeight, 1, ' m')),
          row('Above ground', f.heightAboveGround != null ? `<b>${f.heightAboveGround.toFixed(1)} m</b>` : '–'),
          row('Building', esc(f.buildingName ?? '– (outside footprints)')),
          row('Floor (calibrated)', esc(describeFloor(f.buildingName, f.ellipsoidalAltitude) ?? '– (building not calibrated)')),
        ]
      : []),
    row('Position source', `<span class="tag">${esc(f.source)}</span>`),
    row('Motion state', !hasDiagnostics ? na : f.stationary ? '<b>STATIONARY</b>' : 'MOVING'),
    row('Heading', f.heading != null ? `${f.heading.toFixed(1)}°` : '– (not anchored yet)'),
    row('Heading source', hasDiagnostics ? esc(f.headingSource ?? '–') : na),
    row('GPS', `${gps}${f.gpsRejectReason ? ` <b>${esc(f.gpsRejectReason)}</b>` : ''}`),
    row('GPS H accuracy', f.gpsHorizontalAccuracy != null ? `${dot(accuracyColor(f.gpsHorizontalAccuracy))}${num(f.gpsHorizontalAccuracy, 1, ' m')}` : '–'),
    row('Innovation', num(f.innovationDistance, 1, ' m')),
    row('Uncertainty (heuristic)', num(f.horizontalUncertainty, 1, ' m')),
    row('Confidence H / V / all', `${f.horizontalConfidence.toFixed(2)} / ${f.verticalConfidence.toFixed(2)} / <b>${f.overallConfidence.toFixed(2)}</b>`),
    ...(hasV21
      ? [
          row('Local X / Y / Z', `${num(f.localX, 1)} / ${num(f.localY, 1)} / ${num(f.localZ, 1)} m`),
          row('GPS quality', esc(f.gpsQuality ?? '–')),
          row(
            'PDR',
            f.pdrApplied == null
              ? '<span class="muted">no walking in this window</span>'
              : f.pdrApplied
                ? `<span class="tag active">applied</span>${f.pdrRejectReason ? ` ${esc(f.pdrRejectReason)}` : ''}`
                : `<span class="tag warn">not applied</span> <b>${esc(f.pdrRejectReason ?? '')}</b>`,
          ),
          row('Relative altitude (raw)', num(f.relativeAltitude, 2, ' m')),
          row('Re-anchored', f.reanchored ? `<span class="tag warn">yes</span> <b>${esc(f.reanchorReason ?? '')}</b>` : 'no'),
          row('Divergence detected', f.divergenceDetected ? '<span class="tag warn">yes — state reset to GPS evidence</span>' : 'no'),
        ]
      : []),
  ].join('');
}

/** Replace innerHTML only when it changed, so idle lists are not rebuilt under the mouse every second. */
const lastHtml = new Map<string, string>();
function setHtml(id: string, html: string) {
  if (lastHtml.get(id) === html) return;
  lastHtml.set(id, html);
  $(id).innerHTML = html;
}

function render() {
  const status = $('socket-status');
  status.textContent = state.connected ? 'live' : 'disconnected';
  status.className = `pill ${state.connected ? 'ok' : 'bad'}`;
  $('mode-live').classList.toggle('active', state.mode === 'live');
  $('mode-history').classList.toggle('active', state.mode === 'history');
  $('mode-lab').classList.toggle('active', state.mode === 'lab');

  const collectors = [...state.collectors.values()].sort((a, b) => a.collectorId.localeCompare(b.collectorId));
  setHtml(
    'collector-list',
    collectors
      .map((c) => {
        const sel = state.selected?.kind === 'collector' && state.selected.id === c.collectorId;
        return `<li data-collector="${esc(c.collectorId)}" class="${sel ? 'selected' : ''}">
          ${dot(collectorColor(c.collectorId))}
          <b>${esc(c.collectorId)}</b>
          <span class="conn ${c.socketConnected ? 'on' : 'off'}" title="${c.socketConnected ? 'socket connected' : 'offline'}">${c.socketConnected ? '●' : '○'}</span>
          ${c.collecting ? '<span class="tag rec">REC</span>' : ''}
          ${c.pendingBatchCount ? `<span class="tag warn" title="pending batches on phone">⧗${c.pendingBatchCount}</span>` : ''}
          <span class="muted right">${ago(c.lastSeenAt)}</span>
          <button type="button" class="row-delete" data-delete="${esc(c.collectorId)}" title="${esc(c.collectorId)} 제거">✕</button>
        </li>`;
      })
      .join('') || '<li class="muted">No collectors</li>',
  );

  const selectedSession = state.selected?.kind === 'session' ? state.selected.id : state.selected?.kind === 'point' ? state.selected.pick.sessionId : null;
  setHtml(
    'session-list',
    state.sessions
      .map((s) => {
        const sel = selectedSession === s.sessionId;
        return `<li data-session="${esc(s.sessionId)}" class="${sel ? 'selected' : ''}">
          ${dot(collectorColor(s.collectorId))}
          <b>${esc(s.collectorId)}</b>
          <span class="tag ${s.status.toLowerCase()}">${s.status}</span>
          <span class="muted right">${new Date(s.startedAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          <div class="sub muted">${s.locationCount} pts · ${s.markerCount} markers · ${esc(s.sessionId.slice(0, 8))}</div>
        </li>`;
      })
      .join('') || '<li class="muted">No sessions</li>',
  );

  renderDetail();
}

function renderDetail() {
  const el = $('detail');
  const sel = state.selected;
  el.classList.toggle('muted', !sel);
  if (!sel) {
    el.textContent = 'Select a collector, a session, or click a point on the map.';
    return;
  }
  if (sel.kind === 'collector') return renderCollectorDetail(el, sel.id);
  if (sel.kind === 'session') return renderSessionDetail(el, sel.id);
  if (sel.kind === 'building') return renderBuildingDetail(el, sel.id);
  if (sel.kind === 'mobility') return renderMobilityDetail(el, sel.pick);
  return renderPointDetail(el, sel.pick);
}

function renderCollectorDetail(el: HTMLElement, collectorId: string) {
  const c = state.collectors.get(collectorId);
  if (!c) return;
  const l = c.latestLocation;
  const hs = l ? heightOf(l) : null;
  const f = c.latestFused;
  const track = l ? tracks.get(l.sessionId) : undefined;
  el.innerHTML = `<table>
    ${row('Collector', `${dot(collectorColor(c.collectorId))}${esc(c.collectorId)}`)}
    ${row('Socket', `${c.socketConnected ? 'connected' : 'offline'} · seen ${ago(c.lastSeenAt)}`)}
    ${row('Session', `${esc(c.activeSessionId?.slice(0, 8) ?? '–')} ${c.collecting ? '(collecting)' : ''}`)}
    ${section('Raw GPS')}
    ${row('Lon / Lat', l ? `${l.longitude.toFixed(6)}, ${l.latitude.toFixed(6)}` : '–')}
    ${row('Altitude (MSL)', num(l?.altitude, 1, ' m'))}
    ${row('Ellipsoidal', num(l?.ellipsoidalAltitude, 1, ' m'))}
    ${row('Map height', hs ? `${hs.h.toFixed(1)} m <span class="tag ${hs.source === 'none' ? 'warn' : ''}">${hs.source === 'msl' ? 'MSL' : hs.source === 'ellipsoidal' ? 'ellipsoidal − geoid' : 'no altitude'}</span>` : '–')}
    ${row('H / V accuracy', l ? `${dot(accuracyColor(l.horizontalAccuracy))}${num(l.horizontalAccuracy, 1, ' m')} / ${num(l.verticalAccuracy, 1, ' m')}` : '–')}
    ${row('Fix time', l ? `${time(l.timestamp)} (${ago(l.timestamp)})` : '–')}
    ${section(`Fused (live: ${esc(state.fusion.active)})`)}
    ${f ? fusedRows(f) : row('', '<span class="muted">no fused position yet</span>')}
    ${row('Raw → Fusion offset', offsetText(track, l, f))}
    ${section('Counts')}
    ${row('Phone counts', `${c.sampleCounts ? `loc ${c.sampleCounts.location} · motion ${c.sampleCounts.motion}` : '–'} · pending ${c.pendingBatchCount ?? '–'}`)}
    ${row('Server recv', `batches ${c.receivedCounts.batches} · loc ${c.receivedCounts.locations} · motion ${c.receivedCounts.motion} · alt ${c.receivedCounts.altimeter} · ped ${c.receivedCounts.pedometer} · mk ${c.receivedCounts.markers}`)}
  </table>`;
}

function renderSessionDetail(el: HTMLElement, sessionId: string) {
  const s = state.sessions.find((x) => x.sessionId === sessionId);
  if (!s) return;
  const track = tracks.get(s.sessionId);
  const pts = track?.points ?? [];
  const lastRaw = lastUsableRaw(pts);
  const runs = state.runs.get(sessionId) ?? [];
  const versions = state.fusion.versions;
  const sensorEvents = state.sensorEvents.get(`${sessionId}|fusion-v3.1`) ?? [];
  const eventDetail = (event: FusionSensorEvent) => {
    const d = event.details;
    if (event.eventType === 'tracking-status') return `${String(d.status ?? '')} · ${String(d.reason ?? '')}`;
    if (event.eventType === 'heading-status') return `방향 ${String(d.status ?? '')} · ${String(d.reason ?? '')}`;
    if (event.eventType === 'gps-anchor-decision') return `GPS ${d.accepted ? '앵커 적용' : '보류'} · ${String(d.reason ?? '')} · ${d.accuracy ?? '–'} m`;
    if (event.eventType === 'anchor-applied') return `${String(d.source ?? '')} · 보정 ${Number(d.correctionM ?? 0).toFixed(1)} m · 구간 ${String(d.segmentId ?? '')}`;
    if (event.eventType === 'sensor-gap') return `${String(d.sensor ?? '')} · ${Math.round(Number(d.gapMs ?? 0))} ms`;
    if (event.eventType === 'pedometer-delta') return `${d.source === 'STEP_FALLBACK' ? '걸음 수 대체' : '보행 거리'} ${Number(d.distanceM ?? 0).toFixed(1)} m${d.reason ? ` · ${String(d.reason)}` : ''}`;
    if (event.eventType === 'altimeter-update') return d.accepted ? `기압 상대 변화 ${Number(d.relativeAltitudeM ?? 0).toFixed(2)} m` : `기압 변화 보류 · ${String(d.reason ?? '')}`;
    if (event.eventType === 'stationary-state') return `정지 ${d.stationary === null ? '판정 대기' : d.stationary ? '감지' : '해제'}`;
    if (event.eventType === 'position-suppressed') return `위치 출력 보류 · ${String(d.reason ?? '')} · 오차 ${Number(d.uncertaintyM ?? 0).toFixed(1)} m`;
    return event.eventType;
  };
  const m = (v: string) => runs.find((r) => r.algorithmVersion === v)?.metrics ?? null;
  const cell = (v: string, f: (x: NonNullable<FusionRun['metrics']>) => string) => {
    const x = m(v);
    return `<td>${x ? f(x) : '–'}</td>`;
  };
  const metricRow = (label: string, f: (x: NonNullable<FusionRun['metrics']>) => string) => `<tr><th>${label}</th>${versions.map((v) => cell(v, f)).join('')}</tr>`;
  el.innerHTML = `<table>
    ${row('Session', esc(s.sessionId))}
    ${row('Collector', `${dot(collectorColor(s.collectorId))}${esc(s.collectorId)} · ${esc(s.device.deviceModel ?? '?')} iOS ${esc(s.device.systemVersion ?? '?')} · app ${esc(s.device.appVersion ?? '?')}`)}
    ${row('Status', `<span class="tag ${s.status.toLowerCase()}">${s.status}</span>`)}
    ${row('Started / Ended', `${time(s.startedAt)} / ${time(s.endedAt)}`)}
    ${row('Raw locations', `${s.locationCount}${track ? ` (on map ${pts.length})` : ''} · markers ${s.markerCount}`)}
    ${row('Last usable raw → fusion', offsetText(track, lastRaw, null))}
  </table>
  <table class="metrics">
    <tr class="section"><th>Fusion run metrics</th>${versions.map((v) => `<th>${esc(shortVersion(v))}${v === state.fusion.active ? ' (live)' : ''}</th>`).join('')}</tr>
    ${metricRow('Raw GPS', (x) => `${x.rawGpsCount}`)}
    ${metricRow('Fused outputs', (x) => `${x.fusionOutputCount}`)}
    ${metricRow('GPS accepted / rejected', (x) => `${x.gpsAccepted} / ${x.gpsRejected}${x.rejectedPct != null ? ` (${x.rejectedPct}%)` : ''}`)}
    ${metricRow('Reject reasons', (x) => Object.entries(x.rejectReasons).map(([k, n]) => `${esc(k)} ${n}`).join('<br>') || '–')}
    ${metricRow('Stationary', (x) => (x.stationarySeconds == null ? '–' : `${x.stationarySeconds} s`))}
    ${metricRow('Median GPS H acc.', (x) => num(x.medianGpsHorizontalAccuracy, 1, ' m'))}
    ${metricRow('Max rejected innovation', (x) => num(x.maxRejectedInnovation, 1, ' m'))}
    ${metricRow('Fused / raw path', (x) => `${x.fusedPathLengthM} / ${x.rawGpsPathLengthM} m`)}
    ${metricRow('Re-anchors / divergences', (x) => (x.reanchors == null ? '–' : `${x.reanchors} / ${x.divergences ?? 0}`))}
    ${metricRow('Pedometer path', (x) => (x.validation ? `${x.validation.pedometerPathM} m` : '–'))}
    ${metricRow('Sensor tracking / heading', (x) => x.sensorTracking ? `${x.sensorTracking.trackingStatus} / ${x.sensorTracking.headingStatus}` : '–')}
    ${metricRow('Step fallback / uncertainty', (x) => x.sensorTracking ? `${x.sensorTracking.fallbackStepDistanceM} m / ${num(x.sensorTracking.horizontalUncertaintyM, 1, ' m')}` : '–')}
    ${metricRow('Fused max displacement', (x) => (x.validation ? `${x.validation.fusedMaxDisplacementM} m (evidence ≤ ${x.validation.allowedDisplacementM} m)` : '–'))}
    ${metricRow('Fused Z / barometer range', (x) => (x.validation ? `${num(x.validation.fusedZRangeM, 1)} / ${num(x.validation.altimeterRangeM, 1)} m` : '–'))}
    ${metricRow('Validation', (x) => (!x.validation ? '<span class="muted">not validated (reprocess)</span>' : x.validation.warnings.length ? x.validation.warnings.map((w) => `<span class="warn-text" title="${esc(w.message)}">${esc(w.code)}</span>`).join('<br>') : '<span class="ok-text">ok</span>'))}
  </table>
  <div class="muted small">Metrics describe what each algorithm trusted or rejected; none of them is a position accuracy (no ground truth).</div>
  ${versions.includes('fusion-v3.1') ? `<table class="metrics">
    <tr class="section"><th colspan="2">Sensor tracking events (fusion-v3.1 · ${sensorEvents.length})</th></tr>
    ${sensorEvents.length ? sensorEvents.slice(-80).reverse().map((event) => `<tr><th>${esc(time(event.timestamp))}</th><td>${esc(eventDetail(event))}</td></tr>`).join('') : `<tr><td colspan="2" class="muted">No sensor events yet. Select fusion-v3.1 and reload or reprocess this session.</td></tr>`}
  </table>` : ''}
  <div class="actions">
    ${versions
      .map((v) => {
        const key = `${s.sessionId}|${v}`;
        const busy = state.reprocessing.has(key);
        return `<button type="button" data-action="reprocess" data-session="${esc(s.sessionId)}" data-version="${esc(v)}" ${busy ? 'disabled' : ''}>${busy ? 'Reprocessing…' : `Reprocess ${esc(shortVersion(v))}`}</button>`;
      })
      .join('')}
    <span class="muted">${esc(versions.map((v) => state.reprocessResult.get(`${s.sessionId}|${v}`)).filter(Boolean).join(' · ') || 'Recompute from raw data (raw is never modified)')}</span>
  </div>`;
}

/** A building of the campus 3D model: height and its basis, floors, base/roof, floor calibration. */
function renderBuildingDetail(el: HTMLElement, buildingId: string) {
  const b = campusScene?.building(buildingId);
  if (!b) return;
  const c = b.calibration;
  el.innerHTML = `<table>
    ${row('Building', `<b>${esc(b.name ?? buildingId)}</b>`)}
    ${row('Height', `${b.heightM.toFixed(1)} m <span class="tag ${b.heightSource === 'REGISTER' ? '' : 'warn'}">${b.heightSource === 'REGISTER' ? 'building register' : 'estimate'}</span>`)}
    ${row('Ground floors', b.groundFloors == null ? '–' : `${b.groundFloors}${b.heightSource === 'REGISTER' ? '' : ' (assumed)'}`)}
    ${row('Base / roof', `${b.baseM.toFixed(1)} / ${b.roofM.toFixed(1)} m MSL`)}
    ${row('Ground under it', b.terrainMinM == null ? '–' : `${b.terrainMinM.toFixed(1)} – ${b.terrainMaxM?.toFixed(1)} m MSL`)}
    ${c ? row('Calibration', `entrance floor ${c.entranceFloorOrthometricM.toFixed(2)} m · floor height ${c.floorHeightM.toFixed(2)} m`) : ''}
    ${row('Register id', esc(b.registerId ?? '–'))}
    ${row('Note', `<span class="muted">${esc(b.note ?? '')}</span>`)}
  </table>
  <div class="small muted">Rough block model (docs/CAMPUS_3D_PREVIEW_PLAN.md): flat roof; base and roof on the same terrain DEM fusion uses.</div>`;
}

/** A hand-drawn corridor / open area / portal (edited in QGIS, schema mobility). */
function renderMobilityDetail(el: HTMLElement, pick: MobilityPick) {
  const f = mobilityLayer?.feature(pick);
  if (!f) {
    el.textContent = 'This feature was deleted in QGIS.';
    return;
  }
  const table = { corridors: 'mobility.corridors', openAreas: 'mobility.open_areas', portals: 'mobility.portals' }[pick.table];
  const extra = 'widthM' in f ? row('Width / length', `${f.widthM.toFixed(1)} m / ${f.lengthM.toFixed(1)} m${f.oneWay ? ' · one-way (drawing direction)' : ''}`)
    : 'areaM2' in f ? row('Area', `${f.areaM2.toFixed(0)} m²`) : '';
  el.innerHTML = `<table>
    ${row('Name', `<b>${esc(f.name ?? '(unnamed)')}</b>`)}
    ${row('Kind', `${esc(MOBILITY_KIND_LABELS[f.kind] ?? f.kind)} <span class="muted">${esc(f.kind)}</span>`)}
    ${extra}
    ${row('Height', f.elevationM == null ? 'on the ground' : `${f.elevationM.toFixed(2)} m MSL`)}
    ${f.buildingId || f.floor ? row('Building / floor', `${esc(f.buildingId ?? '–')} / ${esc(f.floor ?? '–')}`) : ''}
    ${f.note ? row('Note', esc(f.note)) : ''}
    ${row('Source', `${table} #${f.id} · edited ${new Date(f.updatedAt).toLocaleString()}`)}
  </table>
  <div class="small muted">Edit it in QGIS (layer "${table}") and save: the preview updates by itself.</div>`;
}

function renderPointDetail(el: HTMLElement, pick: PickId) {
  const track = tracks.get(pick.sessionId);
  if (!track) return;
  if (pick.kind === 'fused') {
    const f = track.fused(pick.version).find((x) => x.fusionSequence === pick.seq);
    if (!f) return;
    const raw = nearestByTime(track.points, f.timestamp);
    el.innerHTML = `<table>
      ${section(`Fused point #${f.fusionSequence} · session ${esc(pick.sessionId.slice(0, 8))}`)}
      ${fusedRows(f)}
      ${row('Raw → Fusion offset', raw ? `<b>${horizontalOffsetMeters(raw, f).toFixed(1)} m</b> to raw #${raw.sequence} ${OFFSET_NOTE}` : '–')}
    </table>`;
    return;
  }
  const p = track.points.find((x) => x.sequence === pick.seq);
  if (!p) return;
  const decision = track.fused(state.fusion.active).find((f) => f.gpsSequence === p.sequence);
  const nearest = nearestByTime(track.fused(state.fusion.active), p.timestamp);
  el.innerHTML = `<table>
    ${section(`Raw GPS #${p.sequence} · session ${esc(pick.sessionId.slice(0, 8))}`)}
    ${row('Time', time(p.timestamp))}
    ${row('Lon / Lat', `${p.longitude.toFixed(6)}, ${p.latitude.toFixed(6)}`)}
    ${row('H / V accuracy', `${dot(accuracyColor(p.horizontalAccuracy))}${num(p.horizontalAccuracy, 1, ' m')} / ${num(p.verticalAccuracy, 1, ' m')}`)}
    ${row('Altitude / Ellipsoidal', `${num(p.altitude, 1, ' m')} / ${num(p.ellipsoidalAltitude, 1, ' m')}`)}
    ${section(`Decision by ${esc(state.fusion.active)}`)}
    ${row(
      'GPS',
      decision
        ? decision.gpsUsed
          ? '<span class="tag active">used</span>'
          : `<span class="tag warn">rejected</span> <b>${esc(decision.gpsRejectReason ?? '')}</b>`
        : '<span class="muted">not the last fix of an output window (decision not stored)</span>',
    )}
    ${row('Innovation', num(decision?.innovationDistance, 1, ' m'))}
    ${row('Raw → Fusion offset', nearest ? `<b>${horizontalOffsetMeters(p, nearest).toFixed(1)} m</b> ${OFFSET_NOTE}` : '–')}
  </table>`;
}

function showMessage(text: string) {
  const el = $('map-message');
  el.textContent = text;
  el.hidden = false;
}

// ---------------- UI events ----------------
$('collector-list').addEventListener('pointerdown', (e) => {
  const del = (e.target as HTMLElement).closest<HTMLElement>('[data-delete]');
  if (del) {
    e.preventDefault(); // keep focus for the dialog input
    void openDeleteDialog(del.dataset.delete!);
    return;
  }
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-collector]');
  if (!li) return;
  const id = li.dataset.collector!;
  state.selected = { kind: 'collector', id };
  if (state.mode !== 'live') {
    state.mode = 'live';
    applyVisibility();
  }
  collectorViz.get(id)?.flyTo();
  scheduleRender();
});

$('session-list').addEventListener('pointerdown', async (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-session]');
  if (!li) return;
  const id = li.dataset.session!;
  const session = state.sessions.find((s) => s.sessionId === id);
  if (!session) return;
  state.selected = { kind: 'session', id };
  state.mode = 'history';
  applyVisibility();
  scheduleRender();
  void loadRuns(id);
  await ensureTrack(id, session.collectorId);
  applyVisibility();
  tracks.get(id)?.flyTo();
});

// Reprocess buttons (pointerdown: the detail panel is re-rendered every second)
$('detail').addEventListener('pointerdown', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action="reprocess"]');
  if (!btn || btn.hasAttribute('disabled')) return;
  const id = btn.dataset.session!;
  const version = btn.dataset.version!;
  const key = `${id}|${version}`;
  state.reprocessing.add(key);
  scheduleRender();
  try {
    const r = await api.reprocessFusion(id, version);
    state.reprocessResult.set(key, `${shortVersion(version)}: ${r.outputs} positions in ${r.durationMs} ms`);
    const track = tracks.get(id);
    if (track) await loadFused(track, version, true);
    await loadRuns(id);
  } catch (err) {
    state.reprocessResult.set(key, `${shortVersion(version)} failed: ${(err as Error).message}`);
  } finally {
    state.reprocessing.delete(key);
    scheduleRender();
  }
});

$('mode-live').addEventListener('click', () => {
  state.mode = 'live';
  applyVisibility();
  scheduleRender();
});
$('mode-history').addEventListener('click', () => {
  state.mode = 'history';
  applyVisibility();
  scheduleRender();
});
$('mode-lab').addEventListener('click', () => {
  state.mode = 'lab';
  applyVisibility();
  scheduleRender();
});
$('reload-sessions').addEventListener('click', () => {
  void loadInitial();
  for (const id of tracks.keys()) void reloadTrack(id, true);
});

for (const key of ['rawPoints', 'rawTrajectory', 'fusedPosition', 'fusedTrajectory', 'accuracy', 'markers'] as const) {
  $<HTMLInputElement>(`layer-${key}`).addEventListener('change', (e) => {
    state.layers[key] = (e.target as HTMLInputElement).checked;
    applyVisibility();
  });
}

/** One checkbox per fusion version; the live version is on by default, others load on demand for comparison. */
function renderVersionToggles() {
  $('fused-versions').innerHTML = state.fusion.versions
    .map(
      (v) =>
        `<label title="${v === state.fusion.active ? 'live version: solid line' : 'comparison: dashed line'}"><input type="checkbox" data-version="${esc(v)}" ${versionEnabled(v) ? 'checked' : ''} /> ${esc(shortVersion(v))}${v === state.fusion.active ? ' (live)' : ` ${['┄', '╌', '─ ─', '— —'][Math.max(0, state.fusion.versions.indexOf(v)) % 4]}`}</label>`,
    )
    .join('');
}
$('fused-versions').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const version = input.dataset.version;
  if (!version) return;
  state.layers.fusedVersions[version] = input.checked;
  if (input.checked) {
    for (const track of tracks.values()) if (!track.hasVersion(version)) void loadFused(track, version, false).then(scheduleRender);
  }
  applyVisibility();
  scheduleRender();
});

// ---------------- collector ID issue / delete ----------------
function removeCollectorLocally(collectorId: string, sessionIds: string[]) {
  state.collectors.delete(collectorId);
  const removed = new Set(sessionIds);
  for (const s of state.sessions) if (s.collectorId === collectorId) removed.add(s.sessionId);
  state.sessions = state.sessions.filter((s) => !removed.has(s.sessionId));
  for (const id of removed) {
    tracks.get(id)?.destroy();
    tracks.delete(id);
    trackLoads.delete(id);
    liveSessionIds.delete(id);
    state.runs.delete(id);
  }
  collectorViz.get(collectorId)?.destroy();
  collectorViz.delete(collectorId);
  const sel = state.selected;
  const selSession = sel?.kind === 'session' ? sel.id : sel?.kind === 'point' ? sel.pick.sessionId : null;
  if ((sel?.kind === 'collector' && sel.id === collectorId) || (selSession && removed.has(selSession))) state.selected = null;
  scheduleRender();
}

const issueForm = $<HTMLFormElement>('issue-form');
const issueInput = $<HTMLInputElement>('issue-input');
const issueResult = $('issue-result');

$('issue-open').addEventListener('click', () => {
  issueForm.hidden = !issueForm.hidden;
  issueResult.textContent = '';
  if (!issueForm.hidden) issueInput.focus();
});
$('issue-cancel').addEventListener('click', () => {
  issueForm.hidden = true;
  issueInput.value = '';
});
issueForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = issueForm.querySelector<HTMLButtonElement>('button[type=submit]')!;
  button.disabled = true;
  try {
    const created = await api.createCollector(issueInput.value.trim() || undefined);
    state.collectors.set(created.collectorId, created);
    issueInput.value = '';
    issueResult.className = 'issue-result ok';
    issueResult.innerHTML = `발급됨: <b>${esc(created.collectorId)}</b> — iPhone 앱의 Collector ID에 입력하세요.`;
    scheduleRender();
  } catch (err) {
    issueResult.className = 'issue-result error';
    issueResult.textContent = (err as Error).message;
  } finally {
    button.disabled = false;
  }
});

const deleteDialog = $<HTMLDialogElement>('delete-dialog');
const deleteInput = $<HTMLInputElement>('delete-input');
const deleteConfirm = $<HTMLButtonElement>('delete-confirm');
const deleteError = $('delete-error');
let deleteTarget: string | null = null;

async function openDeleteDialog(collectorId: string) {
  deleteTarget = collectorId;
  $('delete-title').textContent = `${collectorId} 제거`;
  $('delete-summary').textContent = '불러오는 중…';
  deleteInput.value = '';
  deleteConfirm.disabled = true;
  deleteError.textContent = '';
  deleteDialog.showModal();
  deleteInput.focus();
  try {
    const s = await api.collectorSummary(collectorId);
    $('delete-summary').innerHTML = `
      <b>${esc(s.collectorId)}</b> ID와 함께 아래 데이터가 <b>영구 삭제</b>됩니다. 되돌릴 수 없습니다.
      <ul>
        <li>기기 ${s.deviceCount}대</li>
        <li>세션 ${s.sessionCount}개${s.activeSessionCount ? ` <span class="warn-text">(진행 중 ${s.activeSessionCount}개)</span>` : ''}</li>
        <li>위치 ${s.locationCount.toLocaleString()}개, 마커 ${s.markerCount}개 (+ 모션·고도·걸음 원본)</li>
      </ul>
      연결된 iPhone은 즉시 끊기며 이 ID로 다시 로그인할 수 없습니다.`;
  } catch (err) {
    $('delete-summary').textContent = (err as Error).message;
  }
}

// The delete button only enables when the confirmation text is typed exactly.
deleteInput.addEventListener('input', () => {
  deleteConfirm.disabled = deleteInput.value.trim() !== DELETE_CONFIRM_TEXT;
});
// Typing only: no paste/drop, so the phrase is entered deliberately.
deleteInput.addEventListener('paste', (e) => e.preventDefault());
deleteInput.addEventListener('drop', (e) => e.preventDefault());
$('delete-cancel').addEventListener('click', () => deleteDialog.close());
$<HTMLFormElement>('delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!deleteTarget || deleteInput.value.trim() !== DELETE_CONFIRM_TEXT) return;
  deleteConfirm.disabled = true;
  try {
    await api.deleteCollector(deleteTarget, deleteInput.value);
    removeCollectorLocally(deleteTarget, []);
    deleteDialog.close();
  } catch (err) {
    deleteError.textContent = (err as Error).message;
    deleteConfirm.disabled = false;
  }
});

setInterval(scheduleRender, 1000); // keep "Xs ago" fresh

// ---------------- boot ----------------
/** Click a raw or fused dot on the map to inspect it in the Detail panel. */
function enablePicking(v: Viewer) {
  const C = (window as any).Cesium;
  const handler = new C.ScreenSpaceEventHandler(v.scene.canvas);
  handler.setInputAction((movement: { position: unknown }) => {
    // drillPick: dots usually sit on top of a polyline, which would win a plain pick().
    const hits: { id?: unknown }[] = v.scene.drillPick(movement.position, 10);
    const id = hits.map((h) => h.id as PickId | undefined).find((x) => x?.kind === 'raw' || x?.kind === 'fused');
    if (id) {
      state.selected = { kind: 'point', pick: id };
      campusScene?.select(null);
      scheduleRender();
      return;
    }
    // hand-drawn mobility spaces (entities carry their pick on entity.mobilityPick)
    const mob = hits.map((h) => (h.id as { mobilityPick?: MobilityPick } | undefined)?.mobilityPick).find(Boolean);
    if (mob && state.mode !== 'lab') {
      state.selected = { kind: 'mobility', pick: mob };
      campusScene?.select(null);
      scheduleRender();
      return;
    }
    // campus 3D building (after the dots, so a dot in front of a wall still wins)
    const building = hits.map((h) => h.id as BuildingPick | undefined).find((x) => x?.kind === 'building');
    if (building && state.mode !== 'lab') {
      state.selected = { kind: 'building', id: building.buildingId };
      campusScene?.select(building.buildingId);
      scheduleRender();
    }
  }, C.ScreenSpaceEventType.LEFT_CLICK);
}

/** Header controls of the campus 3D scene (x-ray, labels, estimated heights, camera). */
function setupSceneControls() {
  const group = $('scene-controls');
  group.hidden = !campusScene;
  if (!campusScene) return;
  const s = campusScene;
  $<HTMLInputElement>('scene-xray').addEventListener('change', (e) => s.setOpacity((e.target as HTMLInputElement).checked ? 0.35 : 1));
  $<HTMLInputElement>('scene-labels').addEventListener('change', (e) => s.setShowLabels((e.target as HTMLInputElement).checked));
  $<HTMLInputElement>('scene-estimate').addEventListener('change', (e) => s.setShowEstimate((e.target as HTMLInputElement).checked));
  $('scene-home').addEventListener('click', () => s.home());
  $('scene-top').addEventListener('click', () => s.top());
}

async function boot() {
  try {
    const fv = await api.fusionVersions();
    state.fusion = { active: fv.active, versions: fv.versions.map((v) => v.version) };
  } catch (err) {
    console.error('fusion versions unavailable', err);
    state.fusion.versions = [state.fusion.active];
  }
  renderVersionToggles();
  // terrain geoid: lets fused points without a vertical datum be drawn on the ground instead of underground
  await api
    .terrain()
    .then((t) => {
      setGeoidSeparation(t.geoidSeparationM);
      const calibrations = new Map(t.buildings.filter((b) => b.name && b.calibration).map((b) => [b.name!, b.calibration!]));
      setFloorLabel((building, ellipsoidal) => {
        const c = building ? calibrations.get(building) : undefined;
        if (!c || ellipsoidal == null) return null;
        const n = Math.round((ellipsoidal - t.geoidSeparationM - c.entrancePhoneOrthometricM) / c.floorHeightM);
        return n === 0 ? 'entrance floor' : `entrance floor ${n > 0 ? '+' : ''}${n}`;
      });
    })
    .catch(() => setGeoidSeparation(null));

  const start: Promise<Viewer> = MAP_ENGINE === 'campus'
    ? initCampusMap('vmap').then((r) => {
        campusScene = r.scene;
        if (r.warning) showMessage(r.warning);
        setupSceneControls();
        return r.viewer;
      })
    : initVWorld('vmap');
  start
    .then((v) => {
      viewer = v;
      if (import.meta.env.DEV) (window as any).__previewViewer = v; // debugging in the browser console
      enablePicking(v);
      mobilityLayer = new MobilityLayer(v);
      void mobilityLayer.reload().catch((err) => console.error('mobility spaces unavailable', err));
      $<HTMLInputElement>('scene-mobility').addEventListener('change', (e) => mobilityLayer?.setVisible((e.target as HTMLInputElement).checked));
      $('scene-controls').hidden = false;
      // the campus model draws its own buildings and campus outline; the VWorld map needs the 2D overlay
      if (MAP_ENGINE === 'vworld') {
        void api.spatialMap().then((map) => {
          spatialMapOverlay?.destroy();
          spatialMapOverlay = map.mapVersionId ? new SpatialMapOverlay(v, map) : null;
        }).catch((err) => console.error('Spatial map unavailable', err));
      }
      // Entities could not be created before the viewer existed: rebuild from current state.
      for (const c of state.collectors.values()) syncCollectorViz(c);
      for (const id of liveSessionIds) {
        const s = state.sessions.find((x) => x.sessionId === id);
        if (s) void ensureTrack(id, s.collectorId);
      }
      applyVisibility();
    })
    .catch((err: Error) => {
      console.error(err);
      showMessage(`3D map unavailable: ${err.message} (lists and live status still work)`);
    });

  startRealtime();
  void loadInitial();
}

void boot();
