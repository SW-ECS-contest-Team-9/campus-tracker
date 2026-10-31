// Beacons on the editor's 3D map (docs/BEACON_POSITIONING.md §5.5): every registered beacon at its anchor, the beacons the
// apps heard but nobody registered at the fused position where the signal was strongest, and placing one at the cursor.
// Uses the same admin API as /beacons.html and the apps (POSITIONING_ADMIN_COLLECTORS); other accounts see a read-only layer.
import { buildCreateRequest, buildEditRequest, emptyForm, formFromBeacon, type AdminBeacon, type BeaconForm } from './beacon-scan';
import { formAtCursor, formPoint, placementAt, type MapBuilding } from './beacon-map';
import { tmForward } from './tm';

type XYZ = [number, number, number];
type Discovered = { uuid: string; major: number; minor: number; observations: number; maxRssiDbm: number; measuredPowerDbm: number | null;
  lastSeenAt: string; suggestedPosition: { latitude: number; longitude: number; horizontalUncertaintyM: number | null; floor: string | null; buildingId: string | null } | null };
type Selection = { kind: 'registered'; beacon: AdminBeacon } | { kind: 'discovered'; found: Discovered } | { kind: 'new' };
type Context = {
  viewer: any; C: any; point: (p: XYZ) => any; cursor: () => XYZ; setCursor: (p: XYZ) => void;
  terrain: (x: number, y: number) => number | null;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  say: (text: string, kind?: 'hint' | 'warning' | 'error' | 'success') => void;
  /** the 3D map's buildings in the cursor's frame (footprint, floor table) */
  buildings: () => MapBuilding[];
  /** move the camera to look at a point */
  focus: (p: XYZ) => void;
  /** other drafts are put away first; false = the user kept them */
  start: () => boolean;
};

const ADMIN = '/api/v1/positioning/admin';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const keyOf = (uuid: string, major: number, minor: number) => `${uuid.toLowerCase()}:${major}:${minor}`;
const nameOf = (b: { label?: string | null; major: number; minor: number }) => b.label || `${b.major} / ${b.minor}`;
const FIELDS: (keyof BeaconForm)[] = ['uuid', 'major', 'minor', 'measuredPowerDbm', 'label', 'buildingId', 'floor', 'floorHeightM', 'x', 'y', 'z', 'horizontalAccuracyM'];

export class BeaconMapper {
  private access: 'checking' | 'admin' | 'readonly' | 'offline' = 'checking';
  private beacons: AdminBeacon[] = [];
  private discovered: Discovered[] = [];
  private selected: Selection | null = null;
  private form: BeaconForm = emptyForm();
  private errors: Partial<Record<keyof BeaconForm, string>> = {};
  /** the beacon follows the cursor (click / WASD / R·F) */
  private following = false;
  private busy = false;
  private entities: any[] = [];
  private root: HTMLElement;

  constructor(private ctx: Context) {
    this.root = document.createElement('section');
    this.root.className = 'editor-section';
    this.root.innerHTML = `<h2>비콘 배치</h2>
      <label class="inline-check"><input data-opt="show" type="checkbox" checked> 지도에 비콘 표시</label>
      <label class="inline-check"><input data-opt="found" type="checkbox" checked> 미등록(앱이 들은) 비콘 표시</label>
      <div class="feature-actions"><button data-action="new">새 비콘</button><button data-action="refresh">새로고침</button></div>
      <div class="editor-hint" data-info></div>
      <div data-form hidden>
        <div class="editor-hint" data-title></div>
        <label class="editor-field">UUID<input data-field="uuid" maxlength="40" placeholder="E2C56DB5-DFFB-48D2-B060-D0F5A71096E0"></label>
        <div class="editor-row"><label class="editor-field">Major<input data-field="major" inputmode="numeric"></label><label class="editor-field">Minor<input data-field="minor" inputmode="numeric"></label></div>
        <div class="editor-row"><label class="editor-field">이름<input data-field="label" maxlength="200"></label><label class="editor-field">1 m 세기(dBm)<input data-field="measuredPowerDbm" inputmode="numeric" placeholder="기본값"></label></div>
        <div class="editor-row"><label class="editor-field">커서보다 위(m)<input data-opt="above" type="number" step="0.1" value="0"></label>
          <label class="inline-check"><input data-opt="follow" type="checkbox"> 커서 따라가기</label></div>
        <div class="feature-actions"><button data-action="place">커서 위치에 놓기 (Space)</button><button data-action="goto">비콘으로 커서 이동</button></div>
        <div class="editor-row"><label class="editor-field">X<input data-field="x" type="number" step="0.01"></label><label class="editor-field">Y<input data-field="y" type="number" step="0.01"></label></div>
        <div class="editor-row"><label class="editor-field">Z 정표고(설치 높이)<input data-field="z" type="number" step="0.01"></label><label class="editor-field">정확도(m)<input data-field="horizontalAccuracyM" type="number" step="0.1" placeholder="1"></label></div>
        <div class="editor-row"><label class="editor-field">건물 ID<input data-field="buildingId" maxlength="64" placeholder="outdoor"></label><label class="editor-field">층<input data-field="floor" maxlength="4" placeholder="3F / B1"></label></div>
        <label class="editor-field">층 바닥 높이(해발 m)<input data-field="floorHeightM" type="number" step="0.01"></label>
        <div class="editor-hint" data-errors></div>
        <div class="feature-actions"><button data-action="save">저장 (Enter)</button><button data-action="unplace">위치 해제</button><button data-action="cancel">닫기 (Esc)</button></div>
        <div class="feature-actions" data-manage><button data-action="enable"></button><button data-action="delete">영구 삭제</button></div>
      </div>
      <div class="feature-list" data-list></div>`;
    document.querySelector('.editor-tools')!.append(this.root);
    this.button('new').onclick = () => this.select({ kind: 'new' });
    this.button('refresh').onclick = () => void this.load();
    this.button('place').onclick = () => this.placeAtCursor();
    this.button('goto').onclick = () => { const p = formPoint(this.readForm()); if (p) this.ctx.focus(p); };
    this.button('save').onclick = () => void this.save();
    this.button('unplace').onclick = () => { this.readForm(); this.form = { ...this.form, buildingId: '', floor: '', floorHeightM: '', x: '', y: '', z: '', latitude: '', longitude: '', horizontalAccuracyM: '' }; this.following = false; this.render(); };
    this.button('cancel').onclick = () => this.close();
    this.button('enable').onclick = () => void this.setEnabled();
    this.button('delete').onclick = () => void this.remove();
    this.opt('show').onchange = () => this.draw();
    this.opt('found').onchange = () => this.render();
    this.opt('follow').onchange = () => { this.following = this.opt('follow').checked; if (this.following) this.placeAtCursor(); };
    this.opt('above').oninput = () => { if (this.following) this.placeAtCursor(); };
    for (const k of FIELDS) this.field(k).oninput = () => { this.readForm(); this.draw(); };
  }

  /** A beacon is open in the panel (keys go here). */
  get active() { return this.selected !== null; }
  private field(k: keyof BeaconForm) { return this.root.querySelector<HTMLInputElement>(`[data-field="${k}"]`)!; }
  private opt(k: string) { return this.root.querySelector<HTMLInputElement>(`[data-opt="${k}"]`)!; }
  private button(k: string) { return this.root.querySelector<HTMLButtonElement>(`[data-action="${k}"]`)!; }
  private readForm() {
    for (const k of FIELDS) (this.form as unknown as Record<string, string>)[k] = this.field(k).value;
    return this.form;
  }

  async load() {
    try {
      await this.ctx.request(`${ADMIN}/me`);
      this.access = 'admin';
    } catch {
      this.access = 'readonly';
    }
    try {
      if (this.access === 'admin') {
        const [list, found] = await Promise.all([
          this.ctx.request<{ beacons: AdminBeacon[] }>(`${ADMIN}/beacons?includeDisabled=true`),
          this.ctx.request<{ discovered: Discovered[] }>(`${ADMIN}/discovered?sinceHours=720&limit=200`).catch(() => ({ discovered: [] })),
        ]);
        this.beacons = list.beacons;
        this.discovered = found.discovered;
      } else {
        // read-only: the apps' config (enabled beacons with a position)
        const config = await this.ctx.request<{ beacons: (Omit<AdminBeacon, 'enabled' | 'label'>)[] }>('/api/v1/positioning/beacon-config');
        this.beacons = config.beacons.map((b) => ({ ...b, enabled: true, label: null }));
        this.discovered = [];
      }
    } catch (err) {
      this.access = 'offline';
      this.ctx.say(`비콘을 불러오지 못했습니다: ${(err as Error).message}`, 'warning');
    }
    // the open beacon follows the server (changed or deleted elsewhere)
    const sel = this.selected;
    if (sel?.kind === 'registered') {
      const now = this.beacons.find((b) => b.beaconId === sel.beacon.beaconId);
      if (!now) this.close();
      else this.selected = { kind: 'registered', beacon: now };
    }
    this.render();
  }

  /** A map pick on one of this layer's entities (id editor:beacon:… / editor:beacon-found:…). */
  pick(id: string): boolean {
    const reg = /^editor:beacon:(.+)$/.exec(id);
    if (reg) { const b = this.beacons.find((it) => it.beaconId === reg[1]); if (b) this.select({ kind: 'registered', beacon: b }); return true; }
    const found = /^editor:beacon-found:(.+)$/.exec(id);
    if (found) { const d = this.discovered.find((it) => keyOf(it.uuid, it.major, it.minor) === found[1]); if (d) this.select({ kind: 'discovered', found: d }); return true; }
    return false;
  }

  /** The editor cursor moved: a following beacon goes with it. */
  cursorMoved() { if (this.following && this.selected) this.placeAtCursor(); }

  handleKey(e: KeyboardEvent) {
    if (!this.active || this.access !== 'admin') return false;
    if (!['Space', 'Enter', 'NumpadEnter', 'Escape'].includes(e.code)) return false;
    e.preventDefault();
    if (e.repeat || this.busy) return true;
    if (e.code === 'Space') this.placeAtCursor();
    else if (e.code === 'Escape') this.close();
    else void this.save();
    return true;
  }

  private select(sel: Selection) {
    if (this.access === 'admin' && !this.ctx.start()) return;
    this.selected = sel;
    this.errors = {};
    this.following = false;
    if (sel.kind === 'registered') this.form = formFromBeacon(sel.beacon);
    else if (sel.kind === 'new') this.form = emptyForm();
    else {
      const d = sel.found, s = d.suggestedPosition;
      this.form = { ...emptyForm(), uuid: d.uuid.toUpperCase(), major: String(d.major), minor: String(d.minor),
        measuredPowerDbm: d.measuredPowerDbm === null ? '' : String(d.measuredPowerDbm) };
      if (s) {
        // the phone's fused position when the signal was strongest: a starting point, a few metres off; height unknown
        const g = tmForward(s.latitude, s.longitude);
        const ground = this.ctx.terrain(g.x, g.y) ?? this.ctx.cursor()[2];
        this.form = { ...formAtCursor(this.form, [g.x, g.y, ground], 0, placementAt([g.x, g.y, ground], this.ctx.buildings())),
          ...(s.buildingId ? { buildingId: s.buildingId } : {}), ...(s.floor ? { floor: s.floor } : {}),
          horizontalAccuracyM: s.horizontalUncertaintyM ? String(Math.min(100, Math.max(1, Math.round(s.horizontalUncertaintyM)))) : '' };
      }
    }
    const p = formPoint(this.form);
    if (p) this.ctx.focus(p);
    this.render();
    this.ctx.say(this.access !== 'admin' ? '이 계정은 비콘을 볼 수만 있습니다(POSITIONING_ADMIN_COLLECTORS).'
      : '커서를 설치 위치로 옮기고 Space(커서 위치에 놓기) → Enter(저장). 바닥에 커서를 두고 "커서보다 위"에 설치 높이를 넣으면 편합니다.');
  }

  close() {
    this.selected = null;
    this.following = false;
    this.errors = {};
    this.render();
  }

  private placeAtCursor() {
    if (!this.selected) return;
    const cursor = this.ctx.cursor();
    const above = Number(this.opt('above').value) || 0;
    this.form = formAtCursor(this.readForm(), cursor, above, placementAt([cursor[0], cursor[1], cursor[2] + above], this.ctx.buildings()));
    this.render();
  }

  private async save() {
    const sel = this.selected;
    if (!sel || this.busy || this.access !== 'admin') return;
    const f = this.readForm();
    const r = sel.kind === 'registered' ? buildEditRequest(f) : buildCreateRequest(f);
    if ('errors' in r) { this.errors = r.errors; this.render(); this.ctx.say('입력을 확인하세요.', 'warning'); return; }
    this.busy = true; this.render();
    try {
      const saved = sel.kind === 'registered'
        ? await this.ctx.request<AdminBeacon>(`${ADMIN}/beacons/${sel.beacon.beaconId}`, { method: 'PATCH', body: JSON.stringify(r.body) })
        : await this.ctx.request<AdminBeacon>(`${ADMIN}/beacons`, { method: 'POST', body: JSON.stringify(r.body) });
      this.ctx.say(`${sel.kind === 'registered' ? '저장' : '등록'}했습니다: ${nameOf(saved)}`, 'success');
      this.selected = { kind: 'registered', beacon: saved };
      this.form = formFromBeacon(saved);
      this.following = false;
      await this.load();
    } catch (err) {
      this.ctx.say((err as Error).message, 'error');
    } finally { this.busy = false; this.render(); }
  }

  private async setEnabled() {
    const sel = this.selected;
    if (sel?.kind !== 'registered' || this.busy) return;
    this.busy = true;
    try {
      const saved = await this.ctx.request<AdminBeacon>(`${ADMIN}/beacons/${sel.beacon.beaconId}`, { method: 'PATCH', body: JSON.stringify({ enabled: !sel.beacon.enabled }) });
      this.selected = { kind: 'registered', beacon: saved };
      this.ctx.say(saved.enabled ? '다시 사용합니다.' : '사용 중지했습니다(기록은 남습니다).', 'success');
      await this.load();
    } catch (err) { this.ctx.say((err as Error).message, 'error'); } finally { this.busy = false; this.render(); }
  }

  private async remove() {
    const sel = this.selected;
    if (sel?.kind !== 'registered' || this.busy) return;
    if (!confirm(`비콘 “${nameOf(sel.beacon)}”을 영구 삭제할까요? 그동안 모은 관측은 미등록으로 남습니다.`)) return;
    this.busy = true;
    try {
      await this.ctx.request(`${ADMIN}/beacons/${sel.beacon.beaconId}?permanent=true`, { method: 'DELETE' });
      this.ctx.say(`삭제했습니다: ${nameOf(sel.beacon)}`, 'success');
      this.close();
      await this.load();
    } catch (err) { this.ctx.say((err as Error).message, 'error'); } finally { this.busy = false; this.render(); }
  }

  private render() {
    const sel = this.selected, admin = this.access === 'admin';
    const form = this.root.querySelector<HTMLElement>('[data-form]')!;
    form.hidden = !sel;
    if (sel) {
      for (const k of FIELDS) {
        const input = this.field(k);
        if (document.activeElement !== input) input.value = this.form[k];
        input.disabled = !admin || this.busy || (sel.kind !== 'new' && (k === 'uuid' || k === 'major' || k === 'minor'));
        input.classList.toggle('invalid', !!this.errors[k]);
      }
      this.opt('follow').checked = this.following;
      const title = sel.kind === 'registered' ? `수정: ${esc(nameOf(sel.beacon))}${sel.beacon.enabled ? '' : ' (사용 중지됨)'} · UUID·Major·Minor는 바꿀 수 없습니다`
        : sel.kind === 'discovered' ? `미등록 비콘 등록: 앱이 ${sel.found.observations}번 들음(최대 ${sel.found.maxRssiDbm} dBm). 위치는 신호가 가장 셀 때 폰의 위치(수 m 오차)로 채웠습니다`
        : '새 비콘: UUID·Major·Minor를 넣고 위치를 정하세요';
      this.root.querySelector('[data-title]')!.innerHTML = title;
      this.root.querySelector('[data-errors]')!.textContent = Object.entries(this.errors).map(([k, v]) => `${k}: ${v}`).join(' · ');
      (this.root.querySelector('[data-manage]') as HTMLElement).hidden = sel.kind !== 'registered' || !admin;
      if (sel.kind === 'registered') this.button('enable').textContent = sel.beacon.enabled ? '사용 중지' : '다시 사용';
      for (const k of ['place', 'save', 'unplace', 'enable', 'delete']) this.button(k).disabled = !admin || this.busy;
      this.button('goto').disabled = !formPoint(this.form);
    }
    this.button('new').disabled = this.access !== 'admin';
    const unplaced = this.beacons.filter((b) => !b.anchor).length;
    this.root.querySelector('[data-info]')!.textContent = ({
      checking: '불러오는 중…',
      admin: `등록 ${this.beacons.length}개(위치 없음 ${unplaced}) · 미등록 ${this.discovered.length}개. 지도에서 비콘을 누르거나 목록에서 고르세요.`,
      readonly: `등록 ${this.beacons.length}개(사용 중인 것만). 이 계정은 보기만 가능합니다(POSITIONING_ADMIN_COLLECTORS).`,
      offline: '비콘 정보를 불러오지 못했습니다.',
    } as const)[this.access];
    const rows = [
      ...this.beacons.map((b) => ({ id: `editor:beacon:${b.beaconId}`, color: !b.enabled ? '#9aa39d' : b.anchor ? '#1f6feb' : '#d29922',
        text: `${nameOf(b)} · ${b.anchor ? `${b.anchor.buildingId} ${b.anchor.floor ?? ''}`.trim() : '위치 없음'}${b.enabled ? '' : ' · 중지'}`,
        on: sel?.kind === 'registered' && sel.beacon.beaconId === b.beaconId })),
      ...(this.opt('found').checked ? this.discovered.map((d) => ({ id: `editor:beacon-found:${keyOf(d.uuid, d.major, d.minor)}`, color: '#e8590c',
        text: `미등록 ${d.major} / ${d.minor} · ${d.maxRssiDbm} dBm · ${d.suggestedPosition ? '위치 제안' : '위치 없음'}`,
        on: sel?.kind === 'discovered' && keyOf(sel.found.uuid, sel.found.major, sel.found.minor) === keyOf(d.uuid, d.major, d.minor) })) : []),
    ];
    this.root.querySelector('[data-list]')!.innerHTML = rows.map((r) =>
      `<button class="feature-item${r.on ? ' selected' : ''}" data-pick="${esc(r.id)}"><span class="swatch" style="background:${r.color}"></span>${esc(r.text)}</button>`).join('')
      || '<span class="editor-hint">비콘이 없습니다.</span>';
    this.root.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => b.onclick = () => this.pick(b.dataset.pick!));
    this.draw();
  }

  /** The layer: a point per placed beacon on a stem from the ground, the open one where the form puts it now. */
  private draw() {
    const { viewer, C, point } = this.ctx;
    for (const e of this.entities) viewer.entities.remove(e);
    this.entities = [];
    if (!this.opt('show').checked) return;
    const add = (e: any) => this.entities.push(viewer.entities.add(e));
    const put = (id: string, p: XYZ, css: string, text: string, size: number, dashed: boolean) => {
      const color = C.Color.fromCssColorString(css);
      const foot = this.ctx.terrain(p[0], p[1]);
      if (foot !== null && Math.abs(p[2] - foot) > 0.2) {
        add({ id: `${id}:stem`, polyline: { positions: [point([p[0], p[1], foot]), point(p)], width: 1.5, arcType: C.ArcType.NONE,
          material: dashed ? new C.PolylineDashMaterialProperty({ color }) : color.withAlpha(0.7) } });
      }
      add({ id, position: point(p), point: { pixelSize: size, color, outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text, font: '12px system-ui', fillColor: C.Color.WHITE, showBackground: true, backgroundColor: color.withAlpha(0.85),
          pixelOffset: new C.Cartesian2(0, -18), disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 600) } });
    };
    const sel = this.selected;
    for (const b of this.beacons) {
      if (!b.anchor || (sel?.kind === 'registered' && sel.beacon.beaconId === b.beaconId)) continue;
      const { x, y, z } = b.anchor.position;
      put(`editor:beacon:${b.beaconId}`, [x, y, z], b.enabled ? '#1f6feb' : '#9aa39d', `${nameOf(b)}${b.anchor.floor ? ` · ${b.anchor.floor}` : ''}`, 11, false);
    }
    if (this.opt('found').checked) {
      for (const d of this.discovered) {
        const s = d.suggestedPosition;
        if (!s || (sel?.kind === 'discovered' && keyOf(sel.found.uuid, sel.found.major, sel.found.minor) === keyOf(d.uuid, d.major, d.minor))) continue;
        const g = tmForward(s.latitude, s.longitude);
        const ground = this.ctx.terrain(g.x, g.y) ?? this.ctx.cursor()[2]; // height unknown: near the ground
        put(`editor:beacon-found:${keyOf(d.uuid, d.major, d.minor)}`, [g.x, g.y, ground + 1.5], '#e8590c', `? ${d.major} / ${d.minor}`, 9, true);
      }
    }
    if (sel) {
      const p = formPoint(this.form);
      const before = sel.kind === 'registered' && sel.beacon.anchor ? sel.beacon.anchor.position : null;
      if (p && before && Math.hypot(p[0] - before.x, p[1] - before.y, p[2] - before.z) > 0.01) {
        add({ polyline: { positions: [point([before.x, before.y, before.z]), point(p)], width: 2, arcType: C.ArcType.NONE,
          material: new C.PolylineDashMaterialProperty({ color: C.Color.YELLOW }) } });
        add({ position: point([before.x, before.y, before.z]), point: { pixelSize: 7, color: C.Color.YELLOW.withAlpha(0.5), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      }
      if (p) {
        const name = sel.kind === 'registered' ? nameOf(sel.beacon) : this.form.label || `${this.form.major || '?'} / ${this.form.minor || '?'}`;
        put('editor:beacon-draft', p, '#f2c200', `${name} · Z ${p[2].toFixed(2)}${this.form.floor ? ` · ${this.form.floor}` : ''}`, 15, false);
      }
    }
  }
}
