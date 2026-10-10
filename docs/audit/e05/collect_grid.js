// E05: S-MAP 3D 뷰어(https://smap.seoul.go.kr) 탭의 콘솔에서 실행한 읽기 전용 격자 판독 함수.
// 정사 근사 시점(fov 0.12, 기울기 90도, 회전 0)으로 놓고, 격자점마다 getPixelFromCoordinate -> getCoordinate3dFromPixel 을
// 4회 되풀이해(시차 보정) 화면에 그려진 메시 표면 z 와 getModelIdFromPixel 의 모델 id 를 읽는다. 서버에 추가 요청을 보내지 않는다(타일 표시만).
// 호출 예: await __grid('eunju-1m-a', 201105, 557140, 111, 57, 1, 150, 1700)
// 한 번에 하나만 실행한다(동시에 돌리면 시점이 바뀐다). 결과 문자열은 save_grid.py 로 저장한다.
window.__grid = async function (name, x0, y0, nx, ny, step, zc, range) {
  const m = application.mainMap(), v = m.getView();
  v.setFov(0.12); v.setRotation(0); v.setTilt(Math.PI / 2 - 0.001);
  const cx = x0 + step * (nx - 1) / 2, cy = y0 + step * (ny - 1) / 2;
  v.setCenter([cx, cy, zc]); v.setRange(range);
  // 탭이 가려져 있으면 화면이 스스로 다시 그려지지 않는다(그 상태의 판독은 옛 화면 값이라 버렸다). 그래서 직접 그리게 한다.
  for (let k = 0; k < 24; k++) { m.renderSync(); await new Promise(r => setTimeout(r, 500)); }
  m.renderSync();
  const lines = [`# ${name} S-MAP 3D viewer mesh pick ${new Date().toISOString()} ortho-like fov0.12 tilt90 rot0 center ${cx},${cy},${zc} range ${range}; grid x=${x0}+${step}*i (i<${nx}), y=${y0}+${step}*j (j<${ny}); line j|z*10 csv|modelId csv|xy residual cm csv; -1 = no pick`];
  let miss = 0, bad = 0, t0 = performance.now();
  for (let j = 0; j < ny; j++) {
    const zs = [], ids = [], rs = [];
    for (let i = 0; i < nx; i++) {
      const x = x0 + step * i, y = y0 + step * j; let z = zc, c = null, px = null;
      for (let k = 0; k < 4; k++) { px = m.getPixelFromCoordinate([x, y, z]); c = px && m.getCoordinate3dFromPixel(px); if (!c) break; z = c[2]; }
      if (!c) { zs.push(-1); ids.push(0); rs.push(-1); miss++; continue; }
      zs.push(Math.round(c[2] * 10)); ids.push(m.getModelIdFromPixel(px) || 0); const r = Math.round(Math.hypot(c[0] - x, c[1] - y) * 100); if (r > 30) bad++; rs.push(r);
    }
    lines.push(j + '|' + zs.join(',') + '|' + ids.join(',') + '|' + rs.join(','));
  }
  lines.push(`# done n=${nx * ny} miss=${miss} residual>0.3m=${bad} ms=${Math.round(performance.now() - t0)} tiles=${m.getCountOfViewingTiles()}`);
  let body = lines.join('\n'); if (body.length < 200000) body += '\n#PAD' + '.'.repeat(200000 - body.length);
  return body;
};
