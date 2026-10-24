// "1인칭" (F08): walking through the model at eye height, on a Cesium viewer (preview and editor; started by
// level-view-layer.ts mountSpaceViews). Enter where the map is clicked, or at what "층 따로 보기" had lifted.
//   W/S forward / back, A/D sideways, mouse drag or arrow keys or Q/E to look, Shift to run, Esc to leave.
// The eye is WALK.eyeM above the surface under the feet, and that surface is chosen by level-view.ts feetHeight():
// the highest walkable surface at or below the feet (+ a step), stairs and ramps followed along their road. So an
// underground level or an indoor floor is walked at its own height and the walker never jumps to a roof or the field.
// There is no collision with walls. Nothing of the data is touched; the camera is put back on leaving.
// F09: underground and indoors there is no wall or ceiling model, so the level one stands on is drawn as a schematic
// room from what the data has (ROOM below): the outline of an underground storey or of a building floor as opaque walls
// with a ceiling, and (사2) on a floor that interiors.geojson carves, the rooms between its corridors, lobbies and
// stairwells as opaque wall blocks. No wall stands on a way of that level (a door, a link, an entrance stays open).
// 2026-10-25: the translucent box once drawn around every way (and every tunnel) is gone: walking, it looked like a
// glass wall across the way. While inside, the building one is in is hidden (hideBuildings) instead of drawn see-through.
// These are drawings of the walk only, not walls of the model. PageUp / PageDown on an elevator steps to its next stop.
import type { SceneBuilding } from './api';
import { LEVEL_VIEW, WALK, baseBuildingId, elevatorStops, feetHeight, floorOfRoad, floorText, inPolygons, isConnector, nextStop, roadHeightAt, shortName, walkSurfaces, zoneAt, type Interior, type LvArea, type LvRoad, type Zone } from './level-view';
import { ribbon, roadWidthM, type P3 } from './road-surface';
import { growPolygons, polygonArea, polygonOps, type Polygon } from './polygon-ops';
import { fillPolygons, type Solid } from './structures';
import { tmForward, tmInverse } from './tm';

export type WalkSources = {
  roads: () => LvRoad[]; areas: () => LvArea[]; solids: () => Solid[]; zones: () => Zone[]; buildings: () => SceneBuilding[];
  /** 사2: the empty spaces inside the buildings (interiors.geojson); none: the floors are plain shells. */
  interiors?: () => Interior[];
  groundAt: (x: number, y: number) => number;
  /** The plan point and height under a screen position. */
  pickPoint: (position: any) => { x: number; y: number; z: number } | null;
  lockKeys?: boolean;
  /** Checkboxes switched on while walking inside (underground ways) and put back afterwards. */
  inputs: HTMLInputElement[];
  onWalk?: (on: boolean) => void;
  /** The scene buildings (ids) to leave out while walking: the one the walker is in (see buildingsToHide); [] puts them all back. */
  hideBuildings?: (ids: string[]) => void;
};

/** F09: the schematic room drawn around the walker underground and indoors. Everything of it is opaque. */
export const ROOM = {
  /** A storey height when the floor table has no floor above. */
  storeyM: 3.3,
  /** Ways within this distance of the walker are kept open in the walls (redrawn when the walker has moved half of it). */
  reachM: 90,
  wall: '#d9dde2', floor: '#b4bac2', ceiling: '#eceef1', edge: '#374151',
  /** Lines down the walls and across the ceiling every this many metres: without them a plain face gives the eye no depth. */
  ribM: 6,
  /** The room of an underground storey stands this far inside the storey's own outline and under its top (the model's void box is drawn there, dark). */
  insetM: 0.12,
  /** Thickness of the outer wall of a floor or storey without interiors. */
  shellM: 0.25,
  /** The spaces of interiors.geojson are widened by this before the walls are cut (two spaces that nearly touch leave no sliver of wall between them). */
  spaceSlackM: 0.15,
  /** A way keeps at least this wide an opening through the walls. */
  openingM: 1.8,
  /** Wall pieces smaller than this (m²) are left out: slivers of a footprint and a space that do not quite meet. */
  minWallM2: 0.3,
};

/** The plan of a way's band (one quad per segment, `widthM` wide). */
function band(coords: number[][], widthM: number): Polygon[] {
  if (coords.length < 2) return [];
  const { left, right } = ribbon(coords.map((p) => [p[0], p[1], p[2] ?? 0] as P3), widthM);
  const out: Polygon[] = [];
  for (let i = 0; i + 1 < left.length; i++) out.push([[left[i], left[i + 1], right[i + 1], right[i]].map((p) => [p[0], p[1]])]);
  return out;
}

/**
 * The ways at a level (any part within -1 / +1.5 m of floorM, no elevator) as plan polygons: no wall stands on them.
 * `door`: every opening ROOM.openingM wide (indoors, where a way's stored or default width can be wider than the
 * corridor it runs in); else the way's own width, at least that.
 */
export function wayOpenings(roads: LvRoad[], floorM: number, door = false): Polygon[] {
  const out: Polygon[] = [];
  for (const road of roads) {
    if (road.structure === 'elevator') continue;
    const zs = road.geometry.coordinates.map((c) => c[2]);
    if (!zs.length || Math.min(...zs) > floorM + 1.5 || Math.max(...zs) < floorM - 1) continue;
    out.push(...band(road.geometry.coordinates, door ? ROOM.openingM : Math.max(ROOM.openingM, roadWidthM(road))));
  }
  return out;
}

/**
 * The walls of a level as plan polygons (each stands from the floor to the ceiling, opaque). Every piece of the outline
 * that a space reaches: the outline without the spaces (the rooms between the corridors stand as blocks). Any other
 * piece: its outer wall only (ROOM.shellM thick). Then the openings (the ways) are cut out of all of it.
 */
export function floorWalls(outline: Polygon[], spaces: Polygon[], openings: Polygon[]): Polygon[] {
  const pieces = polygonOps('union', outline);
  const wide = spaces.length ? growPolygons(spaces, ROOM.spaceSlackM) : [];
  const mass = pieces.flatMap((piece) => wide.length && polygonOps('both', wide, [piece]).length
    ? polygonOps('minus', [piece], wide)
    : polygonOps('minus', [piece], growPolygons([piece], -ROOM.shellM)));
  return polygonOps('minus', mass, openings, true).filter((p) => polygonArea(p) >= ROOM.minWallM2);
}

/** The spaces of interiors.geojson of a building (base id) on the floor at floorM. */
export function spacesOnFloor(interiors: Interior[], buildingId: string, floorM: number): Polygon[] {
  return interiors.filter((s) => baseBuildingId(s.building) === buildingId && s.floorsM.some((m) => Math.abs(m - floorM) <= LEVEL_VIEW.floorMatchM)).flatMap((s) => s.polygons);
}

/**
 * The scene buildings to leave out while walking: indoors, every block of the building one is in (from inside, its
 * blocks only hide the room drawn for the walk); underground, every block that stands at the feet's level (a basement
 * one may walk into). Outdoors none: the buildings stay as the user has them.
 */
export function buildingsToHide(buildings: SceneBuilding[], at: { feetM: number; indoorId: string | null; below: boolean }): string[] {
  if (at.indoorId) return buildings.filter((b) => baseBuildingId(b.buildingId) === at.indoorId).map((b) => b.buildingId);
  if (!at.below) return [];
  return buildings.filter((b) => b.baseM < at.feetM + WALK.eyeM && b.roofM > at.feetM + 0.5).map((b) => b.buildingId);
}

export type RoomInput = {
  x: number; y: number; feetM: number;
  /** The level underground storey one is in, or the building road one is on. */
  zone: Zone | null; indoor: LvRoad | null;
  roads: LvRoad[]; buildings: SceneBuilding[]; interiors: Interior[];
};

/**
 * F09: the schematic room for where the walker is (see ROOM), opaque throughout. Two cases:
 *  - a level underground storey (zone with a floor): its outline as a wall from floor to ceiling, an opaque ceiling;
 *  - a floor of a building: the footprint as floor and ceiling (the next floor of the note's table, else a storey
 *    above), its walls by floorWalls (사2 spaces of that floor, else the outer wall), a floor band on stairs and ramps.
 * Anywhere else (a tunnel, a passage under the ground) nothing: the way's own surface and the guide lines are what one sees.
 * Every way of the level within reach stays open through the walls.
 */
export function roomDrawing(r: RoomInput): { mesh: RoomMesh; lines: { points: number[][]; width: number }[] } {
  const mesh = new RoomMesh();
  const lines: { points: number[][]; width: number }[] = [];
  const edge = (points: number[][], width = 1.5) => { lines.push({ points, width }); };
  const roads = r.roads.filter((road) => { const h = roadHeightAt(road.geometry.coordinates, r.x, r.y); return !!h && h.distanceM <= ROOM.reachM; });
  /** A wall along a line of plan points, from `lowM` up `heightM`. */
  const wall = (line: number[][], heightM: number, lowM: number) => {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1];
      mesh.quad([a[0], a[1], lowM], [b[0], b[1], lowM], [b[0], b[1], lowM + heightM], [a[0], a[1], lowM + heightM], ROOM.wall);
    }
    edge(line.map((p) => [p[0], p[1], lowM + heightM]));
    edge(line.map((p) => [p[0], p[1], lowM + 0.03]), 1);
    // ribs: a vertical line every ROOM.ribM along the wall
    let carry = 0;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let d = carry; d < len; d += ROOM.ribM) {
        const t = d / (len || 1), x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
        edge([[x, y, lowM], [x, y, lowM + heightM]], 1);
      }
      carry = (carry - len) % ROOM.ribM; if (carry < 0) carry += ROOM.ribM;
    }
  };
  const walls = (polygons: Polygon[], heightM: number, lowM: number) => { for (const polygon of polygons) for (const ring of polygon) wall([...ring, ring[0]], heightM, lowM); };
  /** Lines across a level ceiling every ROOM.ribM, both ways, where they lie inside the polygons. */
  const ceilingGrid = (polygons: Polygon[], z: number) => {
    const all = polygons.flatMap((poly) => poly[0]);
    if (!all.length) return;
    const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0])), y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
    const run = (from: number[], to: number[]) => {
      const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2));
      let piece: number[][] = [];
      for (let k = 0; k <= n; k++) {
        const p = [from[0] + ((to[0] - from[0]) * k) / n, from[1] + ((to[1] - from[1]) * k) / n, z];
        if (inPolygons(polygons, p[0], p[1])) piece.push(p); else { if (piece.length > 1) edge(piece, 1); piece = []; }
      }
      if (piece.length > 1) edge(piece, 1);
    };
    for (let x = Math.ceil(x0 / ROOM.ribM) * ROOM.ribM; x <= x1; x += ROOM.ribM) run([x, y0], [x, y1]);
    for (let y = Math.ceil(y0 / ROOM.ribM) * ROOM.ribM; y <= y1; y += ROOM.ribM) run([x0, y], [x1, y]);
  };

  if (r.zone) {
    const floorM = r.zone.floorM!, heightM = r.zone.toM! - floorM - ROOM.insetM;
    const inner = growPolygons(r.zone.polygons, -ROOM.insetM);
    walls(floorWalls(inner, [], wayOpenings(roads, floorM)), heightM, floorM);
    for (const polygon of inner) mesh.fill(polygon, floorM + heightM, ROOM.ceiling);
    ceilingGrid(inner, floorM + heightM - 0.02);
  } else if (r.indoor) {
    const id = baseBuildingId(r.indoor.buildingId!);
    const blocks = r.buildings.filter((b) => baseBuildingId(b.buildingId) === id);
    const floorM = roadHeightAt(r.indoor.geometry.coordinates, r.x, r.y)?.z ?? r.feetM;
    const table = blocks.find((b) => b.buildingId === id)?.appearance?.windows?.floorsM ?? [];
    const above = table.filter((m) => m > floorM + 2).sort((a, b) => a - b)[0];
    const heightM = Math.min(above !== undefined ? above - floorM : ROOM.storeyM, 6) - 0.2;
    const outline: Polygon[] = [];
    for (const b of blocks) {
      if (!(floorM >= b.baseM - 2.5 && floorM < b.roofM)) continue;
      for (const poly of b.geometry.coordinates) outline.push([poly[0].slice(0, -1).map(([lon, lat]) => { const m = tmForward(lat, lon); return [m.x, m.y]; })]);
    }
    for (const polygon of outline) {
      mesh.fill(polygon, floorM - 0.05, ROOM.floor);
      mesh.fill(polygon, floorM + heightM, ROOM.ceiling);
    }
    ceilingGrid(outline, floorM + heightM - 0.02);
    walls(floorWalls(outline, spacesOnFloor(r.interiors, id, floorM), wayOpenings(roads, floorM, true)), heightM, floorM);
    // stairs and ramps of the building: a floor band (the footprint's floor is level), no walls
    for (const road of roads) {
      if (!road.buildingId || baseBuildingId(road.buildingId) !== id || !isConnector(road)) continue;
      const zs = road.geometry.coordinates.map((c) => c[2]);
      if (Math.min(...zs) > floorM + 1 || Math.max(...zs) < floorM - 1) continue;
      const { left, right } = ribbon(road.geometry.coordinates.map((p) => [p[0], p[1], p[2]] as P3), Math.max(ROOM.openingM, roadWidthM(road)));
      const up = (p: number[]) => [p[0], p[1], p[2] + 0.02];
      for (let i = 0; i + 1 < left.length; i++) mesh.quad(up(left[i]), up(right[i]), up(right[i + 1]), up(left[i + 1]), ROOM.floor);
    }
  }
  return { mesh, lines };
}

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ShiftLeft', 'ShiftRight']);
const typing = (e: Event) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement | null)?.isContentEditable;

export class FirstPerson {
  active = false;
  /** The button is on and the next map click is where the walk starts. */
  waiting = false;
  /** Where the walker is (for tests and scripted shots). */
  state = { x: 0, y: 0, feetM: 0, heading: 0, pitch: 0 };
  private readonly C: any;
  private readonly hud: HTMLElement;
  private readonly held = new Set<string>();
  private eyeM = 0;
  private last = 0;
  private lastHud = 0;
  private drag: { x: number; y: number } | null = null;
  private saved: { destination: any; heading: number; pitch: number; roll: number; near: number; inputs: boolean; checks: boolean[] } | null = null;
  private inside = false;
  private guides: any[] = [];
  private readonly guideSource: any;
  private data: { roads: LvRoad[]; areas: LvArea[]; solids: Solid[]; zones: Zone[] } = { roads: [], areas: [], solids: [], zones: [] };
  /** F09: the schematic room (primitives) and what it was drawn for. */
  private room: any[] = [];
  roomKey = '';
  private hiddenKey = '';

  constructor(private readonly viewer: any, private readonly src: WalkSources, private readonly changed: () => void) {
    this.C = (window as any).Cesium;
    this.guideSource = new this.C.CustomDataSource('walk-guides'); // its own collection: a page may hide its entities while walking
    void viewer.dataSources.add(this.guideSource);
    this.hud = document.createElement('div');
    this.hud.className = 'walk-hud';
    this.hud.hidden = true;
    viewer.container.append(this.hud);
    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    window.addEventListener('blur', () => this.held.clear());
    const canvas: HTMLCanvasElement = viewer.scene.canvas;
    const stop = (e: Event) => { if (this.active) { e.stopImmediatePropagation(); e.preventDefault(); } };
    canvas.addEventListener('pointerdown', (e) => { if (!this.active) return; stop(e); this.drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); }, true);
    canvas.addEventListener('pointermove', (e) => {
      if (!this.active) return;
      stop(e);
      if (!this.drag) return;
      this.state.heading += (e.clientX - this.drag.x) * 0.005;
      this.state.pitch = Math.max(-1.3, Math.min(1.3, this.state.pitch - (e.clientY - this.drag.y) * 0.005));
      this.drag = { x: e.clientX, y: e.clientY };
    }, true);
    canvas.addEventListener('pointerup', (e) => { if (!this.active) return; stop(e); this.drag = null; }, true);
    for (const type of ['wheel', 'mousedown', 'mousemove', 'mouseup', 'dblclick', 'contextmenu']) canvas.addEventListener(type, stop, true);
    viewer.scene.preUpdate.addEventListener(() => this.tick());
  }

  /** The next map click starts the walk there. */
  wait() {
    this.waiting = true;
    this.hud.hidden = false;
    this.hud.textContent = '1인칭: 지도에서 들어갈 곳을 누르세요 (Esc: 취소)';
    this.changed();
  }

  /** A map click: starts the walk where it hit when waiting; used up while walking. */
  handleClick(position: any): boolean {
    if (this.active) return true;
    if (!this.waiting) return false;
    const p = this.src.pickPoint(position);
    // on the ground as drawn there, not on the roof or wall that was hit (underground and indoor floors are entered from what 층 따로 보기 lifted)
    if (p) this.start(p.x, p.y, Math.min(p.z, this.src.groundAt(p.x, p.y)) + 0.3);
    return true;
  }

  /** Puts the eye WALK.eyeM above the surface at or just below (x, y, z), looking along the nearest road. */
  start(x: number, y: number, z: number, heading?: number) {
    const cam = this.viewer.camera, ctl = this.viewer.scene.screenSpaceCameraController;
    this.data = { roads: this.src.roads(), areas: this.src.areas(), solids: this.src.solids(), zones: this.src.zones() };
    if (!this.saved) {
      this.saved = { destination: cam.positionWC.clone(), heading: cam.heading, pitch: cam.pitch, roll: cam.roll, near: cam.frustum.near, inputs: ctl.enableInputs, checks: this.src.inputs.map((i) => i.checked) };
      this.drawGuides();
    }
    ctl.enableInputs = false;
    if (cam.frustum.near !== undefined) cam.frustum.near = 0.15;
    const feetM = feetHeight([...walkSurfaces(x, y, this.data), { z: this.src.groundAt(x, y) }], z);
    let along = heading;
    if (along === undefined) {
      let best: { d: number; dir: number[] } | null = null;
      for (const road of this.data.roads) {
        const h = roadHeightAt(road.geometry.coordinates, x, y);
        if (h && Math.abs(h.z - feetM) < 2 && h.distanceM < 12 && (!best || h.distanceM < best.d)) best = { d: h.distanceM, dir: h.direction };
      }
      along = best ? Math.atan2(best.dir[0], best.dir[1]) : cam.heading;
    }
    this.state = { x, y, feetM, heading: along ?? cam.heading, pitch: 0 };
    this.eyeM = feetM + WALK.eyeM;
    this.active = true;
    this.waiting = false;
    this.last = performance.now();
    this.hud.hidden = false;
    this.place();
    this.describe();
    this.changed();
  }

  /**
   * Underground or indoors (the feet well below the ground as drawn, or on a building's road) the page's aids go on:
   * the underground ways (`inputs`, `onWalk`). Outdoors they are as the user had them, so the
   * parking levels do not show through the field one is standing on.
   */
  private setInside(on: boolean) {
    if (on === this.inside || !this.saved) return;
    this.inside = on;
    this.src.inputs.forEach((input, i) => {
      const want = on || this.saved!.checks[i];
      if (input.checked !== want) { input.checked = want; input.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    this.src.onWalk?.(on);
  }

  /** Every road as a thin line that also shows through what is in front of it: underground and indoors there are no walls to see, the lines are what one walks along. */
  private drawGuides() {
    const C = this.C;
    for (const road of this.data.roads) {
      if (road.structure === 'elevator' || road.geometry.coordinates.length < 2) continue;
      const color = C.Color.fromCssColorString(road.structure === 'stairs' ? '#e07a1f' : road.roadClass === 'pedestrian' ? '#1d6fd6' : '#f4f4f5');
      const positions = road.geometry.coordinates.map((p) => { const g = tmInverse(p[0], p[1]); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, p[2] + 0.08); });
      this.guides.push(this.guideSource.entities.add({ polyline: { positions, width: 3, material: color, depthFailMaterial: color.withAlpha(0.55) } }));
    }
  }

  stop() {
    const was = this.active;
    this.active = false;
    this.waiting = false;
    this.held.clear();
    this.drag = null;
    this.hud.hidden = true;
    if (this.saved) {
      const cam = this.viewer.camera, s = this.saved;
      this.viewer.scene.screenSpaceCameraController.enableInputs = s.inputs;
      if (cam.frustum.near !== undefined) cam.frustum.near = s.near;
      this.setInside(false);
      this.clearRoom();
      this.hide([]);
      this.guideSource.entities.removeAll();
      this.guides = [];
      if (was) cam.setView({ destination: s.destination, orientation: { heading: s.heading, pitch: s.pitch, roll: s.roll } });
      this.saved = null;
    }
    this.changed();
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (!(this.active || this.waiting) || typing(e)) return;
    if (e.code === 'Escape') { if (down) { e.preventDefault(); e.stopImmediatePropagation(); this.stop(); } return; }
    if (!this.active) return;
    if (this.src.lockKeys) e.stopImmediatePropagation();
    // F09: on an elevator PageUp / PageDown steps to the next stop
    if ((e.code === 'PageUp' || e.code === 'PageDown') && !(e.ctrlKey || e.metaKey || e.altKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (down) this.rideElevator(e.code === 'PageUp' ? 1 : -1);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || !KEYS.has(e.code)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (down) this.held.add(e.code); else this.held.delete(e.code);
  }

  /** F09: on an elevator (within reach of its shaft, at one of its stops) the feet go to the next stop up (1) or down (-1). false: no elevator here or no further stop. */
  rideElevator(direction: 1 | -1): boolean {
    const s = this.state;
    const next = nextStop(elevatorStops(this.data.roads, s.x, s.y), s.feetM, direction);
    if (next === null) return false;
    s.feetM = next;
    this.eyeM = next + WALK.eyeM;
    this.place();
    this.describe();
    return true;
  }

  /** One step of the walk: `dt` seconds with the given keys held (also what tick() does every frame). */
  advance(dt: number, held: Set<string> = this.held) {
    const s = this.state;
    const on = (code: string) => Number(held.has(code));
    s.heading += (on('ArrowRight') + on('KeyE') - on('ArrowLeft') - on('KeyQ')) * 1.6 * dt;
    s.pitch = Math.max(-1.3, Math.min(1.3, s.pitch + (on('ArrowUp') - on('ArrowDown')) * 1.2 * dt));
    const forward = on('KeyW') - on('KeyS'), side = on('KeyD') - on('KeyA');
    const length = Math.hypot(forward, side);
    if (length) {
      const speed = (held.has('ShiftLeft') || held.has('ShiftRight') ? WALK.runMps : WALK.walkMps) * dt / length;
      const sin = Math.sin(s.heading), cos = Math.cos(s.heading);
      s.x += (sin * forward + cos * side) * speed;
      s.y += (cos * forward - sin * side) * speed;
      s.feetM = feetHeight([...walkSurfaces(s.x, s.y, this.data), { z: this.src.groundAt(s.x, s.y) }], s.feetM);
    }
    // the eye follows the feet smoothly (steps do not jolt)
    this.eyeM += (s.feetM + WALK.eyeM - this.eyeM) * Math.min(1, dt * 10);
  }

  private tick() {
    if (!this.active) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.advance(dt);
    this.place();
    if (now - this.lastHud > 300) { this.lastHud = now; this.describe(); }
  }

  private place() {
    const C = this.C, s = this.state;
    const g = tmInverse(s.x, s.y);
    this.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(g.longitude, g.latitude, this.eyeM), orientation: { heading: s.heading, pitch: s.pitch, roll: 0 } });
  }

  /** Where the walker is, in words: building and floor or the zone, the nearest road, the floor height. */
  where(): string {
    const s = this.state;
    let near: { road: LvRoad; d: number } | null = null;
    for (const road of this.data.roads) {
      const h = roadHeightAt(road.geometry.coordinates, s.x, s.y);
      if (h && Math.abs(h.z - s.feetM) < 1.5 && h.distanceM < 8 && (!near || h.distanceM < near.d)) near = { road, d: h.distanceM };
    }
    const parts: string[] = [];
    const road = near?.road;
    if (road?.buildingId) {
      const id = baseBuildingId(road.buildingId);
      const name = this.src.buildings().find((b) => b.buildingId === id)?.name ?? id;
      const floor = floorOfRoad(road);
      parts.push(`${name}${floor !== null ? ` ${floorText(floor)}` : ''}`);
    } else {
      const below = s.feetM < this.src.groundAt(s.x, s.y) - 1.5; // an underground zone is only meant when the feet are under the ground as drawn
      const zone = zoneAt(this.data.zones, s.x, s.y, below ? s.feetM : undefined);
      const under = zone?.layer === 'ground' && below;
      if (zone) parts.push(under ? `${zone.name} 아래` : zone.name);
    }
    if (road?.name) parts.push(shortName(road.name, 30));
    parts.push(`바닥 ${s.feetM.toFixed(1)} m`);
    return parts.join(' · ');
  }

  private describe() {
    const s = this.state;
    const below = s.feetM < this.src.groundAt(s.x, s.y) - 1.5;
    const indoor = this.data.roads.find((r) => { if (!r.buildingId) return false; const h = roadHeightAt(r.geometry.coordinates, s.x, s.y); return !!h && h.distanceM < 3 && Math.abs(h.z - s.feetM) < 1; }) ?? null;
    this.setInside(below || !!indoor);
    this.updateRoom(below, indoor);
    this.hud.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = this.where();
    const stops = elevatorStops(this.data.roads, s.x, s.y);
    const lift = stops.length > 1 ? ` · 승강기: PageUp/PageDown 층 이동(정류 ${stops.map((z) => z.toFixed(1)).join(' · ')} m)` : '';
    const hint = document.createElement('span');
    hint.textContent = `${lift} — W/S 앞뒤 · A/D 옆 · 끌기·화살표·Q/E 둘러보기 · Shift 달리기 · Esc 나가기 (눈높이 1.6 m, 벽 충돌 없음${this.room.length ? ', 벽·천장은 층 외곽·실내 구조(추정)로 그린 약식' : ''})`;
    this.hud.append(b, hint);
  }

  private clearRoom() {
    for (const p of this.room) this.viewer.scene.primitives.remove(p);
    this.room = [];
    this.roomKey = '';
  }

  /** F09: the schematic room for where the walker is (roomDrawing), drawn again only when the storey, the floor or the neighbourhood changes. */
  private updateRoom(below: boolean, indoor: LvRoad | null) {
    const s = this.state;
    const zone = below ? this.data.zones.find((z) => z.layer === 'underground' && z.floorM !== undefined && Math.abs(z.floorM - s.feetM) < 1.2 && inPolygons(z.polygons, s.x, s.y)) ?? null : null;
    const cell = `${Math.round(s.x / (ROOM.reachM / 2))}:${Math.round(s.y / (ROOM.reachM / 2))}`;
    const key = zone ? `zone:${zone.id}:${cell}` : indoor ? `floor:${baseBuildingId(indoor.buildingId!)}:${Math.round(s.feetM)}:${cell}` : below ? `under:${Math.round(s.feetM)}` : '';
    if (key === this.roomKey) return;
    this.clearRoom();
    this.roomKey = key;
    this.hide(buildingsToHide(this.src.buildings(), { feetM: s.feetM, indoorId: indoor ? baseBuildingId(indoor.buildingId!) : null, below }));
    if (!key) return;
    const C = this.C;
    const { mesh, lines } = roomDrawing({ x: s.x, y: s.y, feetM: s.feetM, zone, indoor, roads: this.data.roads, buildings: this.src.buildings(), interiors: this.src.interiors?.() ?? [] });
    const pos = (p: number[]) => { const g = tmInverse(p[0], p[1]); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, p[2]); };
    const edges = new C.PolylineCollection();
    // 선마다 재질을 따로 만든다: 하나를 함께 쓰면 걷기를 끝낼 때 같은 재질이 두 번 파괴된다
    const edgeColor = C.Color.fromCssColorString(ROOM.edge).withAlpha(0.85);
    for (const line of lines) edges.add({ positions: line.points.map(pos), width: line.width, material: C.Material.fromType('Color', { color: edgeColor }) });
    for (const p of [mesh.primitive(C, pos), edges.length ? edges : null]) if (p) this.room.push(this.viewer.scene.primitives.add(p));
  }

  /** The buildings left out while walking (told to the page only when the set changes). */
  private hide(ids: string[]) {
    const key = ids.join('|');
    if (key === this.hiddenKey) return;
    this.hiddenKey = key;
    this.src.hideBuildings?.(ids);
  }
}

/** Triangles with a colour per vertex for one Cesium primitive (the schematic room). */
export class RoomMesh {
  readonly points: number[][] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  private rgba(css: string, alpha: number) { return [parseInt(css.slice(1, 3), 16), parseInt(css.slice(3, 5), 16), parseInt(css.slice(5, 7), 16), Math.round(alpha * 255)]; }
  quad(a: number[], b: number[], c: number[], d: number[], css: string, alpha = 1) {
    const at = this.points.length, color = this.rgba(css, alpha);
    this.points.push(a, b, c, d);
    for (let k = 0; k < 4; k++) this.colors.push(...color);
    this.indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
  }
  /** A level polygon (outer ring and holes) at a height. */
  fill(polygon: number[][][], z: number, css: string, alpha = 1) {
    const at = this.points.length, color = this.rgba(css, alpha);
    const { points, indices } = fillPolygons([polygon]);
    for (const p of points) { this.points.push([p[0], p[1], z]); this.colors.push(...color); }
    for (const k of indices) this.indices.push(at + k);
  }
  primitive(C: any, pos: (p: number[]) => any) {
    if (!this.points.length) return null;
    const values = new Float64Array(this.points.length * 3);
    this.points.forEach((p, i) => { const c = pos(p); values.set([c.x, c.y, c.z], i * 3); });
    return new C.Primitive({
      geometryInstances: new C.GeometryInstance({ geometry: new C.Geometry({
        attributes: {
          position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }),
          color: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: new Uint8Array(this.colors) }),
        } as any,
        indices: new Uint32Array(this.indices), primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: C.BoundingSphere.fromVertices(values as any),
      }) }),
      appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false, closed: false }), asynchronous: false, allowPicking: false,
    });
  }
}
