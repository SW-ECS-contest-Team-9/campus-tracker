// "층 따로 보기" (F08) on a Cesium viewer, for the preview (main.ts) and the editor (editor-main.ts) alike.
// While it is on, a click on the map lifts what was clicked out of the campus, into the air above it:
//   - a building  -> its floors as a stack pulled apart (exploded), each with its indoor roads; ↑/↓ picks one floor;
//   - anything else (a road, a square, the field) -> the 구획 (zone of zones.geojson) there: its ground plates,
//     structures, roads and areas together; underground zones (parking levels, the tunnel, passages) are chosen from
//     the list (or by clicking something of theirs that is visible).
// Lift rule: the lowest point of what is lifted is put LEVEL_VIEW.clearRoofM above the highest roof of the model, so
// nothing of the campus is in front of it. Nothing is moved in the data: these are extra drawings, removed on exit.
// How it reads (line widths, which labels, how strongly the rest is faded) comes from view-style.ts.
// The pure part is level-view.ts. first-person.ts (the walk) is started from here as well (mountSpaceViews).
import type { SceneBuilding } from './api';
import './level-view.css';
import {
  LEVEL_VIEW, baseBuildingId, buildingFloors, explode, floorIndexAt, isConnector, parseZones, shortName, zoneAt, zoneContent,
  type Floor, type LvArea, type LvPlace, type LvRoad, type Zone,
} from './level-view';
import { FirstPerson } from './first-person';
import type { Polygon } from './polygon-ops';
import { ribbon, roadWidthM, type P3 } from './road-surface';
import type { LayerArea } from './scene-layer-data';
import { SOLID_STRIDE, STRUCTURES, parseStructures, solidColors, solidMesh, type Solid } from './structures';
import { tmForward, tmInverse } from './tm';
import { LABELS, LINE_PX, OTHERS, VIEW_COLORS, VIEW_STYLE_CHOICES, VIEW_STYLE_TITLES, onViewStyle, setViewStyle, viewStyle, type ViewStyle } from './view-style';

export type SpaceViewSources = {
  /** Roads as the page has them (the editor's include elevators and unsaved edits). */
  roads: () => LvRoad[];
  /** Open areas, rings in longitude / latitude (the layers' data). */
  areas: () => LayerArea[];
  buildings: () => SceneBuilding[];
  /** Places, where the page has them (the editor). */
  places?: () => LvPlace[];
  /** The ground as drawn (structures-layer.ts groundAt). */
  groundAt: (x: number, y: number) => number;
  /** A reason not to start now (the editor: an unsaved draft), or null. */
  blocked?: () => string | null;
  /** true: every key is kept from the page while a view is on (the editor: no cursor moves, no edits). */
  lockKeys?: boolean;
  /** Called when either view starts or ends (a page disables its tools). */
  onChange?: (state: { level: boolean; walk: boolean }) => void;
  /** Checkboxes switched on while walking and put back afterwards (underground ways, see-through buildings). */
  walkInputs?: HTMLInputElement[];
  /** Called when the lifted view starts and ends (a page hides its own name tags of the campus below, which would show through). */
  onLevel?: (on: boolean) => void;
  /** Extra page work while walking (the editor fades its buildings). */
  onWalk?: (on: boolean) => void;
};

type Unit = { kind: 'zone'; zone: Zone } | { kind: 'building'; id: string; name: string; floors: Floor[]; focus: number | null };
type Tag = { label: any; world: any; priority: number };

const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const openRing = (ring: number[][]) => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);
const metres = (ring: number[][]) => openRing(ring).map(([lon, lat]) => { const p = tmForward(lat, lon); return [p.x, p.y]; });
const typing = (e: Event) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement | null)?.isContentEditable;

/** Triangles with a colour per vertex, collected for one Cesium primitive. */
class Batch {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  add(points: number[][], indices: number[], color: (i: number) => number[], alpha = 255) {
    const at = this.positions.length / 3;
    points.forEach((p, i) => { this.positions.push(p[0], p[1], p[2]); this.colors.push(...color(i), alpha); });
    for (const k of indices) this.indices.push(at + k);
  }
}

export class LevelView {
  active = false;
  unit: Unit | null = null;
  zones: Zone[] = [];
  solids: Solid[] = [];
  private readonly C: any;
  private prims: any[] = [];
  private tags: Tag[] = [];
  private saved: { destination: any; heading: number; pitch: number; roll: number } | null = null;
  private readonly panel: HTMLElement;
  private animation = 0;
  private lastDeclutter = 0;
  private message = '';

  constructor(private readonly viewer: any, private readonly src: SpaceViewSources, private readonly changed: () => void) {
    this.C = (window as any).Cesium;
    this.panel = document.createElement('div');
    this.panel.className = 'level-panel';
    this.panel.hidden = true;
    viewer.container.append(this.panel);
    this.panel.addEventListener('change', (e) => this.onPanelChange(e));
    this.panel.addEventListener('click', (e) => this.onPanelClick(e));
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    viewer.scene.postRender.addEventListener(() => this.declutter());
    onViewStyle(() => { if (this.active) { this.draw(false); this.renderPanel(); } });
  }

  /** Reads zones.geojson and the structure files (its own copy: the structures layer keeps its solids to itself). */
  async load() {
    const json = async (url: string) => { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; } };
    this.zones = parseZones(await json('/zones.geojson'));
    const index = await json(`/structures/${STRUCTURES.indexFile}`);
    const files: string[] = Array.isArray(index) ? index.filter((f) => typeof f === 'string' && /^[\w.-]+\.geojson$/.test(f)) : STRUCTURES.files;
    const solids: Solid[] = [];
    for (const file of files) { const fc = await json(`/structures/${file}`); if (fc) solids.push(...parseStructures(file, fc).solids); }
    this.solids = solids;
    if (this.active) this.renderPanel();
  }

  areas(): LvArea[] {
    return this.src.areas().map((a) => ({ id: a.id, name: a.name, elevationM: a.elevationM, buildingId: a.buildingId, floor: a.floor, rings: a.geometry.coordinates.map(metres) }));
  }

  /** The buildings that can be lifted: one per base id, named by the block that has a name. */
  buildingList(): { id: string; name: string }[] {
    const out = new Map<string, string>();
    for (const b of this.src.buildings()) {
      const id = baseBuildingId(b.buildingId);
      if (!out.has(id) || (b.buildingId === id && b.name)) out.set(id, (b.buildingId === id ? b.name : null) ?? out.get(id) ?? id);
    }
    return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  setActive(on: boolean, options: { fly?: boolean } = {}) {
    if (on === this.active) return;
    if (on) {
      const reason = this.src.blocked?.();
      if (reason) { this.say(reason); this.changed(); return; }
      const cam = this.viewer.camera;
      this.saved = { destination: cam.positionWC.clone(), heading: cam.heading, pitch: cam.pitch, roll: cam.roll };
      this.active = true;
      this.message = '';
      this.src.onLevel?.(true);
      this.panel.hidden = false;
      this.renderPanel();
    } else {
      this.active = false;
      this.unit = null;
      this.src.onLevel?.(false);
      this.clear();
      this.panel.hidden = true;
      if (this.saved) {
        const view = { destination: this.saved.destination, orientation: { heading: this.saved.heading, pitch: this.saved.pitch, roll: this.saved.roll } };
        if (options.fly === false) this.viewer.camera.setView(view); else this.viewer.camera.flyTo({ ...view, duration: 0.8 });
      }
      this.saved = null;
    }
    this.changed();
  }

  private say(text: string) {
    this.message = text;
    if (this.active) this.renderPanel();
    else console.info(text);
  }

  // ---------- choosing ----------
  /** A map click while the view is on. true: the click is used up (the page does nothing with it). */
  handleClick(position: any): boolean {
    if (!this.active) return false;
    const scene = this.viewer.scene;
    const picked = scene.pick(position);
    if (picked && (this.prims.includes(picked.primitive) || this.prims.includes(picked.collection))) return true; // on what is lifted
    const id = picked?.id as { kind?: string; buildingId?: string } | undefined;
    if (id?.kind === 'building' && id.buildingId) { this.showBuilding(baseBuildingId(id.buildingId)); return true; }
    const p = this.pickPoint(position);
    if (!p) return true;
    // an underground zone only when what was hit lies under the ground as drawn (its height range also holds the road above a tunnel)
    const zone = zoneAt(this.zones, p.x, p.y, p.z < this.src.groundAt(p.x, p.y) - 1.5 ? p.z : undefined);
    if (zone) this.showZone(zone.id); else this.say('구획 밖입니다(캠퍼스 안을 누르세요).');
    return true;
  }

  /** The plan point and height of what is under a screen position. */
  pickPoint(position: any): { x: number; y: number; z: number } | null {
    const C = this.C, scene = this.viewer.scene;
    let world = scene.pickPositionSupported ? scene.pickPosition(position) : null;
    if (!world || !Number.isFinite(world.x)) { const ray = this.viewer.camera.getPickRay(position); world = ray && scene.globe.pick(ray, scene); }
    if (!world) return null;
    const carto = C.Cartographic.fromCartesian(world);
    const p = tmForward(C.Math.toDegrees(carto.latitude), C.Math.toDegrees(carto.longitude));
    return { x: p.x, y: p.y, z: carto.height };
  }

  showZone(id: string) {
    const zone = this.zones.find((z) => z.id === id);
    if (!zone) return;
    this.unit = { kind: 'zone', zone };
    this.message = '';
    this.draw(true);
    this.renderPanel();
  }

  showBuilding(id: string, focus: number | null = null) {
    const blocks = this.src.buildings().filter((b) => baseBuildingId(b.buildingId) === id);
    if (!blocks.length) return;
    const main = blocks.find((b) => b.buildingId === id) ?? blocks[0];
    const roads = this.src.roads().filter((r) => r.buildingId && baseBuildingId(r.buildingId) === id);
    const floors = buildingFloors(blocks, main.appearance?.windows?.floorsM, roads);
    this.unit = { kind: 'building', id, name: main.name ?? id, floors, focus: focus !== null && focus < floors.length ? focus : null };
    this.message = floors.length ? '' : '이 건물은 층 자료(층 표·실내 길)가 없어 바닥 판 하나만 띄웁니다.';
    this.draw(true);
    this.renderPanel();
  }

  /** ↑ / ↓: the next floor of the building (past the ends: the whole stack), or the next zone of the same layer. */
  step(delta: number) {
    const u = this.unit;
    if (!u) return;
    if (u.kind === 'building') {
      if (!u.floors.length) return;
      const next = u.focus === null ? (delta > 0 ? 0 : u.floors.length - 1) : u.focus + delta;
      u.focus = next < 0 || next >= u.floors.length ? null : next;
      this.draw(false);
      this.frame();
    } else {
      const same = this.zones.filter((z) => z.layer === u.zone.layer);
      if (u.zone.layer === 'underground') same.sort((a, b) => (a.floorM ?? a.fromM!) - (b.floorM ?? b.fromM!));
      const i = same.findIndex((z) => z.id === u.zone.id);
      this.showZone(same[(i + delta + same.length) % same.length].id);
      return;
    }
    this.renderPanel();
  }

  /** Where a walk starts for what is lifted: a point on its first road, else its middle. */
  anchor(): { x: number; y: number; z: number } | null {
    const u = this.unit;
    if (!u) return null;
    const mid = (line: number[][]) => { const a = line[Math.floor((line.length - 1) / 2)], b = line[Math.ceil((line.length - 1) / 2)]; return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: (a[2] + b[2]) / 2 }; };
    if (u.kind === 'zone') {
      const content = zoneContent(u.zone, { roads: this.src.roads(), areas: this.areas(), solids: this.solids });
      const road = content.roads.find((r) => r.road.roadClass !== 'vehicle') ?? content.roads[0];
      if (road) return mid(road.cut.pieces[0]);
      const ring = u.zone.polygons[0][0];
      const x = ring.reduce((s, p) => s + p[0], 0) / ring.length, y = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      return { x, y, z: u.zone.floorM ?? this.src.groundAt(x, y) };
    }
    const roads = this.src.roads().filter((r) => r.buildingId && baseBuildingId(r.buildingId) === u.id && !isConnector(r));
    const floor = u.focus !== null ? u.floors[u.focus] : u.floors.find((f) => f.roadIds.length);
    const road = roads.find((r) => floor?.roadIds.includes(r.id)) ?? roads[0];
    return road ? mid(road.geometry.coordinates) : null;
  }

  // ---------- drawing ----------
  private clear() {
    cancelAnimationFrame(this.animation);
    for (const p of this.prims) this.viewer.scene.primitives.remove(p);
    this.prims = [];
    this.tags = [];
  }

  private pos(p: number[]) {
    const g = tmInverse(p[0], p[1]);
    return this.C.Cartesian3.fromDegrees(g.longitude, g.latitude, p[2]);
  }

  private mesh(batch: Batch, translucent: boolean) {
    const C = this.C;
    const n = batch.positions.length / 3;
    if (!n) return null;
    const positions = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) { const c = this.pos([batch.positions[3 * i], batch.positions[3 * i + 1], batch.positions[3 * i + 2]]); positions.set([c.x, c.y, c.z], 3 * i); }
    const geometry = new C.Geometry({
      attributes: {
        position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
        color: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: new Uint8Array(batch.colors) }),
      } as any,
      indices: n > 65535 ? new Uint32Array(batch.indices) : new Uint16Array(batch.indices),
      primitiveType: C.PrimitiveType.TRIANGLES,
      boundingSphere: C.BoundingSphere.fromVertices(positions as any),
    });
    return new C.Primitive({ geometryInstances: new C.GeometryInstance({ geometry }), appearance: new C.PerInstanceColorAppearance({ flat: true, translucent, closed: false }), asynchronous: false });
  }

  /** A solid (or a plate written like one) into a batch, heights through `lift`. */
  private addSolid(batch: Batch, solid: Solid, lift: (z: number) => number, colors: { body: string; top: string }, alpha = 255) {
    const { mesh } = solidMesh(solid);
    const body = rgb(colors.body), top = rgb(colors.top);
    const points: number[][] = [];
    const shades: number[][] = [];
    for (let i = 0; i < mesh.positions.length; i += SOLID_STRIDE) {
      points.push([mesh.positions[i], mesh.positions[i + 1], lift(mesh.positions[i + 2])]);
      const c = mesh.positions[i + 4] ? top : body, s = mesh.positions[i + 3];
      shades.push([c[0] * s, c[1] * s, c[2] * s]);
    }
    batch.add(points, mesh.indices, (i) => shades[i], alpha);
  }

  private plate(polygon: Polygon, topM: number, thicknessM = 0.3): Solid {
    return { id: 'plate', file: '', role: 'box', type: 'plate', polygon, bottomM: topM - thicknessM, topM, estimated: false, props: {} };
  }

  /** A road piece as a flat band of its width. */
  private addRibbon(batch: Batch, line: number[][], widthM: number, lift: (z: number) => number, color: string, alpha = 255) {
    if (line.length < 2) return;
    const { left, right } = ribbon(line.map((p) => [p[0], p[1], p[2]] as P3), widthM);
    const points = [...left, ...right].map((p) => [p[0], p[1], lift(p[2]) + 0.15]);
    const indices: number[] = [];
    for (let i = 0; i + 1 < left.length; i++) indices.push(i, left.length + i, i + 1, i + 1, left.length + i, left.length + i + 1);
    const c = rgb(color);
    batch.add(points, indices, () => c, alpha);
  }

  private draw(fly: boolean) {
    this.clear();
    const u = this.unit;
    if (!u) return;
    const C = this.C, style = viewStyle(), px = LINE_PX[style.line], show = LABELS[style.labels];
    const buildings = this.src.buildings();
    const baseM = Math.max(...buildings.map((b) => b.roofM), 0) + LEVEL_VIEW.clearRoofM;
    const solid = new Batch(), faint = new Batch();
    const lines = new C.PolylineCollection(), leaders = new C.PolylineCollection(), points = new C.PointPrimitiveCollection(), labels = new C.LabelCollection();
    const material = (hex: string, alpha = 1, dash = false) => C.Material.fromType(dash ? 'PolylineDash' : 'Color', dash ? { color: C.Color.fromCssColorString(hex).withAlpha(alpha), dashLength: 10 } : { color: C.Color.fromCssColorString(hex).withAlpha(alpha) });
    const line = (pts: number[][], width: number, hex: string, alpha = 1, dash = false, into = lines) => { if (pts.length > 1) into.add({ positions: pts.map((p) => this.pos(p)), width, material: material(hex, alpha, dash) }); };
    const seen = new Set<string>();
    const tag = (kind: keyof typeof show, p: number[], text: string, priority: number, size = 13, color = VIEW_COLORS.label) => {
      if (!show[kind] || !text || seen.has(`${kind}|${text}`)) return;
      seen.add(`${kind}|${text}`);
      const world = this.pos(p);
      const label = labels.add({
        position: world, text, font: `${kind === 'title' ? 700 : 600} ${size}px system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`,
        fillColor: C.Color.fromCssColorString(color), outlineColor: C.Color.WHITE, outlineWidth: 4, style: C.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: C.HorizontalOrigin.CENTER, verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, -6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new C.NearFarScalar(120, 1.15, 900, 0.6), show: false,
      });
      this.tags.push({ label, world, priority });
    };
    const dot = (p: number[], hex: string, size = 9) => points.add({ position: this.pos(p), color: C.Color.fromCssColorString(hex), pixelSize: size, outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY });
    // stairs and pedestrian ramps are connectors by what they are; indoors any road between two floors is one (outdoors a sloping carriageway is not)
    const linking = (r: LvRoad) => r.structure === 'stairs' || r.structure === 'elevator' || (r.roadClass === 'pedestrian' && (r.structure === 'ramp' || (!!r.buildingId && isConnector(r))));
    const roadColor = (r: LvRoad) => (r.structure === 'elevator' ? VIEW_COLORS.elevator : linking(r) ? VIEW_COLORS.stairs : r.roadClass === 'pedestrian' ? VIEW_COLORS.pedestrian : VIEW_COLORS.vehicle);
    const roadFill = (r: LvRoad) => (linking(r) ? '#f3c79b' : r.roadClass === 'pedestrian' ? '#bcd4f2' : '#4a5059');
    const raised = (pts: number[][], lift: (z: number) => number, up = 0.35) => pts.map((p) => [p[0], p[1], lift(p[2]) + up]);
    const middle = (pts: number[][]) => pts[Math.floor(pts.length / 2)];
    const corners = (rings: number[][][]) => {
      const all = rings.flat();
      if (!all.length) return [];
      const pick = (f: (p: number[]) => number) => all.reduce((a, b) => (f(b) > f(a) ? b : a));
      return [...new Set([pick((p) => p[0]), pick((p) => -p[0]), pick((p) => p[1]), pick((p) => -p[1])])];
    };
    const frame: number[][] = []; // lifted points the camera frames
    let dropM = 0; // how far the whole drawing starts below its place (the animation)
    let veilM = baseM;

    if (u.kind === 'zone') {
      const zone = u.zone, ground = zone.layer === 'ground';
      const content = zoneContent(zone, { roads: this.src.roads(), areas: this.areas(), solids: this.solids, places: this.src.places?.() });
      const lift = (z: number) => z + baseM - content.minM;
      dropM = baseM - content.minM;
      veilM = baseM - 2.5;
      const floorAt = (x: number, y: number) => (ground ? this.src.groundAt(x, y) : zone.floorM ?? content.minM);
      if (!ground && zone.floorM !== undefined) for (const polygon of zone.polygons) this.addSolid(solid, this.plate(polygon, zone.floorM), lift, { body: '#aab1ba', top: VIEW_COLORS.plate });
      for (const s of content.solids) {
        const cut = ground
          ? (s.solid.thicknessM ? s.solid : { ...s.solid, bottomM: Math.max(s.solid.bottomM, content.minM - 2) })
          : { ...s.solid, bottomM: s.bottomM, topM: s.topM, profile: s.topM < s.solid.topM ? undefined : s.solid.profile };
        if (cut.topM - cut.bottomM > 0.001 || cut.profile) this.addSolid(solid, cut as Solid, lift, solidColors(s.solid));
      }
      for (const area of content.areas) {
        const ring = openRing(area.rings[0]);
        if (!ground && area.elevationM != null) this.addSolid(solid, this.plate([ring], area.elevationM + 0.04, 0.04), lift, { body: '#c9ced6', top: '#c9ced6' });
        const z = area.elevationM ?? floorAt(ring[0][0], ring[0][1]);
        line([...ring, ring[0]].map((p) => [p[0], p[1], lift(z) + 0.3]), px.faint + 0.5, VIEW_COLORS.outline, 0.7);
        tag('place', [...middle(ring), lift(z) + 1], shortName(area.name), 3);
      }
      // the firm edge of the zone, along the ground as drawn (underground: at its floor)
      for (const polygon of zone.polygons) for (const ring of polygon) {
        const edge = [...ring, ring[0]].map((p) => [p[0], p[1], lift(floorAt(p[0], p[1])) + 0.4]);
        line(edge, px.outline, VIEW_COLORS.outline);
        frame.push(...edge);
      }
      for (const { road, cut } of content.roads) {
        const width = roadWidthM(road);
        for (const piece of cut.pieces) {
          this.addRibbon(solid, piece, width, lift, roadFill(road));
          line(raised(piece, lift), px.road, roadColor(road));
        }
        const longest = cut.pieces.reduce((a, b) => (b.length > a.length ? b : a));
        tag('road', raised([middle(longest)], lift, 1)[0], shortName(road.name), 1, 12);
        if (linking(road)) for (const end of [cut.pieces[0][0], cut.pieces[cut.pieces.length - 1].slice(-1)[0]]) dot(raised([end], lift)[0], VIEW_COLORS.stairs, 7);
        for (const stub of cut.stubs) {
          line(raised(stub, lift), px.connector, VIEW_COLORS.stub, 1, true);
          const end = stub[stub.length - 1];
          const next = zoneAt(this.zones, end[0], end[1], ground ? undefined : end[2]);
          dot(raised([stub[0]], lift)[0], VIEW_COLORS.stub, 7);
          if (next && next.id !== zone.id) tag('link', raised([end], lift, 1)[0], `→ ${shortName(next.name, 16)}`, 4, 12, VIEW_COLORS.stub);
        }
      }
      if (ground) {
        for (const b of buildings) {
          for (const poly of b.geometry.coordinates) {
            const ring = metres(poly[0]);
            const c = middle(ring);
            if (!zone.polygons.some((p) => p[0].length && ringHas(p, c))) continue;
            const z = lift(this.src.groundAt(c[0], c[1])) + 0.4;
            line([...ring, ring[0]].map((p) => [p[0], p[1], z]), px.faint + 0.5, VIEW_COLORS.leader, 0.9, true);
            if (b.name) tag('place', [c[0], c[1], z + 1], `${b.name} 자리`, 2, 12, VIEW_COLORS.leader);
          }
        }
      }
      for (const place of content.places) { dot([place.x, place.y, lift(place.z) + 0.5], VIEW_COLORS.place); tag('place', [place.x, place.y, lift(place.z) + 1.2], shortName(place.name), 5, 12, VIEW_COLORS.place); }
      const outer = zone.polygons.reduce((a, b) => (b[0].length > a[0].length ? b : a))[0];
      tag('title', [...middle(outer), lift(content.maxM) + 4], zone.name, 10, 16);
      for (const p of corners(zone.polygons.map((poly) => poly[0]))) { const z = floorAt(p[0], p[1]); line([[p[0], p[1], z], [p[0], p[1], lift(z)]], 1.5, VIEW_COLORS.leader, 0.9, true, leaders); }
    } else {
      const blocks = buildings.filter((b) => baseBuildingId(b.buildingId) === u.id);
      const floors: Floor[] = u.floors.length ? u.floors : [{ m: Math.min(...blocks.map((b) => b.baseM)), name: null, fromTable: false, roadIds: [] }];
      const lift = explode(floors.map((f) => f.m), baseM);
      dropM = baseM - floors[0].m;
      veilM = baseM - 2.5;
      const roads = this.src.roads();
      const own = roads.filter((r) => r.buildingId && baseBuildingId(r.buildingId) === u.id);
      const focused = (i: number) => u.focus === null || u.focus === i;
      const others = OTHERS[style.others].plate;
      const footprints = blocks.map((b) => ({ b, rings: b.geometry.coordinates.map((poly) => metres(poly[0])) }));
      floors.forEach((floor, i) => {
        const on = focused(i);
        if (!on && others <= 0) return;
        let here = footprints.filter(({ b }) => floor.m >= b.baseM - LEVEL_VIEW.belowBaseM && floor.m < b.roofM);
        if (!here.length) here = footprints;
        for (const { rings } of here) for (const ring of rings) {
          this.addSolid(on ? solid : faint, this.plate([ring], floor.m), lift, { body: '#aab1ba', top: floor.roadIds.length ? '#f3f5f7' : '#dfe3e8' }, on ? 255 : Math.round(255 * others));
          const edge = [...ring, ring[0]].map((p) => [p[0], p[1], lift(floor.m) + 0.05]);
          line(edge, on ? px.outline : px.faint, VIEW_COLORS.outline, on ? 1 : 0.25);
          if (on) frame.push(...edge);
        }
        const ring = here.reduce((a, b) => (b.rings[0].length > a.rings[0].length ? b : a)).rings[0];
        const corner = ring.reduce((a, b) => (b[0] - b[1] > a[0] - a[1] ? b : a)); // the south-east corner: beside the plate, not on it
        const text = `${floor.name ? `${floor.name} · ` : ''}${floor.m.toFixed(1)} m${floor.fromTable ? '' : ' (길 높이)'}`;
        if (on) tag('floor', [corner[0], corner[1], lift(floor.m) + 0.6], u.floors.length ? text : `층 자료 없음 · 바닥 ${floor.m.toFixed(1)} m`, u.focus === i ? 9 : 6, u.focus === i ? 15 : 12);
      });
      const nodeFloor = new Map<string, number>(); // node id -> its height, for the stubs
      for (const road of own) {
        const coords = road.geometry.coordinates;
        const ends = [floorIndexAt(floors, coords[0][2]), floorIndexAt(floors, coords[coords.length - 1][2])];
        if (road.fromNodeId) nodeFloor.set(road.fromNodeId, coords[0][2]);
        if (road.toNodeId) nodeFloor.set(road.toNodeId, coords[coords.length - 1][2]);
        const connector = isConnector(road);
        const on = connector ? u.focus === null || ends.includes(u.focus) : focused(floorIndexAt(floors, (coords[0][2] + coords[coords.length - 1][2]) / 2));
        if (!on && others <= 0) continue;
        if (on && !connector) this.addRibbon(solid, coords, roadWidthM(road), lift, roadFill(road));
        line(raised(coords, lift, connector ? 0.2 : 0.35), on ? (connector ? px.connector : px.road) : px.faint, roadColor(road), on ? 1 : 0.2);
        if (!on) continue;
        if (!connector) tag('road', raised([middle(coords)], lift, 1)[0], shortName(road.name), 1, 12);
        else {
          for (const end of [coords[0], coords[coords.length - 1]]) dot(raised([end], lift, 0.3)[0], roadColor(road), 8);
          if (u.focus !== null) {
            const far = ends[0] === u.focus ? coords[coords.length - 1] : coords[0];
            const to = floorIndexAt(floors, far[2]);
            const where = to >= 0 ? `${floors[to].name ?? ''} ${floors[to].m.toFixed(1)} m`.trim() : `${far[2].toFixed(1)} m`;
            tag('link', raised([far], lift, 0.8)[0], `${road.structure === 'elevator' ? '승강기' : road.structure === 'ramp' ? '경사로' : '계단'} → ${where}`, 5, 12, roadColor(road));
          }
        }
      }
      // roads of the campus that start at a node of this building: a short stub, named by where it leads
      for (const road of roads) {
        if (road.buildingId && baseBuildingId(road.buildingId) === u.id) continue;
        const coords = road.geometry.coordinates;
        for (const [node, pts] of [[road.fromNodeId, coords], [road.toNodeId, [...coords].reverse()]] as [string | undefined, number[][]][]) {
          // it starts at a node of the building's roads, or (no indoor road there yet) its end lies inside the building at a floor's height
          const joins = (node && nodeFloor.has(node)) || (floorIndexAt(floors, pts[0][2]) >= 0 && footprints.some(({ rings }) => rings.some((ring) => ringHas([ring], pts[0]))));
          if (!joins) continue;
          const i = floorIndexAt(floors, node && nodeFloor.has(node) ? nodeFloor.get(node)! : pts[0][2]);
          if (!focused(i) && u.focus !== null) continue;
          let stub: number[][] = [pts[0]], left = LEVEL_VIEW.stubM;
          for (let k = 1; k < pts.length && left > 0; k++) { const d = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); const t = Math.min(1, left / (d || 1)); stub.push(pts[k - 1].map((v, j) => v + (pts[k][j] - v) * t)); left -= d; }
          // the stub keeps the plate's height: where it leads is told by its tag
          stub = stub.map((p) => [p[0], p[1], pts[0][2]]);
          line(raised(stub, lift), px.connector, VIEW_COLORS.stub, 1, true);
          dot(raised([stub[0]], lift)[0], VIEW_COLORS.stub, 8);
          const end = pts[Math.min(pts.length - 1, 1)];
          const where = road.buildingId ? this.buildingList().find((b) => b.id === baseBuildingId(road.buildingId!))?.name ?? road.buildingId : zoneAt(this.zones, end[0], end[1], end[2])?.name ?? shortName(road.name);
          tag('link', raised([stub[stub.length - 1]], lift, 0.9)[0], `→ ${shortName(where, 16)}`, 4, 12, VIEW_COLORS.stub);
        }
      }
      for (const place of this.src.places?.() ?? []) {
        if (!place.buildingId || baseBuildingId(place.buildingId) !== u.id || !focused(floorIndexAt(floors, place.z))) continue;
        dot([place.x, place.y, lift(place.z) + 0.5], VIEW_COLORS.place);
        tag('place', [place.x, place.y, lift(place.z) + 1.2], shortName(place.name), 5, 12, VIEW_COLORS.place);
      }
      const main = footprints.reduce((a, b) => (b.rings[0].length > a.rings[0].length ? b : a)).rings[0];
      tag('title', [...middle(main), lift(floors[floors.length - 1].m) + 6], u.name, 10, 16);
      for (const p of corners([main])) line([[p[0], p[1], floors[0].m], [p[0], p[1], lift(floors[0].m)]], 1.5, VIEW_COLORS.leader, 0.9, true, leaders);
    }

    // everything of the campus below is faded by a veil under what is lifted (view-style.ts OTHERS.veil = what still shows)
    const b = buildings.flatMap((x) => x.geometry.coordinates.flatMap((poly) => poly[0]));
    if (b.length) {
      const lon = b.map((p) => p[0]), lat = b.map((p) => p[1]);
      const veil = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.RectangleGeometry({ rectangle: C.Rectangle.fromDegrees(Math.min(...lon) - 0.006, Math.min(...lat) - 0.005, Math.max(...lon) + 0.006, Math.max(...lat) + 0.005), height: veilM, vertexFormat: C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT }),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(VIEW_COLORS.veil).withAlpha(1 - OTHERS[style.others].veil)) },
        }),
        appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: OTHERS[style.others].veil > 0 }), asynchronous: false, allowPicking: false,
      });
      this.prims.push(this.viewer.scene.primitives.add(veil));
    }
    const moving: any[] = [];
    for (const p of [this.mesh(solid, false), this.mesh(faint, true), lines, points, labels]) if (p) { moving.push(p); this.prims.push(this.viewer.scene.primitives.add(p)); }
    this.prims.push(this.viewer.scene.primitives.add(leaders));
    this.frameSphere = frame.length ? C.BoundingSphere.fromPoints(frame.map((p) => this.pos(p))) : null;

    // the lift itself: the drawing starts at its true place and rises (only when something new was chosen)
    const up = C.Cartesian3.normalize(this.pos([...(frame[0] ?? [200000, 557000]).slice(0, 2), 0]), new C.Cartesian3());
    const place = (t: number) => {
      const m = C.Matrix4.fromTranslation(C.Cartesian3.multiplyByScalar(up, -(1 - t) * dropM, new C.Cartesian3()));
      for (const p of moving) p.modelMatrix = m;
      leaders.show = t >= 1;
      labels.show = t >= 1;
    };
    if (!fly) { place(1); return; }
    this.frame();
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / 900);
      place(1 - (1 - t) ** 3);
      if (t < 1) this.animation = requestAnimationFrame(tick);
    };
    tick();
  }

  private frameSphere: any = null;
  /** The camera looks at what is lifted (the chosen floor of a building), from the side it was on. */
  private frame() {
    const C = this.C;
    if (!this.frameSphere) return;
    this.viewer.camera.flyToBoundingSphere(this.frameSphere, { duration: 0.9, offset: new C.HeadingPitchRange(this.viewer.camera.heading, C.Math.toRadians(-38), Math.max(60, this.frameSphere.radius * 2.6)) });
  }

  /** Tags that would cover a more important one are hidden (checked a few times a second while the view is on). */
  private declutter() {
    if (!this.active || !this.tags.length || performance.now() - this.lastDeclutter < 250) return;
    this.lastDeclutter = performance.now();
    const C = this.C, scene = this.viewer.scene;
    const toWindow = C.SceneTransforms.worldToWindowCoordinates ?? C.SceneTransforms.wgs84ToWindowCoordinates;
    const kept: number[][] = [];
    for (const tag of [...this.tags].sort((a, b) => b.priority - a.priority)) {
      const w = toWindow(scene, tag.world);
      if (!w) { tag.label.show = false; continue; }
      const half = (tag.label.text.length * 7.5 + 12) / 2;
      const box = [w.x - half, w.y - 26, w.x + half, w.y];
      const free = kept.every((k) => box[2] < k[0] || box[0] > k[2] || box[3] < k[1] || box[1] > k[3]);
      tag.label.show = free;
      if (free) kept.push(box);
    }
  }

  // ---------- panel ----------
  private renderPanel() {
    const u = this.unit, style = viewStyle();
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const option = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
    const zoneOptions = (layer: Zone['layer']) => this.zones.filter((z) => z.layer === layer).map((z) => option(`zone:${z.id}`, z.name, u?.kind === 'zone' && u.zone.id === z.id)).join('');
    const title = !u ? '지도에서 건물·길·공간을 누르세요'
      : u.kind === 'zone' ? `${u.zone.name}${u.zone.layer === 'underground' ? ` · ${u.zone.floorM !== undefined ? `바닥 ${u.zone.floorM.toFixed(1)} m` : `${u.zone.fromM!.toFixed(1)}~${u.zone.toM!.toFixed(1)} m`}` : ''}`
      : `${u.name}${u.focus !== null ? ` ${u.floors[u.focus].name ?? ''} · 바닥 ${u.floors[u.focus].m.toFixed(1)} m` : ` · 층 ${u.floors.length}개 벌려 보기`}`;
    const sub = !u ? '' : u.kind === 'zone' ? `${u.zone.description} — 구획 경계는 작업 구분(추정)` : '층: 건물 노트의 층 표 + 실내 길이 있는 높이. 층 이름은 길에 적힌 것만(없으면 높이만)';
    const floors = u?.kind === 'building' && u.floors.length
      ? `<div class="level-floors"><button type="button" data-floor="all" class="${u.focus === null ? 'on' : ''}">전체</button>${[...u.floors.keys()].reverse().map((i) => {
        const f = u.floors[i];
        return `<button type="button" data-floor="${i}" class="${u.focus === i ? 'on' : ''}${f.roadIds.length ? '' : ' empty'}" title="바닥 ${f.m.toFixed(1)} m${f.roadIds.length ? ` · 길 ${f.roadIds.length}개` : ' · 길 없음'}">${esc(f.name ?? f.m.toFixed(1))}</button>`;
      }).join('')}</div>` : '';
    const choice = <K extends keyof ViewStyle>(k: K) => `<label>${VIEW_STYLE_TITLES[k]} <select data-style="${k}">${(VIEW_STYLE_CHOICES[k] as { value: string; label: string }[]).map((c) => option(c.value, c.label, style[k] === c.value)).join('')}</select></label>`;
    const swatch = (color: string, label: string, cls = '') => `<span><i class="${cls}" style="--c:${color}"></i>${label}</span>`;
    this.panel.innerHTML = `
      <div class="level-head"><b>층 따로 보기</b><button type="button" data-action="close" title="제자리로 돌려놓고 끝냄 (Esc)">닫기</button></div>
      <div class="level-title">${esc(title)}</div>
      ${sub ? `<div class="level-sub">${esc(sub)}</div>` : ''}
      ${this.message ? `<div class="level-msg">${esc(this.message)}</div>` : ''}
      <select data-pick><option value="">구획·건물 고르기…</option><optgroup label="지상 구획">${zoneOptions('ground')}</optgroup><optgroup label="지하">${zoneOptions('underground')}</optgroup>
        <optgroup label="건물(층 벌려 보기)">${this.buildingList().map((b) => option(`building:${b.id}`, b.name, u?.kind === 'building' && u.id === b.id)).join('')}</optgroup></select>
      ${floors}
      <div class="level-style">${choice('line')}${choice('labels')}${choice('others')}</div>
      <div class="level-legend">${swatch(VIEW_COLORS.vehicle, '차도')}${swatch(VIEW_COLORS.pedestrian, '보행로·복도')}${swatch(VIEW_COLORS.stairs, '계단·경사로')}${swatch(VIEW_COLORS.elevator, '승강기')}${swatch(VIEW_COLORS.stub, '이웃으로 이어짐', 'dash')}${swatch(VIEW_COLORS.place, '장소', 'dot')}${swatch(VIEW_COLORS.leader, '제자리 표시선', 'dash')}</div>
      <div class="level-hint">띄우는 높이: 가장 높은 지붕 + ${LEVEL_VIEW.clearRoofM} m. ↑↓ · PageUp/PageDown: 층(건물)·구획 차례로. Esc: 제자리로.${this.src.lockKeys ? ' 띄운 동안에는 편집이 잠깁니다(보기 전용).' : ''}</div>`;
  }

  private onPanelChange(e: Event) {
    const el = e.target as HTMLSelectElement;
    if (el.dataset.style) { setViewStyle({ [el.dataset.style]: el.value } as Partial<ViewStyle>); return; }
    if (el.dataset.pick === undefined || !el.value) return;
    const [kind, id] = [el.value.slice(0, el.value.indexOf(':')), el.value.slice(el.value.indexOf(':') + 1)];
    if (kind === 'zone') this.showZone(id); else this.showBuilding(id);
  }

  private onPanelClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-floor]');
    if (!el) return;
    if (el.dataset.action === 'close') { this.setActive(false); return; }
    const u = this.unit;
    if (u?.kind !== 'building' || el.dataset.floor === undefined) return;
    u.focus = el.dataset.floor === 'all' ? null : Number(el.dataset.floor);
    this.draw(false);
    this.frame();
    this.renderPanel();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.active || typing(e)) return;
    if (this.src.lockKeys) e.stopImmediatePropagation(); // the page's own keys (cursor, drawing, shortcuts) rest while the view is on
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const delta = e.code === 'ArrowUp' || e.code === 'PageUp' ? 1 : e.code === 'ArrowDown' || e.code === 'PageDown' ? -1 : 0;
    if (delta) { e.preventDefault(); e.stopImmediatePropagation(); this.step(delta); }
    else if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.setActive(false); }
  }
}

/** Whether a point is in a polygon (outer ring minus holes). */
function ringHas(polygon: Polygon, p: number[]): boolean {
  let n = 0;
  for (const ring of polygon) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) n++;
  }
  return n % 2 === 1;
}

export type SpaceViews = {
  level: LevelView;
  walk: FirstPerson;
  /** A map click: true when a view used it (the page then does nothing with it). */
  handleClick: (position: any) => boolean;
  /** Either view is on. */
  busy: () => boolean;
};

/**
 * Both views on a viewer, wired to the page's two toggles (a checkbox or a button each; a button gets the class
 * `active` while its view is on). The page calls handleClick first in its map click handler.
 */
export function mountSpaceViews(viewer: any, src: SpaceViewSources, controls: { level: HTMLElement; walk: HTMLElement }): SpaceViews {
  const mark = (el: HTMLElement, on: boolean) => { if (el instanceof HTMLInputElement) el.checked = on; else el.classList.toggle('active', on); };
  let views: SpaceViews;
  const changed = () => {
    mark(controls.level, views.level.active);
    mark(controls.walk, views.walk.active || views.walk.waiting);
    document.body.classList.toggle('space-view-on', views.busy());
    src.onChange?.({ level: views.level.active, walk: views.walk.active });
  };
  const level = new LevelView(viewer, src, () => changed());
  const walk = new FirstPerson(viewer, {
    roads: src.roads, areas: () => level.areas(), solids: () => level.solids, zones: () => level.zones, buildings: src.buildings, groundAt: src.groundAt,
    lockKeys: src.lockKeys, inputs: src.walkInputs ?? [], onWalk: src.onWalk, pickPoint: (position) => level.pickPoint(position),
  }, () => changed());
  views = {
    level, walk,
    busy: () => level.active || walk.active || walk.waiting,
    handleClick: (position) => walk.handleClick(position) || level.handleClick(position),
  };
  void level.load().catch((err) => console.error('zones / structures unavailable', err));
  controls.level.addEventListener('click', () => {
    if (walk.active || walk.waiting) walk.stop();
    level.setActive(!level.active);
  });
  controls.walk.addEventListener('click', () => {
    if (walk.active || walk.waiting) { walk.stop(); return; }
    const reason = src.blocked?.();
    if (reason) { console.info(reason); changed(); return; }
    const at = level.active ? level.anchor() : null; // what is lifted is where the walk starts
    if (level.active) level.setActive(false, { fly: false });
    if (at) walk.start(at.x, at.y, at.z); else walk.wait();
  });
  return views;
}
