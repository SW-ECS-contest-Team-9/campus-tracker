// F11 고치기 전후에 보이는 것이 같은지 찍는다(편집기·지도). 읽기만 한다.
//   node shots.mjs editor|map <저장 폴더> 전|후 [--base=http://127.0.0.1:5273] [--chrome=9341]
//   -> <편집기|지도>-f11-<번호-이름>-<전|후>.png : 기본 화면, 오르막길 가까이, 주차장(지하 1층) 띄움, 단면(운동장 지하)
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const [mode, outDir, tag] = args.filter((a) => !a.startsWith('--'));
const editor = mode === 'editor', BASE = opt('base', 'http://127.0.0.1:5273'), CHROME = opt('chrome', '9341');
fs.mkdirSync(outDir, { recursive: true });
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
const VIEWER = editor ? 'window.__editor.viewer' : 'window.__previewViewer', SECTION = editor ? 'window.__editor.layers.section' : 'window.__section';
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(${editor ? 'window.__editor && window.__editor.spaceViews' : 'window.__spaceViews && window.__previewViewer'})`)) break; }
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev(`${SV}.level.zones.length > 0 && ${SV}.level.solids.length > 0`)) break; }
await sleep(12000);
await ev(`(async () => { const tm = await import('/src/tm.ts'); const C = window.Cesium, v = ${VIEWER};
  v.scene.screenSpaceCameraController.enableCollisionDetection = false;
  window.__P = (x, y, z) => { const g = tm.tmInverse(x, y); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, z); };
  window.__look = (w) => { const P = window.__P; const pos = P(...w.pos), tgt = P(...w.tgt), dir = C.Cartesian3.normalize(C.Cartesian3.subtract(tgt, pos, new C.Cartesian3()), new C.Cartesian3());
    let up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new C.Cartesian3());
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, up, new C.Cartesian3()), new C.Cartesian3()); up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
    v.camera.frustum.fov = C.Math.toRadians(w.fov); v.camera.setView({ destination: pos, orientation: { direction: dir, up } }); return 1; }; return 1; })()`);
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(outDir, `${editor ? '편집기' : '지도'}-f11-${name}-${tag}.png`);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); console.log('saved', f);
};
const check = (id, on) => ev(`(() => { const b = document.getElementById('${id}'); if (b.checked !== ${on}) b.click(); return b.checked; })()`);
const click = (id) => ev(`(document.getElementById('${id}').click(), 1)`);
const HOME = { pos: [200950, 557150, 330], tgt: [201095, 557300, 130], fov: 50 };

await shot('01-기본');
await ev(`window.__look(${JSON.stringify({ pos: [201050, 557270, 185], tgt: [201098, 557331, 135], fov: 50 })})`); await sleep(5000);
await shot('02-오르막길-가까이');
await ev(`window.__look(${JSON.stringify({ pos: [201120, 557300, 152], tgt: [201085, 557340, 134], fov: 50 })})`); await sleep(5000);
await shot('03-오르막길-더가까이');

// 단면(운동장 지하)
await check(editor ? 'layer-underground' : 'scene-roads-underground', true);
await ev(`window.__look(${JSON.stringify(HOME)})`);
await check(editor ? 'layer-section' : 'scene-section', true);
await ev(`(() => { ${SECTION}.setLine([201142.5, 557269.91], [201226.36, 557219.19]); ${SECTION}.lookAt({ lowM: 130, highM: 152, backdropM: 10 }); return 1; })()`);
await sleep(7000);
await shot('04-단면-운동장지하');
await check(editor ? 'layer-section' : 'scene-section', false);
await check(editor ? 'layer-underground' : 'scene-roads-underground', false);
await sleep(2000);

// 주차장(지하 1층) 띄움
await click(editor ? 'view-level' : 'scene-level-view'); await sleep(500);
await ev(`(() => { ${SV}.level.showZone('b1'); return 1; })()`); await sleep(2500);
await ev(`(() => { const C = window.Cesium, cam = ${VIEWER}.camera, s = ${SV}.level.frameSphere; if (!s) return 0; cam.cancelFlight(); cam.frustum.fov = C.Math.toRadians(50);
  cam.lookAt(s.center, new C.HeadingPitchRange(C.Math.toRadians(-22), C.Math.toRadians(-47), s.radius * 2.9)); cam.lookAtTransform(C.Matrix4.IDENTITY); cam.moveLeft(s.radius * ${editor ? 0.5 : 0.25}); return 1; })()`);
await sleep(5000);
await shot('05-주차장-지하1층-띄움');
await click(editor ? 'view-level' : 'scene-level-view'); await sleep(1000);
ws.close();
