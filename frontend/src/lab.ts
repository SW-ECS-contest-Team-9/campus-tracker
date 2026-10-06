// Lab mode (docs/MOBILITY_MAP_PLAN.md 4.11): replay run snapshots in time (1x / 5x / 20x / Instant), compare two
// runs, define routes, find their passes and show canonical path + confidence corridor + validation errors.
// Everything here only READS results the backend computed (replays are deterministic; the speed is playback).
import {
  api,
  type CanonicalPath,
  type CanonicalPoint,
  type LabRoute,
  type LabRun,
  type LocationPoint,
  type QcDecision,
  type RouteDetail,
  type RoutePass,
  type RunEvent,
  type RunFix,
  type RunPosition,
  type Session,
  type ValidationReport,
} from './api';
import type { Viewer } from './vworld';
import { heightOf } from './trajectory';

const Cesium = () => (window as any).Cesium;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (v: number | null | undefined, d = 1, unit = '') => (v == null || !Number.isFinite(v) ? '–' : `${v.toFixed(d)}${unit}`);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const SPEEDS: [string, number][] = [['1x', 1], ['5x', 5], ['20x', 20], ['Instant', Infinity]];
const HIDDEN_EVENTS = new Set(['step', 'stair-step']);

interface LoadedRun {
  run: LabRun;
  forward: RunPosition[];
  final: RunPosition[];
  fixes: Map<number, RunFix>;
  events: RunEvent[];
  gps: LocationPoint[];
  qc: Map<number, QcDecision>;
}

type LabPick = { kind: 'lab-canonical'; idx: number } | { kind: 'lab-pass'; passId: string } | { kind: 'lab-gps'; seq: number };

/** Index of the last element with t <= time (binary search), -1 before the first. */
function indexAt<T extends { t: number }>(list: T[], time: number): number {
  let lo = 0, hi = list.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Offset a WGS84 point by (east, north) meters (display only; the campus frame is East/North within 0.008°). */
function offsetLL(lat: number, lon: number, east: number, north: number) {
  return { latitude: lat + north / 110_574, longitude: lon + east / (111_320 * Math.cos((lat * Math.PI) / 180)) };
}

const fixColor = (fix: RunFix | undefined, qc: QcDecision | undefined) =>
  qc?.status === 'REJECTED' ? '#64748b' : fix && !fix.forwardUsed ? '#ef4444' : fix && fix.finalWeight !== null && fix.finalWeight < 0.5 ? '#f97316' : fix ? '#22c55e' : '#94a3b8';
const confidenceColor = (p: CanonicalPoint) => (p.sampleCount < 3 || (p.sigmaXY ?? 99) >= 5 ? '#ef4444' : (p.sigmaXY ?? 99) < 2 && p.sampleCount >= 5 ? '#22c55e' : '#eab308');
const passColor = (p: RoutePass) => (p.excluded ? '#475569' : p.status === 'REJECTED' ? '#94a3b8' : p.status === 'PARTIAL' ? '#a78bfa' : '#38bdf8');

export class Lab {
  private active = false;
  private tab: 'runs' | 'routes' = 'runs';
  private sessions: Session[] = [];
  private versions: string[] = [];
  private sessionId: string | null = null;
  private runs: LabRun[] = [];
  private a: LoadedRun | null = null;
  private b: LoadedRun | null = null;
  private t = 0;
  private playing = false;
  private speed = 5;
  private lastFrame = 0;
  private loopRunning = false;
  private message = '';
  private busy: string | null = null;
  private routes: LabRoute[] = [];
  private route: RouteDetail | null = null;
  private canonical: CanonicalPath | null = null;
  private report: ValidationReport | null = null;
  private selectedPoint: CanonicalPoint | null = null;
  private selectedPass: string | null = null;
  private picking: 'A' | 'B' | null = null;
  private draft: { name: string; a: { latitude: number; longitude: number } | null; b: { latitude: number; longitude: number } | null; radiusM: number } = { name: '', a: null, b: null, radiusM: 15 };
  private includeSynthetic = true;
  private layers = { forward: true, final: true, gps: true, compare: true, passes: true, canonical: true, corridor: true, errors: false };
  private readonly positionsByRun = new Map<string, RunPosition[]>();

  // map objects
  private runEntities: any[] = [];
  private gpsPoints: any = null;
  private gpsIndex: { p: LocationPoint; t: number; point: any }[] = [];
  private routeEntities: any[] = [];
  private canonicalDots: any = null;
  private handler: any = null;

  constructor(private readonly el: HTMLElement, private readonly viewer: () => Viewer | null) {
    el.addEventListener('click', (e) => void this.onClick(e));
    el.addEventListener('change', (e) => void this.onChange(e));
    el.addEventListener('input', (e) => this.onInput(e));
  }

  async setActive(active: boolean, versions: string[]) {
    this.active = active;
    this.versions = versions;
    if (active) {
      this.attachPicking();
      if (!this.sessions.length) {
        try {
          this.sessions = await api.sessions({ limit: 200 });
          this.routes = await api.routes();
        } catch (err) {
          this.message = (err as Error).message;
        }
      }
      if (!this.loopRunning) {
        this.loopRunning = true;
        this.lastFrame = 0;
        requestAnimationFrame((ts) => this.frame(ts));
      }
    }
    this.applyVisibility();
    this.render();
  }

  // ---------------- data ----------------

  private async loadRun(runId: string, role: 'A' | 'B') {
    this.busy = 'loading run…';
    this.render();
    try {
      const run = await api.run(runId);
      const [final, forward, fixes, events, gps, qc] = await Promise.all([
        api.runPositions(runId, 'FINAL'),
        api.runPositions(runId, 'FORWARD'),
        role === 'A' ? api.runFixes(runId) : Promise.resolve([]),
        role === 'A' ? api.runEvents(runId) : Promise.resolve([]),
        role === 'A' ? api.locations(run.sessionId) : Promise.resolve([]),
        role === 'A' ? api.qc(run.sessionId).then((q) => q.decisions).catch(() => []) : Promise.resolve([]),
      ]);
      const loaded: LoadedRun = {
        run, final, forward: forward.length ? forward : final, events, gps,
        fixes: new Map(fixes.map((f) => [f.seq, f])), qc: new Map(qc.map((q) => [q.seq, q])),
      };
      if (role === 'A') {
        this.a = loaded;
        this.t = loaded.forward[0]?.t ?? 0;
        this.playing = false;
      } else this.b = loaded;
      this.drawRuns();
      if (role === 'A') this.flyTo(loaded.final.length ? loaded.final : loaded.forward);
    } catch (err) {
      this.message = `run: ${(err as Error).message}`;
    } finally {
      this.busy = null;
      this.render();
    }
  }

  private async selectSession(id: string) {
    this.sessionId = id || null;
    this.runs = id ? await api.runs(id).catch(() => []) : [];
    this.render();
  }

  private async selectRoute(id: string | null) {
    this.selectedPoint = null;
    this.selectedPass = null;
    if (!id) {
      this.route = null;
      this.canonical = null;
      this.report = null;
      this.drawRoute();
      this.render();
      return;
    }
    this.busy = 'loading route…';
    this.render();
    try {
      this.route = await api.route(id);
      this.canonical = this.route.canonicalPathId ? await api.canonicalPath(this.route.canonicalPathId) : null;
      this.report = this.route.reports[0] ? await api.validationReport(this.route.reports[0].id) : null;
      for (const p of this.route.passes) if (!this.positionsByRun.has(p.runId)) this.positionsByRun.set(p.runId, await api.runPositions(p.runId, 'FINAL'));
      this.drawRoute();
      this.flyTo(this.canonical?.points.length ? this.canonical.points : [this.route.a, this.route.b]);
    } catch (err) {
      this.message = `route: ${(err as Error).message}`;
    } finally {
      this.busy = null;
      this.render();
    }
  }

  private async routeAction(action: 'detect' | 'canonical' | 'validate' | 'delete') {
    if (!this.route) return;
    const id = this.route.id;
    this.busy = { detect: '회차 탐색 중…', canonical: '대표 경로 생성 중…', validate: '검증 중…', delete: '삭제 중…' }[action];
    this.message = '';
    this.render();
    try {
      if (action === 'detect') {
        const r = await api.detectPasses(id, this.includeSynthetic);
        this.message = `세션 ${r.sessions}개에서 회차 ${r.passes}개 (A→B ${r.ab}, B→A ${r.ba})`;
      } else if (action === 'canonical') {
        const r = await api.buildCanonical(id);
        this.message = `대표점 ${r.points}개 · 채택 ${r.passes.accepted} / 부분 ${r.passes.partial} / 거부 ${r.passes.rejected}`;
      } else if (action === 'validate') {
        const r = await api.validateRoute(id);
        this.message = `회차 ${r.passes}개 검증 · median XY ${num(r.pooled.medianXY, 2, ' m')}`;
        this.layers.errors = true;
      } else {
        if (!confirm(`경로 "${this.route.name}"를 삭제할까요? (회차·대표 경로·검증 결과도 함께 삭제)`)) return;
        await api.deleteRoute(id);
        this.routes = await api.routes();
        await this.selectRoute(null);
        return;
      }
      this.routes = await api.routes();
      await this.selectRoute(id);
    } catch (err) {
      this.message = (err as Error).message;
    } finally {
      this.busy = null;
      this.render();
    }
  }

  // ---------------- playback ----------------

  private frame(ts: number) {
    if (!this.active) {
      this.loopRunning = false;
      return;
    }
    const dt = this.lastFrame ? Math.min(ts - this.lastFrame, 250) : 0;
    this.lastFrame = ts;
    const a = this.a;
    if (a && this.playing && a.forward.length) {
      const end = a.forward.at(-1)!.t;
      this.t = this.speed === Infinity ? end : Math.min(end, this.t + dt * this.speed);
      if (this.t >= end) this.playing = false;
      this.updatePlayback();
    }
    requestAnimationFrame((x) => this.frame(x));
  }

  private updatePlayback() {
    for (const g of this.gpsIndex) g.point.show = this.layers.gps && g.t <= this.t;
    const timeEl = this.el.querySelector('#lab-time');
    if (timeEl && this.a) {
      timeEl.textContent = `${clock(this.t)} (${Math.round((this.t - (this.a.forward[0]?.t ?? this.t)) / 1000)} s)`;
      const slider = this.el.querySelector<HTMLInputElement>('#lab-slider');
      if (slider && document.activeElement !== slider) slider.value = String(this.t);
      const info = this.el.querySelector('#lab-now');
      if (info) info.innerHTML = this.nowHtml();
      const play = this.el.querySelector('[data-action="play"]');
      if (play) play.textContent = this.playing ? '❚❚' : '▶';
    }
  }

  private nowHtml(): string {
    const a = this.a;
    if (!a) return '';
    const i = indexAt(a.forward, this.t);
    if (i < 0) return '<span class="muted">before the first output</span>';
    const f = a.forward[i];
    const fin = a.final[Math.max(0, indexAt(a.final, this.t))];
    const correction = fin && a.forward !== a.final ? Math.hypot(fin.x - f.x, fin.y - f.y) : null;
    return `<table>
      <tr><th>source</th><td>${esc(f.source)}${f.stationary ? ' · stationary' : ''}</td></tr>
      <tr><th>σ / heading</th><td>${num(f.sigmaH, 1, ' m')} / ${num(f.heading, 0, '°')}</td></tr>
      <tr><th>GPS</th><td>${f.gpsUsed === null ? '–' : f.gpsUsed ? 'used' : 'rejected'}${f.gpsSequence ? ` #${f.gpsSequence}` : ''}</td></tr>
      <tr><th>height</th><td>${num(f.h, 1, ' m')} (${esc(f.zDatumSource ?? '–')}) · above ground ${num(f.heightAboveGround, 1, ' m')}</td></tr>
      <tr><th>building</th><td>${esc(f.buildingName ?? '–')}</td></tr>
      <tr><th>smoother moved</th><td>${correction === null ? '–' : `${correction.toFixed(1)} m (realtime → final)`}</td></tr>
    </table>`;
  }

  // ---------------- map ----------------

  private attachPicking() {
    const v = this.viewer();
    if (!v || this.handler) return;
    const C = Cesium();
    this.handler = new C.ScreenSpaceEventHandler(v.scene.canvas);
    this.handler.setInputAction((m: { position: unknown }) => {
      if (!this.active) return;
      if (this.picking) {
        const ray = v.camera.getPickRay(m.position);
        const cart = ray ? v.scene.globe.pick(ray, v.scene) : undefined;
        if (!cart) return;
        const g = C.Cartographic.fromCartesian(cart);
        this.draft[this.picking === 'A' ? 'a' : 'b'] = { latitude: C.Math.toDegrees(g.latitude), longitude: C.Math.toDegrees(g.longitude) };
        this.picking = null;
        this.drawRoute();
        this.render();
        return;
      }
      const hits: { id?: unknown }[] = v.scene.drillPick(m.position, 10);
      // point primitives carry our id object; entities are picked as the Entity (our tag is entity.labPick)
      const id = hits
        .map((h) => ((h.id as { labPick?: LabPick } | undefined)?.labPick ?? h.id) as LabPick | undefined)
        .find((x) => x && typeof x === 'object' && 'kind' in x && String(x.kind).startsWith('lab-'));
      if (!id) return;
      if (id.kind === 'lab-canonical') this.selectedPoint = this.canonical?.points[id.idx] ?? null;
      if (id.kind === 'lab-pass') this.selectedPass = id.passId;
      this.render();
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  }

  private clear(list: any[]) {
    const v = this.viewer();
    if (v) for (const e of list) v.entities.remove(e);
    list.length = 0;
  }

  private line(positions: RunPosition[] | { latitude: number; longitude: number; h?: number | null }[], color: string, width: number, opts: { dashed?: boolean; alpha?: number } = {}) {
    const C = Cesium();
    const v = this.viewer()!;
    const ground = positions.some((p) => p.h == null);
    const cs = C.Color.fromCssColorString(color).withAlpha(opts.alpha ?? 0.95);
    return v.entities.add({
      polyline: {
        positions: positions.map((p) => C.Cartesian3.fromDegrees(p.longitude, p.latitude, ground ? 0 : p.h! + 0.3)),
        width,
        clampToGround: ground,
        material: opts.dashed ? new C.PolylineDashMaterialProperty({ color: cs }) : cs,
        depthFailMaterial: ground ? undefined : new C.PolylineDashMaterialProperty({ color: cs.withAlpha(0.4) }),
      },
    });
  }

  private drawRuns() {
    const v = this.viewer();
    if (!v) return;
    const C = Cesium();
    this.clear(this.runEntities);
    if (this.gpsPoints) {
      v.scene.primitives.remove(this.gpsPoints);
      this.gpsPoints = null;
    }
    this.gpsIndex = [];
    const a = this.a;
    if (a) {
      // realtime-equivalent track grows with the playback time; the final (smoothed) track is drawn whole
      const fwdGround = a.forward.some((p) => p.h == null);
      const cart = a.forward.map((p) => C.Cartesian3.fromDegrees(p.longitude, p.latitude, fwdGround ? 0 : p.h! + 0.3));
      this.runEntities.push(v.entities.add({
        polyline: {
          positions: new C.CallbackProperty(() => cart.slice(0, Math.max(indexAt(a.forward, this.t) + 1, 0)), false),
          width: 3, clampToGround: fwdGround, material: C.Color.fromCssColorString('#f472b6'),
        },
        show: this.layers.forward,
      }));
      this.runEntities.at(-1).labRole = 'forward';
      this.runEntities.push(v.entities.add({
        position: new C.CallbackProperty(() => cart[Math.max(indexAt(a.forward, this.t), 0)], false),
        point: { pixelSize: 12, color: C.Color.fromCssColorString('#f472b6'), outlineColor: C.Color.WHITE, outlineWidth: 2,
          heightReference: fwdGround ? C.HeightReference.CLAMP_TO_GROUND : C.HeightReference.NONE, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        show: this.layers.forward,
      }));
      this.runEntities.at(-1).labRole = 'forward';
      if (a.final !== a.forward && a.final.length) {
        const e = this.line(a.final, '#fde047', 3);
        e.show = this.layers.final;
        e.labRole = 'final';
        this.runEntities.push(e);
      }
      this.gpsPoints = v.scene.primitives.add(new C.PointPrimitiveCollection());
      for (const p of a.gps) {
        const fix = a.fixes.get(p.sequence);
        const qc = a.qc.get(p.sequence);
        const point = this.gpsPoints.add({
          position: C.Cartesian3.fromDegrees(p.longitude, p.latitude, heightOf(p).h),
          pixelSize: 7, color: C.Color.fromCssColorString(fixColor(fix, qc)), outlineColor: C.Color.BLACK, outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, id: { kind: 'lab-gps', seq: p.sequence } satisfies LabPick,
        });
        this.gpsIndex.push({ p, t: Date.parse(p.timestamp), point });
      }
    }
    if (this.b?.final.length) {
      const e = this.line(this.b.final, '#22d3ee', 3, { dashed: true });
      e.show = this.layers.compare;
      e.labRole = 'compare';
      this.runEntities.push(e);
    }
    this.updatePlayback();
  }

  private drawRoute() {
    const v = this.viewer();
    if (!v) return;
    const C = Cesium();
    this.clear(this.routeEntities);
    if (this.canonicalDots) {
      v.scene.primitives.remove(this.canonicalDots);
      this.canonicalDots = null;
    }
    const ends: [string, { latitude: number; longitude: number } | null, number][] = this.route
      ? [['A', this.route.a, this.route.radiusM], ['B', this.route.b, this.route.radiusM]]
      : [['A', this.draft.a, this.draft.radiusM], ['B', this.draft.b, this.draft.radiusM]];
    for (const [label, p, r] of ends) {
      if (!p) continue;
      this.routeEntities.push(v.entities.add({
        position: C.Cartesian3.fromDegrees(p.longitude, p.latitude, 0),
        ellipse: { semiMajorAxis: r, semiMinorAxis: r, material: C.Color.WHITE.withAlpha(0.12), outline: true, outlineColor: C.Color.WHITE, heightReference: C.HeightReference.CLAMP_TO_GROUND },
        label: { text: label, font: 'bold 16px sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
          heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }));
    }
    const route = this.route;
    if (!route) return;
    if (this.layers.passes) {
      for (const p of route.passes) {
        const pts = (this.positionsByRun.get(p.runId) ?? []).filter((x) => x.t >= p.tStart && x.t <= p.tEnd);
        if (pts.length < 2) continue;
        const e = this.line(pts, passColor(p), this.selectedPass === p.id ? 4 : 2, { dashed: p.status === 'REJECTED' || p.excluded, alpha: 0.8 });
        e.labPick = { kind: 'lab-pass', passId: p.id } satisfies LabPick;
        this.routeEntities.push(e);
      }
    }
    const c = this.canonical;
    if (c?.points.length) {
      const zAbs = !c.metrics.zRelative && c.points.every((p) => p.z !== null);
      if (this.layers.corridor) {
        // band from left/right offsets along the normal, one polygon per run of equal confidence class
        const pts = c.points;
        const normal = (i: number) => {
          const a = pts[Math.max(0, i - 5)];
          const b = pts[Math.min(pts.length - 1, i + 5)];
          const dx = b.x - a.x, dy = b.y - a.y;
          const l = Math.hypot(dx, dy) || 1;
          return { x: -dy / l, y: dx / l };
        };
        const side = pts.map((p, i) => {
          const n = normal(i);
          return { left: offsetLL(p.latitude, p.longitude, n.x * p.halfWidthM, n.y * p.halfWidthM), right: offsetLL(p.latitude, p.longitude, -n.x * p.halfWidthM, -n.y * p.halfWidthM) };
        });
        let start = 0;
        for (let i = 1; i <= pts.length; i++) {
          if (i < pts.length && confidenceColor(pts[i]) === confidenceColor(pts[start])) continue;
          const lo = start, hi = Math.min(i, pts.length - 1);
          if (hi > lo) {
            const ring = [...side.slice(lo, hi + 1).map((s) => s.left), ...side.slice(lo, hi + 1).reverse().map((s) => s.right)];
            this.routeEntities.push(v.entities.add({
              polygon: { hierarchy: C.Cartesian3.fromDegreesArray(ring.flatMap((q) => [q.longitude, q.latitude])), material: C.Color.fromCssColorString(confidenceColor(pts[lo])).withAlpha(0.35) },
            }));
          }
          start = i;
        }
      }
      if (this.layers.canonical) {
        this.routeEntities.push(this.line(c.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude, h: zAbs ? p.z : null })), '#ffffff', 5));
        this.canonicalDots = v.scene.primitives.add(new C.PointPrimitiveCollection());
        for (const p of c.points) {
          this.canonicalDots.add({
            position: C.Cartesian3.fromDegrees(p.longitude, p.latitude, zAbs ? p.z! + 0.4 : 0),
            pixelSize: this.selectedPoint?.idx === p.idx ? 11 : 5, color: C.Color.fromCssColorString(confidenceColor(p)),
            disableDepthTestDistance: Number.POSITIVE_INFINITY, id: { kind: 'lab-canonical', idx: p.idx } satisfies LabPick,
          });
        }
      }
    }
    if (this.layers.errors && this.report) {
      for (const pe of this.report.errors) {
        for (const e of pe.errors) {
          if (e.d < 0.5) continue;
          const color = e.d < 2 ? '#22c55e' : e.d < 5 ? '#eab308' : '#ef4444';
          this.routeEntities.push(this.line([{ latitude: e.latitude, longitude: e.longitude, h: null }, { latitude: e.footLatitude, longitude: e.footLongitude, h: null }], color, 1));
        }
      }
    }
  }

  private flyTo(points: { latitude: number; longitude: number }[]) {
    const v = this.viewer();
    if (!v || !points.length) return;
    const C = Cesium();
    const sphere = C.BoundingSphere.fromPoints(points.map((p) => C.Cartesian3.fromDegrees(p.longitude, p.latitude, 140)));
    sphere.radius = Math.max(sphere.radius, 60);
    v.camera.flyToBoundingSphere(sphere, { duration: 1.2, offset: new C.HeadingPitchRange(0, C.Math.toRadians(-60), sphere.radius * 3) });
  }

  private applyVisibility() {
    for (const e of this.runEntities) {
      e.show = this.active && (e.labRole === 'forward' ? this.layers.forward : e.labRole === 'final' ? this.layers.final : this.layers.compare);
    }
    if (this.gpsPoints) this.gpsPoints.show = this.active;
    for (const g of this.gpsIndex) g.point.show = this.layers.gps && g.t <= this.t;
    for (const e of this.routeEntities) e.show = this.active;
    if (this.canonicalDots) this.canonicalDots.show = this.active;
  }

  // ---------------- UI ----------------

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!t) return;
    const action = t.dataset.action!;
    if (action === 'tab') {
      this.tab = t.dataset.tab as 'runs' | 'routes';
      this.render();
    } else if (action === 'load-run') await this.loadRun(t.dataset.run!, 'A');
    else if (action === 'compare-run') {
      if (this.b?.run.id === t.dataset.run) {
        this.b = null;
        this.drawRuns();
        this.render();
      } else await this.loadRun(t.dataset.run!, 'B');
    } else if (action === 'pin-run') {
      const r = this.runs.find((x) => x.id === t.dataset.run);
      if (r) {
        await api.pinRun(r.id, !r.pinned);
        this.runs = await api.runs(r.sessionId);
        this.render();
      }
    } else if (action === 'replay') await this.replay();
    else if (action === 'play') {
      if (!this.a) return;
      if (!this.playing && this.t >= (this.a.forward.at(-1)?.t ?? 0)) this.t = this.a.forward[0]?.t ?? 0;
      this.playing = !this.playing;
      this.updatePlayback();
    } else if (action === 'speed') {
      this.speed = Number(t.dataset.speed);
      if (this.speed === Infinity && this.a) {
        this.t = this.a.forward.at(-1)?.t ?? this.t;
        this.playing = false;
      }
      this.render();
      this.updatePlayback();
    } else if (action === 'jump') {
      this.t = Number(t.dataset.t);
      this.playing = false;
      this.updatePlayback();
    } else if (action === 'pick') {
      this.picking = t.dataset.end as 'A' | 'B';
      this.message = `지도에서 ${this.picking} 지점을 클릭하세요`;
      this.render();
    } else if (action === 'create-route') await this.createRoute();
    else if (action === 'route') await this.routeAction(t.dataset.op as 'detect' | 'canonical' | 'validate' | 'delete');
    else if (action === 'select-pass') {
      this.selectedPass = this.selectedPass === t.dataset.pass ? null : t.dataset.pass!;
      this.drawRoute();
      this.render();
    }
  }

  private async onChange(e: Event) {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.id === 'lab-session') await this.selectSession(t.value);
    else if (t.id === 'lab-route') await this.selectRoute(t.value || null);
    else if (t.dataset.layer) {
      this.layers[t.dataset.layer as keyof typeof this.layers] = (t as HTMLInputElement).checked;
      if (['passes', 'canonical', 'corridor', 'errors'].includes(t.dataset.layer)) this.drawRoute();
      this.applyVisibility();
    } else if (t.dataset.exclude) {
      if (!this.route) return;
      await api.excludePass(this.route.id, t.dataset.exclude, (t as HTMLInputElement).checked);
      await this.selectRoute(this.route.id);
    } else if (t.id === 'lab-include-synthetic') this.includeSynthetic = (t as HTMLInputElement).checked;
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'lab-slider') {
      this.t = Number(t.value);
      this.playing = false;
      this.updatePlayback();
    } else if (t.id === 'lab-route-name') this.draft.name = t.value;
    else if (t.id === 'lab-route-radius') {
      this.draft.radiusM = Number(t.value) || 15;
      this.drawRoute();
    }
  }

  private async replay() {
    if (!this.sessionId) return;
    const val = (id: string) => this.el.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`)?.value ?? '';
    const overrides: Record<string, unknown> = {};
    for (const line of val('lab-overrides').split(/\n|,/).map((x) => x.trim()).filter(Boolean)) {
      const i = line.indexOf('=');
      if (i <= 0) {
        this.message = `override "${line}": use key=value`;
        this.render();
        return;
      }
      const raw = line.slice(i + 1).trim();
      overrides[line.slice(0, i).trim()] = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : raw;
    }
    this.busy = 'replaying…';
    this.message = '';
    this.render();
    try {
      const r = await api.replay(this.sessionId, {
        algorithmVersion: val('lab-version'), variant: val('lab-variant') || null, overrides: Object.keys(overrides).length ? overrides : null,
        mode: val('lab-mode') as 'SENSOR_TIME' | 'AS_RECEIVED',
      });
      this.message = `run ${r.runId.slice(0, 8)}: ${r.outputs} positions in ${r.durationMs} ms`;
      this.runs = await api.runs(this.sessionId);
      await this.loadRun(r.runId, 'A');
    } catch (err) {
      this.message = (err as Error).message;
    } finally {
      this.busy = null;
      this.render();
    }
  }

  private async createRoute() {
    const d = this.draft;
    if (!d.name.trim() || !d.a || !d.b) {
      this.message = '이름, A, B를 모두 지정하세요';
      this.render();
      return;
    }
    try {
      const r = await api.createRoute({ name: d.name.trim(), a: d.a, b: d.b, radiusM: d.radiusM });
      this.draft = { name: '', a: null, b: null, radiusM: 15 };
      this.routes = await api.routes();
      await this.selectRoute(r.id);
    } catch (err) {
      this.message = (err as Error).message;
      this.render();
    }
  }

  render() {
    if (!this.active) return;
    const tabs = `<div class="lab-tabs">
      <button data-action="tab" data-tab="runs" class="${this.tab === 'runs' ? 'active' : ''}">재생 (Replay)</button>
      <button data-action="tab" data-tab="routes" class="${this.tab === 'routes' ? 'active' : ''}">경로 (Routes)</button>
    </div>`;
    const status = `${this.busy ? `<div class="lab-busy">${esc(this.busy)}</div>` : ''}${this.message ? `<div class="lab-msg">${esc(this.message)}</div>` : ''}`;
    this.el.innerHTML = tabs + status + (this.tab === 'runs' ? this.runsHtml() : this.routesHtml());
    this.updatePlayback();
  }

  private runsHtml(): string {
    const sessions = this.sessions
      .map((s) => `<option value="${esc(s.sessionId)}" ${s.sessionId === this.sessionId ? 'selected' : ''}>${esc(s.collectorId)} · ${new Date(s.startedAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${esc(s.sessionId.slice(0, 8))}</option>`)
      .join('');
    const runs = this.runs
      .map((r) => {
        const label = `${r.algorithmVersion.replace('fusion-', '')}${r.revision ? ` r${r.revision}` : ''}${r.variant ? ` · ${esc(r.variant)}` : ''}${r.mode === 'AS_RECEIVED' ? ' · as-received' : ''}`;
        const warn = r.metrics?.validation?.warnings.map((w) => w.code).join(', ');
        return `<li class="${this.a?.run.id === r.id ? 'selected' : ''}">
          <span data-action="load-run" data-run="${r.id}" class="lab-link"><b>${label}</b></span>
          ${r.published ? '<span class="tag">published</span>' : ''}${r.pinned ? '<span class="tag">📌</span>' : ''}
          <span class="muted right">${new Date(r.startedAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          <div class="sub muted">${r.outputCount ?? '–'} pts · path ${num(r.metrics?.fusedPathLengthM, 0, ' m')} · GPS ${r.metrics?.gpsAccepted ?? '–'}/${r.metrics?.gpsRejected ?? '–'}
            ${r.overrides ? ` · ${esc(JSON.stringify(r.overrides))}` : ''}${warn ? ` · <span class="warn-text">${esc(warn)}</span>` : ''}
            · <span class="lab-link" data-action="compare-run" data-run="${r.id}">${this.b?.run.id === r.id ? '비교 해제' : '비교(B)'}</span>
            · <span class="lab-link" data-action="pin-run" data-run="${r.id}">${r.pinned ? 'unpin' : 'pin'}</span></div>
        </li>`;
      })
      .join('');
    const a = this.a;
    const t0 = a?.forward[0]?.t ?? 0;
    const t1 = a?.forward.at(-1)?.t ?? 0;
    const events = a
      ? a.events.filter((e) => !HIDDEN_EVENTS.has(e.type)).slice(0, 300)
          .map((e) => `<li data-action="jump" data-t="${e.t}"><span class="muted">${clock(e.t)}</span> ${esc(e.type)} <span class="muted">${esc(eventText(e))}</span></li>`).join('')
      : '';
    const stairs = a ? a.events.filter((e) => e.type === 'stair-step').length : 0;
    const steps = a ? a.events.filter((e) => e.type === 'step').length : 0;
    return `
      <section><h3>세션</h3>
        <select id="lab-session"><option value="">— 세션 선택 —</option>${sessions}</select>
      </section>
      ${this.sessionId ? `<section><h3>새 Replay</h3>
        <div class="lab-form">
          <select id="lab-version">${this.versions.map((v) => `<option ${v === 'fusion-v4' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
          <select id="lab-mode"><option value="SENSOR_TIME">센서 시각순 (정식)</option><option value="AS_RECEIVED">수신 순서 (실시간 재현)</option></select>
          <input id="lab-variant" placeholder="변형 이름 (선택)" maxlength="48" />
          <textarea id="lab-overrides" rows="2" placeholder="파라미터 변경 (선택) 예: gpsGateChi2=9"></textarea>
          <button data-action="replay" ${this.busy ? 'disabled' : ''}>Replay 실행</button>
        </div>
        <div class="small muted">결과는 실행 스냅샷으로만 저장됩니다(게시 안 함). 기존 결과는 지워지지 않습니다.</div>
      </section>
      <section><h3>실행 (${this.runs.length})</h3><ul class="list lab-runs">${runs || '<li class="muted">없음</li>'}</ul></section>` : ''}
      ${a ? `<section><h3>재생 · ${esc(a.run.algorithmVersion)}${a.run.variant ? ` · ${esc(a.run.variant)}` : ''}</h3>
        <div class="lab-player">
          <button data-action="play">${this.playing ? '❚❚' : '▶'}</button>
          ${SPEEDS.map(([l, s]) => `<button data-action="speed" data-speed="${s}" class="${this.speed === s ? 'active' : ''}">${l}</button>`).join('')}
          <span id="lab-time" class="muted"></span>
        </div>
        <input id="lab-slider" type="range" min="${t0}" max="${t1}" step="100" value="${this.t}" />
        <div class="lab-layers">
          <label><input type="checkbox" data-layer="forward" ${this.layers.forward ? 'checked' : ''}/> <span style="color:#f472b6">실시간(전방)</span></label>
          <label><input type="checkbox" data-layer="final" ${this.layers.final ? 'checked' : ''}/> <span style="color:#fde047">최종(스무딩)</span></label>
          <label><input type="checkbox" data-layer="gps" ${this.layers.gps ? 'checked' : ''}/> 원본 GPS</label>
          <label><input type="checkbox" data-layer="compare" ${this.layers.compare ? 'checked' : ''}/> <span style="color:#22d3ee">비교(B)</span></label>
        </div>
        <div class="small muted">GPS 색: <span style="color:#22c55e">채택</span> · <span style="color:#ef4444">실시간 거부</span> · <span style="color:#f97316">스무더 가중치↓</span> · <span style="color:#64748b">qc-v1 제외</span></div>
        <div id="lab-now" class="detail"></div>
      </section>
      <section><h3>사건 <span class="muted">걸음 ${steps} · 계단 ${stairs}</span></h3><ul class="list lab-events">${events || '<li class="muted">없음</li>'}</ul></section>` : ''}`;
  }

  private routesHtml(): string {
    const r = this.route;
    const routes = this.routes.map((x) => `<option value="${x.id}" ${r?.id === x.id ? 'selected' : ''}>${esc(x.name)} (${x.passes})</option>`).join('');
    const d = this.draft;
    const create = `<section><h3>새 경로</h3>
      <div class="lab-form">
        <input id="lab-route-name" placeholder="경로 이름" value="${esc(d.name)}" maxlength="80" />
        <div class="lab-row">
          <button data-action="pick" data-end="A" class="${this.picking === 'A' ? 'active' : ''}">A ${d.a ? '✓' : '지정'}</button>
          <button data-action="pick" data-end="B" class="${this.picking === 'B' ? 'active' : ''}">B ${d.b ? '✓' : '지정'}</button>
          <label>반경 <input id="lab-route-radius" type="number" min="3" max="60" value="${d.radiusM}" style="width:56px" /> m</label>
        </div>
        <button data-action="create-route">경로 만들기</button>
      </div></section>`;
    if (!r) return `<section><h3>경로</h3><select id="lab-route"><option value="">— 경로 선택 —</option>${routes}</select></section>${create}`;
    const c = this.canonical;
    const rep = this.report?.metrics;
    const passes = r.passes
      .map((p) => {
        const s = this.sessions.find((x) => x.sessionId === p.sessionId);
        return `<tr class="${this.selectedPass === p.id ? 'selected' : ''}">
          <td><span class="dot" style="background:${passColor(p)}"></span><span class="lab-link" data-action="select-pass" data-pass="${p.id}">${esc(s?.collectorId ?? '')} ${esc(p.sessionId.slice(0, 8))}</span></td>
          <td>${p.direction}${p.flipped ? '↺' : ''}</td>
          <td>${esc(p.status ?? '–')}${p.reasons.length ? ` <span class="muted">${esc(p.reasons.join(','))}</span>` : ''}</td>
          <td>${Math.round((p.tEnd - p.tStart) / 1000)}s</td>
          <td><input type="checkbox" title="제외" data-exclude="${p.id}" ${p.excluded ? 'checked' : ''}/></td>
        </tr>`;
      })
      .join('');
    const sp = this.selectedPoint;
    const point = sp
      ? `<section><h3>대표점 s = ${sp.s.toFixed(0)} m</h3><table class="lab-kv">
          <tr><th>표본 수 n</th><td>${sp.sampleCount}${sp.lowSamples ? ' <span class="tag warn">LOW</span>' : ''}</td></tr>
          <tr><th>σXY (회차 간)</th><td>${num(sp.sigmaXY, 2, ' m')}</td></tr>
          <tr><th>σZ</th><td>${num(sp.sigmaZ, 2, ' m')}</td></tr>
          <tr><th>대표점 표준오차</th><td>${num(sp.seXY, 2, ' m')}</td></tr>
          <tr><th>신뢰 폭 (반폭)</th><td>${num(sp.halfWidthM, 2, ' m')}</td></tr>
          <tr><th>신뢰도</th><td>${num(sp.confidence, 2)}</td></tr>
          <tr><th>높이</th><td>${num(sp.z, 1, ' m')}${c?.metrics.zRelative ? ' (상대)' : ''}</td></tr>
          <tr><th>기여 회차</th><td>${sp.contributors.map((id) => {
            const p = r.passes.find((x) => x.id === id);
            return p ? `${esc(p.sessionId.slice(0, 8))} ${p.direction} ${clock(p.tStart)}` : esc(id.slice(0, 8));
          }).join('<br>')}</td></tr>
        </table></section>`
      : '';
    return `<section><h3>경로</h3><select id="lab-route"><option value="">— 경로 선택 —</option>${routes}</select>
        <div class="small muted">${esc(r.fusionVersion)}${r.fusionVariant ? ` · ${esc(r.fusionVariant)}` : ''} · 반경 ${r.radiusM} m · 폭 ${r.widthM} m</div>
        <div class="lab-row">
          <label><input type="checkbox" id="lab-include-synthetic" ${this.includeSynthetic ? 'checked' : ''}/> 합성 세션 포함</label>
        </div>
        <div class="lab-row">
          <button data-action="route" data-op="detect" ${this.busy ? 'disabled' : ''}>회차 탐색</button>
          <button data-action="route" data-op="canonical" ${this.busy ? 'disabled' : ''}>대표 경로</button>
          <button data-action="route" data-op="validate" ${this.busy ? 'disabled' : ''}>검증</button>
          <button data-action="route" data-op="delete" class="danger-text">삭제</button>
        </div>
        <div class="lab-layers">
          <label><input type="checkbox" data-layer="passes" ${this.layers.passes ? 'checked' : ''}/> 회차 궤적</label>
          <label><input type="checkbox" data-layer="canonical" ${this.layers.canonical ? 'checked' : ''}/> 대표 경로</label>
          <label><input type="checkbox" data-layer="corridor" ${this.layers.corridor ? 'checked' : ''}/> 신뢰 폭</label>
          <label><input type="checkbox" data-layer="errors" ${this.layers.errors ? 'checked' : ''}/> 검증 오차</label>
        </div>
        <div class="small muted">신뢰 폭 색: <span style="color:#22c55e">σ&lt;2 m, n≥5</span> · <span style="color:#eab308">σ&lt;5 m</span> · <span style="color:#ef4444">σ≥5 m 또는 n&lt;3</span>. 폭은 회차 간 재현성이지 정확도가 아닙니다.</div>
      </section>
      <section><h3>회차 (${r.passes.length})</h3><table class="lab-table"><tr><th>세션</th><th>방향</th><th>판정</th><th>시간</th><th>제외</th></tr>${passes || '<tr><td colspan="5" class="muted">회차 탐색을 실행하세요</td></tr>'}</table></section>
      ${c ? `<section><h3>대표 경로</h3><table class="lab-kv">
        <tr><th>길이 / 대표점</th><td>${num(c.metrics.lengthM, 0, ' m')} / ${c.metrics.points}</td></tr>
        <tr><th>회차</th><td>채택 ${c.metrics.passes.accepted} · 부분 ${c.metrics.passes.partial} · 거부 ${c.metrics.passes.rejected} · 방향 뒤집음 ${c.metrics.passes.flipped}</td></tr>
        <tr><th>σXY 중앙값 / P95</th><td>${num(c.metrics.sigmaXY.median, 2, ' m')} / ${num(c.metrics.sigmaXY.p95, 2, ' m')}</td></tr>
        <tr><th>신뢰도 중앙값</th><td>${num(c.metrics.confidence.median, 2)} · 표본 부족 ${num((c.metrics.lowSampleFraction ?? 0) * 100, 0, '%')}</td></tr>
        <tr><th>알고리즘</th><td>${esc(c.algorithm)} · ${esc(c.metrics.paramsHash)}</td></tr>
      </table></section>` : ''}
      ${rep ? `<section><h3>검증 (회차 하나씩 빼기)</h3><table class="lab-kv">
        <tr><th>회차 / 지점</th><td>${rep.passes} / ${rep.pooled.stations}</td></tr>
        <tr><th>XY 중앙값 / P95 / 최대</th><td>${num(rep.pooled.medianXY, 2)} / ${num(rep.pooled.p95XY, 2)} / ${num(rep.pooled.maxXY, 2)} m</td></tr>
        <tr><th>Z 중앙값 / P95</th><td>${num(rep.pooled.medianZ, 2)} / ${num(rep.pooled.p95Z, 2)} m</td></tr>
        <tr><th>신뢰 폭 포함률</th><td>${num((rep.pooled.corridorCoverage ?? NaN) * 100, 0, '%')} <span class="muted">(약 95%면 폭이 맞음)</span></td></tr>
        <tr><th>원본 제외 비율 (qc-v1)</th><td>${num((rep.rejectedPointRatio ?? NaN) * 100, 1, '%')} · 퓨전 가중치↓ ${num((rep.fusionDownweightedRatio ?? NaN) * 100, 1, '%')}</td></tr>
        <tr><th>마커 퍼짐 (같은 지점)</th><td>${num(rep.markerSpreadM, 2, ' m')} <span class="muted">${rep.markerClusters.length}곳</span></td></tr>
      </table><div class="small muted">회차 간 일관성 지표입니다. 같은 장소에서 모든 회차가 같은 쪽으로 틀리는 편향은 앵커로만 드러납니다.</div></section>` : ''}
      ${point}${create}`;
  }
}

function eventText(e: RunEvent): string {
  const d = e.details;
  const r1 = (v: unknown) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
  switch (e.type) {
    case 'heading': return `${d.source} θ ${r1(d.headingOffsetDeg)}° ±${r1(d.sigmaDeg)}°`;
    case 'heading-segment': return String(d.reason ?? '');
    case 'reanchor': return `shift ${r1(d.shift)} m`;
    case 'initialized': return `accuracy ${r1(d.accuracy)} m`;
    case 'ground-contact': return `zero ${r1(d.offset)} ±${r1(d.sigma)} m`;
    case 'smoothed': return `fixes ${d.fixes} · used ${d.gpsAccepted} · segments ${d.segmentsWithHeading}/${d.segments}`;
    default: return Object.entries(d).slice(0, 3).map(([k, v]) => `${k} ${r1(v)}`).join(' · ');
  }
}
