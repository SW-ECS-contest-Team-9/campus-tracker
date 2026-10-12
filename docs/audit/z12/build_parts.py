"""Z12: 유담관 옆 차도(북좌표 557180 ~ 굽이)의 양쪽 인도를 거리뷰 Y02~Y08 과 사용자 그림 12 대로 다시 만든다. DB·네트워크 접근 없음.
  python -X utf8 build_parts.py
쓰는 파일:
  frontend/public/structures/z12-yudam-sidewalks.geojson   길과 같이 오르는 기운 판(인도·경계석·막돌 줄·화단 띠). 형식은 docs/audit/g02/STRUCTURES.md
  frontend/public/structures/n03b-sidewalks.geojson         이 구간의 N03b 평평한 마디 상자를 걷어 낸다(다시 돌려도 같다)
  docs/audit/z12/model.json                                 치수 요약, 계단 길의 꼭짓점
동쪽 계단 띠는 docs/audit/z03/build_inputs.py 가 만든다(먼저 돌릴 것). 지형 입력은 건드리지 않는다(기단 그대로, 판만 얹음).
사용자 확정(2026-10-12): 왼쪽(서쪽)은 짧게 올라온 단이 아니라 굽이까지 이어지는 인도, 오른쪽은 계단 형상이 아래 끝까지 이어짐. 폭·턱 높이·화단 띠는 거리뷰 눈대중(추정)."""
import json, math, pathlib
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape, box as sbox
from shapely.ops import unary_union
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
load = lambda fn: json.loads((STR / fn).read_text(encoding='utf-8'))
prof_ = {f['properties']['id']: np.array(f['geometry']['coordinates']) for f in json.loads((HERE.parent / 'v02' / 'road-profile.geojson').read_text(encoding='utf-8'))['features'] if f['geometry']['type'] == 'LineString'}
CL = np.vstack([prof_['V2'], prof_['V3'][1:8]])           # 차도 가운데 선과 종단(V02): 분수 광장 옆 ~ 굽이 ~ 굽이 위 조금
CUM = np.r_[0, np.cumsum(np.hypot(*np.diff(CL[:, :2], axis=0).T))]; LINE = LineString(CL[:, :2])
def P(s): return np.array([np.interp(s, CUM, CL[:, 0]), np.interp(s, CUM, CL[:, 1])])
def Z(s): return float(np.interp(s, CUM, CL[:, 2]))
def T(s): d = P(min(s + 0.5, CUM[-1])) - P(max(s - 0.5, 0)); return d / np.hypot(*d)
def off(s, d): t = T(s); return P(s) + d * np.array([-t[1], t[0]])   # d > 0 = 진행 방향 왼쪽(서쪽), d < 0 = 동쪽
def st(x, y): return LINE.project(Point(x, y))
def S_Y(y): return st(float(np.interp(y, prof_['V2'][:, 1], prof_['V2'][:, 0])), y)      # 북좌표 → 거리(V2 구간은 북으로 오른다)

KERB, EDGE = 3.5, 0.2      # 가운데 선에서 턱까지(N03b 와 같음), 경계석 줄 폭
W_W, W_E = 1.5, 3.0        # 서쪽 인도 폭(거리뷰 Y03: 약 1.3 m, 시험용 DB 인도 길 폭 1.5 m 에 맞춤), 동쪽 아랫구간 인도 폭(Y02: 약 3 m)
H_KERB = 0.15              # 턱 높이(추정 0.12~0.20)
ROCK_W, ROCK_H, BED_H = 0.4, 0.45, 0.3   # 서쪽 인도 뒤 막돌 줄과 화단 흙(차도보다)
STEP = 2.0
C_WALK_W, C_WALK_E, C_KERB = '#b0a79d', '#c9bca8', '#d2cfc6'   # 서쪽 회색 벽돌 블록, 동쪽 밝은 돌 포장, 밝은 화강석 경계석(Y02~Y05)
SRC = '거리뷰 Y02~Y08(streetview-yudam-approach-202602), 사용자 그림 12(사용자-청운관현관·은주1관돌계단-20261012), docs/audit/v02 종단'

# --- N03b 마디 상자: 이 구간 것을 걷고, 남은 이웃의 끝에서 새 판을 시작·끝낸다
S_LO = S_Y(557180.0); S_HI = CUM[len(prof_['V2']) - 1] + 2.0
n03 = load('n03b-sidewalks.geojson'); keep = []; ends = {'W': [0.0, CUM[-1]], 'E': [0.0, CUM[-1]]}
for f in n03['features']:
    g = shape(f['geometry']); side = f['properties']['id'].split('-')[-1][0]; c = g.centroid
    if LINE.distance(c) > 6: keep.append(f); continue
    ss = [st(x, y) for x, y in g.exterior.coords]; sc = st(c.x, c.y)
    if S_LO <= sc <= S_HI: continue
    keep.append(f)
    if sc < S_LO: ends[side][0] = max(ends[side][0], max(ss))
    else: ends[side][1] = min(ends[side][1], min(ss))
removed = len(n03['features']) - len(keep); n03['features'] = keep
n03['provenance']['z12'] = '유담관 옆 구간(북좌표 557180 ~ 굽이)은 Z12 가 기운 판으로 다시 만들어 여기서 뺐다(docs/audit/z12/build_parts.py)'
(STR / 'n03b-sidewalks.geojson').write_text(json.dumps(n03, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')

z03 = {f['properties']['id']: f for f in load('z03-fountain.geojson')['features']}
z3m = json.loads((HERE.parent / 'z03' / 'model.json').read_text(encoding='utf-8'))['eastStair']['flights']
def PLAT(*names): return unary_union([shape(z03['Z03-PLATFORM-' + n]['geometry']).buffer(0) for n in names])
HIGH_W = PLAT('PLAZA', 'BANK-S', 'BANK-N-LOW', 'BANK-N-UP', 'TERRACE-S')      # 서쪽 인도 뒤의 더 높은 땅(둑·광장): 화단 띠는 그 앞까지만
ROADBAND = PLAT('ROAD-A', 'ROAD-B')
others = [(f['properties']['id'], shape(f['geometry']).buffer(0), f['properties']) for fn in sorted(p.name for p in STR.glob('*.geojson')) if not fn.startswith(('z12-', 'n03b-'))
          for f in load(fn)['features'] if f['geometry']['type'] == 'Polygon' and f['properties'].get('kind') == 'extrude']

feats = []
def band(s0, s1, d0, d1):
    ss = np.r_[np.arange(s0, s1 - 1e-6, 0.5), s1]
    return Polygon([tuple(off(s, d0)) for s in ss] + [tuple(off(s, d1)) for s in ss[::-1]]).buffer(0)
def slab(id, typ, s0, s1, d0, d1, dz, thick, what, grade, clip=None, cut=None, **extra):
    """길과 같이 오르는 기운 판: 가운데 선 거리 s0~s1, 옆 거리 d0~d1, 윗면 = 차도 종단 + dz. STEP 마디마다 한 조각(조각 안은 곧은 경사)."""
    n = max(1, int(math.ceil((s1 - s0) / STEP))); k = 0; area = 0.0
    for i in range(n):
        a, b = s0 + (s1 - s0) * i / n, s0 + (s1 - s0) * (i + 1) / n
        g = band(a, b, d0, d1)
        if clip is not None: g = g.intersection(clip)
        if cut is not None: g = g.difference(cut)
        for q in (g.geoms if hasattr(g, 'geoms') else [g]):
            if q.geom_type != 'Polygon' or q.area < 0.05: continue
            k += 1; area += q.area; o, e = P(a), P(b); L = float(np.hypot(*(e - o))); d = (e - o) / L
            ring = [[r2(x), r2(y)] for x, y in q.exterior.coords]; ring[-1] = ring[0]
            feats.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [ring]}, 'properties': {
                'id': f'{id}-{k:02d}', 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': '차도 포장 띠(V02 종단)',
                'fromM': r2(Z(a) + dz - thick), 'toM': r2(Z(b) + dz), 'topProfile': {'origin': [r2(o[0]), r2(o[1])], 'direction': [round(float(d[0]), 4), round(float(d[1]), 4)], 'points': [[0.0, r2(Z(a) + dz)], [r2(L), r2(Z(b) + dz)]]},
                'thicknessM': thick, 'assumption': what, 'source': SRC, **extra}})
    return k, area

G_W = '확정(굽이까지 이어지는 인도: 사용자 2026-10-12), 추정(폭·턱 높이)'
sw0, sw1 = ends['W']; se0, se1 = ends['E']
ENTRY = sbox(201080.0, 557216.6, 201086.2, 557220.6)    # 분수 광장 출입 자리(붉은 말뚝): 화단 띠·막돌 줄을 비운다
nW, aW = slab('Z12-SIDEWALK-W', 'landing', sw0, sw1, KERB + EDGE, KERB + W_W, H_KERB, H_KERB + 0.15, f'유담관 쪽 인도: 차도보다 {H_KERB} m 높은 턱, 폭 {W_W} m, 길과 같은 기울기로 끊김 없이 굽이까지. 계단이 아니다', G_W, color=C_WALK_W, material='paving')
slab('Z12-KERB-W', 'wall', sw0, sw1, KERB, KERB + EDGE, H_KERB + 0.01, H_KERB + 0.16, '유담관 쪽 인도의 밝은 화강석 경계석 줄', G_W, color=C_KERB)
# 인도 뒤: 막돌 한 줄 + 화단 흙 띠(거리뷰 Y02~Y06). 둑·광장 기단 앞까지만, 출입 자리는 비움
sr0, sr1 = S_Y(557186.0), S_Y(557252.0)
cutW = unary_union([HIGH_W, ENTRY])
slab('Z12-ROCKEDGE-W', 'wall', sr0, sr1, KERB + W_W, KERB + W_W + ROCK_W, ROCK_H, ROCK_H + 0.15, f'유담관 쪽 인도 바로 뒤의 막돌 줄(높이 약 {ROCK_H} m). 낱돌은 나누지 않았다', '원천(거리뷰), 추정(치수)', clip=ROADBAND, cut=cutW, material='stone', color='#8f8a80')
slab('Z12-BED-W', 'planter', sr0, sr1, KERB + W_W + ROCK_W, 9.0, BED_H, BED_H + 0.15, '막돌 줄 뒤의 화단 흙 띠: 둑·광장 기단 앞까지(전에는 포장으로 비어 있던 띠)', '원천(거리뷰), 추정(치수)', clip=ROADBAND, cut=cutW, color='#8a7d5a')
# 동쪽 아랫구간: 계단 첫 단 아래는 길과 같이 오르는 넓은 돌 포장 인도
foot = z3m[0]; top = z3m[-1]
s_foot = S_Y(557000 + foot['y0']); s_top = S_Y(557000 + top['landingTo'])
reach = band(se0, s_foot, -KERB - 8, -KERB)
obst = unary_union([g for i, g, p in others if not i.startswith('Z03-EAST') and p.get('type') in ('planter', 'wall', 'tree') and g.intersects(reach)] or [Point(0, 0).buffer(0.01)])
G_E = '원천(거리뷰 Y02), 추정(폭·턱 높이)'
Y_FOOT, Y_TOP = 557000 + foot['y0'], 557000 + top['landingTo']   # 계단 띠의 아래·위 끝은 동서로 곧은 선이다(z03): 인도 판을 그 선에서 자른다
nE, aE = slab('Z12-SIDEWALK-E', 'landing', se0, s_foot + 1.5, -KERB - EDGE, -KERB - W_E, H_KERB, H_KERB + 0.15, f'바위 정원 쪽 아랫구간 인도: 계단 첫 단 아래. 차도보다 {H_KERB} m 높은 턱, 폭 {W_E} m, 길과 같은 기울기(계단 아님)', G_E, clip=sbox(201000, 557000, 201200, Y_FOOT), cut=obst, color=C_WALK_E, material='paving')
slab('Z12-KERB-E', 'wall', se0, s_top, -KERB, -KERB - EDGE, H_KERB + 0.01, H_KERB + 0.16, '바위 정원 쪽 경계석 줄: 아랫구간 인도와 계단 띠의 차도 쪽 가장자리', G_E, color=C_KERB)
# 계단 띠 위 ~ 굽이: 좁은 인도
nE2, aE2 = slab('Z12-SIDEWALK-E-UP', 'landing', s_top - 1.5, se1, -KERB - EDGE, -KERB - W_W, H_KERB, H_KERB + 0.15, f'계단 띠 위에서 굽이까지의 인도(폭 {W_W} m, 턱 {H_KERB} m)', '확정(양쪽 인도: 사용자 2026-10-11), 추정(자리·폭)', clip=sbox(201000, Y_TOP, 201200, 558000), color=C_WALK_E, material='paving')
slab('Z12-KERB-E-UP', 'wall', s_top, se1, -KERB, -KERB - EDGE, H_KERB + 0.01, H_KERB + 0.16, '굽이 쪽 경계석 줄', G_E, color=C_KERB)

fc = {'type': 'FeatureCollection', 'name': 'z12-yudam-sidewalks', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
      'provenance': {'builder': 'docs/audit/z12/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '기단·지형은 그대로. 인도는 차도 포장 띠 위에 얹은 기운 판이다. 동쪽 계단 띠는 z03-fountain.geojson 의 Z03-EAST-*'}, 'features': feats}
(STR / 'z12-yudam-sidewalks.geojson').write_text(json.dumps(fc, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
def walk(y): return [r2(float(np.interp(557000 + y, prof_['V2'][:, 1], prof_['V2'][:, 0])) + 4.3), r2(557000 + y)]   # 계단 길의 꼭짓점: 그 북좌표에서 가운데 선 동쪽 4.3 m(인도 길과 같은 줄)
model = {'crs': 'EPSG:5186', 'kerbOffsetM': KERB, 'kerbHeightM': H_KERB,
         'west': {'fromXY': [r2(v) for v in off(sw0, KERB + W_W / 2)], 'toXY': [r2(v) for v in off(sw1, KERB + W_W / 2)], 'lengthM': r2(sw1 - sw0), 'widthM': W_W, 'fromM': r2(Z(sw0) + H_KERB), 'toM': r2(Z(sw1) + H_KERB), 'pieces': nW},
         'eastLower': {'lengthM': r2(s_foot - se0), 'widthM': W_E, 'fromM': r2(Z(se0) + H_KERB), 'toM': r2(Z(s_foot) + H_KERB), 'pieces': nE},
         'eastStair': {'footXY': walk(foot['y0']), 'footM': foot['baseM'], 'topXY': walk(top['landingTo']), 'topM': top['topM'], 'lengthM': r2(s_top - s_foot),
                       'path': [[*walk(y), z] for f in z3m for y, z in ((f['y0'], f['baseM']), (f['y1'], f['topM']), (f['landingTo'], f['topM']))]},
         'eastUpper': {'lengthM': r2(se1 - s_top), 'widthM': W_W, 'pieces': nE2}, 'n03bRemoved': removed, 'features': len(feats)}
(HERE / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('removed n03b', removed, 'features', len(feats), {k: v for k, v in model.items() if k in ('west', 'eastLower', 'eastUpper')}); print('stair', model['eastStair']['footXY'], model['eastStair']['topXY'], model['eastStair']['lengthM'])
