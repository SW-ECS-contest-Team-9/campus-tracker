"""Z13: 정문 ~ 북좌표 557180 의 차도 양쪽 인도를 Z12 방식(길과 같이 오르는 기운 판)으로 다시 만든다. DB·네트워크 접근 없음.
  python -X utf8 sidewalks.py
쓰는 파일:
  frontend/public/structures/z13-gate-sidewalks.geojson   인도·경계석·화단(형식은 docs/audit/g02/STRUCTURES.md)
  frontend/public/structures/n03b-sidewalks.geojson       이 구간의 N03b 평평한 마디 상자(W00~W14, E00~E13)를 걷는다(다시 돌려도 같다)
  docs/audit/z13/model.json                               치수 요약
위쪽 끝은 Z12 인도 판의 아래 끝(z12-yudam-sidewalks.geojson 에서 읽음)이다. 기단·지형·길은 건드리지 않는다.
폭·자리는 네이버 전방위 사진(같은 주행 2026-02-11, 정문길-113 ~ 171)의 옆면에서 잰 값이다(추정 ±0.4 m, 카메라 높이 2.45 m 로 봄)."""
import json, math, pathlib
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape, box as sbox
from shapely.ops import unary_union
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
load = lambda fn: json.loads((STR / fn).read_text(encoding='utf-8'))
prof_ = {f['properties']['id']: np.array(f['geometry']['coordinates']) for f in json.loads((HERE.parent / 'v02' / 'road-profile.geojson').read_text(encoding='utf-8'))['features'] if f['geometry']['type'] == 'LineString'}
CL = np.vstack([prof_['V1'], prof_['V2'][1:]])            # 차도 가운데 선과 종단(V02): 정문 진입로 + 주 진입로
CUM = np.r_[0, np.cumsum(np.hypot(*np.diff(CL[:, :2], axis=0).T))]; LINE = LineString(CL[:, :2])
def P(s): return np.array([np.interp(s, CUM, CL[:, 0]), np.interp(s, CUM, CL[:, 1])])
def Z(s): return float(np.interp(s, CUM, CL[:, 2]))
def T(s): d = P(min(s + 0.5, CUM[-1])) - P(max(s - 0.5, 0)); return d / np.hypot(*d)
def off(s, d): t = T(s); return P(s) + d * np.array([-t[1], t[0]])   # d > 0 = 진행 방향 왼쪽(서쪽), d < 0 = 동쪽
def st(x, y): return LINE.project(Point(x, y))
def S_Y(y): return st(float(np.interp(y, CL[:, 1], CL[:, 0])), y)     # 북좌표 → 거리(이 구간은 북으로 오른다)

KERB, EDGE, H_KERB, STEP = 3.5, 0.2, 0.15, 2.0     # Z12 와 같음: 가운데 선에서 턱까지, 경계석 줄 폭, 턱 높이(추정), 마디
W_W = 1.5                                           # 서쪽 인도 폭(Z12 와 같음)
E_W = [(557104.5, 3.3), (557152.0, 3.3), (557162.0, 2.6), (557176.0, 2.6)]   # 동쪽 인도 폭(북좌표, m): 사진 113~152 는 3.1~3.5, 162·171 은 2.5~2.6. 맨 위는 Z12 의 3.0 에 잇는다
Y_W0 = 557141.0                                     # 서쪽 인도의 아래 끝: 제1주차장 차로와 갈리는 쐐기 화단의 끝(사진 142·152, ±4 m). 그 아래는 인도 없는 아스팔트 어귀
Y_PL0, PL1, PL2 = 557137.0, 1.0, 2.0                # 동쪽 화단: 아래 끝(사진 133 의 둥근 끝, ±3 m), 아랫단 깊이, 윗단 깊이(추정)
ROCK_W, ROCK_H, BED_W, BED_H = 0.4, 0.45, 1.0, 0.3  # 서쪽 인도 뒤 막돌 줄과 화단 흙(Z12 와 같은 치수, 흙 띠 깊이는 추정)
C_WALK_W, C_WALK_E, C_KERB = '#b0a79d', '#c9bca8', '#d2cfc6'
SRC = '네이버 전방위 사진 정문길-113·123·133·142·152·162·12(사용자-네이버거리뷰-20261012, 2026-02-11 주행의 면 전체), docs/audit/v02 종단'

z12 = {f['properties']['id']: f for f in load('z12-yudam-sidewalks.geojson')['features']}
S_W1 = st(*z12['Z12-SIDEWALK-W-01']['properties']['topProfile']['origin']); S_E1 = st(*z12['Z12-SIDEWALK-E-01']['properties']['topProfile']['origin'])
S_E0, S_W0 = S_Y(E_W[0][0]), S_Y(Y_W0)
ES = [S_Y(y) for y, _ in E_W] + [S_E1]; EW = [w for _, w in E_W] + [3.0]
def w_e(s): return float(np.interp(s, ES, EW))

# --- N03b 마디 상자: 이 구간(Z12 아래) 것을 걷는다
n03 = load('n03b-sidewalks.geojson'); keep = []
for f in n03['features']:
    c = shape(f['geometry']).centroid
    if f['properties']['id'].startswith('N03B-SIDEWALK-') and LINE.distance(c) < 6 and st(c.x, c.y) < max(S_W1, S_E1): continue
    keep.append(f)
removed = len(n03['features']) - len(keep); n03['features'] = keep
n03['provenance']['z13'] = '정문 ~ 북좌표 557180 구간은 Z13 이 기운 판으로 다시 만들어 여기서 뺐다(docs/audit/z13/sidewalks.py)'
(STR / 'n03b-sidewalks.geojson').write_text(json.dumps(n03, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')

others = [(f['properties']['id'], shape(f['geometry']).buffer(0), f['properties']) for fn in sorted(p.name for p in STR.glob('*.geojson')) if not fn.startswith(('z13-', 'n03b-'))
          for f in load(fn)['features'] if f['geometry']['type'] == 'Polygon' and f['properties'].get('kind') == 'extrude']
feats = []; hits = set()
def band(s0, s1, d0, d1):
    ss = np.r_[np.arange(s0, s1 - 1e-6, 0.5), s1]; f0, f1 = (d if callable(d) else (lambda s, d=d: d) for d in (d0, d1))
    return Polygon([tuple(off(s, f0(s))) for s in ss] + [tuple(off(s, f1(s))) for s in ss[::-1]]).buffer(0)
def slab(id, typ, s0, s1, d0, d1, dz, thick, what, grade, cut=None, **extra):
    """길과 같이 오르는 기운 판: 가운데 선 거리 s0~s1, 옆 거리 d0~d1(수 또는 s 의 함수), 윗면 = 차도 종단 + dz. STEP 마디마다 한 조각."""
    n = max(1, int(math.ceil((s1 - s0) / STEP))); k = 0
    for i in range(n):
        a, b = s0 + (s1 - s0) * i / n, s0 + (s1 - s0) * (i + 1) / n
        g = band(a, b, d0, d1)
        if cut is not None: g = g.difference(cut)
        for q in (g.geoms if hasattr(g, 'geoms') else [g]):
            if q.geom_type != 'Polygon' or q.area < 0.05: continue
            k += 1; o, e = P(a), P(b); L = float(np.hypot(*(e - o))); d = (e - o) / L
            ring = [[r2(x), r2(y)] for x, y in q.exterior.coords]; ring[-1] = ring[0]
            feats.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [ring]}, 'properties': {
                'id': f'{id}-{k:02d}', 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': '차도 포장 띠(V02 종단)',
                'fromM': r2(Z(a) + dz - thick), 'toM': r2(max(Z(a), Z(b)) + dz), 'topProfile': {'origin': [r2(o[0]), r2(o[1])], 'direction': [round(float(d[0]), 4), round(float(d[1]), 4)], 'points': [[0.0, r2(Z(a) + dz)], [r2(L), r2(Z(b) + dz)]]},
                'thicknessM': thick, 'assumption': what, 'source': SRC, **extra}})
    return k
def obstacles(reach, types=('planter', 'wall', 'tree')):
    hit = [(i, g) for i, g, p in others if p.get('type') in types and g.intersects(reach) and g.intersection(reach).area > 0.02]
    hits.update(i for i, _ in hit); return unary_union([g for _, g in hit]) if hit else None

G_E = '원천(네이버 전방위 사진: 턱 있는 넓은 블록 포장 인도가 정문에서 끊김 없이 오른다), 추정(폭 ±0.4 m·턱 높이)'
G_W = '원천(네이버 전방위 사진: 쐐기 화단 끝에서 시작해 옹벽 발치를 따라 오르는 좁은 인도), 추정(아래 끝 ±4 m·폭·턱 높이)'
dE = lambda s: -KERB - w_e(s)
cutE = obstacles(band(S_E0, S_E1, dE, -KERB))
nE = slab('Z13-SIDEWALK-E', 'landing', S_E0, S_E1, -KERB - EDGE, dE, H_KERB, H_KERB + 0.15, f'수인관 쪽 인도: 차도보다 {H_KERB} m 높은 턱, 폭 3.3 m(북좌표 557152 까지) → 2.6 m(557162~557176) → 3.0 m(Z12 인도에 이음), 길과 같은 기울기의 한 판. 평평한 단이 아니다', G_E, cut=cutE, color=C_WALK_E, material='paving')
slab('Z13-KERB-E', 'wall', S_E0, S_E1, -KERB, -KERB - EDGE, H_KERB + 0.01, H_KERB + 0.16, '수인관 쪽 인도의 밝은 화강석 경계석 줄', G_E, cut=cutE, color=C_KERB)
cutW = obstacles(band(S_W0, S_W1, KERB, KERB + W_W + ROCK_W + BED_W))
nW = slab('Z13-SIDEWALK-W', 'landing', S_W0, S_W1, KERB + EDGE, KERB + W_W, H_KERB, H_KERB + 0.15, f'옹벽 쪽 인도: 차도보다 {H_KERB} m 높은 턱, 폭 {W_W} m, 길과 같은 기울기로 Z12 인도에 끊김 없이 이어진다. 북좌표 {Y_W0:.0f} 아래(주차장 차로 어귀)에는 인도가 없다', G_W, cut=cutW, color=C_WALK_W, material='paving')
slab('Z13-KERB-W', 'wall', S_W0, S_W1, KERB, KERB + EDGE, H_KERB + 0.01, H_KERB + 0.16, '옹벽 쪽 인도의 밝은 화강석 경계석 줄', G_W, cut=cutW, color=C_KERB)
# 서쪽 인도 뒤: 막돌 한 줄과 화단 흙 띠(사진 152·162·12). Z12 의 막돌 줄(북좌표 557186 부터)까지 잇는다
s_r0, s_r1 = S_Y(557158.0), S_Y(557186.0)
slab('Z13-ROCKEDGE-W', 'wall', s_r0, s_r1, KERB + W_W, KERB + W_W + ROCK_W, ROCK_H, ROCK_H + 0.15, f'옹벽 쪽 인도 바로 뒤의 막돌 줄(높이 약 {ROCK_H} m). 낱돌은 나누지 않았다', '원천(사진 152·162·12), 추정(치수·아래 끝)', cut=cutW, material='stone', color='#8f8a80')
slab('Z13-BED-W', 'planter', s_r0, s_r1, KERB + W_W + ROCK_W, KERB + W_W + ROCK_W + BED_W, BED_H, BED_H + 0.15, f'막돌 줄 뒤의 화단 흙 띠(깊이 {BED_W} m 추정): 짙은 돌 옹벽 발치', '원천(사진 152·162·12), 추정(치수)', cut=cutW, color='#8a7d5a')
# 동쪽 인도 뒤: 거친 화강석 블록 화단 두 단과 소나무(수인관 기둥 면 앞). 사진 133(둥근 아래 끝) ~ 12
G_P = '원천(사진 133~12: 인도 뒤에 거친 화강석 블록 화단 두 단, 위에 소나무와 바위), 추정(단 높이 0.5 m 씩·깊이·아래 끝 ±3 m)'
s_p0 = S_Y(Y_PL0); d1 = lambda s: dE(s) - PL1; d2 = lambda s: dE(s) - PL1 - PL2
cutP = obstacles(band(s_p0, S_E1, d2, dE))
nP = slab('Z13-PLANTER-E-LOW', 'planter', s_p0, S_E1, dE, d1, 0.5, 0.65, '수인관 쪽 화단의 아랫단(인도 위 약 0.35 m, 차도 위 0.5 m)', G_P, cut=cutP, material='white_stone')
slab('Z13-PLANTER-E-UP', 'planter', s_p0 + 1.0, S_E1, d1, d2, 1.0, 1.15, '수인관 쪽 화단의 윗단(차도 위 1.0 m). 뒤쪽 끝(건물 쪽)은 추정', G_P, cut=cutP, material='white_stone')
def tree(tid, s, d, k=0.8):
    c = off(s, d); z = Z(s) + 1.0; sq = lambda h: Polygon([(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)])
    for part, mat, h, z0, z1 in (('TRUNK', 'trunk', 0.15, 0.0, 2.2), ('CROWN', 'foliage', 1.1, 2.0, 3.2), ('TOP', 'foliage', 0.6, 3.2, 4.0)):
        ring = [[r2(x), r2(y)] for x, y in sq(h * k).exterior.coords]
        feats.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [ring]}, 'properties': {'id': f'{tid}-{part}', 'type': 'tree', 'kind': 'extrude', 'estimated': True, 'grade': G_P, 'basePlane': 'Z13-PLANTER-E-UP',
                      'fromM': r2(z + z0 * k), 'toM': r2(z + z1 * k), 'assumption': '단순한 나무(소나무 자리. 실제 그루 수·모양이 아니다)', 'source': SRC, 'material': mat}})
trees = [s for s in np.arange(s_p0 + 4.0, S_E1 - 1.0, 9.0)]
for j, s in enumerate(trees):
    if cutP is None or not cutP.intersects(Point(off(s, d1(s) - PL2 / 2)).buffer(0.9)): tree(f'Z13-PLANTER-E-PINE-{j + 1}', s, d1(s) - PL2 / 2)

fc = {'type': 'FeatureCollection', 'name': 'z13-gate-sidewalks', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
      'provenance': {'builder': 'docs/audit/z13/sidewalks.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '기단·지형·길은 그대로. 인도는 차도 포장 띠 위에 얹은 기운 판이다. 북쪽은 z12-yudam-sidewalks.geojson 으로 이어진다'}, 'features': feats}
(STR / 'z13-gate-sidewalks.geojson').write_text(json.dumps(fc, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
yx = lambda s: [r2(v) for v in P(s)]
model = {'crs': 'EPSG:5186', 'kerbOffsetM': KERB, 'kerbHeightM': H_KERB, 'n03bRemoved': removed, 'features': len(feats), 'cutAround': sorted(hits),
         'east': {'fromCentre': yx(S_E0), 'toCentre': yx(S_E1), 'lengthM': r2(S_E1 - S_E0), 'widthM': [[y, w] for y, w in E_W] + [[r2(P(S_E1)[1]), 3.0]], 'fromM': r2(Z(S_E0) + H_KERB), 'toM': r2(Z(S_E1) + H_KERB), 'pieces': nE},
         'west': {'fromCentre': yx(S_W0), 'toCentre': yx(S_W1), 'lengthM': r2(S_W1 - S_W0), 'widthM': W_W, 'fromM': r2(Z(S_W0) + H_KERB), 'toM': r2(Z(S_W1) + H_KERB), 'pieces': nW},
         'eastPlanter': {'lengthM': r2(S_E1 - s_p0), 'lowM': 0.5, 'upM': 1.0, 'depthM': [PL1, PL2], 'pieces': nP}}
(HERE / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('removed n03b', removed, 'features', len(feats)); print(json.dumps(model, ensure_ascii=False))
