// 사용자용 3D 페이지(client3d.html)의 끼워 넣기 메시지 형식 v1. 브라우저·Cesium 에 의존하지 않음(시험 가능).
// 받는 명령: setLocation, clearLocation, setRoute, clearRoute, focus, setFloor, setMarkerImages, setMode.
// 보내는 사건: ready, pick, cameraChanged, floorChanged, error. 모든 메시지에 v: 1.
// 좌표: 경로·focus 는 EPSG:5186 [x, y, z(MSL m)], 위치는 WGS84 lon/lat + z(MSL m).

export const PROTOCOL_VERSION = 1;

export type Xyz = [number, number, number];
export type FloorRef = string | null;

export type Command =
  | { type: 'setLocation'; lon: number; lat: number; z: number | null; accuracyM: number; floor: FloorRef; building: string | null; state: 'ok' | 'uncertain'; markerUrl: string | null }
  | { type: 'clearLocation' }
  | { type: 'setRoute'; points: Xyz[]; floorChanges: { at: Xyz; label: string | null }[] }
  | { type: 'clearRoute' }
  | { type: 'focus'; x: number; y: number; z: number | null; building: string | null; floor: FloorRef }
  | { type: 'setFloor'; building: string; floor: FloorRef; explode: boolean }
  | { type: 'setMarkerImages'; ok: string; uncertain: string }
  | { type: 'setMode'; light: boolean };

export type PageEvent =
  | { v: 1; type: 'ready'; buildings: { id: string; name: string }[]; light: boolean }
  | { v: 1; type: 'pick'; kind: 'building' | 'place' | 'point'; id?: string; name?: string; x: number; y: number; z: number }
  | { v: 1; type: 'cameraChanged'; x: number; y: number; heightM: number; headingDeg: number; pitchDeg: number }
  | { v: 1; type: 'floorChanged'; building: string | null; floor: string | null; explode: boolean }
  | { v: 1; type: 'error'; error: string; command?: string };

export type Parsed = { ok: true; command: Command } | { ok: false; error: string; command?: string };

const LIMITS = { routePoints: 5000, floorChanges: 200, text: 80, dataUrlBytes: 2_000_000, accuracyM: 5000 };
// 서경대 둘레보다 넉넉한 EPSG:5186 상자(잘못된 좌표계로 보낸 값을 막는 정도)
const TM_BOX = { minX: 150_000, maxX: 260_000, minY: 500_000, maxY: 620_000 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= LIMITS.text;

class Bad extends Error {}
const need = (cond: boolean, msg: string) => { if (!cond) throw new Bad(msg); };
const optNum = (v: unknown, name: string): number | null => { if (v === undefined || v === null) return null; need(num(v), `${name}: 숫자 또는 null`); return v as number; };
const optText = (v: unknown, name: string): string | null => { if (v === undefined || v === null) return null; need(text(v), `${name}: 1~${LIMITS.text}자 문자열 또는 null`); return v as string; };
/** 층: "5F", "B1", "3층", "지하 1층" 같은 문자열, 또는 정수(음수 = 지하). */
const floorRef = (v: unknown, name: string): FloorRef => {
  if (v === undefined || v === null) return null;
  if (num(v)) { need(Number.isInteger(v) && v !== 0 && Math.abs(v) < 100, `${name}: 0이 아닌 정수`); return (v as number) < 0 ? `B${-(v as number)}` : `${v}F`; }
  need(text(v), `${name}: 문자열·정수·null`);
  return v as string;
};
const tm = (v: unknown, name: string): Xyz => {
  need(Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every(num), `${name}: [x, y, z] 숫자 배열`);
  const [x, y, z] = v as number[];
  need(x >= TM_BOX.minX && x <= TM_BOX.maxX && y >= TM_BOX.minY && y <= TM_BOX.maxY, `${name}: EPSG:5186 범위 밖`);
  need(z === undefined || (z > -100 && z < 1000), `${name}: z(MSL m) 범위 밖`);
  return [x, y, z ?? NaN];
};

/** 표시용 그림 주소: data:image/(png|gif|jpeg|webp);base64 (2 MB 이하) 또는 http(s)/같은 출처 경로. */
export function imageUrl(v: unknown): boolean {
  if (typeof v !== 'string' || !v) return false;
  if (v.startsWith('data:')) return v.length <= LIMITS.dataUrlBytes && /^data:image\/(png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v);
  if (/^https?:\/\//i.test(v)) return v.length <= 2000 && !/[\s"'<>]/.test(v);
  return /^\/[\w./-]{1,200}$/.test(v) && !v.includes('..');
}

/** 받은 메시지(객체 또는 JSON 문자열)를 검사해 명령으로. 모르는 것은 거절(이유와 함께). */
export function parseCommand(raw: unknown): Parsed {
  let data = raw;
  if (typeof raw === 'string') {
    if (raw.length > 4_000_000) return { ok: false, error: '메시지가 너무 큼' };
    try { data = JSON.parse(raw); } catch { return { ok: false, error: 'JSON 아님' }; }
  }
  if (!isObj(data)) return { ok: false, error: '객체 아님' };
  const type = typeof data.type === 'string' ? data.type : undefined;
  if (data.v !== PROTOCOL_VERSION) return { ok: false, error: `v 는 ${PROTOCOL_VERSION} 이어야 함`, command: type };
  try {
    switch (type) {
      case 'setLocation': {
        need(num(data.lon) && num(data.lat) && Math.abs(data.lon as number) <= 180 && Math.abs(data.lat as number) <= 90, 'lon/lat: WGS84 숫자');
        need(num(data.accuracyM) && (data.accuracyM as number) >= 0 && (data.accuracyM as number) <= LIMITS.accuracyM, `accuracyM: 0~${LIMITS.accuracyM}`);
        need(data.state === 'ok' || data.state === 'uncertain', "state: 'ok' 또는 'uncertain'");
        const markerUrl = data.markerUrl === undefined || data.markerUrl === null ? null : data.markerUrl;
        need(markerUrl === null || imageUrl(markerUrl), 'markerUrl: data:image 또는 http(s) 주소');
        return { ok: true, command: { type, lon: data.lon as number, lat: data.lat as number, z: optNum(data.z, 'z'), accuracyM: data.accuracyM as number,
          floor: floorRef(data.floor, 'floor'), building: optText(data.building, 'building'), state: data.state as 'ok' | 'uncertain', markerUrl: markerUrl as string | null } };
      }
      case 'clearLocation': case 'clearRoute':
        return { ok: true, command: { type } };
      case 'setRoute': {
        need(Array.isArray(data.points) && data.points.length >= 2 && data.points.length <= LIMITS.routePoints, `points: 2~${LIMITS.routePoints}개`);
        const points = (data.points as unknown[]).map((p, i) => tm(p, `points[${i}]`));
        need(points.every((p) => Number.isFinite(p[2])), 'points: 경로 점에는 z 가 있어야 함');
        const fc = data.floorChanges ?? [];
        need(Array.isArray(fc) && fc.length <= LIMITS.floorChanges, 'floorChanges: 배열');
        const floorChanges = (fc as unknown[]).map((c, i) => {
          need(isObj(c), `floorChanges[${i}]: { at, label? }`);
          const at = tm((c as Record<string, unknown>).at, `floorChanges[${i}].at`);
          need(Number.isFinite(at[2]), `floorChanges[${i}].at: z 필요`);
          return { at, label: optText((c as Record<string, unknown>).label, `floorChanges[${i}].label`) };
        });
        return { ok: true, command: { type, points, floorChanges } };
      }
      case 'focus': {
        need(num(data.x) && num(data.y), 'x, y: EPSG:5186 숫자');
        const [x, y] = tm([data.x, data.y], 'x, y');
        return { ok: true, command: { type, x, y, z: optNum(data.z, 'z'), building: optText(data.building, 'building'), floor: floorRef(data.floor, 'floor') } };
      }
      case 'setFloor': {
        need(text(data.building), 'building: 건물 id');
        need(data.explode === undefined || typeof data.explode === 'boolean', 'explode: true/false');
        return { ok: true, command: { type, building: data.building as string, floor: floorRef(data.floor, 'floor'), explode: data.explode === true } };
      }
      case 'setMarkerImages':
        need(imageUrl(data.ok) && imageUrl(data.uncertain), 'ok, uncertain: data:image 또는 http(s) 주소');
        return { ok: true, command: { type, ok: data.ok as string, uncertain: data.uncertain as string } };
      case 'setMode':
        need(typeof data.light === 'boolean', 'light: true/false');
        return { ok: true, command: { type, light: data.light as boolean } };
      default:
        return { ok: false, error: `모르는 명령: ${String(type)}`, command: type };
    }
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.message, command: type };
    throw e;
  }
}

/** 출처 허용 목록(쉼표 구분, 빈 값 = 모두 허용). React Native WebView 의 메시지(출처 없음)는 그 안에서만 받는다. */
export function originAllowed(origin: string, allowList: string, inNativeWebView: boolean): boolean {
  const list = allowList.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  if ((origin === '' || origin === 'null') && inNativeWebView) return true;
  return list.includes(origin);
}

/** 층 문자열 → 층 번호("5F" 5, "B1" -1, "지하 1층" -1); 모르면 null. */
export function floorNumber(ref: string | null): number | null {
  if (!ref) return null;
  const m = /^\s*(?:지하\s*(\d{1,2})\s*층|B(\d{1,2})|(\d{1,2})\s*(?:층|F))\s*$/i.exec(ref);
  if (!m) return null;
  return m[1] ? -Number(m[1]) : m[2] ? -Number(m[2]) : Number(m[3]) || null;
}

/** 건물의 층 목록에서 층 고르기: 이름의 층 번호가 같은 것, 없으면 z 가 가장 가까운 것(1.5 m 안). */
export function matchFloor(floors: { m: number; name: string | null }[], ref: string | null, z: number | null = null): number {
  const n = floorNumber(ref);
  if (n !== null) { const i = floors.findIndex((f) => floorNumber(f.name) === n); if (i >= 0) return i; }
  if (z !== null && Number.isFinite(z)) {
    let best = -1;
    floors.forEach((f, i) => { if (Math.abs(f.m - z) <= 1.5 && (best < 0 || Math.abs(f.m - z) < Math.abs(floors[best].m - z))) best = i; });
    return best;
  }
  return -1;
}

/** 일정 간격보다 자주 부르지 않게(마지막 호출은 반드시 보냄). */
export function throttle<T extends unknown[]>(fn: (...a: T) => void, ms: number, now: () => number = Date.now) {
  let last = -Infinity, timer: ReturnType<typeof setTimeout> | null = null, pending: T | null = null;
  return (...a: T) => {
    const t = now();
    if (t - last >= ms) { last = t; fn(...a); return; }
    pending = a;
    if (!timer) timer = setTimeout(() => { timer = null; last = now(); if (pending) fn(...pending); pending = null; }, ms - (t - last));
  };
}
