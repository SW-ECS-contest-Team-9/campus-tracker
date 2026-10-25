// FP1(2026-10-25, 1인칭 반투명 벽 제거): 프리뷰 화면(vite)을 DB 없이 띄워 1인칭 걷기 시점을 찍는다. 읽기만 한다.
//   node shots.mjs <mock.js> <저장 폴더> <머리말> [시점 이름 일부 ...]
// mock.js = make_mock.py 가 만든 fetch 대역(장면·지형 격자·길 스냅숏). 구조물·zones·interiors 는 화면의 public 파일 그대로.
// --remote-debugging-port=9333 으로 띄운 headless Chrome, SHOT_URL(기본 http://localhost:5291/)의 vite 가 있어야 한다.
import fs from 'node:fs';
import path from 'node:path';
const [mockFile, outDir, prefix, ...only] = process.argv.slice(2);
// 시점: 걷기 시작점(EPSG:5186 x, y, 바닥 높이 m)과 바라보는 방향(북에서 시계 방향, 도), 아래로 숙인 각(도)
const VIEWS = {
  '01-본관2층-복도-북서': { at: [201056.5, 557321.7, 128.5], toward: [201049.5, 557325.1] },
  '02-본관2층-복도-남동': { at: [201070.5, 557314.9, 128.5], toward: [201094, 557303.3] },
  '03-북악관B1-주동선': { at: [201036.5, 557386.3, 130.5], toward: [201048.1, 557381.1] },
  '04-북악관B1-진입통로': { at: [201048.0, 557367.5, 130.5], toward: [201048.1, 557381.1] },
  '05-본관-북악관-지하통로': { at: [201045.2, 557349.5, 128.6], toward: [201046.9, 557359.8] },
};
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(mockFile, 'utf8') });
await send('Page.navigate', { url: process.env.SHOT_URL || 'http://localhost:5291/' });
for (let k = 0; k < 90; k++) { await sleep(1000); if (await ev('!!(window.__spaceViews && window.__previewViewer && window.Cesium)')) break; }
await sleep(15000); // 구조물·구획·실내 구조 파일
fs.mkdirSync(outDir, { recursive: true });
for (const [name, v] of Object.entries(VIEWS)) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const heading = Math.atan2(v.toward[0] - v.at[0], v.toward[1] - v.at[1]);
  const where = await ev(`(async () => { const w = window.__spaceViews.walk; w.stop(); w.start(${v.at[0]}, ${v.at[1]}, ${v.at[2] + 0.3}, ${heading});
    w.state.pitch = -0.08; w.advance(0.5, new Set());
    for (let k = 0; k < 24; k++) await new Promise((r) => setTimeout(r, 250));
    return { hud: document.querySelector('.walk-hud')?.textContent ?? '', feet: w.state.feetM, room: w.roomKey }; })()`);
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  const f = path.join(outDir, `${prefix}-${name}.jpg`);
  fs.writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', f, JSON.stringify(where));
}
await ev('(window.__spaceViews.walk.stop(), 1)');
ws.close();
