// U09: 시험 지도(프리뷰)·시험용 편집기에서 (1) 구획을 띄운 화면(층 따로 보기)을 바로 위에서(북이 위) (2) views.json 의 단면·지하 길 시점을 찍는다. 읽기만 한다.
//   node shots.mjs preview|editor <저장 폴더> <머리말: 전|후> [이름 일부 ...]     -> 지도-u09-<머리말>-<이름>.jpg / 편집기-u09-…
// --remote-debugging-port=9333 으로 띄운 Chrome 이 있어야 한다. 띄운 화면의 틀(가운데·가로 m)은 views.json 의 lift 항목: 학교 지도 조각 또는 사용자 그림 12 와 같은 틀.
import fs from 'node:fs';
import path from 'node:path';
const [mode, outDir, tag, ...only] = process.argv.slice(2);
const editor = mode === 'editor';
const V = JSON.parse(fs.readFileSync(new URL('./views.json', import.meta.url), 'utf8'));
const tab = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
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
const SV = editor ? 'window.__editor.spaceViews' : 'window.__spaceViews', LEVEL = editor ? 'view-level' : 'scene-level-view';
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(${editor ? 'window.__editor && window.__editor.spaceViews' : 'window.__previewViewer && window.__spaceViews'}) && !!window.Cesium`)) break; }
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev(`${SV}.level.zones.length > 0 && ${SV}.level.solids.length > 0`)) break; }
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
const save = (name, url) => { const f = path.join(outDir, `${editor ? '편집기' : '지도'}-u09-${name}.jpg`); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('saved', f); };
const want = (name) => !only.length || only.some((o) => name.includes(o));
let first = true;
for (const [name, w] of Object.entries(V)) {
  if (!want(name)) continue;
  if (w.lift) {
    // 띄운 판의 높이: 가장 높은 지붕 + 15 m (level-view.ts LEVEL_VIEW.clearRoofM). 그 위 2,000 m 에서 좁은 화각으로 바로 내려다본다(북이 위)
    if (!(await ev(`${SV}.level.active`))) await ev(`(document.getElementById('${LEVEL}').click(), 1)`);
    await sleep(500);
    const plateM = await ev(`(() => { const L = ${SV}.level; L.showZone(${JSON.stringify(w.lift.zone)}); return Math.max(...L.src.buildings().map((b) => b.roofM), 0) + 15; })()`);
    await sleep(5000);
    // 틀: widthM(화면 가로가 몇 m) 또는 pxPerM(사용자 그림과 같은 축척). 높이 upM 에서 내려다본다(낮을수록 이름표가 크다). Cesium 의 fov 는 긴 변(가로) 기준
    const canvasW = await ev(`${VIEWER}.scene.canvas.clientWidth`);
    const [cx, cy] = w.lift.centre, up = w.lift.upM ?? 2000, widthM = w.lift.widthM ?? canvasW / w.lift.pxPerM, fov = (2 * Math.atan(widthM / 2 / up) * 180) / Math.PI;
    const az = ((w.lift.upAzDeg ?? 0) * Math.PI) / 180;   // 화면 위쪽의 방위(기본 북)
    save(name, await ev(`window.__shot(${JSON.stringify({ pos: [cx - 0.5 * Math.sin(az), cy - 0.5 * Math.cos(az), plateM + up], tgt: [cx, cy, plateM], fov })}, ${first ? 30 : 16})`));
    await ev(`(document.getElementById('${LEVEL}').click(), 1)`); await sleep(1200);
  } else if (w.walk) {
    // 1인칭(first-person.ts): 정한 자리에 서서 정한 쪽을 본다. 화각만 사진에 맞춰 넓힌다
    await check(true);
    const res = await ev(`(() => { const W = ${SV}.walk; const a = ${JSON.stringify(w.walk)}; W.start(a.at[0], a.at[1], a.at[2], a.heading); W.state.pitch = a.pitch; return W.where ? W.where() : 1; })()`);
    console.log(name, '->', JSON.stringify(res));
    await sleep(6000);
    const url = await ev(`(async () => { const C = window.Cesium, v = ${VIEWER}; const old = v.camera.frustum.fov; v.camera.frustum.fov = C.Math.toRadians(${w.walk.fov});
      for (let k = 0; k < 16; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); } v.render(); const u = v.scene.canvas.toDataURL('image/jpeg', 0.9); v.camera.frustum.fov = old; return u; })()`);
    await ev(`(${SV}.walk.stop(), 1)`); await sleep(800); await check(false);
    save(name, url);
  } else {
    const view = JSON.stringify({ pos: w.pos, tgt: w.tgt, fov: w.fov });
    await check(!!w.underground);
    let url;
    if (w.section) {
      await ev(`window.__shot(${view}, ${first ? 30 : 2})`);
      await ev(`(() => { ${SECTION}.setLine(${JSON.stringify(w.section.a)}, ${JSON.stringify(w.section.b)}); if (${!!w.section.flip}) ${SECTION}.flip(); ${SECTION}.lookAt(${JSON.stringify(w.section.frame ?? {})}); return 1; })()`);
      url = await ev(`(async () => { const v = ${VIEWER}; for (let k = 0; k < 30; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); } v.render(); return v.scene.canvas.toDataURL('image/jpeg', 0.9); })()`);
      await ev(`(${SECTION}.stop(), 1)`);
    } else url = await ev(`window.__shot(${view}, ${first ? 40 : 24})`);
    await check(false);
    save(name, url);
  }
  first = false;
}
ws.close();
await fetch(`http://127.0.0.1:9333/json/close/${tab.id}`);
