// Cesium entities for sessions (raw + fused trajectories, raw points, markers) and collectors (current points).
// Cesium comes from VWorld as a global; there are no typings for it, hence `any`.
//
// Visual language: collector color = identity. Raw = same color, thin + translucent. Fused = same color, thick + solid
// with a white outline. Raw sample dots are colored by GPS accuracy instead.
import type { FusedPosition, LocationPoint, Marker, SpatialGpsDecision, SpatialMap } from './api';
import type { Viewer } from './vworld';

const Cesium = () => (window as any).Cesium;

// ---------- height policy ----------
// VWorld places its terrain and buildings at their MSL (orthometric) heights in the Cesium scene — sampled:
// VWorld 127.9 / 103.6 / 144.2 m vs the campus DEM 132.0 / 97.7 / 140.5 m MSL (ellipsoidal would be +23.4 m).
// So everything is drawn at MSL: phone altitude (MSL), fused ellipsoidal minus the geoid separation N.
export type HeightSource = 'msl' | 'ellipsoidal' | 'none';

/** Geoid separation of the active campus terrain (KNGeoid18): MSL = ellipsoidal - N. */
let geoidSeparation: number | null = null;
export const setGeoidSeparation = (n: number | null) => {
  geoidSeparation = n;
};
const KOREA_GEOID_FALLBACK_M = 23.4;
/** Ellipsoidal height -> the height VWorld uses (MSL). */
export const sceneHeight = (ellipsoidal: number) => ellipsoidal - (geoidSeparation ?? KOREA_GEOID_FALLBACK_M);

export function heightOf(p: { altitude: number | null; ellipsoidalAltitude: number | null }): { h: number; source: HeightSource } {
  if (p.altitude != null) return { h: p.altitude, source: 'msl' };
  if (p.ellipsoidalAltitude != null) return { h: sceneHeight(p.ellipsoidalAltitude), source: 'ellipsoidal' };
  return { h: 0, source: 'none' };
}

function toCartesian(p: { longitude: number; latitude: number }, h: number) {
  // Always (longitude, latitude, height) — never swap.
  return Cesium().Cartesian3.fromDegrees(p.longitude, p.latitude, h);
}
const rawCartesian = (p: LocationPoint) => toCartesian(p, heightOf(p).h);
/** "entrance floor +N" for a building + ellipsoidal height, from the building calibration (set by main.ts). */
let floorLabel: (building: string | null | undefined, ellipsoidal: number | null | undefined) => string | null = () => null;
export const setFloorLabel = (fn: typeof floorLabel) => {
  floorLabel = fn;
};
export const describeFloor = (building: string | null | undefined, ellipsoidal: number | null | undefined) => floorLabel(building, ellipsoidal);
/**
 * Fused height: its ellipsoidal estimate. Without a vertical datum (v4: no ground contact / consistent GPS height)
 * the point is drawn on the terrain (DEM + 1 m phone height) when known, else at the given fallback.
 */
const fusedCartesian = (p: FusedPosition, fallbackH: number) =>
  toCartesian(p, p.ellipsoidalAltitude != null ? sceneHeight(p.ellipsoidalAltitude) : p.terrainHeight != null ? p.terrainHeight + 1 : fallbackH);

export function accuracyColor(hacc: number | null): string {
  if (hacc == null || hacc < 0) return '#9ca3af';
  if (hacc < 5) return '#22c55e';
  if (hacc < 15) return '#eab308';
  return '#ef4444';
}

const PALETTE = ['#3b82f6', '#f97316', '#a855f7', '#14b8a6', '#ec4899', '#84cc16', '#06b6d4', '#f43f5e', '#eab308', '#6366f1'];
export function collectorColor(collectorId: string): string {
  const n = Number.parseInt(collectorId.replace(/\D/g, ''), 10);
  const idx = Number.isFinite(n) ? n - 1 : [...collectorId].reduce((a, c) => a + c.charCodeAt(0), 0);
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** Horizontal distance in meters (equirectangular; plenty for campus-scale debugging). */
export function horizontalOffsetMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const x = (b.longitude - a.longitude) * rad * Math.cos(((a.latitude + b.latitude) / 2) * rad);
  const y = (b.latitude - a.latitude) * rad;
  return Math.hypot(x, y) * R;
}

/** Comparison versions: 1st = short dashes, 2nd = long dashes, ... (legend: ┄ / ╌ / ─ ─). */
export function dashLengthFor(version: string, all: string[]): number {
  const i = Math.max(0, all.indexOf(version));
  return [6, 18, 30, 44][i % 4];
}

export interface LayerVisibility {
  rawPoints: boolean;
  rawTrajectory: boolean;
  fusedPosition: boolean;
  fusedTrajectory: boolean;
  accuracy: boolean;
  markers: boolean;
  /** Which fusion versions' trajectories to draw (e.g. compare fusion-v1 and fusion-v2). */
  fusedVersions: Record<string, boolean>;
}

/** Identifies clickable points on the map (Cesium pick id). */
export type PickId = { kind: 'raw'; sessionId: string; seq: number } | { kind: 'fused'; sessionId: string; version: string; seq: number };

interface FusedLayer {
  list: FusedPosition[]; // sorted by fusionSequence
  seqs: Set<number>;
  line: any;
  additionalLines: any[];
  dots: any; // PointPrimitiveCollection, clickable
}

function byCapture(a: LocationPoint, b: LocationPoint): number {
  return Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence;
}

/** Background footprint outlines. They add map context only; no location inference uses building membership. */
export class SpatialMapOverlay {
  private readonly entities: any[] = [];

  constructor(private readonly viewer: Viewer, map: SpatialMap) {
    const C = Cesium();
    const draw = (polygons: number[][][][], color: any, width: number, label?: string) => {
      for (const polygon of polygons) {
        const shell = polygon[0] ?? [];
        if (shell.length < 2) continue;
        const positions = shell.map(([longitude, latitude]) => C.Cartesian3.fromDegrees(longitude, latitude, 0));
        this.entities.push(viewer.entities.add({
          polyline: { positions, width, clampToGround: true, material: color },
        }));
        if (label) {
          const openRing = shell.length > 1 ? shell.slice(0, -1) : shell;
          const center = openRing.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
          this.entities.push(viewer.entities.add({
            position: C.Cartesian3.fromDegrees(center[0] / openRing.length, center[1] / openRing.length, 1),
            label: {
              text: label, font: '12px sans-serif', fillColor: color,
              outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
              showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }));
        }
      }
    };

    for (const area of map.campus) draw(area, C.Color.fromCssColorString('#38bdf8').withAlpha(0.9), 4);
    for (const building of map.buildings) {
      draw(building.coordinates, C.Color.fromCssColorString('#fbbf24').withAlpha(0.9), 2, building.buildingName ?? '이름 미등록');
    }
  }

  destroy() {
    for (const entity of this.entities) this.viewer.entities.remove(entity);
    this.entities.length = 0;
  }
}

// ---------- one session ----------
export class SessionTrack {
  readonly points: LocationPoint[] = []; // raw, sorted by sensor timestamp (then sequence)
  private readonly seqs = new Set<number>();
  private readonly rawLine: any;
  private readonly rawDots: any; // PointPrimitiveCollection
  private readonly rawDotBySeq = new Map<number, any>();
  private readonly fusedLayers = new Map<string, FusedLayer>();
  private readonly markers = new Map<string, any>();
  private readonly spatialGpsByVersion = new Map<string, Map<number, SpatialGpsDecision>>();
  private visible = true;
  private layers: LayerVisibility = {
    rawPoints: true, rawTrajectory: true, fusedPosition: true, fusedTrajectory: true, accuracy: true, markers: true, fusedVersions: {},
  };

  /**
   * liveVersion = the backend's realtime fusion version: drawn solid; other versions dashed for comparison,
   * each with its own dash length (allVersions order) so v1 / v2 / ... stay distinguishable.
   */
  constructor(
    private readonly viewer: Viewer,
    readonly sessionId: string,
    readonly collectorId: string,
    private readonly liveVersion: string,
    private readonly allVersions: string[] = [],
  ) {
    const C = Cesium();
    const color = C.Color.fromCssColorString(collectorColor(collectorId));
    this.rawLine = viewer.entities.add({
      polyline: {
        positions: [],
        width: 2,
        material: color.withAlpha(0.45),
        // Segments hidden by terrain/buildings are drawn dashed instead of disappearing.
        depthFailMaterial: new C.PolylineDashMaterialProperty({ color: color.withAlpha(0.25) }),
      },
    });
    this.rawDots = viewer.scene.primitives.add(new C.PointPrimitiveCollection());
  }

  /**
   * Raw GPS: deduped by sequence, ordered by SENSOR timestamp (not arrival, not sequence): delayed / background
   * backlog batches arrive late and out of order and must slot into the line where they were captured.
   * Returns how many were new.
   */
  addPoints(points: LocationPoint[]): number {
    const C = Cesium();
    let added = 0;
    let outOfOrder = false;
    for (const p of points) {
      if (this.seqs.has(p.sequence)) continue;
      this.seqs.add(p.sequence);
      const last = this.points[this.points.length - 1];
      this.points.push(p);
      if (last && byCapture(p, last) < 0) outOfOrder = true;
      const dot = this.rawDots.add({
        id: { kind: 'raw', sessionId: this.sessionId, seq: p.sequence } satisfies PickId,
        position: rawCartesian(p),
        pixelSize: 6,
        color: C.Color.fromCssColorString(accuracyColor(p.horizontalAccuracy)).withAlpha(0.85),
        outlineColor: C.Color.BLACK.withAlpha(0.5),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      this.rawDotBySeq.set(p.sequence, dot);
      added++;
    }
    if (added === 0) return 0;
    if (outOfOrder) this.points.sort(byCapture);
    this.rawLine.polyline.positions = this.points.map(rawCartesian);
    for (const v of this.fusedLayers.keys()) this.redrawFused(v);
    this.applyGpsDecisions();
    return added;
  }

  fused(version: string): FusedPosition[] {
    return this.fusedLayers.get(version)?.list ?? [];
  }

  setSpatialGpsDecisions(decisions: SpatialGpsDecision[], version = 'fusion-v3') {
    const bySequence = new Map<number, SpatialGpsDecision>();
    for (const decision of decisions) bySequence.set(decision.sequence, decision);
    this.spatialGpsByVersion.set(version, bySequence);
    this.applyGpsDecisions();
  }

  hasVersion(version: string) {
    return this.fusedLayers.has(version);
  }

  private layer(version: string): FusedLayer {
    let l = this.fusedLayers.get(version);
    if (l) return l;
    const C = Cesium();
    const color = C.Color.fromCssColorString(collectorColor(this.collectorId));
    const live = version === this.liveVersion;
    l = {
      list: [],
      seqs: new Set(),
      line: this.viewer.entities.add({
        polyline: {
          positions: [],
          width: live ? 5 : 3,
          // live version: solid with a white outline; other versions: dashed, for side-by-side comparison
          material: live
            ? new C.PolylineOutlineMaterialProperty({ color, outlineColor: C.Color.WHITE, outlineWidth: 1.5 })
            : new C.PolylineDashMaterialProperty({ color: color.withAlpha(0.9), gapColor: C.Color.BLACK.withAlpha(0.35), dashLength: dashLengthFor(version, this.allVersions) }),
          depthFailMaterial: new C.PolylineDashMaterialProperty({ color: color.withAlpha(live ? 0.8 : 0.5) }),
        },
      }),
      additionalLines: [],
      dots: this.viewer.scene.primitives.add(new C.PointPrimitiveCollection()),
    };
    this.fusedLayers.set(version, l);
    this.apply();
    return l;
  }

  /** Fused positions of one version (live append). Merged by fusionSequence. */
  addFused(version: string, list: FusedPosition[]): number {
    const l = this.layer(version);
    let added = 0;
    for (const f of list) {
      if (l.seqs.has(f.fusionSequence)) continue;
      l.seqs.add(f.fusionSequence);
      l.list.push(f);
      added++;
    }
    if (added) {
      l.list.sort((a, b) => a.fusionSequence - b.fusionSequence);
      this.redrawFused(version);
      if (version === this.liveVersion) this.applyGpsDecisions();
    }
    return added;
  }

  /** After a reprocess: the stored result of this version was replaced as a whole. */
  replaceFused(version: string, list: FusedPosition[]) {
    const l = this.layer(version);
    l.list.length = 0;
    l.seqs.clear();
    this.addFused(version, list);
    this.redrawFused(version);
    if (version === this.liveVersion) this.applyGpsDecisions();
  }

  private fallbackHeight() {
    const last = this.points[this.points.length - 1];
    return last ? heightOf(last).h : 0;
  }

  private redrawFused(version: string) {
    const l = this.fusedLayers.get(version);
    if (!l) return;
    const C = Cesium();
    const h = this.fallbackHeight();
    const color = C.Color.fromCssColorString(collectorColor(this.collectorId));
    // A spatial reacquisition starts a new line segment; do not draw through a campus-boundary gap.
    const currentSegmentId = l.list.at(-1)?.spatialSegmentId ?? 0;
    const segments = new Map<number, FusedPosition[]>();
    for (const point of l.list) {
      const id = point.spatialSegmentId ?? 0;
      const segment = segments.get(id) ?? [];
      segment.push(point);
      segments.set(id, segment);
    }
    l.line.polyline.positions = (segments.get(currentSegmentId) ?? []).map((f) => fusedCartesian(f, h));
    for (const line of l.additionalLines) this.viewer.entities.remove(line);
    l.additionalLines.length = 0;
    for (const [segmentId, segment] of segments) {
      if (segmentId === currentSegmentId || segment.length < 2) continue;
      l.additionalLines.push(this.viewer.entities.add({
        polyline: {
          positions: segment.map((f) => fusedCartesian(f, h)),
          width: version === this.liveVersion ? 5 : 3,
          material: version === this.liveVersion
            ? new C.PolylineOutlineMaterialProperty({ color, outlineColor: C.Color.WHITE, outlineWidth: 1.5 })
            : new C.PolylineDashMaterialProperty({ color: color.withAlpha(0.9), gapColor: C.Color.BLACK.withAlpha(0.35), dashLength: dashLengthFor(version, this.allVersions) }),
          depthFailMaterial: new C.PolylineDashMaterialProperty({ color: color.withAlpha(version === this.liveVersion ? 0.8 : 0.5) }),
        },
      }));
    }
    l.dots.removeAll();
    for (const f of l.list) {
      l.dots.add({
        id: { kind: 'fused', sessionId: this.sessionId, version, seq: f.fusionSequence } satisfies PickId,
        position: fusedCartesian(f, h),
        pixelSize: version === this.liveVersion ? 5 : 4,
        color: f.stationary ? C.Color.WHITE : color,
        outlineColor: C.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
  }

  /** Raw fixes the live fusion version rejected are drawn faded (they stay stored and visible). */
  private applyGpsDecisions() {
    const C = Cesium();
    const rejected = new Set<number>();
    for (const f of this.fused(this.liveVersion)) if (f.gpsSequence != null && f.gpsUsed === false) rejected.add(f.gpsSequence);
    const shownSpatialVersions = this.allVersions.filter((version) =>
      version === this.liveVersion || this.layers.fusedVersions[version],
    );
    for (const version of shownSpatialVersions) {
      for (const [sequence, decision] of this.spatialGpsByVersion.get(version) ?? []) {
        if (!decision.anchorAccepted) rejected.add(sequence);
      }
    }
    for (const p of this.points) {
      const dot = this.rawDotBySeq.get(p.sequence);
      if (!dot) continue;
      const isRejected = rejected.has(p.sequence);
      dot.color = C.Color.fromCssColorString(accuracyColor(p.horizontalAccuracy)).withAlpha(isRejected ? 0.22 : 0.85);
      dot.outlineWidth = isRejected ? 0 : 1;
    }
  }

  /** Re-draws all markers (after a replay they snap to the new fused track). */
  replaceMarkers(markers: Marker[]) {
    for (const e of this.markers.values()) this.viewer.entities.remove(e);
    this.markers.clear();
    markers.forEach((m) => this.addMarker(m));
  }

  addMarker(m: Marker) {
    if (this.markers.has(m.markerId)) return;
    const C = Cesium();
    // snapped onto the finished fusion track (position + height at the marker time); the phone's own altitude
    // jumps by tens of meters indoors and is only the fallback while there is no fused track
    const fusedH = m.fused?.ellipsoidalAltitude ?? null;
    const { h, source } = fusedH !== null ? { h: sceneHeight(fusedH), source: 'fused' as const } : heightOf(m);
    const floor = describeFloor(m.fused?.buildingName, fusedH);
    const at = m.fused ? { longitude: m.fused.longitude, latitude: m.fused.latitude } : m;
    const heightText = source === 'fused'
      ? `${m.fused!.buildingName ? `${m.fused!.buildingName} ` : ''}${floor ?? (m.fused!.heightAboveGround != null ? `ground +${m.fused!.heightAboveGround.toFixed(1)} m` : `${h.toFixed(1)} m`)}`
      : `${h.toFixed(1)} m${source === 'msl' ? ' MSL' : ''} (phone)`;
    const entity = this.viewer.entities.add({
      position: toCartesian(at, h),
      point: {
        pixelSize: 14,
        color: C.Color.WHITE,
        outlineColor: C.Color.fromCssColorString(collectorColor(this.collectorId)),
        outlineWidth: 4,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `${m.type}${m.note ? `: ${m.note}` : ''}\n${heightText}`,
        font: '13px sans-serif',
        fillColor: C.Color.WHITE,
        outlineColor: C.Color.BLACK,
        outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new C.Cartesian2(0, -28),
        showBackground: true,
        backgroundColor: C.Color.BLACK.withAlpha(0.55),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    this.markers.set(m.markerId, entity);
    this.apply();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.apply();
  }

  setLayers(layers: LayerVisibility) {
    this.layers = layers;
    this.apply();
  }

  private versionVisible(version: string) {
    return this.layers.fusedVersions[version] ?? version === this.liveVersion;
  }

  private apply() {
    this.rawLine.show = this.visible && this.layers.rawTrajectory;
    this.rawDots.show = this.visible && this.layers.rawPoints;
    for (const [version, l] of this.fusedLayers) {
      const show = this.visible && this.layers.fusedTrajectory && this.versionVisible(version);
      l.line.show = show;
      for (const line of l.additionalLines) line.show = show;
      l.dots.show = show;
    }
    for (const e of this.markers.values()) e.show = this.visible && this.layers.markers;
  }

  flyTo() {
    const C = Cesium();
    const h = this.fallbackHeight();
    const positions = this.points.map(rawCartesian);
    for (const [version, l] of this.fusedLayers) if (this.versionVisible(version)) positions.push(...l.list.map((f) => fusedCartesian(f, h)));
    for (const e of this.markers.values()) positions.push(e.position.getValue(C.JulianDate.now()));
    if (positions.length === 0) return;
    const sphere = C.BoundingSphere.fromPoints(positions);
    sphere.radius = Math.max(sphere.radius, 60);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.2,
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-50), sphere.radius * 3),
    });
  }

  destroy() {
    this.viewer.entities.remove(this.rawLine);
    for (const l of this.fusedLayers.values()) {
      this.viewer.entities.remove(l.line);
      for (const line of l.additionalLines) this.viewer.entities.remove(line);
      this.viewer.scene.primitives.remove(l.dots);
    }
    for (const e of this.markers.values()) this.viewer.entities.remove(e);
    this.viewer.scene.primitives.remove(this.rawDots);
  }
}

// ---------- one collector's live current points (raw + fused) ----------
export class CollectorVisualization {
  private readonly raw: any;
  private readonly fusedEntity: any;
  latestRaw: (LocationPoint & { sessionId: string }) | null = null;
  latestFused: (FusedPosition & { sessionId: string }) | null = null;
  private visible = true;
  private requireFusedCurrent = false;
  private layers: LayerVisibility | null = null;

  constructor(
    private readonly viewer: Viewer,
    readonly collectorId: string,
  ) {
    const C = Cesium();
    const color = C.Color.fromCssColorString(collectorColor(collectorId));
    const label = (bg: any) => ({
      text: collectorId,
      font: 'bold 14px sans-serif',
      fillColor: C.Color.WHITE,
      outlineColor: C.Color.BLACK,
      outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new C.Cartesian2(0, -30),
      showBackground: true,
      backgroundColor: bg,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    // Raw GPS current point: small, translucent, with the GPS-reported horizontal accuracy radius.
    this.raw = viewer.entities.add({
      show: false,
      point: {
        pixelSize: 10,
        color: color.withAlpha(0.5),
        outlineColor: C.Color.WHITE.withAlpha(0.8),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: { ...label(C.Color.BLACK.withAlpha(0.6)), font: '12px sans-serif', pixelOffset: new C.Cartesian2(0, 22) },
      ellipse: {
        semiMajorAxis: 1,
        semiMinorAxis: 1,
        height: 0,
        material: color.withAlpha(0.15),
        outline: true,
        outlineColor: color.withAlpha(0.7),
      },
    });
    // Fused current point: larger, solid.
    this.fusedEntity = viewer.entities.add({
      show: false,
      point: {
        pixelSize: 17,
        color,
        outlineColor: C.Color.WHITE,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: label(color.withAlpha(0.85)),
    });
  }

  updateRaw(p: LocationPoint & { sessionId: string }) {
    // "latest" = newest sensor time: a recovered backlog point must not move the live marker backwards
    if (this.latestRaw && this.latestRaw.sessionId === p.sessionId && byCapture(p, this.latestRaw) <= 0) return;
    this.latestRaw = p;
    const { h, source } = heightOf(p);
    this.raw.position = rawCartesian(p);
    const r = p.horizontalAccuracy != null && p.horizontalAccuracy > 0 ? p.horizontalAccuracy : 0;
    this.raw.ellipse.semiMajorAxis = Math.max(r, 0.1);
    this.raw.ellipse.semiMinorAxis = Math.max(r, 0.1);
    this.raw.ellipse.height = h;
    this.raw.label.text = `${this.collectorId} raw  ${h.toFixed(1)} m${source === 'msl' ? ' MSL' : source === 'none' ? ' (no alt)' : ''}  ±${r.toFixed(1)} m`;
    this.apply();
  }

  updateFused(f: FusedPosition & { sessionId: string }) {
    if (this.latestFused && this.latestFused.sessionId === f.sessionId && f.fusionSequence <= this.latestFused.fusionSequence) return;
    this.latestFused = f;
    const h = f.ellipsoidalAltitude != null ? sceneHeight(f.ellipsoidalAltitude) : this.latestRaw ? heightOf(this.latestRaw).h : 0;
    this.fusedEntity.position = fusedCartesian(f, h);
    const building = f.buildingName ? `  ·  ${f.buildingName} (참고)` : '';
    const capturedAt = new Date(f.timestamp).toLocaleTimeString();
  const lastValid = f.algorithmVersion === 'fusion-v3' || f.algorithmVersion === 'fusion-v3.1' ? '최근 유효 위치' : '위치';
    this.fusedEntity.label.text = `${this.collectorId}  ${lastValid} ${capturedAt}  conf ${f.overallConfidence.toFixed(2)}  ${h.toFixed(1)} m${f.heading != null ? `  ${f.heading.toFixed(0)}°` : ''}${building}`;
    this.apply();
  }

  setVisible(visible: boolean, layers: LayerVisibility) {
    this.visible = visible;
    this.layers = layers;
    this.apply();
  }

  setRequireFusedCurrent(required: boolean) {
    this.requireFusedCurrent = required;
    this.apply();
  }

  private apply() {
    const L = this.layers;
    const showFused = this.visible && !!L?.fusedPosition && this.latestFused !== null;
    this.raw.show = this.visible && !!L?.rawPoints && this.latestRaw !== null && (!this.requireFusedCurrent || this.latestFused !== null);
    this.raw.ellipse.show = this.raw.show && !!L?.accuracy && (this.latestRaw?.horizontalAccuracy ?? 0) > 0;
    this.raw.label.show = !showFused; // one label per collector: on the fused point when it exists
    this.fusedEntity.show = showFused;
  }

  destroy() {
    this.viewer.entities.remove(this.raw);
    this.viewer.entities.remove(this.fusedEntity);
  }

  flyTo() {
    const target = this.latestFused ?? (this.requireFusedCurrent ? null : this.latestRaw);
    if (!target) return;
    const C = Cesium();
    const h = target.ellipsoidalAltitude != null ? sceneHeight(target.ellipsoidalAltitude) : 0;
    this.viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(target.longitude, target.latitude - 0.004, h + 400),
      orientation: { heading: 0, pitch: C.Math.toRadians(-45), roll: 0 },
      duration: 1.2,
    });
  }
}
