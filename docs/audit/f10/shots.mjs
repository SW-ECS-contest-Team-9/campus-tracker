// F10 층 따로 보기: 지하 1·2층 겹침 고침 전후와, 띄운 것 위의 세션·퓨전 궤적을 찍는다(프리뷰·편집기). 읽기만 한다.
//   node shots.mjs preview|editor <저장 폴더> 전|후 [이름 일부 ...] [--base=http://localhost:5273] [--chrome=9346] [--fixture=frontend/test/fixtures/f10-tracks.json]
//   -> 지도-f10-<번호-이름>-<전|후>.jpg / 편집기-f10-...   화면 전체(패널·범례 포함).
// 시험용 DB 에는 세션이 없다. 궤적 갈무리는 --fixture 의 지어낸 궤적을 화면의 시험용 자리(level.extraTracks)에 넣어 찍는다.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const [mode, outDir, tag, ...only] = args.filter((a) => !a.startsWith('--'));
const editor = mode === 'editor', BASE = opt('base', 'http://localhost:5273'), CHROME = opt('chrome', '9346'), FIXTURE = opt('fixture', '');
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
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev(`${SV}.level.zones.length > 0 && ${SV}.level.solids.length > 0`)) break; }
await sleep(9000);
await ev(`(() => { ${VIEWER}.scene.screenSpaceCameraController.enableCollisionDetection = false; return 1; })()`);
/** 띄운 것을 한 방향에서 본다: 방위(도, 북 0·동 90), 내려다보는 각, 거리(띄운 것 반지름의 배수). */
const look = (v) => ev(`(() => { const C = window.Cesium, cam = ${VIEWER}.camera, s = ${SV}.level.frameSphere; if (!s) return 0;
  cam.cancelFlight(); cam.frustum.fov = C.Math.toRadians(${v.fov ?? 50});
  cam.lookAt(s.center, new C.HeadingPitchRange(C.Math.toRadians(${v.heading}), C.Math.toRadians(${v.pitch}), s.radius * ${v.range}));
  cam.lookAtTransform(C.Matrix4.IDENTITY); return 1; })()`);
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  const f = path.join(outDir, `${editor ? '편집기' : '지도'}-f10-${name}-${tag}.jpg`);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); console.log('saved', f);
};
const want = (name) => !only.length || only.some((o) => name.includes(o));
const after = tag === '후';
const click = (id) => ev(`(document.getElementById('${id}').click(), 1)`);
const LEVEL = editor ? 'view-level' : 'scene-level-view';
/** 사용자 화면(00, 00b)과 비슷한 시점: 남남동 위에서 북북서로. */
const USER = { heading: -22, pitch: -47, range: 2.9 };
const TOP = { heading: 0, pitch: -89, range: 2.3 };
const SIDE = { heading: 60, pitch: -12, range: 2.2 };

if (!(await ev(`${SV}.level.active`))) await click(LEVEL);
await sleep(500);
const lift = async (id, floor) => {
  const info = await ev(`(() => { const L = ${SV}.level; if (${floor === undefined}) { L.showZone(${JSON.stringify(id)}); return L.unit ? L.unit.zone.name : null; }
    L.showBuilding(${JSON.stringify(id)}, ${JSON.stringify(floor)}); return L.unit ? L.unit.name + ' 층 ' + L.unit.floors.map((f) => (f.name || '-') + '@' + f.m).join(' ') : null; })()`);
  await sleep(2500);
  return info;
};
const panel = () => ev(`(() => { const p = document.querySelector('.level-panel'); return p ? p.innerText.replace(/\\s+/g, ' ').slice(0, 1200) : ''; })()`);

// ---- 겹침: 지하 1층·2층, 지하 차도, 지하 보행 구간 ----
const ZONES = [
  ['01-띄움-지하1층-사용자시점', 'b1', USER], ['02-띄움-지하2층-사용자시점', 'b2', USER],
  ['03-띄움-지하1층-위에서', 'b1', TOP], ['04-띄움-지하2층-위에서', 'b2', TOP],
  ['05-띄움-지하1층-옆에서', 'b1', SIDE], ['06-띄움-지하2층-옆에서', 'b2', SIDE],
  ['07-띄움-지하차도', 'tunnel', { heading: 20, pitch: -40, range: 2.4 }], ['08-띄움-지하보행구간', 'walk', { heading: 20, pitch: -40, range: 2.6 }],
];
for (const [name, id, view] of ZONES) {
  if (!want(name)) continue;
  console.log(name, '->', await lift(id));
  await look(view); await sleep(4500);
  await shot(name);
}

// ---- 세션·퓨전 궤적(지어낸 궤적) ----
if (after && FIXTURE) {
  const tracks = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).tracks;
  await ev(`(() => { const L = ${SV}.level; L.extraTracks = ${JSON.stringify(tracks)}; L.tracksChanged(); return 1; })()`);
  const TRACKS = [
    ['11-궤적-지하1층', 'b1', undefined, USER], ['12-궤적-지하2층', 'b2', undefined, USER], ['13-궤적-운동장', 'field', undefined, USER],
    ['14-궤적-은주관-벌려보기', '은주관', null, null], ['15-궤적-지하차도', 'tunnel', undefined, { heading: 20, pitch: -40, range: 2.4 }],
  ];
  for (const [name, id, floor, view] of TRACKS) {
    if (!want(name)) continue;
    console.log(name, '->', await lift(id, floor));
    if (view) await look(view);
    await sleep(4500);
    console.log('   패널:', await panel());
    await shot(name);
  }
  if (want('16-궤적')) {
    const line = (v) => ev(`(() => { const el = document.querySelector('.level-panel select[data-style="line"]'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
    await lift('b1'); await look(USER);
    await line('thick'); await sleep(4000); await shot('16-궤적-지하1층-굵게');
    await line('normal');
  }
  await ev(`(() => { const L = ${SV}.level; L.extraTracks = []; L.tracksChanged(); return 1; })()`);
}
if (after && want('17-세션없음')) { await lift('walk'); await look({ heading: 20, pitch: -40, range: 2.6 }); await sleep(3000); console.log('   패널:', await panel()); await shot('17-세션없음-지하보행구간'); }
await click(LEVEL); await sleep(1200);
ws.close();
