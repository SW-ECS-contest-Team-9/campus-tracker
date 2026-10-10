// Cross-section tool (단면도) of the Cesium preview map: cuts the scene with the vertical plane of section.ts,
// hides one half and draws the cut face. Turning it off restores everything.
// What is cut how:
//  - ground: Cesium clips the rendered terrain at the plane (exact). Everything laid on the ground (road and area
//    fills, ground-clamped lines) is only drawn where ground is, so it is cut with it.
//  - buildings, underground ways, level area surfaces: their shapes are cut at the plane and redrawn (exact; setSection of each layer).
//  - tracks, markers and other map objects (entities, point collections): cut once when the plane is set — lines above
//    the ground are cut at the plane, points and labels on the hidden side are hidden. Objects that appear or move
//    afterwards are not cut until the plane is set again (approximate). The review layers of scene-local-corrections.ts are not cut.
// The cut face: the ground profile along the line down to a base level, a height scale, the outline of each cut
// building with its base and roof height, and a mark where a road or a level area meets the plane.
import type { CarriagewayRoad, MobilityOpenArea, SceneBuilding } from './api';
import { AREA_FILLS } from './mobility-map';
import { ROAD_SURFACE, isUnderground, roadWidthM, surfaceKind } from './road-surface';
import {
  clipPolyline, clipRing, extendToBox, heightTicks, lineCrossings, meshCrossings, planeAlong, planePoint, planeSide, profileHeight, ringIntervals, sectionPlane, terrainProfile,
  type Mesh, type SectionPlane, type XY,
} from './section';
import { tmForward, tmInverse } from './tm';
import type { Viewer } from './vworld';

/** Display constants of the cut face. */
export const SECTION = {
  /** Cut ground: a soil tone, darker than the ivory ground so the profile reads. */
  faceColor: '#bda98a',
  lineColor: '#3b352d',
  /** Indoor ways (not drawn as surfaces on the map) marked on the cut face: their height tells the floor level. */
  indoorColor: '#6d4bc4',
  areaColor: '#64748b',
  profileStepM: 1,
  /** The face reaches this far below the lowest thing on it, rounded down to 5 m. */
  baseMarginM: 5,
  /** Lines and marks sit this far in front of the plane, the face this far behind it, so nothing flickers. */
  offsetM: 0.05,
};

type Cuttable = { setSection(plane: SectionPlane | null): void };
export type SectionSources = {
  /** Ground height at an EPSG:5186 point. */
  height: (x: number, y: number) => number;
  /** Extent of the terrain grid (EPSG:5186): the cut face spans the whole of it. */
  box: { minX: number; minY: number; maxX: number; maxY: number };
  buildings: () => SceneBuilding[];
  roads: () => CarriagewayRoad[];
  areas: () => MobilityOpenArea[];
  /** The merged ground surfaces as drawn (road-surface-layer.ts): x, y, height, edge per vertex. */
  surfaces: () => { color: string; mesh: Mesh }[];
  /** The layers that cut their own shapes. */
  layers: () => (Cuttable | null)[];
};

export class SectionTool {
  /** True while waiting for the two clicks: other click handling should stand back. */
  placing = false;
  private plane: SectionPlane | null = null;
  /** The picked points A, B as distances along the (extended) plane line, and the height range of the face. */
  private frame = { from: 0, to: 0, base: 0, top: 0 };
  private picked: { a: XY; b: XY; flip: boolean } | null = null;
  private drawn: any[] = [];
  private undo: (() => void)[] = [];
  private handler: any = null;
  private marker: any = null;

  constructor(private readonly viewer: Viewer, private readonly src: SectionSources, private readonly onStatus: (text: string) => void) {}

  get active() { return this.plane !== null; }

  /** Wait for two clicks on the map: the section line A → B. */
  start() {
    const C = (window as any).Cesium;
    this.stop();
    this.placing = true;
    this.onStatus('지도에서 자를 선의 첫 점을 찍으세요');
    let first: XY | null = null;
    this.handler = new C.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.handler.setInputAction((movement: { position: unknown }) => {
      const hit = this.viewer.scene.globe.pick(this.viewer.camera.getPickRay(movement.position), this.viewer.scene);
      if (!hit) return;
      const p = this.xy(hit);
      if (!first) {
        first = p;
        this.marker = this.viewer.entities.add({ position: hit, point: { pixelSize: 9, color: C.Color.fromCssColorString('#dc2626'), outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
        this.onStatus('둘째 점을 찍으세요');
      } else if (Math.hypot(p[0] - first[0], p[1] - first[1]) > 1) {
        this.setLine(first, p);
      }
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  }

  /** Cut along A → B (EPSG:5186). The half the camera is in is hidden. */
  setLine(a: XY, b: XY) {
    this.endPlacing();
    const camera = this.xy(this.viewer.camera.positionWC);
    this.picked = { a, b, flip: planeSide(sectionPlane(a, b), camera) > 0 };
    this.apply();
  }

  /** Hide the other half instead. */
  flip() {
    if (!this.picked) return;
    this.picked.flip = !this.picked.flip;
    this.apply();
  }

  /** Turn the tool off and restore the scene (and the perspective view). */
  stop() {
    this.endPlacing();
    this.clear();
    this.picked = null;
    this.viewer.camera.switchToPerspectiveFrustum();
    this.onStatus('');
  }

  /**
   * Camera square to the cut, on the hidden side, far enough to see the picked stretch A–B from the base of the face to
   * the highest roof on it. Orthographic (no perspective), so heights can be compared across the cut.
   */
  lookAt() {
    if (!this.plane) return;
    const C = (window as any).Cesium;
    const { from, to, base, top } = this.frame;
    const length = Math.abs(to - from);
    const camera = this.viewer.camera;
    const [x, y] = planePoint(this.plane, (from + to) / 2, -Math.max(300, length * 1.5));
    camera.switchToOrthographicFrustum();
    camera.setView({ destination: this.position(x, y, (base + top) / 2), orientation: { heading: Math.atan2(this.plane.n[0], this.plane.n[1]), pitch: 0, roll: 0 } });
    // after setView: it resets the width from the camera height
    const aspect = this.viewer.scene.drawingBufferWidth / this.viewer.scene.drawingBufferHeight;
    camera.frustum.aspectRatio = aspect;
    camera.frustum.width = Math.max(length, (top - base) * aspect) * 1.15;
  }

  private xy(cartesian: unknown): XY {
    const C = (window as any).Cesium;
    const g = C.Cartographic.fromCartesian(cartesian);
    const p = tmForward(C.Math.toDegrees(g.latitude), C.Math.toDegrees(g.longitude));
    return [p.x, p.y];
  }

  private position(x: number, y: number, z: number) {
    const { latitude, longitude } = tmInverse(x, y);
    return (window as any).Cesium.Cartesian3.fromDegrees(longitude, latitude, z);
  }

  private endPlacing() {
    this.placing = false;
    this.handler?.destroy();
    this.handler = null;
    if (this.marker) this.viewer.entities.remove(this.marker);
    this.marker = null;
  }

  private clear() {
    if (!this.plane) return;
    this.plane = null;
    this.viewer.scene.globe.clippingPlanes = undefined;
    for (const layer of this.src.layers()) layer?.setSection(null);
    for (const restore of this.undo.reverse()) restore();
    this.undo = [];
    for (const p of this.drawn) this.viewer.scene.primitives.remove(p);
    this.drawn = [];
  }

  private apply() {
    const C = (window as any).Cesium;
    this.clear();
    const { a, b, flip } = this.picked!;
    const whole = extendToBox(a, b, this.src.box) ?? { a, b };
    const plane = sectionPlane(whole.a, whole.b, flip);
    this.plane = plane;
    this.frame.from = planeAlong(plane, a);
    this.frame.to = planeAlong(plane, b);
    // the plane in a local east-north-up frame at the middle of A–B (the map grid and true north differ by < 0.01° here)
    const mid = planePoint(plane, (this.frame.from + this.frame.to) / 2);
    this.viewer.scene.globe.clippingPlanes = new C.ClippingPlaneCollection({
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(this.position(mid[0], mid[1], 0)),
      planes: [new C.ClippingPlane(new C.Cartesian3(plane.n[0], plane.n[1], 0), 0)],
      edgeWidth: 0,
    });
    for (const layer of this.src.layers()) layer?.setSection(plane);
    this.cutMapObjects(plane);
    this.drawFace(plane);
    this.onStatus(`단면 ${Math.abs(this.frame.to - this.frame.from).toFixed(0)} m`);
  }

  /** Entities and point collections that are in the scene now (tracks, markers, hand-drawn spaces above the ground). */
  private cutMapObjects(plane: SectionPlane) {
    const C = (window as any).Cesium;
    const now = this.viewer.clock.currentTime;
    const hide = (o: { show: boolean }) => {
      if (!o.show) return;
      o.show = false;
      this.undo.push(() => { o.show = true; });
    };
    for (const e of [...this.viewer.entities.values]) {
      if (!e.show) continue;
      if (e.polyline) {
        const positions: any[] | undefined = e.polyline.positions?.getValue(now);
        if (!positions?.length || e.polyline.clampToGround?.getValue(now)) continue; // on the ground: cut with the ground
        const pieces = clipPolyline(plane, positions.map((c) => [...this.xy(c), c.x, c.y, c.z]));
        if (pieces.length === 1 && pieces[0].length === positions.length) continue;
        hide(e);
        for (const piece of pieces) {
          const part = this.viewer.entities.add({ polyline: { positions: piece.map((p) => new C.Cartesian3(p[2], p[3], p[4])), width: e.polyline.width, material: e.polyline.material, depthFailMaterial: e.polyline.depthFailMaterial, arcType: e.polyline.arcType } });
          this.undo.push(() => this.viewer.entities.remove(part));
        }
      } else if (e.polygon && e.polygon.height?.getValue(now) != null) {
        const hierarchy = e.polygon.hierarchy.getValue(now);
        const kept = clipRing(plane, hierarchy.positions.map((c: any) => [...this.xy(c), c.x, c.y, c.z]));
        if (kept.length === hierarchy.positions.length) continue;
        if (!kept.length) { hide(e); continue; }
        const original = e.polygon.hierarchy;
        e.polygon.hierarchy = new C.PolygonHierarchy(kept.map((p) => new C.Cartesian3(p[2], p[3], p[4])));
        this.undo.push(() => { e.polygon.hierarchy = original; });
      } else if (e.position && !e.polygon && !e.corridor) {
        const p = e.position.getValue(now);
        if (p && planeSide(plane, this.xy(p)) < 0) hide(e);
      }
    }
    const primitives = this.viewer.scene.primitives;
    for (let i = 0; i < primitives.length; i++) {
      const collection = primitives.get(i);
      if (!(collection instanceof C.PointPrimitiveCollection)) continue;
      for (let k = 0; k < collection.length; k++) {
        const point = collection.get(k);
        if (planeSide(plane, this.xy(point.position)) < 0) hide(point);
      }
    }
  }

  private drawFace(plane: SectionPlane) {
    const C = (window as any).Cesium;
    const at = (d: number, z: number, off: number) => { const [x, y] = planePoint(plane, d, off); return this.position(x, y, z); };
    const front = (d: number, z: number) => at(d, z, -SECTION.offsetM);
    const metres = (ring: number[][]) => ring.slice(0, -1).map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; });
    const profile = terrainProfile(this.src.height, plane, SECTION.profileStepM);

    // what meets the plane
    const buildings = this.src.buildings().flatMap((b) => b.geometry.coordinates.flatMap((poly) => ringIntervals(plane, metres(poly[0])).map(([from, to]) => ({ b, from, to }))));
    const roads = this.src.roads().flatMap((road) => lineCrossings(plane, road.geometry.coordinates).map((hit) => {
      const kind = surfaceKind(road);
      const onGround = kind !== null && !isUnderground(road);
      return { road, kind, onGround, d: hit.d, z: onGround ? profileHeight(profile, hit.d) : hit.z ?? profileHeight(profile, hit.d), half: roadWidthM(road) / 2 };
    })).filter((r) => !r.onGround); // roads on the ground are part of the merged surfaces below
    const surfaces = this.src.surfaces().map((s) => ({ color: s.color, cuts: meshCrossings(plane, s.mesh, 4) }));
    const areas = this.src.areas().filter((a) => a.elevationM != null).flatMap((a) => ringIntervals(plane, metres(a.geometry.coordinates[0])).map(([from, to]) => ({ a, from, to })));

    // heights on the face: along the whole line for the face itself, between A and B for the camera
    const lo = Math.min(this.frame.from, this.frame.to), hi = Math.max(this.frame.from, this.frame.to);
    const heights = (all: boolean) => {
      const near = (from: number, to = from) => all || (to >= lo && from <= hi);
      return [
        ...profile.filter((s) => near(s.d)).map((s) => s.z), ...buildings.filter((x) => near(x.from, x.to)).flatMap((x) => [x.b.baseM, x.b.roofM]),
        ...roads.filter((r) => near(r.d)).map((r) => r.z), ...surfaces.flatMap((s) => s.cuts.filter((c) => near(c[0][0])).map((c) => c[0][1])), ...areas.filter((x) => near(x.from, x.to)).map((x) => x.a.elevationM!),
      ];
    };
    const floor5 = (zs: number[]) => Math.floor((Math.min(...zs) - SECTION.baseMarginM) / 5) * 5;
    const base = floor5(heights(true));
    const top = Math.max(...heights(true));
    this.frame.base = floor5(heights(false));
    this.frame.top = Math.max(...heights(false));

    // the cut ground: from the profile down to the base level, just behind the plane
    const values = new Float64Array(profile.length * 6);
    const indices: number[] = [];
    profile.forEach((s, i) => {
      const up = at(s.d, s.z, SECTION.offsetM), down = at(s.d, base, SECTION.offsetM);
      values.set([up.x, up.y, up.z, down.x, down.y, down.z], i * 6);
      if (i > 0) indices.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    });
    this.drawn.push(this.viewer.scene.primitives.add(new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.Geometry({
          attributes: { position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }) } as any,
          indices: new Uint32Array(indices),
          primitiveType: C.PrimitiveType.TRIANGLES,
          boundingSphere: C.BoundingSphere.fromVertices(values as unknown as number[]),
        }),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(SECTION.faceColor)) },
      }),
      appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false, closed: false }),
      asynchronous: false,
    })));

    const lines = new C.PolylineCollection();
    const labels = new C.LabelCollection();
    const line = (positions: unknown[], css: string, width: number, alpha = 1) => lines.add({ positions, width, material: C.Material.fromType('Color', { color: C.Color.fromCssColorString(css).withAlpha(alpha) }) });
    const label = (d: number, z: number, text: string, css = SECTION.lineColor, right = false) => labels.add({
      position: front(d, z), text, font: '12px system-ui, "Apple SD Gothic Neo", sans-serif', fillColor: C.Color.fromCssColorString(css), outlineColor: C.Color.WHITE, outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: right ? C.HorizontalOrigin.RIGHT : C.HorizontalOrigin.LEFT, verticalOrigin: C.VerticalOrigin.BOTTOM,
      pixelOffset: new C.Cartesian2(right ? -4 : 4, -2), disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    // seen from the hidden side A → B runs left to right when the kept side is on its left (not flipped)
    const leftEnd = this.picked!.flip ? Math.max(this.frame.from, this.frame.to) : Math.min(this.frame.from, this.frame.to);
    const rightEnd = this.frame.from + this.frame.to - leftEnd;
    for (const z of heightTicks(base, top)) {
      line([front(0, z), front(plane.length, z)], SECTION.lineColor, 1, 0.3);
      label(leftEnd, z, `${z} m`);
      label(rightEnd, z, `${z} m`, SECTION.lineColor, true);
    }
    line(profile.map((s) => front(s.d, s.z)), SECTION.lineColor, 2);
    for (const { b, from, to } of buildings) {
      line([front(from, b.baseM), front(from, b.roofM), front(to, b.roofM), front(to, b.baseM), front(from, b.baseM)], SECTION.lineColor, 2);
      label((from + to) / 2, b.roofM, `${b.name ?? ''} ${b.baseM.toFixed(1)}–${b.roofM.toFixed(1)} m`.trim());
    }
    // the merged ground surfaces where the plane cuts them, at the height they are drawn at
    for (const s of surfaces) for (const [p, q] of s.cuts) line([front(p[0], p[1] + 0.05), front(q[0], q[1] + 0.05)], s.color, 6);
    for (const { a, from, to } of areas) {
      const css = AREA_FILLS.find((f) => f.match(a))?.color ?? SECTION.areaColor;
      if (!AREA_FILLS.some((f) => f.match(a))) line([front(from, a.elevationM!), front(to, a.elevationM!)], css, 4);
      label((from + to) / 2, a.elevationM!, `${a.name ?? '영역'} ${a.elevationM!.toFixed(1)} m`);
    }
    const labelled = new Set<string>();
    for (const r of roads) {
      const css = r.kind ? ROAD_SURFACE.colors[r.kind] : SECTION.indoorColor;
      line([front(r.d - r.half, r.z), front(r.d + r.half, r.z)], css, 6);
      const key = `${Math.round(r.d / 5)}:${r.z.toFixed(1)}`;
      if (labelled.has(key)) continue;
      labelled.add(key);
      label(r.d + r.half, r.z, `${r.z.toFixed(1)} m${r.kind && r.road.name ? ` ${r.road.name.split(' (')[0]}` : ''}`);
    }
    this.drawn.push(this.viewer.scene.primitives.add(lines), this.viewer.scene.primitives.add(labels));
  }
}
