// Z09: 시점 하나에서 화면 점들이 무엇인지 알아본다(읽기만).  node pick.mjs <views.json> <시점> x,y x,y ...   (SHOT_URL 로 포트 선택)
import fs from 'node:fs';
const [viewsFile, name, ...pts] = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(viewsFile, 'utf8'))[name];
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600)); return r.result.result.value; };
if (!(await ev('!!window.__shot'))) throw new Error('먼저 shots.mjs 로 화면을 연다');
await ev(`window.__shot(${JSON.stringify({ pos: w.pos, tgt: w.tgt, fov: w.fov })}, 6)`);
for (const p of pts) {
  const [x, y] = p.split(',').map(Number);
  console.log(p, await ev(`(async () => { const C = window.Cesium, v = window.__previewViewer; const tm = await import('/src/tm.ts'); const o = v.scene.pick(new C.Cartesian2(${x}, ${y})); const c = v.scene.pickPosition(new C.Cartesian2(${x}, ${y})); let at = null; if (c) { const g = C.Cartographic.fromCartesian(c); const q = tm.tmForward(C.Math.toDegrees(g.latitude), C.Math.toDegrees(g.longitude)); at = [q.x.toFixed(1), q.y.toFixed(1), g.height.toFixed(1)]; } return JSON.stringify({ id: o && (typeof o.id === 'object' ? (o.id.id ?? o.id.buildingId ?? Object.keys(o.id)) : o.id), prim: o && o.primitive && o.primitive.constructor.name, at }); })()`));
}
ws.close();
