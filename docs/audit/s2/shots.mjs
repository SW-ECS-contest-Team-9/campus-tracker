// 사2 층 펼치기 실내 구조: 편집기(또는 프리뷰)에서 건물 층을 펼쳐 실내 구조를 그리기 전·후를 찍는다. 읽기만 한다.
//   node shots.mjs editor|preview <저장 폴더> [건물 ...] [--base=http://localhost:5273] [--chrome=9356]
//   -> 실내-<건물>-<전체|층>-<전|후>.jpg   전 = 같은 화면에서 실내 구조(level.interiors)를 비우고 그린 것(지금까지의 모습).
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const [mode, outDir, ...only] = args.filter((a) => !a.startsWith('--'));
const editor = mode === 'editor', BASE = opt('base', 'http://localhost:5273'), CHROME = opt('chrome', '9356');
const list = await (await fetch(`http://127.0.0.1:${CHROME}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1500)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/${editor ? 'editor.html' : ''}` });
if (editor) {
  await sleep(4000);
  await ev(`(async () => { const login = document.getElementById('editor-login'); if (login && !login.hidden) { const s = document.getElementById('login-account');
    for (let k = 0; k < 20 && ![...s.options].some((o) => o.value === 'T05'); k++) await new Promise((r) => setTimeout(r, 500));
    s.value = 'T05'; document.getElementById('editor-login-form').requestSubmit(); } return 1; })()`);
}
const SV = editor ? 'window.__editor.spaceViews' : 'window.__spaceViews';
const VIEWER = editor ? 'window.__editor.viewer' : 'window.__previewViewer';
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(${editor ? 'window.__editor && window.__editor.spaceViews' : 'window.__spaceViews && window.__previewViewer'})`)) break; }
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev(`${SV}.level.zones.length > 0 && ${SV}.level.interiors.length > 0`)) break; }
await sleep(8000);
await ev(`(() => { ${VIEWER}.scene.screenSpaceCameraController.enableCollisionDetection = false; return 1; })()`);
const look = (v) => ev(`(async () => { const C = window.Cesium, cam = ${VIEWER}.camera, s = ${SV}.level.frameSphere; if (!s) return 0;
  const v = ${JSON.stringify(v)}; cam.cancelFlight(); cam.frustum.fov = C.Math.toRadians(50);
  cam.lookAt(s.center, new C.HeadingPitchRange(C.Math.toRadians(v.heading), C.Math.toRadians(v.pitch), s.radius * v.range));
  cam.lookAtTransform(C.Matrix4.IDENTITY); cam.moveLeft(s.radius * (v.shift ?? 0.3)); return 1; })()`);
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  const f = path.join(outDir, `실내-${name}.jpg`);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); console.log('saved', f);
};
const LEVEL = editor ? 'view-level' : 'scene-level-view';
if (!(await ev(`${SV}.level.active`))) await ev(`(document.getElementById('${LEVEL}').click(), 1)`);
await sleep(500);
await ev(`(() => { window.__s2keep = ${SV}.level.interiors; return window.__s2keep.length; })()`);
/** id 건물을 띄운다. floor: 층 이름(없으면 전체). carved false: 실내 구조를 비우고(전). */
const lift = (id, floor, carved) => ev(`(() => { const L = ${SV}.level; L.interiors = ${carved} ? window.__s2keep : [];
  L.showBuilding(${JSON.stringify(id)}); const i = ${JSON.stringify(floor ?? null)} === null ? null : L.unit.floors.findIndex((f) => f.name === ${JSON.stringify(floor ?? null)});
  if (i !== null && i >= 0) L.showBuilding(${JSON.stringify(id)}, i);
  return L.unit.name + ' ' + (i === null ? '전체' : (L.unit.floors[i] || {}).name) + ' 실내 ' + L.interiors.filter((s) => s.building === ${JSON.stringify(id)}).length; })()`);
const STACK = { heading: -25, pitch: -50, range: 2.6, shift: 0.4 }, FLOOR = { heading: -25, pitch: -60, range: 3.6, shift: 0.5 };
const PLAN = [
  ['북악관', null, STACK], ['북악관', '2층', FLOOR], ['북악관', '지하 1층', FLOOR], ['북악관', '1층', FLOOR],
  ['본관', null, STACK], ['본관', '5층', FLOOR], ['본관', '2층', FLOOR],
  ['한림관', null, STACK], ['한림관', '3층', FLOOR], ['한림관', '1층', FLOOR],
  ['은주관', null, STACK], ['은주관', '1층', FLOOR], ['은주관', '3층', FLOOR], ['은주관', '5층', FLOOR],
  ['은주관#2관', null, STACK], ['은주관#2관', '2층', FLOOR], ['은주관#2관', '6층', FLOOR],
  ['수인관', null, STACK], ['수인관', '1층', FLOOR],
];
for (const [id, floor, view] of PLAN) {
  if (only.length && !only.includes(id.split('#')[0])) continue;
  for (const carved of [false, true]) {
    console.log(await lift(id, floor, carved));
    await sleep(2500); await look(view); await sleep(4000);
    await shot(`${id.replace('#', '-')}-${floor ?? '전체'}-${carved ? '후' : '전'}`);
  }
}
await ev(`(() => { ${SV}.level.interiors = window.__s2keep; return 1; })()`);
await ev(`(document.getElementById('${LEVEL}').click(), 1)`); await sleep(800);
ws.close();
