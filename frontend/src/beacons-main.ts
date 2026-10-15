// Beacon registry page (docs/BEACON_POSITIONING.md §5.3): register iBeacons by hand, from a Web Bluetooth scan of this
// device, or from the unregistered beacons the collector apps heard. Uses the /api/v1/positioning/admin API with a
// collector-account token (the same sign-in as the network editor; the account must be in POSITIONING_ADMIN_COLLECTORS).
import './beacons.css';
import { API_BASE_URL } from './api';
import { HeardBeacons, buildCreateRequest, emptyForm, parseIBeacon, scanSupport, APPLE_COMPANY_ID, beaconKey, type BeaconForm } from './beacon-scan';

// Same storage keys as the editor: signing in on one page signs in on the other.
const DEVICE_KEY = 'campus.editor.deviceId';
const TOKEN_KEY = 'campus.editor.accessToken';
const USER_KEY = 'campus.editor.collectorId';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

interface Anchor { anchorId: string; buildingId: string; floor: string | null; floorHeightM: number | null; position: { x: number; y: number; z: number } }
interface Beacon { beaconId: string; uuid: string; major: number; minor: number; measuredPowerDbm: number | null; enabled: boolean; label: string | null;
  lastObservedAt: string | null; anchor: Anchor | null }
interface Discovered { uuid: string; major: number; minor: number; observations: number; sessions: number; maxRssiDbm: number; measuredPowerDbm: number | null;
  platforms: string[]; lastSeenAt: string; suggestedPosition: { latitude: number; longitude: number; horizontalUncertaintyM: number | null; floor: string | null; buildingId: string | null } | null }
interface Building { buildingId: string; buildingName: string; floorsWithNodes: string[] }

class HttpError extends Error { constructor(readonly status: number, readonly code: string | undefined, message: string, readonly details?: any) { super(message); } }

const token = () => localStorage.getItem(TOKEN_KEY) ?? '';
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (token()) headers.set('authorization', `Bearer ${token()}`);
  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status, body?.error?.code, body?.error?.message ?? `HTTP ${res.status}`, body?.error?.details);
  return body as T;
}
const admin = <T>(path: string, init?: RequestInit) => request<T>(`/api/v1/positioning/admin${path}`, init);

const FORM_FIELDS: (keyof BeaconForm)[] = ['uuid', 'major', 'minor', 'measuredPowerDbm', 'label', 'buildingId', 'floor', 'floorHeightM', 'mountAboveFloorM',
  'latitude', 'longitude', 'x', 'y', 'z', 'horizontalAccuracyM'];

const field = (key: keyof BeaconForm, label: string, attrs = '') =>
  `<label class="bf-field" data-field="${key}">${label}<input id="f-${key}" ${attrs} /><small class="bf-error" id="e-${key}"></small></label>`;

$('beacons-root').innerHTML = `
<div class="bp-app">
  <header class="bp-header">
    <a class="bp-brand" href="/">Campus Tracker</a><strong>비콘 등록</strong>
    <a class="bp-nav" href="/editor.html">편집기</a><span class="spacer"></span>
    <span id="bp-user"></span><button id="bp-logout" type="button">로그아웃</button>
  </header>
  <div id="bp-banner" class="bp-banner" hidden></div>
  <main class="bp-main">
    <section class="bp-card">
      <h2>자동 검색</h2>
      <div class="bp-tabs" role="tablist">
        <button id="tab-ble" class="active" type="button" role="tab">이 기기 블루투스</button>
        <button id="tab-app" type="button" role="tab">앱이 들은 미등록 비콘</button>
      </div>
      <div id="pane-ble">
        <p class="bp-hint">블루투스 권한을 허용하면 주변 iBeacon 광고를 검색합니다. 항목을 누르면 오른쪽 양식에 UUID·Major·Minor·송신 세기가 채워집니다.</p>
        <div class="bp-row"><button id="ble-start" type="button" class="primary">블루투스 검색 시작</button><button id="ble-stop" type="button" disabled>중지</button></div>
        <div id="ble-status" class="bp-status"></div>
        <ul id="ble-list" class="bp-list"></ul>
      </div>
      <div id="pane-app" hidden>
        <p class="bp-hint">수집 앱(iOS·Android)이 세션 중 들은, 아직 등록되지 않은 비콘입니다. 앱은 아래 <b>검색 UUID</b>와 등록된 비콘의 UUID만 듣습니다.
          제안 위치는 신호가 가장 셀 때의 휴대폰 추정 위치로, 실제 설치 위치와 몇 m 다를 수 있습니다.</p>
        <div class="bp-row"><label class="bf-inline">최근<select id="app-hours"><option value="24">24시간</option><option value="168" selected>7일</option><option value="720">30일</option></select></label>
          <button id="app-refresh" type="button">새로고침</button></div>
        <ul id="app-list" class="bp-list"></ul>
        <h3>검색 UUID</h3>
        <ul id="survey-list" class="bp-list compact"></ul>
        <form id="survey-form" class="bp-row"><input id="survey-uuid" placeholder="E2C56DB5-DFFB-48D2-B060-D0F5A71096E0" /><input id="survey-label" placeholder="메모(선택)" /><button type="submit">추가</button></form>
        <small id="survey-error" class="bf-error"></small>
      </div>
    </section>

    <section class="bp-card">
      <h2>등록 (직접 입력)</h2>
      <form id="beacon-form" novalidate>
        <fieldset><legend>식별자</legend>
          ${field('uuid', 'UUID', 'placeholder="E2C56DB5-DFFB-48D2-B060-D0F5A71096E0" autocomplete="off" spellcheck="false"')}
          <div class="bf-grid3">${field('major', 'Major', 'inputmode="numeric" placeholder="0~65535"')}${field('minor', 'Minor', 'inputmode="numeric" placeholder="0~65535"')}${field('measuredPowerDbm', '1 m 송신 세기(dBm)', 'inputmode="numeric" placeholder="-59"')}</div>
          ${field('label', '이름', 'placeholder="예: 북악관 3층 엘리베이터 앞"')}
        </fieldset>
        <fieldset><legend>설치 위치 (Spatial Anchor, 비우면 위치 없이 등록)</legend>
          <label class="bf-field" data-field="buildingId">건물<input id="f-buildingId" list="building-options" placeholder="건물 ID, 바깥이면 outdoor" /><small class="bf-error" id="e-buildingId"></small></label>
          <datalist id="building-options"></datalist>
          <div class="bf-grid2">${field('floor', '층', 'placeholder="3F / B1"')}${field('floorHeightM', '층 바닥 높이(해발 m, 선택)', 'inputmode="decimal"')}</div>
          <div class="bp-row"><label class="bf-inline"><input type="radio" name="pos-mode" value="wgs84" checked /> 위도·경도</label>
            <label class="bf-inline"><input type="radio" name="pos-mode" value="grid" /> EPSG:5186 X·Y</label>
            <button id="use-location" type="button">현재 위치 사용</button></div>
          <div id="pos-wgs84" class="bf-grid2">${field('latitude', '위도', 'inputmode="decimal"')}${field('longitude', '경도', 'inputmode="decimal"')}</div>
          <div id="pos-grid" class="bf-grid2" hidden>${field('x', 'X (m)', 'inputmode="decimal"')}${field('y', 'Y (m)', 'inputmode="decimal"')}</div>
          <div class="bf-grid3">${field('mountAboveFloorM', '바닥에서 높이(m)', 'inputmode="decimal" placeholder="2.5"')}${field('z', '설치 높이(해발 m, 비우면 계산)', 'inputmode="decimal"')}${field('horizontalAccuracyM', '위치 정확도(m)', 'inputmode="decimal" placeholder="1"')}</div>
        </fieldset>
        <div class="bp-row"><button type="submit" class="primary">등록</button><button id="form-reset" type="button">비우기</button></div>
        <div id="form-result" class="bp-status"></div>
      </form>
    </section>

    <section class="bp-card wide">
      <h2>등록된 비콘 <small id="registry-version"></small></h2>
      <label class="bf-inline"><input id="show-disabled" type="checkbox" /> 비활성 포함</label>
      <div class="bp-table-wrap"><table class="bp-table"><thead><tr><th>이름</th><th>UUID</th><th>Major</th><th>Minor</th><th>건물·층</th><th>최근 관측</th><th></th></tr></thead>
        <tbody id="registry-body"></tbody></table></div>
    </section>
  </main>
  <div id="bp-login" class="bp-login" hidden><form id="bp-login-form" class="bp-card">
    <h2>트랙커 계정으로 로그인</h2><p class="bp-hint">편집기와 같은 비밀번호 없는 계정입니다. 비콘 등록은 서버의 POSITIONING_ADMIN_COLLECTORS에 있는 계정만 할 수 있습니다.</p>
    <select id="login-account" required><option value="">계정 불러오는 중…</option></select>
    <div id="login-error" class="bf-error"></div><button type="submit" class="primary">로그인</button>
  </form></div>
</div>`;

// ---------------------------------------------------------------------------------------------
// state

let registered: Beacon[] = [];
const registeredKeys = () => new Set(registered.map((b) => beaconKey(b.uuid, b.major, b.minor)));
const heard = new HeardBeacons((key) => registeredKeys().has(key));

function banner(message: string | null, kind: 'error' | 'info' = 'error') {
  const el = $('bp-banner');
  el.hidden = !message;
  el.className = `bp-banner ${kind}`;
  el.textContent = message ?? '';
}

function showError(err: unknown) {
  if (err instanceof HttpError && (err.status === 401 || err.code === 'TOKEN_REQUIRED' || err.code === 'INVALID_TOKEN' || err.code === 'TOKEN_EXPIRED')) {
    localStorage.removeItem(TOKEN_KEY);
    return showLogin();
  }
  if (err instanceof HttpError && err.code === 'POSITIONING_ADMIN_REQUIRED') {
    return banner(`${localStorage.getItem(USER_KEY) ?? '이 계정'}은 비콘 등록 권한이 없습니다. 서버 .env의 POSITIONING_ADMIN_COLLECTORS에 계정 코드를 추가하세요.`);
  }
  banner((err as Error).message);
}

// ---------------------------------------------------------------------------------------------
// login (same flow as the editor)

async function showLogin() {
  $('bp-login').hidden = false;
  const select = $<HTMLSelectElement>('login-account');
  try {
    const rows = await request<{ collectorId: string }[]>('/api/v1/collectors');
    select.innerHTML = `<option value="">계정 선택</option>${rows.map((r) => `<option value="${esc(r.collectorId)}">${esc(r.collectorId)}</option>`).join('')}`;
    const prior = localStorage.getItem(USER_KEY);
    if (prior && rows.some((r) => r.collectorId === prior)) select.value = prior;
  } catch (err) { select.innerHTML = '<option value="">Backend 연결 실패</option>'; $('login-error').textContent = (err as Error).message; }
}

$<HTMLFormElement>('bp-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $<HTMLSelectElement>('login-account').value;
  if (!code) return;
  try {
    let deviceId = localStorage.getItem(DEVICE_KEY);
    if (!deviceId) { deviceId = uuid(); localStorage.setItem(DEVICE_KEY, deviceId); }
    const result = await request<{ accessToken: string; collectorId: string }>('/api/v1/collectors/login', {
      method: 'POST', body: JSON.stringify({ collectorId: code, deviceId, platform: 'web', deviceModel: 'Beacon Registry', appVersion: '0.1.0' }),
    });
    localStorage.setItem(TOKEN_KEY, result.accessToken);
    localStorage.setItem(USER_KEY, result.collectorId);
    $('bp-login').hidden = true;
    await start();
  } catch (err) { $('login-error').textContent = (err as Error).message; }
});

$('bp-logout').onclick = () => {
  stopScan();
  localStorage.removeItem(TOKEN_KEY);
  void showLogin();
};

// ---------------------------------------------------------------------------------------------
// registry table

async function loadRegistry() {
  const r = await admin<{ beacons: Beacon[]; configVersion: number }>(`/beacons?includeDisabled=${$('show-disabled').checked}`);
  registered = r.beacons;
  $('registry-version').textContent = `설정 v${r.configVersion} · ${r.beacons.length}개`;
  $('registry-body').innerHTML = r.beacons.map((b) => `<tr class="${b.enabled ? '' : 'disabled'}">
    <td>${esc(b.label ?? '—')}</td><td class="mono">${esc(b.uuid)}</td><td>${b.major}</td><td>${b.minor}</td>
    <td>${b.anchor ? `${esc(b.anchor.buildingId)} ${esc(b.anchor.floor ?? '')}` : '<span class="muted">위치 없음</span>'}</td>
    <td>${b.lastObservedAt ? new Date(b.lastObservedAt).toLocaleString() : '—'}</td>
    <td>${b.enabled ? `<button type="button" data-disable="${b.beaconId}">비활성화</button>` : `<button type="button" data-enable="${b.beaconId}">다시 활성화</button>`}</td></tr>`).join('')
    || '<tr><td colspan="7" class="muted">등록된 비콘이 없습니다</td></tr>';
  renderHeard();
}

$('registry-body').addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const disable = target.dataset.disable, enable = target.dataset.enable;
  if (!disable && !enable) return;
  if (disable && !confirm('이 비콘을 비활성화할까요? 수집 앱 설정과 이후 재처리에서 빠집니다. 기록은 지우지 않습니다.')) return;
  try {
    await admin(`/beacons/${disable ?? enable}`, disable ? { method: 'DELETE' } : { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    await loadRegistry();
  } catch (err) { showError(err); }
});
$('show-disabled').addEventListener('change', () => void loadRegistry().catch(showError));

// ---------------------------------------------------------------------------------------------
// form

function readForm(): BeaconForm {
  const f = emptyForm();
  for (const k of FORM_FIELDS) (f as any)[k] = $(`f-${k}`).value;
  f.positionMode = (document.querySelector<HTMLInputElement>('input[name="pos-mode"]:checked')?.value ?? 'wgs84') as BeaconForm['positionMode'];
  return f;
}

function fill(values: Partial<BeaconForm>) {
  for (const [k, v] of Object.entries(values)) if (v !== undefined && $(`f-${k}`)) $(`f-${k}`).value = String(v);
  if (values.positionMode) setPositionMode(values.positionMode);
  clearErrors();
  $('form-result').textContent = '';
  $('f-label').focus();
}

function clearErrors() {
  for (const k of FORM_FIELDS) { const e = $(`e-${k}`); if (e) e.textContent = ''; }
}

function setPositionMode(mode: BeaconForm['positionMode']) {
  const radio = document.querySelector<HTMLInputElement>(`input[name="pos-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  $('pos-wgs84').hidden = mode !== 'wgs84';
  $('pos-grid').hidden = mode !== 'grid';
}
document.querySelectorAll<HTMLInputElement>('input[name="pos-mode"]').forEach((r) => r.addEventListener('change', () => setPositionMode(r.value as BeaconForm['positionMode'])));

$('use-location').onclick = () => {
  if (!('geolocation' in navigator)) return banner('이 브라우저에서 위치를 읽을 수 없습니다.');
  $('form-result').textContent = '현재 위치를 읽는 중…';
  navigator.geolocation.getCurrentPosition(
    (p) => {
      setPositionMode('wgs84');
      fill({ latitude: p.coords.latitude.toFixed(7), longitude: p.coords.longitude.toFixed(7),
        horizontalAccuracyM: String(Math.min(100, Math.max(1, Math.round(p.coords.accuracy)))) });
      $('form-result').textContent = `현재 위치 ±${Math.round(p.coords.accuracy)} m (실내 GPS는 수십 m 틀릴 수 있습니다. 가능하면 도면 좌표를 쓰세요)`;
    },
    (e) => { $('form-result').textContent = `위치를 읽지 못했습니다: ${e.message}`; },
    { enableHighAccuracy: true, timeout: 15_000 },
  );
};

$('form-reset').onclick = () => { fill(emptyForm()); };

$<HTMLFormElement>('beacon-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  const built = buildCreateRequest(readForm());
  if ('errors' in built) {
    for (const [k, msg] of Object.entries(built.errors)) $(`e-${k}`).textContent = msg ?? '';
    $('form-result').textContent = '입력을 확인하세요.';
    return;
  }
  try {
    const created = await admin<Beacon>('/beacons', { method: 'POST', body: JSON.stringify(built.body) });
    $('form-result').textContent = `등록했습니다: ${created.label ?? ''} ${created.uuid} / ${created.major} / ${created.minor}`;
    await Promise.all([loadRegistry(), loadDiscovered()]);
  } catch (err) {
    if (err instanceof HttpError && err.code === 'BEACON_EXISTS') { $('form-result').textContent = '이미 등록된 UUID·Major·Minor입니다(아래 목록 참조).'; return; }
    if (err instanceof HttpError && err.code === 'VALIDATION_ERROR') { $('form-result').textContent = `서버가 입력을 거절했습니다: ${JSON.stringify(err.details?.fieldErrors ?? err.details)}`; return; }
    showError(err);
  }
});

async function loadBuildings() {
  try {
    const r = await request<{ buildings: Building[] }>('/api/v1/mobility/nodes?limit=1');
    $('building-options').innerHTML = r.buildings.map((b) => `<option value="${esc(b.buildingId)}">${esc(b.buildingName)}${b.floorsWithNodes.length ? ` (${esc(b.floorsWithNodes.join(', '))})` : ''}</option>`).join('');
  } catch { /* free text still works */ }
}

// ---------------------------------------------------------------------------------------------
// tabs

const tabs = { ble: $('tab-ble'), app: $('tab-app') };
function selectTab(which: 'ble' | 'app') {
  tabs.ble.classList.toggle('active', which === 'ble');
  tabs.app.classList.toggle('active', which === 'app');
  $('pane-ble').hidden = which !== 'ble';
  $('pane-app').hidden = which !== 'app';
  if (which === 'app') void loadDiscovered().catch(showError);
}
tabs.ble.onclick = () => selectTab('ble');
tabs.app.onclick = () => selectTab('app');

// ---------------------------------------------------------------------------------------------
// Web Bluetooth scan (Chromium, experimental flag, https/localhost; asks for the Bluetooth permission)

interface LeScan { active: boolean; stop(): void }
interface AdvertisementEvent extends Event { rssi?: number; manufacturerData?: Map<number, DataView>; device?: { name?: string } }
type BluetoothApi = EventTarget & { requestLEScan?: (options: object) => Promise<LeScan> };
const bluetooth = (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth;
let scan: LeScan | null = null;
let quietTimer: number | undefined;

function onAdvertisement(event: Event) {
  const e = event as AdvertisementEvent;
  const data = e.manufacturerData?.get(APPLE_COMPANY_ID);
  const frame = parseIBeacon(APPLE_COMPANY_ID, data ?? null);
  if (!frame) return;
  heard.add(frame, e.rssi ?? null, Date.now());
  window.clearTimeout(quietTimer);
  renderHeard();
}

function renderHeard() {
  const rows = heard.list();
  $('ble-list').innerHTML = rows.map((b) => `<li class="${b.registered ? 'registered' : ''}">
    <button type="button" data-heard="${esc(b.key)}" ${b.registered ? 'disabled' : ''}>
      <span class="mono">${esc(b.uuid)}</span><span>Major ${b.major} · Minor ${b.minor}</span>
      <span>${b.lastRssi ?? '—'} dBm (최대 ${b.maxRssi ?? '—'}) · 1 m ${b.measuredPower} dBm · ${b.count}회</span>
      <span class="tag">${b.registered ? '등록됨' : '양식에 채우기'}</span></button></li>`).join('');
}

$('ble-list').addEventListener('click', (event) => {
  const key = (event.target as HTMLElement).closest<HTMLElement>('[data-heard]')?.dataset.heard;
  const b = heard.list().find((x) => x.key === key);
  if (!b) return;
  fill({ uuid: b.uuid.toUpperCase(), major: String(b.major), minor: String(b.minor), measuredPowerDbm: String(b.measuredPower) });
});

async function startScan() {
  const support = scanSupport({ isSecureContext: window.isSecureContext, bluetooth });
  if (!support.ok) { $('ble-status').textContent = support.message; return; }
  try {
    // The browser shows its Bluetooth permission prompt here. Only iBeacon advertisements (Apple 0x004C, 0x02 0x15).
    scan = await bluetooth!.requestLEScan!({ filters: [{ manufacturerData: [{ companyIdentifier: APPLE_COMPANY_ID, dataPrefix: new Uint8Array([0x02, 0x15]) }] }], keepRepeatedDevices: true });
  } catch (err) {
    const e = err as DOMException;
    $('ble-status').textContent = e.name === 'NotAllowedError' ? '블루투스 권한이 거부되었습니다. 주소창의 사이트 권한에서 블루투스를 허용한 뒤 다시 시도하세요.'
      : e.name === 'NotFoundError' || e.name === 'InvalidStateError' ? '블루투스가 꺼져 있거나 어댑터가 없습니다.'
        : `검색을 시작하지 못했습니다: ${e.message}`;
    return;
  }
  bluetooth!.addEventListener('advertisementreceived', onAdvertisement);
  $('ble-start').setAttribute('disabled', '');
  $('ble-stop').removeAttribute('disabled');
  $('ble-status').textContent = '검색 중… 비콘 가까이(1~2 m) 가면 신호가 셉니다.';
  quietTimer = window.setTimeout(() => {
    if (!heard.list().length) $('ble-status').textContent = '15초 동안 iBeacon을 찾지 못했습니다. 비콘 전원과 거리를 확인하세요. 일부 브라우저는 Apple 제조사 광고를 넘겨주지 않으므로, 그때는 앱 수집 목록이나 직접 입력을 쓰세요.';
  }, 15_000);
}

function stopScan() {
  window.clearTimeout(quietTimer);
  if (scan?.active) scan.stop();
  scan = null;
  bluetooth?.removeEventListener('advertisementreceived', onAdvertisement);
  $('ble-start').removeAttribute('disabled');
  $('ble-stop').setAttribute('disabled', '');
  if ($('ble-status').textContent?.startsWith('검색 중')) $('ble-status').textContent = `중지했습니다. ${heard.list().length}개를 들었습니다.`;
}

$('ble-start').onclick = () => void startScan();
$('ble-stop').onclick = () => stopScan();
document.addEventListener('visibilitychange', () => { if (document.hidden && scan) stopScan(); });

// ---------------------------------------------------------------------------------------------
// beacons the collector apps heard

let discovered: Discovered[] = [];
async function loadDiscovered() {
  const hours = $<HTMLSelectElement>('app-hours').value;
  const [d, s] = await Promise.all([
    admin<{ discovered: Discovered[] }>(`/discovered?sinceHours=${hours}`),
    admin<{ surveyUuids: { uuid: string; label: string | null }[] }>('/survey-uuids'),
  ]);
  discovered = d.discovered;
  $('app-list').innerHTML = discovered.map((b, i) => `<li><button type="button" data-discovered="${i}">
    <span class="mono">${esc(b.uuid)}</span><span>Major ${b.major} · Minor ${b.minor}</span>
    <span>최대 ${b.maxRssiDbm} dBm · ${b.observations}회 · 세션 ${b.sessions} · ${esc(b.platforms.join('/'))} · ${new Date(b.lastSeenAt).toLocaleString()}</span>
    <span class="tag">${b.suggestedPosition ? `제안 위치 ${esc(b.suggestedPosition.buildingId ?? '')} ${esc(b.suggestedPosition.floor ?? '')} ±${Math.round(b.suggestedPosition.horizontalUncertaintyM ?? 0)} m` : '위치 제안 없음'}</span>
    </button></li>`).join('') || '<li class="muted">미등록 비콘을 들은 기록이 없습니다. 검색 UUID를 추가하고 앱에서 비콘 수집을 켠 채 세션을 진행하세요.</li>';
  $('survey-list').innerHTML = s.surveyUuids.map((u) => `<li><span class="mono">${esc(u.uuid)}</span> ${esc(u.label ?? '')}
    <button type="button" data-survey-remove="${esc(u.uuid)}">삭제</button></li>`).join('') || '<li class="muted">없음</li>';
}

$('app-list').addEventListener('click', (event) => {
  const i = (event.target as HTMLElement).closest<HTMLElement>('[data-discovered]')?.dataset.discovered;
  const b = i === undefined ? undefined : discovered[Number(i)];
  if (!b) return;
  const p = b.suggestedPosition;
  fill({ uuid: b.uuid.toUpperCase(), major: String(b.major), minor: String(b.minor), measuredPowerDbm: b.measuredPowerDbm === null ? '' : String(b.measuredPowerDbm),
    ...(p ? { positionMode: 'wgs84' as const, latitude: p.latitude.toFixed(7), longitude: p.longitude.toFixed(7), buildingId: p.buildingId ?? '', floor: p.floor ?? '',
      horizontalAccuracyM: String(Math.min(100, Math.max(1, Math.round(p.horizontalUncertaintyM ?? 5)))) } : {}) });
  if (p) $('form-result').textContent = '제안 위치는 휴대폰 추정 위치입니다. 설치 위치와 높이를 확인해 고친 뒤 등록하세요.';
});
$('app-refresh').onclick = () => void loadDiscovered().catch(showError);
$('app-hours').addEventListener('change', () => void loadDiscovered().catch(showError));

$<HTMLFormElement>('survey-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('survey-error').textContent = '';
  try {
    await admin('/survey-uuids', { method: 'POST', body: JSON.stringify({ uuid: $('survey-uuid').value.trim(), label: $('survey-label').value.trim() || null }) });
    $('survey-uuid').value = '';
    $('survey-label').value = '';
    await loadDiscovered();
  } catch (err) { $('survey-error').textContent = err instanceof HttpError && err.code === 'VALIDATION_ERROR' ? 'UUID 형식(8-4-4-4-12)을 확인하세요' : (err as Error).message; }
});
$('survey-list').addEventListener('click', async (event) => {
  const u = (event.target as HTMLElement).dataset.surveyRemove;
  if (!u) return;
  try { await admin(`/survey-uuids/${u}`, { method: 'DELETE' }); await loadDiscovered(); } catch (err) { showError(err); }
});

// ---------------------------------------------------------------------------------------------

async function start() {
  banner(null);
  $('bp-user').textContent = localStorage.getItem(USER_KEY) ?? '';
  try {
    await admin('/me');
  } catch (err) { return showError(err); }
  await Promise.all([loadRegistry(), loadBuildings()]).catch(showError);
}

// say up front when this browser cannot scan (before any sign-in or network)
const support = scanSupport({ isSecureContext: window.isSecureContext, bluetooth });
if (!support.ok) $('ble-status').textContent = support.message;

if (token()) void start(); else void showLogin();
