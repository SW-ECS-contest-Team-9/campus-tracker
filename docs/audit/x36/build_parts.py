"""X36(2026-10-23): 2026-10-22 전경 영상 비교의 남은 항목(사용자 지시 2026-10-23: 근거로 Claude 가 정해 짓는다).
  X05 북악관·문예관 사이 계단(후보 가: 문예관 기단 테라스에 계단 자리를 파고, 아랫단 북 → 참 → 윗단 서 → 테라스 138.8)
  R02 본관 남쪽 앞 계단 후보 나 중 B1(섬 서쪽 끝 넓은 디딤 단)
  X33 나머지 노면·표지(위쪽 갈래 "SLOW 20"·굽이 원 표시와 글자, 본관 앞 차도 아래 끝 횡단보도, 갈림 과속방지턱, 정문 계단 서쪽 가로등·표지판·노란 함)
  X16 꼭대기 갈림 화단의 둥근 끝, X22 지하 1층 통로 가운데 노란 선, X25 "« EXIT" 걸린 표지·분홍 테두리 칸
근거: 볼트 데이터/모델링 개선/2026-10-22 전경 영상 비교.md, 구역 노트(오르막길과 주변, 유담관 9층 쪽 앞마당과 본관 앞 차도, 위쪽 갈래와 한림관 둘레, 운동장 아래 지하층과 지하 차도) 2026-10-23 절.
  python -I build_parts.py           DB·네트워크 접근 없음
쓰는 파일: frontend/public/structures/x36-remaining.geojson(새), g02-way.geojson(고침: G02-PLATFORM-PODIUM 외곽, 옛 G02-PODIUM-STAIR-* 걷음), backend/data/terrain/recipes/g02-surface.geojson(고침: PODIUM 외곽 + 새 계단 바탕)
돌리는 차례: … → x22 → x27 → 이 스크립트(첫 실행의 옛 외곽은 x36/base-platforms.json 에 남긴다). 좌표 EPSG:5186, 치수 대부분 추정."""
import json, math, pathlib, importlib.util
import numpy as np
from shapely.geometry import Polygon, Point, LineString, shape
from shapely.ops import unary_union

HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; AUDIT = HERE.parent
STR = REPO / 'frontend' / 'public' / 'structures'; REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'
r2 = lambda v: round(float(v), 2)
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def dump(p, obj): p.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
def ring(pts):
    p = [[r2(x), r2(y)] for x, y in pts]
    if Polygon(p).exterior.is_ccw is False: p = p[::-1]
    return p + [p[0]]
def big(g):
    g = g.buffer(0)
    return g if g.geom_type == 'Polygon' else max(g.geoms, key=lambda q: q.area)
def geom(poly):
    poly = poly.buffer(0)
    if poly.geom_type == 'MultiPolygon':
        return {'type': 'MultiPolygon', 'coordinates': [[ring(list(q.exterior.coords)[:-1])] + [ring(list(i.coords)[:-1]) for i in q.interiors] for q in poly.geoms]}
    return {'type': 'Polygon', 'coordinates': [ring(list(poly.exterior.coords)[:-1])] + [ring(list(i.coords)[:-1]) for i in poly.interiors]}
FEATS = []
def box(id, typ, poly, z0, z1, assumption, source, grade='추정', base='', **extra):
    poly = (poly if hasattr(poly, 'geom_type') else Polygon(poly)).buffer(0)
    if poly.is_empty or poly.area < 0.005 or z1 - z0 < 0.005: return
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base, 'fromM': r2(z0), 'toM': r2(z1),
        'assumption': assumption, 'source': source, **extra}, 'geometry': geom(poly)})
def frame(o, a):
    o = np.asarray(o, float); a = np.asarray(a, float); a = a / np.hypot(*a); b = np.array([-a[1], a[0]])
    return lambda u, v: tuple(o + a * u + b * v), (lambda u0, u1, v0, v1: Polygon([tuple(o + a * u + b * v) for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]))
def disc(c, r, n=18): return Polygon([(c[0] + r * math.cos(2 * math.pi * k / n), c[1] + r * math.sin(2 * math.pi * k / n)) for k in range(n)])

OWN = 'x36-remaining.geojson'
FILES = {fn.name: load(fn) for fn in sorted(STR.glob('*.geojson')) if fn.name != OWN}
ALL = {f['properties']['id']: f for d in FILES.values() for f in d['features'] if f.get('geometry')}
def top_of(p, x, y):
    pr = p.get('topProfile')
    if not pr: return float(p.get('topM', p.get('toM')))
    L = math.hypot(*pr['direction']); d = ((x - pr['origin'][0]) * pr['direction'][0] + (y - pr['origin'][1]) * pr['direction'][1]) / L
    return float(np.interp(d, [q[0] for q in pr['points']], [q[1] for q in pr['points']]))
SHAPES = {i: shape(f['geometry']).buffer(0) for i, f in ALL.items()}
def ground(x, y, boxes=()):
    """그 자리의 가장 높은 기단 윗면(boxes 머리말의 상자가 있으면 그 윗면도)."""
    best = None
    for i, f in ALL.items():
        p = f['properties']
        if not (p.get('kind') == 'platform' or (boxes and i.startswith(boxes) and p.get('kind') == 'extrude')): continue
        if SHAPES[i].contains(Point(x, y)):
            z = top_of(p, x, y)
            if best is None or z > best[0]: best = (z, i)
    if best is None: raise SystemExit(f'바탕 없음 {x:.1f},{y:.1f}')
    return best

# 5 x 7 칸 글꼴(노면 글자)
FONT = {'S': '01111 10000 10000 01110 00001 00001 11110', 'L': '10000 10000 10000 10000 10000 10000 11111', 'O': '01110 10001 10001 10001 10001 10001 01110',
        'W': '10001 10001 10001 10101 10101 11011 10001', '2': '01110 10001 00001 00010 00100 01000 11111', '0': '01110 10001 10011 10101 11001 10001 01110'}
def text(idp, s, P, u0, v0, cw, ch, z, what, src, grade, base, color='#f2f2ee'):
    """글자 칸을 판으로. P(u, v): u = 글줄 방향, v = 글자 위쪽."""
    for k, c in enumerate(s):
        cells = []
        for row, bits in enumerate(FONT[c].split()):
            for col, b in enumerate(bits):
                if b == '1':
                    uu = u0 + k * cw * 6 + col * cw; vv = v0 + (6 - row) * ch
                    cells.append(Polygon([P(uu, vv), P(uu + cw, vv), P(uu + cw, vv + ch), P(uu, vv + ch)]))
        box(f'{idp}-{k + 1}-{c}', 'wall', unary_union(cells).buffer(0.001), z, z + 0.02, what, src, grade, base, color=color)

sp = importlib.util.spec_from_file_location('g02common', AUDIT / 'g02' / 'common.py'); G = importlib.util.module_from_spec(sp); sp.loader.exec_module(G)
ST = lambda s, t: tuple(float(v) for v in G.st_to_xy(s, t))
def QST(s0, s1, t0, t1): return Polygon([ST(s0, t0), ST(s1, t0), ST(s1, t1), ST(s0, t1)])
BASEF = HERE / 'base-platforms.json'
BASE_ALL = load(BASEF) if BASEF.exists() else {}

# ===================== 본관 입구(3) 옹벽 틈(사용자 표시 2026-10-23) =====================
# 사용자 표시(비교-후/사용자표시-오르막-본관입구.webp): 오르막 남쪽 옹벽 선이 끊기고 길(29ba445f, s 62.8)이 끝나는 자리 바로 남쪽의 어두운 구멍 = 입구(3).
# 지금 틈은 s 59.2~63.4(가운데 61.3)이고 문틀(X22)도 61.3 이라, 길·학교 표지(s 62.8)와 표시한 어두운 구멍보다 1.5 m 서쪽이다. 틈과 문틀을 +1.5 m(가운데 62.8)로 옮긴다.
SHIFT = 1.5; GAP0, GAP1 = 59.2 + SHIFT, 63.4 + SHIFT
GAPF = ['G03-SWALL-A', 'G03-SBED-A', 'G03-SWALL-LED-A', 'G03-SWALL-B', 'G03-SBED-B', 'G03-SWALL-LED-B']
x22 = FILES['x22-photo-fixes.geojson']; g02f = FILES['g02-way.geojson']
if 'gap' not in BASE_ALL:
    BASE_ALL['gap'] = {f['properties']['id']: {'geometry': f['geometry'], 'topProfile': f['properties']['topProfile']} for f in g02f['features'] if f['properties']['id'] in GAPF}
    BASE_ALL['ent3'] = {f['properties']['id']: f['geometry'] for f in x22['features'] if f['properties']['id'].startswith('X22-BONGWAN-ENT3-')}
for f in g02f['features']:
    i = f['properties']['id']
    if i not in GAPF: continue
    g0 = shape(BASE_ALL['gap'][i]['geometry']); pr = json.loads(json.dumps(BASE_ALL['gap'][i]['topProfile']))
    pts = np.array(g0.exterior.coords); s_, t_ = G.xy_to_st(pts[:, 0], pts[:, 1]); t0, t1 = float(t_.min()), float(t_.max())
    sp_ = [q[0] for q in pr['points']]; zp = [q[1] for q in pr['points']]
    if i.endswith('-A'):   # 끝을 59.2 → 60.7 로 늘임(마지막 기울기 그대로)
        z_end = zp[-1] + (zp[-1] - zp[-2]) / (sp_[-1] - sp_[-2]) * (GAP0 - sp_[-1]); pr['points'][-1] = [GAP0, r2(z_end)]
        poly = QST(float(s_.min()), GAP0, t0, t1)
    else:                   # 시작을 63.4 → 64.9 로 줄임
        z_st = float(np.interp(GAP1, sp_, zp)); pr['points'][0] = [GAP1, r2(z_st)]
        poly = QST(GAP1, float(s_.max()), t0, t1)
    f['geometry'] = geom(poly); f['properties']['topProfile'] = pr
    f['properties']['toM'] = r2(max(q[1] for q in pr['points'])); f['properties']['fromM'] = r2(min(f['properties']['fromM'], min(q[1] for q in pr['points']) - 0.05))
    f['properties']['assumption'] = f['properties'].get('assumption', '').split(' [X36')[0] + ' [X36 2026-10-23: 입구(3) 틈을 s 60.7~64.9 로(사용자 표시·길·학교 표지 s 62.8)]'
dv_ = np.array(ST(SHIFT, 0)) - np.array(ST(0, 0))
for f in x22['features']:
    i = f['properties']['id']
    if i in BASE_ALL['ent3']:
        f['geometry'] = geom(Polygon([(x + dv_[0], y + dv_[1]) for x, y in BASE_ALL['ent3'][i]['coordinates'][0]]))
        if ' [X36' not in f['properties'].get('assumption', ''): f['properties']['assumption'] = f['properties'].get('assumption', '') + ' [X36 2026-10-23: 틈과 함께 1.5 m 동쪽(s 62.8)]'
dump(STR / 'x22-photo-fixes.geojson', x22)

# ===================== 지상 오르막(한림관 북쪽 → 운동장) 폭: 사용자 규칙 2026-10-23 =====================
# 사용자: 건물 좌표(원천 외곽)가 맞으면 길 폭 = 은주1관 북쪽 끝과 대일관 계단 끝 사이 거리이고, 시작부터 끝까지 한결같다. 사진(기울어 건물이 길을 덮음)에서 재지 않는다.
#   은주1관 북쪽 끝(원천 외곽 북서 모서리) (201131.69, 557301.74) = s 100.0, t -4.6
#   대일관 옆 넓은 계단(Z02-SIDE-STAIR) 발치 남서 끝 (201138.6, 557315.6) = s 100.0, t 10.6(남쪽 난간벽 바깥 t 10.6)
#   거리 15.5 m(두 점이 같은 s 에 있어 길에 직각). 길 = s 69.3(오르막 C 구간 시작) ~ 기단 끝, t -4.6 ~ +10.9 의 한결같은 띠.
# 띠 안: 차로 칠 판 하나(옛 차로 칠 판·양쪽 인도·북쪽 턱을 이 구간에서 걷음), 갈림 섬 화단(D76·D81·D87·둥근 끝: 영상 96~98 초)은 섬으로 남김. 남쪽 옹벽·화단 C 는 띠 밖(t -4.6)으로 0.8 m 남쪽.
S_TOP0 = 69.3; T_S, T_N = -4.6, 10.9
EUNJU_TIP, STAIR_END = (201131.69, 557301.74), (201138.6, 557315.6)
WIDTH = float(np.hypot(STAIR_END[0] - EUNJU_TIP[0], STAIR_END[1] - EUNJU_TIP[1]))
WAYF = ALL['G02-PLATFORM-WAY']; WAYG = SHAPES['G02-PLATFORM-WAY']; WP = WAYF['properties']['topProfile']
TOPF = ['G03-SIDEWALK-N1', 'G03-KERB-N1', 'G03-SIDEWALK-S2', 'G03-PAINT-LANE-2', 'G03-SWALL-C', 'G03-SWALL-LED-C', 'G03-SBED-C']
for f in g02f['features']:
    i = f['properties']['id']
    if i not in TOPF: continue
    if i not in BASE_ALL.setdefault('top', {}): BASE_ALL['top'][i] = f['geometry']
    g0 = shape(BASE_ALL['top'][i]); pts = np.array(g0.exterior.coords); s_, t_ = G.xy_to_st(pts[:, 0], pts[:, 1])
    if i in ('G03-SWALL-C', 'G03-SWALL-LED-C', 'G03-SBED-C'):   # 띠 밖으로: t 를 0.8 m 남쪽(−)
        f['geometry'] = geom(QST(float(s_.min()), float(s_.max()), float(t_.min()) - 0.8, float(t_.max()) - 0.8))
        note = '띠(t -4.6 ~ 10.9) 밖으로 0.8 m 남쪽'
    else:
        s1 = min(float(s_.max()), S_TOP0)
        if s1 - float(s_.min()) < 0.2: f['properties']['_drop'] = True; continue
        f['geometry'] = geom(QST(float(s_.min()), s1, float(t_.min()), float(t_.max()))); note = f's {S_TOP0} 에서 끝(그 위는 한결같은 폭 띠)'
    f['properties']['assumption'] = f['properties'].get('assumption', '').split(' [X36')[0] + f' [X36 2026-10-23: {note}]'
g02f['features'] = [f for f in g02f['features'] if not f['properties'].pop('_drop', False)]
island = unary_union([SHAPES[i] for i in ('G02-NPLANT-D76', 'G02-NPLANT-D81', 'G02-NPLANT-D87')])
blockers = unary_union([SHAPES[i] for i, f in ALL.items() if f['properties'].get('kind') == 'extrude' and not f['properties'].get('underground') and not f['properties'].get('inVoid')
                        and f['properties'].get('type') != 'tree' and not i.startswith(('G03-PAINT-LANE', 'G03-SIDEWALK', 'G03-KERB', 'G03-SWALL', 'G03-SBED', 'G03-SLAB', 'X36-')) and SHAPES[i].intersects(QST(S_TOP0, 114, T_S, T_N))])
field = SHAPES['Z02-PLATFORM-FIELD']
toplane = QST(S_TOP0, 113.2, T_S, T_N).intersection(WAYG).difference(blockers.buffer(0.02)).difference(island.buffer(0.3)).difference(field.buffer(0.02))
prof = {'origin': WP['origin'], 'direction': WP['direction'], 'points': [[q[0], r2(q[1] + 0.03)] for q in WP['points'] if q[0] >= S_TOP0 - 15]}
FEATS.append({'type': 'Feature', 'properties': {'id': 'X36-UPHILL-TOP-LANE', 'type': 'wall', 'kind': 'extrude', 'estimated': True, 'grade': f'확정(규칙: 사용자 2026-10-23), 원천(은주1관 외곽), 모델(대일관 계단 발치), 폭 {WIDTH:.1f} m',
    'basePlane': 'WAY', 'fromM': r2(min(q[1] for q in prof['points']) - 0.03), 'toM': r2(max(q[1] for q in prof['points'])), 'topProfile': prof, 'thicknessM': 0.03, 'color': '#9c9b95', 'pattern': 'rings',
    'assumption': f'지상 오르막(한림관 북쪽 → 운동장, s {S_TOP0} ~ 끝): 폭 {WIDTH:.1f} m 한결같은 띠(은주1관 북쪽 끝 ~ 대일관 계단 발치), 갈림 섬 화단은 섬. 높이 = 기본 평면 + 0.03', 'source': '사용자 2026-10-23(구역 노트 오르막길과 주변), 건물 외곽(은주관), 구조물 Z02-SIDE-STAIR'}, 'geometry': geom(toplane)})
box('X36-UPHILL-TOP-KERB-N', 'wall', QST(S_TOP0, 100.0, T_N, T_N + 0.25).intersection(WAYG).difference(blockers.buffer(0.02)), 0, 0, '', '', base='WAY')   # 자리표(높이 0 이라 안 만들어짐)

# ===================== X05 북악관·문예관 사이 계단(후보 가) =====================
SRC5 = '사진 06(북악관-문예관-사이-오르막-계단.webp: 인도에서 곧게 오르는 아랫단 → 참 → 왼쪽(서)으로 꺾여 오르는 윗단, 양옆 화강석 난간벽, 위에 난간), 후보 그림 비교-후/후보-X05-북악관문예관계단.png'
G5 = '사진(모양: 꺾인 두 줄·난간벽), Claude 결정 2026-10-23(후보 가: 사진의 윗단 끝 난간 = 테라스 가장자리), 추정(단 수·자리 ±1 m)'
TT = 138.8
zf, _ = ground(*ST(36.3, 4.3), ('G03-SIDEWALK',))
NRI = int(round((TT - zf) / 0.16)); RISE = (TT - zf) / NRI; NL = 9; NU = NRI - NL; GO = 0.3
S0, S1 = 35.0, 37.6                       # 아랫단·참의 s 폭(2.6 m)
T0 = 4.5; TL0 = T0 + GO * (NL - 1); TL1 = TL0 + 2.4       # 아랫단 디딤 NL-1 개, 참 깊이 2.4
for k in range(1, NL):
    box(f'X36-PODIUM-STAIR-L{k:02d}', 'stair_step', QST(S0, S1, T0 + GO * (k - 1), T0 + GO * k), zf - 0.3, zf + RISE * k, f'북악관·문예관 사이 계단 아랫단 {k}(북으로)', SRC5, G5, 'G02-X36-PLATFORM-PODIUM-STAIRWELL',
        stair='X36-PODIUM-STAIR-LOW', riseM=r2(RISE), runM=GO, widthM=S1 - S0, material='stone')
ZL = zf + RISE * NL
box('X36-PODIUM-STAIR-LANDING', 'landing', QST(S0, S1, TL0, TL1), zf - 0.3, ZL, '참(아랫단 머리, 여기서 서쪽으로 꺾음)', SRC5, G5, 'G02-X36-PLATFORM-PODIUM-STAIRWELL', material='stone')
for k in range(1, NU):
    box(f'X36-PODIUM-STAIR-U{k:02d}', 'stair_step', QST(S0 - GO * k, S0 - GO * (k - 1), TL0, TL1), zf - 0.3, ZL + RISE * k, f'윗단 {k}(서쪽으로)', SRC5, G5, 'G02-X36-PLATFORM-PODIUM-STAIRWELL',
        stair='X36-PODIUM-STAIR-UP', riseM=r2(RISE), runM=GO, widthM=TL1 - TL0, material='stone')
SU = S0 - GO * (NU - 1)                    # 윗단 끝(마지막 단 다음은 테라스 138.8)
WALL = '#bdb7ab'
box('X36-PODIUM-STAIR-WALL-E', 'wall', QST(S1, S1 + 0.3, T0, TL1 + 0.3), zf - 0.3, TT + 0.9, '아랫단·참 동쪽 화강석 난간벽', SRC5, G5, 'G02-X36-PLATFORM-PODIUM-STAIRWELL', color=WALL)
box('X36-PODIUM-STAIR-WALL-N', 'wall', QST(SU - 0.3, S1, TL1, TL1 + 0.3), zf - 0.3, TT + 0.9, '참·윗단 북쪽 화강석 난간벽(위 테라스 쪽 난간)', SRC5, G5, 'G02-X36-PLATFORM-PODIUM-STAIRWELL', color=WALL)
for k in range(1, NL):
    box(f'X36-PODIUM-STAIR-WALL-W-{k:02d}', 'wall', QST(S0 - 0.3, S0, T0 + GO * (k - 1), T0 + GO * k), zf - 0.3, min(zf + RISE * k + 0.9, TT + 0.9), '아랫단 서쪽 화강석 난간벽(그 서쪽은 테라스 덩어리)', SRC5, G5, 'G02-X36-PLATFORM-PODIUM-STAIRWELL', color=WALL)
HOLE = unary_union([QST(S0 - 0.3, S1 + 0.3, T0, TL0), QST(SU - 0.3, S1 + 0.3, TL0, TL1 + 0.3)]).buffer(0)
# 기단 고침(첫 실행에 옛 외곽을 남김)
SURF = load(REC / 'g02-surface.geojson')
if 'G02-PLATFORM-PODIUM' not in BASE_ALL:
    sf = [s for s in SURF['features'] if s['properties']['name'] == 'PODIUM'][0]
    BASE_ALL['G02-PLATFORM-PODIUM'] = {'geometry': ALL['G02-PLATFORM-PODIUM']['geometry'], 'surface': sf['geometry']}
dump(BASEF, BASE_ALL)
BASE = BASE_ALL['G02-PLATFORM-PODIUM']
pod_new = shape(BASE['geometry']).buffer(0).difference(HOLE); pods_new = shape(BASE['surface']).buffer(0).difference(HOLE)
WELL = shape(BASE['geometry']).buffer(0).intersection(HOLE).buffer(0)
g02 = g02f; out = []
for f in g02['features']:
    i = f['properties']['id']
    if i.startswith('G02-PODIUM-STAIR-') or i.startswith('G02-X36-'): continue
    if i == 'G03-NPLANT-B1':   # 인도 북쪽 화단: 계단 아랫단 자리를 뺌(사진 06: 아랫단 양옆이 화단)
        if 'G03-NPLANT-B1' not in BASE_ALL: BASE_ALL['G03-NPLANT-B1'] = f['geometry']; dump(BASEF, BASE_ALL)
        rest = shape(BASE_ALL['G03-NPLANT-B1']).buffer(0).difference(HOLE.buffer(0.02))
        f['geometry'] = geom(big(rest))
        f['properties']['assumption'] = f['properties'].get('assumption', '').split(' [X36')[0] + ' [X36 2026-10-23: 계단 아랫단 자리를 뺌]'
    if i == 'G02-PLATFORM-PODIUM':
        f['geometry'] = geom(big(pod_new)); f['properties']['assumption'] = f['properties']['assumption'].split(' [X36')[0] + ' [X36 2026-10-23: 계단 자리(아랫단·참·윗단)를 뺌(후보 가)]'
    out.append(f)
out.append({'type': 'Feature', 'properties': {'id': 'G02-X36-PLATFORM-PODIUM-STAIRWELL', 'type': 'platform', 'kind': 'platform', 'estimated': True, 'grade': G5, 'surfaceName': 'X36-PODIUM-STAIRWELL',
    'topM': r2(zf - 0.02), 'bottomM': 130.0, 'bottomNote': '옆 기단보다 아래', 'material': 'paving', 'assumption': '문예관 기단 테라스에 판 계단 자리의 바닥(인도 높이). 위에 계단·참 상자', 'source': SRC5}, 'geometry': geom(WELL)})
g02['features'] = out; dump(STR / 'g02-way.geojson', g02)
sfeats = []
for s in SURF['features']:
    if s['properties']['name'] == 'X36-PODIUM-STAIRWELL': continue
    if s['properties']['name'] == 'PODIUM': s['geometry'] = geom(big(pods_new))
    sfeats.append(s)
sfeats.append({'type': 'Feature', 'properties': {'name': 'X36-PODIUM-STAIRWELL', 'srid': 5186, 'heightM': r2(zf - 0.02), 'reason': 'X36 북악관·문예관 사이 계단 자리(후보 가)', 'grade': G5, 'source': SRC5}, 'geometry': geom(WELL)})
SURF['features'] = sfeats; dump(REC / 'g02-surface.geojson', SURF)
X05 = {'foot': [r2(c) for c in ST((S0 + S1) / 2, T0)], 'footZ': r2(zf), 'landing': [r2(c) for c in ST((S0 + S1) / 2, (TL0 + TL1) / 2)], 'landingZ': r2(ZL), 'top': [r2(c) for c in ST(SU - 0.4, (TL0 + TL1) / 2)], 'risers': [NL, NU], 'rise': r2(RISE)}

# ===================== R02 본관 남쪽 앞 계단 B1(후보 나) =====================
SRCB = '거리뷰 05(섬 서쪽 끝의 넓은 돌 디딤 단), S-MAP 정사 claude-m16/S07(줄무늬 칸), R02 후보 나'
GB = 'Claude 결정 2026-10-23(후보 나의 B1), 추정(자리 ±3 m, 단 수 = 높이 차 / 0.16)'
P, Q = frame((201043.5, 557293.0), (4.0, 4.0))
z0b, b0 = ground(201043.5, 557293.0); z1b, b1 = ground(*P(1.6, 0))
nb = max(2, int(round((z1b - z0b) / 0.16))); rb = (z1b - z0b) / nb
for k in range(1, nb + 1):
    box(f'X36-BONGWAN-B1-STAIR-S{k:02d}', 'stair_step', Q(0.4 * (k - 1), 0.4 * k, -3.0, 3.0), z0b - 0.3, z0b + rb * k, f'본관 앞 섬 서쪽 끝 넓은 돌 디딤 단 {k}(폭 6 m)', SRCB, GB, b0, stair='X36-BONGWAN-B1-STAIR', riseM=r2(rb), runM=0.4, widthM=6.0, material='stone')

# ===================== X33 나머지 노면·표지 =====================
AERG = '사용자 항공사진 항공-한림관정문-은주1관.webp(땅 위 표시 셋으로 맞춤 ±1.5 m, docs/audit/x27/aerial-georef.json)'
GX = '항공사진(자리·크기 ±1.5 m), 사진 23·e2(무엇인지), 추정(글꼴·무늬)'
# 위쪽 갈래 아래 구간 "SLOW" + 원 안 "20"(북쪽으로 오르는 차가 읽음)
zs, bs = ground(201110.8, 557216.0)
Pu, _ = frame((201109.2, 557214.9), (1.0, 0.0))
text('X36-ROAD-SLOW', 'SLOW', Pu, 0.0, 0.0, 0.13, 0.2, zs + 0.01, '노면 글자 "SLOW"(위쪽 갈래 아래 구간, 북쪽 보고)', AERG, GX, bs)
zc, bc = ground(201110.7, 557213.3)
box('X36-ROAD-20-RING', 'wall', disc((201110.7, 557213.3), 1.25, 24).difference(disc((201110.7, 557213.3), 1.05, 24)), zc + 0.01, zc + 0.03, '노면 원(속도 제한 표시 테)', AERG, GX, bc, color='#f2f2ee')
P20, _ = frame((201110.7 - 0.5, 557213.3 - 0.55), (1.0, 0.0))
text('X36-ROAD-20', '20', P20, 0.0, 0.0, 0.085, 0.16, zc + 0.01, '노면 원 안 "20"', AERG, GX, bc)
# 굽이: 원 표시 + 글자(항공사진의 밝은 원과 그 동쪽 글자)
zb2, bb2 = ground(201090.1, 557277.5)
box('X36-BEND-RING', 'wall', disc((201090.1, 557277.5), 1.4, 24).difference(disc((201090.1, 557277.5), 1.18, 24)), zb2 + 0.01, zb2 + 0.03, '굽이 노면 원 표시', AERG, GX, bb2, color='#f2f2ee')
Pb, _ = frame((201090.1 - 0.45, 557277.5 - 0.6), (1.0, 0.0))
text('X36-BEND-20', '20', Pb, 0.0, 0.0, 0.09, 0.17, zb2 + 0.01, '굽이 노면 원 안 "20"', AERG, GX, bb2)
zt2, bt2 = ground(201093.48, 557276.59)
Pt, _ = frame((201093.48, 557276.59), (0.0, -1.0))   # 글줄은 남쪽으로(동쪽에서 오는 차가 읽음, 추정)
text('X36-BEND-SLOW', 'SLOW', Pt, -1.5, -0.7, 0.12, 0.2, zt2 + 0.01, '굽이 노면 글자 "SLOW"(방향 추정)', AERG, GX, bt2)
# 본관 앞 차도 아래 끝 횡단보도(S-MAP 정사 줄무늬 (201074, 557273), 길과 직각)
SRCX = 'S-MAP 정사 화면(claude-m16/S06: 줄무늬 (201074.2, 557273.4)), 사진 e2·23'
cwc = np.array([201074.0, 557272.5]); dr = np.array([-0.73, 0.68]); dr /= np.hypot(*dr)    # 차도 방향(인도 3372d297 와 나란히)
Pc, Qc = frame(cwc, dr)
for k in range(8):
    v0 = -3.6 + k * 0.95
    zz, bz = ground(*Pc(0.0, v0 + 0.25))
    box(f'X36-CROSSWALK-{k + 1}', 'wall', Qc(-1.6, 1.6, v0, v0 + 0.5), zz + 0.01, zz + 0.03, '횡단보도 흰 줄(본관 앞 차도 아래 끝)', SRCX, 'S-MAP(자리 ±1 m), 추정(줄 수·크기)', bz, color='#f2f2ee')
# 갈림 과속방지턱(H14: 노랑·흰 줄)
pb, qb = frame((201080.6, 557265.5), (0.6, 0.8))
for k in range(8):
    v0 = -3.2 + k * 0.8; zz, bz = ground(*pb(0.0, v0 + 0.4))
    box(f'X36-BUMP-JUNCTION-{k + 1}', 'wall', qb(-0.45, 0.45, v0, v0 + 0.8), zz - 0.05, zz + 0.08, '갈림 과속방지턱(노랑·흰 줄)', '사진 e2, S-MAP 정사', 'S-MAP·사진(자리 ±2 m), 추정(무늬)', bz, color='#f2c230' if k % 2 == 0 else '#f2f2ee')
# 정문 계단 서쪽: 짙은 기둥 가로등, 경고 삼각·원형 표지판 기둥, 노란 함(H18·사진 21·e2)
x27m = load(AUDIT / 'x27' / 'model.json')['frame']; C = np.array(x27m['C']); A = np.array(x27m['A']); N = np.array(x27m['N'])
H = lambda u, v: tuple(C + A * u + N * v)
SRCH = '사진 21(정문 계단 서쪽 화단 너머 짙은 기둥 가로등·경고 삼각·원형 표지판 기둥·노란 함), 사진 e2(계단식 보도 발치 노란 함)'
GH = '사진(있음), 추정(자리 ±2 m·크기)'
sq = lambda c, h: Polygon([(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)])
lp = H(-9.0, -6.5); zl, bl = ground(*lp)
box('X36-HANLIM-LAMP', 'wall', sq(lp, 0.1), zl, zl + 5.5, '정문 계단 서쪽 짙은 기둥 가로등', SRCH, GH, bl, color='#2c2e31')
box('X36-HANLIM-LAMP-HEAD', 'wall', sq(lp, 0.28), zl + 5.3, zl + 5.6, '가로등 머리', SRCH, GH, 'X36-HANLIM-LAMP', color='#2c2e31')
for k, (u, sym) in enumerate(((-11.0, 'tri'), (-12.2, 'round'))):
    c = H(u, -8.9); zz, bz = ground(*c)
    box(f'X36-SIGN-{k + 1}-POST', 'wall', sq(c, 0.04), zz, zz + 2.6, '표지판 기둥', SRCH, GH, bz, color='#9a9da0')
    box(f'X36-SIGN-{k + 1}-FACE', 'wall', Polygon([H(u - 0.35, -8.95), H(u + 0.35, -8.95), H(u + 0.35, -8.9), H(u - 0.35, -8.9)]).buffer(0), zz + 2.0, zz + 2.7, '경고 삼각 표지(빨간 테)' if sym == 'tri' else '원형 규제 표지(빨간 테·파란 바탕)', SRCH, GH, f'X36-SIGN-{k + 1}-POST', color='#d9d6cc' if sym == 'tri' else '#c8262c')
BOXES = unary_union([SHAPES[i] for i, f in ALL.items() if i.startswith(('P01-', 'P02-', 'Z06-', 'X22-LAMP')) and SHAPES[i].distance(Point(201075.5, 557277.6)) < 4])
yb = next(c for c in ((201075.5 + dx, 557277.6 + dy) for dy in (0, -0.6, 0.6, -1.2, 1.2) for dx in (0, 0.6, -0.6, 1.2, -1.2)) if not sq(c, 0.37).intersects(BOXES)); zy, by = ground(*yb, ('N03B-SIDEWALK',))
box('X36-YELLOW-BOX', 'wall', sq(yb, 0.35), zy, zy + 0.8, '노란 함(모래·제설함)', SRCH, GH, by, color='#e8c21a')

# ===================== X16 꼭대기 갈림 화단의 둥근 끝 =====================
SRC16 = '전경 영상 96~98 초(꼭대기 갈림 끝이 둥근 흰 돌 화단), 구조물 G02-NPLANT-D87'
d87 = ALL['G02-NPLANT-D87']; g87 = SHAPES['G02-NPLANT-D87']; pts = np.array(g87.exterior.coords)[:-1]
e2 = pts[np.argsort(-pts[:, 0])[:2]]; mid = e2.mean(0); rr = np.hypot(*(e2[0] - e2[1])) / 2
endd = disc(tuple(mid), rr, 24).difference(g87.buffer(0.01)).difference(unary_union([SHAPES[i] for i in SHAPES if i.startswith('U06-ROADWALL-N-')]).buffer(0.02))
box('X36-FORK-PLANTER-ROUNDEND', 'planter', endd, d87['properties']['fromM'], d87['properties']['toM'], '꼭대기 갈림 화단 동쪽 끝의 둥근 흰 돌 머리', SRC16, '영상(있음), 추정(반지름 = 화단 폭의 반)', 'G02-NPLANT-D87', material='white_stone', topColor='#6f8a55')

# ===================== X22·X25 지하 1층 =====================
U02 = load(AUDIT / 'u02' / 'model.json'); ZB1 = U02['heights']['b1Floor']
APP = U02['approach']; e0, e1 = np.array(APP['entry']['xy']), np.array(APP['laneEnd']['xy'])
SRCU = '전경 영상 2 59~74 초(지하 1층 통로 가운데 노란 선, 60~68 초 "« EXIT" 걸린 표지·분홍 테두리 칸)'
box('X36-B1-CENTRELINE', 'wall', LineString([tuple(e0), tuple(e1)]).buffer(0.06, cap_style=2), ZB1, ZB1 + 0.02, '지하 1층 긴 통로(북서 목 → 동쪽 끝) 가운데 노란 선. 다른 통로는 자리를 몰라 안 함', SRCU,
    '영상(있음), 추정(긴 통로 하나에만)', 'U02-VOID-B1 바닥', color='#e8c21a', inVoid=True, underground=True)
door = np.array(U02['points']['DOOR']['xy']) if 'DOOR' in U02['points'] else np.array([201209.4, 557280.8])
cd = np.array([201209.4, 557280.8]); dv = (np.array([201200.0, 557245.0]) - cd); dv /= np.hypot(*dv)
Pd, Qd = frame(cd, dv)
box('X36-B1-EXIT-SIGN', 'wall', Qd(2.8, 2.95, -0.55, 0.55), ZB1 + 2.4, ZB1 + 2.75, '"« EXIT" 걸린 표지(청운관 쪽 문 앞, 천장에 매달림: 초록 판)', SRCU, '영상(있음), 추정(자리)', 'U02-VOID-B1', color='#1f8f4a', inVoid=True, underground=True)
pk = Qd(4.0, 9.0, 1.5, 9.0); pk_in = Qd(4.12, 8.88, 1.62, 8.88)
box('X36-B1-PINK-BAYS', 'wall', pk.difference(pk_in), ZB1, ZB1 + 0.03, '분홍 테두리 칸 한 묶음(청운관 쪽 문 옆, 추정 자리)', SRCU, '영상(있음), 추정(자리·크기)', 'U02-VOID-B1 바닥', color='#e86aa6', inVoid=True, underground=True)

dump(STR / OWN, {'type': 'FeatureCollection', 'name': 'x36-remaining', 'crs': CRS,
  'provenance': {'builder': 'docs/audit/x36/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '2026-10-22 전경 영상 비교의 남은 항목(2026-10-23). 치수는 추정'}, 'features': FEATS})
dump(HERE / 'model.json', {'uphillTop': {'widthM': round(WIDTH, 2), 'eunjuTip': EUNJU_TIP, 'stairEnd': STAIR_END, 'tSouth': T_S, 'tNorth': T_N, 'sStart': S_TOP0}, 'x05': X05, 'b1': {'risers': nb, 'rise': r2(rb), 'from': [r2(z0b), b0], 'to': [r2(z1b), b1]}})
print('x36 상자', len(FEATS), 'X05', X05)
