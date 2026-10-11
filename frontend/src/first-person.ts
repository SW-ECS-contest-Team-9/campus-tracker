// "1인칭" (F08): walking through the model at eye height, on a Cesium viewer (preview and editor; started by
// level-view-layer.ts mountSpaceViews). Enter where the map is clicked, or at what "층 따로 보기" had lifted.
//   W/S forward / back, A/D sideways, mouse drag or arrow keys or Q/E to look, Shift to run, Esc to leave.
// The eye is WALK.eyeM above the surface under the feet, and that surface is chosen by level-view.ts feetHeight():
// the highest walkable surface at or below the feet (+ a step), stairs and ramps followed along their road. So an
// underground level or an indoor floor is walked at its own height and the walker never jumps to a roof or the field.
// There is no collision with walls. Nothing of the data is touched; the camera is put back on leaving.
import type { SceneBuilding } from './api';
import { WALK, baseBuildingId, feetHeight, floorOfRoad, floorText, roadHeightAt, shortName, walkSurfaces, zoneAt, type LvArea, type LvRoad, type Zone } from './level-view';
import type { Solid } from './structures';
import { tmInverse } from './tm';

export type WalkSources = {
  roads: () => LvRoad[]; areas: () => LvArea[]; solids: () => Solid[]; zones: () => Zone[]; buildings: () => SceneBuilding[];
  groundAt: (x: number, y: number) => number;
  /** The plan point and height under a screen position. */
  pickPoint: (position: any) => { x: number; y: number; z: number } | null;
  lockKeys?: boolean;
  /** Checkboxes switched on while walking (underground ways, see-through buildings) and put back afterwards. */
  inputs: HTMLInputElement[];
  onWalk?: (on: boolean) => void;
};

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
    if (p) this.start(p.x, p.y, p.z + 0.3);
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
   * the underground ways and see-through buildings (`inputs`, `onWalk`). Outdoors they are as the user had them, so the
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
    if (e.ctrlKey || e.metaKey || e.altKey || !KEYS.has(e.code)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (down) this.held.add(e.code); else this.held.delete(e.code);
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
    this.setInside(s.feetM < this.src.groundAt(s.x, s.y) - 1.5 || this.data.roads.some((r) => { if (!r.buildingId) return false; const h = roadHeightAt(r.geometry.coordinates, s.x, s.y); return !!h && h.distanceM < 3 && Math.abs(h.z - s.feetM) < 1; }));
    this.hud.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = this.where();
    const hint = document.createElement('span');
    hint.textContent = ' — W/S 앞뒤 · A/D 옆 · 끌기·화살표·Q/E 둘러보기 · Shift 달리기 · Esc 나가기 (눈높이 1.6 m, 벽 충돌 없음)';
    this.hud.append(b, hint);
  }
}
