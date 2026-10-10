// F07: 시험 지도에서 건물 겉모습이 다른 기능과 함께 도는지 본다(읽기만 한다. 편집기는 시험 계정 T05 로 로그인만 한다).
//   node check.mjs <저장 폴더>
// --remote-debugging-port=9333 으로 띄운 Chrome 이 있어야 한다. 프리뷰: X-ray, 단면, 건물 집기, 다시 그리는 시간. 편집기: 같은 시점 넷.
import fs from 'node:fs';
import path from 'node:path';
const outDir = process.argv[2];
const V = JSON.parse(fs.readFileSync(new URL('./views.json', import.meta.url), 'utf8'));
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, url) => { const f = path.join(outDir, name); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('saved', f); };
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
const helpers = (viewer) => `(async () => { const tm = await import('/src/tm.ts'); const C = window.Cesium, v = ${viewer};
  v.scene.screenSpaceCameraController.enableCollisionDetection = false;
  window.__P = (x, y, z) => { const g = tm.tmInverse(x, y); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, z); };
  window.__shot = async (w, n) => { const P = window.__P; const pos = P(...w.pos), tgt = P(...w.tgt), dir = C.Cartesian3.normalize(C.Cartesian3.subtract(tgt, pos, new C.Cartesian3()), new C.Cartesian3());
    let up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new C.Cartesian3());
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, up, new C.Cartesian3()), new C.Cartesian3()); up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
    v.camera.frustum.fov = C.Math.toRadians(w.fov); v.camera.setView({ destination: pos, orientation: { direction: dir, up } });
    for (let k = 0; k < n; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); }
    v.render(); return v.scene.canvas.toDataURL('image/jpeg', 0.9); }; return 1; })()`;
const shot = (name, n = 16) => ev(`window.__shot(${JSON.stringify(V[Object.keys(V).find((k) => k.startsWith(name))])}, ${n})`);

// ---- 프리뷰
await send('Page.navigate', { url: 'http://localhost:5273/' });
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev('!!(window.__previewViewer && window.Cesium && window.__layers)')) break; }
await sleep(6000);
await ev(helpers('window.__previewViewer'));
await shot('11', 40);
// 집기: 벽의 창 판·모임지붕·평지붕 뚜껑 위의 점이 그 건물로 집히는지
const picks = await ev(`(() => { const v = window.__previewViewer, C = window.Cesium, out = {};
  for (const [name, p] of Object.entries({ '혜인관 벽(창 판)': [201222, 557222, 160], '대일관 지붕': [201170, 557318, 174], '청운관 지붕': [201225, 557290, 187.9] })) {
    const w = C.SceneTransforms.worldToWindowCoordinates(v.scene, window.__P(...p)); const hit = w && v.scene.pick(w); out[name] = hit?.id?.buildingId ?? (hit ? 'other' : null); }
  return out; })()`);
console.log('집기', JSON.stringify(picks));
// X-ray
await ev(`(() => { const i = document.getElementById('scene-xray'); i.checked = true; i.dispatchEvent(new Event('change')); })()`);
save('확인-프리뷰-Xray-운동장.jpg', await shot('11'));
await ev(`(() => { const i = document.getElementById('scene-xray'); i.checked = false; i.dispatchEvent(new Event('change')); })()`);
// 다시 그리는 시간(선택을 바꿀 때마다 건물 층 전체를 다시 만든다)
const ms = await ev(`(() => { const s = window.__layers; const scene = window.__previewViewer && (window.__campusScene || null); const t = performance.now();
  for (let k = 0; k < 5; k++) { window.__section.setLine([201100, 557230 + k], [201260, 557300]); } const cut = (performance.now() - t) / 5; window.__section.stop(); return Math.round(cut); })()`);
console.log('단면 한 번 다시 그리기 ms', ms);
// 단면: 운동장을 가로질러 대일관·혜인관을 자른다
await ev(`window.__section.setLine([201130, 557240], [201250, 557300])`);
save('확인-프리뷰-단면-대일관·청운관.jpg', await shot('11'));
await ev(`window.__section.stop()`);
const fps = await ev(`(async () => { const v = window.__previewViewer; let n = 0; const t = performance.now(); while (performance.now() - t < 3000) { v.render(); n++; await new Promise((r) => setTimeout(r, 0)); } return Math.round(n / 3); })()`);
console.log('프리뷰 초당 그리기(머리 없는 Chrome, 소프트웨어 그리기일 수 있음)', fps);

// ---- 편집기
await send('Page.navigate', { url: 'http://localhost:5273/editor.html' });
await sleep(4000);
await ev(`(async () => { const login = document.getElementById('editor-login'); if (login && !login.hidden) { const s = document.getElementById('login-account');
  for (let k = 0; k < 20 && ![...s.options].some((o) => o.value === 'T05'); k++) await new Promise((r) => setTimeout(r, 500));
  s.value = 'T05'; document.getElementById('editor-login-form').requestSubmit(); } return 1; })()`);
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev('!!(window.__editor && window.Cesium)')) break; }
await sleep(8000);
await ev(helpers('window.__editor.viewer'));
let first = true;
for (const key of ['01', '04', '05', '10', '02', '09']) { const name = Object.keys(V).find((k) => k.startsWith(key)); save(`편집기-${name}.jpg`, await shot(key, first ? 40 : 20)); first = false; }
ws.close();
