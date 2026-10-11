// The name tags and the legend of the cross-section (F09), drawn as HTML over the map canvas so that they can be laid
// out on screen: no tag covers another, each height is named once in a column at the right edge with a leader line to
// where it is on the cut face, and the legend and the reading options (view-style.ts) sit in a small panel.
// section-layer.ts gives the tags in face coordinates (distance along the cut, height); the layout is label-layout.ts.
import './section.css';
import { declutter, levelText, mergeLevels, spread, textWidth, type Box, type LevelItem } from './label-layout';
import { LABELS, VIEW_COLORS, bindViewStyleControls, viewStyle, viewStyleControls } from './view-style';

/** A tag on the cut face. `world`: where it points (Cartesian3). */
export type FaceTag =
  /** A number of the height scale, at the left end of the cut. */
  | { kind: 'tick'; world: any; text: string }
  /** The name of something that is cut (a building above its roof, a void in its middle). `low`: its foot; when the anchor is above the top of the screen and the foot is not, the name sits at the top edge. */
  | { kind: 'title'; world: any; text: string; priority: number; sub?: string; low?: any }
  /** A floor of a cut building, at the end of its floor line. */
  | { kind: 'floor'; world: any; text: string; priority: number }
  /**
   * Something at a height: merged into one tag per height in the column at the right edge. `rank`: 'major' (an area, an
   * underground space) always names its height; 'way' (a road, a passage) names it when no major thing does; 'minor'
   * (a platform top, a deck, a cover) is shown only at density "전체", where every name is listed.
   */
  | { kind: 'level'; world: any; z: number; d: number; name: string; priority: number; rank: 'major' | 'way' | 'minor' };

export type LegendEntry = { color: string; label: string; shape?: 'line' | 'thick' | 'box' | 'dash' | 'fill' };

const FONT = 12, TAG_H = 17;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class SectionOverlay {
  private readonly root: HTMLElement;
  private readonly tagsEl: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly panel: HTMLElement;
  private tags: FaceTag[] = [];
  private lastView = '';
  private dirty = true;
  /** Laid-out boxes of the last pass (tests and scripted checks read them). */
  placed: (Box & { text: string; kind: string })[] = [];

  constructor(private readonly viewer: any, private readonly options: { onOverlayToggle?: (show: boolean) => void; overlayToggleLabel?: string }) {
    this.root = document.createElement('div');
    this.root.className = 'section-overlay';
    this.root.hidden = true;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.tagsEl = document.createElement('div');
    this.panel = document.createElement('div');
    this.panel.className = 'section-panel';
    this.root.append(this.svg, this.tagsEl);
    viewer.container.append(this.root, this.panel);
    this.panel.hidden = true;
    bindViewStyleControls(this.panel);
    this.panel.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.overlay !== undefined) this.options.onOverlayToggle?.(el.checked);
    });
    viewer.scene.postRender.addEventListener(() => this.layout());
  }

  /** The tags of a new cut and its legend; `title` heads the panel. */
  show(tags: FaceTag[], legend: LegendEntry[], title: string, overlaysShown: boolean) {
    this.tags = tags;
    this.dirty = true;
    this.root.hidden = false;
    this.panel.hidden = false;
    const swatch = (e: LegendEntry) => `<span><i class="${e.shape ?? 'line'}" style="--c:${e.color}"></i>${esc(e.label)}</span>`;
    const open = this.panel.querySelector('details')?.open ?? true; // folded stays folded across redraws
    this.panel.innerHTML = `<details${open ? ' open' : ''}><summary><b>${esc(title)}</b> · 범례·보기 설정</summary>
      <div class="section-style">${viewStyleControls()}</div>
      <div class="section-legend">${legend.map(swatch).join('')}</div>
      ${this.options.overlayToggleLabel ? `<label class="section-check"><input type="checkbox" data-overlay ${overlaysShown ? 'checked' : ''}> ${esc(this.options.overlayToggleLabel)}</label>` : ''}
      <div class="section-hint">자른 면은 또렷하게, 뒤쪽은 '나머지' 설정대로. 오른쪽 줄 = 높이마다 이름표 하나(지시선).</div></details>`;
  }

  hide() {
    this.tags = [];
    this.placed = [];
    this.root.hidden = true;
    this.panel.hidden = true;
    this.tagsEl.innerHTML = '';
    this.svg.innerHTML = '';
  }

  /** Lays the tags out again when the camera moved (checked after every frame; cheap when nothing changed). */
  private layout() {
    if (this.root.hidden) return;
    const C = (window as any).Cesium, scene = this.viewer.scene, cam = this.viewer.camera;
    const canvas: HTMLCanvasElement = scene.canvas;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const view = [cam.positionWC.x, cam.positionWC.y, cam.positionWC.z, cam.directionWC.x, cam.directionWC.y, cam.directionWC.z, cam.frustum.width ?? cam.frustum.fov, W, H].map((v) => (v as number).toFixed(3)).join(',');
    if (!this.dirty && view === this.lastView) return;
    this.dirty = false;
    this.lastView = view;
    const toWindow = C.SceneTransforms.worldToWindowCoordinates ?? C.SceneTransforms.wgs84ToWindowCoordinates;
    const at = (world: any): { x: number; y: number } | null => { const w = toWindow(scene, world); return w && Number.isFinite(w.x) && Number.isFinite(w.y) ? { x: w.x, y: w.y } : null; };
    const inView = (p: { x: number; y: number }) => p.x >= -2 && p.x <= W + 2 && p.y >= -2 && p.y <= H + 2;
    const show = LABELS[viewStyle().labels];
    const out: { box: Box; text: string; kind: string; cls: string; leader?: { x: number; y: number } }[] = [];
    const taken: Box[] = [];
    const size = (text: string, bold = false) => ({ w: textWidth(text, FONT) + (bold ? 14 : 10), h: TAG_H });

    // 1. the height scale: always, at its place
    for (const tag of this.tags) {
      if (tag.kind !== 'tick') continue;
      const p = at(tag.world);
      if (!p || !inView(p)) continue;
      const s = size(tag.text);
      const box = { x: Math.max(2, p.x + 3), y: p.y - s.h, ...s };
      taken.push(box);
      out.push({ box, text: tag.text, kind: 'tick', cls: 'tick' });
    }

    // 2. one tag per height, in a column at the right edge, each with a leader to the nearest thing of that height
    if (show.floor) {
      type Seen = LevelItem & { p: { x: number; y: number }; rank: 'major' | 'way' | 'minor' };
      const seen: Seen[] = [];
      for (const tag of this.tags) {
        if (tag.kind !== 'level') continue;
        const p = at(tag.world);
        if (p && inView(p) && (show.road || tag.rank !== 'minor')) seen.push({ z: tag.z, d: tag.d, name: tag.name, priority: tag.priority, p, rank: tag.rank });
      }
      const levels = mergeLevels(seen).map((level) => {
        const items = level.items as Seen[];
        // at "주요" a height is named by its areas and spaces, else by one way; at "전체" by everything there
        const major = items.filter((i) => i.name && i.rank === 'major');
        const named = show.road ? items.filter((i) => i.name) : major.length ? major : items.filter((i) => i.name).slice(0, 1);
        const names = [...new Set(named.map((i) => i.name))];
        const shownItems = show.road || !major.length ? items : major;
        const anchor = shownItems.reduce((a, b) => (b.p.x > a.p.x ? b : a)).p;
        const text = levelText({ z: level.z, names }, show.road ? 3 : 2);
        return { text, anchor, ...size(text) };
      });
      const ys = spread(levels.map((l) => l.anchor.y - TAG_H / 2), TAG_H, 4, H - 4, 3);
      levels.forEach((level, i) => {
        const box = { x: W - 8 - level.w, y: ys[i], w: level.w, h: level.h };
        taken.push(box);
        out.push({ box, text: level.text, kind: 'level', cls: 'level', leader: level.anchor });
      });
    }

    // 3. names and floors where they are, the more important first; one that would cover another is left out
    const free = this.tags.flatMap((tag) => {
      if ((tag.kind !== 'title' && tag.kind !== 'floor') || !show[tag.kind]) return [];
      const p = at(tag.world);
      if (!p) return [];
      // a building taller than the view: its name at the top edge, as long as its foot is in the view
      if (tag.kind === 'title' && tag.low && p.y < 24) { const q = at(tag.low); if (q && q.y > 60) p.y = 24; }
      if (!inView(p)) return [];
      const text = tag.kind === 'title' && tag.sub && show.road ? `${tag.text} ${tag.sub}` : tag.text;
      const s = size(text, tag.kind === 'title');
      const box = tag.kind === 'title' ? { x: p.x - s.w / 2, y: p.y - s.h - 3, ...s } : { x: p.x + 4, y: p.y - s.h - 1, ...s };
      return [{ ...box, text, kind: tag.kind, priority: tag.priority }];
    });
    const blocked = free.map((f) => taken.some((t) => f.x < t.x + t.w + 3 && t.x < f.x + f.w + 3 && f.y < t.y + t.h + 2 && t.y < f.y + f.h + 2));
    const candidates = free.filter((_, i) => !blocked[i]);
    const kept = declutter(candidates, 3);
    candidates.forEach((f, i) => { if (kept[i]) out.push({ box: f, text: f.text, kind: f.kind, cls: f.kind }); });

    this.placed = out.map((o) => ({ ...o.box, text: o.text, kind: o.kind }));
    this.tagsEl.innerHTML = out.map((o) => `<span class="section-tag ${o.cls}" style="left:${o.box.x.toFixed(1)}px;top:${o.box.y.toFixed(1)}px;width:${o.box.w}px">${esc(o.text)}</span>`).join('');
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = out.filter((o) => o.leader).map((o) => {
      const y = o.box.y + o.box.h / 2;
      return `<polyline points="${o.leader!.x.toFixed(1)},${o.leader!.y.toFixed(1)} ${(o.box.x - 14).toFixed(1)},${y.toFixed(1)} ${(o.box.x - 2).toFixed(1)},${y.toFixed(1)}" /><circle cx="${o.leader!.x.toFixed(1)}" cy="${o.leader!.y.toFixed(1)}" r="3" />`;
    }).join('');
    this.svg.style.setProperty('--leader', VIEW_COLORS.leader);
  }
}
