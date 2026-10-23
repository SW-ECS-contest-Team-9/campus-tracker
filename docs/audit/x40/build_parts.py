"""X40(2026-10-23): 사용자 표시·사진 항목 1~6 의 구조물.
  1 한림관 원통 북쪽 ~ 대일관 서쪽 현관 사이 쐐기 화단(사용자 표시 항공/사용자표시-한림관북쪽-화단.webp), 지상 오르막 차로 칠 판은 화단 앞에서 끝
  2 대일관 서쪽 현관 동쪽 옆벽을 아치로 틈(데크 서쪽 끝과 현관 참이 턱 없이 이어짐)
  3 타일 면(조각 돌 포장): 카페 SP 데크 서쪽 끝 ~ 대일관 옆 계단 발치를 평평한 145.95 m 로, 옆 계단 아랫단 5단 더함, 카페 앞 평탄부(145.5)에서 3단
  4 문예관 저층부와 지상 오르막 사이 통 계단(폭 10 m, 20단 → 차양 앞 마당 144.2), 마당 → 카페 앞 평탄부 난간 계단 8단
  5 대일관 동쪽 끝(청운관 앞): 참 위 작은 계단을 뒤쪽(-v)으로 돌림, 청운관 떠 있는 화단을 둥근 두 굽이로
  6 은주1관 정면: 두 갈래 곡선 계단(모래시계 꼴)·가운데 참·둥근 화단·타원 화단·난간, X27 반원 테라스를 걷음
근거·결정: 볼트 구역 노트 오르막길과 주변 X40 절, 건물 노트 대일관·청운관·은주관 X40 절.
  python -I build_parts.py         DB·네트워크 접근 없음. 첫 실행 때 고친 상자의 옛 모습을 base.json 에 남기고, 다시 돌리면 그것에서 다시 만든다.
쓰는 파일: frontend/public/structures/x40-parts.geojson(새), g02-way·x36-remaining·z02-daeil-front·x22-photo-fixes·b15-cheongun·x27-hanlim-front(id 로 고침),
  backend/data/terrain/recipes/g02-surface.geojson(TOP·WAY·FORK 외곽 + 새 바탕 둘). 좌표 EPSG:5186, 치수 대부분 추정."""
import json, math, copy, pathlib, importlib.util
import numpy as np
from shapely.geometry import Polygon, Point, LineString, MultiPolygon, shape, box as sbox
from shapely.ops import unary_union

HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; AUDIT = HERE.parent
STR = REPO / 'frontend' / 'public' / 'structures'; REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'
OWN = 'x40-parts.geojson'
r2 = lambda v: round(float(v), 2)
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def dump(p, obj): p.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
def ring(pts):
    p = [[r2(x), r2(y)] for x, y in pts]
    if not Polygon(p).exterior.is_ccw: p = p[::-1]
    return p + [p[0]]
def geom(poly):
    poly = poly.buffer(0)
    parts = [q for q in (poly.geoms if poly.geom_type == 'MultiPolygon' else [poly]) if q.area > 0.01]
    rings = lambda q: [ring(list(q.exterior.coords)[:-1])] + [ring(list(i.coords)[:-1]) for i in q.interiors]
    if len(parts) == 1: return {'type': 'Polygon', 'coordinates': rings(parts[0])}
    return {'type': 'MultiPolygon', 'coordinates': [rings(q) for q in parts]}
def disc(c, r, n=24): return Polygon([(c[0] + r * math.cos(2 * math.pi * k / n), c[1] + r * math.sin(2 * math.pi * k / n)) for k in range(n)])
def mod(name): sp = importlib.util.spec_from_file_location(name, AUDIT / name / 'common.py'); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m); return m
G = mod('g02'); Z = mod('z02')
ST = lambda s, t: tuple(float(v) for v in G.st_to_xy(s, t))
def QST(s0, s1, t0, t1): return Polygon([ST(s0, t0), ST(s1, t0), ST(s1, t1), ST(s0, t1)])
def sof(x, y): return float(G.xy_to_st(np.array([x]), np.array([y]))[0][0])
UV = lambda u, v: tuple(float(c) for c in Z.uv_to_xy(u, v))
def QUV(u0, u1, v0, v1): return Polygon([UV(u0, v0), UV(u1, v0), UV(u1, v1), UV(u0, v1)])
BIG = 300.0
def half_s(s0, s1): return QST(s0, s1, -BIG, BIG)

# ---------- 파일 읽기와 옛 모습(base.json) 되살리기 ----------
FILES = {fn.name: load(fn) for fn in sorted(STR.glob('*.geojson')) if fn.name != OWN}
SURF = load(REC / 'g02-surface.geojson')
BASEF = HERE / 'base.json'
BASE = load(BASEF) if BASEF.exists() else {'features': {}, 'surfaces': {}}
for fname, feats in BASE['features'].items():          # 다시 돌릴 때: 고친·지운 상자를 옛 모습으로, 이 스크립트가 넣은 X40- 상자는 걷음
    d = FILES[fname]; have = {f['properties']['id']: k for k, f in enumerate(d['features'])}
    for i, f in feats.items():
        if i in have: d['features'][have[i]] = copy.deepcopy(f)
        else: d['features'].append(copy.deepcopy(f))
for d in FILES.values(): d['features'] = [f for f in d['features'] if not f['properties']['id'].startswith('X40-')]
for nm, f in BASE['surfaces'].items():
    k = [j for j, s in enumerate(SURF['features']) if s['properties']['name'] == nm]
    if k: SURF['features'][k[0]] = copy.deepcopy(f)
SURF['features'] = [s for s in SURF['features'] if not s['properties']['name'].startswith('X40-')]
CHANGED = set()
def F(fname, i):
    """고칠 상자: 처음 만질 때 옛 모습을 남긴다."""
    d = FILES[fname]
    f = [f for f in d['features'] if f['properties']['id'] == i][0]
    BASE['features'].setdefault(fname, {}).setdefault(i, copy.deepcopy(f)); CHANGED.add(fname); return f
DROPPED = set()
def drop(fname, pred):
    d = FILES[fname]; keep = []
    for f in d['features']:
        if pred(f['properties']['id']): DROPPED.add(f['properties']['id']); BASE['features'].setdefault(fname, {}).setdefault(f['properties']['id'], copy.deepcopy(f)); CHANGED.add(fname)
        else: keep.append(f)
    d['features'] = keep
def surface(nm):
    s = [s for s in SURF['features'] if s['properties']['name'] == nm][0]
    BASE['surfaces'].setdefault(nm, copy.deepcopy(s)); return s
def note(f, txt): f['properties']['assumption'] = f['properties'].get('assumption', '').split(' [X40')[0] + f' [X40 2026-10-23: {txt}]'
ALL = {f['properties']['id']: (fn, f) for fn, d in FILES.items() for f in d['features'] if f.get('geometry')}
SH = lambda i: shape(ALL[i][1]['geometry']).buffer(0)

FEATS = []
def box(id, typ, poly, z0, z1, assumption, source, grade='추정', base='', **extra):
    poly = (poly if hasattr(poly, 'geom_type') else Polygon(poly)).buffer(0)
    if poly.is_empty or poly.area < 0.005 or z1 - z0 < 0.005: return None
    f = {'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base, 'fromM': r2(z0), 'toM': r2(z1),
         'assumption': assumption, 'source': source, **extra}, 'geometry': geom(poly)}
    FEATS.append(f); return f
def tree(id, c, z, base, src, grade, h=1.0, cr=1.2):
    for part, mat, hh, z0, z1 in (('TRUNK', 'trunk', 0.14, 0.0, 3.0 * h), ('CROWN', 'foliage', cr, 2.5 * h, 3.8 * h), ('TOP', 'foliage', cr * 0.55, 3.8 * h, 4.6 * h)):
        box(f'{id}-{part}', 'tree', disc(c, hh, 6), z + z0, z + z1, '소나무(단순한 나무)', src, grade, base, material=mat)
def blockers(area, zlo=-1e9, zhi=1e9, skip=(), und=False):
    """그 자리의 다른 상자(나무·빈 곳·지하·얇은 칠 판 빼고, 높이가 겹치는 것만)."""
    gs = []
    for i, (fn, f) in ALL.items():
        p = f['properties']
        if p.get('kind') != 'extrude' or p.get('type') == 'tree' or ((p.get('underground') or p.get('inVoid')) and not und) or i.startswith(skip) or i in DROPPED: continue
        lo, hi = p.get('fromM', 0), p.get('toM', 0)
        if p.get('topProfile'): zs = [q[1] for q in p['topProfile']['points']]; hi = max(zs); lo = min(zs) - p.get('thicknessM', 99)
        if hi - lo <= 0.06 or hi <= zlo or lo >= zhi: continue
        g = SH(i)
        if g.intersects(area): gs.append(g)
    return unary_union(gs) if gs else Polygon()
WAYP = ALL['G02-PLATFORM-WAY'][1]['properties']['topProfile']
def way_z(s): return float(np.interp(s, [q[0] for q in WAYP['points']], [q[1] for q in WAYP['points']]))

# ===================== 1 쐐기 화단 =====================
SRC1 = '사용자 표시 항공/사용자표시-한림관북쪽-화단.webp(파란 테두리, D23 항공사진 변환에 특징점 895개로 맞춤 docs/audit/x40/georef.json), 카카오·네이버 항공사진(짙은 나무 덩어리), 영상 1 142~146 초'
G1 = '확정(화단이 있다: 사용자 표시), 추정(외곽 ±1 m, 높이 = 길 + 0.45, 나무 넷)'
BM = load(HERE / 'blue_marks.json')
bottom_curve = [p for p in BM['ring_bottom'] if p[0] <= 201145.06]
W = Polygon(BM['ring_top'] + [(201151.69, 557308.75), (201147.7, 557308.45), (201146.4, 557306.2)] + bottom_curve[::-1]).buffer(0)
W = W.buffer(0.3, join_style=1).buffer(-0.3, join_style=1)
W1 = W.difference(blockers(W, 146.0, 151.0, skip=('X36-UPHILL-TOP-LANE', 'P02-FIELD-STRIPE', 'G03-PAINT', 'U0')).buffer(0.03)).buffer(0)
W1 = max(W1.geoms, key=lambda q: q.area) if W1.geom_type == 'MultiPolygon' else W1
prof1 = {'origin': WAYP['origin'], 'direction': WAYP['direction'], 'points': [[95.0, r2(way_z(95) + 0.45)], [100.0, r2(way_z(100) + 0.45)], [110.0, r2(way_z(110) + 0.45)], [130.0, r2(way_z(110) + 0.45)]]}
SW0 = min(sof(x, y) for x, y in W1.exterior.coords); ZW0 = r2(way_z(SW0) - 0.1)
f1 = box('X40-WEDGE-PLANTER', 'planter', W1, ZW0, max(q[1] for q in prof1['points']), '한림관 원통 북쪽 ~ 대일관 서쪽 현관 사이 쐐기 화단(짙은 화강석 테, 윗면 = 길 + 0.45 m). 동쪽 끝의 옛 두 조각(Z02-PLANTER-W1·W2)과 이어짐', SRC1, G1, 'G02-PLATFORM-WAY',
         color='#5e6266', topColor='#5f7f45')
f1['properties'].update(topProfile=prof1, bottomM=ZW0)
for k, x in enumerate((201138.8, 201141.9, 201145.0, 201148.0)):
    col = W1.intersection(LineString([(x, 557300), (x, 557320)]))
    if col.is_empty: continue
    c = col.interpolate(0.5, normalized=True)
    tree(f'X40-WEDGE-PINE-{k + 1}', (c.x, c.y), way_z(sof(c.x, c.y)) + 0.45, 'X40-WEDGE-PLANTER', SRC1, G1, h=0.9, cr=1.0)
lane = F('x36-remaining.geojson', 'X36-UPHILL-TOP-LANE')
lane['geometry'] = geom(shape(lane['geometry']).buffer(0).difference(W.buffer(0.02)))
note(lane, '쐐기 화단(사용자 표시) 앞에서 끝')

# ===================== 2 대일관 서쪽 현관 동쪽 옆 아치 =====================
SRC2 = '영상 1 136~150 초(frames t068~t076: 현관 회랑 끝 아치 구멍 너머 나무), 사용자 표시 항공/사용자표시-대일관현관-동쪽-틈.webp("정문처럼 트임")'
G2 = '확정(트인 통로: 사용자), 영상(아치), 추정(기둥 폭 0.45 m, 아치 머리 154.2 = 앞면 아치와 같음)'
se = F('z02-daeil-front.geojson', 'Z02-PORCH-SIDE-E')
sg = shape(BASE['features']['z02-daeil-front.geojson']['Z02-PORCH-SIDE-E']['geometry'])
a0 = np.array([201160.995, 557308.655]); a1 = np.array([201162.385, 557311.755]); ax = (a1 - a0) / np.linalg.norm(a1 - a0); L2 = float(np.linalg.norm(a1 - a0))
PX = np.array([-ax[1], ax[0]])
def along(t0, t1): return sg.intersection(Polygon([tuple(a0 + ax * a + PX * w) for a, w in ((t0, -1), (t1, -1), (t1, 1), (t0, 1))]))
se['properties']['fromM'] = 154.2; note(se, '아래를 아치로 틈: 154.2 m 위 머리벽만 남김(양 끝 기둥은 X40-PORCH-E-PIER)')
box('X40-PORCH-E-PIER-S', 'wall', along(0.0, 0.45), 151.3, 154.2, '현관 동쪽 옆 아치의 앞쪽 기둥(벽돌)', SRC2, G2, 'Z02-PLATFORM-ENTRANCE', material='brick')
box('X40-PORCH-E-PIER-N', 'wall', along(L2 - 0.45, L2), 151.3, 154.2, '현관 동쪽 옆 아치의 벽 쪽 기둥(벽돌)', SRC2, G2, 'Z02-PLATFORM-ENTRANCE', material='brick')

# ===================== 3·4 문예관 저층부 동쪽 끝: 통 계단, 마당 → 평탄부 계단, 타일 면 =====================
SRC3 = '사용자 편집기 표시 비교-후/사용자표시-문예관앞-타일면-화살표.webp·-통계단.webp, 사진 문예관-저층부-동쪽끝-계단-위에서(학교자료/skuniv-6ab01da5), 구역 노트 X40 절'
G3 = '확정(타일 면 평평·계단까지, 통 계단: 사용자), Claude 결정(높이 145.95 = 카페 데크 윗면, 짜임: 사진), 추정(치수)'
TOPG = shape(BASE['features'].get('g02-way.geojson', {}).get('G02-PLATFORM-TOP', ALL['G02-PLATFORM-TOP'][1])['geometry']).buffer(0)
WAYG = shape(BASE['features'].get('g02-way.geojson', {}).get('G02-PLATFORM-WAY', ALL['G02-PLATFORM-WAY'][1])['geometry']).buffer(0)
FORKG = shape(BASE['features'].get('g02-way.geojson', {}).get('G02-PLATFORM-FORK', ALL['G02-PLATFORM-FORK'][1])['geometry']).buffer(0)
B2G = shape(BASE['features'].get('g02-way.geojson', {}).get('G03-CRAZY-PAVING-BASE-2', ALL['G03-CRAZY-PAVING-BASE-2'][1])['geometry']).buffer(0)
deck_steps = unary_union([SH(i) for i in ALL if i.startswith('G03-CAFE-DECK-STEP')])
S_DECKW = min(sof(x, y) for x, y in deck_steps.exterior.coords) if deck_steps.geom_type == 'Polygon' else min(sof(x, y) for q in deck_steps.geoms for x, y in q.exterior.coords)
S_T = round(S_DECKW + 0.6, 2)                 # 타일 면 서쪽 끝(데크 서쪽 계단과 같은 선)
ZT = 145.95
TILE = TOPG.intersection(half_s(S_T, 200)).union(B2G).buffer(0)
TOPW = TOPG.difference(half_s(S_T, 200)).buffer(0)
WAY_NEW = WAYG.difference(TILE.buffer(0.01)).buffer(0)
# 통 계단(항목 4)
S40, S41, T40, T41 = 66.0, 76.0, 4.6, 11.0
ZF4 = round(way_z(S40), 2); NR4 = 21; R4 = (144.2 - ZF4) / NR4; GO4 = (T41 - T40) / (NR4 - 1)
WELL = FORKG.intersection(QST(S40, S41, T40, T41)).buffer(0)
FORK_NEW = FORKG.difference(QST(S40, S41, T40, T41)).buffer(0)
g02 = FILES['g02-way.geojson']
for i, g in (('G02-PLATFORM-TOP', TOPW), ('G02-PLATFORM-WAY', WAY_NEW), ('G02-PLATFORM-FORK', FORK_NEW)):
    f = F('g02-way.geojson', i); f['geometry'] = geom(g)
    note(f, {'G02-PLATFORM-TOP': f'타일 면(s {S_T} 동쪽)을 X40-PLATFORM-TILE 로 뗌', 'G02-PLATFORM-WAY': '타일 면(옆 계단 발치까지)을 뗌', 'G02-PLATFORM-FORK': '통 계단 자리(t 11 남쪽)를 뗌'}[i])
for i, g, z, txt, mat in (('X40-PLATFORM-TILE', TILE, ZT, f'타일 면: 카페 SP 데크 서쪽 끝(s {S_T}) ~ 대일관 옆 계단 발치, 평평 145.95 m(카페 데크 윗면 = 카페 앞)', 'paving'),
                          ('X40-PLATFORM-FORK-STAIRWELL', WELL, ZF4 - 0.02, '통 계단 자리의 바닥(계단 발치 높이). 위에 계단 상자', 'paving')):
    g02['features'].append({'type': 'Feature', 'properties': {'id': i, 'type': 'platform', 'kind': 'platform', 'estimated': True, 'grade': G3, 'surfaceName': i.replace('PLATFORM-', ''),
        'topM': r2(z), 'bottomM': 139.0, 'bottomNote': '옆 기단보다 아래', 'material': mat, 'assumption': txt, 'source': SRC3}, 'geometry': geom(g)})
CHANGED.add('g02-way.geojson')
for nm, g in (('TOP', TOPW), ('WAY', None), ('FORK', FORK_NEW)):
    s = surface(nm); s['geometry'] = geom(g if g is not None else shape(s['geometry']).buffer(0).difference(TILE.buffer(0.01)))
SURF['features'] += [{'type': 'Feature', 'properties': {'name': 'X40-TILE', 'srid': 5186, 'heightM': ZT, 'reason': 'X40 타일 면(카페 앞 ~ 대일관 옆 계단 발치, 평평)', 'grade': G3, 'source': SRC3}, 'geometry': geom(TILE)},
                     {'type': 'Feature', 'properties': {'name': 'X40-FORK-STAIRWELL', 'srid': 5186, 'heightM': r2(ZF4 - 0.02), 'reason': 'X40 통 계단 자리', 'grade': G3, 'source': SRC3}, 'geometry': geom(WELL)}]
# 조각 돌 포장: 타일 면 안의 조각은 145.95 로, 바탕 둘은 나눔, 옛 경사 바탕 자리에 새 조각
for i, (fn, f) in list(ALL.items()):
    if not i.startswith('G03-CRAZY-PAVING-') or 'BASE' in i: continue
    c = SH(i).centroid
    if TILE.contains(c):
        f = F(fn, i); f['properties']['fromM'] = r2(ZT); f['properties']['toM'] = r2(ZT + 0.02); note(f, '타일 면 145.95 로 올림')
b1 = F('g02-way.geojson', 'G03-CRAZY-PAVING-BASE-1'); b1['geometry'] = geom(shape(b1['geometry']).buffer(0).difference(TILE)); note(b1, f's {S_T} 서쪽(카페 앞 평탄부)만')
drop('g02-way.geojson', lambda i: i == 'G03-CRAZY-PAVING-BASE-2')
SRC3T = SRC3 + ', 옛 조각 돌 포장(G03-CRAZY-PAVING) 무늬'
box('X40-TILE-BASE', 'wall', TILE.difference(TOPG.buffer(0.01)), ZT - 0.02, ZT, '타일 면 줄눈 바탕(옛 경사 바탕 자리)', SRC3T, G3, 'X40-PLATFORM-TILE', color='#8f8a82')
from shapely.ops import voronoi_diagram
rng = np.random.default_rng(40); newz = TILE.difference(TOPG.buffer(0.01)).buffer(0)
mn = newz.bounds; pts = [Point(x, y) for x, y in zip(rng.uniform(mn[0], mn[2], 600), rng.uniform(mn[1], mn[3], 600)) if newz.contains(Point(x, y))]
from shapely.geometry import MultiPoint
cells = voronoi_diagram(MultiPoint(pts), envelope=newz.buffer(2))
for k, cell in enumerate(cells.geoms):
    q = cell.intersection(newz).buffer(-0.045)
    if q.area > 0.05: box(f'X40-TILE-{k + 1:03d}', 'wall', q, ZT, ZT + 0.02, '조각 돌(옛 무늬와 같은 크기, 자리는 지어낸 것)', SRC3T, G3, 'X40-TILE-BASE', color=['#cfc5b6', '#b9ad9c', '#d8d0c3', '#a99d8e'][k % 4])
# 평탄부(145.5) → 타일 면(145.95) 3단: 데크 서쪽 계단 남쪽
T_DECK = min(G.xy_to_st(np.array([x]), np.array([y]))[1][0] for x, y in (deck_steps.exterior.coords if deck_steps.geom_type == 'Polygon' else []))
tlo = min(G.xy_to_st(*np.array(TOPG.exterior.coords).T)[1])
for k in range(2):
    box(f'X40-TILE-STEP-{k + 1}', 'stair_step', QST(S_T - 0.6 + 0.3 * k, S_T - 0.3 + 0.3 * k, tlo, T_DECK - 0.05).intersection(TOPG), 145.3, 145.5 + 0.15 * (k + 1),
        f'카페 앞 평탄부 145.5 → 타일 면 145.95 계단 {k + 1}(데크 서쪽 계단과 같은 선)', SRC3, G3, 'G02-PLATFORM-TOP', stair='X40-TILE-STEP', riseM=0.15, runM=0.3, material='stone')
# 대일관 옆 계단 아랫단 5단(145.95 → 146.67)
s01 = SH('Z02-SIDE-STAIR-S01'); s02 = SH('Z02-SIDE-STAIR-S02'); dv = np.array(s02.centroid.coords[0]) - np.array(s01.centroid.coords[0])
from shapely import affinity
ZS01 = 146.67; RS = (ZS01 - ZT) / 5
cafe_pl = unary_union([SH(i) for i in ALL if i.startswith('G03-CAFE-PLANTER')]).buffer(0.03)
for k in range(1, 6):
    g = affinity.translate(s01, -dv[0] * (6 - k), -dv[1] * (6 - k)).difference(cafe_pl)
    box(f'X40-SIDE-STAIR-LOW-{k}', 'stair_step', g, ZT - 0.1, ZT + RS * k, f'대일관 옆 계단 아랫단 {k}(타일 면 145.95 → 옛 발치 146.67, 한 단 {RS:.3f} m)', SRC3, G3, 'X40-PLATFORM-TILE', stair='Z02-SIDE-STAIR', riseM=r2(RS), runM=0.36, material='stone')
# 통 계단
SRC4 = SRC3; G4 = '확정(폭 전체 계단: 사용자 "통 계단"), 추정(폭 s 66~76, 21단 0.16 m, 디딤 0.32 m)'
drop('g02-way.geojson', lambda i: i.startswith('G02-FORK-STAIR'))
for k in range(1, NR4):
    zt = ZF4 + R4 * k
    box(f'X40-FULL-STAIR-S{k:02d}', 'stair_step', QST(S40 + 0.3, S41 - 0.3, T40 + GO4 * (k - 1), T40 + GO4 * k), ZF4 - 0.3, zt, f'문예관 저층부 앞 통 계단 {k}(길 {ZF4} → 마당 144.2, 폭 9.4 m. 낮은 단은 동쪽으로 오르는 길에 묻힘)', SRC4, G4,
        'X40-PLATFORM-FORK-STAIRWELL / G02-PLATFORM-WAY', stair='X40-FULL-STAIR', riseM=r2(R4), runM=r2(GO4), widthM=9.4, material='stone', color='#cfcac0')
    for side, s0 in (('W', S40), ('E', S41 - 0.3)):
        box(f'X40-FULL-STAIR-CHEEK-{side}{k:02d}', 'wall', QST(s0, s0 + 0.3, T40 + GO4 * (k - 1), T40 + GO4 * k), ZF4 - 0.3, zt + 0.45, '통 계단 양옆 화강석 옆벽', SRC4, G4, 'X40-FULL-STAIR', color='#d8d3c7')
lane2 = F('x36-remaining.geojson', 'X36-UPHILL-TOP-LANE'); lane2['geometry'] = geom(shape(lane2['geometry']).buffer(0).difference(QST(S40, S41, T40, T41 + 1).buffer(0.02)))
note(lane2, '쐐기 화단 앞에서 끝, 통 계단 자리(s 66~76, t 4.6 북쪽)를 뺌')
# 마당(144.2) → 카페 앞 평탄부(145.5) 난간 계단 8단
NR5 = 8; R5 = (145.5 - 144.2) / NR5; S50, S51, T50, T51 = 74.0, 76.0, 12.5, 16.5
for k in range(1, NR5 + 1):
    box(f'X40-FORK-TOP-STAIR-S{k}', 'stair_step', QST(S50 + 0.25 * (k - 1), S50 + 0.25 * k, T50, T51), 144.0, 144.2 + R5 * k, f'차양 앞 마당 144.2 → 카페 앞 평탄부 145.5 난간 계단 {k}(사진의 오른쪽 위로 오르는 계단)', SRC3, G3, 'G02-PLATFORM-FORK',
        stair='X40-FORK-TOP-STAIR', riseM=r2(R5), runM=0.25, widthM=4.0, material='stone', color='#cfcac0')
    for side, t0 in (('S', T50 - 0.12), ('N', T51)):
        box(f'X40-FORK-TOP-RAIL-{side}{k}', 'wall', QST(S50 + 0.25 * (k - 1), S50 + 0.25 * k, t0, t0 + 0.12), 144.2 + R5 * k + 0.85, 144.2 + R5 * k + 0.95, '검은 쇠 난간 손잡이(사진)', SRC3, G3, 'X40-FORK-TOP-STAIR', color='#2b2d30')
        if k in (1, 4, 8): box(f'X40-FORK-TOP-RAILPOST-{side}{k}', 'wall', QST(S50 + 0.25 * k - 0.1, S50 + 0.25 * k, t0, t0 + 0.12), 144.2 + R5 * k, 144.2 + R5 * k + 0.85, '난간 기둥', SRC3, G3, 'X40-FORK-TOP-STAIR', color='#2b2d30')

# ===================== 5 대일관 동쪽 끝: 작은 계단 돌리기, 청운관 떠 있는 화단 둥글게 =====================
SRC5 = '사진 청운관-정면-운동장에서-상승관계단.webp·대일관-정면-운동장에서-상승관계단표시.webp(확대), 항공-대일관앞-원본(D23 변환), 사용자 2026-10-22 꺾은선'
G5 = '확정(정면 계단·옆 화단·참 뒤로 오르는 계단: 사진·사용자), 추정(치수)'
NR6 = 12; GO6 = (4.6 - 1.2) / NR6
for k in range(1, NR6 + 1):
    f = F('x22-photo-fixes.geojson', f'X22-SANGSEUNG-STAIR-S{k:02d}')
    f['geometry'] = geom(QUV(54.0, 57.0, -1.2 - GO6 * k, -1.2 - GO6 * (k - 1))); f['properties']['runM'] = r2(GO6)
    note(f, '참에서 뒤쪽(-v)으로 곧게 오르게 돌림(사진: 참 위에서 뒤로 더 오름)')
ch = F('x22-photo-fixes.geojson', 'X22-SANGSEUNG-STAIR-CHEEK'); ch['geometry'] = geom(QUV(57.0, 57.2, -3.9, -1.2)); note(ch, '계단 동쪽 옆으로(위 끝 0.7 m 는 마당으로 트임)')
ph = F('b15-cheongun.geojson', 'B15-CHEONGUN-PORCH-PLANTER-HIGH')
c0, c1, c2, c3 = [np.array(p) for p in BASE['features']['b15-cheongun.geojson']['B15-CHEONGUN-PORCH-PLANTER-HIGH']['geometry']['coordinates'][0][:4]]
mA, mB = (c0 + c3) / 2, (c1 + c2) / 2; mid = (mA + mB) / 2; dr = (mB - mA) / np.linalg.norm(mB - mA)
lobes = unary_union([disc(tuple(mid + dr * 1.3), 1.85, 32), disc(tuple(mid - dr * 1.3), 1.85, 32)])
lobes = lobes.difference(blockers(lobes, 150.4, 152.2, skip=('B15-CHEONGUN-PORCH-PLANTER-HIGH',)).buffer(0.03)).buffer(0)
ph['geometry'] = geom(max(lobes.geoms, key=lambda q: q.area) if lobes.geom_type == 'MultiPolygon' else lobes)
note(ph, '둥근 두 굽이(지름 3.7 m 원 둘, 항공사진의 짙은 초록 덩어리·사진의 둥근 돌 통)')
# 나무: 이 화단에는 B15 의 소나무가 이미 있고 위가 현관 판이라 더하지 않음

# ===================== 6 은주1관 정면 두 갈래 곡선 계단 =====================
SRC6 = '사진 사진/은주1관-정면-바위정원-곡선계단.webp, 카카오 항공 항공-카카오-은주관-한림관-풋살파크.webp(X27 항공사진에 특징점 1,427개로 맞춤), 건물 노트 은주관 X40 절'
G6 = '확정(짜임: 위 두 줄 → 가운데 참·둥근 화단 → 아래 두 줄, 난간: 사진), 항공사진(반원 자리), Claude 결정(높이 128.9·단 수), 추정(치수)'
TC = np.array([201119.6, 557253.0]); WD = np.array([2.0, 11.3]); WD = WD / np.linalg.norm(WD); ND = np.array([-WD[1], WD[0]])   # ND = 정면에서 바깥(서)
if ND[0] > 0: ND = -ND
def PP(r, phi): a = math.radians(phi); return tuple(TC + r * (math.cos(a) * ND + math.sin(a) * WD))
def sector(r0, r1, p0, p1, n=None):
    n = n or max(4, int(abs(p1 - p0) / 2))
    ph = np.linspace(p0, p1, n + 1)
    return Polygon([PP(r1, p) for p in ph] + [PP(r0, p) for p in ph[::-1]]) if r0 > 0 else Polygon([tuple(TC)] + [PP(r1, p) for p in ph])
def NW(n0, n1, w0, w1): return Polygon([tuple(TC + ND * a + WD * b) for a, b in ((n0, w0), (n1, w0), (n1, w1), (n0, w1))])
ZTOP, ZW, ZB = 131.3, 128.9, 125.6
x27 = 'x27-hanlim-front.geojson'
drop(x27, lambda i: i.startswith(('X27-EUNJU-TERRACE',)))
# 북쪽 아랫줄: X27 곡선 돌계단 41 조각을 24단으로 묶고 128.9 에서 끝
xs = sorted([i for i in ALL if i.startswith('X27-EUNJU-STAIR-S')])
NL = 24; Z0L = 125.2; RL = (ZW - Z0L) / NL
northstair = []
for j in range(NL):
    ids = xs[int(round(j * len(xs) / NL)):int(round((j + 1) * len(xs) / NL))]
    zt = Z0L + RL * (j + 1)
    for i in ids:
        f = F(x27, i); f['properties']['toM'] = r2(zt); f['properties']['riseM'] = r2(RL); northstair.append(SH(i))
        note(f, f'북쪽 아랫줄: 굽이 125.2 → 가운데 참 128.9, {NL}단 중 {j + 1}')
        for side, extra in (('W', 1.0), ('E', 0.5)):
            wid = i.replace('STAIR-S', f'STAIR-WALL-{side}-')
            if wid in ALL: w = F(x27, wid); w['properties']['toM'] = r2(zt + extra); note(w, '계단 높이에 맞춤')
NS = unary_union(northstair + [SH(i.replace('STAIR-S', f'STAIR-WALL-{sd}-')) for i in xs for sd in 'WE' if i.replace('STAIR-S', f'STAIR-WALL-{sd}-') in ALL]).buffer(0.02)
semi = sector(0, 6.0, -90, 90, 90)
# 위 테라스(131.3): 정면 벽 앞 띠
TERR = NW(0, 1.6, -6.0, 6.0).intersection(semi.buffer(0.01)).union(sector(0, 6.0, 85, 90)).union(sector(0, 6.0, -90, -85)).buffer(0)
TERR = TERR.difference(blockers(TERR, 125.6, 131.3).buffer(0.02)).buffer(0)
box('X40-EUNJU-TERRACE', 'landing', TERR, ZB, ZTOP, '은주1관 아치 문 앞 위 테라스(131.3 m = 입구(1) 1층 바닥). 곡선 계단 두 줄이 양 끝에서 내려간다', SRC6, G6, 'X27-PLATFORM-EUNJU-TERRACE-BASE', color='#cbbfae')
# 위 두 줄 곡선 계단: r 3.2~4.8, φ ±10 → ±85, 15단
NU = 15; RU = (ZTOP - ZW) / NU
for side, sg_ in (('N', 1), ('S', -1)):
    for k in range(1, NU + 1):
        p0 = 10 + (75 / NU) * (k - 1); p1 = 10 + (75 / NU) * k
        zt = ZW + RU * k
        st_ = sector(3.4, 4.6, sg_ * p0, sg_ * p1, 3).difference(TERR)
        box(f'X40-EUNJU-UPSTAIR-{side}{k:02d}', 'stair_step', st_, ZB, zt, f'위 {"북" if sg_ > 0 else "남"}쪽 곡선 계단 {k}(가운데 참 128.9 → 위 테라스 131.3, {NU}단)', SRC6, G6, 'X27-PLATFORM-EUNJU-TERRACE-BASE',
            stair=f'X40-EUNJU-UPSTAIR-{side}', riseM=r2(RU), runM=0.33, widthM=1.2, color='#cfcac0', material='stone')
        for nm, r0, r1 in (('IN', 3.2, 3.4), ('OUT', 4.6, 4.8)):
            box(f'X40-EUNJU-UPSTAIR-RAIL-{side}{nm}{k:02d}', 'wall', sector(r0, r1, sg_ * p0, sg_ * p1, 3).difference(TERR), ZB, zt + 0.9,
                '밝은 화강석 난간벽(곡선 계단 양옆)', SRC6, G6, 'X27-PLATFORM-EUNJU-TERRACE-BASE', color='#e3dfd5')
# 가운데 참(128.9): r 4.8~7.2 φ ±45 + r 3.2~4.8 φ ±10
LAND = sector(4.8, 7.2, -45, 45).union(sector(3.2, 4.8, -10, 10)).difference(NS).buffer(0)
LAND = LAND.difference(blockers(LAND, 125.0, 128.9).buffer(0.02)).buffer(0)
box('X40-EUNJU-LANDING', 'landing', LAND, 124.9, ZW, '가운데 참(128.9 m): 위 두 줄이 내려와 만나고 아래 두 줄(북: 곡선 돌계단, 남: 차도로)이 벌어져 내려간다', SRC6, G6, 'X27-PLATFORM-EUNJU-TERRACE-BASE / X27-PLATFORM-EUNJU-STAIR-BED', color='#cbbfae')
RP = disc(PP(6.4, 0), 0.8, 24)
box('X40-EUNJU-ROUND-PLANTER', 'planter', RP, ZW, ZW + 0.7, '가운데 참 앞 가장자리 둥근 돌 화단(나무 한 그루, 사진)', SRC6, G6, 'X40-EUNJU-LANDING', color='#d6d0c4', topColor='#6f8a55')
tree('X40-EUNJU-ROUND-TREE', PP(6.4, 0), ZW + 0.7, 'X40-EUNJU-ROUND-PLANTER', SRC6, G6, h=0.8)
for nm, p0, p1 in (('N', 6, 32), ('S', -32, -6)):
    box(f'X40-EUNJU-LANDING-RAIL-{nm}', 'wall', sector(7.0, 7.2, p0, p1), ZW, ZW + 0.9, '가운데 참 바깥 난간벽(아래 두 줄 자리는 트임)', SRC6, G6, 'X40-EUNJU-LANDING', color='#e3dfd5')
# 위 두 줄 사이 타원 화단(r < 3.2)
OVAL = sector(0, 3.2, -88, 88).difference(TERR).buffer(0)
box('X40-EUNJU-OVAL-PLANTER', 'planter', OVAL, ZB, ZW + 0.5, '위 두 줄 곡선 계단 사이 낮은 화단(소나무 여럿, 사진)', SRC6, G6, 'X27-PLATFORM-EUNJU-TERRACE-BASE', color='#d6d0c4', topColor='#5f7f45')
for k, (r, p) in enumerate(((2.5, 15), (2.5, -15))): tree(f'X40-EUNJU-OVAL-PINE-{k + 1}', PP(r, p), ZW + 0.5, 'X40-EUNJU-OVAL-PLANTER', SRC6, G6, h=0.7, cr=0.6)
# 위 테라스 난간(가운데, 계단 머리는 트임)과 둥근 화분 둘
box('X40-EUNJU-TERRACE-RAIL', 'wall', NW(1.6, 1.8, -3.0, 3.0), ZTOP, ZTOP + 0.9, '위 테라스 가장자리 돌 난간(가운데 화단 쪽)', SRC6, G6, 'X40-EUNJU-TERRACE', color='#e3dfd5')
for k, w in enumerate((2.3, -2.3)):
    box(f'X40-EUNJU-TERRACE-POT-{k + 1}', 'planter', disc(tuple(TC + ND * 0.8 + WD * w), 0.6, 16), ZTOP, ZTOP + 0.6, '아치 문 앞 둥근 돌 화분(소나무, 사진)', SRC6, G6, 'X40-EUNJU-TERRACE', color='#d6d0c4', topColor='#6f8a55')
    tree(f'X40-EUNJU-TERRACE-PINE-{k + 1}', tuple(TC + ND * 0.8 + WD * w), ZTOP + 0.6, f'X40-EUNJU-TERRACE-POT-{k + 1}', SRC6, G6, h=0.7, cr=0.5)
# 남쪽 아랫줄: 참 남쪽 끝(φ −40, r 6) → 차도 가장자리
def top_platform(x, y, want=''):
    best = None
    for i, (fn, f) in ALL.items():
        p = f['properties']
        if p.get('kind') != 'platform' or i.startswith('X40-') or not i.startswith(want) or not SH(i).contains(Point(x, y)): continue
        pr = p.get('topProfile')
        if pr: Lp = math.hypot(*pr['direction']); d = ((x - pr['origin'][0]) * pr['direction'][0] + (y - pr['origin'][1]) * pr['direction'][1]) / Lp; z = float(np.interp(d, [q[0] for q in pr['points']], [q[1] for q in pr['points']]))
        else: z = p['topM']
        if best is None or z > best[0]: best = (z, i)
    return best
SA = np.array(PP(6.6, -42)); SE = np.array([201111.2, 557248.4])
ZR, road_id = top_platform(*SE, 'Z05-PLATFORM-UPPER-U1')
NSL = max(2, int(round((ZW - ZR) / 0.16))); RSL = (ZW - ZR) / NSL
dS = SE - SA; LS = float(np.linalg.norm(dS)); uS = dS / LS; pS = np.array([-uS[1], uS[0]])
def QS(a0, a1, b0, b1): return Polygon([tuple(SA + uS * a + pS * b) for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))])
beds = unary_union([SH(i) for i in ALL if i.startswith('X27-EUNJU-BED')]).buffer(0.02)
for k in range(1, NSL + 1):
    a0_ = LS - (LS / (NSL + 1)) * (k + 1); a1_ = LS - (LS / (NSL + 1)) * k
    box(f'X40-EUNJU-LOWSTAIR-S-{k:02d}', 'stair_step', QS(a0_, a1_, -1.0, 1.0).difference(beds).difference(LAND.buffer(0.01)), ZR - 0.3, ZR + RSL * k, f'남쪽 아랫줄 {k}(가운데 참 128.9 → 위쪽 갈래 차도 {ZR:.2f}, {NSL}단)', SRC6, G6, road_id,
        stair='X40-EUNJU-LOWSTAIR-S', riseM=r2(RSL), runM=r2(LS / (NSL + 1)), widthM=2.0, color='#cfcac0', material='stone')
for nm, b0, b1 in (('A', -1.2, -1.0), ('B', 1.0, 1.2)):
    box(f'X40-EUNJU-LOWSTAIR-S-RAIL-{nm}', 'wall', QS(LS / (NSL + 1), LS, b0, b1).difference(beds).difference(LAND.buffer(0.01)), ZR - 0.3, ZW + 0.9, '남쪽 아랫줄 난간벽', SRC6, G6, road_id, color='#e3dfd5')
X6 = {'TC': TC.tolist(), 'ND': ND.tolist(), 'WD': WD.tolist(), 'landingZ': ZW, 'terraceZ': ZTOP, 'southFoot': [r2(c) for c in SE], 'southFootZ': r2(ZR), 'southTop': [r2(c) for c in SA],
      'upN': [[r2(c) for c in PP(4.0, p)] for p in (10, 30, 50, 70, 85)], 'upS': [[r2(c) for c in PP(4.0, -p)] for p in (10, 30, 50, 70, 85)], 'door': [r2(c) for c in TC + ND * 0.4]}

# ===================== 7 본관·한림관 사이 중간 옥상 마당(카카오 항공사진) =====================
SRC7 = '사용자 항공 항공/항공-카카오-한림관-중간옥상.webp(X27 항공사진에 특징점 673개로 맞춤 georef-more.json), 사진 15(둥근 벽돌 화단 둘·뒤 긴 화단·오른쪽 콘크리트 난간벽)'
G7 = '확정(옥상 마당 자리: 사용자), 항공사진(화단 자리 ±1.5 m), 추정(크기)'
x22 = 'x22-photo-fixes.geojson'
YARD = SH('X22-ROOF-YARD-FLOOR'); ZD = 137.8
for k, (c, r) in enumerate((((201098.6, 557296.3), 1.0), ((201095.6, 557295.8), 0.8))):
    d_ = disc(c, r).intersection(YARD)
    f = F(x22, f'X22-ROOF-YARD-PLANTER-ROUND-{k + 1}'); f['geometry'] = geom(d_); note(f, '카카오 항공사진의 둥근 덩어리 자리로 옮김')
    for part, hh in (('TRUNK', 0.12), ('CROWN', 0.8), ('TOP', 0.45)):
        f = F(x22, f'X22-ROOF-YARD-TREE-{k + 1}-{part}'); f['geometry'] = geom(disc(c, hh, 4)); note(f, '화단과 함께 옮김')
box('X40-ROOF-YARD-PARAPET-E', 'wall', LineString([(201101.2, 557286.0), (201101.17, 557288.41), (201100.77, 557289.05)]).buffer(0.15, cap_style=2).intersection(YARD), ZD, ZD + 1.0,
    '동쪽 끝(원통 남서쪽, 낮은 틈 쪽으로 트인 곳) 콘크리트 난간벽(사진 15 오른쪽)', SRC7, G7, 'X22-ROOF-YARD-FLOOR', color='#c4c2bb')

# ===================== 본관 사진(X37·X40·X44·X46, 비교4) =====================
SRCB = '사진 본관-서쪽-위에서.webp(2026-10-23, 찍은 자리 (200994.9, 557307.2) 약 148 m, 비교4), 건물 노트 본관 2026-10-23 절'
GB = '원천(사진: 있음), 추정(치수·자리)'
BONG = [Polygon(b['coordinates'][0][0]) for b in G.buildings() if b['name'] == '본관'][0]
WALL = BONG.buffer(-1.5, join_style=2)                      # 처마 깊이 1.5 m 안쪽이 벽(겉모습 지붕.처마_깊이)
# X37 유리 층 앞 검은 쇠 난간(보 위 148.3 ~ 149.4)
box('X40-BONGWAN-GLASS-RAIL', 'wall', WALL.buffer(0.12, join_style=2).difference(WALL.buffer(0.04, join_style=2)), 148.3, 149.4, '맨 위 유리 층 앞 검은 쇠 난간(돌 처마띠 위, 사진)', SRCB, GB, '본관', color='#202224')
# X40 서쪽 끝 면: 세로 두 줄의 둥근 머리 작은 창(가운데 한 줄 4, 남서 모서리 쪽 한 줄 3)
wa = np.array([201033.4, 557319.4]); wb = np.array([201044.7, 557344.2]); wd = (wb - wa) / np.linalg.norm(wb - wa); wn = np.array([-wd[1], wd[0]])
if Point(*(wa + wd * 13 + wn * 3)).within(BONG): wn = -wn     # wn = 바깥(서)
w0 = wa + wn * -1.5                                          # 벽 선 위 남쪽 끝(대략)
Lw = float(np.linalg.norm(wb - wa))
for col, (frac, zs) in enumerate(((0.5, (132.4, 136.1, 139.8, 143.5)), (0.17, (136.1, 139.8, 143.5)))):
    for k, z in enumerate(zs):
        c = w0 + wd * (Lw * frac)
        win = Polygon([tuple(c + wd * a + wn * b) for a, b in ((-0.45, -0.02), (0.45, -0.02), (0.45, 0.1), (-0.45, 0.1))])
        box(f'X40-BONGWAN-WEST-WIN-{col + 1}{k + 1}', 'wall', win, z, z + 1.4, '서쪽 끝 면 둥근 머리 작은 창(어두운 유리, 머리는 네모로 줄임)', SRCB, GB, '본관', color='#2f3a44')
# X46 회차 공간 어귀 아스팔트: 포장면(회차 공간) 위에 걸친 부분이 길 기울기를 따라 솟아 덩어리로 보이던 것 → 포장면 기울기를 따르는 얇은 판으로
apr = F('g02-way.geojson', 'G03-PAINT-APRON'); ag = shape(BASE['features']['g02-way.geojson']['G03-PAINT-APRON']['geometry']).buffer(0)
TP = ALL['Z05-PLATFORM-TURN-PLAZA'][1]['properties']; TPG = SH('Z05-PLATFORM-TURN-PLAZA')
on_plaza = ag.intersection(TPG).buffer(0)
apr['geometry'] = geom(ag.difference(TPG.buffer(0.01))); note(apr, '회차 공간 포장면 위 부분은 X40-PAINT-APRON-PLAZA 로 뗌(포장면 기울기)')
if on_plaza.area > 0.05:
    pp = copy.deepcopy(TP['topProfile']); pp['points'] = [[q[0], r2(q[1] + 0.03)] for q in pp['points']]
    f = box('X40-PAINT-APRON-PLAZA', 'wall', on_plaza, min(q[1] for q in pp['points']) - 0.03, max(q[1] for q in pp['points']), '어귀의 검은 아스팔트 중 회차 공간 포장면 위 부분(포장면과 같은 기울기의 얇은 판, 사진: 평평한 아스팔트)', SRCB + ', 거리뷰 21', GB,
            'Z05-PLATFORM-TURN-PLAZA', color='#26282b')
    f['properties'].update(topProfile=pp, thicknessM=0.03)
def plaza_z(x, y):
    pr = TP['topProfile']; Lp = math.hypot(*pr['direction']); d = ((x - pr['origin'][0]) * pr['direction'][0] + (y - pr['origin'][1]) * pr['direction'][1]) / Lp
    return float(np.interp(d, [q[0] for q in pr['points']], [q[1] for q in pr['points']]))
# X44 장애인 주차 칸(파란 바닥, 휠체어 표시, 옆 빗금 칸)과 파란 안내 표지 기둥: 전화 부스 화단 서쪽
pc = np.array([201031.0, 557341.0]); pu = np.array([math.sin(math.radians(115.6)), math.cos(math.radians(115.6))]); pv = np.array([-pu[1], pu[0]])   # pu = 칸 긴 쪽(화단 쪽, 본관 긴 축과 나란)
def QP(a0, a1, b0, b1): return Polygon([tuple(pc + pu * a + pv * b) for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))])
zp = plaza_z(*pc); pp2 = copy.deepcopy(TP['topProfile']); pp2['points'] = [[q[0], r2(q[1] + 0.02)] for q in pp2['points']]
def paint(id, poly, what, color, lift=0.02):
    pr = copy.deepcopy(TP['topProfile']); pr['points'] = [[q[0], r2(q[1] + lift)] for q in pr['points']]
    f = box(id, 'wall', poly, min(q[1] for q in pr['points']) - 0.02, max(q[1] for q in pr['points']), what, SRCB + ', 구역 노트 회차 공간 P01 "아직 없는 것"', '원천(사진: 있음), 추정(자리 ±4 m·크기)', 'Z05-PLATFORM-TURN-PLAZA', color=color)
    if f: f['properties'].update(topProfile=pr, thicknessM=0.02)
paint('X40-DISABLED-BAY', QP(-2.5, 2.5, -1.65, 1.65), '장애인 주차 칸 파란 바닥(5.0 x 3.3 m)', '#2f6db5')
paint('X40-DISABLED-BAY-SIGN', QP(-0.6, 0.6, -0.6, 0.6), '바닥의 흰 휠체어 표시(네모로 줄임)', '#f2f2ee', 0.035)
for k in range(5):
    paint(f'X40-DISABLED-BAY-HATCH-{k + 1}', QP(-2.5 + 1.0 * k, -2.5 + 1.0 * k + 0.25, 1.75, 3.15), '옆 빗금 칸(흰 빗금, 곧은 띠로 줄임)', '#f2f2ee')
for nm, b0 in (('A', -1.75), ('B', 3.15)):
    paint(f'X40-DISABLED-BAY-LINE-{nm}', QP(-2.5, 2.5, b0, b0 + 0.1), '칸 흰 테두리', '#f2f2ee')
post = tuple(pc + pu * 3.0)
box('X40-DISABLED-SIGN-POST', 'wall', disc(post, 0.05, 8), zp - 0.1, zp + 2.6, '파란 안내 표지 기둥(회색 쇠기둥)', SRCB, '원천(사진: 있음), 추정(자리)', 'Z05-PLATFORM-TURN-PLAZA', color='#8a8d90')
box('X40-DISABLED-SIGN-PLATE', 'wall', Polygon([tuple(np.array(post) + pv * a + pu * b) for a, b in ((-0.3, 0.06), (0.3, 0.06), (0.3, 0.1), (-0.3, 0.1))]), zp + 1.9, zp + 2.5, '파란 장애인 주차 안내 판', SRCB, '원천(사진: 있음), 추정(자리)', 'X40-DISABLED-SIGN-POST', color='#2f6db5')

# ---------- 겹침 정리: 새 상자는 높이가 겹치는 다른 상자 자리를 비우고, 나무는 겹치면 뺀다 ----------
def zr(p):
    lo, hi = p['fromM'], p['toM']
    if p.get('topProfile'): zs = [q[1] for q in p['topProfile']['points']]; hi = max(zs); lo = p.get('bottomM', lo)
    return lo, hi
fam = lambda i: i.rsplit('-', 1)[0]
done = []
for f in FEATS:
    p = f['properties']; g = shape(f['geometry']).buffer(0); lo, hi = zr(p)
    others = [shape(o['geometry']).buffer(0) for o in done if not (o['properties'].get('stair') and o['properties'].get('stair') == p.get('stair')) and o['properties']['id'] != p.get('basePlane')
              and p['id'] != o['properties'].get('basePlane') and zr(o['properties'])[1] > lo + 0.05 and zr(o['properties'])[0] < hi - 0.05 and o['properties']['type'] != 'tree']
    blk = blockers(g, lo + 0.05, hi - 0.05, skip=('P02-FIELD-STRIPE', 'G03-PAINT', p.get('basePlane') or '#none'), und=True).union(unary_union(others) if others else Polygon())
    if p['type'] == 'tree':
        if g.intersection(blk).area > 0.01 or any(g.intersection(shape(o['geometry']).buffer(0)).area > 0.01 for o in done if o['properties']['type'] == 'tree' and fam(o['properties']['id']) != fam(p['id']) and zr(o['properties'])[1] > lo and zr(o['properties'])[0] < hi):
            p['_drop'] = True
        else: done.append(f)
        continue
    if not blk.is_empty and g.intersection(blk).area > 0.01:
        g2 = g.difference(blk.buffer(0.02)).buffer(0)
        if g2.area < 0.02: p['_drop'] = True; continue
        f['geometry'] = geom(g2)
    done.append(f)
# 나무: 한 그루의 한 부분이 빠지면 그 그루 전체를 뺀다
gone = {f['properties']['id'].rsplit('-', 1)[0] for f in FEATS if f['properties'].get('_drop') and f['properties']['type'] == 'tree'}
FEATS = [f for f in FEATS if not f['properties'].pop('_drop', False) and not (f['properties']['type'] == 'tree' and f['properties']['id'].rsplit('-', 1)[0] in gone)]
print('뺀 나무', sorted(gone))

# ---------- 쓰기 ----------
FEATS_OUT = {'type': 'FeatureCollection', 'name': 'x40-parts', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': FEATS}
dump(STR / OWN, FEATS_OUT)
for fn in sorted(CHANGED): dump(STR / fn, FILES[fn])
dump(REC / 'g02-surface.geojson', SURF)
dump(BASEF, BASE)
model = {'tile': {'sWest': S_T, 'z': ZT, 'stairFootOld': ZS01}, 'fullStair': {'s': [S40, S41], 't': [T40, T41], 'footZ': ZF4, 'risers': NR4, 'rise': r2(R4)},
         'forkTop': {'s': [S50, S51], 't': [T50, T51]}, 'eunju1': X6, 'wedgeArea': r2(W1.area)}
dump(HERE / 'model.json', model)
print('상자', len(FEATS), '고친 파일', sorted(CHANGED), '쐐기 화단', round(W1.area, 1), '㎡, 타일 면', round(TILE.area, 1), '㎡, s', S_T, '통 계단 발치', ZF4, '남쪽 아랫줄', NSL, '단', road_id, round(ZR, 2))
