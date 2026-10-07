// Editor view layer: local-only display preferences and a CAD/Blender-style camera controller.
// Nothing here is sent to the server or other editors; preferences live in this browser only.
// Cesium is passed in as the namespace object (editor-main keeps the global `C` pattern).

export type NavPreset = 'cesium' | 'blender' | 'cad';
export type EndpointMode = 'selected' | 'all' | 'off';
export type ViewPrefs = {
  roadColors: Record<string, string>;
  dimOthers: boolean; dimAlpha: number;
  depthFade: boolean; fadeNear: number; fadeFar: number; fadeMin: number;
  endpoints: EndpointMode;
  hoverHighlight: boolean;
  preset: NavPreset; zoomToPointer: boolean; invertZoom: boolean;
  sens: { rotate: number; pan: number; zoom: number };
};

const PREFS_KEY = 'campus.editor.viewPrefs';
export const DEFAULT_PREFS: ViewPrefs = {
  roadColors: {}, dimOthers: true, dimAlpha: 0.25,
  depthFade: true, fadeNear: 80, fadeFar: 700, fadeMin: 0.3,
  endpoints: 'selected', hoverHighlight: true,
  preset: 'cesium', zoomToPointer: false, invertZoom: false,
  sens: { rotate: 1, pan: 1, zoom: 1 },
};

export function loadPrefs(): ViewPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_PREFS);
    return { ...structuredClone(DEFAULT_PREFS), ...raw, sens: { ...DEFAULT_PREFS.sens, ...(raw.sens ?? {}) },
      roadColors: typeof raw.roadColors === 'object' && raw.roadColors ? raw.roadColors : {} };
  } catch { return structuredClone(DEFAULT_PREFS); }
}
export function savePrefs(p: ViewPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode: keep in memory only */ }
}

/** 0 at `near`, 1 at `far`, smooth in between. */
export function smoothstep(near: number, far: number, d: number) {
  if (far <= near) return d >= far ? 1 : 0;
  const t = Math.min(1, Math.max(0, (d - near) / (far - near)));
  return t * t * (3 - 2 * t);
}

/** Shortest distance from point p to a polyline (ECEF Cartesian3 list). */
export function distanceToPolyline(C: any, p: any, pts: any[], scratch: { a: any; b: any }) {
  if (!pts.length) return Number.POSITIVE_INFINITY;
  if (pts.length === 1) return C.Cartesian3.distance(p, pts[0]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const ab = C.Cartesian3.subtract(b, a, scratch.a);
    const ap = C.Cartesian3.subtract(p, a, scratch.b);
    const len2 = C.Cartesian3.magnitudeSquared(ab);
    const t = len2 > 0 ? Math.min(1, Math.max(0, C.Cartesian3.dot(ap, ab) / len2)) : 0;
    C.Cartesian3.multiplyByScalar(ab, t, ab);
    C.Cartesian3.add(a, ab, ab);
    const d = C.Cartesian3.distance(p, ab);
    if (d < best) best = d;
  }
  return best;
}

type DragOp = 'orbit' | 'pan-ground' | 'pan-screen' | 'zoom';
export type NavHooks = {
  prefs: () => ViewPrefs;
  /** World (ECEF) position of the editor cursor. */
  cursorWorld: () => any;
  /** True when the user pinned the orbit center to the editor cursor. */
  orbitLocked: () => boolean;
  /** Existing editor zoom (height-scaled). screen = zoom toward that pixel, otherwise toward screen centre. */
  zoom: (steps: number, screen?: { x: number; y: number }) => void;
  zoomExtents: () => void;
  onHover: (featureId: string | null, screen: { x: number; y: number } | null) => void;
  onUserCamera: () => void;
};

const ORBIT_RAD_PER_PX = 0.006;

export class NavController {
  private drag: { op: DragOp; button: number; last: { x: number; y: number }; pivot?: any; plane?: any; grab?: any; depth?: number } | null = null;
  private lastMiddleDown = 0;
  private hoverFrame = 0;
  private hoverPos: { x: number; y: number } | null = null;
  private altUsed = false;

  constructor(private viewer: any, private C: any, private hooks: NavHooks) {}

  install() {
    const C = this.C, scene = this.viewer.scene, canvas: HTMLCanvasElement = scene.canvas;
    const ctl = scene.screenSpaceCameraController;
    // All mouse navigation is handled here so sensitivity and button mapping apply uniformly.
    ctl.enableRotate = false; ctl.enableTranslate = false; ctl.enableTilt = false; ctl.enableLook = false; ctl.enableZoom = false;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('blur', () => { this.drag = null; });
    window.addEventListener('keyup', (e) => { if ((e.code === 'AltLeft' || e.code === 'AltRight') && this.altUsed) { e.preventDefault(); this.altUsed = false; } });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.hooks.prefs();
      const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1);
      const steps = -pixels / 100 * p.sens.zoom * (p.invertZoom ? -1 : 1);
      this.hooks.zoom(steps, p.zoomToPointer ? this.local(e) : undefined);
      this.hooks.onUserCamera();
    }, { passive: false });
    canvas.addEventListener('pointerleave', () => { this.hoverPos = null; this.hooks.onHover(null, null); });
    void C;
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = (this.viewer.scene.canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private opFor(e: PointerEvent): DragOp | null {
    const p = this.hooks.prefs(), b = e.button;
    if (p.preset === 'blender') {
      // Middle button, or Alt+Left ("Emulate 3 Button Mouse") for laptops.
      if (b === 1 || (b === 0 && e.altKey)) return e.shiftKey ? 'pan-screen' : e.ctrlKey ? 'zoom' : 'orbit';
      return null;
    }
    if (p.preset === 'cad') {
      if (b === 1) return e.shiftKey ? 'orbit' : 'pan-screen';
      if (b === 0 && e.altKey) return e.shiftKey ? 'orbit' : 'pan-screen';
      return null;
    }
    // cesium (former behaviour): left pan (orbit when locked to cursor), middle / Ctrl+left orbit, right zoom.
    if (b === 0) return e.ctrlKey || this.hooks.orbitLocked() ? 'orbit' : 'pan-ground';
    if (b === 1) return 'orbit';
    if (b === 2) return 'zoom';
    return null;
  }

  /** Point under a pixel: depth buffer first (buildings), then globe, then a point along the ray. */
  pickWorld(pos: { x: number; y: number }) {
    const C = this.C, scene = this.viewer.scene, camera = this.viewer.camera;
    const px = new C.Cartesian2(pos.x, pos.y);
    let hit: any;
    try { if (scene.pickPositionSupported) hit = scene.pickPosition(px); } catch { hit = undefined; }
    const ray = camera.getPickRay(px);
    if (!hit || !Number.isFinite(hit.x)) hit = ray ? scene.globe.pick(ray, scene) : undefined;
    if (hit && Number.isFinite(hit.x)) {
      const d = C.Cartesian3.distance(hit, camera.positionWC);
      if (d > 0.5 && d < 50_000) return hit;
    }
    if (!ray) return undefined;
    const fallback = Math.max(20, Math.abs(camera.positionCartographic.height) * 2);
    return C.Ray.getPoint(ray, fallback, new C.Cartesian3());
  }

  private onDown(e: PointerEvent) {
    const op = this.opFor(e);
    if (!op) return;
    const C = this.C, pos = this.local(e);
    if (e.button === 1) {
      const now = performance.now();
      if (now - this.lastMiddleDown < 320 && this.hooks.prefs().preset === 'cad') { this.lastMiddleDown = 0; this.hooks.zoomExtents(); return; }
      this.lastMiddleDown = now;
    }
    if (e.altKey) this.altUsed = true;
    const drag: NonNullable<NavController['drag']> = { op, button: e.button, last: pos };
    if (op === 'orbit') drag.pivot = this.hooks.orbitLocked() ? this.hooks.cursorWorld() : this.pickWorld(pos);
    if (op === 'pan-ground' || op === 'pan-screen') {
      drag.grab = this.pickWorld(pos);
      if (drag.grab) {
        drag.depth = C.Cartesian3.distance(drag.grab, this.viewer.camera.positionWC);
        const normal = C.Ellipsoid.WGS84.geodeticSurfaceNormal(drag.grab, new C.Cartesian3());
        drag.plane = C.Plane.fromPointNormal(drag.grab, normal);
      }
    }
    this.drag = drag;
    this.hooks.onHover(null, null);
  }

  private onUp(e: PointerEvent) {
    if (this.drag && e.button === this.drag.button) this.drag = null;
  }

  private onMove(e: PointerEvent) {
    const pos = this.local(e);
    if (!this.drag) { this.scheduleHover(e, pos); return; }
    if ((e.buttons & ({ 0: 1, 1: 4, 2: 2 } as Record<number, number>)[this.drag.button]) === 0) { this.drag = null; return; }
    const dx = pos.x - this.drag.last.x, dy = pos.y - this.drag.last.y;
    if (!dx && !dy) return;
    const p = this.hooks.prefs();
    switch (this.drag.op) {
      case 'orbit': if (this.drag.pivot) this.orbit(this.drag.pivot, dx * ORBIT_RAD_PER_PX * p.sens.rotate, dy * ORBIT_RAD_PER_PX * p.sens.rotate); break;
      case 'pan-ground': if (!this.panGround(pos, p.sens.pan)) this.panScreen(dx, dy, p.sens.pan); break;
      case 'pan-screen': this.panScreen(dx, dy, p.sens.pan); break;
      case 'zoom': this.hooks.zoom(dy / 70 * p.sens.zoom * (p.invertZoom ? -1 : 1)); break;
    }
    this.drag.last = pos;
    this.hooks.onUserCamera();
  }

  private scheduleHover(e: PointerEvent, pos: { x: number; y: number }) {
    if (e.target !== this.viewer.scene.canvas || !this.hooks.prefs().hoverHighlight) return;
    this.hoverPos = pos;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const at = this.hoverPos;
      if (!at) return;
      let id: string | null = null;
      try {
        const picked = this.viewer.scene.pick(new this.C.Cartesian2(at.x, at.y), 6, 6);
        const raw = picked?.id?.id ?? picked?.id;
        if (typeof raw === 'string' && /^editor:(road|place|vertex):/.test(raw)) id = raw;
      } catch { id = null; }
      this.hooks.onHover(id, at);
    });
  }

  /** Move the camera by a world-space (ECEF) vector regardless of its reference frame. */
  private moveWorld(delta: any) {
    const C = this.C, camera = this.viewer.camera;
    const local = C.Matrix4.multiplyByPointAsVector(camera.inverseTransform, delta, new C.Cartesian3());
    C.Cartesian3.add(camera.position, local, camera.position);
  }

  /** Rotate the camera around a world pivot; positive yaw follows a rightward drag (scene turns with the mouse). */
  orbit(pivot: any, yaw: number, pitch: number) {
    const C = this.C, camera = this.viewer.camera;
    const saved = C.Matrix4.clone(camera.transform);
    const savedAxis = camera.constrainedAxis;
    camera.lookAtTransform(C.Transforms.eastNorthUpToFixedFrame(pivot));
    camera.constrainedAxis = C.Cartesian3.UNIT_Z;
    if (yaw) camera.rotateLeft(yaw);
    if (pitch) camera.rotateDown(pitch);
    camera.constrainedAxis = savedAxis;
    camera.lookAtTransform(saved);
  }

  /** Grab-and-drag on the horizontal plane through the grabbed point (map-style pan). */
  private panGround(pos: { x: number; y: number }, sens: number) {
    const C = this.C, camera = this.viewer.camera, d = this.drag!;
    if (!d.plane || !d.grab) return false;
    const ray = camera.getPickRay(new C.Cartesian2(pos.x, pos.y));
    const hit = ray && C.IntersectionTests.rayPlane(ray, d.plane);
    if (!hit) return false;
    const delta = C.Cartesian3.subtract(d.grab, hit, new C.Cartesian3());
    const limit = Math.max(5, (d.depth ?? 100) * 0.5);
    const mag = C.Cartesian3.magnitude(delta);
    if (!Number.isFinite(mag)) return false;
    if (mag > limit) C.Cartesian3.multiplyByScalar(delta, limit / mag, delta);
    C.Cartesian3.multiplyByScalar(delta, sens, delta);
    this.moveWorld(delta);
    return true;
  }

  /** Screen-plane pan scaled so the grabbed depth tracks the mouse (sens = 1). */
  private panScreen(dx: number, dy: number, sens: number) {
    const C = this.C, camera = this.viewer.camera, canvas: HTMLCanvasElement = this.viewer.scene.canvas;
    const f = camera.frustum;
    let mpp: number;
    if (f instanceof C.OrthographicFrustum) mpp = f.width / Math.max(1, canvas.clientWidth);
    else {
      const depth = this.drag?.depth ?? Math.max(10, Math.abs(camera.positionCartographic.height));
      const fovy = f.fovy ?? f.fov ?? Math.PI / 3;
      mpp = depth * 2 * Math.tan(fovy / 2) / Math.max(1, canvas.clientHeight);
    }
    camera.moveLeft(dx * mpp * sens);
    camera.moveUp(dy * mpp * sens);
  }

  /** Pivot used by keyboard view commands: cursor when locked, otherwise the point at screen centre. */
  viewPivot() {
    if (this.hooks.orbitLocked()) return this.hooks.cursorWorld();
    const canvas: HTMLCanvasElement = this.viewer.scene.canvas;
    return this.pickWorld({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }) ?? this.hooks.cursorWorld();
  }

  /** Blender numpad-style standard views around the current pivot, keeping distance. */
  standardView(kind: 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left') {
    const C = this.C, camera = this.viewer.camera;
    const pivot = this.viewPivot();
    if (!pivot) return;
    const range = Math.max(5, C.Cartesian3.distance(camera.positionWC, pivot));
    const deg = C.Math.toRadians;
    const hp: Record<string, [number, number]> = {
      top: [camera.heading, deg(-90)], bottom: [camera.heading, deg(89.9)],
      front: [deg(0), 0], back: [deg(180), 0], right: [deg(270), 0], left: [deg(90), 0],
    };
    const [h, p] = hp[kind];
    this.lookAt(pivot, h, p, range);
  }

  /** Opposite side of the current view (numpad 9): heading +180° around the pivot, same tilt so it stays above ground. */
  flipView() {
    const C = this.C, camera = this.viewer.camera;
    const pivot = this.viewPivot();
    if (!pivot) return;
    this.lookAt(pivot, camera.heading + Math.PI, camera.pitch, Math.max(5, C.Cartesian3.distance(camera.positionWC, pivot)));
  }

  orbitStep(yawDeg: number, pitchDeg: number) {
    const pivot = this.viewPivot();
    if (pivot) this.orbit(pivot, this.C.Math.toRadians(yawDeg), this.C.Math.toRadians(pitchDeg));
    this.hooks.onUserCamera();
  }

  private lookAt(pivot: any, heading: number, pitch: number, range: number) {
    const C = this.C, camera = this.viewer.camera;
    camera.lookAt(pivot, new C.HeadingPitchRange(heading, pitch, range));
    if (this.hooks.orbitLocked()) camera.lookAtTransform(C.Transforms.eastNorthUpToFixedFrame(this.hooks.cursorWorld()));
    else camera.lookAtTransform(C.Matrix4.IDENTITY);
    this.hooks.onUserCamera();
  }

  isOrtho() { return this.viewer.camera.frustum instanceof this.C.OrthographicFrustum; }
  toggleOrtho() {
    const camera = this.viewer.camera;
    if (this.isOrtho()) camera.switchToPerspectiveFrustum(); else camera.switchToOrthographicFrustum();
    this.hooks.onUserCamera();
    return this.isOrtho();
  }

  /** Fit a set of world points into view (CAD zoom extents / Blender frame selected). */
  frame(points: any[], duration = 0.45) {
    const C = this.C, camera = this.viewer.camera;
    if (!points.length) return false;
    const sphere = C.BoundingSphere.fromPoints(points);
    sphere.radius = Math.max(sphere.radius, 8);
    camera.lookAtTransform(C.Matrix4.IDENTITY);
    const pitch = Math.min(C.Math.toRadians(-20), camera.pitch);
    camera.flyToBoundingSphere(sphere, { duration, offset: new C.HeadingPitchRange(camera.heading, pitch, 0) });
    this.hooks.onUserCamera();
    return true;
  }
}
