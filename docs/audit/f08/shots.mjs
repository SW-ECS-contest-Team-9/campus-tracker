// F08: 층 따로 보기와 1인칭을 시험 지도(프리뷰)·시험용 편집기에서 찍는다. 읽기만 한다(편집기는 시험 계정 T05 로 로그인만).
//   node shots.mjs preview|editor <저장 폴더> [이름 일부 ...] [--base=http://localhost:5273] [--chrome=9333]
// 화면 전체(패널·HUD 포함)를 찍는다. 1인칭 걷기는 길 이름으로 고른 길을 따라 W 키를 누른 것과 같은 걸음으로 간다
// (first-person.ts advance): 발 높이 기록을 f08-걷기-기록.json 에 남긴다.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const [mode, outDir, ...only] = args.filter((a) => !a.startsWith('--'));
const editor = mode === 'editor', BASE = opt('base', 'http://localhost:5273'), CHROME = opt('chrome', '9333');
const list = await (await fetch(`http://127.0.0.1:${CHROME}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1200)); return r.result.result.value; };
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
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(${editor ? 'window.__editor && window.__editor.spaceViews' : 'window.__spaceViews'})`)) break; }
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev(`${SV}.level.zones.length > 0 && ${SV}.level.solids.length > 0`)) break; }
await sleep(8000);
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  const f = path.join(outDir, `${editor ? '편집기' : '지도'}-f08-${name}.jpg`);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); console.log('saved', f);
};
const want = (name) => !only.length || only.some((o) => name.includes(o));
const click = (id) => ev(`(document.getElementById('${id}').click(), 1)`);
const LEVEL = editor ? 'view-level' : 'scene-level-view', WALKB = editor ? 'view-walk' : 'scene-first-person';

// ---- 층 따로 보기 ----
// [이름, 구획 id] 또는 [이름, 건물 id, 층 바닥 높이(null = 전체 벌려 보기)]
const LIFTS = [
  ['01-운동장지하1층', 'b1'], ['02-운동장지하2층', 'b2'],
  ['03-은주1관-3층', '은주관', 137.8], ['04-본관-2층', '본관', 128.5], ['05-본관-5층', '본관', 137.8],
  ['06-유담관-7층', '유담관', 121.6], ['07-유담관-9층', '유담관', 129.4], ['08-북악관-지하1층', '북악관', 130.5],
  ['09-구획-내리막길', 'way'], ['10-구획-분수광장', 'fountain'], ['11-대일관-벌려보기', '대일관', null], ['12-은주1관-벌려보기', '은주관', null],
  ['13-지하차도', 'tunnel'], ['14-본관유담관지하통로', 'glass'],
];
if (LIFTS.some(([n]) => want(n))) {
  if (!(await ev(`${SV}.level.active`))) await click(LEVEL);
  await sleep(500);
  await shot('00-켠직후'); // 패널만: 아직 아무것도 안 띄움
  for (const [name, id, floorM] of LIFTS) {
    if (!want(name)) continue;
    const info = await ev(`(() => { const L = ${SV}.level; if (${floorM === undefined}) { L.showZone(${JSON.stringify(id)}); return L.unit ? L.unit.zone.name : null; }
      L.showBuilding(${JSON.stringify(id)}); const u = L.unit; if (!u) return null; const m = ${JSON.stringify(floorM ?? null)};
      if (m !== null) { const i = u.floors.findIndex((f) => Math.abs(f.m - m) < 0.6); if (i < 0) return 'no floor at ' + m + ': ' + u.floors.map((f) => f.m).join(','); L.showBuilding(${JSON.stringify(id)}, i); }
      return L.unit.name + ' ' + L.unit.floors.map((f) => (f.name || '-') + '@' + f.m + (f.roadIds.length ? '*' : '')).join(' '); })()`);
    console.log(name, '->', info);
    await sleep(4500);
    await shot(name);
  }
  // 보기 설정: 굵게 + 이름표 전체 + 나머지 숨김으로 한 장
  if (want('15-설정')) {
    await ev(`(async () => { const s = await import('/src/view-style.ts'); s.setViewStyle({ line: 'thick', labels: 'all', others: 'hide' }); ${SV}.level.showZone('fountain'); return 1; })()`);
    await sleep(4500); await shot('15-설정-굵게-전체-숨김');
    await ev(`(async () => { const s = await import('/src/view-style.ts'); s.setViewStyle(s.VIEW_STYLE_DEFAULT); return 1; })()`);
  }
  await click(LEVEL); await sleep(1500);
  if (want('16-끈뒤')) await shot('16-끈뒤');
}

// ---- 1인칭 ----
// [이름, 길 이름 정규식들(차례로 이어 걸음), 찍을 곳(걸은 거리 비율)]
const WALKS = [
  ['21-걷기-운동장', null],
  ['22-걷기-대일관앞계단', ['대일관.*계단|현관.*계단']],
  ['23-걷기-지하1층-은주관문-계단-3층', ['운동장 지하 1층 ~ 은주1관 3층 문', '은주1관 지하통로 문 안 계단', '은주1관 3층 복도', '한림관–은주1관 연결통로']],
  ['24-걷기-본관2층-유리문-지하통로', ['본관 2층 복도', '본관 2층 유리문 ~ 지하통로 머리', '본관 2층–유담관 7층 지하통로']],
  ['25-걷기-한림관-연결통로-본관5층', ['한림관 연결 층 통로', '본관 5층–한림관 연결통로']],
  ['26-걷기-내리막길', ['문예관 옆 오르막 보행로']],
  ['27-걷기-운동장계단-지하1층', ['운동장 지하 1층 ~ 운동장 계단']],
];
const trace = {};
for (const [name, chain] of WALKS) {
  if (!want(name)) continue;
  const res = await ev(`(async () => { const sv = ${SV}; const W = sv.walk; const src = sv.level;
    const roads = (${editor} ? window.__editor.spaceViews : window.__spaceViews).level['src'].roads();
    const chain = ${JSON.stringify(chain)};
    if (!chain) { src.setActive(true); src.showZone('field'); const a = src.anchor(); src.setActive(false, { fly: false }); W.start(a.x, a.y, a.z); return { start: W.where(), feet: [W.state.feetM], lines: 0 }; }
    const lines = [];
    for (const pattern of chain) { const re = new RegExp(pattern); const hits = roads.filter((r) => re.test(r.name || '')); if (!hits.length) return { missing: pattern };
      let c = hits.reduce((a, b) => (b.geometry.coordinates.length > a.geometry.coordinates.length ? b : a)).geometry.coordinates.map((p) => [...p]);
      if (chain.length === 1 && /계단|오르막/.test(pattern) && c[0][2] < c[c.length - 1][2]) c.reverse(); // 위에서 아래로
      if (lines.length) { const last = lines[lines.length - 1].slice(-1)[0]; const d = (p) => Math.hypot(p[0] - last[0], p[1] - last[1]); if (d(c[c.length - 1]) < d(c[0])) c.reverse(); }
      lines.push(c); }
    if (lines.length > 1) { const next = lines[1][0]; const d = (p) => Math.hypot(p[0] - next[0], p[1] - next[1]); if (d(lines[0][0]) < d(lines[0][lines[0].length - 1])) lines[0].reverse(); }
    const pts = lines.flat();
    W.start(pts[0][0], pts[0][1], pts[0][2] + 0.3, Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]));
    window.__walk = { pts, i: 1, feet: [W.state.feetM], where: [W.where()] };
    return { start: W.where(), lines: lines.length, points: pts.length, from: pts[0], to: pts[pts.length - 1] }; })()`);
  console.log(name, JSON.stringify(res));
  if (res.missing) { trace[name] = res; await ev(`(${SV}.walk.stop(), 1)`); continue; }
  await sleep(6000);
  await shot(`${name}-a`);
  if (chain) {
    // 길을 따라 W 를 누른 것처럼 걷는다: 다음 꼭짓점 쪽으로 몸을 돌리고 0.1 초씩 전진. 세 곳에서 찍는다
    for (const part of ['b', 'c', 'd']) {
      const r = await ev(`(() => { const W = ${SV}.walk, w = window.__walk, held = new Set(['KeyW']); const stopAt = Math.ceil(w.pts.length * ${part === 'b' ? 0.34 : part === 'c' ? 0.67 : 1});
        let guard = 0;
        while (w.i < stopAt && guard++ < 20000) { const t = w.pts[w.i]; const dx = t[0] - W.state.x, dy = t[1] - W.state.y;
          if (Math.hypot(dx, dy) < 0.25) { w.i++; continue; }
          W.state.heading = Math.atan2(dx, dy); W.advance(Math.min(0.1, Math.hypot(dx, dy) / 1.4), held); w.feet.push(Math.round(W.state.feetM * 100) / 100); }
        w.where.push(W.where()); return { feet: W.state.feetM, target: w.pts[Math.min(w.i, w.pts.length) - 1][2], where: W.where(), steps: w.feet.length }; })()`);
      console.log('  ', part, JSON.stringify(r));
      await sleep(3500);
      await shot(`${name}-${part}`);
    }
    trace[name] = await ev(`(() => { const w = window.__walk; const f = w.feet; return { where: w.where, feetStart: f[0], feetEnd: f[f.length - 1], feetMin: Math.min(...f), feetMax: Math.max(...f), biggestStep: f.reduce((m, v, i) => (i ? Math.max(m, Math.abs(v - f[i - 1])) : 0), 0), roadEnd: w.pts[w.pts.length - 1][2] }; })()`);
  } else trace[name] = res;
  await ev(`(${SV}.walk.stop(), 1)`);
  await sleep(800);
}
if (Object.keys(trace).length) { const f = path.join(outDir, `${editor ? '편집기' : '지도'}-f08-걷기-기록.json`); fs.writeFileSync(f, JSON.stringify(trace, null, 1)); console.log('saved', f, JSON.stringify(trace)); }
ws.close();
