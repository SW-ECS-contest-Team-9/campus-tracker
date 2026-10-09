type XY = [number, number];
type XYZ = [number, number, number];
type Area = { id: number; name: string; kind: string; elevationM: number | null; buildingId: string | null;
  floor: string | null; note: string | null; revision: string; areaM2: number; geometry: { coordinates: XY[][] } };
type Context = { viewer: any; C: any; point: (p: XYZ) => any; cursor: () => XYZ;
  terrain: (x: number, y: number) => number | null;
  request: <T>(path: string, init?: RequestInit) => Promise<T>; start: () => boolean; say: (text: string) => void };
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

/** Area boundaries are independent of routing centerlines. Existing paths are never removed automatically. */
export class AreaEditor {
  private areas: Area[] = [];
  private vertices: XY[] | null = null;
  private holes: XY[][] = [];
  private selected: Area | null = null;
  private entities: any[] = [];
  private busy = false;
  private root: HTMLElement;
  constructor(private ctx: Context) {
    this.root = document.createElement('section');
    this.root.className = 'editor-section';
    this.root.innerHTML = `<h2>공간 영역</h2><div class="feature-actions"><button data-action="new">공간 그리기</button><button data-action="refresh">새로고침</button></div>
      <div data-form hidden>
      <label class="editor-field">이름<input data-field="name" maxlength="160"></label>
      <label class="editor-field">유형<select data-field="kind"><option value="lobby">로비·계단 앞 공간</option><option value="plaza">광장</option><option value="courtyard">중정</option><option value="parking">주차장</option><option value="other">기타</option></select></label>
      <label class="editor-field">바닥 고도(m)<input data-field="elevationM" type="number" step="0.01" min="-100" max="2000"></label>
      <label class="editor-field">건물 ID<input data-field="buildingId" maxlength="80"></label>
      <label class="editor-field">층 ID<input data-field="floor" maxlength="80"></label>
      <label class="editor-field">설명<textarea data-field="note" maxlength="2000"></textarea></label>
      <div class="feature-actions"><button data-action="add">커서 점 추가</button><button data-action="undo">마지막 점 취소</button><button data-action="redraw">경계 다시 그리기</button></div>
      <div class="feature-actions"><button data-action="save">공간 저장</button><button data-action="cancel">취소</button></div></div>
      <div class="editor-hint" data-info>공간은 경로와 별개인 면입니다. 클릭으로 커서를 옮기고 Space로 경계점을 추가하세요.</div>
      <div class="feature-list" data-list></div>`;
    document.querySelector('.editor-tools')!.append(this.root);
    this.button('new').onclick = () => {
      if (this.active && !confirm('작성 중인 공간을 취소하고 새로 그릴까요?')) return;
      if (!this.ctx.start()) return;
      this.selected = null; this.vertices = []; this.holes = [];
      for (const key of ['name','buildingId','floor','note']) this.field(key).value = '';
      this.field('kind').value = 'lobby'; this.field('elevationM').value = String(this.ctx.cursor()[2]);
      this.form.hidden = false; this.render(); this.ctx.viewer.scene.canvas.focus();
    };
    this.button('refresh').onclick = () => void this.load().catch(this.error);
    this.button('add').onclick = () => this.add();
    this.button('undo').onclick = () => { this.vertices?.pop(); this.render(); };
    this.button('redraw').onclick = () => {
      if (this.holes.length && !confirm('경계를 다시 그리면 기존 중정·구멍도 제거됩니다. 다시 그릴까요?')) return;
      this.vertices = []; this.holes = []; this.render();
    };
    this.button('cancel').onclick = () => this.cancel();
    this.button('save').onclick = () => void this.save().catch(this.error);
    this.field('elevationM').oninput = () => this.render();
  }
  get active() { return this.vertices !== null; }
  private get form() { return this.root.querySelector<HTMLElement>('[data-form]')!; }
  private field(key: string) { return this.root.querySelector<HTMLInputElement>(`[data-field="${key}"]`)!; }
  private button(key: string) { return this.root.querySelector<HTMLButtonElement>(`[data-action="${key}"]`)!; }
  private error = (err: unknown) => this.ctx.say(err instanceof Error ? err.message : String(err));
  cancel() { if (this.busy) return; this.vertices = null; this.holes = []; this.selected = null; this.form.hidden = true; this.render(); }
  add() {
    if (!this.vertices || this.busy) return;
    const [x,y] = this.ctx.cursor();
    const last = this.vertices.at(-1);
    if (last && Math.hypot(x-last[0],y-last[1]) < 0.05) return;
    this.vertices.push([x,y]); this.render();
  }
  handleKey(e: KeyboardEvent) {
    if (!this.active) return false;
    if (!['Space','Backspace','Escape','Enter','NumpadEnter'].includes(e.code) && !(e.ctrlKey && e.code === 'KeyS')) return false;
    e.preventDefault();
    if (e.repeat || this.busy) return true;
    if (e.code === 'Space') this.add();
    else if (e.code === 'Backspace') { this.vertices!.pop(); this.render(); }
    else if (e.code === 'Escape') { if (confirm('공간 초안을 취소할까요?')) this.cancel(); }
    else void this.save().catch(this.error);
    return true;
  }
  async load() {
    this.areas = await this.ctx.request<Area[]>('/api/v1/editor/areas');
    this.render();
  }
  private edit(area: Area) {
    if (this.busy || this.active && !confirm('작성 중인 공간을 취소할까요?')) return;
    if (!this.ctx.start()) return;
    this.selected = area;
    this.vertices = area.geometry.coordinates[0].slice(0,-1).map(p => [...p] as XY);
    this.holes = area.geometry.coordinates.slice(1).map(ring => ring.slice(0,-1).map(p => [...p] as XY));
    for (const key of ['name','kind','buildingId','floor','note']) this.field(key).value = String(area[key as keyof Area] ?? '');
    this.field('elevationM').value = String(area.elevationM ?? this.ctx.terrain(...this.vertices[0]) ?? this.ctx.cursor()[2]);
    this.form.hidden = false; this.render();
    this.ctx.say('공간의 정보·고도를 수정하거나 경계를 다시 그린 뒤 저장하세요.');
  }
  private async save() {
    if (!this.vertices || this.busy) return;
    if (this.vertices.length < 3) throw new Error('공간 경계점은 최소 3개가 필요합니다.');
    const elevationM = Number(this.field('elevationM').value);
    if (!this.field('elevationM').value || !Number.isFinite(elevationM)) throw new Error('바닥 고도를 입력하세요.');
    const body = {name:this.field('name').value.trim(),kind:this.field('kind').value,elevationM,
      buildingId:this.field('buildingId').value || null,floor:this.field('floor').value || null,
      note:this.field('note').value || null,coordinates:this.vertices,holes:this.holes,expectedRevision:this.selected?.revision};
    if (!body.name) throw new Error('공간 이름을 입력하세요.');
    this.busy = true; this.render();
    try {
      await this.ctx.request(`/api/v1/editor/areas${this.selected ? `/${this.selected.id}` : ''}`, {
        method:this.selected?'PUT':'POST',body:JSON.stringify(body)});
      this.busy = false; this.cancel();
      this.ctx.say('공간을 저장했습니다. 기존 도로는 유지됩니다.');
      await this.load();
    } finally { this.busy = false; this.render(); }
  }
  private async remove(area: Area) {
    if (this.busy || !confirm(`공간 “${area.name}”을 삭제할까요? 기존 경로는 유지됩니다.`)) return;
    this.busy = true;
    try {
      await this.ctx.request(`/api/v1/editor/areas/${area.id}`, {method:'DELETE',body:JSON.stringify({expectedRevision:area.revision})});
      if (this.selected?.id === area.id) { this.busy = false; this.cancel(); }
      await this.load();
    } finally { this.busy = false; this.render(); }
  }
  private render() {
    for (const e of this.entities) this.ctx.viewer.entities.remove(e);
    this.entities = [];
    const {C,viewer,point} = this.ctx;
    const draw = (vertices: XY[], height: number | null, draft: boolean, name: string, holes: XY[][] = []) => {
      const color = draft ? C.Color.YELLOW : C.Color.fromCssColorString('#29a7bb');
      const positions = vertices.map(([x,y])=>point([x,y,height ?? this.ctx.terrain(x,y) ?? 0]));
      const holePositions = holes.map(ring => ring.map(([x,y])=>point([x,y,height ?? this.ctx.terrain(x,y) ?? 0])));
      if (positions.length >= 3) this.entities.push(viewer.entities.add({polygon:{hierarchy:new C.PolygonHierarchy(positions,holePositions.map(p=>new C.PolygonHierarchy(p))),perPositionHeight:true,material:color.withAlpha(0.25),arcType:C.ArcType.NONE}}));
      for (const p of holePositions) this.entities.push(viewer.entities.add({polyline:{positions:[...p,p[0]],width:3,material:color,depthFailMaterial:color,arcType:C.ArcType.NONE}}));
      if (positions.length >= 2) this.entities.push(viewer.entities.add({polyline:{positions:[...positions,...(positions.length>=3?[positions[0]]:[])],width:3,material:color,arcType:C.ArcType.NONE}}));
      if (positions.length) this.entities.push(viewer.entities.add({position:positions[0],label:{text:name,font:'12px system-ui',fillColor:color,showBackground:true,disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
      if (draft) for (const position of positions) this.entities.push(viewer.entities.add({position,point:{pixelSize:8,color,disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    };
    for (const area of this.areas) if (area.id !== this.selected?.id) draw(area.geometry.coordinates[0].slice(0,-1),area.elevationM,false,area.name,area.geometry.coordinates.slice(1).map(r=>r.slice(0,-1)));
    const height = Number(this.field('elevationM').value);
    if (this.vertices && Number.isFinite(height)) draw(this.vertices,height,true,this.field('name').value || '공간 초안',this.holes);
    this.root.querySelector('[data-info]')!.textContent = this.active ? `경계점 ${this.vertices!.length}개 · 같은 바닥 고도의 닫힌 면 · Space 추가 / Enter 저장` : '공간은 경로와 별개인 면입니다. 기존 도로는 자동 정리·연결되지 않습니다.';
    this.root.querySelector('[data-list]')!.innerHTML = this.areas.map(a=>`<div class="feature-actions"><button data-edit="${a.id}">${escape(a.name)} · ${Math.round(a.areaM2)}㎡ · ${escape(a.floor ?? '')}</button><button data-remove="${a.id}">삭제</button></div>`).join('') || '<span class="editor-hint">저장된 공간이 없습니다.</span>';
    this.root.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach(b=>b.onclick=()=>this.edit(this.areas.find(a=>a.id===Number(b.dataset.edit))!));
    this.root.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b=>b.onclick=()=>void this.remove(this.areas.find(a=>a.id===Number(b.dataset.remove))!).catch(this.error));
    this.root.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=this.busy);
  }
}
