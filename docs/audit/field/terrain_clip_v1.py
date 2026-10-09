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
from shapely.geometry import LineString, Point, Polygon, mapping, shape
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
CAN2 = Polygon([(x, y) for x, y, *_ in CAN.exterior.coords])
# 연속 절단면(추정): 돌출 지붕에 가장 가까운 원외곽선 변의 방향(u)과 법선(n)에 맞춘 직사각형.
# 폭 = 지붕 셀을 u축에 투영한 범위, 깊이 = 외곽선 밖 1 m ~ 지붕 셀의 가장 안쪽까지. 셀 톱니를 그대로 쓰지 않음.
ext = list(O.geoms[0].exterior.coords)
edges = [(ext[k], ext[k + 1]) for k in range(len(ext) - 1)]
(a, b) = min(edges, key=lambda e: LineString([e[0], e[1]]).distance(CAN2))
L = float(np.hypot(b[0] - a[0], b[1] - a[1]))
u = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
n = (-u[1], u[0])
if O.contains(Point(a[0] + (b[0] - a[0]) / 2 + n[0] * 1.0, a[1] + (b[1] - a[1]) / 2 + n[1] * 1.0)) is False:
    n = (-n[0], -n[1])  # 안쪽을 향하게
cs = [((x - a[0]) * u[0] + (y - a[1]) * u[1], (x - a[0]) * n[0] + (y - a[1]) * n[1]) for x, y in CAN2.exterior.coords]
u0, u1 = min(c[0] for c in cs), max(c[0] for c in cs)
v1 = max(c[1] for c in cs)
P = lambda s_, t_: (a[0] + u[0] * s_ + n[0] * t_, a[1] + u[1] * s_ + n[1] * t_)
CUT = Polygon([P(u0, -1.0), P(u1, -1.0), P(u1, v1), P(u0, v1)])
OPEN = O.intersection(CUT)  # 열린 돌출부 범위(원외곽선 안)
body = O.difference(CUT)
parts = list(getattr(body, 'geoms', [body]))
CH_TOP = S['SF-CHEONGUN-CANOPY']['geometry']['coordinates'][0][0][2]
FIELD_Z = S['SF-FIELD']['geometry']['coordinates'][0][0][2]
SRC_C = 'building-outlines-5186 청운관 외곽선 변 방향, SF-CHEONGUN-CANOPY 셀 범위·z(S-MAP), SF-FIELD z; 구조 종류 = 사진16·23, 영상 SKU 02:03·DAKNAT 04:00'
openring = [[round(x, 3), round(y, 3)] for x, y in OPEN.exterior.coords]
feats2 = [{'type': 'Feature', 'properties': {'id': 'CHEONGUN-BODY', 'type': 'building_override', 'kind': 'override', 'buildingId': '청운관', 'estimated': True,
                                             'assumption': f'청운관 본체 = 원외곽선 − 연속 절단 직사각형(전면 변 방향, 폭 {u1 - u0:.1f} m, 깊이 {v1:.1f} m, 추정). 절단 범위 안 원본 세로 벽 제거, 본체 높이는 원본 baseM/roofM 유지',
                                             'source': SRC_C},
           'geometry': {'type': 'MultiPolygon', 'coordinates': [[[[round(x, 3), round(y, 3)] for x, y in r.coords] for r in [p_.exterior, *p_.interiors]] for p_ in parts]}}]
N_LV = 4
for k in range(1, N_LV + 1):
    z = round(FIELD_Z + (CH_TOP - FIELD_Z) * k / N_LV, 2)
    feats2.append({'type': 'Feature', 'properties': {'id': f'EST-CHEONGUN-SLAB-{k}', 'type': 'open_slab', 'kind': 'extrude', 'fromM': round(z - 0.3, 2), 'toM': z, 'estimated': True, **({'replaces': 'SF-CHEONGUN-CANOPY'} if k == N_LV else {}),
                   'assumption': f'수평 슬래브(두께 0.3 m): {N_LV}층 균등 분할 가정, {k}/{N_LV}' + (' = 지붕 높이 163.8' if k == N_LV else '') + '. 평면 = 연속 절단 범위(직선 면), 벽 없음', 'source': SRC_C},
                   'geometry': {'type': 'Polygon', 'coordinates': [openring]}})
for k, s_ in enumerate((u0 + 0.4, (u0 + u1) / 2, u1 - 0.4), 1):
    x, y = P(s_, 0.4)
    feats2.append({'type': 'Feature', 'properties': {'id': f'EST-CHEONGUN-COL-{k}', 'type': 'column', 'kind': 'extrude', 'fromM': FIELD_Z, 'toM': CH_TOP, 'estimated': True,
                   'assumption': '기둥 0.5 m 정사각형, 전면 변을 따라 양끝·가운데 3개(수·위치 미측정, 사진의 열린 기둥 구조만 근거)', 'source': SRC_C},
                   'geometry': {'type': 'Polygon', 'coordinates': [[[round(x + dx, 3), round(y + dy, 3)] for dx, dy in ((-.25, -.25), (.25, -.25), (.25, .25), (-.25, .25), (-.25, -.25))]]}})
fc2 = {'type': 'FeatureCollection', 'name': 'cheongun-split-v1', 'crs': v3['crs'],
       'provenance': {'source': 'building-outlines-5186.json 청운관 + field-surfaces-v3 SF-CHEONGUN-CANOPY', 'sha256': hashlib.sha256((ROOT / 'docs/audit/m16/preview/data/building-outlines-5186.json').read_bytes()).hexdigest(), 'generator': 'docs/audit/field/terrain_clip_v1.py',
                      'status': '표시용 국소 대체(추정). 원본 scene 자료·운영 DB 불변'},
       'features': feats2}
(OUT / 'cheongun-split-v1.geojson').write_text(json.dumps(fc2, ensure_ascii=False), encoding='utf-8')
lines.append(f'청운관: 원외곽선 {O.area:.1f} m², 절단(열린 돌출부) {OPEN.area:.1f} m² (폭 {u1 - u0:.1f} × 깊이 {v1:.1f} m), 본체 {body.area:.1f} m² ({len(parts)}조각, 조각 면적 {[round(q.area, 1) for q in parts]})')
lines.append(f'  지붕 셀 {CAN2.area:.1f} m² 대비: 절단 범위 − 셀 {OPEN.difference(CAN2).area:.1f} m², 셀 − 절단 범위 {CAN2.difference(OPEN).area:.1f} m², 하우스도르프 {OPEN.hausdorff_distance(CAN2):.2f} m')
(ROOT / 'docs/audit/field/terrain-clip-checks.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('\n'.join(lines))
