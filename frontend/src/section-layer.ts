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
// F09 (readability, all from view-style.ts so the choices are the same as in 층 따로 보기):
//  - everything the plane cuts has a firm outline (slabs, voids, platforms, building walls) in the chosen line weight,
//    a cut building is a light face with a line and a tag ("3층") per floor of its note's floor table (scene API);
//  - roads and passages are thick cross-marks with a light casing, in the colours of the lifted view;
//  - what stands behind the cut is dimmed by a veil just behind the face (나머지: 흐리게 / 숨김);
//  - the tags are laid out on screen by section-overlay.ts: one per height in a column at the right edge with a
//    leader line, names and floors where they are, none covering another; a legend and the options in a panel.
import type { CarriagewayRoad, SceneBuilding } from './api';
import { floorOfRoad, floorText, shortName, tableFloorName } from './level-view';
import { SectionOverlay, type FaceTag, type LegendEntry } from './section-overlay';
import type { CutItem } from './structures-layer';
import { LABELS, SECTION_BACKDROP, SECTION_PX, VIEW_COLORS, onViewStyle, viewStyle } from './view-style';
import { AREA_FILLS } from './mobility-map';
import { ROAD_SURFACE, isUnderground, isUndergroundArea, roadWidthM, surfaceKind } from './road-surface';
import type { LayerArea } from './scene-layer-data';
import {
  clipPolyline, clipRing, extendToBox, heightTicks, lineCrossings, meshCrossings, planeAlong, planePoint, planeSide, profileHeight, ringIntervals, sectionPlane, terrainProfile,
  type Mesh, type SectionPlane, type XY,
} from './section';
import { polygonIntervals } from './structures';
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
  /** Z08: the plain wall lookAt() may stand behind the cut, so that far buildings (as large as near ones without perspective) do not crowd the cut face. */
  backdropColor: '#f4f2ec',
  /** F09: the veil that dims what stands behind the cut sits this far behind the plane (behind the cut ground and the cut faces of the structures). */
  veilOffsetM: 0.12,
  /** F09: the light face of a cut building, just in front of the plane: the scene layer closes a cut building with a wall in the plane (bricks, windows, glass), which this face fades so that the floor lines read; a hint of the wall colour stays. */
  buildingFace: '#fffdf7', buildingFaceOffsetM: -0.02, buildingFaceAlpha: 0.86,
  /** F09: a box (stair step, wall, planter ...) narrower than this on the cut gets no outline of its own. */
  outlineMinM: 0.4,
};

export type Cuttable = { setSection(plane: SectionPlane | null): void };
export type SectionSources = {
  /** Ground height at an EPSG:5186 point. */
  height: (x: number, y: number) => number;
  /** Extent of the terrain grid (EPSG:5186): the cut face spans the whole of it. */
  box: { minX: number; minY: number; maxX: number; maxY: number };
  buildings: () => SceneBuilding[];
  roads: () => CarriagewayRoad[];
  areas: () => LayerArea[];
  /** The merged ground surfaces as drawn (road-surface-layer.ts): x, y, height, edge per vertex. */
  surfaces: () => { color: string; mesh: Mesh }[];
  /** The layers that cut their own shapes. */
  layers: () => (Cuttable | null)[];
  /** F09: what the plane cuts of the structures (structures-layer.ts cutItems): outlined and named on the face. */
  cutItems?: (plane: SectionPlane) => CutItem[];
  /** F09: called after a cut was set, changed or removed (a page hides its own name tags and edit lines meanwhile). */
  onChange?: () => void;
  /** F09: a page whose own lines would bury the face (the editor) names the switch that shows them again; they are hidden while a cut is on unless it is checked. */
  overlayToggleLabel?: string;
  /**
   * Which map objects (entities) are cut; default: all. A page that draws its entities again and again (the editor)
   * names the ones it redraws and calls uncutObjects() before and cutObjects() after each redraw.
   */
  objects?: (entity: any) => boolean;
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
  /** The perspective frustum of the view before lookAt() switched to the orthographic one. */
  private perspective: any = null;
  /** Distance behind the cut of the plain backdrop wall, or null (lookAt sets it). */
  private backdropM: number | null = null;
  /** F09: the page's own lines and markers stay visible although a cut is on (the panel's switch; default: hidden). */
  showOverlays = false;
  private readonly overlay: SectionOverlay;

  constructor(private readonly viewer: Viewer, private readonly src: SectionSources, private readonly onStatus: (text: string) => void) {
    this.overlay = new SectionOverlay(viewer, { overlayToggleLabel: src.overlayToggleLabel, onOverlayToggle: (show) => { this.showOverlays = show; this.src.onChange?.(); } });
    onViewStyle(() => this.refresh());
  }

  /** The tags as laid out on screen (scripted checks). */
  get tags() { return this.overlay.placed; }

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

  /** Cut again with the same line (the data on the cut face changed). */
  refresh() {
    if (this.plane && this.picked) this.apply();
  }

  /** Take back the cuts of the map objects (the layers and the ground stay cut). */
  uncutObjects() {
    for (const restore of this.undo.reverse()) restore();
    this.undo = [];
  }

  /** Cut the map objects that are in the scene now. */
  cutObjects() {
    if (!this.plane) return;
    this.uncutObjects();
    this.cutMapObjects(this.plane);
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
    // back to the frustum the view had (switchToPerspectiveFrustum would make a default one: near 1 m instead of 0.1 m)
    if (this.perspective) this.viewer.camera.frustum = this.perspective;
    this.perspective = null;
    this.backdropM = null;
    this.onStatus('');
    this.src.onChange?.();
  }

  /**
   * Camera square to the cut, on the hidden side, far enough to see the picked stretch A–B from the base of the face to
   * the highest roof on it. Orthographic (no perspective), so heights can be compared across the cut.
   * Z08 `frame`: instead look at the heights `lowM`..`highM` only (the stretch A–B still fits), and with `backdropM`
   * stand a plain wall that far behind the cut: what lies further back is not seen (a far tower no longer fills the
   * view of a narrow gap).
   */
  lookAt(frame: { lowM?: number; highM?: number; backdropM?: number | null } = {}) {
    if (!this.plane) return;
    const C = (window as any).Cesium;
    if (frame.backdropM !== undefined && frame.backdropM !== this.backdropM) {
      this.backdropM = frame.backdropM;
      this.apply();
    }
    const { from, to } = this.frame;
    const base = frame.lowM ?? this.frame.base, top = frame.highM ?? this.frame.top;
    const length = Math.abs(to - from);
    const camera = this.viewer.camera;
    const [x, y] = planePoint(this.plane, (from + to) / 2, -Math.max(300, length * 1.5));
    if (!this.perspective) this.perspective = camera.frustum.clone();
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
    this.uncutObjects();
    for (const p of this.drawn) this.viewer.scene.primitives.remove(p);
    this.drawn = [];
    this.overlay.hide();
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
    this.src.onChange?.();
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
      if (!e.show || (this.src.objects && !this.src.objects(e))) continue;
      if (e.polyline) {
        const positions: any[] | undefined = e.polyline.positions?.getValue(now);
        if (!positions?.length || e.polyline.clampToGround?.getValue(now)) continue; // on the ground: cut with the ground
        const pieces = clipPolyline(plane, positions.map((c) => [...this.xy(c), c.x, c.y, c.z]));
        if (pieces.length === 1 && pieces[0].length === positions.length) continue;
        hide(e);
        for (const piece of pieces) {
          const part = this.viewer.entities.add({ polyline: { positions: piece.map((p) => new C.Cartesian3(p[2], p[3], p[4])), width: e.polyline.width, material: e.polyline.material, depthFailMaterial: e.polyline.depthFailMaterial, arcType: e.polyline.arcType } });
          part.cutFrom = e.id; // a click on the piece is a click on the line it was cut from
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
    // an underground area (U04: car park aisles) is cut with its holes: the stall blocks are gaps in its line
    const areas = this.src.areas().filter((a) => a.elevationM != null).flatMap((a) => {
      const below = isUndergroundArea(a);
      return (below ? polygonIntervals(plane, a.geometry.coordinates.map(metres)) : ringIntervals(plane, metres(a.geometry.coordinates[0]))).map(([from, to], k) => ({ a, from, to, below, first: k === 0 }));
    });

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

    if (this.backdropM !== null) {
      const d0 = Math.min(this.frame.from, this.frame.to) - 200, d1 = Math.max(this.frame.from, this.frame.to) + 200;
      const corners = [at(d0, base, this.backdropM), at(d1, base, this.backdropM), at(d1, top + 200, this.backdropM), at(d0, top + 200, this.backdropM)];
      const wall = new Float64Array(corners.flatMap((c) => [c.x, c.y, c.z]));
      this.drawn.push(this.viewer.scene.primitives.add(new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.Geometry({
            attributes: { position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: wall }) } as any,
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]), primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: C.BoundingSphere.fromVertices(wall as unknown as number[]),
          }),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(SECTION.backdropColor)) },
        }),
        appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false, closed: false }), asynchronous: false, allowPicking: false,
      })));
    }

    // ---- F09: what is drawn on the face, in the chosen line weight ----
    const style = viewStyle(), px = SECTION_PX[style.line], show = LABELS[style.labels];
    const quad = (corners: unknown[], css: string, alpha: number) => {
      const values = new Float64Array((corners as { x: number; y: number; z: number }[]).flatMap((c) => [c.x, c.y, c.z]));
      this.drawn.push(this.viewer.scene.primitives.add(new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.Geometry({
            attributes: { position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }) } as any,
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]), primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: C.BoundingSphere.fromVertices(values as unknown as number[]),
          }),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(css).withAlpha(alpha)) },
        }),
        appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: alpha < 1, closed: false }), asynchronous: false, allowPicking: false,
      })));
    };
    // what stands behind the cut is dimmed (or hidden): a veil just behind the face. The face itself stays at full contrast.
    const backdrop = SECTION_BACKDROP[style.others];
    quad([at(0, base, SECTION.veilOffsetM), at(plane.length, base, SECTION.veilOffsetM), at(plane.length, top + 300, SECTION.veilOffsetM), at(0, top + 300, SECTION.veilOffsetM)], VIEW_COLORS.backdrop, 1 - backdrop);
    // a cut building: a light face, so its floors read
    for (const { b, from, to } of buildings) quad([at(from, b.baseM, SECTION.buildingFaceOffsetM), at(to, b.baseM, SECTION.buildingFaceOffsetM), at(to, b.roofM, SECTION.buildingFaceOffsetM), at(from, b.roofM, SECTION.buildingFaceOffsetM)], SECTION.buildingFace, SECTION.buildingFaceAlpha);

    const lines = new C.PolylineCollection();
    const tags: FaceTag[] = [];
    const line = (positions: unknown[], css: string, width: number, alpha = 1) => lines.add({ positions, width, material: C.Material.fromType('Color', { color: C.Color.fromCssColorString(css).withAlpha(alpha) }) });
    /** A cross-mark with a light casing, so it reads on a dark slab and on a light void alike. */
    const mark = (d0: number, z0: number, d1: number, z1: number, css: string, width = px.mark) => {
      line([front(d0, z0), front(d1, z1)], '#ffffff', width + 3, 0.95);
      line([front(d0, z0), front(d1, z1)], css, width);
    };
    const inFrame = (from: number, to = from) => to >= lo - 2 && from <= hi + 2;
    const clampD = (d: number) => Math.min(hi, Math.max(lo, d));
    // seen from the hidden side A → B runs left to right when the kept side is on its left (not flipped)
    const leftEnd = this.picked!.flip ? Math.max(this.frame.from, this.frame.to) : Math.min(this.frame.from, this.frame.to);
    for (const z of heightTicks(base, top)) {
      line([front(0, z), front(plane.length, z)], SECTION.lineColor, px.grid, 0.22);
      tags.push({ kind: 'tick', world: front(leftEnd, z), text: `${z} m` });
    }
    line(profile.map((s) => front(s.d, s.z)), SECTION.lineColor, px.cut);

    // the structures the plane cuts: firm outlines (voids and platforms in the cut weight, small boxes thin)
    const cutItems = this.src.cutItems?.(plane) ?? [];
    // an underground space made of many pieces of one name (a sloping passage: a piece per step of its floor) is one
    // thing on the face: named once, with the heights of its two ends, not a tag per piece
    const spaces = new Map<string, { from: number; to: number; pieces: typeof cutItems }>();
    for (const item of cutItems) {
      if (item.solid.role !== 'void' || !item.name || !inFrame(item.from, item.to)) continue;
      const g = spaces.get(item.name) ?? { from: Infinity, to: -Infinity, pieces: [] };
      g.from = Math.min(g.from, item.from); g.to = Math.max(g.to, item.to); g.pieces.push(item);
      spaces.set(item.name, g);
    }
    for (const [name, g] of spaces) {
      const floors = new Set(g.pieces.map((p) => p.bottomM.toFixed(1)));
      const low = g.pieces.reduce((a, b) => (b.bottomM < a.bottomM ? b : a)), high = g.pieces.reduce((a, b) => (b.bottomM > a.bottomM ? b : a));
      const widest = g.pieces.reduce((a, b) => (Math.min(hi, b.to) - Math.max(lo, b.from) > Math.min(hi, a.to) - Math.max(lo, a.from) ? b : a));
      const mid = (clampD(widest.from) + clampD(widest.to)) / 2;
      if (floors.size <= 2) {
        if (g.to - g.from > 3) tags.push({ kind: 'title', world: front(mid, (widest.bottomM + widest.topM) / 2 - 0.4), text: name, sub: `${widest.bottomM.toFixed(1)}–${widest.topM.toFixed(1)} m`, priority: 7 });
        for (const piece of floors.size === 1 ? [widest] : [low, high]) {
          tags.push({ kind: 'level', world: front(clampD(piece.to), piece.bottomM), z: piece.bottomM, d: piece.to, name: `${name} 바닥`, priority: 5, rank: 'major' });
          tags.push({ kind: 'level', world: front(clampD(piece.to), piece.topM), z: piece.topM, d: piece.to, name: `${name} 천장`, priority: 3, rank: 'major' });
        }
      } else {
        const at = g.pieces.reduce((a, b) => (Math.abs((b.from + b.to) / 2 - (g.from + g.to) / 2) < Math.abs((a.from + a.to) / 2 - (g.from + g.to) / 2) ? b : a));
        tags.push({ kind: 'title', world: front((clampD(at.from) + clampD(at.to)) / 2, at.topM + 0.3), text: name, sub: `바닥 ${low.bottomM.toFixed(1)}–${high.bottomM.toFixed(1)} m`, priority: 7 });
        tags.push({ kind: 'level', world: front((clampD(low.from) + clampD(low.to)) / 2, low.bottomM), z: low.bottomM, d: low.to, name: `${name} 바닥(낮은 끝)`, priority: 5, rank: 'major' });
        tags.push({ kind: 'level', world: front((clampD(high.from) + clampD(high.to)) / 2, high.bottomM), z: high.bottomM, d: high.to, name: `${name} 바닥(높은 끝)`, priority: 5, rank: 'major' });
      }
    }
    for (const item of cutItems) {
      const role = item.solid.role, wide = item.to - item.from >= SECTION.outlineMinM;
      if (role !== 'box' || wide) {
        const width = role === 'box' ? Math.max(1, px.cut - 1.5) : px.cut;
        for (const polygon of item.polygons) for (const ring of polygon) line([...ring, ring[0]].map(([d, z]) => front(d, z)), role === 'void' ? VIEW_COLORS.outline : SECTION.lineColor, width, role === 'box' ? 0.8 : 1);
      }
      if (!inFrame(item.from, item.to)) continue;
      const mid = (clampD(item.from) + clampD(item.to)) / 2;
      if (role === 'void') continue; // named above, as one space
      if (item.name && item.to - item.from >= 0.3) {
        tags.push({ kind: 'level', world: front(mid, item.topM), z: item.topM, d: mid, name: item.name, priority: role === 'platform' ? 2 : 4, rank: 'minor' });
      }
    }

    // buildings: the cut outline, a line and a tag per floor of the note's floor table, the name above the roof
    const floorTagged = new Set<string>();
    // from the left of the view on, so that a building cut twice (a ring, two wings) has its floor tags on its first stretch
    for (const { b, from, to } of [...buildings].sort((p, q) => (this.picked!.flip ? q.to - p.to : p.from - q.from))) {
      line([front(from, b.baseM), front(from, b.roofM), front(to, b.roofM), front(to, b.baseM), front(from, b.baseM)], SECTION.lineColor, px.cut + 0.5);
      if (!inFrame(from, to)) continue;
      const w = b.appearance?.windows, floors = w?.floorsM ?? [], names = w?.floorNames?.length === floors.length ? w!.floorNames! : null;
      const leftD = this.picked!.flip ? clampD(to) : clampD(from);
      floors.forEach((m, i) => {
        if (m <= b.baseM - 2.5 || m >= b.roofM - 0.5) return;
        line([front(from, m), front(to, m)], VIEW_COLORS.floorLine, px.floor, 0.9);
        const name = names ? tableFloorName(names[i]) : '';
        const key = `${b.buildingId.split('#')[0]}:${m}`;
        if (!show.floor || floorTagged.has(key)) return;
        floorTagged.add(key);
        tags.push({ kind: 'floor', world: front(leftD, m), text: name ? (show.road ? `${name} ${m.toFixed(1)}` : name) : `${m.toFixed(1)} m`, priority: 3 });
      });
      const name = b.name ?? '';
      if (name) tags.push({ kind: 'title', world: front((clampD(from) + clampD(to)) / 2, b.roofM), text: name, sub: `${b.baseM.toFixed(1)}–${b.roofM.toFixed(1)} m`, priority: 8 + Math.min(1, (to - from) / 200), low: front((clampD(from) + clampD(to)) / 2, Math.max(b.baseM, b.terrainMinM ?? b.baseM)) });
    }

    // the merged ground surfaces where the plane cuts them, at the height they are drawn at
    for (const s of surfaces) for (const [p, q] of s.cuts) line([front(p[0], p[1] + 0.05), front(q[0], q[1] + 0.05)], s.color, Math.max(3, px.mark - 2));
    for (const { a, from, to, below } of areas) {
      const css = AREA_FILLS.find((f) => f.match(a))?.color ?? SECTION.areaColor;
      if (below) mark(from, a.elevationM! + 0.05, to, a.elevationM! + 0.05, VIEW_COLORS.aisle);
      else if (!AREA_FILLS.some((f) => f.match(a))) line([front(from, a.elevationM!), front(to, a.elevationM!)], css, Math.max(3, px.mark - 3));
      if (inFrame(from, to)) tags.push({ kind: 'level', world: front(clampD(to), a.elevationM!), z: a.elevationM!, d: to, name: shortName(a.name ?? '영역', 18), priority: 6, rank: 'major' });
    }
    // roads and passages that are not ground surfaces (underground, indoor): thick cross-marks in the colours of the lifted view
    const crossings = new Map<string, number[]>();
    for (const r of roads) if (inFrame(r.d)) crossings.set(r.road.id, [...(crossings.get(r.road.id) ?? []), r.z]);
    for (const r of roads) {
      const road = r.road, walk = road.roadClass === 'pedestrian';
      const css = !r.kind ? VIEW_COLORS.indoor : road.structure === 'stairs' ? VIEW_COLORS.stairs : walk ? VIEW_COLORS.pedestrian : VIEW_COLORS.vehicle;
      mark(r.d - r.half, r.z, r.d + r.half, r.z, css);
      if (!inFrame(r.d)) continue;
      // a way that runs along the cut meets it at every bend: only its lowest and highest crossing are named
      const zs = crossings.get(road.id)!;
      if (zs.length > 2 && r.z !== Math.min(...zs) && r.z !== Math.max(...zs)) continue;
      const floor = road.buildingId ? floorOfRoad(road) : null;
      const name = shortName(road.name, 18) || (floor !== null ? floorText(floor) : '');
      tags.push({ kind: 'level', world: front(r.d + r.half, r.z), z: r.z, d: r.d, name, priority: walk ? 4 : 3, rank: 'way' });
    }
    this.drawn.push(this.viewer.scene.primitives.add(lines));

    const legend: LegendEntry[] = [
      { color: SECTION.faceColor, label: '자른 땅', shape: 'fill' }, { color: '#9a968e', label: '자른 구조물(기단·슬래브)', shape: 'fill' }, { color: VIEW_COLORS.outline, label: '빈 곳(지하 공간)', shape: 'box' },
      { color: SECTION.lineColor, label: '건물 윤곽', shape: 'box' }, { color: VIEW_COLORS.floorLine, label: '층 바닥(노트 층 표)' },
      { color: VIEW_COLORS.vehicle, label: '차도', shape: 'thick' }, { color: VIEW_COLORS.pedestrian, label: '보행 길', shape: 'thick' }, { color: VIEW_COLORS.stairs, label: '계단', shape: 'thick' },
      { color: VIEW_COLORS.indoor, label: '실내 길', shape: 'thick' }, { color: VIEW_COLORS.aisle, label: '주차장 통로 면', shape: 'thick' }, { color: VIEW_COLORS.leader, label: '높이 지시선', shape: 'dash' },
    ];
    this.overlay.show(tags, legend, `단면도 · ${Math.abs(this.frame.to - this.frame.from).toFixed(0)} m`, this.showOverlays);
  }
}
