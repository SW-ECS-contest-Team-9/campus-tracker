// WS1: 1인칭 겹친 계단(청운관 계단실) 걷기 전후를 시험 지도(프리뷰)로 찍는다. 읽기만 한다. 화면 1280×720.
//   TAG=전|후 node shots.mjs <저장 폴더>   -> <TAG>-1인칭-<이름>-a~d.jpg, <TAG>-1인칭-기록.json
// 걷기는 uv1/shots.mjs 와 같다(길 이름 차례로 잇고, 다음 꼭짓점 0.25 m 안이면 다음으로, 한 번에 dt ≤ 0.1 s). 기록에는 걸음마다
// 발 높이와 그 자리에서 걷는 길(차례의 길 가운데 평면으로 가장 가까운 것)의 높이를 둔다. 계단·경사 길 기울기 최대도 둔다.
// --remote-debugging-port=9357(CDP_PORT) 으로 띄운 headless Chrome 이 있어야 한다.
import fs from 'node:fs';
import path from 'node:path';
const [outDir] = process.argv.slice(2);
const TAG = process.env.TAG ?? '후';
const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT ?? '9357') + '/json')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1200)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: process.env.PREVIEW ?? 'http://localhost:5173/' });
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(window.__previewViewer && window.Cesium && window.__spaceViews)`)) break; }
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev(`window.__spaceViews.level.zones.length > 0 && window.__spaceViews.level.solids.length > 0`)) break; }
await sleep(8000);
const save = (name, b64) => { const f = path.join(outDir, name + '.jpg'); fs.writeFileSync(f, Buffer.from(b64, 'base64')); console.log('saved', f); };
const capture = async (name) => save(name, (await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 })).result.data);
const SV = 'window.__spaceViews';
const WALKS = [
  ['청운관계단실', ['^청운관 계단실: 붉은 벽 칸', '^청운관 계단실: 지하 1층 앞방']],
  ['서문터널', ['^지하 차도 [(]서문 터널']],
  ['보행구간', ['^지하 차도 보행 구간 [(]본관 북쪽']],
];
const trace = {};
trace.steepest = await ev(`(() => { const out = []; for (const r of ${SV}.level['src'].roads()) { if (r.structure !== 'stairs' && r.structure !== 'ramp') continue; const c = r.geometry.coordinates;
  for (let i = 0; i + 1 < c.length; i++) { const h = Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]); if (h > 0.05) out.push({ id: r.id.slice(0, 8), structure: r.structure, slope: Math.round(Math.abs(c[i + 1][2] - c[i][2]) / h * 100) / 100, runM: Math.round(h * 100) / 100 }); } }
  out.sort((a, b) => b.slope - a.slope); return { segments: out.length, top: out.slice(0, 12) }; })()`);
for (const [name, chain] of WALKS) {
  const res = await ev(`(async () => { const sv = ${SV}; const W = sv.walk; const roads = sv.level['src'].roads(); const chain = ${JSON.stringify(chain)};
    const lines = [];
    for (const pattern of chain) { const re = new RegExp(pattern); const hits = roads.filter((r) => re.test(r.name || '')); if (!hits.length) return { missing: pattern };
      let c = hits.reduce((a, b) => (b.geometry.coordinates.length > a.geometry.coordinates.length ? b : a)).geometry.coordinates.map((p) => [...p]);
      if (lines.length) { const last = lines[lines.length - 1].slice(-1)[0]; const d = (p) => Math.hypot(p[0] - last[0], p[1] - last[1]); if (d(c[c.length - 1]) < d(c[0])) c.reverse(); }
      lines.push(c); }
    if (lines.length > 1) { const next = lines[1][0]; const d = (p) => Math.hypot(p[0] - next[0], p[1] - next[1]); if (d(lines[0][0]) < d(lines[0][lines[0].length - 1])) lines[0].reverse(); }
    const pts = lines.flat();
    W.start(pts[0][0], pts[0][1], pts[0][2] + 0.3, Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]));
    window.__walk = { pts, lines, li: 0, i: 1, feet: [W.state.feetM], off: [], where: [W.where()] };
    return { start: W.where(), lines: lines.length, points: pts.length, from: pts[0], to: pts[pts.length - 1] }; })()`);
  console.log(name, JSON.stringify(res));
  if (res.missing) { trace[name] = res; await ev(`(${SV}.walk.stop(), 1)`); continue; }
  await sleep(6000); await capture(`${TAG}-1인칭-${name}-a`);
  for (const part of ['b', 'c', 'd']) {
    const r = await ev(`(async () => { const L = await import('/src/level-view.ts'); const W = ${SV}.walk, w = window.__walk, held = new Set(['KeyW']); const stopAt = Math.ceil(w.pts.length * ${part === 'b' ? 0.34 : part === 'c' ? 0.67 : 1});
      let guard = 0;
      while (w.i < stopAt && guard++ < 20000) { const t = w.pts[w.i]; const dx = t[0] - W.state.x, dy = t[1] - W.state.y;
        if (Math.hypot(dx, dy) < 0.25) { w.i++; continue; }
        W.state.heading = Math.atan2(dx, dy); W.advance(Math.min(0.1, Math.hypot(dx, dy) / 1.4), held);
        const own = w.lines.map((c) => L.roadHeightAt(c, W.state.x, W.state.y)).reduce((a, b) => (!a || (b && b.distanceM < a.distanceM) ? b : a), null);
        w.feet.push(Math.round(W.state.feetM * 100) / 100); w.off.push(Math.round((W.state.feetM - own.z) * 100) / 100); }
      w.where.push(W.where()); return { feet: W.state.feetM, target: w.pts[Math.min(w.i, w.pts.length) - 1][2], where: W.where(), steps: w.feet.length }; })()`);
    console.log('  ', part, JSON.stringify(r));
    await sleep(3500); await capture(`${TAG}-1인칭-${name}-${part}`);
  }
  trace[name] = await ev(`(() => { const w = window.__walk; const f = w.feet, o = w.off; return { where: w.where, feetStart: f[0], feetEnd: f[f.length - 1], feetMin: Math.min(...f), feetMax: Math.max(...f), biggestStep: f.reduce((m, v, i) => (i ? Math.max(m, Math.abs(v - f[i - 1])) : 0), 0), roadEnd: w.pts[w.pts.length - 1][2], offRoadMax: Math.max(...o.map(Math.abs)), offRoadOver03: o.filter((v) => Math.abs(v) > 0.3).length, steps: f.length }; })()`);
  await ev(`(${SV}.walk.stop(), 1)`); await sleep(800);
}
const f = path.join(outDir, `${TAG}-1인칭-기록.json`); fs.writeFileSync(f, JSON.stringify(trace, null, 1)); console.log('saved', f);
ws.close();
