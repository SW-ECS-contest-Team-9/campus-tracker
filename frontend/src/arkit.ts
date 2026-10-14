import { tmInverse } from './tm';
import type { Viewer } from './vworld';

export interface ArPose { sequence:number; timestamp:number; frameTimestamp:number; x:number; y:number; z:number; trackingState:'normal'|'limited'|'notAvailable' }
export interface ArPoseEvent { sessionId:string; arSessionId:string; pose:ArPose; receivedAt:string }
interface MapPoint { timestamp:number; e:number; n:number; h:number|null; source:string }
interface ArSession { arSessionId:string; poseCount:number; lastPose:ArPose; lastReceivedAt:string; generatedAt:string|null;
  result: { poseCount:number; alignment:{status:string;reason:string;rms:number|null;verticalRms:number|null}; aligned:MapPoint[][]; corrected:MapPoint[][] }|null }
interface Entry { sessionId:string; summary:ArSession; cursor:number; poses:Map<number,ArPose>; entities:any[] }
const color = (state:string) => state==='normal'?'#22d3ee':state==='limited'?'#fbbf24':'#94a3b8';

export class ArkitPreview {
  private entries = new Map<string,Entry>();
  private visible = new Set<string>();
  private loading = new Map<string,Promise<void>>();
  private removed = new Set<string>();
  private arkit = true;
  private corrected = true;
  private dirty = true;
  private lastRender = 0;
  private viewer:Viewer|null = null;
  constructor(private panel:HTMLElement, private apiBase = '') {
    const controls = document.createElement('div');
    for (const [title, key] of [['ARKit 경로','arkit'],['보정 경로','corrected']] as const) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type='checkbox'; input.checked=true; input.dataset.arkitLayer=key;
      input.onchange=()=> { this[key]=input.checked; this.dirty=true; this.lastRender=0; this.applyMapVisibility(); };
      label.append(input,document.createTextNode(title)); controls.append(label);
    }
    panel.append(controls,document.createElement('div'));
  }
  setViewer(viewer:Viewer) { this.viewer=viewer; for(const entry of this.entries.values()) this.drawMap(entry); }
  setVisible(ids:Set<string>) { this.visible=ids; this.dirty=true; this.lastRender=0; this.applyMapVisibility(); }
  remove(sessionId:string) { this.removed.add(sessionId); for(const [key,e] of this.entries) if(e.sessionId===sessionId) { this.clearMap(e); this.entries.delete(key); } this.dirty=true; }
  async load(sessionId:string) {
    if(this.removed.has(sessionId)) return;
    const active=this.loading.get(sessionId); if(active) return active;
    const promise=this.fetchSession(sessionId).catch(err=>console.warn('ARKit preview:',err)).finally(()=>this.loading.delete(sessionId));
    this.loading.set(sessionId,promise); return promise;
  }
  private async get(path:string) { const res=await fetch(`${this.apiBase}/api/v1/sessions/${path}`); if(!res.ok) throw new Error(`ARKit HTTP ${res.status}`); return res.json(); }
  private async fetchSession(sessionId:string) {
    const response:{sessions:ArSession[]}=await this.get(`${sessionId}/arkit`);
    if(this.removed.has(sessionId)) return;
    for(const summary of response.sessions) {
      const key=`${sessionId}/${summary.arSessionId}`;
      let entry=this.entries.get(key);
      if(!entry) { entry={sessionId,summary,cursor:0,poses:new Map(),entities:[]}; this.entries.set(key,entry); }
      // Raw local viewer is a documented 15 minute window. REST pagination retains access to all raw data.
      let next:number|null=entry.cursor;
      do {
        const raw:{poses:(ArPose & {id?:number})[];nextAfterId?:number|null}=await this.get(`${sessionId}/arkit/${summary.arSessionId}/poses?from=${Math.max(0,summary.lastPose.timestamp-900000)}&limit=10000&afterId=${next}`);
        if(this.removed.has(sessionId)) return;
        for(const p of raw.poses) { entry.poses.set(p.sequence,p); entry.cursor=Math.max(entry.cursor,p.id??0); }
        next=raw.nextAfterId??null;
      } while(next!=null);
      const live=entry.summary;
      entry.summary={...summary,poseCount:Math.max(summary.poseCount,entry.poses.size)};
      if(live.lastPose.timestamp>summary.lastPose.timestamp) entry.summary.lastPose=live.lastPose;
      if(live.lastReceivedAt>summary.lastReceivedAt) entry.summary.lastReceivedAt=live.lastReceivedAt;
      this.trim(entry); this.drawMap(entry);
    }
    this.dirty=true; this.lastRender=0;
  }
  pose(event:ArPoseEvent) {
    if(this.removed.has(event.sessionId)) return;
    const key=`${event.sessionId}/${event.arSessionId}`;
    let e=this.entries.get(key);
    if(!e) { e={sessionId:event.sessionId,summary:{arSessionId:event.arSessionId,poseCount:0,lastPose:event.pose,lastReceivedAt:event.receivedAt,generatedAt:null,result:null},cursor:0,poses:new Map(),entities:[]}; this.entries.set(key,e); void this.load(event.sessionId); }
    if(!e.poses.has(event.pose.sequence)) { e.poses.set(event.pose.sequence,event.pose); e.summary.poseCount++; }
    if(event.pose.timestamp>=e.summary.lastPose.timestamp) e.summary.lastPose=event.pose;
    if(event.receivedAt>e.summary.lastReceivedAt) e.summary.lastReceivedAt=event.receivedAt;
    this.trim(e); this.dirty=true;
  }
  private trim(e:Entry) { const cutoff=e.summary.lastPose.timestamp-900000; for(const [seq,p] of e.poses) if(p.timestamp<cutoff) e.poses.delete(seq); }
  private clearMap(e:Entry) { for(const entity of e.entities) this.viewer?.entities.remove(entity); e.entities=[]; }
  private drawMap(e:Entry) {
    this.clearMap(e);
    if(!this.viewer || e.summary.result?.alignment.status!=='aligned') return;
    const C=(window as any).Cesium;
    for(const [kind,segments] of [['arkit',e.summary.result.aligned],['corrected',e.summary.result.corrected]] as const) {
      for(const points of segments) {
        if(points.length<2) continue;
        const drawn=points.length<=2000?points:Array.from({length:2000},(_,i)=>points[Math.round(i*(points.length-1)/1999)]);
        const positions=drawn.map(p=> { const wgs=tmInverse(p.e,p.n); return C.Cartesian3.fromDegrees(wgs.longitude,wgs.latitude,p.h??0); });
        const uncertain=points.some(p=>p.source==='limited');
        const entity=this.viewer.entities.add({polyline:{positions,width:kind==='arkit'?3:5,clampToGround:points.some(p=>p.h==null),
          material:C.Color.fromCssColorString(kind==='corrected'?'#e879f9':uncertain?'#fbbf24':'#22d3ee')}});
        entity.arkitKind=kind; e.entities.push(entity);
      }
    }
    this.applyMapVisibility();
  }
  private applyMapVisibility() { for(const e of this.entries.values()) for(const entity of e.entities) entity.show=this.visible.has(e.sessionId)&&(entity.arkitKind==='arkit'?this.arkit:this.corrected); }
  render(connected:boolean) {
    if(!this.dirty || Date.now()-this.lastRender<1000) return; this.dirty=false; this.lastRender=Date.now();
    const content=this.panel.lastElementChild!; content.replaceChildren();
    const entries=[...this.entries.values()].filter(e=>this.visible.has(e.sessionId));
    if(!entries.length) { content.textContent='표시 중인 세션의 ARKit 데이터 없음'; return; }
    for(const e of entries) {
      const s=e.summary, block=document.createElement('div'), status=document.createElement('p');
      const recent=Date.now()-Date.parse(s.lastReceivedAt)<5000;
      const alignment=s.result?.alignment;
      status.textContent=`${e.sessionId.slice(0,8)} / AR ${s.arSessionId}\n연결 ${connected&&recent?'수신 중':'최근 수신 없음'} · ${s.lastPose.trackingState} · ${s.poseCount} poses\n최근 수신 ${new Date(s.lastReceivedAt).toLocaleTimeString()} · 측정 ${new Date(s.lastPose.timestamp).toLocaleTimeString()}\n정합 ${alignment?.status??'pending'} · RMS ${alignment?.rms?.toFixed(2)??'—'} m\n${alignment?.reason??'정합 대기'}\n결과 ${s.generatedAt?new Date(s.generatedAt).toLocaleTimeString():'—'} (${s.result?.poseCount??0} poses) · 보정 ${s.result?.corrected.some(s=>s.length>1)?'생성됨':'보류'}\n카메라 로컬 좌표 · 최근 15분 · 청록 normal / 황색 limited / 회색 notAvailable`;
      status.style.whiteSpace='pre-line'; status.style.overflowWrap='anywhere'; block.append(status);
      const points=[...e.poses.values()].sort((a,b)=>a.timestamp-b.timestamp||a.sequence-b.sequence);
      if(this.arkit) for(const vertical of [false,true]) {
        const canvas=document.createElement('canvas'); canvas.width=280; canvas.height=130; canvas.style.width='100%'; canvas.setAttribute('aria-label',vertical?'ARKit 로컬 X/Y 수직 궤적':'ARKit 로컬 X/Z 수평 궤적'); block.append(canvas);
        const ctx=canvas.getContext('2d'); if(!ctx||!points.length) continue;
        ctx.fillStyle='#0f172a';ctx.fillRect(0,0,280,130);ctx.fillStyle='#cbd5e1';ctx.font='11px sans-serif';ctx.fillText(vertical?'X / Y (up), meters':'X / −Z, meters (local)',8,14);
        let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
        for(const p of points) { const y=vertical?p.y:-p.z; minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,y);maxY=Math.max(maxY,y); }
        const scale=Math.min(250/Math.max(1,maxX-minX),90/Math.max(1,maxY-minY));
        for(let i=1;i<points.length;i++) { const a=points[i-1],b=points[i]; if(b.timestamp-a.timestamp>1000||b.frameTimestamp<=a.frameTimestamp) continue;ctx.strokeStyle=color(b.trackingState);ctx.beginPath();ctx.moveTo(15+(a.x-minX)*scale,115-((vertical?a.y:-a.z)-minY)*scale);ctx.lineTo(15+(b.x-minX)*scale,115-((vertical?b.y:-b.z)-minY)*scale);ctx.stroke(); }
        ctx.fillStyle='#cbd5e1';ctx.fillText(`X ${(maxX-minX).toFixed(1)}m / ${vertical?'Y':'Z'} ${(maxY-minY).toFixed(1)}m`,8,127);
      }
      content.append(block);
    }
  }
  tick() { this.dirty=true; }
}
