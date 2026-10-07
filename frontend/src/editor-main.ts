import './editor.css';
import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL } from './api';
import { initCampusMap } from './campus-map';
import { tmForward, tmInverse } from './tm';
import type { TerrainGrid } from './api';

type XYZ = [number, number, number];
type RoadClass = 'pedestrian' | 'vehicle' | 'shared';
type ObjectType = 'road' | 'place';
type Road = {
  id: string; name: string | null; roadClass: RoadClass; structure: string; pedestrianAccess: string; vehicleAccess: string;
  pedestrianDirection: string; vehicleDirection: string; widthM: number | null; wheelchairAccess: string;
  buildingId: string | null; levelId: string | null; status: string; revision: number;
  geometry: { coordinates: XYZ[] };
};
type Place = { id: string; parentId: string | null; name: string; category: string; description: string | null; buildingId: string | null; levelId: string | null; status: string; revision: number; geometry: { coordinates: XYZ } };
type Lease = { objectType: ObjectType; objectId: string; ownerCode: string; sessionId: string; leaseToken: string; expiresAt: string };
type Draft = { id: string; coordinates: XYZ[]; leaseToken: string; expectedRevision: number | null; attrs: Record<string, unknown>; objectType: ObjectType;
  branchFrom?: { roadId: string; vertexIndex: number } };
type RunPoint = { seq: number; x: number; y: number; h: number | null; zRel: number | null; source: string; t: number };
type SnapMode = 'XY' | 'Z' | 'XYZ';
type SnapTarget = { source: 'fusion' | 'road'; point: XYZ; label: string };
type JunctionPreview = { coordinate: XYZ; levelId: string | null; alreadyConnected: boolean;
  roads: { id: string; revision: number; name: string | null; roadClass: RoadClass; distanceM: number; heightM: number; status: string }[] };

// Most lookups are form controls (.value/.disabled); HTMLInputElement also covers the plain-element members used here.
const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
// crypto.randomUUID exists only in secure contexts (https or localhost); over plain http on a LAN/Tailscale
// address build the v4 UUID from getRandomValues, which is available everywhere.
const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const COLORS: Record<string, string> = { pedestrian: '#0b8f70', vehicle: '#dc6a24', shared: '#7856b7', place: '#cc3f64', junction: '#192c25' };
const ORIGIN = { x: 201100, y: 557250 };
const DEVICE_KEY = 'campus.editor.deviceId';
const TOKEN_KEY = 'campus.editor.accessToken';
const USER_KEY = 'campus.editor.collectorId';
const EDITOR_SESSION = sessionStorage.getItem('campus.editor.sessionId') || uuid();
sessionStorage.setItem('campus.editor.sessionId', EDITOR_SESSION);

const root = $('editor-root');
root.innerHTML = `
  <div class="editor-app">
    <header class="editor-header">
      <a class="editor-brand" href="/" title="캠퍼스 Preview로 돌아가기">Campus Network Editor</a>
      <span id="editor-tool-label" class="editor-status">선택 도구</span>
      <span class="editor-status">WASD 이동 · Q/E 회전 · Space 꼭지점 · R/F 높이</span>
      <span class="spacer"></span><span id="editor-user" class="editor-status"></span>
      <span id="editor-connection" class="editor-status offline">연결 중…</span>
      <label class="inline-check" title="AI 에이전트가 요청하면 카메라를 그 위치로 이동합니다"><input id="editor-ai-follow" type="checkbox"> AI 화면 안내</label>
      <button id="editor-follow" type="button" title="카메라 따라가기">카메라 추적 꺼짐</button>
      <button id="editor-logout" type="button">로그아웃</button>
    </header>
    <div class="editor-body">
      <aside class="editor-tools">
        <section class="editor-section"><h2>작도 도구</h2>
          <div class="tool-grid">
            <button data-tool="select" class="active">선택</button><button data-tool="pedestrian">보행로</button>
            <button data-tool="vehicle">차량 도로</button><button data-tool="shared">보차 혼용</button>
            <button data-tool="place">장소 마커</button><button data-tool="junction">교차점</button><button id="editor-cancel">작성 취소</button>
          </div>
        </section>
        <section class="editor-section" id="junction-fields" hidden><h2>교차점 정의</h2><div id="junction-preview-info" class="editor-hint">커서를 교차 위치로 옮기세요.</div><div class="feature-actions"><button id="junction-save" disabled>이 위치를 연결 노드로 지정</button></div></section>
        <section class="editor-section" id="road-fields">
          <h2>도로 속성</h2>
          <label class="editor-field">이름<input id="road-name" maxlength="160" placeholder="예: 북악관 보행로"></label>
          <label class="editor-field">구조<select id="road-structure"><option value="ordinary">일반 도로/통로</option><option value="sidewalk">인도</option><option value="crossing">횡단보도</option><option value="stairs">계단</option><option value="ramp">경사로</option><option value="indoor_corridor">실내 통로</option><option value="elevator">엘리베이터(수직)</option></select></label>
          <div class="editor-row"><label class="editor-field">보행 통행<select id="ped-access"><option>unknown</option><option>allowed</option><option>prohibited</option><option>restricted</option></select></label><label class="editor-field">차량 통행<select id="veh-access"><option>unknown</option><option>allowed</option><option>prohibited</option><option>restricted</option></select></label></div>
          <div class="editor-row"><label class="editor-field">보행 방향<select id="ped-dir"><option>both</option><option>forward</option><option>backward</option><option>unknown</option></select></label><label class="editor-field">차량 방향<select id="veh-dir"><option>both</option><option>forward</option><option>backward</option><option>unknown</option></select></label></div>
          <div class="editor-row"><label class="editor-field">폭(m)<input id="road-width" type="number" min="0.1" max="100" step="0.1" placeholder="미확인"></label><label class="editor-field">휠체어<select id="wheelchair"><option>unknown</option><option>allowed</option><option>prohibited</option><option>restricted</option></select></label></div>
          <label class="editor-field">건물 ID<input id="building-id" maxlength="80" placeholder="선택"></label>
          <label class="editor-field">층 ID<input id="level-id" maxlength="80" placeholder="예: outdoor / B1 / 1F"></label>
        </section>
        <section class="editor-section" id="place-fields" hidden>
          <h2>장소 정보</h2><label class="editor-field">이름<input id="place-name" maxlength="160" placeholder="장소명"></label>
          <label class="editor-field">분류<select id="place-category"><option value="building_entrance">건물 출입구</option><option value="destination">목적지</option><option value="facility">시설</option><option value="landmark">랜드마크</option><option value="parking">주차장</option><option value="bus_stop">버스 정류장</option><option value="other">기타</option></select></label>
          <label class="editor-field">설명<textarea id="place-description" maxlength="2000"></textarea></label>
          <label class="editor-field">건물 ID<input id="place-building" maxlength="80"></label><label class="editor-field">층 ID<input id="place-level" maxlength="80"></label>
        </section>
        <section class="editor-section"><h2>커서</h2>
          <div class="editor-row"><label class="editor-field">이동 Step<select id="move-step"><option value="0.1">0.1 m</option><option value="0.5" selected>0.5 m</option><option value="1">1 m</option><option value="5">5 m</option></select></label><label class="editor-field">회전 Step<select id="turn-step"><option value="1">1°</option><option value="5" selected>5°</option><option value="15">15°</option><option value="45">45°</option></select></label></div>
          <div class="editor-row"><label class="editor-field">X<input id="cursor-x" type="number" step="0.01"></label><label class="editor-field">Y<input id="cursor-y" type="number" step="0.01"></label></div>
          <div class="editor-row"><label class="editor-field">Z 정표고<input id="cursor-z" type="number" step="0.01"></label><label class="editor-field">머리 방향<input id="cursor-heading" type="number" step="1"></label></div>
          <div id="cursor-ground-clearance" class="editor-depth-readout">지면 높이 확인 중</div>
          <label class="inline-check"><input id="editor-orbit" type="checkbox"> 카메라 회전 중심을 커서에 고정</label>
          <div class="editor-hint">켜면 지도 드래그가 커서를 중심으로 회전하고, 커서 이동 시 회전 중심도 따라갑니다.</div>
          <div class="editor-hint"><span class="keycap">W</span>/<span class="keycap">S</span> 전후진 · <span class="keycap">A</span>/<span class="keycap">D</span> 좌우 · <span class="keycap">Q</span>/<span class="keycap">E</span> 머리 회전 · <span class="keycap">R</span>/<span class="keycap">F</span> Z 이동 · 동시 입력 가능</div>
        </section>
        <section class="editor-section"><h2>점 참고 / 스냅</h2>
          <label class="editor-field">수집 세션<select id="fusion-session"><option value="">세션 선택</option></select></label>
          <label class="editor-field">Fusion 실행<select id="fusion-run"><option value="">실행 선택</option></select></label>
          <label class="inline-check"><input id="fusion-overlay" type="checkbox" checked> 궤적 표시</label>
          <label class="inline-check"><input id="fusion-snap" type="checkbox"> 최근접 Fusion 점 스냅</label>
          <label class="inline-check"><input id="road-vertex-snap" type="checkbox"> 저장된 도로 Vertex 스냅</label>
          <label class="editor-field">스냅 방식<select id="snap-mode"><option value="XY">XY만, 현재 Z 유지</option><option value="Z">Z만, XY 자유 이동</option><option value="XYZ">절대고도 포함 XYZ</option></select></label>
          <label class="inline-check"><input id="snap-lock" type="checkbox"> 스냅 락 · 이동 중 가까운 점 따라가기</label>
          <div id="snap-status" class="editor-hint">스냅할 점 종류를 선택하세요.</div>
          <div class="editor-hint">도로 Vertex와 높이까지 정확히 연결하려면 XYZ를 선택하세요. XY는 현재 Z를 유지합니다.</div>
          <div class="editor-hint">Fusion 높이는 폰 높이를 포함할 수 있습니다. Z/XYZ 적용 전 노면 높이를 확인하세요.</div>
        </section>
        <section class="editor-section"><h2>함께 작업 중</h2><div id="presence-list" class="presence-list"></div></section>
      </aside>
      <main id="editor-map-wrap" class="editor-map"><div id="editor-map" tabindex="0"></div><div class="editor-crosshair"></div><div id="editor-heading" class="editor-heading" aria-label="커서 진행 방향"><span id="editor-heading-arrow" class="editor-heading-arrow">↑</span><span id="editor-heading-value">북 0°</span></div><div id="coordinate-bar" class="editor-coordinate-bar">지도를 클릭하여 커서 위치 지정</div></main>
      <aside class="editor-inspector">
        <section class="editor-section"><h2>작업</h2><div id="editor-message" class="editor-hint">도로/장소 도구를 고르고 지도를 클릭한 뒤 Space로 점을 추가하세요.</div>
          <div class="feature-actions"><button id="editor-edit" disabled>선택 편집</button><button id="editor-save" class="active" disabled>저장</button><button id="editor-delete" disabled>삭제</button></div>
          <div id="selected-info" class="editor-hint" style="margin-top:8px"></div>
        </section>
        <section class="editor-section"><h2>편집 Vertex</h2><div class="feature-actions"><button id="vertex-prev" disabled>이전</button><button id="vertex-next" disabled>다음</button><button id="vertex-delete" disabled>점 삭제</button></div><div class="feature-actions"><button id="vertex-undo-last" disabled>마지막 점 취소</button><span class="editor-hint">작도 중 Backspace</span></div><div id="vertex-info" class="editor-hint" style="margin-top:8px"></div></section>
        <section class="editor-section"><h2>캠퍼스 도로</h2><div id="road-list" class="feature-list"></div></section>
        <section class="editor-section"><h2>장소</h2><div id="place-list" class="feature-list"></div></section>
        <section class="editor-section"><h2>최근 변경</h2><div id="change-list" class="change-list"></div></section>
      </aside>
    </div>
  </div>
  <div id="editor-login" class="editor-login"><form id="editor-login-form" class="editor-login-card">
    <h1>트랙커 계정으로 로그인</h1><p>기존 트랙커 계정 코드를 사용합니다. 비밀번호는 필요하지 않으며 브라우저를 편집 기기로 등록합니다.</p>
    <label class="editor-field">트랙커 계정<select id="login-account" required><option value="">계정 불러오는 중…</option></select></label>
    <div id="login-error"></div><button type="submit">로그인</button>
  </form></div>`;

function token() { return localStorage.getItem(TOKEN_KEY) ?? ''; }
function userCode() { return localStorage.getItem(USER_KEY) ?? ''; }
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token()) headers.set('authorization', `Bearer ${token()}`);
  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

async function loadAccounts() {
  const select = $('login-account');
  try {
    const rows = await request<{ collectorId: string }[]>('/api/v1/collectors');
    select.innerHTML = `<option value="">계정 선택</option>${rows.map((r) => `<option value="${esc(r.collectorId)}">${esc(r.collectorId)}</option>`).join('')}`;
    const prior = localStorage.getItem(USER_KEY);
    if (prior && rows.some((r) => r.collectorId === prior)) select.value = prior;
    if (!rows.length) select.innerHTML = '<option value="">등록된 트랙커 계정이 없습니다</option>';
  } catch (err) { select.innerHTML = '<option value="">Backend 연결 실패</option>'; $('login-error').textContent = (err as Error).message; }
}
void loadAccounts();

$<HTMLFormElement>('editor-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('login-account').value;
  if (!code) return;
  try {
    let deviceId = localStorage.getItem(DEVICE_KEY);
    if (!deviceId) { deviceId = uuid(); localStorage.setItem(DEVICE_KEY, deviceId); }
    const result = await request<{ accessToken: string; collectorId: string }>('/api/v1/collectors/login', {
      method: 'POST', body: JSON.stringify({ collectorId: code, deviceId, platform: 'web', deviceModel: 'Campus Network Editor', appVersion: '0.1.0' }),
    });
    localStorage.setItem(TOKEN_KEY, result.accessToken);
    localStorage.setItem(USER_KEY, result.collectorId);
    $('editor-login').hidden = true;
    await startEditor();
  } catch (err) { $('login-error').innerHTML = `<div class="error">${esc((err as Error).message)}</div>`; }
});

let viewer: any = null;
let C: any = null;
let terrain: TerrainGrid | null = null;
let socket: Socket | null = null;
let roads: Road[] = [];
let places: Place[] = [];
let nodes: any[] = [];
let leases: any[] = [];
let entities: any[] = [];
let cursorEntity: any;
let cursorDirection: any;
let cursorDirectionOutline: any;
let cursorArrow: any;
let cursorArrowOutline: any;
let cursorDepthLine: any;
let cursorDepthOutline: any;
let cursorGroundPoint: any;
let ownCursor: XYZ = [ORIGIN.x, ORIGIN.y, 135];
let heading = 0;
let tool = 'select';
let roadDraft: Draft | null = null;
let placeDraft: Draft | null = null;
let selectedRoad: Road | null = null;
let selectedPlace: Place | null = null;
let selectedVertex = -1;
let dirty = false;
let draftSeq = 0;
let junctionPreview: JunctionPreview | null = null;
let junctionPreviewCursor: XYZ | null = null;
let junctionPreviewTimer: ReturnType<typeof setTimeout> | null = null;
let junctionPreviewRequest = 0;
let junctionSaving = false;
let junctionMarker: any = null;
let draftSendTimer: ReturnType<typeof setTimeout> | null = null;
let lastDraftSentAt = 0;
let followMode: 'off' | 'position' | 'direction' = 'off';
let orbitCursor = false;
let lastFollowTarget: any = null;
let snapPoints: RunPoint[] = [];
let lockedSnapTarget: SnapTarget | null = null;
let activeSnapTarget: SnapTarget | null = null;
let lockedSnapEntity: any = null;
let roadSnapEntity: any = null;
// Unsnapped movement target; a snapped cursor alone cannot cross gaps between source points.
let snapGuide: XYZ | null = null;
let leaseTimers = new Map<string, ReturnType<typeof setInterval>>();
let acquiredAffected: Lease[] = [];
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF']);
const heldKeys = new Set<string>();
let movementTimer: ReturnType<typeof setInterval> | null = null;
let mouseHandler: any;
let controlsInstalled = false;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let cursorTimer: ReturnType<typeof setTimeout> | null = null;
const remoteCursors = new Map<string, any>();
const remoteDirections = new Map<string, any>();
const connectedPeers = new Map<string, { collectorId: string; sessionId: string; agent?: string }>();
// Transient marks shown by AI agents (proposals from dry runs, highlighted findings); never saved.
const agentOverlays = new Map<string, any[]>();
let lastSentSelection = '';
type ChangeSet = { changeSetId: string; at: string; ownerCode: string; actor: { via: string; agent?: string }; revertOf: string | null; roads: number; places: number; operations: string[] };
let changeSets: ChangeSet[] = [];
const remoteDrafts = new Map<string, any>();
const undoStack: XYZ[][] = [];
const redoStack: XYZ[][] = [];

function say(message: string, kind: 'hint' | 'warning' | 'error' | 'success' = 'hint') {
  $('editor-message').className = kind;
  $('editor-message').textContent = message;
}
function attrsFromUI(roadClass = (roadDraft?.attrs.roadClass as RoadClass | undefined) ?? (tool as RoadClass)): Record<string, unknown> {
  let ped = $('ped-access').value, veh = $('veh-access').value;
  if (roadClass === 'pedestrian' && veh === 'allowed') veh = 'unknown';
  if (roadClass === 'vehicle' && ped === 'allowed') ped = 'unknown';
  return { name: $('road-name').value.trim() || null, roadClass, structure: $('road-structure').value,
    pedestrianAccess: ped, vehicleAccess: veh, pedestrianDirection: $('ped-dir').value, vehicleDirection: $('veh-dir').value,
    widthM: $('road-width').value ? Number($('road-width').value) : null, wheelchairAccess: $('wheelchair').value,
    buildingId: $('building-id').value.trim() || null, levelId: $('level-id').value.trim() || null };
}
function setRoadAttrs(a: Record<string, any>) {
  $('road-name').value = a.name ?? ''; $('road-structure').value = a.structure ?? 'ordinary';
  $('ped-access').value = a.pedestrianAccess ?? 'unknown'; $('veh-access').value = a.vehicleAccess ?? 'unknown';
  $('ped-dir').value = a.pedestrianDirection ?? 'both'; $('veh-dir').value = a.vehicleDirection ?? 'both';
  $('road-width').value = a.widthM == null ? '' : String(a.widthM); $('wheelchair').value = a.wheelchairAccess ?? 'unknown';
  $('building-id').value = a.buildingId ?? ''; $('level-id').value = a.levelId ?? '';
}
function drawPoint(p: XYZ) { const g = tmInverse(p[0], p[1]); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, p[2]); }
function terrainAt(x: number, y: number) {
  if (!terrain) return ownCursor[2];
  const fx = (x - terrain.originX) / terrain.resolution - 0.5, fy = (y - terrain.originY) / terrain.resolution - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  if (ix < 0 || iy < 0 || ix + 1 >= terrain.width || iy + 1 >= terrain.height) return null;
  const tx = fx - ix, ty = fy - iy, h = (i: number, j: number) => terrain!.heights[j * terrain!.width + i];
  return h(ix, iy) * (1 - tx) * (1 - ty) + h(ix + 1, iy) * tx * (1 - ty) + h(ix, iy + 1) * (1 - tx) * ty + h(ix + 1, iy + 1) * tx * ty;
}
function cursorGroundOffset(): { ground: number; clearance: number } | null {
  if (!terrain) return null;
  const ground = terrainAt(ownCursor[0], ownCursor[1]);
  return ground != null && Number.isFinite(ground) ? { ground, clearance: ownCursor[2] - ground } : null;
}
function addEntity(e: any) { const entity = viewer.entities.add(e); entities.push(entity); return entity; }
function cleanMapEntities() { for (const e of entities) viewer.entities.remove(e); entities = []; }
function drawLine(points: XYZ[], color: any, width: number, outlined = true, dashed = false, id?: string) {
  if (points.length < 2) return;
  const positions = points.map(drawPoint);
  const common = { positions, arcType: C.ArcType.NONE };
  const casing = C.Color.fromCssColorString('#14251d').withAlpha(0.9);
  if (outlined) addEntity({ polyline: { ...common, width: width + 4, material: casing, depthFailMaterial: casing } });
  addEntity({ id, polyline: { ...common, width, material: dashed ? new C.PolylineDashMaterialProperty({ color, dashLength: 14 }) : color,
    depthFailMaterial: color.withAlpha(0.8) } });
}
function cursorDirectionPoints(): { shaft: XYZ[]; arrow: XYZ[] } {
  const angle = heading * Math.PI / 180;
  const forward: [number, number] = [Math.sin(angle), Math.cos(angle)];
  const right: [number, number] = [Math.cos(angle), -Math.sin(angle)];
  const point = (along: number, sideways = 0): XYZ => [ownCursor[0] + forward[0] * along + right[0] * sideways,
    ownCursor[1] + forward[1] * along + right[1] * sideways, ownCursor[2] + 0.4];
  return { shaft: [point(0.4), point(4)], arrow: [point(2.8, -0.8), point(4), point(2.8, 0.8)] };
}
function updateCursorGraphics() {
  const position = drawPoint(ownCursor);
  const { shaft, arrow } = cursorDirectionPoints();
  const shaftPositions = shaft.map(drawPoint);
  const arrowPositions = arrow.map(drawPoint);
  const offset = cursorGroundOffset();
  const depth = offset && offset.clearance < -0.05 ? -offset.clearance : 0;
  if (!cursorEntity) cursorEntity = viewer.entities.add({ position,
    point: { pixelSize: 18, color: C.Color.fromCssColorString('#e22b2b'), outlineColor: C.Color.WHITE,
      outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: { text: '커서', font: 'bold 13px system-ui', pixelOffset: new C.Cartesian2(0, 27), fillColor: C.Color.WHITE,
      outlineColor: C.Color.fromCssColorString('#20251f'), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true, backgroundColor: C.Color.fromCssColorString('#20251f').withAlpha(0.9),
      backgroundPadding: new C.Cartesian2(7, 4), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  else cursorEntity.position = position;
  cursorEntity.label.text = depth ? `↓ 지면 아래 ${depth.toFixed(2)} m` : '커서';
  if (!cursorDirectionOutline) {
    const outline = C.Color.fromCssColorString('#20251f');
    cursorDirectionOutline = viewer.entities.add({ polyline: { positions: shaftPositions, width: 10, material: outline,
      depthFailMaterial: outline, arcType: C.ArcType.NONE } });
    cursorDirection = viewer.entities.add({ polyline: { positions: shaftPositions, width: 5, material: C.Color.WHITE,
      depthFailMaterial: C.Color.WHITE, arcType: C.ArcType.NONE } });
    cursorArrowOutline = viewer.entities.add({ polyline: { positions: arrowPositions, width: 10, material: outline,
      depthFailMaterial: outline, arcType: C.ArcType.NONE } });
    cursorArrow = viewer.entities.add({ polyline: { positions: arrowPositions, width: 5, material: C.Color.WHITE,
      depthFailMaterial: C.Color.WHITE, arcType: C.ArcType.NONE } });
  } else {
    cursorDirectionOutline.polyline.positions = shaftPositions;
    cursorDirection.polyline.positions = shaftPositions;
    cursorArrowOutline.polyline.positions = arrowPositions;
    cursorArrow.polyline.positions = arrowPositions;
  }
  if (!cursorDepthLine) {
    const line = new C.PolylineDashMaterialProperty({ color: C.Color.WHITE, dashLength: 12 });
    cursorDepthOutline = viewer.entities.add({ show: false, polyline: { positions: [position, position], width: 8,
      material: C.Color.fromCssColorString('#20251f'), depthFailMaterial: C.Color.fromCssColorString('#20251f'), arcType: C.ArcType.NONE } });
    cursorDepthLine = viewer.entities.add({ show: false, polyline: { positions: [position, position], width: 4,
      material: line, depthFailMaterial: line, arcType: C.ArcType.NONE } });
    cursorGroundPoint = viewer.entities.add({ show: false, position, point: { pixelSize: 12, color: C.Color.WHITE,
      outlineColor: C.Color.fromCssColorString('#20251f'), outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  }
  const belowGround = depth > 0 && offset !== null;
  cursorDepthOutline.show = belowGround;
  cursorDepthLine.show = belowGround;
  cursorGroundPoint.show = belowGround;
  if (belowGround) {
    const groundPosition = drawPoint([ownCursor[0], ownCursor[1], offset.ground]);
    cursorDepthOutline.polyline.positions = [position, groundPosition];
    cursorDepthLine.polyline.positions = [position, groundPosition];
    cursorGroundPoint.position = groundPosition;
  }
}
function drawAll() {
  if (!viewer) return;
  cleanMapEntities();
  for (const r of roads) {
    const css = COLORS[r.roadClass] ?? '#64748b';
    const color = C.Color.fromCssColorString(css).withAlpha(r.status === 'APPROVED' ? 1 : 0.8);
    drawLine(r.geometry.coordinates, color, 5, true, false, `editor:road:${r.id}`);
  }
  for (const p of places) {
    addEntity({ id: `editor:place:${p.id}`, position: drawPoint(p.geometry.coordinates), point: { pixelSize: 11,
      color: C.Color.fromCssColorString(COLORS.place), outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: p.name, font: '12px system-ui', pixelOffset: new C.Cartesian2(0, -14), fillColor: C.Color.WHITE,
        outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  }
  for (const n of nodes) {
    const connected = roads.some((r) => (r as any).fromNodeId === n.id || (r as any).toNodeId === n.id);
    if (!connected) continue;
    const coords = n.geometry?.coordinates;
    if (coords) addEntity({ id: `editor:node:${n.id}`, position: drawPoint(coords), point: { pixelSize: n.kind === 'junction' ? 10 : 6,
      color: C.Color.fromCssColorString(n.kind === 'junction' ? '#ffca45' : COLORS.junction),
      outlineColor: C.Color.fromCssColorString('#14251d'), outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  }
  updateCursorGraphics();
  if (roadDraft?.coordinates.length) {
    drawLine(roadDraft.coordinates, C.Color.YELLOW, 6);
    if (!(selectedRoad && selectedVertex >= 0)) drawLine([roadDraft.coordinates.at(-1)!, ownCursor], C.Color.YELLOW, 5, true, true);
  } else if (selectedRoad && selectedVertex >= 0) {
    const coords = selectedRoad.geometry.coordinates.map((p, i) => i === selectedVertex ? ownCursor : p);
    drawLine(coords, C.Color.YELLOW, 6);
  }
  const editVertices = roadDraft?.coordinates ?? (selectedRoad ? selectedRoad.geometry.coordinates : []);
  editVertices.forEach((p, i) => addEntity({ id: selectedRoad ? `editor:vertex:${selectedRoad.id}:${i}` : roadDraft ? `editor:draft-vertex:${i}` : undefined,
    position: drawPoint(p), point: { pixelSize: i === selectedVertex ? 13 : 9,
    color: i === selectedVertex ? C.Color.ORANGE : C.Color.WHITE, outlineColor: C.Color.fromCssColorString('#14251d'),
    outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
  drawFusionOverlay();
  updateReadouts(); renderLists();
}
async function loadSnapshot() {
  const data = await request<{ roads: Road[]; places: Place[]; nodes: any[]; leases: any[] }>('/api/v1/editor/snapshot');
  roads = data.roads; places = data.places; nodes = data.nodes; leases = data.leases;
  drawAll();
  void loadChanges();
}
async function loadChanges() {
  try { changeSets = await request<ChangeSet[]>('/api/v1/editor/changes?limit=12'); } catch { return; }
  const label: Record<string, string> = { created: '생성', updated: '수정', replaced: '분할/대체', deleted: '보관' };
  $('change-list').innerHTML = changeSets.map((c) => {
    const who = c.actor?.via === 'mcp' ? `🤖 ${esc(c.actor.agent ?? 'AI')} (${esc(c.ownerCode)})` : esc(c.ownerCode);
    const what = [c.roads ? `도로 ${c.roads}` : '', c.places ? `장소 ${c.places}` : ''].filter(Boolean).join(' · ') || '노드';
    return `<div class="change-item${c.actor?.via === 'mcp' ? ' ai' : ''}"><span>${who}<br><span class="muted">${new Date(c.at).toLocaleTimeString()} · ${what} · ${c.revertOf ? '되돌림' : c.operations.map((o) => label[o] ?? o).join('/')}</span></span>
      <button data-revert="${esc(c.changeSetId)}" title="이 변경 묶음을 되돌립니다">되돌리기</button></div>`;
  }).join('') || '<span class="editor-hint">변경 이력이 없습니다.</span>';
  $('change-list').querySelectorAll<HTMLButtonElement>('[data-revert]').forEach((b) => b.onclick = () => void revertChangeSet(b.dataset.revert!));
}
async function revertChangeSet(changeSetId: string) {
  if (roadDraft || placeDraft) { say('편집 중인 초안을 먼저 저장하거나 취소하세요.', 'warning'); return; }
  try {
    const result = await request<{ restored: number }>(`/api/v1/editor/changesets/${changeSetId}/revert`, { method: 'POST', body: JSON.stringify({ sessionId: EDITOR_SESSION, mutationId: uuid() }) });
    selectedRoad = null; selectedPlace = null;
    await loadSnapshot();
    say(`변경을 되돌렸습니다 (객체 ${result.restored}개).`, 'success');
  } catch (err) { say(`되돌릴 수 없습니다: ${(err as Error).message}`, 'error'); }
}
function drawAgentOverlay(o: { key: string; collectorId: string; agent: string; items: { kind: string; coordinates: XYZ[]; label?: string; style: string }[] }) {
  clearAgentOverlay(o.key);
  if (!viewer) return;
  const made: any[] = [];
  for (const item of o.items) {
    const color = C.Color.fromCssColorString(item.style === 'remove' ? '#ef4444' : '#d946ef');
    const text = `🤖 ${o.agent}${item.style === 'proposal' ? ' 제안' : item.style === 'remove' ? ' 삭제 제안' : ''}${item.label ? ` · ${item.label}` : ''}`;
    const label = { text, font: 'bold 12px system-ui', pixelOffset: new C.Cartesian2(0, -18), fillColor: C.Color.WHITE, showBackground: true,
      backgroundColor: color.withAlpha(0.85), disableDepthTestDistance: Number.POSITIVE_INFINITY };
    const positions = item.coordinates.map(drawPoint);
    if (item.kind === 'line' && positions.length > 1) {
      const material = new C.PolylineDashMaterialProperty({ color, dashLength: 16 });
      made.push(viewer.entities.add({ polyline: { positions, width: 6, material, depthFailMaterial: material, arcType: C.ArcType.NONE },
        position: positions[Math.floor(positions.length / 2)], label }));
    } else made.push(viewer.entities.add({ position: positions[0], label,
      point: { pixelSize: 16, color: color.withAlpha(0.35), outlineColor: color, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
  }
  agentOverlays.set(o.key, made);
}
function clearAgentOverlay(key: string) {
  for (const e of agentOverlays.get(key) ?? []) viewer?.entities.remove(e);
  agentOverlays.delete(key);
}
function sendSelection() {
  const selected = selectedRoad ? { objectType: 'road', objectId: selectedRoad.id } : selectedPlace ? { objectType: 'place', objectId: selectedPlace.id } : null;
  const key = JSON.stringify(selected);
  if (key === lastSentSelection || !socket?.connected) return;
  lastSentSelection = key;
  socket.emit('editor:selection:update', selected);
}
function clearJunctionPreview() {
  if (junctionPreviewTimer) clearTimeout(junctionPreviewTimer);
  junctionPreviewTimer = null;
  junctionPreviewRequest++;
  junctionPreview = null;
  junctionPreviewCursor = null;
  if (junctionMarker && viewer) viewer.entities.remove(junctionMarker);
  junctionMarker = null;
  $('junction-preview-info').textContent = '커서를 교차 위치로 옮기세요.';
  updateControls();
}
function scheduleJunctionPreview() {
  if (tool !== 'junction' || junctionSaving) return;
  clearJunctionPreview();
  $('junction-preview-info').textContent = '교차 가능한 도로 확인 중…';
  const requestId = junctionPreviewRequest;
  junctionPreviewTimer = setTimeout(() => { void (async () => {
    const cursor: XYZ = [...ownCursor];
    try {
      const preview = await request<JunctionPreview>('/api/v1/editor/junction-preview', { method: 'POST', body: JSON.stringify({ coordinate: cursor }) });
      if (requestId !== junctionPreviewRequest || tool !== 'junction') return;
      junctionPreview = preview; junctionPreviewCursor = cursor;
      const info = $('junction-preview-info');
      if (preview.roads.length < 2) info.textContent = '같은 층·높이에서 커서 0.75 m 안에 만나는 도로가 2개 이상 필요합니다.';
      else if (preview.alreadyConnected) info.textContent = '이 도로들은 이미 하나의 연결 노드를 공유합니다.';
      else if (preview.roads.length > 32) info.textContent = '한 번에 연결할 수 있는 도로는 32개까지입니다.';
      else info.textContent = `${preview.roads.length}개 도로 연결 후보 · Z ${preview.coordinate[2].toFixed(2)} m · 최대 위치 보정 ${Math.max(...preview.roads.map((r) => r.distanceM)).toFixed(2)} m · ${preview.roads.map((r) => r.name || r.roadClass).join(', ')}`;
      if (preview.roads.length >= 2) junctionMarker = viewer.entities.add({ position: drawPoint(preview.coordinate),
        point: { pixelSize: 16, color: C.Color.YELLOW, outlineColor: C.Color.BLACK, outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: preview.alreadyConnected ? '이미 연결됨' : `교차점 후보 · ${preview.roads.length}개 도로`,
          pixelOffset: new C.Cartesian2(0, -19), font: 'bold 12px system-ui', fillColor: C.Color.WHITE,
          showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.8), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      updateControls();
    } catch (err) {
      if (requestId === junctionPreviewRequest) $('junction-preview-info').textContent = (err as Error).message;
    }
  })(); }, 180);
}
async function defineJunction() {
  const preview = junctionPreview, cursor = junctionPreviewCursor;
  if (tool !== 'junction' || !preview || !cursor || preview.roads.length < 2 || preview.roads.length > 32 || preview.alreadyConnected || junctionSaving) return;
  junctionSaving = true; updateControls();
  const acquired: Lease[] = [];
  let saved = false;
  try {
    if (!socket?.connected) throw new Error('협업 서버 연결이 끊겨 있습니다.');
    for (const road of preview.roads) { const lease = await acquire('road', road.id); acquired.push(lease); heartbeat(lease); }
    const result = await request<{ nodeId: string; roadCount: number }>('/api/v1/editor/junctions', { method: 'POST',
      body: JSON.stringify({ coordinate: cursor, roads: preview.roads.map((road) => ({ id: road.id, revision: road.revision,
        leaseToken: acquired.find((lease) => lease.objectId === road.id)!.leaseToken })), sessionId: EDITOR_SESSION, mutationId: uuid() }) });
    saved = true;
    say(`${result.roadCount}개 도로를 하나의 교차점으로 연결했습니다.`, 'success');
    await loadSnapshot().catch((err) => say(`교차점은 저장됐지만 목록을 새로고침하지 못했습니다: ${(err as Error).message}`, 'warning'));
  } catch (err) { say((err as Error).message, 'error'); }
  finally {
    for (const lease of acquired) {
      const key = `road:${lease.objectId}`;
      clearInterval(leaseTimers.get(key)); leaseTimers.delete(key);
      if (!saved) await release(lease);
    }
    junctionSaving = false;
    if (tool === 'junction') scheduleJunctionPreview();
  }
}
function setTool(next: string) {
  tool = next;
  if (next !== 'junction') clearJunctionPreview();
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === next));
  $('road-fields').hidden = !['pedestrian', 'vehicle', 'shared'].includes(next) && !selectedRoad;
  $('place-fields').hidden = next !== 'place' && !selectedPlace;
  $('junction-fields').hidden = next !== 'junction';
  $('editor-tool-label').textContent = ({ select: '선택', pedestrian: '보행로 작도', vehicle: '차량 도로 작도', shared: '보차 혼용 작도', place: '장소 배치', junction: '교차점 정의' } as any)[next] ?? next;
  if (['pedestrian', 'vehicle', 'shared'].includes(next)) void startRoadDraft(next as RoadClass);
  else if (next === 'place') void startPlaceDraft();
  else if (next === 'junction') {
    clearDraft(); selectedRoad = null; selectedPlace = null;
    $('road-fields').hidden = true; $('place-fields').hidden = true;
    scheduleJunctionPreview();
  }
  else if (next === 'select') { clearDraft(); }
  say(next === 'place' ? '지도를 클릭해 장소 위치를 정하고 저장하세요.' : next === 'junction' ? '커서를 교차 위치에 두고 후보 도로를 확인한 뒤 연결 노드를 지정하세요.'
    : next === 'select' ? '도로 또는 장소를 선택하세요.' : '지도를 클릭해 시작 위치를 놓고 Space로 꼭지점을 추가하세요.');
}
async function acquire(kind: ObjectType, id: string) {
  return request<Lease>('/api/v1/editor/leases', { method: 'POST', body: JSON.stringify({ objectType: kind, objectId: id, sessionId: EDITOR_SESSION }) });
}
async function release(l: Lease | { objectType: ObjectType; objectId: string; leaseToken: string }) {
  await request('/api/v1/editor/leases/release', { method: 'POST', body: JSON.stringify({ objectType: l.objectType, objectId: l.objectId, sessionId: EDITOR_SESSION, leaseToken: l.leaseToken }) }).catch(() => undefined);
  const key = `${l.objectType}:${l.objectId}`; clearInterval(leaseTimers.get(key)); leaseTimers.delete(key);
}
function heartbeat(l: Lease) {
  const key = `${l.objectType}:${l.objectId}`;
  clearInterval(leaseTimers.get(key));
  leaseTimers.set(key, setInterval(() => {
    void request<Lease>('/api/v1/editor/leases/renew', { method: 'POST', body: JSON.stringify({ objectType: l.objectType,
      objectId: l.objectId, sessionId: EDITOR_SESSION, leaseToken: l.leaseToken }) }).catch((err) => {
        clearInterval(leaseTimers.get(key)); leaseTimers.delete(key); say(`편집권을 잃었습니다: ${(err as Error).message}`, 'error');
      });
  }, 10_000));
}
function clearDraft(releaseLease = true) {
  if (draftSendTimer) clearTimeout(draftSendTimer);
  draftSendTimer = null;
  const active = roadDraft ?? placeDraft;
  if (active && releaseLease) void release({ objectType: active.objectType, objectId: active.id, leaseToken: active.leaseToken });
  if (active) socket?.emit('editor:draft:clear', { objectType: active.objectType, objectId: active.id, leaseToken: active.leaseToken });
  if (active) {
    const key = `${active.objectType}:${active.id}`;
    clearInterval(leaseTimers.get(key)); leaseTimers.delete(key);
  }
  for (const l of acquiredAffected) {
    const key = `${l.objectType}:${l.objectId}`;
    clearInterval(leaseTimers.get(key)); leaseTimers.delete(key);
    if (releaseLease) void release(l);
  }
  roadDraft = null; placeDraft = null; dirty = false; selectedVertex = -1; acquiredAffected = []; draftSeq = 0;
  lastDraftSentAt = 0;
  $('editor-save').toggleAttribute('disabled', true); $('editor-delete').toggleAttribute('disabled', !selectedRoad && !selectedPlace);
  undoStack.length = 0; redoStack.length = 0;
  drawAll();
}
async function startRoadDraft(kind: RoadClass, existing?: Road, branch?: { road: Road; vertexIndex: number }) {
  clearDraft();
  const id = existing?.id ?? uuid();
  try {
    const l = await acquire('road', id); heartbeat(l);
    if (existing) {
      selectedRoad = existing; selectedPlace = null;
      roadDraft = { id, coordinates: existing.geometry.coordinates.map((p) => [...p] as XYZ), leaseToken: l.leaseToken,
        expectedRevision: existing.revision, attrs: { name: existing.name, roadClass: existing.roadClass, structure: existing.structure,
          pedestrianAccess: existing.pedestrianAccess, vehicleAccess: existing.vehicleAccess, pedestrianDirection: existing.pedestrianDirection,
          vehicleDirection: existing.vehicleDirection, widthM: existing.widthM, wheelchairAccess: existing.wheelchairAccess,
          buildingId: existing.buildingId, levelId: existing.levelId }, objectType: 'road' };
      setRoadAttrs(roadDraft.attrs);
      selectedVertex = 0; ownCursor = [...roadDraft.coordinates[0]]; rebaseSnapGuide();
      if (followMode !== 'off' || orbitCursor) followCursor();
    } else {
      selectedRoad = null; selectedPlace = null;
      if (branch) {
        setRoadAttrs({ ...branch.road, name: null });
        ownCursor = [...branch.road.geometry.coordinates[branch.vertexIndex]];
        rebaseSnapGuide();
        if (followMode !== 'off' || orbitCursor) followCursor();
      } else if (kind === 'pedestrian') { $('ped-access').value = 'allowed'; $('veh-access').value = 'prohibited'; }
      else if (kind === 'vehicle') { $('ped-access').value = 'prohibited'; $('veh-access').value = 'allowed'; }
      else { $('ped-access').value = 'allowed'; $('veh-access').value = 'allowed'; }
      roadDraft = { id, coordinates: branch ? [[...ownCursor]] : [], leaseToken: l.leaseToken, expectedRevision: null,
        attrs: attrsFromUI(kind), objectType: 'road',
        branchFrom: branch ? { roadId: branch.road.id, vertexIndex: branch.vertexIndex } : undefined };
      if (branch) { dirty = true; sendCursor(); }
    }
    updateControls(); drawAll(); publishDraft();
  } catch (err) { setTool('select'); say((err as Error).message, 'error'); }
}
async function startPlaceDraft(existing?: Place) {
  clearDraft();
  const id = existing?.id ?? uuid();
  try {
    const l = await acquire('place', id); heartbeat(l);
    selectedRoad = null; selectedPlace = existing ?? null;
    if (existing) {
      $('place-name').value = existing.name; $('place-category').value = existing.category;
      $('place-description').value = existing.description ?? ''; $('place-building').value = existing.buildingId ?? ''; $('place-level').value = existing.levelId ?? '';
      ownCursor = [...existing.geometry.coordinates]; rebaseSnapGuide();
      if (followMode !== 'off' || orbitCursor) followCursor();
    }
    placeDraft = { id, coordinates: [], leaseToken: l.leaseToken, expectedRevision: existing?.revision ?? null,
      attrs: {}, objectType: 'place' };
    updateControls(); drawAll(); publishDraft();
  } catch (err) { setTool('select'); say((err as Error).message, 'error'); }
}
function snapMode(): SnapMode { return $('snap-mode').value as SnapMode; }
function snappingEnabled() {
  return $<HTMLInputElement>('fusion-snap').checked || $<HTMLInputElement>('road-vertex-snap').checked;
}
function updateLockMarker() {
  if (!viewer) return;
  if (!lockedSnapEntity) lockedSnapEntity = viewer.entities.add({ show: false,
    point: { pixelSize: 17, color: C.Color.WHITE, outlineColor: C.Color.fromCssColorString('#0759c7'),
      outlineWidth: 4, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: { text: '', font: 'bold 12px system-ui', pixelOffset: new C.Cartesian2(0, -24),
      fillColor: C.Color.WHITE, outlineColor: C.Color.fromCssColorString('#082b64'), outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true,
      backgroundColor: C.Color.fromCssColorString('#082b64').withAlpha(0.9),
      disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  lockedSnapEntity.show = lockedSnapTarget !== null && snapMode() === 'Z';
  if (!lockedSnapTarget) return;
  lockedSnapEntity.position = drawPoint(lockedSnapTarget.point);
  lockedSnapEntity.label.text = `${lockedSnapTarget.label} · ${snapMode()} LOCK`;
}
function updateRoadSnapMarker() {
  if (!viewer || (!roadSnapEntity && activeSnapTarget?.source !== 'road')) return;
  if (!roadSnapEntity) roadSnapEntity = viewer.entities.add({ show: false,
    point: { pixelSize: 15, color: C.Color.TRANSPARENT, outlineColor: C.Color.fromCssColorString('#facc15'),
      outlineWidth: 4, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: { text: '', font: 'bold 11px system-ui', pixelOffset: new C.Cartesian2(0, -23),
      fillColor: C.Color.WHITE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.8),
      disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  roadSnapEntity.show = activeSnapTarget?.source === 'road';
  if (activeSnapTarget?.source === 'road') {
    roadSnapEntity.position = drawPoint(activeSnapTarget.point);
    roadSnapEntity.label.text = activeSnapTarget.label;
  }
}
function nearestSnapTarget(p: XYZ, mode: SnapMode, maxDistance = 2.5): SnapTarget | null {
  let best: SnapTarget | null = null, distance = maxDistance;
  if ($<HTMLInputElement>('road-vertex-snap').checked) {
    const level = roadDraft ? $('level-id').value.trim() || null : null;
    for (const road of roads) {
      if (roadDraft && road.levelId !== level) continue;
      road.geometry.coordinates.forEach((point, index) => {
        if (selectedRoad?.id === road.id && selectedVertex === index && roadDraft) return;
        const d = Math.hypot(p[0] - point[0], p[1] - point[1]);
        if (d < distance) { distance = d; best = { source: 'road', point: [...point] as XYZ, label: `도로 ${road.name || road.roadClass} Vertex ${index + 1}` }; }
      });
    }
  }
  if ($<HTMLInputElement>('fusion-snap').checked) for (const q of snapPoints) {
    if ((mode === 'Z' || mode === 'XYZ') && (q.h == null || !Number.isFinite(q.h))) continue;
    // Run positions use the campus-local frame, while the editor cursor uses EPSG:5186.
    const x = q.x + ORIGIN.x, y = q.y + ORIGIN.y;
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < distance) { distance = d; best = { source: 'fusion', point: [x, y, q.h ?? p[2]], label: `Fusion 점 #${q.seq}` }; }
  }
  return best;
}
function refreshSnapSources() {
  const guide: XYZ = snappingEnabled() && snapGuide ? [...snapGuide] : [...ownCursor];
  if ($<HTMLInputElement>('snap-lock').checked && !nearestSnapTarget(guide, snapMode(), Number.POSITIVE_INFINITY)) {
    $<HTMLInputElement>('snap-lock').checked = false;
    lockedSnapTarget = null;
  }
  if (!snappingEnabled()) { lockedSnapTarget = null; activeSnapTarget = null; snapGuide = null; }
  updateLockMarker();
  setCursor(guide);
}
function rebaseSnapGuide() {
  snapGuide = snappingEnabled() ? [...ownCursor] : null;
  activeSnapTarget = null;
  if (lockedSnapTarget) {
    lockedSnapTarget = nearestSnapTarget(ownCursor, snapMode(), Number.POSITIVE_INFINITY);
    updateLockMarker();
  }
}
function applySnap(p: XYZ): XYZ {
  activeSnapTarget = null;
  if (!snappingEnabled()) { updateRoadSnapMarker(); return p; }
  const mode = snapMode();
  const locked = $<HTMLInputElement>('snap-lock').checked;
  const target = nearestSnapTarget(p, mode, locked ? Number.POSITIVE_INFINITY : 2.5);
  if (!target) { updateRoadSnapMarker(); return p; }
  if (locked) {
    lockedSnapTarget = target;
    updateLockMarker();
  }
  activeSnapTarget = target;
  updateRoadSnapMarker();
  return [mode === 'Z' ? p[0] : target.point[0],
    mode === 'Z' ? p[1] : target.point[1],
    mode === 'XY' ? p[2] : target.point[2]];
}
function setCursor(p: XYZ, updateCamera = true, relativeMove = false) {
  const snapping = snappingEnabled();
  const guide: XYZ = relativeMove && snapGuide && snapping
    ? [snapGuide[0] + p[0] - ownCursor[0], snapGuide[1] + p[1] - ownCursor[1], snapGuide[2] + p[2] - ownCursor[2]] : p;
  snapGuide = snapping ? [...guide] : null;
  const before = ownCursor;
  ownCursor = applySnap(guide);
  if (snapGuide && snapMode() !== 'XY') snapGuide[2] = ownCursor[2];
  const positionChanged = ownCursor.some((value, index) => value !== before[index]);
  if (positionChanged && selectedRoad && selectedVertex >= 0 && roadDraft) {
    roadDraft.coordinates[selectedVertex] = [...ownCursor]; selectedRoad.geometry.coordinates = roadDraft.coordinates;
    dirty = true;
  }
  drawCursorOnly(); updateReadouts();
  if ((followMode !== 'off' || orbitCursor) && updateCamera) followCursor();
  sendCursor();
  if (positionChanged && (roadDraft || placeDraft)) publishDraft();
  if (positionChanged && tool === 'junction') scheduleJunctionPreview();
}
function drawCursorOnly() {
  if (!viewer) return;
  updateCursorGraphics();
  if (roadDraft || (selectedRoad && selectedVertex >= 0)) drawAll();
}
function sendCursor() {
  if (cursorTimer) return;
  cursorTimer = setTimeout(() => { cursorTimer = null; socket?.emit('editor:cursor:update', { coordinate: ownCursor, heading }); }, 50);
}
function updateReadouts() {
  const offset = cursorGroundOffset();
  const clearance = offset?.clearance ?? null;
  const depthText = clearance === null ? '지면 높이 없음' : clearance < -0.05 ? `지면 아래 ${(-clearance).toFixed(2)} m`
    : clearance > 0.05 ? `지면 위 ${clearance.toFixed(2)} m` : '지면 높이';
  const belowGround = clearance !== null && clearance < -0.05;
  const readout = $('cursor-ground-clearance');
  readout.className = `editor-depth-readout${belowGround ? ' below' : ''}`;
  readout.textContent = offset ? `지면 Z ${offset.ground.toFixed(2)} m · ${depthText}` : depthText;
  const bar = $('coordinate-bar');
  const snapEnabled = snappingEnabled();
  const lockEnabled = lockedSnapTarget !== null;
  const snapLabel = lockedSnapTarget ? `LOCK ${snapMode()} · ${lockedSnapTarget.label}` : activeSnapTarget ? `SNAP ${snapMode()} · ${activeSnapTarget.label}` : snapEnabled ? 'SNAP 대기' : '';
  bar.textContent = `X ${ownCursor[0].toFixed(2)} · Y ${ownCursor[1].toFixed(2)} · Z ${ownCursor[2].toFixed(2)} m · ${((heading % 360 + 360) % 360).toFixed(0)}°${snapLabel ? ` · ${snapLabel}` : ''}`;
  $('snap-status').textContent = lockedSnapTarget ? `${lockedSnapTarget.label} 추적 중 · 이동하면 가까운 점으로 자동 전환됩니다.`
    : activeSnapTarget ? `${activeSnapTarget.label}에 ${snapMode()} 스냅 중`
      : snapEnabled ? '2.5 m 안의 스냅 점을 찾는 중' : '스냅 꺼짐';
  if (offset) {
    const badge = document.createElement('span');
    badge.className = `editor-depth-badge${belowGround ? ' below' : ''}`;
    badge.textContent = depthText;
    bar.append(badge);
  }
  if (!$('cursor-x').matches(':focus')) $('cursor-x').value = ownCursor[0].toFixed(2);
  if (!$('cursor-y').matches(':focus')) $('cursor-y').value = ownCursor[1].toFixed(2);
  if (!$('cursor-z').matches(':focus')) $('cursor-z').value = ownCursor[2].toFixed(2);
  if (!$('cursor-heading').matches(':focus')) $('cursor-heading').value = ((heading % 360 + 360) % 360).toFixed(0);
  const normalizedHeading = (heading % 360 + 360) % 360;
  $('editor-heading-arrow').style.transform = `rotate(${normalizedHeading}deg)`;
  $('editor-heading-value').textContent = `진행 ${normalizedHeading.toFixed(0)}° · 북 기준`;
  $('vertex-info').textContent = selectedRoad && selectedVertex >= 0 ? `Vertex ${selectedVertex + 1} / ${selectedRoad.geometry.coordinates.length} · ${ownCursor.map((v) => v.toFixed(2)).join(', ')}`
    : roadDraft ? `${roadDraft.coordinates.length}개 꼭지점 · Space로 추가`
      : selectedRoad ? '지도에 표시된 점을 더블클릭하면 해당 Vertex에서 새 도로를 시작합니다.' : '';
  updateControls();
}
function updateControls() {
  sendSelection();
  $('editor-save').toggleAttribute('disabled', !socket?.connected || !(roadDraft && (roadDraft.coordinates.length >= 2 || selectedRoad) || placeDraft && $('place-name').value.trim()));
  $('editor-delete').toggleAttribute('disabled', !socket?.connected || (!selectedRoad && !selectedPlace) || !!roadDraft || !!placeDraft);
  $('editor-edit').toggleAttribute('disabled', !socket?.connected || (!selectedRoad && !selectedPlace) || !!roadDraft || !!placeDraft);
  $('vertex-prev').toggleAttribute('disabled', !selectedRoad || selectedVertex <= 0);
  $('vertex-next').toggleAttribute('disabled', !selectedRoad || selectedVertex < 0 || selectedVertex >= selectedRoad.geometry.coordinates.length - 1);
  $('vertex-delete').toggleAttribute('disabled', !roadDraft || roadDraft.coordinates.length <= 2 || selectedVertex < 0);
  $('vertex-undo-last').toggleAttribute('disabled', !roadDraft || !!selectedRoad || roadDraft.coordinates.length <= (roadDraft.branchFrom ? 1 : 0));
  $('junction-save').toggleAttribute('disabled', !socket?.connected || junctionSaving || tool !== 'junction'
    || !junctionPreview || junctionPreview.roads.length < 2 || junctionPreview.roads.length > 32 || junctionPreview.alreadyConnected);
  $('selected-info').textContent = selectedRoad ? `${selectedRoad.name || '이름 없는 도로'} · ${selectedRoad.roadClass} · ${selectedRoad.status} r${selectedRoad.revision}` : selectedPlace ? `${selectedPlace.name} · ${selectedPlace.category} · ${selectedPlace.status} r${selectedPlace.revision}` : dirty ? '저장되지 않은 변경' : '';
}
function renderLists() {
  $('road-list').innerHTML = roads.map((r) => `<button class="feature-item ${selectedRoad?.id === r.id ? 'selected' : ''}" data-road-id="${esc(r.id)}"><span class="swatch" style="background:${COLORS[r.roadClass]}"></span><span>${esc(r.name || '이름 없는 도로')}<br><span class="muted">${esc(r.roadClass)} · ${esc(r.status)}</span></span></button>`).join('') || '<span class="editor-hint">저장된 도로가 없습니다.</span>';
  $('place-list').innerHTML = places.map((p) => `<button class="feature-item ${selectedPlace?.id === p.id ? 'selected' : ''}" data-place-id="${esc(p.id)}"><span class="swatch" style="background:${COLORS.place}"></span><span>${esc(p.name)}<br><span class="muted">${esc(p.category)}</span></span></button>`).join('') || '<span class="editor-hint">저장된 장소가 없습니다.</span>';
  $('road-list').querySelectorAll<HTMLButtonElement>('[data-road-id]').forEach((b) => b.onclick = () => selectRoad(b.dataset.roadId!));
  $('place-list').querySelectorAll<HTMLButtonElement>('[data-place-id]').forEach((b) => b.onclick = () => selectPlace(b.dataset.placeId!));
  const peers = [...connectedPeers.values()].filter((p) => p.sessionId !== EDITOR_SESSION);
  $('presence-list').innerHTML = [...new Map(peers.map((p) => [`${p.collectorId}|${p.agent ?? ''}`, p])).values()].map((p) => {
    if (p.agent) return `<div><i class="presence-dot ai"></i>🤖 ${esc(p.agent)} <span class="muted">(${esc(p.collectorId)}) · AI 작업 중</span></div>`;
    const count = leases.filter((l) => l.ownerCode === p.collectorId).length;
    return `<div><i class="presence-dot"></i>${esc(p.collectorId)}${count ? ` · ${count}개 객체 편집` : ' · 접속 중'}</div>`;
  }).join('') || '<span class="muted">다른 작업자가 없습니다.</span>';
}
function selectRoad(id: string) {
  if (roadDraft || placeDraft) return;
  selectedRoad = roads.find((r) => r.id === id) ?? null; selectedPlace = null; selectedVertex = -1;
  $('road-fields').hidden = false; $('place-fields').hidden = true;
  if (selectedRoad) setRoadAttrs(selectedRoad);
  updateControls(); drawAll();
}
function selectPlace(id: string) {
  if (roadDraft || placeDraft) return;
  selectedPlace = places.find((p) => p.id === id) ?? null; selectedRoad = null; selectedVertex = -1;
  $('road-fields').hidden = true; $('place-fields').hidden = false;
  if (selectedPlace) { $('place-name').value = selectedPlace.name; $('place-category').value = selectedPlace.category; $('place-description').value = selectedPlace.description ?? ''; ownCursor = [...selectedPlace.geometry.coordinates]; rebaseSnapGuide(); if (followMode !== 'off' || orbitCursor) followCursor(); }
  updateControls(); drawAll();
}
async function startEditingSelection() {
  if (selectedRoad) await startRoadDraft(selectedRoad.roadClass as RoadClass, selectedRoad);
  else if (selectedPlace) { tool = 'place'; $('editor-tool-label').textContent = '장소 편집'; document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === 'place')); await startPlaceDraft(selectedPlace); }
}
async function branchFromVertex(roadId: string, vertexIndex: number) {
  if (roadDraft || placeDraft) { say('현재 편집 중인 도로를 먼저 저장하거나 취소한 뒤 분기하세요.', 'warning'); return; }
  const road = roads.find((item) => item.id === roadId);
  if (!road || !road.geometry.coordinates[vertexIndex]) return;
  tool = road.roadClass;
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  $('editor-tool-label').textContent = `${road.roadClass === 'pedestrian' ? '보행로' : road.roadClass === 'vehicle' ? '차량 도로' : '보차 혼용'} 분기 작도`;
  $('road-fields').hidden = false; $('place-fields').hidden = true; $('junction-fields').hidden = true;
  await startRoadDraft(road.roadClass, undefined, { road, vertexIndex });
  if ((roadDraft as Draft | null)?.branchFrom?.roadId === roadId) say(`Vertex ${vertexIndex + 1}에서 새 도로를 시작했습니다. 커서를 이동한 뒤 Space로 다음 점을 추가하세요.`);
}

function pushUndo() {
  if (roadDraft) { undoStack.push(roadDraft.coordinates.map((p) => [...p] as XYZ)); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; }
}
function undoLastVertex() {
  if (!roadDraft || selectedRoad || roadDraft.coordinates.length <= (roadDraft.branchFrom ? 1 : 0)) return;
  pushUndo();
  roadDraft.coordinates.pop();
  const previous = roadDraft.coordinates.at(-1);
  if (previous) {
    ownCursor = [...previous];
    rebaseSnapGuide();
    if (followMode !== 'off' || orbitCursor) followCursor();
    sendCursor();
  }
  dirty = true;
  drawAll();
  publishDraft();
}
function commitVertex() {
  if (!roadDraft) return;
  if (selectedRoad && selectedVertex >= 0) {
    const before = roadDraft.coordinates[selectedVertex];
    const after = roadDraft.coordinates[selectedVertex + 1];
    if (before && Math.hypot(before[0] - ownCursor[0], before[1] - ownCursor[1], before[2] - ownCursor[2]) < 0.02) return;
    if (after && Math.hypot(after[0] - ownCursor[0], after[1] - ownCursor[1], after[2] - ownCursor[2]) < 0.02) return;
  } else {
    const last = roadDraft.coordinates.at(-1);
    if (last && Math.hypot(last[0] - ownCursor[0], last[1] - ownCursor[1], last[2] - ownCursor[2]) < 0.02) return;
  }
  pushUndo();
  if (selectedRoad && selectedVertex >= 0) {
    roadDraft.coordinates.splice(selectedVertex + 1, 0, [...ownCursor]); selectedVertex++;
    selectedRoad.geometry.coordinates = roadDraft.coordinates;
  } else {
    roadDraft.coordinates.push([...ownCursor]);
  }
  dirty = true; updateControls(); drawAll(); publishDraft();
}
function publishDraft() {
  if (draftSendTimer) clearTimeout(draftSendTimer);
  draftSendTimer = null;
  const delay = Math.max(0, 100 - (Date.now() - lastDraftSentAt));
  if (delay) { draftSendTimer = setTimeout(publishDraft, delay); return; }
  const d = roadDraft ?? placeDraft;
  if (!d || !socket?.connected) return;
  let roadCoordinates = d.coordinates;
  if (d.objectType === 'road' && !(selectedRoad && selectedVertex >= 0)) {
    const last = roadCoordinates.at(-1);
    if (last && Math.hypot(last[0] - ownCursor[0], last[1] - ownCursor[1], last[2] - ownCursor[2]) >= 0.02) roadCoordinates = [...roadCoordinates, [...ownCursor]];
  }
  lastDraftSentAt = Date.now();
  const sentSeq = ++draftSeq;
  socket.emit('editor:draft:update', { objectType: d.objectType, objectId: d.id, leaseToken: d.leaseToken,
    baseRevision: d.expectedRevision ?? 0, draftSeq: sentSeq, draft: d.objectType === 'road' ? { coordinates: roadCoordinates, attrs: attrsFromUI(d.attrs.roadClass as RoadClass) }
      : { coordinate: ownCursor, attrs: { name: $('place-name').value.trim(), category: $('place-category').value,
        description: $('place-description').value.trim(), buildingId: $('place-building').value.trim(), levelId: $('place-level').value.trim() } } },
  (result: any) => {
    if (result?.code === 'DRAFT_RATE_LIMITED' && sentSeq === draftSeq && (roadDraft ?? placeDraft)?.leaseToken === d.leaseToken) {
      if (draftSendTimer) clearTimeout(draftSendTimer);
      draftSendTimer = setTimeout(publishDraft, 100);
    } else if (!result?.ok && result?.code) say(`실시간 초안 전송 실패: ${result.code}`, 'warning');
  });
}
function undo() {
  if (!roadDraft || !undoStack.length) return;
  redoStack.push(roadDraft.coordinates.map((p) => [...p] as XYZ)); roadDraft.coordinates = undoStack.pop()!;
  if (selectedRoad) selectedRoad.geometry.coordinates = roadDraft.coordinates;
  dirty = true; drawAll(); publishDraft();
}
function redo() {
  if (!roadDraft || !redoStack.length) return;
  undoStack.push(roadDraft.coordinates.map((p) => [...p] as XYZ)); roadDraft.coordinates = redoStack.pop()!;
  if (selectedRoad) selectedRoad.geometry.coordinates = roadDraft.coordinates;
  dirty = true; drawAll(); publishDraft();
}
function clearHeldKeys() {
  heldKeys.clear();
  if (movementTimer) clearInterval(movementTimer);
  movementTimer = null;
}
function stepMove() {
  const step = Number($('move-step').value);
  const turn = Number($('turn-step').value) * (Number(heldKeys.has('KeyE')) - Number(heldKeys.has('KeyQ')));
  if (turn) heading = (heading + turn + 360) % 360;
  const forwardInput = Number(heldKeys.has('KeyW')) - Number(heldKeys.has('KeyS'));
  const rightInput = Number(heldKeys.has('KeyD')) - Number(heldKeys.has('KeyA'));
  const heightInput = Number(heldKeys.has('KeyR')) - Number(heldKeys.has('KeyF'));
  const h = heading * Math.PI / 180;
  const forward: [number, number] = [Math.sin(h), Math.cos(h)], right: [number, number] = [Math.cos(h), -Math.sin(h)];
  const dx = forward[0] * forwardInput + right[0] * rightInput;
  const dy = forward[1] * forwardInput + right[1] * rightInput;
  const mag = Math.hypot(forwardInput, rightInput);
  if (mag || heightInput) {
    setCursor([ownCursor[0] + (mag ? dx / mag * step : 0), ownCursor[1] + (mag ? dy / mag * step : 0), ownCursor[2] + heightInput * step], true, true);
  } else if (turn) {
    drawCursorOnly(); updateReadouts();
    if (followMode === 'direction') followCursor();
    sendCursor();
  }
}
function followCursor() {
  if (!viewer) return;
  const camera = viewer.camera;
  const target = drawPoint(ownCursor);
  const pitch = orbitCursor
    ? Math.max(C.Math.toRadians(-89), Math.min(C.Math.toRadians(-5), camera.pitch))
    : Math.max(C.Math.toRadians(-85), Math.min(C.Math.toRadians(-25), camera.pitch));
  const depth = Math.max(0, -(cursorGroundOffset()?.clearance ?? 0));
  const minRange = depth ? Math.max(12, (depth + 8) / Math.sin(-pitch)) : orbitCursor ? 2 : 12;
  // Distance from the previous target preserves user zoom while the cursor moves.
  const range = lastFollowTarget
    ? Math.max(minRange, C.Cartesian3.distance(camera.positionWC, lastFollowTarget))
    : Math.max(minRange, Math.min(250, Math.max(35, C.Cartesian3.distance(camera.positionWC, target))));
  const cameraHeading = followMode === 'direction' ? C.Math.toRadians(heading) : camera.heading;
  camera.lookAt(target, new C.HeadingPitchRange(cameraHeading, pitch, range));
  if (!orbitCursor) camera.lookAtTransform(C.Matrix4.IDENTITY);
  lastFollowTarget = target;
}

// Cesium's default zoom scales with the picked building/terrain distance. Use only
// camera height (or cursor range in orbit mode) so geometry under the pointer
// cannot change the editor's zoom speed.
function zoomCamera(steps: number) {
  if (!viewer || !Number.isFinite(steps) || steps === 0) return;
  const camera = viewer.camera;
  const cursorRange = C.Cartesian3.distance(camera.positionWC, drawPoint(ownCursor));
  const height = Math.abs(camera.positionCartographic.height);
  const reference = Math.max(5, Math.min(20_000, orbitCursor ? cursorRange : height));
  const amount = reference * (1 - Math.exp(-Math.max(-3, Math.min(3, steps)) * 0.18));
  camera.zoomIn(orbitCursor && amount > 0 ? Math.min(amount, Math.max(0, cursorRange - 2)) : amount);
}

async function saveCurrent() {
  try {
    if (!socket?.connected) throw new Error('협업 서버 연결이 끊겨 있습니다. 연결이 복구된 뒤 저장하세요.');
    if (roadDraft) {
      const attrs = attrsFromUI((roadDraft.attrs.roadClass as RoadClass) ?? (tool as RoadClass));
      const coords = selectedRoad && selectedVertex >= 0 ? roadDraft.coordinates : roadDraft.coordinates;
      if (coords.length < 2) throw new Error('도로를 저장하려면 Space로 두 점 이상 추가하세요.');
      if (attrs.structure === 'elevator' && (coords.length !== 2 || Math.hypot(coords[1][0] - coords[0][0], coords[1][1] - coords[0][1]) > 0.3 || Math.abs(coords[1][2] - coords[0][2]) < 0.5)) {
        throw new Error('엘리베이터는 같은 위치에서 높이만 다른 두 점입니다. Space로 첫 점을 찍고 R/F로 높이를 바꾼 뒤 Space로 둘째 점을 찍으세요(층 사이마다 하나씩).');
      }
      const preview = await request<{ crossings: any[]; selfCrossings: any[]; needsLease: { id: string; revision: number }[] }>('/api/v1/editor/topology-preview', { method: 'POST',
        body: JSON.stringify({ coordinates: coords, levelId: attrs.levelId, branchFrom: roadDraft.branchFrom }) });
      acquiredAffected = [];
      for (const item of preview.needsLease) {
        const lease = await acquire('road', item.id); heartbeat(lease); acquiredAffected.push(lease);
      }
      const affected = preview.needsLease.map((item) => ({ ...item, leaseToken: acquiredAffected.find((l) => l.objectId === item.id)!.leaseToken }));
      const result = await request<{ roadId: string }>('/api/v1/editor/road-changesets', { method: 'POST', body: JSON.stringify({ id: roadDraft.id, ...attrs,
        coordinates: coords, expectedRevision: roadDraft.expectedRevision, leaseToken: roadDraft.leaseToken, sessionId: EDITOR_SESSION,
        branchFrom: roadDraft.branchFrom,
        affected: affected.map((a) => ({ ...a, sessionId: EDITOR_SESSION })), mutationId: uuid() }) });
      socket?.emit('editor:draft:clear', { objectType: 'road', objectId: roadDraft.id, leaseToken: roadDraft.leaseToken });
      for (const l of acquiredAffected) { clearInterval(leaseTimers.get(`road:${l.objectId}`)); leaseTimers.delete(`road:${l.objectId}`); }
      clearInterval(leaseTimers.get(`road:${roadDraft.id}`)); leaseTimers.delete(`road:${roadDraft.id}`);
      acquiredAffected = [];
      if (draftSendTimer) clearTimeout(draftSendTimer);
      draftSendTimer = null;
      roadDraft = null; selectedRoad = null; dirty = false; selectedVertex = -1; setTool('select');
      await loadSnapshot(); selectRoad(result.roadId);
      say(`저장했습니다. 기존 도로 교차 ${preview.crossings.length}곳, 자기 교차 ${preview.selfCrossings.length}곳을 연결했습니다.`, 'success');
    } else if (placeDraft) {
      const result = await request<{ placeId: string }>('/api/v1/editor/places', { method: 'POST', body: JSON.stringify({ id: placeDraft.id,
        name: $('place-name').value.trim(), category: $('place-category').value, description: $('place-description').value.trim() || null,
        buildingId: $('place-building').value.trim() || null, levelId: $('place-level').value.trim() || null, coordinate: ownCursor,
        expectedRevision: placeDraft.expectedRevision, leaseToken: placeDraft.leaseToken, sessionId: EDITOR_SESSION, mutationId: uuid() }) });
      clearInterval(leaseTimers.get(`place:${placeDraft.id}`)); leaseTimers.delete(`place:${placeDraft.id}`);
      socket?.emit('editor:draft:clear', { objectType: 'place', objectId: placeDraft.id, leaseToken: placeDraft.leaseToken });
      if (draftSendTimer) clearTimeout(draftSendTimer);
      draftSendTimer = null;
      placeDraft = null; selectedPlace = null; dirty = false; setTool('select'); await loadSnapshot(); selectPlace(result.placeId); say('장소를 저장했습니다.', 'success');
    }
  } catch (err) {
    for (const l of acquiredAffected) await release(l);
    acquiredAffected = [];
    say((err as Error).message, 'error');
  }
}

async function deleteSelection() {
  const objectType: ObjectType | null = selectedRoad ? 'road' : selectedPlace ? 'place' : null;
  const selected: any = selectedRoad ?? selectedPlace;
  if (!objectType || !selected) return;
  let lease: Lease | null = null;
  try {
    lease = await acquire(objectType, selected.id); heartbeat(lease);
    await request(`/api/v1/editor/${objectType === 'road' ? 'roads' : 'places'}/${selected.id}`, { method: 'DELETE',
      body: JSON.stringify({ expectedRevision: selected.revision, sessionId: EDITOR_SESSION, leaseToken: lease.leaseToken, mutationId: uuid() }) });
    clearInterval(leaseTimers.get(`${objectType}:${selected.id}`)); leaseTimers.delete(`${objectType}:${selected.id}`);
    selectedRoad = null; selectedPlace = null; await loadSnapshot(); say('객체를 보관 처리했습니다.', 'success');
  } catch (err) {
    clearInterval(leaseTimers.get(`${objectType}:${selected.id}`)); leaseTimers.delete(`${objectType}:${selected.id}`);
    if (lease) await release(lease);
    say((err as Error).message, 'error');
  }
}

async function loadSessions() {
  try {
    const sessions = await request<any[]>('/api/v1/sessions?limit=500');
    const select = $('fusion-session');
    select.innerHTML = '<option value="">세션 선택</option>' + sessions.map((s) => `<option value="${esc(s.sessionId)}">${esc(s.collectorId)} · ${new Date(s.startedAt).toLocaleString()}</option>`).join('');
  } catch { /* track reference is optional */ }
}
async function loadRuns(sessionId: string) {
  $('fusion-run').innerHTML = '<option value="">Fusion 실행 선택</option>'; snapPoints = [];
  refreshSnapSources(); drawFusionOverlay();
  if (!sessionId) return;
  const runs = await request<any[]>(`/api/v1/sessions/${sessionId}/runs`);
  if (sessionId !== $('fusion-session').value) return;
  $('fusion-run').innerHTML = '<option value="">Fusion 실행 선택</option>' + runs.filter((r) => r.status === 'COMPLETED').map((r) => `<option value="${esc(r.id)}">${esc(r.algorithmVersion)} r${esc(r.revision ?? '?')} · ${new Date(r.startedAt).toLocaleString()}</option>`).join('');
}
async function loadRun(runId: string) {
  snapPoints = [];
  refreshSnapSources(); drawFusionOverlay();
  if (runId) {
    const points = await request<RunPoint[]>(`/api/v1/runs/${runId}/positions?stage=FINAL`);
    if (runId !== $('fusion-run').value) return;
    snapPoints = points;
  }
  drawFusionOverlay(); refreshSnapSources();
}
function drawFusionOverlay() {
  for (const e of entities.filter((e) => (e as any).__fusion)) viewer.entities.remove(e);
  entities = entities.filter((e) => !(e as any).__fusion);
  if (!$<HTMLInputElement>('fusion-overlay').checked || !snapPoints.length) return;
  const pts = snapPoints.map((p) => {
    const x = p.x + ORIGIN.x, y = p.y + ORIGIN.y;
    const z = p.h ?? terrainAt(x, y) ?? 0;
    return drawPoint([x, y, z]);
  });
  const line = viewer.entities.add({ polyline: { positions: pts, width: 2, material: C.Color.fromCssColorString('#64748b').withAlpha(0.55), arcType: C.ArcType.NONE } });
  (line as any).__fusion = true; entities.push(line);
  snapPoints.forEach((p) => {
    const x = p.x + ORIGIN.x, y = p.y + ORIGIN.y, z = p.h ?? terrainAt(x, y) ?? 0;
    const dot = viewer.entities.add({ position: drawPoint([x, y, z]), point: { pixelSize: 4, color: C.Color.fromCssColorString('#94a3b8').withAlpha(0.75), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    (dot as any).__fusion = true; entities.push(dot);
  });
}

function setRemoteCursor(payload: any) {
  const priorPeer = connectedPeers.get(payload.socketId);
  const agent: string | undefined = payload.agent ?? priorPeer?.agent;
  connectedPeers.set(payload.socketId, { collectorId: payload.collectorId, sessionId: payload.sessionId, agent });
  const cursorColor = agent ? C.Color.fromCssColorString('#d946ef') : C.Color.CYAN;
  if (!priorPeer) renderLists();
  if (!payload.coordinate) return;
  let e = remoteCursors.get(payload.socketId);
  const pos = drawPoint(payload.coordinate as XYZ);
  if (!e) {
    e = viewer.entities.add({ position: pos, point: { pixelSize: agent ? 13 : 10, color: cursorColor, outlineColor: C.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: agent ? `🤖 ${agent}` : payload.collectorId, font: '11px system-ui', pixelOffset: new C.Cartesian2(0, -13), fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    remoteCursors.set(payload.socketId, e);
  } else e.position = pos;
  const angle = Number(payload.heading ?? 0) * Math.PI / 180;
  const end: XYZ = [payload.coordinate[0] + Math.sin(angle) * 1.4, payload.coordinate[1] + Math.cos(angle) * 1.4, payload.coordinate[2]];
  let direction = remoteDirections.get(payload.socketId);
  if (!direction) {
    direction = viewer.entities.add({ show: !agent, polyline: { positions: [drawPoint(payload.coordinate), drawPoint(end)], width: 3, material: C.Color.CYAN } });
    remoteDirections.set(payload.socketId, direction);
  } else direction.polyline.positions = [drawPoint(payload.coordinate), drawPoint(end)];
}
function removeRemoteCursor(socketId: string) {
  const e = remoteCursors.get(socketId), d = remoteDirections.get(socketId);
  if (e) viewer.entities.remove(e); if (d) viewer.entities.remove(d);
  remoteCursors.delete(socketId); remoteDirections.delete(socketId); connectedPeers.delete(socketId); renderLists();
}
function setRemoteDraft(p: any) {
  const key = `${p.objectType}:${p.objectId}`;
  let e = remoteDrafts.get(key);
  const coords: XYZ[] = p.draft?.coordinates ?? (p.draft?.coordinate ? [p.draft.coordinate] : []);
  if (!coords.length) {
    if (e) viewer.entities.remove(e);
    remoteDrafts.delete(key);
    return;
  }
  const positions = coords.map(drawPoint);
  const draftName = typeof p.draft?.attrs?.name === 'string' ? p.draft.attrs.name.trim().slice(0, 60) : '';
  if (e) viewer.entities.remove(e);
  e = viewer.entities.add({ polyline: positions.length > 1 ? { positions, width: 4, material: C.Color.CYAN.withAlpha(0.8), arcType: C.ArcType.NONE } : undefined,
    position: positions[0], point: positions.length === 1 ? { pixelSize: 9, color: C.Color.CYAN } : undefined,
    label: { text: `${p.collectorId} · ${draftName ? `${draftName} · ` : ''}편집 중`, font: '11px system-ui', pixelOffset: new C.Cartesian2(0, -10), fillColor: C.Color.CYAN, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  remoteDrafts.set(key, e);
}

function installSocket() {
  socket = io(`${API_BASE_URL}/editor`, { transports: ['websocket', 'polling'], auth: { token: token(), sessionId: EDITOR_SESSION } });
  socket.on('connect', () => { $('editor-connection').textContent = '협업 연결됨'; $('editor-connection').classList.remove('offline'); sendCursor(); publishDraft();
    void loadSnapshot().then(() => { if (tool === 'junction') scheduleJunctionPreview(); })
      .catch((err) => say(`도로 목록을 불러오지 못했습니다: ${(err as Error).message}`, 'warning')); });
  socket.on('disconnect', () => {
    $('editor-connection').textContent = '오프라인 · 저장 중지'; $('editor-connection').classList.add('offline');
    for (const e of remoteDrafts.values()) viewer.entities.remove(e);
    remoteDrafts.clear();
    for (const e of remoteCursors.values()) viewer.entities.remove(e);
    for (const e of remoteDirections.values()) viewer.entities.remove(e);
    remoteCursors.clear(); remoteDirections.clear(); connectedPeers.clear();
    for (const key of [...agentOverlays.keys()]) clearAgentOverlay(key);
    lastSentSelection = '';
    renderLists(); updateControls();
  });
  socket.on('editor:overlay:snapshot', (list: any[]) => { for (const o of list) drawAgentOverlay(o); });
  socket.on('editor:overlay:set', drawAgentOverlay);
  socket.on('editor:overlay:clear', (p: any) => clearAgentOverlay(p.key));
  socket.on('editor:view:focus', (p: any) => {
    const who = `🤖 ${p.agent}${p.label ? ` · ${p.label}` : ''}`;
    if (!$('editor-ai-follow').checked) { say(`${who} 위치를 보여 주려 합니다. 따라가려면 상단의 'AI 화면 안내'를 켜세요.`); return; }
    const target = drawPoint(p.coordinate as XYZ);
    const pitch = Math.max(C.Math.toRadians(-85), Math.min(C.Math.toRadians(-30), viewer.camera.pitch));
    viewer.camera.lookAt(target, new C.HeadingPitchRange(viewer.camera.heading, pitch, Math.max(10, Number(p.rangeM) || 80)));
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    lastFollowTarget = null;
    say(`${who} 위치로 화면을 옮겼습니다.`);
  });
  socket.on('connect_error', (err) => { $('editor-connection').textContent = `연결 실패 · ${err.message}`; $('editor-connection').classList.add('offline'); updateControls(); });
  socket.on('editor:presence:snapshot', (list: any[]) => { for (const p of list) if (p.socketId !== socket?.id) { connectedPeers.set(p.socketId, p); if (p.cursor) setRemoteCursor(p); } renderLists(); });
  socket.on('editor:presence:joined', (p: any) => { connectedPeers.set(p.socketId, p); renderLists(); void loadSnapshot().catch(() => undefined); });
  socket.on('editor:presence:left', (p: any) => removeRemoteCursor(p.socketId));
  socket.on('editor:cursor:update', setRemoteCursor);
  socket.on('editor:draft:update', setRemoteDraft);
  socket.on('editor:draft:snapshot', (drafts: any[]) => { for (const draft of drafts) setRemoteDraft(draft); });
  socket.on('editor:draft:clear', (p: any) => { const key = `${p.objectType}:${p.objectId}`; const e = remoteDrafts.get(key); if (e) viewer.entities.remove(e); remoteDrafts.delete(key); });
  socket.on('editor:lease:changed', (p: any) => { if (p.action === 'released') leases = leases.filter((l) => !(l.objectType === p.objectType && l.objectId === p.objectId)); else { leases = leases.filter((l) => !(l.objectType === p.objectType && l.objectId === p.objectId)); leases.push(p); } renderLists(); });
  socket.on('editor:feature:changed', (p: any) => {
    const draft = remoteDrafts.get(`${p.objectType}:${p.objectId}`);
    if (draft) viewer.entities.remove(draft);
    remoteDrafts.delete(`${p.objectType}:${p.objectId}`);
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { void loadSnapshot().then(() => { if (tool === 'junction') scheduleJunctionPreview(); }).catch(() => undefined); }, 180);
  });
}

function installControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.onclick = () => { setTool(b.dataset.tool!); viewer.scene.canvas.focus(); });
  $('editor-cancel').onclick = () => { clearDraft(); setTool('select'); say('편집 초안을 취소했습니다.'); };
  $('editor-save').onclick = () => void saveCurrent(); $('editor-delete').onclick = () => void deleteSelection();
  $('editor-edit').onclick = () => void startEditingSelection();
  $('editor-follow').onclick = () => { followMode = followMode === 'off' ? 'position' : followMode === 'position' ? 'direction' : 'off'; $('editor-follow').textContent = `카메라 추적 ${followMode === 'off' ? '꺼짐' : followMode === 'position' ? '위치' : '위치+방향'}`; if (followMode !== 'off' || orbitCursor) followCursor(); else lastFollowTarget = null; };
  $<HTMLInputElement>('editor-orbit').onchange = () => {
    orbitCursor = $<HTMLInputElement>('editor-orbit').checked;
    if (orbitCursor) followCursor();
    else {
      viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
      if (followMode === 'off') lastFollowTarget = null;
    }
  };
  $('editor-logout').onclick = () => { clearHeldKeys(); clearDraft(); for (const timer of leaseTimers.values()) clearInterval(timer); leaseTimers.clear(); socket?.disconnect(); socket = null; localStorage.removeItem(TOKEN_KEY); $('editor-login').hidden = false; };
  $('vertex-prev').onclick = () => { if (selectedRoad && selectedVertex > 0) { selectedVertex--; ownCursor = [...selectedRoad.geometry.coordinates[selectedVertex]]; rebaseSnapGuide(); drawAll(); if (followMode !== 'off' || orbitCursor) followCursor(); sendCursor(); } };
  $('vertex-next').onclick = () => { if (selectedRoad && selectedVertex >= 0 && selectedVertex < selectedRoad.geometry.coordinates.length - 1) { selectedVertex++; ownCursor = [...selectedRoad.geometry.coordinates[selectedVertex]]; rebaseSnapGuide(); drawAll(); if (followMode !== 'off' || orbitCursor) followCursor(); sendCursor(); } };
  $('vertex-delete').onclick = () => { if (!roadDraft || selectedVertex < 0 || roadDraft.coordinates.length <= 2) return; pushUndo(); roadDraft.coordinates.splice(selectedVertex, 1); selectedRoad!.geometry.coordinates = roadDraft.coordinates; selectedVertex = Math.min(selectedVertex, roadDraft.coordinates.length - 1); ownCursor = [...roadDraft.coordinates[selectedVertex]]; rebaseSnapGuide(); dirty = true; drawAll(); if (followMode !== 'off' || orbitCursor) followCursor(); publishDraft(); };
  $('vertex-undo-last').onclick = undoLastVertex;
  $('junction-save').onclick = () => void defineJunction();
  $('cursor-x').onchange = () => setCursor([Number($('cursor-x').value), ownCursor[1], ownCursor[2]]);
  $('cursor-y').onchange = () => setCursor([ownCursor[0], Number($('cursor-y').value), ownCursor[2]]);
  $('cursor-z').onchange = () => setCursor([ownCursor[0], ownCursor[1], Number($('cursor-z').value)]);
  $('cursor-heading').onchange = () => { heading = Number($('cursor-heading').value); drawCursorOnly(); updateReadouts(); if (followMode === 'direction') followCursor(); sendCursor(); };
  for (const id of ['road-name','road-structure','ped-access','veh-access','ped-dir','veh-dir','road-width','wheelchair','building-id','level-id']) $(id).addEventListener('change', () => { if (roadDraft) { roadDraft.attrs = attrsFromUI(); dirty = true; updateControls(); publishDraft(); } });
  for (const id of ['place-name', 'place-category', 'place-description', 'place-building', 'place-level']) {
    $(id).addEventListener('input', () => { updateControls(); if (placeDraft) publishDraft(); });
  }
  $('fusion-session').onchange = () => void loadRuns($('fusion-session').value).catch((e) => say((e as Error).message, 'error'));
  $('fusion-run').onchange = () => void loadRun($('fusion-run').value).catch((e) => say((e as Error).message, 'error'));
  $('fusion-overlay').onchange = drawFusionOverlay;
  $('fusion-snap').onchange = refreshSnapSources;
  $('road-vertex-snap').onchange = refreshSnapSources;
  $('snap-mode').onchange = refreshSnapSources;
  $('snap-lock').onchange = () => {
    if (!$<HTMLInputElement>('snap-lock').checked) {
      lockedSnapTarget = null;
      updateLockMarker();
      setCursor(snapGuide ? [...snapGuide] : [...ownCursor]);
      return;
    }
    const target = nearestSnapTarget(snapGuide ?? ownCursor, snapMode());
    if (!target) {
      $<HTMLInputElement>('snap-lock').checked = false;
      say('현재 커서에서 2.5 m 이내에 사용할 도로 Vertex 또는 Fusion 점이 없습니다.', 'warning');
      updateReadouts();
      return;
    }
    lockedSnapTarget = target;
    snapGuide = snapGuide ?? [...ownCursor];
    updateLockMarker();
    setCursor([...snapGuide]);
  };

  keyHandler = (e: KeyboardEvent) => {
    if (['ControlLeft','ControlRight','MetaLeft','MetaRight','AltLeft','AltRight'].includes(e.code)) { clearHeldKeys(); return; }
    if (!$('editor-login').hidden || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable || e.isComposing) return;
    const shortcut = (e.metaKey || e.ctrlKey) && ['KeyZ','KeyY','KeyS'].includes(e.code);
    const handled = movementKeys.has(e.code) || e.code === 'Space' || shortcut || e.code === 'Delete' || e.code === 'Backspace';
    if (!handled) return;
    if (e.metaKey || e.ctrlKey || e.altKey) {
      clearHeldKeys();
      if (!shortcut) return;
    }
    e.preventDefault();
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { e.shiftKey ? redo() : undo(); return; }
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyY') { redo(); return; }
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') { void saveCurrent(); return; }
    if ((e.code === 'Space') && !e.repeat) { if (roadDraft) commitVertex(); else say('Vertex를 추가하려면 도로 작도 모드를 선택하세요.'); return; }
    if (e.code === 'Delete' || e.code === 'Backspace') {
      if (!e.repeat && e.code === 'Backspace' && roadDraft && !selectedRoad) undoLastVertex();
      else if (!e.repeat && roadDraft && selectedVertex >= 0) $('vertex-delete').click();
      return;
    }
    if (movementKeys.has(e.code) && !heldKeys.has(e.code)) {
      heldKeys.add(e.code);
      stepMove();
      if (!movementTimer) movementTimer = setInterval(stepMove, 90);
    }
  };
  window.addEventListener('keydown', keyHandler);
  window.addEventListener('keyup', (e) => {
    heldKeys.delete(e.code);
    if (!heldKeys.size) clearHeldKeys();
  });
  window.addEventListener('blur', clearHeldKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearHeldKeys(); });
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) clearHeldKeys();
  });

  mouseHandler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
  let rightDragging = false;
  mouseHandler.setInputAction(() => { rightDragging = true; }, C.ScreenSpaceEventType.RIGHT_DOWN);
  mouseHandler.setInputAction(() => { rightDragging = false; }, C.ScreenSpaceEventType.RIGHT_UP);
  mouseHandler.setInputAction((movement: any) => {
    if (rightDragging) zoomCamera((movement.endPosition.y - movement.startPosition.y) / 70);
  }, C.ScreenSpaceEventType.MOUSE_MOVE);
  window.addEventListener('mouseup', (event) => { if (event.button === 2) rightDragging = false; });
  viewer.scene.canvas.addEventListener('wheel', (event: WheelEvent) => {
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewer.scene.canvas.clientHeight : 1);
    zoomCamera(-pixels / 100);
  }, { passive: false });
  mouseHandler.setInputAction((movement: any) => {
    const hits = viewer.scene.drillPick(movement.position, 8, 8);
    const feature = tool === 'select' ? hits.map((h: any) => h.id?.id).find((id: unknown) =>
      typeof id === 'string' && /^editor:(road|place):/.test(id)) : null;
    if (feature?.startsWith('editor:road:')) { selectRoad(feature.slice('editor:road:'.length)); setTool('select'); return; }
    if (feature?.startsWith('editor:place:')) { selectPlace(feature.slice('editor:place:'.length)); setTool('select'); return; }
    const ray = viewer.camera.getPickRay(movement.position);
    const hit = ray && viewer.scene.globe.pick(ray, viewer.scene);
    if (!hit) return;
    const carto = C.Cartographic.fromCartesian(hit); const g = tmForward(C.Math.toDegrees(carto.latitude), C.Math.toDegrees(carto.longitude));
    const dem = terrainAt(g.x, g.y);
    setCursor([g.x, g.y, dem ?? carto.height]);
    if (tool === 'place' && placeDraft) { placeDraft.coordinates = [[...ownCursor]]; dirty = true; $('editor-save').disabled = !$('place-name').value.trim(); publishDraft(); }
    viewer.scene.canvas.focus(); drawAll();
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  viewer.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  mouseHandler.setInputAction((movement: any) => {
    const vertexId = viewer.scene.drillPick(movement.position, 8, 8)
      .map((hit: any) => hit.id?.id).find((id: unknown) => typeof id === 'string'
        && (id.startsWith('editor:vertex:') || id.startsWith('editor:draft-vertex:')));
    if (!vertexId) { zoomCamera(1); return; }
    if (roadDraft || placeDraft || vertexId.startsWith('editor:draft-vertex:')) {
      say('현재 편집 중인 도로를 먼저 저장하거나 취소한 뒤 분기하세요.', 'warning'); return;
    }
    const match = /^editor:vertex:([0-9a-f-]+):(\d+)$/.exec(vertexId);
    if (match) void branchFromVertex(match[1], Number(match[2]));
  }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  controlsInstalled = true;
}

async function startEditor() {
  $('editor-login').hidden = true;
  $('editor-user').textContent = userCode();
  if (viewer) {
    if (!controlsInstalled) installControls();
    socket?.disconnect(); socket = null;
    installSocket(); await loadSnapshot(); await loadSessions();
    return;
  }
  const result = await initCampusMap('editor-map');
  viewer = result.viewer; C = (window as any).Cesium;
  // The terrain-grid endpoint is binary; read it directly, matching the Preview's grid DTO.
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/terrain/grid`);
    const meta = JSON.parse(res.headers.get('X-Grid') ?? 'null');
    if (res.ok && meta) terrain = { ...meta, heights: new Float32Array(await res.arrayBuffer()) } as TerrainGrid;
  } catch { /* the DEM is a cursor-height aid; map rendering can still continue */ }
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
  viewer.scene.screenSpaceCameraController.enableZoom = false;
  viewer.scene.screenSpaceCameraController.minimumPickingTerrainHeight = -1_000_000;
  viewer.scene.canvas.setAttribute('tabindex', '0');
  ownCursor[2] = terrainAt(ownCursor[0], ownCursor[1]) ?? ownCursor[2];
  viewer.scene.canvas.addEventListener('click', () => viewer.scene.canvas.focus());
  installControls(); installSocket(); await loadSnapshot(); await loadSessions();
  setTool('select');
  if (result.warning) say(result.warning, 'warning');
  $('editor-logout').title = `${userCode()} · tracker account`;
}

if (token()) void startEditor().catch((err) => { $('editor-login').hidden = false; $('login-error').textContent = (err as Error).message; });
