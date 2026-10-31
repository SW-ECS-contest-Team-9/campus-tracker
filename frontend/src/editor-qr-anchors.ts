import QRCode from 'qrcode';
import { placementAt, type MapBuilding } from './beacon-map';

type XYZ = [number, number, number];
type Anchor = { id: string; label: string; buildingId: string; floor: string | null; coordinate: XYZ; revision: number };
type Context = { viewer: any; C: any; point: (p: XYZ) => any; cursor: () => XYZ; buildings: () => MapBuilding[];
  request: <T>(path: string, init?: RequestInit) => Promise<T>; focus: (p: XYZ) => void;
  say: (text: string, kind?: 'hint' | 'warning' | 'error' | 'success') => void; start: () => boolean };
const API = '/api/v1/editor/qr-anchors';
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Independent QR anchors, not routing nodes: moving one never moves or disconnects a road. */
export class QrAnchorEditor {
  private root = document.createElement('section');
  private anchors: Anchor[] = [];
  private selected: Anchor | null = null;
  private editing = false;
  private busy = false;
  private entities: any[] = [];
  get active() { return this.editing; }
  close() { this.editing = false; this.selected = null; this.render(); }
  constructor(private ctx: Context) {
    this.root.className = 'editor-section';
    this.root.innerHTML = `<h2>QR 기준점</h2><div class="editor-hint">지도 커서를 기준점 위치로 옮긴 후 추가하세요. 도로 노드와 별도로 관리됩니다.</div>
      <label class="inline-check"><input data-show type="checkbox" checked> 지도에 QR 기준점 표시</label>
      <div class="feature-actions"><button data-new>새 기준점</button><button data-reload>새로고침</button></div>
      <div data-form hidden>
        <label class="editor-field">이름<input data-field="label" maxlength="200"></label>
        <div class="editor-row"><label class="editor-field">건물 ID<input data-field="buildingId" maxlength="24" placeholder="outdoor"></label><label class="editor-field">층<input data-field="floor" maxlength="4" placeholder="1F / B1"></label></div>
        <div class="editor-row"><label class="editor-field">X (EPSG:5186)<input data-field="x" type="number" step="0.01"></label><label class="editor-field">Y (EPSG:5186)<input data-field="y" type="number" step="0.01"></label></div>
        <label class="editor-field">Z 바닥 높이 (해발 m)<input data-field="z" type="number" step="0.01"></label>
        <div class="feature-actions"><button data-place>커서 위치로 지정</button><button data-save>저장</button><button data-cancel>닫기</button></div>
        <div class="feature-actions"><button data-code>QR 보기·인쇄</button><button data-delete>삭제</button></div>
        <div class="editor-hint" data-message></div>
      </div><div class="feature-list" data-list></div>`;
    document.querySelector('.editor-tools')!.append(this.root);
    this.el<HTMLButtonElement>('new').onclick = () => { if (!this.ctx.start()) return; this.editing = true; this.selected = null; this.fill({ label: '', buildingId: 'outdoor', floor: null, coordinate: this.ctx.cursor() }); this.place(); this.render(); };
    this.el<HTMLButtonElement>('reload').onclick = () => void this.load();
    this.el<HTMLButtonElement>('place').onclick = () => this.place();
    this.el<HTMLButtonElement>('save').onclick = () => void this.save();
    this.el<HTMLButtonElement>('cancel').onclick = () => this.close();
    this.el<HTMLButtonElement>('delete').onclick = () => void this.remove();
    this.el<HTMLButtonElement>('code').onclick = () => void this.print();
    this.el<HTMLInputElement>('show').onchange = () => this.draw();
  }
  private el<T extends HTMLElement>(key: string): T { return this.root.querySelector<T>(`[data-${key}]`)!; }
  private field(key: string) { return this.root.querySelector<HTMLInputElement>(`[data-field="${key}"]`)!; }
  private fill(a: Pick<Anchor, 'label' | 'buildingId' | 'floor' | 'coordinate'>) {
    this.field('label').value = a.label; this.field('buildingId').value = a.buildingId; this.field('floor').value = a.floor ?? '';
    ['x', 'y', 'z'].forEach((k, i) => { this.field(k).value = String(a.coordinate[i]); });
  }
  private place() {
    const p = this.ctx.cursor(), where = placementAt(p, this.ctx.buildings());
    ['x', 'y', 'z'].forEach((k, i) => { this.field(k).value = String(Math.round(p[i] * 100) / 100); });
    this.field('buildingId').value = where.buildingId ?? 'outdoor'; this.field('floor').value = where.floor ?? '';
  }
  async load() {
    try { this.anchors = (await this.ctx.request<{ anchors: Anchor[] }>(API)).anchors; this.render(); }
    catch (e) { this.ctx.say(`QR 기준점을 불러오지 못했습니다: ${(e as Error).message}`, 'warning'); }
  }
  pick(id: string) {
    const a = this.anchors.find((n) => `editor:qr:${n.id}` === id);
    if (!a || !this.ctx.start()) return false;
    this.editing = true; this.selected = a; this.fill(a); this.ctx.focus(a.coordinate); this.render(); return true;
  }
  private async save() {
    if (this.busy) return;
    const label = this.field('label').value.trim(), buildingId = this.field('buildingId').value.trim();
    const floor = this.field('floor').value.trim().toUpperCase() || null;
    const raw = ['x', 'y', 'z'].map((k) => this.field(k).value);
    const coordinate = raw.map(Number);
    if (!label || !buildingId || raw.some((v) => !v.trim()) || coordinate.some((v) => !Number.isFinite(v)) ||
        (floor !== null && !/^(B[1-9]|[1-9][0-9]?F)$/.test(floor)) || (buildingId !== 'outdoor' && !floor)) {
      this.el('message').textContent = '이름, 건물, 유효한 좌표를 입력하고 실내 기준점은 층을 지정하세요.'; return;
    }
    this.busy = true;
    try {
      const old = this.selected;
      const saved = await this.ctx.request<Anchor>(old ? `${API}/${old.id}` : API, { method: old ? 'PUT' : 'POST',
        body: JSON.stringify({ label, buildingId, floor, coordinate, ...(old ? { expectedRevision: old.revision } : {}) }) });
      this.selected = saved; this.fill(saved); await this.load(); this.ctx.say('QR 기준점을 저장했습니다.', 'success');
    } catch (e) { this.el('message').textContent = `저장 실패: ${(e as Error).message} 다른 곳에서 바뀌었다면 새로고침 후 다시 선택하세요.`; }
    finally { this.busy = false; }
  }
  private async remove() {
    const a = this.selected;
    if (!a || this.busy || !confirm(`“${a.label}” QR 기준점을 삭제할까요? 기존 기록은 저장 당시 좌표를 유지하며, 인쇄한 QR은 사용할 수 없습니다.`)) return;
    this.busy = true;
    try { await this.ctx.request(`${API}/${a.id}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: a.revision }) });
      this.selected = null; this.editing = false; await this.load(); this.ctx.say('QR 기준점을 삭제했습니다.', 'success');
    } catch (e) { this.el('message').textContent = `삭제 실패: ${(e as Error).message} 다른 곳에서 바뀌었다면 새로고침 후 다시 선택하세요.`; }
    finally { this.busy = false; }
  }
  private async print() {
    const a = this.selected; if (!a) return;
    const w = window.open('', '_blank');
    if (!w) { this.el('message').textContent = 'QR 인쇄 창을 열 수 없습니다. 팝업을 허용해 주세요.'; return; }
    try {
      const src = await QRCode.toDataURL(`campustracker:node:${a.id}`, { width: 512, margin: 4, errorCorrectionLevel: 'M' });
      w.document.write(`<!doctype html><html lang="ko"><head><title>QR 기준점</title></head><body style="text-align:center;font:18px sans-serif"><h1>${esc(a.label)}</h1><p>${esc(a.buildingId)} ${esc(a.floor)}</p><img alt="QR 기준점" src="${src}" style="width:80mm;height:80mm"><p>이 QR을 지정된 기준점 위치에 부착하세요.</p><button onclick="window.print()">인쇄</button></body></html>`); w.document.close();
    } catch { w.close(); this.el('message').textContent = 'QR 코드를 만들지 못했습니다.'; }
  }
  private render() {
    this.el('form').hidden = !this.editing;
    this.el<HTMLButtonElement>('code').disabled = !this.selected;
    this.el<HTMLButtonElement>('delete').disabled = !this.selected;
    this.el('message').textContent = this.selected ? '위치 변경은 이 QR을 사용하는 기록의 재처리 결과에도 반영됩니다.' : '';
    const list = this.el('list'); list.innerHTML = this.anchors.map((a) => `<button type="button" data-id="${esc(a.id)}">${esc(a.label)} · ${esc(a.buildingId)} ${esc(a.floor)}</button>`).join('');
    list.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.onclick = () => { this.pick(`editor:qr:${b.dataset.id}`); });
    this.draw();
  }
  private draw() {
    for (const e of this.entities) this.ctx.viewer.entities.remove(e);
    this.entities = [];
    if (!this.el<HTMLInputElement>('show').checked) return;
    const C = this.ctx.C;
    for (const a of this.anchors) this.entities.push(this.ctx.viewer.entities.add({ id: `editor:qr:${a.id}`, position: this.ctx.point(a.coordinate),
      point: { pixelSize: 12, color: C.Color.fromCssColorString('#9c27b0'), outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: `QR · ${a.label}`, font: '14px sans-serif', fillColor: C.Color.WHITE, showBackground: true, pixelOffset: new C.Cartesian2(0, -22), disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
  }
}
