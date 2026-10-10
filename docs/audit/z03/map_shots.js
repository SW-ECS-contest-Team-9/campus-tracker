// Z03: 시험 지도(http://localhost:5273/, 개발 서버)의 콘솔에서 실행한 갈무리 함수. 읽기만 한다(DB·서버에 쓰지 않음).
// __z03setup(): 좌표 변환(tm.ts)을 불러오고, 구조물 파일 z03-fountain.geojson 을 임시로 그릴 준비를 한다(프런트가 구조물을 아직 그리지 않아서. 화면에만 있고 새로고침하면 사라진다).
// __z03shots(views): views = {이름: {pos:[x,y,z], tgt:[x,y,z], fov, crop?:가로/세로}} 마다 '이름m'(지도 그대로)와 '이름s'(구조물을 올린 것)를 찍어
//   'ALLSHOTS이름|dataURL#NEXT#…' 한 줄로 돌려준다 -> save_shots.py
window.__z03setup = async function () {
  const C = window.Cesium, v = window.__previewViewer, tm = await import('/src/tm.ts');
  const P = (x, y, z) => { const g = tm.tmInverse(x, y); return C.Cartesian3.fromDegrees(g.longitude, g.latitude, z); };
  const fc = await (await fetch('/structures/z03-fountain.geojson')).json();
  const col = (p) => {
    const m = p.material, t = p.type, c = (s, a = 1) => C.Color.fromCssColorString(s).withAlpha(a);
    if (m === 'water') return c('#4fa8d8'); if (m === 'glass') return c('#9cc7d6', 0.55); if (m === 'white-stone') return c('#f1efe8'); if (m === 'stone') return c('#a39e94');
    if (t === 'platform') return m === 'rock' ? c('#8c8f72') : c('#ddd6c6');
    if (t === 'stair_step' || t === 'landing') return c('#c9b9a3'); if (t === 'barrier') return c('#c8322c'); if (t === 'planter') return c('#5b5f63');
    return p.id.startsWith('Z03-RAIL') ? c('#222222') : p.id.startsWith('Z03-PARAPET') ? c('#b9b4a8') : c('#3d4146');
  };
  const ents = [];
  for (const f of fc.features) {
    const p = f.properties; if (p.kind === 'platform' && p.topProfile) continue;   // 기운 기단(차도·둑)은 지형이 싣고 있다
    const ring = f.geometry.coordinates[0].slice(0, -1), lo = p.kind === 'platform' ? p.bottomM : p.fromM, hi = p.kind === 'platform' ? p.topM + 0.03 : p.toM;
    ents.push(v.entities.add({ show: false, polygon: { hierarchy: ring.map((q) => P(q[0], q[1], lo)), perPositionHeight: false, height: lo, extrudedHeight: hi, material: col(p), outline: false } }));
  }
  window.__z03 = { C, v, P, ents };
  return fc.features.length + ' features, drawn ' + ents.length;
};
window.__z03shots = async function (views) {
  const { C, v, P, ents } = window.__z03, out = [];
  const settle = async (n) => { for (let k = 0; k < n; k++) { v.scene.requestRender(); v.render(); await new Promise((r) => setTimeout(r, 250)); } };
  for (const [name, w] of Object.entries(views)) {
    const pos = P(...w.pos), tgt = P(...w.tgt), dir = C.Cartesian3.normalize(C.Cartesian3.subtract(tgt, pos, new C.Cartesian3()), new C.Cartesian3());
    let up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new C.Cartesian3());
    if (Math.abs(C.Cartesian3.dot(up, dir)) > 0.999) up = C.Cartesian3.normalize(C.Cartesian3.subtract(P(w.pos[0], w.pos[1] + 50, w.pos[2]), pos, new C.Cartesian3()), new C.Cartesian3());   // 바로 아래를 볼 때는 위 = 북
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, up, new C.Cartesian3()), new C.Cartesian3()); up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
    v.camera.frustum.fov = C.Math.toRadians(w.fov); v.camera.setView({ destination: pos, orientation: { direction: dir, up } });
    for (const [tag, show] of [['m', false], ['s', true]]) {
      ents.forEach((e) => (e.show = show)); await settle(tag === 'm' ? 28 : 8);
      v.render(); out.push(name + tag + '|' + v.scene.canvas.toDataURL('image/jpeg', 0.9));
    }
  }
  ents.forEach((e) => (e.show = false));
  let s = 'ALLSHOTS' + out.join('#NEXT#'); if (s.length < 200000) s += '#PAD' + '.'.repeat(200000 - s.length);
  return s;
};
