// F09 읽기 쉬움: 같은 시점을 고치기 전과 뒤에 찍는다(프리뷰·편집기). 읽기만 한다(편집기는 시험 계정 T05 로 로그인만).
//   node shots.mjs preview|editor <저장 폴더> 전|후 [이름 일부 ...] [--base=http://localhost:5273] [--chrome=9333]
//   -> 지도-f09-<번호-이름>-<전|후>.jpg / 편집기-f09-...   화면 전체(패널·범례 포함)를 찍는다.
// 나란히 붙이기는 compare.py.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const [mode, outDir, tag, ...only] = args.filter((a) => !a.startsWith('--'));
const editor = mode === 'editor', BASE = opt('base', 'http://localhost:5273'), CHROME = opt('chrome', '9333');
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
const UNDER = editor ? 'layer-underground' : 'scene-roads-underground', SECTIONBOX = editor ? 'layer-section' : 'scene-section';
for (let k = 0; k < 60; k++) { await sleep(1000); if (await ev(`!!(${editor ? 'window.__editor && window.__editor.spaceViews' : 'window.__spaceViews && window.__previewViewer'})`)) break; }
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev(`${SV}.level.zones.length > 0 && ${SV}.level.solids.length > 0`)) break; }
await sleep(9000);
await ev(`(async () => { const tm = await import('/src/tm.ts'); const C = window.Cesium, v = ${VIEWER};
  v.scene.screenSpaceCameraController.enableCollisionDetection = false;
  window.__P = (x, y, z) => { const g = tm.tmInverse(x, y); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, z); };
  window.__look = (w) => { const P = window.__P; const pos = P(...w.pos), tgt = P(...w.tgt), dir = C.Cartesian3.normalize(C.Cartesian3.subtract(tgt, pos, new C.Cartesian3()), new C.Cartesian3());
    let up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new C.Cartesian3());
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, up, new C.Cartesian3()), new C.Cartesian3()); up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
    v.camera.frustum.fov = C.Math.toRadians(w.fov); v.camera.setView({ destination: pos, orientation: { direction: dir, up } }); return 1; }; return 1; })()`);
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  const f = path.join(outDir, `${editor ? '편집기' : '지도'}-f09-${name}-${tag}.jpg`);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); console.log('saved', f);
};
const want = (name) => !only.length || only.some((o) => name.includes(o));
const after = tag === '후'; // 고친 뒤에만 있는 기능(보기 설정 따라오기, 층 고르기 목록, 승강기)은 뒤에만 찍는다
const click = (id) => ev(`(document.getElementById('${id}').click(), 1)`);
const check = (id, on) => ev(`(() => { const b = document.getElementById('${id}'); if (b.checked !== ${on}) b.click(); return b.checked; })()`);
const LEVEL = editor ? 'view-level' : 'scene-level-view';
const HOME = { pos: [200950, 557150, 330], tgt: [201095, 557300, 130], fov: 50 };

// ---- 일반 지도: 전체(이름표), 지하 길 켬 ----
const MAPS = [
  ['01-전체-남서위에서', HOME, false],
  ['02-전체-가까이-본관앞', { pos: [200990, 557230, 215], tgt: [201070, 557310, 130], fov: 50 }, false],
  ['03-지하길켬-남서위에서', HOME, true],
  ['04-지하길켬-바로위에서', { pos: [201120, 557282, 430], tgt: [201120, 557284, 130], fov: 42 }, true],
  ['05-지하길끔-운동장위에서', { pos: [201180, 557150, 300], tgt: [201180, 557262, 140], fov: 45 }, false],
];
for (const [name, view, under] of MAPS) {
  if (!want(name)) continue;
  await check(UNDER, under);
  await ev(`window.__look(${JSON.stringify(view)})`);
  await sleep(6000);
  await shot(name);
  await check(UNDER, false);
}

// ---- 단면도 ----
const SECTIONS = [
  ['11-단면-운동장지하', { a: [201142.5, 557269.91], b: [201226.36, 557219.19], frame: { lowM: 130, highM: 152, backdropM: 10 } }, true],
  ['12-단면-은주1관-한림관-본관', { a: [201150.8, 557281.6], b: [201090.0, 557306.2], frame: { lowM: 130, highM: 152, backdropM: 6 } }, false],
  ['13-단면-본관2층-유담관7층', { a: [201042.5, 557360.5], b: [201024.6, 557286.9], frame: { lowM: 116, highM: 138, backdropM: 6 } }, true],
];
for (const [name, s, under] of SECTIONS) {
  if (!want(name)) continue;
  await check(UNDER, under);
  await ev(`window.__look(${JSON.stringify(HOME)})`);
  await check(SECTIONBOX, true); // 화면의 체크로 켠다(편집기는 이때 선·표지를 물린다)
  await ev(`(() => { ${SECTION}.setLine(${JSON.stringify(s.a)}, ${JSON.stringify(s.b)}); ${SECTION}.lookAt(${JSON.stringify(s.frame)}); return 1; })()`);
  await sleep(7000);
  await shot(name);
  if (after) console.log(name, '이름표', JSON.stringify(await ev(`(() => { const t = ${SECTION}.tags; const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    let over = 0; for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) if (hit(t[i], t[j])) over++;
    return { 수: t.length, 겹침: over, 높이: t.filter((x) => x.kind === 'level').map((x) => x.text) }; })()`)));
  // 보기 설정을 바꾸면 바로 따라옴: 굵게 + 이름표 전체 + 나머지 숨김 / 가늘게 + 이름표 없음
  if (after && name.startsWith('11-')) {
    await ev(`(async () => { const s = await import('/src/view-style.ts'); s.setViewStyle({ line: 'thick', labels: 'all', others: 'hide' }); return 1; })()`);
    await sleep(3500); await shot('14-단면-운동장지하-굵게·전체·숨김');
    await ev(`(async () => { const s = await import('/src/view-style.ts'); s.setViewStyle({ line: 'thin', labels: 'none', others: 'dim' }); return 1; })()`);
    await sleep(3500); await shot('15-단면-운동장지하-가늘게·없음·흐리게');
    await ev(`(async () => { const s = await import('/src/view-style.ts'); s.setViewStyle(s.VIEW_STYLE_DEFAULT); return 1; })()`);
    if (editor) { // 편집 선·표지도 보기를 켠 모습(기본은 꺼짐)
      await ev(`(() => { const b = document.querySelector('.section-panel input[data-overlay]'); b.click(); return b.checked; })()`);
      await sleep(3000); await shot('16-단면-운동장지하-편집선켬');
      await ev(`(() => { const b = document.querySelector('.section-panel input[data-overlay]'); b.click(); return b.checked; })()`);
    }
  }
  await check(SECTIONBOX, false);
  await ev(`(${SECTION}.stop(), 1)`);
  await check(UNDER, false);
  await sleep(800);
}

// ---- 층 따로 보기 ----
const LIFTS = [['21-띄움-운동장지하1층', 'b1'], ['22-띄움-운동장지하2층', 'b2'], ['23-벌려-은주1관', '은주관', null], ['24-벌려-대일관', '대일관', null], ['25-벌려-은주1관-3층', '은주관', 137.8]];
if (LIFTS.some(([n]) => want(n))) {
  await ev(`window.__look(${JSON.stringify(HOME)})`);
  if (!(await ev(`${SV}.level.active`))) await click(LEVEL);
  await sleep(500);
  for (const [name, id, floorM] of LIFTS) {
    if (!want(name)) continue;
    const info = await ev(`(() => { const L = ${SV}.level; if (${floorM === undefined}) { L.showZone(${JSON.stringify(id)}); return L.unit ? L.unit.zone.name : null; }
      L.showBuilding(${JSON.stringify(id)}); const u = L.unit; if (!u) return null; const m = ${JSON.stringify(floorM ?? null)};
      if (m !== null) { const i = u.floors.findIndex((f) => Math.abs(f.m - m) < 0.6); if (i < 0) return 'no floor at ' + m; L.showBuilding(${JSON.stringify(id)}, i); }
      return L.unit.name + ' ' + L.unit.floors.map((f) => (f.name || '-') + '@' + f.m + (f.roadIds.length ? '*' : '')).join(' '); })()`);
    console.log(name, '->', info);
    await sleep(5000);
    await shot(name);
  }
  // 운동장을 실제로 눌러 본다: 땅 아래에 지하 층이 있으면 고르는 목록이 뜬다
  if (after && want('26-고르기')) {
    await ev(`(${SV}.level.setActive(false, { fly: false }), 1)`);
    await ev(`window.__look(${JSON.stringify({ pos: [201180, 557150, 300], tgt: [201180, 557262, 140], fov: 45 })})`);
    await sleep(2500);
    await click(LEVEL); await sleep(800);
    const box = await ev(`(() => { const r = ${VIEWER}.scene.canvas.getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(1500);
    console.log('26-고르기 ->', JSON.stringify(await ev(`${SV}.level.choices`)));
    await shot('26-고르기-운동장누름');
    await ev(`(() => { const b = document.querySelector('.level-chooser [data-zone="b2"]'); if (b) b.click(); return !!b; })()`);
    await sleep(5000);
    await shot('27-고르기-지하2층고름');
  }
  await click(LEVEL); await sleep(1500);
}

// ---- 1인칭 ----
// [이름, 길 이름 정규식(그 길의 가운데에 섬) 또는 구획 id, 바라볼 방향 더하기(도)]
const WALKS = [['31-1인칭-지하1층주차장', { zone: 'b1' }], ['32-1인칭-본관유담관지하통로', { road: '본관 2층–유담관 7층 지하통로' }]];
for (const [name, at] of WALKS) {
  if (!want(name)) continue;
  const res = await ev(`(async () => { const sv = ${SV}; const W = sv.walk, L = sv.level; const roads = L['src'].roads(); const at = ${JSON.stringify(at)};
    if (at.zone) { const z = L.zones.find((q) => q.id === at.zone); const ring = z.polygons[0][0]; const x = ring.reduce((s, p) => s + p[0], 0) / ring.length, y = ring.reduce((s, p) => s + p[1], 0) / ring.length; W.start(x, y, z.floorM + 0.3, 1.2); return W.where(); }
    const re = new RegExp(at.road); const hits = roads.filter((r) => re.test(r.name || '')); if (!hits.length) return 'missing';
    const c = hits.reduce((a, b) => (b.geometry.coordinates.length > a.geometry.coordinates.length ? b : a)).geometry.coordinates;
    // 길이의 40 % 지점에서 길을 따라 바라봄
    const len = c.map((p, k) => (k ? Math.hypot(p[0] - c[k - 1][0], p[1] - c[k - 1][1]) : 0)); let left = len.reduce((s, v) => s + v, 0) * 0.4, i = 1;
    while (i < c.length - 1 && left > len[i]) { left -= len[i]; i++; }
    const t = left / (len[i] || 1), p = c[i - 1].map((v, k) => v + (c[i][k] - v) * t);
    W.start(p[0], p[1], p[2] + 0.3, Math.atan2(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1])); return W.where(); })()`);
  console.log(name, '->', res);
  await sleep(7000);
  await shot(`${name}-a`);
  await ev(`(() => { const W = ${SV}.walk; W.state.heading += 2.2; W.state.pitch = -0.12; return 1; })()`);
  await sleep(3000);
  await shot(`${name}-b`);
  await ev(`(${SV}.walk.stop(), 1)`);
  await sleep(800);
}
// 승강기: 유담관 승강기 아래 정류에 서서 PageUp 을 실제 키 입력으로 누른다
if (after && want('33-1인칭-승강기')) {
  const res = await ev(`(async () => { const sv = ${SV}; const W = sv.walk, L = sv.level; const lifts = L['src'].roads().filter((r) => r.structure === 'elevator');
    if (!lifts.length) return { 승강기: 0 };
    const r = lifts.find((q) => /유담관/.test((q.name || '') + (q.buildingId || ''))) || lifts[0]; const c = r.geometry.coordinates; const low = c[0][2] < c[c.length - 1][2] ? c[0] : c[c.length - 1];
    W.start(low[0] + 0.8, low[1], low[2] + 0.3, 0); return { 승강기: lifts.length, 이름: r.name, 선곳: W.where(), 발: W.state.feetM }; })()`);
  console.log('33-1인칭-승강기', JSON.stringify(res));
  if (res.승강기) {
    await sleep(4000); await shot('33-1인칭-승강기-a-아래정류');
    await ev(`(${VIEWER}.scene.canvas.focus(), 1)`);
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 });
    await sleep(3500);
    console.log('  PageUp ->', JSON.stringify(await ev(`(() => { const W = ${SV}.walk; return { 발: W.state.feetM, 선곳: W.where() }; })()`)));
    await shot('33-1인칭-승강기-b-PageUp뒤');
  }
  await ev(`(${SV}.walk.stop(), 1)`);
}
ws.close();
