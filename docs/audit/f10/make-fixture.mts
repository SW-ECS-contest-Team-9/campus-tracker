// F10: 띄운 화면의 궤적 그리기를 보려고 지어낸 궤적(실제 수집 자료 아님)을 만든다. 시험용 백엔드(3210)에서 길·건물만 읽는다.
//   cd frontend && node --import tsx ../docs/audit/f10/make-fixture.mts   -> frontend/test/fixtures/f10-tracks.json
// 경로: 운동장 위 → 지하 1층 통로 → 1층–2층 경사로 → 지하 2층 → (높이 없는 점, 터무니없는 높이의 점) → 은주관 두 층 → 지하 차도.
// 퓨전: 1 m 마다. 원본: 4 m 마다 ±1.5 m 흔들림, 일부는 높이를 믿을 수 없음.
import fs from 'node:fs';
const { tmForward } = await import('../../../frontend/src/tm.ts');
const api = async (path: string) => (await fetch(`http://127.0.0.1:3210${path}`)).json();
const roads: { name: string | null; geometry: { coordinates: number[][] } }[] = (await api('/api/v1/mobility/roads')).roads;
const scene = await api('/api/v1/scene');
const find = (part: string) => { const r = roads.find((x) => (x.name ?? '').includes(part)); if (!r) throw new Error(`길 없음: ${part}`); return r.geometry.coordinates; };
const PHONE = 1.2;
const up = (line: number[][]) => line.map((p) => [p[0], p[1], p[2] + PHONE]);
const ramp = find('지하 1층–지하 2층 경사로');
const rampDown = ramp[0][2] > ramp[ramp.length - 1][2] ? ramp : [...ramp].reverse();
const tunnel = find('지하 차도 (본관·문예관 사이');
const eunju = scene.buildings.find((b: { buildingId: string }) => b.buildingId === '은주관');
const ring: number[][] = eunju.geometry.coordinates[0][0].map(([lon, lat]: number[]) => { const p = tmForward(lat, lon); return [p.x, p.y]; });
const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
const floors: number[] = (eunju.appearance?.windows?.floorsM ?? []).filter((m: number) => m >= eunju.baseM - 2.5 && m < eunju.roofM);
const inB = (k: number) => [cx + (ring[k][0] - cx) * 0.45, cy + (ring[k][1] - cy) * 0.45];
const legs: { line: (number | null)[][]; reliable?: boolean }[] = [
  { line: [[201215, 557235, 148.9 + PHONE], [201180, 557262, 148.9 + PHONE]] }, // 운동장 위
  { line: [[201160, 557266, 141.4 + PHONE], [201172, 557238, 141.4 + PHONE], [201200, 557214, 141.4 + PHONE], [rampDown[0][0], rampDown[0][1], 141.4 + PHONE]] }, // 지하 1층
  { line: up(rampDown) }, // 경사로
  { line: [[rampDown[rampDown.length - 1][0], rampDown[rampDown.length - 1][1], 137.9 + PHONE], [201185, 557225, 137.9 + PHONE], [201205, 557205, 137.9 + PHONE]] }, // 지하 2층
  { line: [[201205, 557205, null], [201215, 557230, null]] }, // 높이 없음
  { line: [[201215, 557230, 125], [201200, 557250, 125]] }, // 터무니없는 높이
  ...floors.slice(1, 3).map((m, i) => ({ line: [[...inB(0), m + PHONE], [...inB(Math.floor(ring.length / 3)), m + PHONE], [...inB(Math.floor((2 * ring.length) / 3) + i), m + PHONE]] })), // 은주관 두 층
  { line: up(tunnel) }, // 지하 차도
];
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const r1 = (v: number) => Math.round(v * 10) / 10;
const fused: object[] = [], raw: object[] = [];
for (const leg of legs) {
  for (let i = 0; i + 1 < leg.line.length; i++) {
    const a = leg.line[i], b = leg.line[i + 1], d = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!), n = Math.max(1, Math.round(d));
    for (let k = 0; k < n; k++) {
      const t = k / n, x = a[0]! + (b[0]! - a[0]!) * t, y = a[1]! + (b[1]! - a[1]!) * t, h = a[2] == null || b[2] == null ? null : a[2] + (b[2] - a[2]) * t;
      fused.push({ x: r1(x), y: r1(y), h: h == null ? null : r1(h) });
      if (k % 4 === 0) { const poor = raw.length % 7 === 3; raw.push({ x: r1(x + rnd() * 3), y: r1(y + rnd() * 3), h: h == null ? null : r1(h + rnd() * 1.5), ...(poor ? { reliable: false } : {}) }); }
    }
  }
}
const out = { note: '지어낸 궤적(실제 수집 자료 아님). docs/audit/f10/make-fixture.mts 로 만듦. 좌표 EPSG:5186 m, 높이 MSL.', tracks: [
  { id: 'f10-raw', kind: 'raw', label: '지어낸 세션 원본', points: raw }, { id: 'f10-fused', kind: 'fused', label: '지어낸 퓨전', points: fused }] };
fs.mkdirSync('test/fixtures', { recursive: true });
fs.writeFileSync('test/fixtures/f10-tracks.json', `${JSON.stringify(out)}\n`);
console.log('점', raw.length, fused.length, '은주관 층', floors.slice(1, 3), '경사로', rampDown[0], rampDown[rampDown.length - 1]);
