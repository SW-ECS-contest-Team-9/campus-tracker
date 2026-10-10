// Z03: S-MAP 3D 뷰어(https://smap.seoul.go.kr) 탭의 콘솔에서 실행한 읽기 전용 판독 함수(e05/collect_grid.js 와 같은 방식).
// __g2: 거의 정사 시점(fov 0.12, 기울기 90도, 회전 0)에서 격자점마다 화면에 그려진 메시 표면 z(cm)와 모델 id(색인)를 읽는다. 서버에 추가 요청 없음(타일 표시만).
//   await __g2('z03-plaza-05m-a', 201026, 557160, 157, 55, 0.5, 114, 500)   (조각 a~d: y0 = 557160, 557187.5, 557215, 557242.5)
// __tiles: 같은 시점의 화면 조각 6장(가운데 x 201046·201090, y 557180·557214·557248, range 300)과 조각마다 좌표 4점의 화면 픽셀 -> ortho.py 가 한 장으로 편다.
// 결과 글은 200,000 자가 넘게 채워서 돌려주면 브라우저 도구가 파일로 떨군다 -> save_grid.py / ortho.py.
window.__g2 = async function (name, x0, y0, nx, ny, step, zc, range) {
  const m = application.mainMap(), v = m.getView();
  v.setFov(0.12); v.setRotation(0); v.setTilt(Math.PI / 2 - 0.001);
  const cx = x0 + step * (nx - 1) / 2, cy = y0 + step * (ny - 1) / 2;
  v.setCenter([cx, cy, zc]); v.setRange(range);
  let last = -1, same = 0;
  for (let k = 0; k < 60; k++) { m.renderSync(); await new Promise(r => setTimeout(r, 500)); const t = m.getCountOfViewingTiles(); if (t === last) same++; else same = 0; last = t; if (k > 20 && same > 8) break; }
  m.renderSync();
  const idl = [], idx = {};
  const lines = [`# ${name} S-MAP 3D viewer mesh pick ${new Date().toISOString()} ortho-like fov0.12 tilt90 rot0 center ${cx},${cy},${zc} range ${range}; grid x=${x0}+${step}*i (i<${nx}), y=${y0}+${step}*j (j<${ny}); line j|z cm csv|model index csv; -1 = no pick`];
  let miss = 0, bad = 0, t0 = performance.now();
  for (let j = 0; j < ny; j++) {
    const zs = [], ids = [];
    for (let i = 0; i < nx; i++) {
      const x = x0 + step * i, y = y0 + step * j; let z = zc, c = null, px = null;
      for (let k = 0; k < 4; k++) { px = m.getPixelFromCoordinate([x, y, z]); c = px && m.getCoordinate3dFromPixel(px); if (!c) break; z = c[2]; }
      if (!c) { zs.push(-1); ids.push(0); miss++; continue; }
      const id = m.getModelIdFromPixel(px) || 0; if (!(id in idx)) { idx[id] = idl.length; idl.push(id); }
      if (Math.hypot(c[0] - x, c[1] - y) > 0.3) bad++;
      zs.push(Math.round(c[2] * 100)); ids.push(idx[id]);
    }
    lines.push(j + '|' + zs.join(',') + '|' + ids.join(','));
  }
  lines.push('# ids ' + idl.join(','));
  lines.push(`# done n=${nx * ny} miss=${miss} residual>0.3m=${bad} ms=${Math.round(performance.now() - t0)} tiles=${m.getCountOfViewingTiles()}`);
  return lines.join('\n');
};
window.__tilesRun = async function () {
  const m = application.mainMap(), v = m.getView(), out = [];
  const cv = [...document.querySelectorAll('canvas.ol-unselectable')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  for (const cx of [201046, 201090]) for (const cy of [557180, 557214, 557248]) {
    v.setFov(0.12); v.setRotation(0); v.setTilt(Math.PI / 2 - 0.001); v.setCenter([cx, cy, 114]); v.setRange(300);
    for (let k = 0; k < 30; k++) { m.renderSync(); await new Promise(r => setTimeout(r, 400)); }
    m.renderSync(); const url = cv.toDataURL('image/jpeg', 0.93); const pts = [];
    for (const dx of [-15, 15]) for (const dy of [-12, 12]) { const p = m.getPixelFromCoordinate([cx + dx, cy + dy, 114]); pts.push([cx + dx, cy + dy, p[0], p[1]]); }
    out.push(JSON.stringify({ cx, cy, w: cv.width, h: cv.height, cw: cv.clientWidth, ch: cv.clientHeight, pts }) + '|' + url);
  }
  return out.join('\n');
};
