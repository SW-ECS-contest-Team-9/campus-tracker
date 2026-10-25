// UV1: 지하 빈 곳 보완을 시험 지도(프리뷰)로 찍는다. 읽기만 한다. 화면 1280×720.
//   node shots.mjs map <저장 폴더> [시점 이름 일부 ...]    -> 지도-<시점>.jpg (시점 views.json, tp2/shots.mjs 와 같은 방식: underground = '지하 길' 켬, section = 단면도)
//   node shots.mjs level <저장 폴더> [이름 일부 ...]       -> 층따로-*.jpg, 1인칭-*.jpg, 1인칭-기록.json (f08/shots.mjs 와 같은 방식)
// --remote-debugging-port=9357(CDP_PORT) 으로 띄운 headless Chrome 이 있어야 한다.
import fs from 'node:fs';
import path from 'node:path';
const [mode, outDir, ...only] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(new URL('./views.json', import.meta.url), 'utf8'));
const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT ?? '9357') + '/json')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1200)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (name) => !only.length || only.some((o) => name.includes(o));
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:5273/' });
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(window.__previewViewer && window.Cesium && window.__spaceViews)`)) break; }
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev(`window.__spaceViews.level.zones.length > 0 && window.__spaceViews.level.solids.length > 0`)) break; }
await sleep(8000);
const save = (name, b64) => { const f = path.join(outDir, name + '.jpg'); fs.writeFileSync(f, Buffer.from(b64, 'base64')); console.log('saved', f); };
const capture = async (name) => save(name, (await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 })).result.data);

if (mode === 'map') {
  await ev(`(async () => { const tm = await import('/src/tm.ts'); const C = window.Cesium, v = window.__previewViewer;
    v.scene.screenSpaceCameraController.enableCollisionDetection = false;
    window.__P = (x, y, z) => { const g = tm.tmInverse(x, y); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, z); };
    window.__shot = async (w, n) => { const P = window.__P; const pos = P(...w.pos), tgt = P(...w.tgt), dir = C.Cartesian3.normalize(C.Cartesian3.subtract(tgt, pos, new C.Cartesian3()), new C.Cartesian3());
      let up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new C.Cartesian3());
      const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, up, new C.Cartesian3()), new C.Cartesian3()); up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
      v.camera.frustum.fov = C.Math.toRadians(w.fov); v.camera.setView({ destination: pos, orientation: { direction: dir, up } });
      for (let k = 0; k < n; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); }
      v.render(); return v.scene.canvas.toDataURL('image/jpeg', 0.9); }; return 1; })()`);
  const check = (on) => ev(`(() => { const b = document.getElementById('scene-roads-underground'); if (b.checked !== ${on}) b.click(); return b.checked; })()`);
  let first = true;
  for (const [name, w] of Object.entries(V)) {
    if (!want(name)) continue;
    const view = JSON.stringify({ pos: w.pos, tgt: w.tgt, fov: w.fov });
    await check(!!w.underground);
    let url;
    if (w.section) {
      await ev(`window.__shot(${view}, ${first ? 30 : 2})`);
      await ev(`(() => { window.__section.setLine(${JSON.stringify(w.section.a)}, ${JSON.stringify(w.section.b)}); window.__section.lookAt(${JSON.stringify(w.section.frame ?? {})}); return 1; })()`);
      url = await ev(`(async () => { const v = window.__previewViewer; for (let k = 0; k < 30; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); } v.render(); return v.scene.canvas.toDataURL('image/jpeg', 0.9); })()`);
      await ev(`(window.__section.stop(), 1)`);
    } else url = await ev(`window.__shot(${view}, ${first ? 40 : 24})`);
    first = false;
    await check(false);
    save(`${process.env.TAG ?? "후"}-지도-${name}`, url.split(',')[1]);
  }
} else {
  const SV = 'window.__spaceViews';
  const ZONES = [['층따로-지하차도', 'tunnel'], ['층따로-보행구간·횡단보도', 'walk'], ['층따로-1주차장B1', 'b1'], ['층따로-1주차장B2', 'b2']];
  if (ZONES.some(([n]) => want(n))) {
    if (!(await ev(`${SV}.level.active`))) await ev(`(document.getElementById('scene-level-view').click(), 1)`);
    await sleep(800);
    for (const [name, id] of ZONES) {
      if (!want(name)) continue;
      console.log(name, '->', await ev(`(() => { const L = ${SV}.level; L.showZone(${JSON.stringify(id)}); return L.unit ? L.unit.zone.name : null; })()`));
      await sleep(5000); await capture(name);
    }
    await ev(`(document.getElementById('scene-level-view').click(), 1)`); await sleep(1500);
  }
  // [이름, 길 이름 정규식들(차례로 이어 걸음)]
  const WALKS = [
    ['1인칭-서문터널', ['^지하 차도 \\(서문 터널']],
    ['1인칭-보행구간', ['^지하 차도 보행 구간 \\(본관 북쪽']],
    ['1인칭-청운관계단실', ['^청운관 계단실: 붉은 벽 칸', '^청운관 계단실: 지하 1층 앞방']],
  ];
  const trace = {};
  for (const [name, chain] of WALKS) {
    if (!want(name)) continue;
    const res = await ev(`(async () => { const sv = ${SV}; const W = sv.walk; const roads = sv.level['src'].roads(); const chain = ${JSON.stringify(chain)};
      const lines = [];
      for (const pattern of chain) { const re = new RegExp(pattern); const hits = roads.filter((r) => re.test(r.name || '')); if (!hits.length) return { missing: pattern };
        let c = hits.reduce((a, b) => (b.geometry.coordinates.length > a.geometry.coordinates.length ? b : a)).geometry.coordinates.map((p) => [...p]);
        if (lines.length) { const last = lines[lines.length - 1].slice(-1)[0]; const d = (p) => Math.hypot(p[0] - last[0], p[1] - last[1]); if (d(c[c.length - 1]) < d(c[0])) c.reverse(); }
        lines.push(c); }
      if (lines.length > 1) { const next = lines[1][0]; const d = (p) => Math.hypot(p[0] - next[0], p[1] - next[1]); if (d(lines[0][0]) < d(lines[0][lines[0].length - 1])) lines[0].reverse(); }
      const pts = lines.flat();
      W.start(pts[0][0], pts[0][1], pts[0][2] + 0.3, Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]));
      window.__walk = { pts, i: 1, feet: [W.state.feetM], where: [W.where()] };
      return { start: W.where(), lines: lines.length, points: pts.length, from: pts[0], to: pts[pts.length - 1] }; })()`);
    console.log(name, JSON.stringify(res));
    if (res.missing) { trace[name] = res; await ev(`(${SV}.walk.stop(), 1)`); continue; }
    await sleep(6000); await capture(`${name}-a`);
    for (const part of ['b', 'c', 'd']) {
      const r = await ev(`(() => { const W = ${SV}.walk, w = window.__walk, held = new Set(['KeyW']); const stopAt = Math.ceil(w.pts.length * ${part === 'b' ? 0.34 : part === 'c' ? 0.67 : 1});
        let guard = 0;
        while (w.i < stopAt && guard++ < 20000) { const t = w.pts[w.i]; const dx = t[0] - W.state.x, dy = t[1] - W.state.y;
          if (Math.hypot(dx, dy) < 0.25) { w.i++; continue; }
          W.state.heading = Math.atan2(dx, dy); W.advance(Math.min(0.1, Math.hypot(dx, dy) / 1.4), held); w.feet.push(Math.round(W.state.feetM * 100) / 100); }
        w.where.push(W.where()); return { feet: W.state.feetM, target: w.pts[Math.min(w.i, w.pts.length) - 1][2], where: W.where(), steps: w.feet.length }; })()`);
      console.log('  ', part, JSON.stringify(r));
      await sleep(3500); await capture(`${name}-${part}`);
    }
    trace[name] = await ev(`(() => { const w = window.__walk; const f = w.feet; return { where: w.where, feetStart: f[0], feetEnd: f[f.length - 1], feetMin: Math.min(...f), feetMax: Math.max(...f), biggestStep: f.reduce((m, v, i) => (i ? Math.max(m, Math.abs(v - f[i - 1])) : 0), 0), roadEnd: w.pts[w.pts.length - 1][2] }; })()`);
    await ev(`(${SV}.walk.stop(), 1)`); await sleep(800);
  }
  if (Object.keys(trace).length) { const f = path.join(outDir, '1인칭-기록.json'); fs.writeFileSync(f, JSON.stringify(trace, null, 1)); console.log('saved', f); }
}
ws.close();
