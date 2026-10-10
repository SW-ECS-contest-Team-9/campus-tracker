// Z08: 시험용 편집기(http://localhost:5273/editor.html, 시험 계정 T05 로 로그인만 한다)를 views.json 의 시점에서 찍는다. 읽기만 한다.
//   node editor_shots.mjs <저장 폴더> [시점 이름 일부 ...]      -> 편집기-<시점>.jpg   (단면 시점은 건너뜀)
// --remote-debugging-port=9333 으로 띄운 Chrome 이 있어야 한다. 프리뷰 쪽은 ../z05/shots.mjs.
import fs from 'node:fs';
import path from 'node:path';
const [outDir, ...only] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(new URL('./views.json', import.meta.url), 'utf8'));
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:5273/editor.html' });
await sleep(4000);
await ev(`(async () => { const login = document.getElementById('editor-login'); if (login && !login.hidden) { const s = document.getElementById('login-account');
  for (let k = 0; k < 20 && ![...s.options].some((o) => o.value === 'T05'); k++) await new Promise((r) => setTimeout(r, 500));
  s.value = 'T05'; document.getElementById('editor-login-form').requestSubmit(); } return 1; })()`);
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev('!!(window.__editor && window.Cesium)')) break; }
await sleep(8000);
await ev(`(async () => { const tm = await import('/src/tm.ts'); const C = window.Cesium, v = window.__editor.viewer;
  v.scene.screenSpaceCameraController.enableCollisionDetection = false;
  window.__P = (x, y, z) => { const g = tm.tmInverse(x, y); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, z); };
  window.__shot = async (w, n) => { const P = window.__P; const pos = P(...w.pos), tgt = P(...w.tgt), dir = C.Cartesian3.normalize(C.Cartesian3.subtract(tgt, pos, new C.Cartesian3()), new C.Cartesian3());
    let up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new C.Cartesian3());
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, up, new C.Cartesian3()), new C.Cartesian3()); up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
    v.camera.frustum.fov = C.Math.toRadians(w.fov); v.camera.setView({ destination: pos, orientation: { direction: dir, up } });
    for (let k = 0; k < n; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); }
    v.render(); return v.scene.canvas.toDataURL('image/jpeg', 0.9); }; return 1; })()`);
let first = true;
for (const [name, w] of Object.entries(V)) {
  if (w.section || (only.length && !only.some((o) => name.includes(o)))) continue;
  const url = await ev(`window.__shot(${JSON.stringify({ pos: w.pos, tgt: w.tgt, fov: w.fov })}, ${first ? 40 : 20})`); first = false;
  const f = path.join(outDir, `편집기-${name}.jpg`); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('saved', f);
}
ws.close();
