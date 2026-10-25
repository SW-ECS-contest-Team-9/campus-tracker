// EJ1: 은주관 층 따로 보기 갈무리(읽기만). 화면 1280×720, headless Chrome(CDP_PORT, 기본 9358), 미리보기(BASE, 기본 http://localhost:5283).
//   node docs/audit/ej1/shots.mjs <저장 폴더>
// 시험 서버의 장면(GET /api/v1/scene)은 그대로 두고, 응답 안 은주관 덩어리의 창 층 표(appearance.windows.floorsM·floorNames)만
// 이 가지 backend/data/scene/overrides/building-roofs.json 의 값으로 바꿔 끼운다(층 펼치기의 층 표 = 그 값). 실내 구조는 frontend/public/interiors.geojson.
import fs from 'node:fs';
import path from 'node:path';
const [outDir] = process.argv.slice(2);
const BASE = process.env.BASE ?? 'http://localhost:5283', CDP = process.env.CDP_PORT ?? '9358';
const roofs = JSON.parse(fs.readFileSync(new URL('../../../backend/data/scene/overrides/building-roofs.json', import.meta.url), 'utf8'));
const looks = new Map(roofs.appearance.filter((a) => a.id.startsWith('은주관')).map((a) => [a.id, a]));
const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = async (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method !== 'Fetch.requestPaused') return;
  const { requestId } = msg.params;
  const body = await send('Fetch.getResponseBody', { requestId });
  const scene = JSON.parse(body.result.base64Encoded ? Buffer.from(body.result.body, 'base64').toString('utf8') : body.result.body);
  let n = 0;
  for (const b of scene.buildings ?? []) {
    const a = looks.get(b.buildingId);
    if (a?.windows && b.appearance?.windows) { b.appearance.windows.floorsM = a.windows.floorsM; b.appearance.windows.floorNames = a.windows.floorNames; n++; }
  }
  console.log('scene: 은주관 층 표 바꿈', n);
  await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(scene)).toString('base64') });
};
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1500)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/scene', requestStage: 'Response' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/` });
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(window.__spaceViews && window.__previewViewer)`)) break; }
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev(`window.__spaceViews.level.zones.length > 0 && window.__spaceViews.level.interiors.length > 0`)) break; }
await sleep(8000);
const SV = 'window.__spaceViews', VIEWER = 'window.__previewViewer';
await ev(`(() => { ${VIEWER}.scene.screenSpaceCameraController.enableCollisionDetection = false; return 1; })()`);
const look = (v) => ev(`(async () => { const C = window.Cesium, cam = ${VIEWER}.camera, s = ${SV}.level.frameSphere; if (!s) return 0;
  const v = ${JSON.stringify(v)}; cam.cancelFlight(); cam.frustum.fov = C.Math.toRadians(50);
  cam.lookAt(s.center, new C.HeadingPitchRange(C.Math.toRadians(v.heading), C.Math.toRadians(v.pitch), s.radius * v.range));
  cam.lookAtTransform(C.Matrix4.IDENTITY); cam.moveLeft(s.radius * (v.shift ?? 0.3)); return 1; })()`);
if (!(await ev(`${SV}.level.active`))) await ev(`(document.getElementById('scene-level-view').click(), 1)`);
await sleep(500);
const lift = (id, floor) => ev(`(() => { const L = ${SV}.level; L.showBuilding(${JSON.stringify(id)});
  const i = ${JSON.stringify(floor)} === null ? null : L.unit.floors.findIndex((f) => f.name === ${JSON.stringify(floor)});
  if (i !== null && i >= 0) L.showBuilding(${JSON.stringify(id)}, i);
  return { unit: L.unit.name, floor: i === null ? '전체' : (L.unit.floors[i] || {}).name, floors: L.unit.floors.map((f) => f.name + ' ' + f.m), inside: L.interiors.filter((s) => s.building === ${JSON.stringify(id)}).length }; })()`);
const STACK = { heading: -25, pitch: -40, range: 2.6, shift: 0.3 }, FLOOR = { heading: -25, pitch: -60, range: 3.2, shift: 0.4 };
const PLAN = [
  ['은주관', null, STACK, '은주1관-전체'], ['은주관', '1층', FLOOR, '은주1관-1층'], ['은주관', '3층', FLOOR, '은주1관-3층'], ['은주관', '5층', FLOOR, '은주1관-5층'],
  ['은주관#2관', null, STACK, '은주2관-전체'], ['은주관#2관', '1층', FLOOR, '은주2관-1층'], ['은주관#2관', '6층', FLOOR, '은주2관-6층'], ['은주관#2관', '7층', FLOOR, '은주2관-7층'],
];
fs.mkdirSync(outDir, { recursive: true });
const log = [];
for (const [id, floor, view, name] of PLAN) {
  const r = await lift(id, floor); await sleep(2500); await look(view);
  for (let k = 0; k < 6; k++) { await ev(`(${VIEWER}.scene.requestRender(), ${VIEWER}.render(), 1)`); await sleep(400); }
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  const f = path.join(outDir, `층따로-${name}.jpg`); fs.writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', f, JSON.stringify(r)); log.push({ name, ...r });
}
fs.writeFileSync(path.join(outDir, '층따로-기록.json'), JSON.stringify(log, null, 1));
process.exit(0);
