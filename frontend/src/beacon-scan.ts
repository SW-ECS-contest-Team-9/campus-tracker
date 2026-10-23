// Beacon registration page, pure part (no DOM, no network): iBeacon parsing of Web Bluetooth advertisement data,
// the list of beacons heard during a scan, browser support, and the registration form -> POST body.
// The parser follows the same layout and fixture as the Android app (fixtures/beacon/ibeacon-packets.json).

export const APPLE_COMPANY_ID = 0x004c;

export interface IBeaconFrame { uuid: string; major: number; minor: number; measuredPower: number }

/** Manufacturer data AFTER the 2-byte company id (what Web Bluetooth's manufacturerData map holds). */
export function parseIBeacon(companyId: number, data: DataView | Uint8Array | null | undefined): IBeaconFrame | null {
  if (companyId !== APPLE_COMPANY_ID || !data) return null;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 23 || bytes[0] !== 0x02 || bytes[1] !== 0x15) return null;
  const hex = Array.from(bytes.slice(2, 18), (b) => b.toString(16).padStart(2, '0')).join('');
  return {
    uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    major: (bytes[18] << 8) | bytes[19],
    minor: (bytes[20] << 8) | bytes[21],
    measuredPower: bytes[22] > 127 ? bytes[22] - 256 : bytes[22],
  };
}

export const beaconKey = (uuid: string, major: number, minor: number) => `IBEACON:${uuid.toLowerCase()}:${major}:${minor}`;

export interface HeardBeacon extends IBeaconFrame {
  key: string;
  count: number;
  lastRssi: number | null;
  maxRssi: number | null;
  firstSeen: number;
  lastSeen: number;
  /** already in the registry (shown, not offered for registration); re-evaluated on every list() */
  registered: boolean;
}

/** Beacons heard during one scan, strongest first. RSSI 127 / 0 = unavailable. */
export class HeardBeacons {
  private readonly byKey = new Map<string, HeardBeacon>();
  constructor(private readonly isRegistered: (key: string) => boolean = () => false) {}

  add(frame: IBeaconFrame, rssi: number | null | undefined, at: number): HeardBeacon {
    const key = beaconKey(frame.uuid, frame.major, frame.minor);
    const usable = rssi !== null && rssi !== undefined && rssi < 0 && rssi >= -120 ? rssi : null;
    const prev = this.byKey.get(key);
    const next: HeardBeacon = prev
      ? { ...prev, count: prev.count + 1, lastRssi: usable ?? prev.lastRssi, maxRssi: usable === null ? prev.maxRssi : Math.max(prev.maxRssi ?? -999, usable), lastSeen: at, measuredPower: frame.measuredPower }
      : { ...frame, uuid: frame.uuid.toLowerCase(), key, count: 1, lastRssi: usable, maxRssi: usable, firstSeen: at, lastSeen: at, registered: this.isRegistered(key) };
    this.byKey.set(key, next);
    return next;
  }

  list(): HeardBeacon[] {
    return [...this.byKey.values()].map((b) => ({ ...b, registered: this.isRegistered(b.key) })).sort((a, b) => Number(a.registered) - Number(b.registered) || (b.maxRssi ?? -999) - (a.maxRssi ?? -999) || a.key.localeCompare(b.key));
  }

  clear() { this.byKey.clear(); }
}

export type ScanSupport = { ok: true } | { ok: false; reason: 'NO_WEB_BLUETOOTH' | 'NO_LE_SCAN' | 'INSECURE_CONTEXT'; message: string };

/**
 * Web Bluetooth advertisement scanning (`navigator.bluetooth.requestLEScan`) is only in Chromium browsers, behind
 * chrome://flags/#enable-experimental-web-platform-features, on https or localhost. Safari / iOS have no Web Bluetooth.
 */
export function scanSupport(env: { isSecureContext: boolean; bluetooth?: { requestLEScan?: unknown } | undefined }): ScanSupport {
  if (!env.isSecureContext) return { ok: false, reason: 'INSECURE_CONTEXT', message: '블루투스 검색은 https 또는 localhost에서만 열립니다. 이 주소(http)에서는 앱 수집 목록이나 직접 입력을 쓰세요.' };
  if (!env.bluetooth) return { ok: false, reason: 'NO_WEB_BLUETOOTH', message: '이 브라우저는 Web Bluetooth를 지원하지 않습니다(Safari·iOS 포함). Android/PC의 Chrome을 쓰거나 앱 수집 목록을 쓰세요.' };
  if (typeof env.bluetooth.requestLEScan !== 'function') {
    return { ok: false, reason: 'NO_LE_SCAN', message: '광고 검색(requestLEScan)이 꺼져 있습니다. Chrome에서 chrome://flags/#enable-experimental-web-platform-features 를 켜고 다시 여세요.' };
  }
  return { ok: true };
}

// ---- registration form ----

export interface BeaconForm {
  uuid: string; major: string; minor: string; measuredPowerDbm: string; label: string;
  buildingId: string; floor: string; floorHeightM: string;
  /** mounting height above the floor (m): with floorHeightM gives z when z is left empty */
  mountAboveFloorM: string;
  positionMode: 'wgs84' | 'grid';
  latitude: string; longitude: string; x: string; y: string; z: string;
  horizontalAccuracyM: string;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOOR_RE = /^(B[1-9]|[1-9][0-9]?F)$/;

/** "E2C56DB5DFFB48D2B060D0F5A71096E0" or with dashes / braces -> canonical lower-case 8-4-4-4-12, else null. */
export function normalizeUuid(v: string): string | null {
  const hex = v.trim().replace(/[{}\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const num = (v: string) => (v.trim() === '' ? null : Number(v));

/** Form -> `POST /api/v1/positioning/admin/beacons` body, or the field errors (Korean, shown next to the fields). */
export function buildCreateRequest(f: BeaconForm): { body: Record<string, unknown> } | { errors: Partial<Record<keyof BeaconForm, string>> } {
  const errors: Partial<Record<keyof BeaconForm, string>> = {};
  const uuid = normalizeUuid(f.uuid);
  if (!uuid) errors.uuid = 'UUID는 16진수 32자리입니다';
  const int16 = (k: 'major' | 'minor') => {
    const n = num(f[k]);
    if (n === null || !Number.isInteger(n) || n < 0 || n > 65535) errors[k] = '0~65535 정수';
    return n;
  };
  const major = int16('major'), minor = int16('minor');
  const power = num(f.measuredPowerDbm);
  if (power !== null && (!Number.isInteger(power) || power < -127 || power > 20)) errors.measuredPowerDbm = '−127~20 dBm 정수';
  const anchorWanted = Boolean(f.buildingId.trim() || f.latitude.trim() || f.longitude.trim() || f.x.trim() || f.y.trim());
  let anchor: Record<string, unknown> | undefined;
  if (anchorWanted) {
    if (!f.buildingId.trim()) errors.buildingId = '건물(바깥이면 outdoor)을 고르세요';
    const floor = f.floor.trim().toUpperCase();
    if (floor && !FLOOR_RE.test(floor)) errors.floor = '1F…99F 또는 B1…B9';
    const floorHeight = num(f.floorHeightM);
    if (floorHeight !== null && !Number.isFinite(floorHeight)) errors.floorHeightM = '숫자';
    const mount = num(f.mountAboveFloorM);
    let z = num(f.z);
    if (z === null && floorHeight !== null && mount !== null && Number.isFinite(floorHeight + mount)) z = Math.round((floorHeight + mount) * 1000) / 1000;
    if (z === null || !Number.isFinite(z)) errors.z = '설치 높이(해발 m) 또는 층 바닥 높이 + 바닥에서 높이를 넣으세요';
    let position: Record<string, number> | undefined;
    if (f.positionMode === 'wgs84') {
      const lat = num(f.latitude), lon = num(f.longitude);
      if (lat === null || !(lat >= 33 && lat <= 39)) errors.latitude = '위도 33~39';
      if (lon === null || !(lon >= 124 && lon <= 132)) errors.longitude = '경도 124~132';
      if (lat !== null && lon !== null && z !== null) position = { latitude: lat, longitude: lon, z };
    } else {
      const x = num(f.x), y = num(f.y);
      if (x === null || !(x >= 100_000 && x <= 700_000)) errors.x = 'EPSG:5186 X(m)';
      if (y === null || !(y >= 100_000 && y <= 800_000)) errors.y = 'EPSG:5186 Y(m)';
      if (x !== null && y !== null && z !== null) position = { x, y, z };
    }
    const acc = num(f.horizontalAccuracyM);
    if (acc !== null && !(acc > 0 && acc <= 100)) errors.horizontalAccuracyM = '0~100 m';
    anchor = { buildingId: f.buildingId.trim(), ...(floor ? { floor } : {}), ...(floorHeight !== null ? { floorHeightM: floorHeight } : {}),
      position, ...(acc !== null ? { horizontalAccuracyM: acc } : {}) };
  }
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      uuid, major, minor,
      ...(power !== null ? { measuredPowerDbm: power } : {}),
      ...(f.label.trim() ? { label: f.label.trim() } : {}),
      ...(anchor ? { anchor } : {}),
    },
  };
}

export const emptyForm = (): BeaconForm => ({
  uuid: '', major: '', minor: '', measuredPowerDbm: '', label: '', buildingId: '', floor: '', floorHeightM: '', mountAboveFloorM: '',
  positionMode: 'wgs84', latitude: '', longitude: '', x: '', y: '', z: '', horizontalAccuracyM: '',
});

// ---- editing a registered beacon (same rules as the apps: fixtures/beacon/registration-cases.json editCases / beaconToForm) ----

/** A registered beacon as the admin API lists it (`GET /admin/beacons`). Placement is EPSG:5186 only. */
export interface AdminBeacon {
  beaconId: string; uuid: string; major: number; minor: number; measuredPowerDbm: number | null; enabled: boolean;
  label: string | null; lastObservedAt?: string | null;
  anchor: { anchorId: string; buildingId: string; floor: string | null; floorHeightM: number | null;
    position: { x: number; y: number; z: number }; horizontalAccuracyM?: number | null } | null;
}

/** The edit form of a registered beacon; the stored placement is EPSG:5186, so grid mode. */
export function formFromBeacon(b: AdminBeacon): BeaconForm {
  const a = b.anchor;
  const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  return {
    ...emptyForm(), uuid: b.uuid.toUpperCase(), major: String(b.major), minor: String(b.minor), measuredPowerDbm: s(b.measuredPowerDbm),
    label: b.label ?? '', buildingId: a?.buildingId ?? '', floor: a?.floor ?? '', floorHeightM: s(a?.floorHeightM),
    positionMode: a ? 'grid' : 'wgs84', x: s(a?.position.x), y: s(a?.position.y), z: s(a?.position.z), horizontalAccuracyM: s(a?.horizontalAccuracyM),
  };
}

/**
 * Edit form -> `PATCH /admin/beacons/:id` body: the same checks as a new beacon; identity is not sent (fixed); empty power /
 * label clear them (null); no placement unlinks the anchor.
 */
export function buildEditRequest(f: BeaconForm): { body: Record<string, unknown> } | { errors: Partial<Record<keyof BeaconForm, string>> } {
  const r = buildCreateRequest(f);
  if ('errors' in r) return r;
  const b = r.body;
  return { body: { measuredPowerDbm: b.measuredPowerDbm ?? null, label: b.label ?? null, ...(b.anchor ? { anchor: b.anchor } : { anchorId: null }) } };
}
