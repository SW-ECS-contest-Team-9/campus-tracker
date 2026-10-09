import './editor.css';
import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL } from './api';
import { initCampusMap, type CampusSceneLayer } from './campus-map';
import { tmForward, tmInverse } from './tm';
import type { TerrainGrid } from './api';
import { NavController, loadPrefs, savePrefs, smoothstep, distanceToPolyline, type ViewPrefs, type NavPreset, type EndpointMode, type ColorMode } from './editor-view';
import { floorColor, floorFromHeight, floorFromLevelId, floorLabel } from './floor-colors';
import { cursorAxes, xrayAlpha, XrayPaths } from './editor-visibility';

type XYZ = [number, number, number];
type RoadClass = 'pedestrian' | 'vehicle' | 'shared';
type ObjectType = 'road' | 'place';
type Road = {
  id: string; name: string | null; roadClass: RoadClass; structure: string; pedestrianAccess: string; vehicleAccess: string;
  pedestrianDirection: string; vehicleDirection: string; widthM: number | null; wheelchairAccess: string;
  buildingId: string | null; levelId: string | null; status: string; revision: number;
  /** shared display colour (#rrggbb) set by any editor or agent; null = automatic */
  displayColor?: string | null;
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
      <span class="editor-status">WASD 이동 · Q/E 회전 · Space 꼭지점 · R/F 높이 · Enter 저장 · Esc 취소 · ? 단축키</span>
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
        <section class="editor-section"><h2>보기 · 조작</h2>
          <label class="editor-field">마우스 조작 방식<select id="nav-preset">
            <option value="cesium">기본 · 좌 이동 / 중·Ctrl+좌 회전 / 우·휠 줌</option>
            <option value="blender">Blender · 중 회전 / Shift+중 이동 / Ctrl+중 줌</option>
            <option value="cad">CAD · 중 이동 / Shift+중 회전 / 중 더블클릭 전체</option></select></label>
          <label class="editor-field">회전 감도 <b id="sens-rotate-v"></b><input id="sens-rotate" type="range" min="0.1" max="3" step="0.1"></label>
          <label class="editor-field">이동 감도 <b id="sens-pan-v"></b><input id="sens-pan" type="range" min="0.1" max="3" step="0.1"></label>
          <label class="editor-field">줌 감도 <b id="sens-zoom-v"></b><input id="sens-zoom" type="range" min="0.1" max="3" step="0.1"></label>
          <label class="inline-check"><input id="zoom-pointer" type="checkbox"> 마우스 위치로 줌</label>
          <label class="inline-check"><input id="zoom-invert" type="checkbox"> 줌 방향 반전</label>
          <div class="editor-hint">Blender/CAD 방식에서는 Alt+좌 드래그가 가운데 버튼을 대신합니다(노트북용). 설정은 이 브라우저에만 저장됩니다.</div>
          <div class="feature-actions"><button id="nav-help-btn" type="button">단축키 보기 (?)</button></div>
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
          <h3 class="editor-subhead">동선 묶음 → 통로 변환</h3>
          <div class="feature-actions"><button id="corridor-add" type="button" title="위에서 고른 Fusion 실행을 변환 대상에 추가">현재 실행 추가</button><button id="corridor-clear" type="button">비우기</button></div>
          <div id="corridor-list" class="corridor-list"></div>
          <div class="editor-row"><label class="editor-field">높이 기준<select id="corridor-z"><option value="run">기록 높이 − 폰 높이</option><option value="terrain">지형 높이</option></select></label><label class="editor-field">폰 높이 m<input id="corridor-phone" type="number" min="0" max="2.5" step="0.1" value="1.1"></label></div>
          <div class="feature-actions"><button id="corridor-preview" type="button">미리보기</button><button id="corridor-draft" type="button" disabled>통로로 작도</button></div>
          <div id="corridor-info" class="editor-hint">같은 통로를 걸은 실행 여러 개를 추가하면 중앙선·폭을 추정해 하나의 실내 통로로 만듭니다.</div>
        </section>
        <section class="editor-section"><h2>함께 작업 중</h2><div id="presence-list" class="presence-list"></div></section>
      </aside>
      <main id="editor-map-wrap" class="editor-map"><div id="editor-map" tabindex="0"></div><div class="editor-crosshair"></div><div id="editor-heading" class="editor-heading" aria-label="커서 진행 방향"><span id="editor-heading-arrow" class="editor-heading-arrow">↑</span><span id="editor-heading-value">북 0°</span></div><div id="coordinate-bar" class="editor-coordinate-bar">지도를 클릭하여 커서 위치 지정</div>
        <div class="editor-viewbar" aria-label="보기 전환">
          <button data-view="top" title="위에서 보기 (7)">위</button><button data-view="front" title="앞에서 보기 (1)">앞</button>
          <button data-view="right" title="오른쪽에서 보기 (3)">우</button><button data-view="flip" title="반대편에서 보기 (9)">반대</button>
          <button id="view-ortho" data-view="ortho" title="원근/정사영 전환 (5)">원근</button>
          <button data-view="frame-selected" title="선택 맞춤 (. / Numpad .)">선택 맞춤</button><button data-view="frame-all" title="전체 맞춤 (Home)">전체</button>
          <button id="view-isolate" data-view="isolate" title="선택 경로만 보기 (/)">단독</button>
        </div>
        <div id="editor-hover-tip" class="editor-hover-tip" hidden></div></main>
      <aside class="editor-inspector">
        <section class="editor-section"><h2>작업</h2><div id="editor-message" class="editor-hint">도로/장소 도구를 고르고 지도를 클릭한 뒤 Space로 점을 추가하세요.</div>
          <div class="feature-actions"><button id="editor-edit" disabled>선택 편집</button><button id="editor-save" class="active" disabled>저장</button><button id="editor-delete" disabled>삭제</button></div>
          <div id="selected-info" class="editor-hint" style="margin-top:8px"></div>
        </section>
        <section class="editor-section"><h2>경로 표시</h2>
          <div id="road-color-row" class="editor-color-row" hidden><label class="editor-field">선택 경로 색 · 모든 편집자와 공유<input id="road-color" type="color"></label><button id="road-color-reset" type="button" title="공유 색을 지우고 자동 색으로">자동</button></div>
          <label class="editor-field">자동 색 기준<select id="color-mode"><option value="floor">층별 (낮을수록 어둡게)</option><option value="type">도로 유형별</option></select></label>
          <div class="editor-row"><label class="editor-field">층고 m (층 추정)<input id="floor-height" type="number" min="2" max="8" step="0.1"></label><label class="editor-field">통로 높이 m<input id="tube-height" type="number" min="1" max="6" step="0.1"></label></div>
          <label class="inline-check"><input id="solids" type="checkbox"> 실내 통로 사각튜브 · 엘리베이터 샤프트 표시</label>
          <label class="editor-field">건물 불투명도 <b id="building-opacity-v"></b><input id="building-opacity" type="range" min="0" max="1" step="0.05"></label>
          <label class="inline-check"><input id="xray-paths" type="checkbox"> 건물·지형 너머 통로 표시</label>
          <div class="editor-hint">관통 표시를 켜면 먼 거리에서도 통로 중심선이 보입니다. 앞·뒤·좌·우는 커서 머리 방향 기준이며 각 축은 4m입니다.</div>
          <div id="route-legend" class="route-legend"></div>
          <label class="inline-check"><input id="dim-others" type="checkbox"> 선택 시 다른 경로 흐리게</label>
          <label class="editor-field">다른 경로 불투명도 <b id="dim-alpha-v"></b><input id="dim-alpha" type="range" min="0.05" max="1" step="0.05"></label>
          <label class="editor-field">시작 / 도착점<select id="endpoint-mode"><option value="selected">선택 경로만</option><option value="all">모든 경로</option><option value="off">숨김</option></select></label>
          <label class="inline-check"><input id="depth-fade" type="checkbox"> 카메라 거리별 선 명도</label>
          <div class="editor-row"><label class="editor-field">선명 거리 m<input id="fade-near" type="number" min="0" step="10"></label><label class="editor-field">흐림 거리 m<input id="fade-far" type="number" min="1" step="10"></label></div>
          <label class="editor-field">최소 명도 <b id="fade-min-v"></b><input id="fade-min" type="range" min="0.05" max="1" step="0.05"></label>
          <label class="inline-check"><input id="hover-highlight" type="checkbox"> 마우스 오버 미리 강조</label>
        </section>
        <section class="editor-section"><h2>편집 Vertex</h2><div class="feature-actions"><button id="vertex-prev" disabled>이전</button><button id="vertex-next" disabled>다음</button><button id="vertex-delete" disabled>점 삭제</button></div><div class="feature-actions"><button id="vertex-undo-last" disabled>마지막 점 취소</button><span class="editor-hint">작도 중 Backspace</span></div><div id="vertex-info" class="editor-hint" style="margin-top:8px"></div></section>
        <section class="editor-section"><h2>캠퍼스 도로</h2><div id="road-list" class="feature-list"></div></section>
        <section class="editor-section"><h2>장소</h2><div id="place-list" class="feature-list"></div></section>
        <section class="editor-section"><h2>최근 변경</h2><div id="change-list" class="change-list"></div></section>
      </aside>
    </div>
  </div>
  <div id="editor-help" class="editor-help" hidden><div class="editor-help-card">
    <h2>단축키 · 마우스</h2>
    <table>
      <tr><th colspan="2">편집</th></tr>
      <tr><td><span class="keycap">W A S D</span> <span class="keycap">Q E</span> <span class="keycap">R F</span></td><td>커서 이동 · 머리 회전 · 높이</td></tr>
      <tr><td><span class="keycap">Space</span></td><td>꼭지점 추가</td></tr>
      <tr><td><span class="keycap">Backspace</span> / <span class="keycap">Delete</span></td><td>마지막 점 취소 / 선택 점 삭제</td></tr>
      <tr><td><span class="keycap">Enter</span> · <span class="keycap">Ctrl S</span></td><td>저장 (작도 종료)</td></tr>
      <tr><td><span class="keycap">Esc</span></td><td>작도 취소(변경 시 두 번) · 도구 해제 · 선택 해제</td></tr>
      <tr><td><span class="keycap">Ctrl Z</span> / <span class="keycap">Ctrl Y</span></td><td>실행 취소 / 다시 실행</td></tr>
      <tr><th colspan="2">보기 (숫자패드 또는 숫자열)</th></tr>
      <tr><td><span class="keycap">7</span> <span class="keycap">1</span> <span class="keycap">3</span></td><td>위 · 앞(북쪽 보기) · 오른쪽 · Shift / Ctrl+숫자패드는 반대편</td></tr>
      <tr><td><span class="keycap">9</span> · <span class="keycap">5</span></td><td>반대편 보기 · 원근/정사영 전환</td></tr>
      <tr><td><span class="keycap">4</span> <span class="keycap">6</span> <span class="keycap">8</span> <span class="keycap">2</span></td><td>15° 궤도 회전</td></tr>
      <tr><td><span class="keycap">.</span> · <span class="keycap">Home</span> · <span class="keycap">0</span></td><td>선택 맞춤 · 전체 맞춤 · 커서로 이동</td></tr>
      <tr><td><span class="keycap">/</span></td><td>선택 경로만 보기 (단독)</td></tr>
      <tr><th colspan="2">마우스</th></tr>
      <tr><td>기본</td><td>좌 드래그 이동 · 중 / Ctrl+좌 회전 · 우 드래그 · 휠 줌</td></tr>
      <tr><td>Blender</td><td>중 회전 · Shift+중 이동 · Ctrl+중 줌 · 휠 줌 (Alt+좌 = 중)</td></tr>
      <tr><td>CAD</td><td>중 이동 · Shift+중 회전 · 중 더블클릭 전체 · 휠 마우스 위치 줌</td></tr>
      <tr><td>공통</td><td>목록 항목 더블클릭 = 해당 경로로 이동 · 회전 중심은 마우스 아래 지점(커서 고정 시 커서)</td></tr>
    </table>
    <div class="feature-actions"><button id="editor-help-close" type="button">닫기 (Esc)</button></div>
  </div></div>
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
let cursorAxisEntities: any[] = [];
let buildingScene: CampusSceneLayer | null = null;
let xrayPaths: XrayPaths | null = null;
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
// Local-only view state (editor-view.ts): never emitted over the socket or saved on the server.
const prefs: ViewPrefs = loadPrefs();
let nav: NavController | null = null;
let hoverId: string | null = null;
let isolate = false;
let escArmedAt = 0;
let lastListClick = { id: '', at: 0 };
const roadWorld = new Map<string, any[]>();
type RoadStyle = { line: any; casing: any; fail: any; glow: any };
const roadStyles = new Map<string, RoadStyle>();
const cssColorCache = new Map<string, any>();
const fadeScratch = { a: null as any, b: null as any };
const previewColors = new Map<string, string>(); // colour picker drag, before the shared colour is saved
type CorridorTrack = { runId: string; label: string };
type CorridorResult = { coordinates: XYZ[]; widthM: number | null; stations: number; coverage: number; usedTracks: number; reversedTracks: number; zSource: string; warnings: string[] };
let corridorTracks: CorridorTrack[] = [];
let corridorResult: CorridorResult | null = null;
let corridorEntities: any[] = [];
type FloorInfo = { floor: number; estimated: boolean };
const floorCache = new Map<string, FloorInfo>();

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
  cursorAxes(ownCursor, heading).forEach((axis, i) => {
    const end = drawPoint(axis.end);
    const color = cssColor(axis.color);
    const labelOffsets = [[0, -32], [55, 0], [0, 32], [-55, 0]];
    if (!cursorAxisEntities[i]) cursorAxisEntities[i] = viewer.entities.add({ position: end,
      polyline: { positions: [position, end], width: 3, material: color, depthFailMaterial: color, arcType: C.ArcType.NONE },
      label: { text: axis.label, font: 'bold 12px system-ui', fillColor: color, showBackground: true,
        backgroundColor: cssColor('#14251d').withAlpha(0.9), backgroundPadding: new C.Cartesian2(4, 3),
        pixelOffset: new C.Cartesian2(...labelOffsets[i]), disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new C.DistanceDisplayCondition(0, 500) } });
    else {
      cursorAxisEntities[i].position = end;
      cursorAxisEntities[i].polyline.positions = [position, end];
    }
  });
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
const isConnectorRoad = (r: Road) => r.structure === 'stairs' || r.structure === 'elevator';
/** Floor of a road: the levelId when it names one, otherwise estimated from its height above the terrain (lowest point for stairs/elevators). */
function roadFloor(r: Road): FloorInfo {
  const key = `${r.id}:${r.revision}:${r.levelId}:${prefs.floorHeightM}`;
  const cached = floorCache.get(key);
  if (cached) return cached;
  let info: FloorInfo = { floor: 1, estimated: true };
  const named = floorFromLevelId(r.levelId);
  if (named !== null) info = { floor: named, estimated: false };
  else {
    const c = r.geometry.coordinates;
    const p = isConnectorRoad(r) ? c.reduce((lo, q) => (q[2] < lo[2] ? q : lo), c[0]) : [...c].sort((a, b) => a[2] - b[2])[c.length >> 1];
    const ground = terrain ? terrainAt(p[0], p[1]) : null;
    if (ground !== null && Number.isFinite(ground)) info = { floor: floorFromHeight(p[2], ground, prefs.floorHeightM), estimated: true };
  }
  floorCache.set(key, info);
  return info;
}
/** Shared colour first, then the picker preview, then the automatic colour (floor or road class). */
function roadCss(r: Road) {
  return previewColors.get(r.id) ?? r.displayColor ?? (prefs.colorMode === 'floor' ? floorColor(roadFloor(r).floor) : COLORS[r.roadClass] ?? '#64748b');
}
const CLASS_WIDTH: Record<string, number> = { pedestrian: 4, shared: 5, vehicle: 7 };
function cssColor(css: string) {
  let c = cssColorCache.get(css);
  if (!c) { c = C.Color.fromCssColorString(css) ?? C.Color.GRAY; cssColorCache.set(css, c); }
  return c;
}
function hoveredRoadId() { return hoverId?.startsWith('editor:road:') ? hoverId.slice('editor:road:'.length) : null; }
/** Road colour for this frame: local colour × status × camera-distance fade × dimming when another road is selected. */
function computeRoadStyle(r: Road) {
  let s = roadStyles.get(r.id);
  if (!s) { s = { line: new C.Color(), casing: new C.Color(), fail: new C.Color(), glow: new C.Color() }; roadStyles.set(r.id, s); }
  const focus = selectedRoad?.id ?? null;
  const isFocus = r.id === focus;
  let alpha = r.status === 'APPROVED' ? 1 : 0.8;
  if (!isFocus) {
    const pts = roadWorld.get(r.id);
    if (prefs.depthFade && pts?.length) {
      const d = distanceToPolyline(C, viewer.camera.positionWC, pts, fadeScratch);
      alpha *= 1 - (1 - prefs.fadeMin) * smoothstep(prefs.fadeNear, prefs.fadeFar, d);
    }
    if (focus && (prefs.dimOthers || isolate)) alpha *= isolate ? 0.04 : prefs.dimAlpha;
  }
  C.Color.clone(cssColor(roadCss(r)), s.line);
  if (r.id === hoveredRoadId() && !isFocus) { C.Color.lerp(s.line, C.Color.WHITE, 0.35, s.line); alpha = Math.max(alpha, 0.95); }
  if (isFocus) alpha = 1;
  // Always below 1: Cesium keeps these lines in one translucent batch, so alpha changes only update attributes.
  alpha = Math.min(0.99, Math.max(0.03, alpha));
  s.line.alpha = alpha;
  C.Color.clone(s.line, s.fail); s.fail.alpha = alpha * 0.8;
  C.Color.clone(cssColor('#14251d'), s.casing); s.casing.alpha = Math.min(0.99, 0.9 * alpha);
  C.Color.lerp(cssColor(roadCss(r)), C.Color.WHITE, 0.45, s.glow); s.glow.alpha = 0.9;
}
function updateRoadStyles() {
  if (!viewer) return;
  xrayPaths?.setVisible(prefs.xrayPaths);
  for (const r of roads) if (roadWorld.has(r.id)) {
    computeRoadStyle(r);
    const dimmed = !!selectedRoad && selectedRoad.id !== r.id;
    const style = roadStyles.get(r.id)!;
    xrayPaths?.update(r.id, style.line, xrayAlpha(style.line.alpha, dimmed && prefs.dimOthers, dimmed && isolate));
  }
}
function styleProperty(id: string, key: keyof RoadStyle) {
  return new C.ColorMaterialProperty(new C.CallbackProperty((_t: any, result: any) => {
    const s = roadStyles.get(id);
    return s ? C.Color.clone(s[key], result) : C.Color.clone(C.Color.GRAY, result);
  }, false));
}
function colorCallback(id: string, key: keyof RoadStyle) {
  return new C.CallbackProperty((_t: any, result: any) => {
    const s = roadStyles.get(id);
    return s ? C.Color.clone(s[key], result) : C.Color.clone(C.Color.GRAY, result);
  }, false);
}
/**
 * Line material by road type (shape channel; colour is the floor): crossing = zebra dashes, ramp = long dashes,
 * everything else solid. Stairs add uphill chevrons, sidewalks a light edge, elevators a shaft, corridors a tube.
 */
function roadMaterial(r: Road, key: 'line' | 'fail') {
  if (r.structure === 'crossing') return new C.PolylineDashMaterialProperty({ color: colorCallback(r.id, key), gapColor: C.Color.WHITE.withAlpha(0.95), dashLength: 10 });
  if (r.structure === 'ramp') return new C.PolylineDashMaterialProperty({ color: colorCallback(r.id, key), dashLength: 22, dashPattern: 0b1111111111110000 });
  return styleProperty(r.id, key);
}
/** Plan-view chevrons every ~1.2 m pointing uphill (toward the higher end), lifted 5 cm so they sit on the line. */
function stairChevrons(c: XYZ[]): XYZ[][] {
  const up = c.at(-1)![2] >= c[0][2] ? c : [...c].reverse();
  const out: XYZ[][] = [];
  for (let i = 1; i < up.length; i++) {
    const a = up[i - 1], b = up[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.3) continue;
    const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len, nx = -ty, ny = tx;
    for (let d = 0.6; d < len; d += 1.2) {
      const f = d / len, x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, z = a[2] + (b[2] - a[2]) * f + 0.05;
      out.push([[x - tx * 0.35 + nx * 0.4, y - ty * 0.35 + ny * 0.4, z], [x, y, z], [x - tx * 0.35 - nx * 0.4, y - ty * 0.35 - ny * 0.4, z]]);
    }
  }
  return out;
}
function drawRoad(r: Road) {
  const coords = r.geometry.coordinates;
  if (coords.length < 2) return;
  const positions = coords.map(drawPoint);
  roadWorld.set(r.id, positions);
  computeRoadStyle(r);
  const common = { positions, arcType: C.ArcType.NONE };
  const focus = selectedRoad?.id === r.id;
  const base = r.structure === 'elevator' ? 8 : CLASS_WIDTH[r.roadClass] ?? 5;
  const width = focus ? base + 3 : base;
  const css = roadCss(r);
  if (focus) {
    const s = roadStyles.get(r.id)!;
    const glow = new C.PolylineGlowMaterialProperty({ glowPower: 0.22, taperPower: 1, color: s.glow.clone() });
    addEntity({ polyline: { ...common, width: width + 20, material: glow, depthFailMaterial: glow } });
  }
  // sidewalks get a light edge instead of the dark casing
  const casing = r.structure === 'sidewalk' ? new C.ColorMaterialProperty(C.Color.fromCssColorString('#f4f1e6').withAlpha(0.95)) : styleProperty(r.id, 'casing');
  addEntity({ polyline: { ...common, width: width + (r.roadClass === 'vehicle' ? 5 : 4), material: casing, depthFailMaterial: casing } });
  addEntity({ id: `editor:road:${r.id}`, polyline: { ...common, width, material: roadMaterial(r, 'line'), depthFailMaterial: roadMaterial(r, 'fail') } });
  if (r.structure === 'stairs') for (const chevron of stairChevrons(coords)) {
    addEntity({ polyline: { positions: chevron.map(drawPoint), width: 2.5, arcType: C.ArcType.NONE, material: C.Color.WHITE.withAlpha(0.95), depthFailMaterial: C.Color.WHITE.withAlpha(0.6) } });
  }
  if (!prefs.solids) return;
  const tint = cssColor(css);
  if (r.structure === 'indoor_corridor') {
    // rectangular tube: floor at the centerline, widthM wide, tubeHeightM high
    const w = (r.widthM ?? 2.5) / 2, h = prefs.tubeHeightM;
    addEntity({ id: `editor:road:${r.id}:tube`, polylineVolume: { positions, cornerType: C.CornerType.MITERED,
      shape: [new C.Cartesian2(-w, 0), new C.Cartesian2(w, 0), new C.Cartesian2(w, h), new C.Cartesian2(-w, h)],
      material: tint.withAlpha(focus ? 0.28 : 0.16), outline: true, outlineColor: tint.withAlpha(0.85) } });
  } else if (r.structure === 'elevator') {
    const lo = coords[0][2] <= coords.at(-1)![2] ? coords[0] : coords.at(-1)!, rise = Math.abs(coords.at(-1)![2] - coords[0][2]);
    addEntity({ id: `editor:road:${r.id}:shaft`, position: drawPoint([lo[0], lo[1], lo[2] + rise / 2]),
      box: { dimensions: new C.Cartesian3(1.8, 1.8, rise), material: tint.withAlpha(focus ? 0.3 : 0.18), outline: true, outlineColor: tint.withAlpha(0.9) } });
  }
}
/** Floors present (with estimated ones marked) and the line-shape key. */
function renderLegend() {
  const floors = new Map<number, boolean>();
  for (const r of roads) { const f = roadFloor(r); floors.set(f.floor, (floors.get(f.floor) ?? true) && f.estimated); }
  const floorItems = prefs.colorMode === 'floor'
    ? [...floors.entries()].sort((a, b) => b[0] - a[0]).map(([f, est]) => `<span class="legend-item"><i style="background:${floorColor(f)}"></i>${floorLabel(f)}${est ? '<span class="muted">·추정</span>' : ''}</span>`).join('')
    : (['pedestrian', 'shared', 'vehicle'] as const).map((k) => `<span class="legend-item"><i style="background:${COLORS[k]}"></i>${({ pedestrian: '보행', shared: '혼용', vehicle: '차량' })[k]}</span>`).join('');
  $('route-legend').innerHTML = `<div class="legend-row">${floorItems || '<span class="muted">경로 없음</span>'}</div>
    <div class="legend-row legend-shapes"><span class="legend-item"><b class="shape solid"></b>일반</span><span class="legend-item"><b class="shape sidewalk"></b>인도</span><span class="legend-item"><b class="shape zebra"></b>횡단보도</span>
    <span class="legend-item"><b class="shape dash"></b>경사로</span><span class="legend-item"><b class="shape chevron">›››</b>계단(오르막)</span><span class="legend-item"><b class="shape tube"></b>실내 통로</span><span class="legend-item"><b class="shape shaft"></b>엘리베이터</span>
    <span class="legend-item muted">두께: 보행 &lt; 혼용 &lt; 차량</span></div>`;
}
/** Start/end markers: large labelled rings for the focused road or draft, small dots for the rest ('all'). */
function drawEndpoints(coords: XYZ[], labelled: boolean) {
  if (!coords.length) return;
  const marker = (p: XYZ, css: string, text: string) => addEntity({ position: drawPoint(p),
    point: { pixelSize: labelled ? 22 : 8, color: cssColor(css).withAlpha(labelled ? 0.85 : 0.9), outlineColor: C.Color.WHITE,
      outlineWidth: labelled ? 3 : 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: labelled ? { text, font: 'bold 12px system-ui', pixelOffset: new C.Cartesian2(0, -26), fillColor: C.Color.WHITE,
      showBackground: true, backgroundColor: cssColor(css).withAlpha(0.92), backgroundPadding: new C.Cartesian2(6, 3),
      disableDepthTestDistance: Number.POSITIVE_INFINITY } : undefined });
  marker(coords[0], '#16a34a', '시작');
  if (coords.length >= 2) marker(coords.at(-1)!, '#dc2626', '도착');
}
function drawAll() {
  if (!viewer) return;
  cleanMapEntities();
  roadWorld.clear();
  for (const r of roads) drawRoad(r);
  xrayPaths?.replace(roads.filter((r) => roadWorld.has(r.id)).map((r) => ({
    id: r.id, positions: roadWorld.get(r.id)!, width: selectedRoad?.id === r.id ? 6 : 4,
    color: roadStyles.get(r.id)!.line,
  })));
  xrayPaths?.setVisible(prefs.xrayPaths);
  renderLegend();
  if (prefs.endpoints === 'all') for (const r of roads) if (r.id !== selectedRoad?.id) drawEndpoints(r.geometry.coordinates, false);
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
  const focusCoords = roadDraft?.coordinates ?? selectedRoad?.geometry.coordinates;
  if (focusCoords && prefs.endpoints !== 'off') drawEndpoints(focusCoords, true);
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
  $('road-color-row').hidden = !selectedRoad;
  if (selectedRoad && !$('road-color').matches(':focus')) $('road-color').value = toHexColor(roadCss(selectedRoad));
  $('view-isolate').classList.toggle('active', isolate);
  $('selected-info').textContent = selectedRoad ? `${selectedRoad.name || '이름 없는 도로'} · ${selectedRoad.roadClass} · ${selectedRoad.status} r${selectedRoad.revision}` : selectedPlace ? `${selectedPlace.name} · ${selectedPlace.category} · ${selectedPlace.status} r${selectedPlace.revision}` : dirty ? '저장되지 않은 변경' : '';
}
function renderLists() {
  $('road-list').innerHTML = roads.map((r) => `<button class="feature-item ${selectedRoad?.id === r.id ? 'selected' : ''}" data-road-id="${esc(r.id)}"><span class="swatch" style="background:${esc(roadCss(r))}"></span><span>${esc(r.name || '이름 없는 도로')}<br><span class="muted">${esc(r.roadClass)} · ${esc(r.status)}</span></span></button>`).join('') || '<span class="editor-hint">저장된 도로가 없습니다.</span>';
  $('place-list').innerHTML = places.map((p) => `<button class="feature-item ${selectedPlace?.id === p.id ? 'selected' : ''}" data-place-id="${esc(p.id)}"><span class="swatch" style="background:${COLORS.place}"></span><span>${esc(p.name)}<br><span class="muted">${esc(p.category)}</span></span></button>`).join('') || '<span class="editor-hint">저장된 장소가 없습니다.</span>';
  // The list re-renders on every redraw, so a native dblclick rarely survives; detect the second click by id/time.
  const listClick = (id: string, select: () => void, frame: () => void) => {
    const now = Date.now(), again = lastListClick.id === id && now - lastListClick.at < 450;
    lastListClick = { id: again ? '' : id, at: now };
    select();
    if (again) frame();
  };
  $('road-list').querySelectorAll<HTMLButtonElement>('[data-road-id]').forEach((b) => b.onclick = () => listClick(`road:${b.dataset.roadId}`, () => selectRoad(b.dataset.roadId!), () => frameRoad(b.dataset.roadId!)));
  $('place-list').querySelectorAll<HTMLButtonElement>('[data-place-id]').forEach((b) => b.onclick = () => listClick(`place:${b.dataset.placeId}`, () => selectPlace(b.dataset.placeId!), () => { const p = places.find((x) => x.id === b.dataset.placeId); if (p) nav?.frame([drawPoint(p.geometry.coordinates)]); }));
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
function zoomCamera(steps: number, screen?: { x: number; y: number }) {
  if (!viewer || !Number.isFinite(steps) || steps === 0) return;
  const camera = viewer.camera;
  const cursorRange = C.Cartesian3.distance(camera.positionWC, drawPoint(ownCursor));
  const height = Math.abs(camera.positionCartographic.height);
  const reference = Math.max(5, Math.min(20_000, orbitCursor ? cursorRange : height));
  let amount = reference * (1 - Math.exp(-Math.max(-3, Math.min(3, steps)) * 0.18));
  // Zoom toward the pointer (CAD style): same height-scaled speed, only the direction follows the mouse ray;
  // the picked distance merely stops the camera short of the surface.
  const ray = screen && !orbitCursor ? camera.getPickRay(new C.Cartesian2(screen.x, screen.y)) : undefined;
  if (ray) {
    const hit = nav?.pickWorld(screen!);
    if (amount > 0 && hit) amount = Math.min(amount, Math.max(0, C.Cartesian3.distance(camera.positionWC, hit) - 2));
    const dir = C.Matrix4.multiplyByPointAsVector(camera.inverseTransform, ray.direction, new C.Cartesian3());
    camera.move(C.Cartesian3.normalize(dir, dir), amount);
    return;
  }
  camera.zoomIn(orbitCursor && amount > 0 ? Math.min(amount, Math.max(0, cursorRange - 2)) : amount);
}

function toHexColor(css: string) {
  const c = cssColor(css), h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(c.red)}${h(c.green)}${h(c.blue)}`;
}
function focusPointsWorld(): any[] {
  if (roadDraft?.coordinates.length) return roadDraft.coordinates.map(drawPoint);
  if (selectedRoad) return selectedRoad.geometry.coordinates.map(drawPoint);
  if (selectedPlace) return [drawPoint(selectedPlace.geometry.coordinates)];
  return [];
}
function frameRoad(id: string) {
  const road = roads.find((r) => r.id === id);
  if (road) { nav?.frame(road.geometry.coordinates.map(drawPoint)); lastFollowTarget = null; }
}
function frameSelection() {
  if (!nav?.frame(focusPointsWorld())) say('맞출 선택 객체가 없습니다. 도로나 장소를 먼저 선택하세요.');
  lastFollowTarget = null;
}
function frameAll() {
  const pts = [...roads.flatMap((r) => r.geometry.coordinates.map(drawPoint)), ...places.map((p) => drawPoint(p.geometry.coordinates))];
  if (!nav?.frame(pts.length ? pts : [drawPoint(ownCursor)])) return;
  lastFollowTarget = null;
}
function toggleIsolate() {
  isolate = !isolate;
  if (isolate && !selectedRoad) say('단독 보기는 경로를 선택했을 때 적용됩니다.');
  updateControls();
}
function toggleHelp(open = $('editor-help').hidden) { $('editor-help').hidden = !open; }
function viewCommand(kind: string) {
  if (!nav) return;
  if (kind === 'top' || kind === 'bottom' || kind === 'front' || kind === 'back' || kind === 'right' || kind === 'left') nav.standardView(kind);
  else if (kind === 'flip') nav.flipView();
  else if (kind === 'ortho') nav.toggleOrtho();
  else if (kind === 'frame-selected') frameSelection();
  else if (kind === 'frame-all') frameAll();
  else if (kind === 'isolate') toggleIsolate();
  else if (kind === 'cursor') nav.frame([drawPoint(ownCursor)]);
  lastFollowTarget = null;
  $('view-ortho').textContent = nav.isOrtho() ? '정사영' : '원근';
  $('view-ortho').classList.toggle('active', nav.isOrtho());
}
/** Blender numpad / CAD view keys. Ctrl+digit is left to the browser (tab switching); Shift+digit gives the opposite view. */
function handleViewKey(e: KeyboardEvent): boolean {
  if (!nav || e.metaKey || e.altKey) return false;
  const digit = /^(Numpad|Digit)(\d)$/.exec(e.code);
  if (e.ctrlKey && !(digit && digit[1] === 'Numpad')) return false;
  const opposite = e.shiftKey || e.ctrlKey;
  let command: string | null = null;
  if (digit) {
    const n = Number(digit[2]);
    if (n === 7) command = opposite ? 'bottom' : 'top';
    else if (n === 1) command = opposite ? 'back' : 'front';
    else if (n === 3) command = opposite ? 'left' : 'right';
    else if (n === 9) command = 'flip';
    else if (n === 5) command = 'ortho';
    else if (n === 0) command = 'cursor';
    else if (n === 4 || n === 6 || n === 8 || n === 2) {
      e.preventDefault();
      nav.orbitStep(n === 4 ? -15 : n === 6 ? 15 : 0, n === 8 ? 15 : n === 2 ? -15 : 0);
      lastFollowTarget = null;
      return true;
    }
  } else if (e.code === 'NumpadDecimal' || e.code === 'Period') command = 'frame-selected';
  else if (e.code === 'Home') command = 'frame-all';
  else if (e.code === 'NumpadDivide' || (e.code === 'Slash' && !e.shiftKey)) command = 'isolate';
  else if (e.key === '?') { e.preventDefault(); toggleHelp(); return true; }
  if (!command) return false;
  e.preventDefault();
  viewCommand(command);
  return true;
}
function onHover(id: string | null, screen: { x: number; y: number } | null) {
  const active = tool === 'select' && !roadDraft && !placeDraft ? id?.replace(/:(tube|shaft)$/, '') ?? null : null;
  const tip = $('editor-hover-tip');
  if (active !== hoverId) { hoverId = active; viewer.scene.canvas.style.cursor = active ? 'pointer' : ''; }
  if (!active || !screen) { tip.hidden = true; return; }
  let text = '';
  if (active.startsWith('editor:road:')) {
    const r = roads.find((x) => x.id === active.slice('editor:road:'.length));
    if (r) text = `${r.name || '이름 없는 도로'} · ${r.roadClass} · ${r.structure} · 점 ${r.geometry.coordinates.length}개`;
  } else if (active.startsWith('editor:place:')) {
    const p = places.find((x) => x.id === active.slice('editor:place:'.length));
    if (p) text = `${p.name} · ${p.category}`;
  } else if (active.startsWith('editor:vertex:')) text = '더블클릭: 이 Vertex에서 분기';
  tip.hidden = !text;
  tip.textContent = text;
  tip.style.left = `${screen.x + 14}px`; tip.style.top = `${screen.y + 14}px`;
}
async function saveRoadColor(roadId: string, color: string | null) {
  try {
    await request(`/api/v1/editor/roads/${roadId}/style`, { method: 'PUT', body: JSON.stringify({ displayColor: color, sessionId: EDITOR_SESSION, mutationId: uuid() }) });
    const road = roads.find((r) => r.id === roadId);
    if (road) road.displayColor = color; // the change feed reloads everyone, this one included
    say(color ? '경로 색을 모든 편집자와 공유했습니다.' : '공유 색을 지웠습니다. 자동 색으로 표시합니다.', 'success');
  } catch (err) { say(`색을 저장하지 못했습니다: ${(err as Error).message}`, 'error'); }
  previewColors.delete(roadId);
  drawAll();
}

// ---- recorded walks -> one corridor (backend corridor-preview; saving goes through the normal draft/save path) ----
function renderCorridorList() {
  $('corridor-list').innerHTML = corridorTracks.map((t, i) => `<div class="corridor-item"><span>${esc(t.label)}</span><button type="button" data-corridor-remove="${i}" title="빼기">×</button></div>`).join('')
    || '<span class="editor-hint">추가된 실행이 없습니다.</span>';
  $('corridor-list').querySelectorAll<HTMLButtonElement>('[data-corridor-remove]').forEach((b) => b.onclick = () => {
    corridorTracks.splice(Number(b.dataset.corridorRemove), 1); clearCorridorPreview(); renderCorridorList();
  });
  $('corridor-draft').toggleAttribute('disabled', !corridorResult);
}
function addCorridorTrack() {
  const runId = $('fusion-run').value;
  if (!runId) { say('먼저 수집 세션과 Fusion 실행을 고르세요.', 'warning'); return; }
  if (corridorTracks.some((t) => t.runId === runId)) { say('이미 추가된 실행입니다.'); return; }
  const session = $<HTMLSelectElement>('fusion-session'), run = $<HTMLSelectElement>('fusion-run');
  corridorTracks.push({ runId, label: `${session.selectedOptions[0]?.textContent ?? ''} · ${run.selectedOptions[0]?.textContent ?? runId.slice(0, 8)}` });
  clearCorridorPreview(); renderCorridorList();
}
function clearCorridorPreview() {
  for (const e of corridorEntities) viewer?.entities.remove(e);
  corridorEntities = []; corridorResult = null;
  if ($('corridor-draft')) $('corridor-draft').toggleAttribute('disabled', true);
}
async function previewCorridor() {
  if (!corridorTracks.length) { say('변환할 실행을 하나 이상 추가하세요.', 'warning'); return; }
  clearCorridorPreview();
  $('corridor-info').textContent = '중앙선 계산 중…';
  try {
    const result = await request<CorridorResult>('/api/v1/editor/corridor-preview', { method: 'POST', body: JSON.stringify({
      tracks: corridorTracks.map((t) => ({ runId: t.runId })), zSource: $('corridor-z').value, phoneHeightM: Number($('corridor-phone').value) || 0 }) });
    corridorResult = result;
    const positions = result.coordinates.map(drawPoint);
    const magenta = C.Color.fromCssColorString('#d946ef');
    corridorEntities.push(viewer.entities.add({ polyline: { positions, width: 5, arcType: C.ArcType.NONE,
      material: new C.PolylineDashMaterialProperty({ color: magenta, dashLength: 14 }), depthFailMaterial: new C.PolylineDashMaterialProperty({ color: magenta.withAlpha(0.6), dashLength: 14 }) } }));
    const w = (result.widthM ?? 2.5) / 2, h = prefs.tubeHeightM;
    corridorEntities.push(viewer.entities.add({ polylineVolume: { positions, cornerType: C.CornerType.MITERED,
      shape: [new C.Cartesian2(-w, 0), new C.Cartesian2(w, 0), new C.Cartesian2(w, h), new C.Cartesian2(-w, h)],
      material: magenta.withAlpha(0.14), outline: true, outlineColor: magenta.withAlpha(0.8) } }));
    $('corridor-info').textContent = `실행 ${result.usedTracks}개(${result.reversedTracks}개 역방향 정렬) · 꼭지점 ${result.coordinates.length}개 · 폭 ${result.widthM ?? '추정 불가(2.5 m로 표시)'} m · 2개 이상 겹친 구간 ${Math.round(result.coverage * 100)}%`
      + (result.warnings.length ? ` · ${result.warnings.join(' / ')}` : '');
    nav?.frame(positions);
    lastFollowTarget = null;
  } catch (err) { $('corridor-info').textContent = `변환 실패: ${(err as Error).message}`; }
  renderCorridorList();
}
async function corridorToDraft() {
  const result = corridorResult;
  if (!result) return;
  if (roadDraft || placeDraft) { say('편집 중인 초안을 먼저 저장하거나 취소하세요.', 'warning'); return; }
  tool = 'pedestrian';
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === 'pedestrian'));
  $('editor-tool-label').textContent = '통로 작도 (동선 변환)';
  $('road-fields').hidden = false; $('place-fields').hidden = true; $('junction-fields').hidden = true;
  await startRoadDraft('pedestrian');
  if (!roadDraft) return;
  const draft = roadDraft as Draft;
  $('road-structure').value = 'indoor_corridor';
  if (result.widthM) $('road-width').value = String(result.widthM);
  draft.coordinates = result.coordinates.map((c) => [...c] as XYZ);
  draft.attrs = attrsFromUI('pedestrian');
  dirty = true;
  ownCursor = [...draft.coordinates.at(-1)!]; rebaseSnapGuide();
  clearCorridorPreview(); renderCorridorList();
  updateControls(); drawAll(); publishDraft();
  say('동선에서 만든 통로 초안입니다. 이름·층을 정하고 꼭지점을 확인한 뒤 저장(Enter)하세요. 끝을 기존 도로에 이으려면 그 Vertex로 옮기세요.');
}

function bindViewPrefs() {
  const persist = () => { savePrefs(prefs); updateRoadStyles(); };
  const range = (id: string, get: () => number, set: (v: number) => void, fmt = (v: number) => `×${v.toFixed(1)}`) => {
    const input = $(id), out = $(`${id}-v`);
    input.value = String(get()); out.textContent = fmt(get());
    input.addEventListener('input', () => { set(Number(input.value)); out.textContent = fmt(get()); persist(); });
  };
  const check = (id: string, get: () => boolean, set: (v: boolean) => void, redraw = false) => {
    const input = $(id);
    input.checked = get();
    input.addEventListener('change', () => { set(input.checked); persist(); if (redraw) drawAll(); });
  };
  $('nav-preset').value = prefs.preset;
  $('nav-preset').addEventListener('change', () => {
    prefs.preset = $('nav-preset').value as NavPreset;
    prefs.zoomToPointer = prefs.preset === 'cad';
    $('zoom-pointer').checked = prefs.zoomToPointer;
    persist();
    say({ cesium: '기본 조작: 좌 드래그 이동, 가운데·Ctrl+좌 회전, 우 드래그·휠 줌.', blender: 'Blender 조작: 가운데 회전, Shift+가운데 이동, Ctrl+가운데 줌. 노트북은 Alt+좌.',
      cad: 'CAD 조작: 가운데 이동, Shift+가운데 회전, 가운데 더블클릭 전체 보기, 휠은 마우스 위치로 줌.' }[prefs.preset]);
  });
  range('sens-rotate', () => prefs.sens.rotate, (v) => { prefs.sens.rotate = v; });
  range('sens-pan', () => prefs.sens.pan, (v) => { prefs.sens.pan = v; });
  range('sens-zoom', () => prefs.sens.zoom, (v) => { prefs.sens.zoom = v; });
  check('zoom-pointer', () => prefs.zoomToPointer, (v) => { prefs.zoomToPointer = v; });
  check('zoom-invert', () => prefs.invertZoom, (v) => { prefs.invertZoom = v; });
  check('dim-others', () => prefs.dimOthers, (v) => { prefs.dimOthers = v; });
  range('dim-alpha', () => prefs.dimAlpha, (v) => { prefs.dimAlpha = v; }, (v) => `${Math.round(v * 100)}%`);
  check('depth-fade', () => prefs.depthFade, (v) => { prefs.depthFade = v; });
  range('fade-min', () => prefs.fadeMin, (v) => { prefs.fadeMin = v; }, (v) => `${Math.round(v * 100)}%`);
  check('hover-highlight', () => prefs.hoverHighlight, (v) => { prefs.hoverHighlight = v; if (!v) onHover(null, null); });
  $('fade-near').value = String(prefs.fadeNear); $('fade-far').value = String(prefs.fadeFar);
  const fadeRange = () => {
    const near = Math.max(0, Number($('fade-near').value) || 0), far = Math.max(near + 1, Number($('fade-far').value) || near + 1);
    prefs.fadeNear = near; prefs.fadeFar = far; $('fade-far').value = String(far); persist();
  };
  $('fade-near').addEventListener('change', fadeRange); $('fade-far').addEventListener('change', fadeRange);
  $('endpoint-mode').value = prefs.endpoints;
  $('endpoint-mode').addEventListener('change', () => { prefs.endpoints = $('endpoint-mode').value as EndpointMode; persist(); drawAll(); });
  // Shared colour: preview while the picker moves, save on release; every editor reloads through the change feed.
  $('road-color').addEventListener('input', () => { if (selectedRoad) { previewColors.set(selectedRoad.id, $('road-color').value); updateRoadStyles(); } });
  $('road-color').addEventListener('change', () => { if (selectedRoad) void saveRoadColor(selectedRoad.id, $('road-color').value); });
  $('road-color-reset').onclick = () => { if (selectedRoad) void saveRoadColor(selectedRoad.id, null); };
  $('color-mode').value = prefs.colorMode;
  $('color-mode').addEventListener('change', () => { prefs.colorMode = $('color-mode').value as ColorMode; persist(); drawAll(); });
  $('floor-height').value = String(prefs.floorHeightM); $('tube-height').value = String(prefs.tubeHeightM);
  $('floor-height').addEventListener('change', () => { prefs.floorHeightM = Math.min(8, Math.max(2, Number($('floor-height').value) || 3)); $('floor-height').value = String(prefs.floorHeightM); persist(); drawAll(); });
  $('tube-height').addEventListener('change', () => { prefs.tubeHeightM = Math.min(6, Math.max(1, Number($('tube-height').value) || 2.4)); $('tube-height').value = String(prefs.tubeHeightM); persist(); drawAll(); });
  check('solids', () => prefs.solids, (v) => { prefs.solids = v; }, true);
  range('building-opacity', () => prefs.buildingOpacity, (v) => {
    prefs.buildingOpacity = v; buildingScene?.setOpacity(v);
  }, (v) => `${Math.round(v * 100)}%`);
  check('xray-paths', () => prefs.xrayPaths, (v) => { prefs.xrayPaths = v; });
  $('corridor-add').onclick = addCorridorTrack;
  $('corridor-clear').onclick = () => { corridorTracks = []; clearCorridorPreview(); renderCorridorList(); };
  $('corridor-preview').onclick = () => void previewCorridor();
  $('corridor-draft').onclick = () => void corridorToDraft();
  renderCorridorList();
  $('nav-help-btn').onclick = () => toggleHelp(true);
  $('editor-help-close').onclick = () => toggleHelp(false);
  $('editor-help').addEventListener('click', (e) => { if (e.target === $('editor-help')) toggleHelp(false); });
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.onclick = () => { viewCommand(b.dataset.view!); viewer.scene.canvas.focus(); });
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
        body: JSON.stringify({ coordinates: coords, levelId: attrs.levelId, branchFrom: roadDraft.branchFrom, structure: attrs.structure }) });
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
    const draft = p.payload?.style ? undefined : remoteDrafts.get(`${p.objectType}:${p.objectId}`);
    if (draft) { viewer.entities.remove(draft); remoteDrafts.delete(`${p.objectType}:${p.objectId}`); }
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
    if (e.code === 'Escape' && !$('editor-help').hidden) { e.preventDefault(); toggleHelp(false); return; }
    if (handleViewKey(e)) return;
    if (e.code === 'Escape' && !e.repeat) {
      e.preventDefault();
      if (roadDraft || placeDraft) {
        // CAD-style cancel; a draft with changes needs a second Esc so one keystroke cannot discard work.
        if (dirty && Date.now() - escArmedAt > 1500) { escArmedAt = Date.now(); say('Esc를 한 번 더 누르면 작성 중인 초안을 취소합니다.', 'warning'); return; }
        escArmedAt = 0; clearDraft(); setTool('select'); say('편집 초안을 취소했습니다.'); return;
      }
      if (tool !== 'select') { setTool('select'); return; }
      if (selectedRoad || selectedPlace) { selectedRoad = null; selectedPlace = null; selectedVertex = -1; isolate = false; setTool('select'); }
      return;
    }
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (roadDraft || placeDraft) { e.preventDefault(); void saveCurrent(); }
      return;
    }
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

  // Mouse navigation (orbit / pan / zoom with sensitivity and Blender/CAD presets) lives in editor-view.ts.
  nav = new NavController(viewer, C, {
    prefs: () => prefs,
    cursorWorld: () => drawPoint(ownCursor),
    orbitLocked: () => orbitCursor,
    zoom: (steps, screen) => zoomCamera(steps, screen),
    zoomExtents: () => viewCommand('frame-all'),
    onHover,
    onUserCamera: () => { if (!$('editor-hover-tip').hidden) $('editor-hover-tip').hidden = true; },
  });
  nav.install();
  bindViewPrefs();
  viewer.scene.preRender.addEventListener(updateRoadStyles);
  mouseHandler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
  mouseHandler.setInputAction((movement: any) => {
    const hits = viewer.scene.drillPick(movement.position, 8, 8);
    const feature = tool === 'select' ? hits.map((h: any) => h.id?.id).find((id: unknown) =>
      typeof id === 'string' && /^editor:(road|place):/.test(id))?.replace(/:(tube|shaft)$/, '') : null;
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
  buildingScene = result.scene;
  buildingScene?.setOpacity(prefs.buildingOpacity);
  xrayPaths = new XrayPaths(C, viewer);
  // The terrain-grid endpoint is binary; read it directly, matching the Preview's grid DTO.
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/terrain/grid`);
    const meta = JSON.parse(res.headers.get('X-Grid') ?? 'null');
    if (res.ok && meta) terrain = { ...meta, heights: new Float32Array(await res.arrayBuffer()) } as TerrainGrid;
  } catch { /* the DEM is a cursor-height aid; map rendering can still continue */ }
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
  viewer.scene.screenSpaceCameraController.enableZoom = false;
  fadeScratch.a = new C.Cartesian3(); fadeScratch.b = new C.Cartesian3();
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
