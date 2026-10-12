// Z13(z12/shots.mjs 와 같음. 시점은 z13/views.json 만): 시험 지도(프리뷰)와 시험용 편집기를 찍는다. 읽기만 한다. CDP_PORT 로 Chrome 을 고른다.
//   node shots.mjs preview|editor <저장 폴더> [시점 이름 일부 ...]     -> <TAG 기본 '후'>-지도-<시점>.jpg / <TAG>-편집기-<시점>.jpg   (TAG 환경 변수: 전|후)
// --remote-debugging-port=9357 으로 띄운 Chrome 이 있어야 한다. z05/shots.mjs 와 같은 방식이고 더한 것은 둘이다:
//   underground: true = '지하 길' 체크를 켜고 찍은 뒤 끈다.  section = 편집기에서도 같은 단면도 도구로 자른다.
import fs from 'node:fs';
import path from 'node:path';
const [mode, outDir, ...only] = process.argv.slice(2);
const editor = mode === 'editor';
const V = JSON.parse(fs.readFileSync(new URL('./views.json', import.meta.url), 'utf8'));
const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT ?? '9357') + '/json')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: editor ? 'http://localhost:5273/editor.html' : 'http://localhost:5273/' });
if (editor) {
  await sleep(4000);
  await ev(`(async () => { const login = document.getElementById('editor-login'); if (login && !login.hidden) { const s = document.getElementById('login-account');
    for (let k = 0; k < 20 && ![...s.options].some((o) => o.value === 'T05'); k++) await new Promise((r) => setTimeout(r, 500));
    s.value = 'T05'; document.getElementById('editor-login-form').requestSubmit(); } return 1; })()`);
}
const VIEWER = editor ? 'window.__editor.viewer' : 'window.__previewViewer', SECTION = editor ? 'window.__editor.layers.section' : 'window.__section', BOX = editor ? 'layer-underground' : 'scene-roads-underground';
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(${editor ? 'window.__editor' : 'window.__previewViewer'} && window.Cesium)`)) break; }
await sleep(8000);
await ev(`(async () => { const tm = await import('/src/tm.ts'); const C = window.Cesium, v = ${VIEWER};
  v.scene.screenSpaceCameraController.enableCollisionDetection = false;
  window.__P = (x, y, z) => { const g = tm.tmInverse(x, y); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, z); };
  window.__shot = async (w, n) => { const P = window.__P; const pos = P(...w.pos), tgt = P(...w.tgt), dir = C.Cartesian3.normalize(C.Cartesian3.subtract(tgt, pos, new C.Cartesian3()), new C.Cartesian3());
    let up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new C.Cartesian3());
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, up, new C.Cartesian3()), new C.Cartesian3()); up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
    v.camera.frustum.fov = C.Math.toRadians(w.fov); v.camera.setView({ destination: pos, orientation: { direction: dir, up } });
    for (let k = 0; k < n; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); }
    v.render(); return v.scene.canvas.toDataURL('image/jpeg', 0.9); }; return 1; })()`);
const check = (on) => ev(`(() => { const b = document.getElementById('${BOX}'); if (b.checked !== ${on}) b.click(); return b.checked; })()`);
let first = true;
for (const [name, w] of Object.entries(V)) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const view = JSON.stringify({ pos: w.pos, tgt: w.tgt, fov: w.fov });
  await check(!!w.underground);
  let url;
  if (w.section) {
    await ev(`window.__shot(${view}, ${first ? 30 : 2})`);
    await ev(`(() => { ${SECTION}.setLine(${JSON.stringify(w.section.a)}, ${JSON.stringify(w.section.b)}); if (${!!w.section.flip}) ${SECTION}.flip(); ${SECTION}.lookAt(${JSON.stringify(w.section.frame ?? {})}); return 1; })()`);
    url = await ev(`(async () => { const v = ${VIEWER}; for (let k = 0; k < 30; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); } v.render(); return v.scene.canvas.toDataURL('image/jpeg', 0.9); })()`);
    await ev(`(${SECTION}.stop(), 1)`);
  } else url = await ev(`window.__shot(${view}, ${first ? 40 : 24})`);
  first = false;
  await check(false);
  const f = path.join(outDir, `${process.env.TAG ?? '후'}-${editor ? '편집기' : '지도'}-${name}.jpg`); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('saved', f);
}
ws.close();
