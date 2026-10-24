// 층별 트래킹 노드(2026-10-25): 층 따로 보기의 펼친 마지막 장면과 한 층 포커싱 화면에 지어낸 세션 점을 찍는다. 읽기만 한다.
//   node shots.mjs <mock.js> <저장 폴더>
// mock.js = docs/audit/fp1/make_mock.py 가 만든 fetch 대역(DB 없음). --remote-debugging-port=9333 headless Chrome,
// SHOT_URL(기본 http://localhost:5291/)에 vite. 지어낸 궤적은 level.extraTracks 에 넣는다(시험 DB 에 세션이 없음).
// 점: 층마다 한 무리 — 기록 층(확정) 4, 높이만(추정) 4, 높이 없음(미상) 2. 북악관 B1~7층, 운동장 지하 2층 → 1층, 본관–북악관 지하 통로, 지상(회차 공간).
import fs from 'node:fs';
import path from 'node:path';
const [mockFile, outDir] = process.argv.slice(2);
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1500)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(mockFile, 'utf8') });
await send('Page.navigate', { url: process.env.SHOT_URL || 'http://localhost:5291/' });
for (let k = 0; k < 90; k++) { await sleep(1000); if (await ev('!!(window.__spaceViews && window.__previewViewer && window.Cesium)')) break; }
for (let k = 0; k < 40; k++) { await sleep(1000); if (await ev('window.__spaceViews.level.zones.length > 0 && window.__spaceViews.level.solids.length > 0')) break; }
await sleep(8000);
fs.mkdirSync(outDir, { recursive: true });
const L = 'window.__spaceViews.level';
await ev(`(document.getElementById('scene-level-view').click(), 1)`);
await sleep(500);

// ---- 지어낸 궤적: 화면에 실린 건물·구획으로 만든다 ----
const info = await ev(`(async () => {
  const tm = await import('/src/tm.ts'); const lv = await import('/src/level-view.ts');
  const L = ${L}, src = L.src;
  const metres = (ring) => ring.map(([lon, lat]) => { const p = tm.tmForward(lat, lon); return [p.x, p.y]; });
  const inRing = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pts = [];
  /** a cluster of 10 points around (x, y) inside 'ok': 4 with the record, 4 height only, 2 without a height */
  const cluster = (x, y, h, record, ok, spread = 2.5) => {
    let n = 0;
    for (let k = 0; k < 200 && n < 10; k++) {
      const p = { x: x + (rnd() - 0.5) * 2 * spread, y: y + (rnd() - 0.5) * 2 * spread };
      if (!ok(p.x, p.y)) continue;
      pts.push({ ...p, h: n >= 8 ? null : h + (rnd() - 0.5) * 0.6, ...(n < 4 && record ? { record } : {}) }); n++;
    }
    return n;
  };
  const out = {};
  // 북악관: 층마다 발자국 안의 다른 자리에 한 무리
  const bukak = L.buildingList().find((b) => b.name.includes('북악관'));
  L.showBuilding(bukak.id);
  const floors = L.unit.floors;
  const blocks = src.buildings().filter((b) => b.buildingId === bukak.id || b.buildingId.startsWith(bukak.id));
  const rings = blocks.flatMap((b) => b.geometry.coordinates.map((poly) => metres(poly[0])));
  const inB = (x, y) => rings.some((r) => inRing(r, x, y));
  const main = rings.reduce((a, b) => (b.length > a.length ? b : a));
  const xs = main.map((p) => p[0]), ys = main.map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const code = (name) => { const n = lv.floorInText(name); return n === null ? null : n < 0 ? 'B' + (-n) : n + 'F'; };
  out.bukak = { id: bukak.id, floors: floors.map((f) => (f.name ?? '-') + '@' + f.m), clusters: [] };
  floors.forEach((f, i) => {
    let x = 0, y = 0;
    for (let k = 0; k < 400; k++) { x = box[0] + (box[2] - box[0]) * (0.15 + 0.7 * ((i + 0.5) / floors.length)) + (rnd() - 0.5) * 4; y = box[1] + (box[3] - box[1]) * (0.3 + rnd() * 0.4); if (inB(x, y)) break; }
    const c = code(f.name);
    out.bukak.clusters.push([f.name, c, cluster(x, y, f.m + 1.2, c ? { buildingId: bukak.id, floor: c, source: 'marker' } : null, inB)]);
  });
  // 운동장 지하 2층 -> 지하 1층(주차장): 지하 2층에 두 무리, 지하 1층에 두 무리
  const zone = (id) => L.zones.find((z) => z.id === id);
  const inZ = (z) => (x, y) => z.polygons.some((poly) => inRing(poly[0], x, y) && !poly.slice(1).some((hole) => inRing(hole, x, y)));
  const b2 = zone('b2'), b1 = zone('b1');
  out.parking = [cluster(201185, 557235, b2.floorM + 1.2, { buildingId: null, floor: 'B2', source: 'marker' }, inZ(b2), 4), cluster(201170, 557245, b2.floorM + 1.2, { buildingId: null, floor: 'B2', source: 'marker' }, inZ(b2), 4),
    cluster(201175, 557255, b1.floorM + 1.2, { buildingId: null, floor: 'B1', source: 'marker' }, inZ(b1), 4), cluster(201195, 557245, b1.floorM + 1.2, { buildingId: null, floor: 'B1', source: 'marker' }, inZ(b1), 4)];
  // 본관–북악관 지하 통로(FP1 05 시점의 길): 높이만, 기록 없음
  const a = [201045.2, 557349.5], b = [201046.9, 557359.8];
  const passage = []; for (let k = 0; k <= 8; k++) { const t = k / 8; const p = { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, h: 128.6 + 1.2 }; pts.push(p); passage.push(p); }
  out.passage = passage.map((p) => { const z = lv.zoneAt(L.zones, p.x, p.y, p.h); const inside = src.buildings().filter((bb) => bb.geometry.coordinates.some((poly) => inRing(metres(poly[0]), p.x, p.y))).map((bb) => bb.buildingId); return (z ? z.id : '-') + '/' + inside.join('+'); });
  // 지상: 북악관 앞 회차 공간
  const turn = zone('turn'), r0 = turn.polygons[0][0];
  const cx = r0.reduce((s, p) => s + p[0], 0) / r0.length, cy = r0.reduce((s, p) => s + p[1], 0) / r0.length;
  out.ground = cluster(cx, cy, src.groundAt(cx, cy) + 1.2, { buildingId: 'outdoor', floor: null, outdoor: true, source: 'marker' }, inZ(turn), 5);
  out.groundAt = [cx, cy, inZ(turn)(cx, cy)];
  L.extraTracks = [{ id: 'synthetic|raw', kind: 'raw', label: '지어낸 세션', points: pts }];
  out.points = pts.length;
  return out;
})()`);
console.log(JSON.stringify(info, null, 1));

/** what is lifted now after the lift: every moving primitive back at identity, dots per floor/plate, panel line */
const check = () => ev(`(() => { const L = ${L}, C = window.Cesium;
  const moved = L.prims.filter((p) => p.modelMatrix && !C.Matrix4.equalsEpsilon(p.modelMatrix, C.Matrix4.IDENTITY, 1e-9)).length;
  const by = {}; for (const d of L.trackDots) { const k = d.floor ?? '-'; (by[k] ??= { n: 0, z: new Set(), g: {} }).n++; by[k].z.add(Math.round(d.at[2] * 100) / 100); by[k].g[d.grade] = (by[k].g[d.grade] ?? 0) + 1; }
  const floors = Object.entries(by).map(([k, v]) => k + ':' + v.n + ' z=' + [...v.z].join('/') + ' ' + JSON.stringify(v.g));
  const msg = document.querySelector('.level-track-msg'); return { moved, dots: L.trackDots.length, floors, panel: msg ? msg.innerText : '' }; })()`);
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
  const f = path.join(outDir, `${name}.jpg`);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); console.log('saved', f);
};
const lift = async (expr, name, mid = false) => {
  await ev(`(${L}.${expr}, 1)`);
  if (mid) { await sleep(350); await shot(`${name}-펼치는-중`); }
  await sleep(3500);
  console.log(name, JSON.stringify(await check()));
  await shot(name);
};
const bid = JSON.stringify(info.bukak.id);
await lift(`showBuilding(${bid})`, '01-북악관-펼친-마지막', true);
await ev(`(() => { const p = document.querySelector('.level-panel'); p.scrollTop = p.scrollHeight; return 1; })()`);
await sleep(300); await shot('01b-북악관-범례');
await ev(`(() => { document.querySelector('.level-panel').scrollTop = 0; return 1; })()`);
const nFloors = info.bukak.floors.length;
const pick = (name) => info.bukak.floors.findIndex((f) => f.startsWith(name));
for (const [label, i] of [['02-북악관-지하1층-포커싱', pick('지하 1층')], ['03-북악관-3층-포커싱', pick('3층')], ['04-북악관-7층-포커싱', nFloors - 1]]) if (i >= 0) await lift(`showBuilding(${bid}, ${i})`, label);
await lift(`showZone('b2')`, '05-운동장-지하2층', true);
await lift(`showZone('b1')`, '06-운동장-지하1층');
const passageZones = [...new Set(info.passage.map((s) => s.split('/')[0]).filter((z) => z !== '-'))];
const passageBuilding = info.passage.map((s) => s.split('/')[1]).find((b) => b);
for (const z of passageZones) await lift(`showZone(${JSON.stringify(z)})`, `07-지하통로-${z}`);
if (passageBuilding) {
  const part = await ev(`${L}.buildingList().find((b) => ${JSON.stringify(passageBuilding)}.startsWith(b.id))?.id ?? null`);
  if (part) await lift(`showBuilding(${JSON.stringify(part)})`, `08-지하통로-건물-${part}`);
}
await lift(`showZone('turn')`, '09-지상-회차공간');
await ev(`(() => { ${L}.extraTracks = []; ${L}.setActive(false, { fly: false }); return 1; })()`);
ws.close();
