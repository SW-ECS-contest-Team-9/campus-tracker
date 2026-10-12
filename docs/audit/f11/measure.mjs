// F11 끌어서 옮길 때 프레임 시간 재기(편집기·지도). 읽기만 한다.
//   node measure.mjs editor|map <이름> [--base=http://127.0.0.1:5273] [--chrome=9341] [--setup=파일.js] [--out=폴더] [--profile] [--shot]
//   --setup: 재기 전에 화면에서 돌릴 식(층 끄기 등 원인 나누기용). VIEWER, LAYERS 를 쓸 수 있다.
//   결과: <out>/<이름>.json (프레임 간격 중앙·p95, 장면 갱신+그리기 시간, 개수, CPU 프로파일 상위 함수)
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const flag = (k) => args.includes(`--${k}`);
const [mode, name] = args.filter((a) => !a.startsWith('--'));
const editor = mode === 'editor', BASE = opt('base', 'http://127.0.0.1:5273'), CHROME = opt('chrome', '9341');
const OUT = opt('out', '.'), SETUP = opt('setup', '');
fs.mkdirSync(OUT, { recursive: true });
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
const VIEWER = editor ? 'window.__editor.viewer' : 'window.__previewViewer';
const LAYERS = editor ? 'window.__editor.layers' : 'window.__sceneLayers';
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(${editor ? 'window.__editor && window.__editor.spaceViews' : 'window.__previewViewer'})`)) break; }
await sleep(20000); // 층·구조물·지형 타일이 다 올라올 때까지
if (SETUP) { console.log('setup ->', await ev(`(async () => { const VIEWER = ${VIEWER}, LAYERS = ${LAYERS}; ${fs.readFileSync(SETUP, 'utf8')} })()`)); await sleep(6000); }

const counts = await ev(`(() => { const v = ${VIEWER}, s = v.scene; const ds = []; for (let i = 0; i < v.dataSources.length; i++) ds.push(v.dataSources.get(i).entities.values.length);
  const kinds = {}; const all = [...v.entities.values]; for (let i = 0; i < v.dataSources.length; i++) all.push(...v.dataSources.get(i).entities.values);
  let callbacks = 0;
  for (const e of all) for (const k of ['box','polygon','polyline','polylineVolume','point','label','billboard','wall','corridor','cylinder','ellipse','rectangle','model']) if (e[k]) {
    kinds[k] = (kinds[k] || 0) + 1;
    const g = e[k]; for (const p of g.propertyNames || []) { const q = g[p]; if (q && q.isConstant === false) callbacks++; }
  }
  return { webgl: (() => { const gl = s.context._gl, x = gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; })(),
    entities: v.entities.values.length, dataSourceEntities: ds, kinds, nonConstantProps: callbacks, primitives: s.primitives.length, groundPrimitives: s.groundPrimitives.length,
    requestRenderMode: s.requestRenderMode, resolutionScale: v.resolutionScale, shadows: v.shadows, msaa: s.msaaSamples, fxaa: s.postProcessStages.fxaa.enabled,
    depthTest: s.globe.depthTestAgainstTerrain, canvas: [s.canvas.width, s.canvas.height] }; })()`);

await ev(`(() => { const v = ${VIEWER}, s = v.scene, M = (window.__f11 = { raf: [], render: [], cmds: [], on: false, t0: 0, travel: 0, events: {} });
  let lastPos = null; for (const t of ['pointerdown','pointermove','pointerup']) window.addEventListener(t, (e) => { if (M.on || t !== 'pointermove') M.events[t + ':' + e.buttons + ':' + (e.target.tagName || '')] = (M.events[t + ':' + e.buttons + ':' + (e.target.tagName || '')] || 0) + 1; }, true);
  let last = 0; const tick = (t) => { if (M.on && last) M.raf.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  s.preUpdate.addEventListener(() => { M.t0 = performance.now(); });
  s.postRender.addEventListener(() => { if (M.on) { M.render.push(performance.now() - M.t0); M.cmds.push(s.frameState.commandList.length); const p = v.camera.positionWC; if (lastPos) M.travel += Math.hypot(p.x - lastPos.x, p.y - lastPos.y, p.z - lastPos.z); lastPos = { x: p.x, y: p.y, z: p.z }; } });
  return 1; })()`);

if (flag('attrib')) await ev(`(() => { const v = ${VIEWER}, s = v.scene, C = window.Cesium, A = (window.__f11a = { rows: [], frames: 0 });
  const wrap = (obj, fn, label) => { const row = { label, ms: 0, cmds: 0 }; A.rows.push(row); const orig = obj[fn];
    obj[fn] = function (...a) { const fs = s.frameState, c0 = fs.commandList.length, t = performance.now(); const r = orig.apply(this, a); if (window.__f11.on) { row.ms += performance.now() - t; row.cmds += fs.commandList.length - c0; } return r; }; };
  const describe = (p) => { const n = p.constructor.name; if (p.get && typeof p.length === 'number') return n + '[' + p.length + ']';
    if (p._numberOfInstances !== undefined || p.geometryInstances) return n + '(inst ' + (p._numberOfInstances || (p.geometryInstances || []).length || '?') + ')'; return n; };
  const walk = (col, path) => { for (let i = 0; i < col.length; i++) { const p = col.get(i); const label = path + '/' + i + ':' + describe(p) + (p.show === false ? ' (꺼짐)' : '');
    if (p instanceof C.PrimitiveCollection) walk(p, label); else wrap(p, 'update', label); } };
  walk(s.primitives, 'prim'); walk(s.groundPrimitives, 'ground');
  wrap(s.globe, 'render', 'globe.render'); wrap(s.globe, 'endFrame', 'globe.endFrame'); wrap(v.dataSourceDisplay, 'update', 'dataSourceDisplay.update(엔티티 갱신)');
  s.postRender.addEventListener(() => { if (window.__f11.on) A.frames++; });
  return A.rows.length; })()`);
await sleep(1500);
if (flag('shot')) { const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 }); fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(r.result.data, 'base64')); }

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 690, y: 510 }); await sleep(2500); // 첫 집기(pick)의 셰이더 만들기는 따로
// 가만히 둔 2 초
await ev(`(window.__f11.on = true, 1)`); await sleep(2000);
if (flag('attrib')) await ev(`(window.__f11.on = false, window.__f11a.rows.forEach((r) => { r.ms = 0; r.cmds = 0; }), window.__f11a.frames = 0, 1)`);
const idle = await ev(`(() => { const M = window.__f11; M.on = false; const o = { raf: M.raf, render: M.render, cmds: M.cmds }; M.raf = []; M.render = []; M.cmds = []; return o; })()`);

// 왼쪽 단추로 좌우 끌기 3 초(좌우 300 px, 놓는 자리는 누른 자리에서 300 px: 누른 자리에서 놓으면 클릭이 되어 다시 그린다)
if (flag('profile')) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 }); await send('Profiler.start'); }
const X0 = 700, Y0 = 520, STEPS = 180;
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0, y: Y0 });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X0, y: Y0, button: 'left', buttons: 1, clickCount: 1 });
await ev(`(window.__f11.on = true, 1)`);
const start = Date.now();
for (let i = 1; i <= STEPS; i++) {
  const x = X0 + Math.round(300 * Math.sin((i / STEPS) * Math.PI * 2.5));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: Y0, button: 'left', buttons: 1 });
  const wait = start + (i * 3000) / STEPS - Date.now(); if (wait > 0) await sleep(wait);
}
const dragMs = Date.now() - start;
const drag = await ev(`(() => { const M = window.__f11; M.on = false; return { raf: M.raf, render: M.render, cmds: M.cmds, travel: M.travel, events: M.events }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X0 + 300, y: Y0, button: 'left', buttons: 0, clickCount: 1 });
const attrib = flag('attrib') ? await ev(`(() => { const A = window.__f11a; return A.rows.map((r) => ({ label: r.label, msPerFrame: +(r.ms / A.frames).toFixed(4), cmdsPerFrame: Math.round(r.cmds / A.frames) })).sort((a, b) => b.msPerFrame - a.msPerFrame); })()`) : [];
// 단추 없이 마우스만 움직이기 2 초(편집기는 움직일 때마다 가리킨 것을 집는다)
await sleep(500); await ev(`(() => { const M = window.__f11; M.raf = []; M.render = []; M.cmds = []; M.on = true; return 1; })()`);
const h0 = Date.now();
for (let i = 1; i <= 120; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0 + Math.round(300 * Math.sin((i / 120) * Math.PI * 2)), y: Y0 + 40 }); const wait = h0 + (i * 2000) / 120 - Date.now(); if (wait > 0) await sleep(wait); }
const hover = await ev(`(() => { const M = window.__f11; M.on = false; return { raf: M.raf, render: M.render }; })()`);
let top = [];
if (flag('profile')) {
  const { result } = await send('Profiler.stop'); const p = result.profile;
  const self = new Map(); const byId = new Map(p.nodes.map((n) => [n.id, n]));
  p.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + (p.timeDeltas[i] || 0)); });
  const agg = new Map(); let total = 0;
  for (const [id, us] of self) { const n = byId.get(id), c = n.callFrame; const key = `${c.functionName || '(anon)'} ${c.url.split('/').pop().split('?')[0]}:${c.lineNumber + 1}`; agg.set(key, (agg.get(key) || 0) + us); total += us; }
  top = [...agg].sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, us]) => `${(us / 1000).toFixed(0).padStart(6)} ms ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  // 우리 코드(src/) 에서 시작한 시간: 조상 가운데 /src/ 가 있는 표본
  const parent = new Map(); for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const own = new Map();
  for (const [id, us] of self) { let cur = id, hit = null; while (cur !== undefined) { const c = byId.get(cur).callFrame; if (c.url.includes('/src/')) hit = `${c.functionName || '(anon)'} ${c.url.split('/').pop().split('?')[0]}:${c.lineNumber + 1}`; cur = parent.get(cur); }
    if (hit) own.set(hit, (own.get(hit) || 0) + us); }
  top.push('--- src/ 에서 불린 것(가장 바깥 우리 함수 기준, 포함 시간) ---', ...[...own].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, us]) => `${(us / 1000).toFixed(0).padStart(6)} ms  ${k}`));
}
const stat = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const q = (f) => +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(1);
  return { n: a.length, median: q(0.5), p95: q(0.95), max: +s[s.length - 1].toFixed(1), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) }; };
const out = { name, mode, base: BASE, setup: SETUP ? path.basename(SETUP) : null, counts,
  idle: { frame: stat(idle.raf), render: stat(idle.render), commands: stat(idle.cmds) },
  drag: { ms: dragMs, cameraTravelM: +drag.travel.toFixed(1), events: drag.events, frame: stat(drag.raf), render: stat(drag.render), commands: stat(drag.cmds) }, hover: { frame: stat(hover.raf), render: stat(hover.render) }, attrib, top };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(out, null, 1));
console.log(name, '| 가만히 frame', JSON.stringify(out.idle.frame), 'render', JSON.stringify(out.idle.render), 'cmds', out.idle.commands?.median);
console.log(name, '| 끌기   frame', JSON.stringify(out.drag.frame), 'render', JSON.stringify(out.drag.render), 'cmds', out.drag.commands?.median, '카메라 이동', out.drag.cameraTravelM, 'm', JSON.stringify(out.drag.events));
if (top.length) console.log(top.join('\n'));
ws.close();
