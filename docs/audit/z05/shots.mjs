// Z05: 시험 지도(http://localhost:5273/)를 정해진 시점에서 찍어 파일로 저장한다. 읽기만 한다(DB·서버에 쓰지 않음).
//   node shots.mjs <views.json> <저장 폴더> <머리말> [시점 이름 일부 ...]
// --remote-debugging-port=9333 으로 띄운 Chrome 이 있어야 한다. views.json = {이름: {pos:[x,y,z], tgt:[x,y,z], fov}} (EPSG:5186, m)
import fs from 'node:fs';
import path from 'node:path';
const [viewsFile, outDir, prefix, ...only] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(viewsFile, 'utf8'));
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:5273/' });
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev('!!(window.__previewViewer && window.Cesium)')) break; }
await sleep(6000);
await ev(`(async () => { const tm = await import('/src/tm.ts'); const C = window.Cesium, v = window.__previewViewer;
  v.scene.screenSpaceCameraController.enableCollisionDetection = false;   // Z06: 낮은 시점이 덜 불러온 지형 타일에 밀려 올라가지 않게
  window.__P = (x, y, z) => { const g = tm.tmInverse(x, y); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, z); };
  window.__shot = async (w, n) => { const P = window.__P; const pos = P(...w.pos), tgt = P(...w.tgt), dir = C.Cartesian3.normalize(C.Cartesian3.subtract(tgt, pos, new C.Cartesian3()), new C.Cartesian3());
    let up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new C.Cartesian3());
    if (Math.abs(C.Cartesian3.dot(up, dir)) > 0.999) up = C.Cartesian3.normalize(C.Cartesian3.subtract(P(w.pos[0], w.pos[1] + 50, w.pos[2]), pos, new C.Cartesian3()), new C.Cartesian3());
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, up, new C.Cartesian3()), new C.Cartesian3()); up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
    v.camera.frustum.fov = C.Math.toRadians(w.fov); v.camera.setView({ destination: pos, orientation: { direction: dir, up } });
    for (let k = 0; k < n; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); }
    v.render(); return v.scene.canvas.toDataURL('image/jpeg', 0.9); }; return 1; })()`);
let first = true;
for (const [name, w] of Object.entries(V)) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const url = await ev(`window.__shot(${JSON.stringify({ pos: w.pos, tgt: w.tgt, fov: w.fov })}, ${first ? 40 : 24})`); first = false;
  const f = path.join(outDir, `${prefix}-${name}.jpg`); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('saved', f);
}
ws.close();
