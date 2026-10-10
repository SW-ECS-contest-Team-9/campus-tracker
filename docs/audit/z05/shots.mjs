// Z05: 시험 지도(http://localhost:5273/)를 정해진 시점에서 찍어 파일로 저장한다. 읽기만 한다(DB·서버에 쓰지 않음).
//   node shots.mjs <views.json> <저장 폴더> <머리말> [시점 이름 일부 ...]
// --remote-debugging-port=9333 으로 띄운 Chrome 이 있어야 한다. views.json = {이름: {pos:[x,y,z], tgt:[x,y,z], fov}} (EPSG:5186, m)
// Z07: 시점에 section: {a:[x,y], b:[x,y], flip?: true, ortho?: true(자른 면 정면 보기), zoom?: {widthM, centerM}(정면 보기에서 보이는 폭과 가운데 높이)} 가 있으면 그 선으로 단면을 켜고 찍은 뒤 끈다(프리뷰의 단면도 기능 그대로).
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
await send('Page.navigate', { url: process.env.SHOT_URL || 'http://localhost:5273/' });   // SHOT_URL: 다른 포트의 화면(작업 체크아웃을 바로 볼 때)
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
  const view = JSON.stringify({ pos: w.pos, tgt: w.tgt, fov: w.fov });
  let url;
  if (w.section) {   // 카메라를 먼저 놓는다(단면은 카메라가 있는 쪽 절반을 숨긴다). ortho: 자른 면을 정면에서 원근 없이
    await ev(`window.__shot(${view}, 2)`);
    await ev(`(() => { window.__section.setLine(${JSON.stringify(w.section.a)}, ${JSON.stringify(w.section.b)}); if (${!!w.section.flip}) window.__section.flip(); if (${!!w.section.ortho}) window.__section.lookAt(); const z = ${JSON.stringify(w.section.zoom ?? null)}; if (z) { const c = window.__previewViewer.camera; c.moveUp(z.centerM - window.Cesium.Cartographic.fromCartesian(c.positionWC).height); c.frustum.width = z.widthM;   // 폭은 옮긴 뒤에(옮기면 폭이 카메라 높이로 되돌아간다) } return 1; })()`);
    url = w.section.ortho
      ? await ev(`(async () => { const v = window.__previewViewer; for (let k = 0; k < 30; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); } v.render(); return v.scene.canvas.toDataURL('image/jpeg', 0.9); })()`)
      : await ev(`window.__shot(${view}, 30)`);
    await ev(`(window.__section.stop(), 1)`);
  } else url = await ev(`window.__shot(${view}, ${first ? 40 : 24})`);
  first = false;
  const f = path.join(outDir, `${prefix}-${name}.jpg`); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('saved', f);
}
ws.close();
