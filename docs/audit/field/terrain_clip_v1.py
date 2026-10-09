"""표시용 국소 지형 대체 자료 + 청운관 본체/돌출부 분리 (DEM 파일·운영 DB 불변).

1) terrain-clip-v1.geojson
   - clip: 검증된 표면 경계(SF-FIELD 셀 윤곽, SF-CORRIDOR, SF-ENJU2-UPPER/LOWER-0/LOWER-1) 안의 렌더 지형을 잘라냄(Cesium globe clippingPolygons)
   - skirt: 각 표면 경계를 따라 ≤1 m 간격으로 표면 z ↔ DEM z 사이 세로 면(사면·옹벽 대용, 추정)
2) cheongun-split-v1.geojson
   - override: 청운관 본체 = 원외곽선 − 돌출 지붕(SF-CHEONGUN-CANOPY) 평면. 돌출부는 추정 구조(슬래브·기둥)와 빈 공간으로 남김
3) 검사: 관통 셀(지형 > 면 + 0.3 m)이 모두 잘림 구역 안인지, 구역 밖 DEM 셀 수/해시(불변 자료)
사용: python terrain_clip_v1.py <repo-root>
"""
import hashlib, json, sys
from pathlib import Path
import numpy as np
from shapely.geometry import Point, Polygon, mapping, shape
from shapely.prepared import prep

ROOT = Path(sys.argv[1])
OUT = ROOT / 'frontend/public/corrections'
v3 = json.loads((OUT / 'field-surfaces-v3.geojson').read_text(encoding='utf-8'))
S = {f['properties']['id']: f for f in v3['features']}
m = json.loads((ROOT / 'docs/audit/m16/preview/data/terrain-grid-meta.json').read_text())
grid_raw = (ROOT / 'docs/audit/m16/preview/data/terrain-grid.f32').read_bytes()
G = np.frombuffer(grid_raw, dtype='<f4').reshape(m['height'], m['width'])
R = m['resolution']


def dem_bilinear(x, y):
    i, j = (x - m['originX']) / R, (y - m['originY']) / R
    i0, j0 = int(np.floor(i)), int(np.floor(j))
    fi, fj = i - i0, j - j0
    g = lambda a, b: float(G[min(max(b, 0), m['height'] - 1), min(max(a, 0), m['width'] - 1)])
    return (g(i0, j0) * (1 - fi) + g(i0 + 1, j0) * fi) * (1 - fj) + (g(i0, j0 + 1) * (1 - fi) + g(i0 + 1, j0 + 1) * fi) * fj


def dem_cell(x, y):
    return float(G[int(round((y - m['originY']) / R)), int(round((x - m['originX']) / R))])


def zfun(f):
    pts = np.array(f['geometry']['coordinates'][0])
    if np.ptp(pts[:, 2]) < 1e-9:
        return lambda x, y: float(pts[0, 2])
    def g(x, y):
        d = np.hypot(pts[:, 0] - x, pts[:, 1] - y) + 1e-6
        w = 1 / d ** 2
        return float((w * pts[:, 2]).sum() / w.sum())
    return g


ZONES = ['SF-FIELD', 'SF-CORRIDOR', 'SF-ENJU2-UPPER', 'SF-ENJU2-LOWER-0', 'SF-ENJU2-LOWER-1']
feats, lines = [], []
for zid in ZONES:
    f = S[zid]
    ring = f['geometry']['coordinates'][0]
    feats.append({'type': 'Feature', 'properties': {'id': f'CLIP-{zid}', 'type': 'terrain_clip', 'kind': 'clip', 'estimated': True,
                                                    'assumption': f'{zid} 경계 안 렌더 지형을 잘라 보정 면만 보이게 함(표시 전용, DEM 파일·운영 DB 불변)',
                                                    'source': f'field-surfaces-v3.geojson {zid} 경계(S-MAP 메시)'},
                  'geometry': {'type': 'Polygon', 'coordinates': [[[x, y] for x, y, *_ in ring]]}})
    z = zfun(f)
    pts = []
    for (x0, y0, *_), (x1, y1, *_) in zip(ring[:-1], ring[1:]):
        L = float(np.hypot(x1 - x0, y1 - y0))
        n = max(1, int(np.ceil(L / 1.0)))
        for k in range(n):
            t = k / n
            pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    pts.append(pts[0])
    top = [round(z(x, y), 3) for x, y in pts]
    other = [round(dem_bilinear(x, y), 3) for x, y in pts]
    feats.append({'type': 'Feature', 'properties': {'id': f'SKIRT-{zid}', 'type': 'render_connection_face', 'kind': 'skirt', 'estimated': True, 'verifiedWall': False, 'otherZ': other,
                                                    'assumption': '렌더 연결면(옹벽·사면 아님, 검증된 벽 아님): 경계선 ≤1 m 간격마다 보정 면 z와 기존 DEM(쌍선형) z 사이를 잇는 표시용 세로 면. 실제 전이 형상 미측정',
                                                    'source': f'field-surfaces-v3.geojson {zid} z(S-MAP) + DEM 스냅샷 terrain-grid.f32'},
                  'geometry': {'type': 'LineString', 'coordinates': [[round(x, 3), round(y, 3), t] for (x, y), t in zip(pts, top)]}})
    diffs = [abs(a - b) for a, b in zip(top, other)]
    runs, cur = [], None
    for (x, y), d in zip(pts, diffs):
        if d > 3.0:
            cur = cur or [(x, y), (x, y), 0, 0.0]
            cur[1] = (x, y); cur[2] += 1; cur[3] = max(cur[3], d)
        elif cur:
            runs.append(cur); cur = None
    if cur:
        runs.append(cur)
    for r in sorted(runs, key=lambda r: -r[2])[:6]:
        lines.append(f'  재검토 구간 {zid}: ({r[0][0]:.0f},{r[0][1]:.0f})→({r[1][0]:.0f},{r[1][1]:.0f}) {r[2]} m, 높이차 최대 {r[3]:.1f} m')
    lines.append(f'렌더 연결면 SKIRT-{zid}: 점 {len(pts)}, |면−DEM| 중앙 {np.median(diffs):.2f} 최대 {max(diffs):.2f} m')

fc = {'type': 'FeatureCollection', 'name': 'terrain-clip-v1', 'crs': v3['crs'],
      'provenance': {'source': 'frontend/public/corrections/field-surfaces-v3.geojson + docs/audit/m16/preview/data/terrain-grid.f32', 'sha256': hashlib.sha256(grid_raw).hexdigest(),
                     'generator': 'docs/audit/field/terrain_clip_v1.py', 'status': '표시용 국소 대체(추정). DEM 파일·운영 DB 불변'},
      'features': feats}
(OUT / 'terrain-clip-v1.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')

# 관통 셀 → 잘림 구역 안인지
lines.append('관통 셀(DEM 셀 중심 > 면 + 0.3 m): 구역 / 전체 셀 / 관통 / 잘림 구역 안 / 남음')
clip_union = [prep(Polygon([(x, y) for x, y, *_ in S[z]['geometry']['coordinates'][0]]).buffer(0)) for z in ZONES]
for zid in ZONES:
    f = S[zid]
    P = Polygon([(x, y) for x, y, *_ in f['geometry']['coordinates'][0]]).buffer(0)
    z = zfun(f)
    x0, y0, x1, y1 = P.bounds
    n = k = inside = 0
    for x in np.arange(m['originX'] + R * np.ceil((x0 - m['originX']) / R), x1, R):
        for y in np.arange(m['originY'] + R * np.ceil((y0 - m['originY']) / R), y1, R):
            if not P.contains(Point(x, y)):
                continue
            n += 1
            if dem_cell(x, y) - z(x, y) > 0.3:
                k += 1
                inside += any(c.contains(Point(x, y)) for c in clip_union)
    lines.append(f'  {zid}: {n} / {k} / {inside} / {k - inside}')

# 청운관 분리
o = [b for b in json.loads((ROOT / 'docs/audit/m16/preview/data/building-outlines-5186.json').read_text(encoding='utf-8')) if b['name'] == '청운관'][0]
O = shape({'type': 'MultiPolygon', 'coordinates': o['coordinates']})
CAN = shape(S['SF-CHEONGUN-CANOPY']['geometry'])
body = O.difference(Polygon([(x, y) for x, y, *_ in CAN.exterior.coords]).buffer(0.5, join_style=2))  # 지붕 셀 평면이 외곽선에서 0.08 m 떨어져 있어 0.5 m 넓혀 전면까지 열음(가정)
parts = [q for q in getattr(body, 'geoms', [body]) if q.area >= 2.0]  # 2 m² 미만 조각(버퍼 잔여)은 버림
fc2 = {'type': 'FeatureCollection', 'name': 'cheongun-split-v1', 'crs': v3['crs'],
       'provenance': {'source': 'building-outlines-5186.json 청운관 + field-surfaces-v3 SF-CHEONGUN-CANOPY', 'sha256': hashlib.sha256((ROOT / 'docs/audit/m16/preview/data/building-outlines-5186.json').read_bytes()).hexdigest(), 'generator': 'docs/audit/field/terrain_clip_v1.py',
                      'status': '표시용 국소 대체(추정). 원본 scene 자료·운영 DB 불변'},
       'features': [{'type': 'Feature', 'properties': {'id': 'CHEONGUN-BODY', 'type': 'building_override', 'kind': 'override', 'buildingId': '청운관', 'estimated': True,
                                                       'assumption': f'청운관 본체 = 원외곽선 − 돌출 지붕 평면({CAN.area:.1f} m²)을 0.5 m 넓힌 범위(전면 외곽선까지 열기 위한 가정). 본체 높이는 원본 baseM/roofM 유지. 돌출부는 열린 다층(슬래브·기둥 추정)과 빈 공간',
                                                       'source': 'building-outlines-5186 청운관 외곽선, SF-CHEONGUN-CANOPY 평면(S-MAP), 사진23·영상 SKU 02:03'},
                     'geometry': {'type': 'MultiPolygon', 'coordinates': [[[[round(x, 3), round(y, 3)] for x, y in r.coords] for r in [p.exterior, *p.interiors]] for p in parts]}}]}
(OUT / 'cheongun-split-v1.geojson').write_text(json.dumps(fc2, ensure_ascii=False), encoding='utf-8')
lines.append(f'청운관: 원외곽선 {O.area:.1f} m², 돌출부 {O.intersection(CAN).area:.1f} m², 본체 {body.area:.1f} m² ({len(parts)}조각)')
(ROOT / 'docs/audit/field/terrain-clip-checks.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('\n'.join(lines))
