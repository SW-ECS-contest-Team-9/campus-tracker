// F11 길 하나를 화면에서 눌러 고른 뒤 찍는다(고른 길 강조·나머지 흐리게가 그대로인지). 편집기가 열려 있어야 한다(shots.mjs 뒤).
//   node select-check.mjs <저장 파일.png> [--chrome=9341]
import fs from 'node:fs';
const args = process.argv.slice(2), CHROME = (args.find((a) => a.startsWith('--chrome=')) ?? '--chrome=9341').split('=')[1];
const list = await (await fetch(`http://127.0.0.1:${CHROME}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await ev(`window.__look({ pos: [201050, 557270, 185], tgt: [201098, 557331, 135], fov: 50 })`); await sleep(3000);
const at = await ev(`(() => { const v = window.__editor.viewer, C = window.Cesium, r = v.scene.canvas.getBoundingClientRect();
  for (const e of v.entities.values) { if (!/^editor:road:[0-9a-f-]+$/.test(e.id)) continue; const ps = e.polyline.positions.getValue(); const a = ps[ps.length >> 1], b = ps[(ps.length >> 1) - 1] ?? a;
    const w = C.SceneTransforms.worldToWindowCoordinates(v.scene, C.Cartesian3.midpoint(a, b, new C.Cartesian3()));
    if (w && w.x > 150 && w.x < r.width - 150 && w.y > 200 && w.y < r.height - 250) { const hit = v.scene.pick(w, 6, 6); if ((hit?.id?.id ?? '') === e.id) return { x: w.x + r.left, y: w.y + r.top, id: e.id }; } } return null; })()`);
console.log('누를 자리', JSON.stringify(at));
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }); await sleep(800);
const tip = await ev(`(() => { const t = document.getElementById('editor-hover-tip'); return t.hidden ? null : t.innerText; })()`);
console.log('가리킴 쪽지', JSON.stringify(tip));
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
await sleep(4000);
const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(args[0], Buffer.from(r.result.data, 'base64'));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
ws.close();
