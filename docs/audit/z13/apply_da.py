"""Z13 후보 다(Claude 결정 2026-10-23): 유담관 옆 차도(주 진입로)의 동쪽 턱 선을 S-MAP 0.5 m 메시의 턱 선대로 옮기고(차도 가운데 선·양쪽 인도·서쪽 화단 띠도 같이),
동쪽 계단식 보도(계단 띠)의 폭을 전방위 사진에서 잰 폭으로. 근거: 볼트 구역 노트 "분수 광장과 주변" Z13 절(관찰 10개 중 다 8 맞음), docs/audit/z13/candidates.py(턱 선 맞춤·잰 폭).
  python -I apply_da.py            DB·네트워크 접근 없음
옮김 dx(y) = kerb_mesh(y) − kerb_now(y)(북좌표 557203.5~557252), 그 밖 8 m 에서 0 으로 줄임. 서쪽(광장·둑, 동좌표 201082 보다 서쪽)은 옮기지 않는다.
쓰는 파일(id 로 고침, 첫 실행의 옛 도형은 z13/base-da.json 에 남김):
  frontend/public/structures/z03-fountain.geojson      Z03-EAST-STAIR-*·Z03-EAST-LANDING-* 를 새 턱 선 + 잰 폭으로 다시 만듦
  frontend/public/structures/z12-yudam-sidewalks.geojson Z12 인도·턱·서쪽 화단 띠 조각을 dx 만큼(꼭짓점마다)
  frontend/public/structures/z13-da.geojson             옛 띠 바깥 선과 새 띠 바깥 선 사이를 채우는 화단 벽(사진: 둥근 화단 코·긴 의자 뒤 벽·바위 발치)
돌리는 차례: z03 → … → z12 → p02 → … → x36 → 이 스크립트."""
import json, math, pathlib, sys
import numpy as np
from shapely.geometry import Polygon, Point, shape, mapping
from shapely.ops import unary_union
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; STR = REPO / 'frontend' / 'public' / 'structures'
sys.path.insert(0, str(HERE.parent / 'z03'))
r2 = lambda v: round(float(v), 2)
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def dump(p, o): p.write_text(json.dumps(o, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
X, Y = 201000.0, 557000.0
D = load(HERE / 'da.json'); A_, B_ = D['a'], D['b']
V2 = np.array([f for f in load(HERE.parent / 'v02' / 'road-profile.geojson')['features'] if f['properties']['id'] == 'V2'][0]['geometry']['coordinates'])
def road_z(y): return float(np.interp(Y + y, V2[:, 1], V2[:, 2]))
def cx(y): return float(np.interp(Y + y, V2[:, 1], V2[:, 0])) - X
def kerb_now(y): return cx(y) + 3.8
def kerb_mesh(y): return A_ * y + B_
RE = [(180, 102.0), (184, 100.0), (188, 98.0), (192, 96.5), (196, 95.5), (200, 94.5), (204, 94.5), (208, 95.5), (212, 94.0), (216, 94.5), (220, 94.0), (224, 94.0), (228, 94.0), (232, 95.0), (236, 95.5), (240, 95.0), (244, 96.0), (248, 97.0), (252, 98.0)]
def out_now(y): return float(np.interp(max(y, 212.0), [a for a, _ in RE], [b for _, b in RE])) + 3.5
def w_meas(y): return float(np.interp(y, D['WY'], D['WW']))
Y0, Y1, TAPER = D['Y_FOOT'], D['Y_TOP'], 8.0
def dx(y):
    if y < Y0 - TAPER or y > Y1 + TAPER: return 0.0
    if y < Y0: return (kerb_mesh(Y0) - kerb_now(Y0)) * (y - (Y0 - TAPER)) / TAPER
    if y > Y1: return (kerb_mesh(Y1) - kerb_now(Y1)) * ((Y1 + TAPER) - y) / TAPER
    return kerb_mesh(y) - kerb_now(y)
X_FIX = 82.0   # 이보다 서쪽(광장·둑)은 옮기지 않음
def warp(x, y):   # 절대 좌표
    xl, yl = x - X, y - Y
    return (x + dx(yl), y) if xl >= X_FIX else (x, y)
def warp_poly(g):
    g = shape(g)
    if g.geom_type == 'Polygon':
        return Polygon([warp(*p) for p in g.exterior.coords], [[warp(*p) for p in i.coords] for i in g.interiors])
    return unary_union([Polygon([warp(*p) for p in q.exterior.coords]) for q in g.geoms])
def ring(pts):
    p = [[r2(x), r2(y)] for x, y in pts]
    if Polygon(p).exterior.is_ccw is False: p = p[::-1]
    return p + [p[0]]
def geom(poly):
    poly = poly.buffer(0)
    if poly.geom_type != 'Polygon': poly = max(poly.geoms, key=lambda q: q.area)
    return {'type': 'Polygon', 'coordinates': [ring(list(poly.exterior.coords)[:-1])] + [ring(list(i.coords)[:-1]) for i in poly.interiors]}
BASEF = HERE / 'base-da.json'
Z03, Z12 = load(STR / 'z03-fountain.geojson'), load(STR / 'z12-yudam-sidewalks.geojson')
if not BASEF.exists():
    dump(BASEF, {'z03': [f for f in Z03['features'] if f['properties']['id'].startswith(('Z03-EAST-STAIR-', 'Z03-EAST-LANDING-'))],
                 'z12': {f['properties']['id']: f['geometry'] for f in Z12['features']}})
BASE = load(BASEF)
NOTE = ' [Z13 다 2026-10-23: 턱 선을 메시대로(차도·인도 함께 dx 옮김), 계단 띠 폭 = 잰 폭]'
# ---- Z12: 꼭짓점마다 dx ----
for f in Z12['features']:
    i = f['properties']['id']
    g0 = BASE['z12'][i]
    f['geometry'] = geom(warp_poly(g0))
    if NOTE not in f['properties'].get('assumption', ''): f['properties']['assumption'] = f['properties'].get('assumption', '').split(' [Z13 다')[0] + NOTE
# ---- 계단 띠: 새 턱 선(kerb_mesh) ~ 턱 + 잰 폭 ----
old_band = unary_union([shape(f['geometry']).buffer(0) for f in BASE['z03']])
NR, RUN, NF = 6, 0.35, 7
RISE = (road_z(Y1) - road_z(Y0)) / (NF * NR)
def kerb_(y): return kerb_mesh(y)
def out_(y): return kerb_mesh(y) + w_meas(y)
P = lambda lst: Polygon([(X + a, Y + b) for a, b in lst])
grid_y = np.arange(195, 262, 0.05); grid_z = np.array([road_z(v) for v in grid_y])
new = []; old_by = {f['properties']['id']: f for f in BASE['z03']}
y = Y0
for k in range(1, NF + 1):
    base = road_z(y)
    for s in range(NR):
        ya, yb = y + s * RUN, y + (s + 1) * RUN; fid = f'Z03-EAST-STAIR-F{k}-S{s + 1:02d}'
        f = json.loads(json.dumps(old_by[fid])); f['geometry'] = geom(P([(kerb_(ya), ya), (out_(ya), ya), (out_(yb), yb), (kerb_(yb), yb)]))
        f['properties'].update({'fromM': r2(base - 0.1), 'toM': r2(base + (s + 1) * RISE), 'widthM': r2(out_(ya) - kerb_(ya))}); f['properties']['assumption'] = f['properties']['assumption'].split(' [Z13 다')[0] + NOTE
        new.append(f)
    top = base + NR * RISE; y1 = y + NR * RUN
    y2 = Y1 if k == NF else float(np.interp(top, grid_z, grid_y))
    fid = f'Z03-EAST-LANDING-{k}'; f = json.loads(json.dumps(old_by[fid])); f['geometry'] = geom(P([(kerb_(y1), y1), (out_(y1), y1), (out_(y2), y2), (kerb_(y2), y2)]))
    f['properties'].update({'fromM': r2(base - 0.1), 'toM': r2(top)}); f['properties']['assumption'] = f['properties']['assumption'].split(' [Z13 다')[0] + NOTE
    new.append(f); y = y2
Z03['features'] = [f for f in Z03['features'] if not f['properties']['id'].startswith(('Z03-EAST-STAIR-', 'Z03-EAST-LANDING-'))] + new
dump(STR / 'z03-fountain.geojson', Z03); dump(STR / 'z12-yudam-sidewalks.geojson', Z12)
# ---- 옛 띠 바깥 쪽 남는 자리: 화단 벽(2 m 마디, 윗면 = 그 자리 새 띠 윗면 + 0.5) ----
new_band = unary_union([shape(f['geometry']).buffer(0) for f in new])
others = []
for fn in STR.glob('*.geojson'):
    if fn.name in ('z03-fountain.geojson', 'z12-yudam-sidewalks.geojson', 'z13-da.geojson'): continue
    for f in load(fn)['features']:
        p = f['properties']
        if f.get('geometry') and p.get('kind') == 'extrude' and not p.get('underground') and not p.get('inVoid'):
            g = shape(f['geometry']).buffer(0)
            if g.intersects(old_band.buffer(1.0)): others.append(g)
z12u = unary_union([shape(f['geometry']).buffer(0) for f in Z12['features']])
rest = old_band.difference(new_band.buffer(0.02)).difference(unary_union(others).buffer(0.02) if others else Polygon()).difference(z12u.buffer(0.02))
feats = []
for k, ys in enumerate(np.arange(Y0, Y1, 2.0)):
    part = rest.intersection(Polygon([(X + 70, Y + ys), (X + 110, Y + ys), (X + 110, Y + ys + 2.0), (X + 70, Y + ys + 2.0)])).buffer(-0.05).buffer(0.05)
    if part.is_empty or part.area < 0.3: continue
    tops = [f['properties']['toM'] for f in new if shape(f['geometry']).intersects(Polygon([(X + 70, Y + ys), (X + 110, Y + ys), (X + 110, Y + ys + 2.0), (X + 70, Y + ys + 2.0)]))]
    zt = (max(tops) if tops else road_z(ys + 1)) + 0.5
    for j, q in enumerate([part] if part.geom_type == 'Polygon' else list(part.geoms)):
        if q.area < 0.3: continue
        feats.append({'type': 'Feature', 'properties': {'id': f'Z13-BAND-OUTER-BED-{k + 1:02d}-{j + 1}', 'type': 'planter', 'kind': 'extrude', 'estimated': True,
            'grade': 'Claude 결정 2026-10-23(Z13 다), 사진(잰 폭의 바깥 = 화단 코·긴 의자 뒤 벽·바위 발치), 추정(윗면 = 띠 + 0.5 m)', 'basePlane': 'Z03-ROAD-B' if ys >= 214 else 'Z03-ROAD-A',
            'fromM': r2(road_z(ys) - 0.3), 'toM': r2(zt), 'color': '#cfc8b8', 'topColor': '#6f8a55',
            'assumption': '계단 띠를 잰 폭으로 줄인 뒤 옛 바깥 선까지 남는 자리: 화강석 턱 화단(사진 08~10 의 둥근 화단·벽 발치)', 'source': '네이버 전방위 사진 08~10(z13), 구역 노트 분수 광장과 주변 Z13'}, 'geometry': geom(q)})
dump(STR / 'z13-da.geojson', {'type': 'FeatureCollection', 'name': 'z13-da', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
  'provenance': {'builder': 'docs/audit/z13/apply_da.py', 'schema': 'docs/audit/g02/STRUCTURES.md'}, 'features': feats})
json.dump({'dx': {str(y): r2(dx(y)) for y in (195.5, 203.5, 213, 224, 235, 246, 252, 260)}, 'width': {str(y): r2(w_meas(y)) for y in (203.5, 213, 224, 235, 246, 252)}, 'fill': len(feats)},
          open(HERE / 'model-da.json', 'w', encoding='utf-8'), indent=1)
print('band', len(new), 'fill', len(feats), {y: r2(dx(y)) for y in (203.5, 224, 252)})
