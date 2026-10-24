"""R2(2026-10-25): 지상 오르막·본관·북악관·문예관 둘레를 전수 판독 R2 대로 고친다. DB·네트워크 접근 없음.   python -X utf8 build_parts.py
근거: 볼트 데이터/보완자료/학교-전경-20261022/전수판독/R2/판독.md(보완 목록 B1~B9, 그림 01·20·21·03),
  구역 노트 오르막길과 주변·북악관 앞 회차 공간과 본관 앞, 동 노트 본관·북악관·문예관의 "2026-10-25 R2 전수 판독 반영" 절.
옛 생성 스크립트(g02/build_inputs.py, x36·x40/build_parts.py)는 뒤 작업이 같은 파일을 id 로 고쳐 다시 돌릴 수 없다. 그래서 d25·r1 처럼 id 로 고친다.
처음 실행 때 고치는 지물의 원본을 base.json 에 남기고, 다음 실행은 원본에서 다시 시작한다(몇 번 돌려도 같다. r1/build_parts.py 다음에 돌린다).

실제 축 s', t'(판독 R2): 원점 (201042.26, 557346.46) = 남쪽 옹벽 머릿돌 선, 방향 (0.91395, -0.40582) = 방위 113.94°, t' 북쪽 +.
모델 축 s, t(g02/common.py, 본관 북벽과 나란한 116.18°)로 놓인 단면을 실제 축으로 옮긴다.
고치는 파일(frontend/public/structures):
  g02-way.geojson      B1 옹벽·LED·화단·인도·연석·차로 칠·노면 글자·로고·북쪽 화단·나무를 실제 축 단면으로(t' 만 옮김, s' 와 높이 그대로),
                       B2 윗구간 옹벽 C·LED C·화단 C·판 C·연석 S2 를 15.5 m 띠 안으로, B6 차단기·말뚝, B8 노란 함, B5 테라스 기단 계단 자리,
                       B4 차양 앞 마당 기단(FORK)·통 계단 바닥 기단
  x22-photo-fixes      가로등(B1 화단을 따라)
  x36-remaining        B2 차로 칠(t' 2.65~6.25 만), B7 둥근 끝, B5 북악관–문예관 사이 계단 t' +1.0
  x40-parts            쐐기 화단·소나무(B2), 옛 통 계단(X40-FULL-STAIR-*) 걷음, 장애인 칸 칠 다시(U03 이 칸 밖으로 나가 깎을 것이 없음)
  u03-underground-walk B3 U03 계단 빈 곳·유리문 앞 바닥·유리문을 전화부스 화단 밑으로
  r2-uphill.geojson    (새) 윗구간 남·북 인도·북쪽 연석·들머리 포장, B4 통 계단(아랫단 9 → 참 → 윗단 11)·옆벽·동쪽 화단, U03 이음 빈 곳
backend/data/terrain/recipes/g02-surface.geojson: PODIUM·X36-PODIUM-STAIRWELL·FORK·X40-FORK-STAIRWELL 외곽.
높이는 기단 윗면(모델 축 s 의 함수, 그대로)에서 온다."""
import json, math, pathlib, copy
import numpy as np
from shapely.geometry import Polygon, Point, LineString, MultiPolygon, shape
from shapely.ops import unary_union
from shapely import affinity

HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
STR = REPO / 'frontend' / 'public' / 'structures'; REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'
BASEF = HERE / 'base.json'
r2 = lambda v: round(float(v), 2)
OUT = 'r2-uphill.geojson'
SRC = '판독 보완자료/학교-전경-20261022/전수판독/R2/판독.md(S-MAP 정사 10, S-MAP 0.5 m 메시, 전경 영상 0.25 s 프레임, 사진 04·05·06·08, 거리뷰 21·23)'
G_AX = '확정(축·옹벽: 정사 흰 줄 + 메시), 추정(단면 폭 ±0.3~0.5 m)'
G_EST = '추정(판독 R2: 한 자료·눈대중)'

# ---------- 축 ----------
OM = np.array([201044.0, 557350.0]); U = np.array([60.0, -29.5]); U = U / np.hypot(*U); NM = np.array([-U[1], U[0]])
O = np.array([201042.26, 557346.46]); A = np.array([0.91395, -0.40582]); A = A / np.hypot(*A); N = np.array([-A[1], A[0]])
def P(s, t): return O + A * s + N * t
def ST(p): d = np.asarray(p, float) - O; return float(d @ A), float(d @ N)
def MST(p): d = np.asarray(p, float) - OM; return float(d @ U), float(d @ NM)
def R(s0, s1, t0, t1): return Polygon([tuple(P(s, t)) for s, t in ((s0, t0), (s1, t0), (s1, t1), (s0, t1))])
WAYP = [(-3.5, 130.96), (20.0, 133.75), (55.0, 138.95), (100.0, 146.68), (110.0, 148.9)]   # G02-PLATFORM-WAY topProfile(모델 축 s)
def way(p): return float(np.interp(MST(p)[0], *zip(*WAYP)))
def way_st(s, t): return way(P(s, t))
def way_prof(off, upto=130.0):
    pts = [[s, r2(z + off)] for s, z in WAYP] + [[upto, r2(WAYP[-1][1] + off)]]
    return {'origin': [OM[0], OM[1]], 'direction': [float(U[0]), float(U[1])], 'points': pts}
def prof_z(pr, x, y):
    d = np.array(pr['direction'], float); L = float(np.hypot(*d)); t = ((x - pr['origin'][0]) * d[0] + (y - pr['origin'][1]) * d[1]) / L
    ps = pr['points']; return float(np.interp(t, [q[0] for q in ps], [q[1] for q in ps]))

# ---------- 파일 ----------
FILES = ['g02-way.geojson', 'x22-photo-fixes.geojson', 'x36-remaining.geojson', 'x40-parts.geojson', 'u03-underground-walk.geojson']
D = {fn: json.loads((STR / fn).read_text(encoding='utf-8')) for fn in FILES}
SURF = json.loads((REC / 'g02-surface.geojson').read_text(encoding='utf-8'))
def dump(path, obj): path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
# 다시 돌릴 때: 원본으로 되돌리고 R2 가 만든 것(R2-*)을 걷는다
BASE = json.loads(BASEF.read_text(encoding='utf-8')) if BASEF.exists() else None
if BASE:
    for fn in FILES:
        orig = BASE['features'].get(fn, {})
        feats = [f for f in D[fn]['features'] if not f['properties']['id'].startswith('R2-')]
        have = {f['properties']['id'] for f in feats}
        feats = [copy.deepcopy(orig[f['properties']['id']]) if f['properties']['id'] in orig else f for f in feats]
        feats += [copy.deepcopy(f) for i, f in orig.items() if i not in have]
        D[fn]['features'] = feats
    SURF['features'] = [s for s in SURF['features'] if s['properties']['name'] not in BASE['surface']] + [copy.deepcopy(s) for s in BASE['surface'].values()]
IDX = {}
def reindex():
    IDX.clear()
    for fn in FILES:
        for f in D[fn]['features']: IDX[f['properties']['id']] = (fn, f)
reindex()
def F(i): return IDX[i][1]
def SH(i): return shape(F(i)['geometry']).buffer(0)
def ids(pred): return sorted(i for i in IDX if pred(i))

# 고치는 지물(원본 보관 대상)
def is_warp(i):
    return (any(i.startswith(p) for p in ('G03-SWALL-A', 'G03-SWALL-B', 'G03-SWALL-LED-A', 'G03-SWALL-LED-B', 'G03-SBED-A', 'G03-SBED-B', 'G03-SIDEWALK-S1', 'G03-SIDEWALK-S2',
            'G03-KERB-S1', 'G03-KERB-S2', 'G03-SIDEWALK-N1', 'G03-KERB-N1', 'G03-PAINT-LANE-', 'G03-LOGO-', 'G03-TREE-S', 'G03-NPLANT-A', 'G03-NPLANT-B', 'G03-NPLANT-C',
            'G03-TREE-NA', 'G03-TREE-NB', 'G03-TREE-NC', 'G03-TREE-ND', 'G02-NPLANT-D', 'R02-TREE-SB', 'X22-LAMP-UPN-', 'X22-LAMP-UPS-', 'X40-WEDGE-PLANTER', 'X40-WEDGE-PINE-')))
UPPER = ['G03-SWALL-C', 'G03-SWALL-LED-C', 'G03-SBED-C', 'G03-SLAB-C']
OTHER = ['X36-UPHILL-TOP-LANE', 'X36-FORK-PLANTER-ROUNDEND', 'G03-GRIT-BIN', 'G02-PLATFORM-PODIUM', 'G02-X36-PLATFORM-PODIUM-STAIRWELL', 'G02-PLATFORM-FORK',
         'X40-PLATFORM-FORK-STAIRWELL', 'U03-VOID-STEPS', 'U03-VOID-LOBBY', 'U03-GLASS-DOOR']
TOUCH = ids(is_warp) + UPPER + OTHER + ids(lambda i: i.startswith('G03-BARRIER-') or i.startswith('G03-BOLLARD-') or i.startswith('X36-PODIUM-STAIR-')
                                         or i.startswith('X40-FULL-STAIR-') or i.startswith('X40-DISABLED-'))
SURF_TOUCH = ['PODIUM', 'X36-PODIUM-STAIRWELL', 'FORK', 'X40-FORK-STAIRWELL']
if not BASE:
    BASE = {'features': {}, 'surface': {s['properties']['name']: copy.deepcopy(s) for s in SURF['features'] if s['properties']['name'] in SURF_TOUCH}}
    for i in TOUCH: fn, f = IDX[i]; BASE['features'].setdefault(fn, {})[i] = copy.deepcopy(f)
    dump(BASEF, BASE)
REPORT = []

# ---------- 도형 도우미 ----------
def ring(poly):
    p = [[r2(x), r2(y)] for x, y in list(poly.exterior.coords)[:-1]]
    if Polygon(p).exterior.is_ccw is False: p = p[::-1]
    return p + [p[0]]
def geom(g):
    g = g.buffer(0)
    if g.geom_type == 'MultiPolygon':
        parts = [q for q in g.geoms if q.area > 0.01]
        if len(parts) == 1: g = parts[0]
        else: return {'type': 'MultiPolygon', 'coordinates': [[ring(q)] for q in parts]}
    assert g.geom_type == 'Polygon' and g.area > 0.003, g
    return {'type': 'Polygon', 'coordinates': [ring(g)]}
def big(g):
    g = g.buffer(0)
    return max(g.geoms, key=lambda q: q.area) if g.geom_type == 'MultiPolygon' else g
def note(f, what):
    p = f['properties']; p['assumption'] = p.get('assumption', '').split(' [R2')[0] + f' [R2 2026-10-25: {what}]'
def zrange(f):
    """윗면이 기운 판(topProfile)이면 외곽 꼭짓점에서 fromM·toM 을 다시 셈."""
    p = f['properties']
    if not p.get('topProfile') or p.get('thicknessM') is None: return
    g = shape(f['geometry']); cs = [c for q in (g.geoms if g.geom_type == 'MultiPolygon' else [g]) for c in q.exterior.coords]
    zs = [prof_z(p['topProfile'], x, y) for x, y in cs]
    p['toM'] = r2(max(zs)); p['fromM'] = r2(min(zs) - (p.get('thicknessM') or 0.03))

# ---------- B1 변환: 모델 단면 선 -> 실제 단면 선 ----------
def line_t(tm, sp):
    """모델 축의 t = tm 인 선이 실제 축 s' = sp 에서 갖는 t'."""
    a = ST(OM + tm * NM); b = ST(OM + tm * NM + U)
    k = (sp - a[0]) / (b[0] - a[0]); return a[1] + k * (b[1] - a[1])
INNER = [(-4.05, -0.05), (-3.80, 0.20), (-1.85, 2.40), (-1.60, 2.65), (2.60, 6.25), (2.85, 6.50), (4.60, 8.00)]   # (모델 t, 실제 t')
T_N = 10.9   # 북쪽 바깥 기준선(모델 t, 움직이지 않음): 15.5 m 띠 북쪽 선
def warp_pt(x, y, south):
    """south = ('fix', tm) 이면 그 모델 선은 그대로, ('to', tm, t') 이면 그 선을 t' 로."""
    sp, tp = ST((x, y)); tm = MST((x, y))[1]
    anc = [(south[1], 0.0 if south[0] == 'fix' else south[2] - line_t(south[1], sp))]
    anc += [(m, tt - line_t(m, sp)) for m, tt in INNER] + [(T_N, 0.0)]
    d = float(np.interp(tm, [a[0] for a in anc], [a[1] for a in anc]))
    q = P(sp, tp + d); return float(q[0]), float(q[1])
def warp_geom(g, south):
    def wr(poly): return Polygon([warp_pt(x, y, south) for x, y in poly.exterior.coords])
    g = shape(g)
    if g.geom_type == 'MultiPolygon': return unary_union([wr(q) for q in g.geoms])
    return wr(g)
WARPED = []
for i in ids(is_warp):
    f = F(i); g = shape(f['geometry']); sc = ST(g.centroid.coords[0])[0]
    south = ('to', -6.46, -4.6) if (sc >= 69.3 and MST(g.centroid.coords[0])[1] < -3.8) else ('fix', -6.36)
    f['geometry'] = geom(warp_geom(f['geometry'], south)); WARPED.append(i)
    note(f, '오르막 실제 축(방위 113.94°) 단면으로 옮김(t\' 만, s\'·높이 그대로)')
REPORT.append(f'B1 옮긴 지물 {len(WARPED)}')

# ---------- B2 윗구간: 15.5 m 띠 안 ----------
S0U, S1U = 69.3, 111.0
END = Polygon([tuple(P(s, t)) for s, t in ((60, -12), (113.2, -12), (112.0, -3.4), (108.5, 10.0), (107.8, 16), (60, 16))])   # 운동장 쪽 끝(옛 차로 칠 판 동쪽 끝 선)
def up_rect(t0, t1, s0=S0U, s1=S1U): return R(s0, s1, t0, t1).intersection(END)
def reprof(f, off):
    p = f['properties']; p['topProfile'] = way_prof(off); zrange(f)
def off_of(f):
    p = f['properties']; pr = p['topProfile']; s0 = pr['points'][0][0]
    return pr['points'][0][1] - float(np.interp(s0, *zip(*WAYP)))
WAYG = shape(F('G02-PLATFORM-WAY')['geometry']).buffer(0)
for i, (t0, t1) in (('G03-SWALL-C', (-0.05, 0.2)), ('G03-SWALL-LED-C', (0.2, 0.24)), ('G03-SBED-C', (-4.6, -0.05))):
    f = F(i); off = off_of(f); f['geometry'] = geom(up_rect(t0, t1)); reprof(f, off)
    note(f, f'15.5 m 띠 안 t\' {t0}~{t1}(옹벽 머릿돌 = t\' 0), s\' {S0U}~{S1U}')
f = F('G03-SLAB-C'); off = off_of(f); slab = up_rect(-4.6, 0.2).difference(WAYG)
f['geometry'] = geom(slab); reprof(f, off); note(f, '띠 남쪽(옹벽·화단) 중 길 기단 밖만 받치는 판')
REPORT.append(f'판 C {slab.area:.1f} ㎡')
f = F('G03-KERB-S2'); off = off_of(f); f['geometry'] = geom(unary_union([shape(f['geometry']), up_rect(2.4, 2.65)])); reprof(f, off)
note(f, f's\' {S1U} 까지(은주관 옆)')
lane = F('X36-UPHILL-TOP-LANE'); LANE_OLD = shape(lane['geometry']).buffer(0)
lane['geometry'] = geom(up_rect(2.65, 6.25)); zrange(lane); note(lane, '차로 칠은 t\' 2.65~6.25 만(양쪽 인도·연석은 따로, 아래 구간과 같은 단면)')
NEW = []
def feat(fid, typ, g, z0, z1, what, grade, base, **extra):
    assert z1 > z0, fid
    return {'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base,
            'fromM': r2(z0), 'toM': r2(z1), 'assumption': 'R2: ' + what, 'source': SRC, **extra}, 'geometry': geom(g)}
def strip(fid, like, g, what):
    p0 = F(like)['properties']; off = off_of(F(like))
    f = feat(fid, p0['type'], g, 0, 1, what, G_AX, 'G02-PLATFORM-WAY', color=p0.get('color'), thicknessM=p0.get('thicknessM'))
    if p0.get('pattern'): f['properties']['pattern'] = p0['pattern']
    f['properties']['topProfile'] = way_prof(off); zrange(f); return f
NEW.append(strip('R2-SIDEWALK-S3', 'G03-SIDEWALK-S2', up_rect(0.2, 2.65), f'윗구간 남쪽 인도(옹벽 면 t\' 0.2 ~ 연석 2.65, s\' {S0U}~{S1U}). 아래 구간과 같은 단면(영상 81~92.5 s)'))
NEW.append(strip('R2-SIDEWALK-N2', 'G03-SIDEWALK-N1', up_rect(6.25, 8.0), '윗구간 북쪽 인도(t\' 6.25~8.0, 화단 면까지)'))
NEW.append(strip('R2-KERB-N2', 'G03-KERB-N1', up_rect(6.25, 6.5), '윗구간 북쪽 연석(t\' 6.25~6.5)'))

# ---------- 북쪽 화단 손질 ----------
# B4 통 계단 자리(아래에서 씀)
SW, SE, T0, GO, NL, NU, LAND = 65.5, 74.5, 8.0, 0.26, 9, 11, 1.2
TL0 = T0 + GO * NL; TL1 = TL0 + LAND; TTOP = TL1 + GO * NU
STAIR = R(SW, SE, T0, TTOP)
# B5 북악관–문예관 사이 계단: 통째로 t' +1.0
DT5 = 1.0
x36st = ids(lambda i: i.startswith('X36-PODIUM-STAIR-'))
HOLE_OLD = unary_union([SH(i) for i in x36st]).buffer(0.01, join_style=2).simplify(0.03)
for i in x36st + ['G02-X36-PLATFORM-PODIUM-STAIRWELL']:
    f = F(i); f['geometry'] = geom(affinity.translate(shape(f['geometry']), *(N * DT5))); note(f, f'발치를 북쪽 화단 면 t\' 8.0 으로(통째로 t\' +{DT5} m, 짜임 그대로)')
HOLE_NEW = affinity.translate(HOLE_OLD, *(N * DT5))
pod = F('G02-PLATFORM-PODIUM'); well = F('G02-X36-PLATFORM-PODIUM-STAIRWELL')
POD_ALL = unary_union([shape(BASE['features']['g02-way.geojson']['G02-PLATFORM-PODIUM']['geometry']), shape(BASE['features']['g02-way.geojson']['G02-X36-PLATFORM-PODIUM-STAIRWELL']['geometry'])]).buffer(0.02, join_style=2).buffer(-0.02, join_style=2)
pod['geometry'] = geom(big(POD_ALL.difference(HOLE_NEW))); note(pod, '사이 계단 자리를 t\' +1.0 옮겨 다시 팜')
well['geometry'] = geom(big(POD_ALL.intersection(HOLE_NEW))); note(well, '사이 계단을 따라 t\' +1.0')
for s in SURF['features']:
    nm = s['properties']['name']
    if nm in ('PODIUM', 'X36-PODIUM-STAIRWELL'):
        allg = unary_union([shape(BASE['surface']['PODIUM']['geometry']), shape(BASE['surface']['X36-PODIUM-STAIRWELL']['geometry'])]).buffer(0.02, join_style=2).buffer(-0.02, join_style=2)
        s['geometry'] = geom(big(allg.difference(HOLE_NEW) if nm == 'PODIUM' else allg.intersection(HOLE_NEW)))
PODG = shape(pod['geometry']).buffer(0)
# 화단: B 는 테라스 기단·사이 계단 자리를 뺌, 모두 통 계단 자리와 t' 8.0 남쪽을 뺌
NORTH8 = Polygon([tuple(P(s, t)) for s, t in ((-20, 8.0), (140, 8.0), (140, 40), (-20, 40))])
for i in ids(lambda i: i.startswith('G03-NPLANT-') or i.startswith('G02-NPLANT-D') or i == 'X40-WEDGE-PLANTER'):
    if i == 'G03-NPLANT-DRUM': continue
    f = F(i); g = shape(f['geometry']).buffer(0).intersection(NORTH8)
    if i.startswith('G03-NPLANT-B'): g = g.difference(PODG.buffer(0.02)).difference(HOLE_NEW.buffer(0.02))
    g = big(g.difference(STAIR.buffer(0.02)))
    if i == 'G03-NPLANT-C3':   # 통 계단 서쪽 옆 소나무 화단 상자(영상 48~53 s): 계단 서쪽 끝까지
        ts = [ST(c)[1] for c in g.exterior.coords]; g = big(unary_union([g, R(63.0, SW, 8.0, max(ts))]).difference(STAIR.buffer(0.02)))
    if g.area < 0.3: REPORT.append(f'{i} 남은 넓이 {g.area:.2f} — 걷음'); f['properties']['_drop'] = True; continue
    f['geometry'] = geom(g); zrange(f)
REPORT.append('B 화단 ' + ', '.join(f'{i} {SH(i).area:.1f}㎡' for i in ids(lambda i: i.startswith('G03-NPLANT-B')) if not F(i)['properties'].get('_drop')))
# 화단이 북쪽으로 늘며 닿은 이웃(카페 앞 평탄부·타일 면 기단, 조각 돌 바탕, 타일 계단, 문예관 서쪽 유리 면, 대일관 옆 계단 벽)은 뺀다
def EXT(fn, pred): return [shape(f['geometry']).buffer(0) for f in json.loads((STR / fn).read_text(encoding='utf-8'))['features'] if pred(f['properties']['id'])]
NBLOCK = unary_union([SH('G02-PLATFORM-TOP'), SH('X40-PLATFORM-TILE'), SH('G03-CRAZY-PAVING-BASE-1')] + [SH(i) for i in ids(lambda i: i.startswith('X40-TILE-STEP-'))]
                     + EXT('z07-building-parts.geojson', lambda i: i == 'Z07-MUNYE-PODIUM-WESTFACE') + EXT('z02-daeil-front.geojson', lambda i: i.startswith('Z02-SIDE-STAIR-WALL-'))).buffer(0.02)
for i in ids(lambda i: (i.startswith('G03-NPLANT-') and i != 'G03-NPLANT-DRUM') or i.startswith('G02-NPLANT-D') or i == 'X40-WEDGE-PLANTER'):
    f = F(i)
    if f['properties'].get('_drop'): continue
    g = shape(f['geometry']).buffer(0)
    if g.intersection(NBLOCK).area > 0.01: f['geometry'] = geom(big(g.difference(NBLOCK))); zrange(f)
# B7 D87 둥근 끝: s' 92.5 에서 끝나게
d87 = F('G02-NPLANT-D87'); g87 = SH('G02-NPLANT-D87'); ts = [ST(c)[1] for c in g87.exterior.coords]
t_lo, t_hi = max(8.0, min(ts)), max(ts); RAD = (t_hi - t_lo) / 2; S_END = 92.5; SC = S_END - RAD
d87['geometry'] = geom(big(g87.intersection(R(-50, SC, -50, 50)))); note(d87, f'둥근 끝이 s\' {S_END} 에서 끝나게 동쪽 끝을 s\' {SC:.2f} 로(타일 마당 들머리 틈 s\' {S_END}~)')
cc = P(SC, (t_lo + t_hi) / 2); disc = Point(*cc).buffer(RAD, 32).intersection(R(SC, SC + 5, -50, 50))
rnd = F('X36-FORK-PLANTER-ROUNDEND'); rnd['geometry'] = geom(disc); note(rnd, f'반지름 {RAD:.2f} m, 가운데 s\' {SC:.2f}·t\' {(t_lo + t_hi) / 2:.2f}(D87 화단 깊이의 반)')
# 나무가 화단 밖으로 나갔는지
PL = {i: SH(i) for i in ids(lambda i: (i.startswith('G03-NPLANT-') or i.startswith('G02-NPLANT-D') or i in ('X40-WEDGE-PLANTER', 'X36-FORK-PLANTER-ROUNDEND'))) if not F(i)['properties'].get('_drop')}
for i in ids(lambda i: (i.startswith('G03-TREE-N') or i.startswith('X40-WEDGE-PINE-')) and i.endswith('TRUNK')):
    c = SH(i).centroid
    if any(g.contains(c) for g in PL.values()): continue
    stem = i[:-len('-TRUNK')]; kids = ids(lambda j, stem=stem: j.startswith(stem + '-'))
    if HOLE_NEW.buffer(0.3).contains(c):   # 옮긴 사이 계단 안에 선 나무(옛 자리도 계단 아랫단 안이었다)
        for j in kids: F(j)['properties']['_drop'] = True
        REPORT.append(f'나무 {stem} 걷음(사이 계단 안)'); continue
    pl = min(PL.items(), key=lambda kv: kv[1].distance(c)); sp, tp = ST(c.coords[0])
    cut = pl[1].intersection(LineString([tuple(P(sp, -50)), tuple(P(sp, 50))]))
    tt = ST(cut.centroid.coords[0])[1] if not cut.is_empty else ST(pl[1].centroid.coords[0])[1]
    for j in kids:
        f = F(j); f['geometry'] = geom(affinity.translate(shape(f['geometry']), *(N * (tt - tp)))); note(f, f"화단 {pl[0]} 가운데(t' {tt:.2f})로")
    REPORT.append(f"나무 {stem} → {pl[0]} t' {tt:.2f}")

# 들머리 포장: 옛 차로 칠 판 중 t' 8.0 북쪽에서 화단·계단이 아닌 곳
apron = LANE_OLD.intersection(NORTH8).intersection(R(S0U, 120, 8.0, 12.5)).difference(unary_union(list(PL.values()) + [STAIR]).buffer(0.02))
parts = [q for q in (apron.geoms if apron.geom_type == 'MultiPolygon' else [apron]) if q.area > 0.8]
if parts:
    f = feat('R2-UPHILL-TOP-APRON', 'wall', unary_union(parts), 0, 1, '옛 차로 칠 판 중 북쪽 화단 면(t\' 8.0) 북쪽에서 화단이 아닌 곳: 타일 마당 들머리 등의 매끈한 포장(영상 97.5~101 s)',
             G_EST, 'G02-PLATFORM-WAY', color='#b6b4ac', thicknessM=0.03)
    f['properties']['topProfile'] = way_prof(0.03); zrange(f); NEW.append(f)
    REPORT.append('들머리 포장 ' + ', '.join(f"s' {min(ST(c)[0] for c in q.exterior.coords):.1f}~{max(ST(c)[0] for c in q.exterior.coords):.1f} {q.area:.1f}㎡" for q in parts))

# ---------- B4 통 계단 ----------
SRC4 = SRC + ', 영상 47~65 s(아랫단 → 참 → 윗단, 동쪽 화강석 옆벽)'
G4 = '확정(아랫단 → 참 → 윗단 짜임: 영상), 추정(단 수 9 + 11, 디딤 0.26, 참 1.2 m, 자리 ±1 m, 머리 t\' 14.4)'
for i in ids(lambda i: i.startswith('X40-FULL-STAIR-')): F(i)['properties']['_drop'] = True
SI0, SI1 = SW + 0.3, SE - 0.3
ZW = way_st(SI0, T0); RISE = (144.2 - ZW) / (NL + NU); ZL = ZW + RISE * NL
def s_where(z, t):
    """오르는 길 면(기본 평면)이 높이 z 가 되는 s'(같은 t'): 그 동쪽은 단이 길에 묻힘."""
    lo, hi = SI0, SI1
    if way_st(hi, t) <= z: return hi
    if way_st(lo, t) >= z: return lo
    for _ in range(40):
        m = (lo + hi) / 2
        if way_st(m, t) < z: lo = m
        else: hi = m
    return lo
BOT = ZW - 0.3
for k in range(1, NL + 1):
    t0, t1 = T0 + GO * (k - 1), T0 + GO * k; zt = ZW + RISE * k; se = s_where(zt, (t0 + t1) / 2)
    if se - SI0 < 0.3: continue
    NEW.append(feat(f'R2-FULL-STAIR-L{k:02d}', 'stair_step', R(SI0, se, t0, t1), BOT, zt, f'문예관 저층부 앞 통 계단 아랫단 {k}/{NL}(한 단 {RISE:.3f} m, 디딤 {GO} m). 길이 동쪽으로 올라 s\' {se:.1f} 동쪽은 길에 묻힘', G4,
                    'G02-PLATFORM-WAY', stair='R2-FULL-STAIR', riseM=r2(RISE), runM=GO, material='stone', color='#cfcac0'))
se = s_where(ZL, (TL0 + TL1) / 2)
NEW.append(feat('R2-FULL-STAIR-LANDING', 'landing', R(SI0, SI1, TL0, TL1), BOT, ZL, f'통 계단 참(깊이 {LAND} m, {ZL:.2f} m). 동쪽 끝(s\' {se:.1f}~)은 오르는 길과 거의 같은 높이', G4, 'G02-PLATFORM-WAY', material='stone', color='#cfcac0'))
for k in range(1, NU + 1):
    t0, t1 = TL1 + GO * (k - 1), TL1 + GO * k; zt = ZL + RISE * k
    NEW.append(feat(f'R2-FULL-STAIR-U{k:02d}', 'stair_step', R(SI0, SI1, t0, t1), BOT, zt, f'통 계단 윗단 {k}/{NU} → 차양 앞 마당 144.2', G4, 'G02-PLATFORM-WAY',
                    stair='R2-FULL-STAIR', riseM=r2(RISE), runM=GO, material='stone', color='#cfcac0'))
    NEW.append(feat(f'R2-FULL-STAIR-CHEEK-E-U{k:02d}', 'wall', R(SI1, SE, t0, t1), BOT, zt + 1.0, '윗단 동쪽 키 큰 화강석 옆벽(디딤 위 1.0 m, 높이 추정)', G4, 'R2-FULL-STAIR', color='#c9c3b6', material='stone'))
NEW.append(feat('R2-FULL-STAIR-CHEEK-E-LANDING', 'wall', R(SI1, SE, TL0, TL1), BOT, ZL + 1.0, '참 동쪽 화강석 옆벽', G4, 'R2-FULL-STAIR', color='#c9c3b6', material='stone'))
for k, (t0, t1, zt) in enumerate([(T0 + GO * (j - 1), T0 + GO * j, ZW + RISE * j) for j in range(1, NL + 1)] + [(TL0, TL1, ZL)] + [(TL1 + GO * (j - 1), TL1 + GO * j, ZL + RISE * j) for j in range(1, NU + 1)]):
    NEW.append(feat(f'R2-FULL-STAIR-CHEEK-W{k + 1:02d}', 'wall', R(SW, SI0, t0, t1), BOT, max(zt, way_st(SW, t1)) + 0.45, '서쪽 계단식 화강석 옆벽(소나무 화단 상자 가)', G4, 'R2-FULL-STAIR', color='#d8d3c7', material='stone'))
# 동쪽 바위·관목 계단식 화단: 통 계단 동쪽 끝 ~ D76, 앞 낮은 단·뒤 높은 단(난간 계단 X40-FORK-TOP 남쪽까지)
d76w = min(ST(c)[0] for c in SH('G02-NPLANT-D76').exterior.coords)
ftop = min(ST(c)[1] for c in SH('X40-FORK-TOP-STAIR-S1').exterior.coords)
pe1 = R(SE, d76w, T0, TL0); pe2 = R(SE, d76w, TL0, ftop - 0.05)
z1 = way_st(SE, T0) + 0.6
NEW.append(feat('R2-FULL-STAIR-PLANTER-E1', 'planter', pe1, BOT, max(z1, ZL + 0.3), '통 계단 동쪽 바위·관목 계단식 화단 앞 단(영상 61~64 s, 높이 추정)', G_EST, 'G02-PLATFORM-WAY', color='#70747a', topColor='#6f8a55'))
NEW.append(feat('R2-FULL-STAIR-PLANTER-E2', 'planter', pe2, BOT, 144.65, '통 계단 동쪽 계단식 화단 뒤 단(마당 144.2 + 0.45, 추정)', G_EST, 'G02-PLATFORM-WAY', color='#70747a', topColor='#6f8a55'))
REPORT.append(f'통 계단: 발치 길 {ZW:.2f} → 참 {ZL:.2f} → 마당 144.2, 한 단 {RISE:.3f} m, 머리 t\' {TTOP:.2f}, 동쪽 화단 s\' {SE}~{d76w:.2f}')
# 차양 앞 마당 기단(FORK): 계단 자리를 떼고, 계단 머리 서쪽 끝까지 마당을 늘림(계단 머리가 마당에 닿게)
fork = F('G02-PLATFORM-FORK'); fwell = F('X40-PLATFORM-FORK-STAIRWELL')
FORK_ALL = unary_union([shape(BASE['features']['g02-way.geojson']['G02-PLATFORM-FORK']['geometry']), shape(BASE['features']['g02-way.geojson']['X40-PLATFORM-FORK-STAIRWELL']['geometry']),
                        R(SW, 67.7, TTOP - 0.05, 17.4)]).buffer(0.02, join_style=2).buffer(-0.02, join_style=2)
fork['geometry'] = geom(big(FORK_ALL.difference(STAIR))); note(fork, f'통 계단 자리(s\' {SW}~{SE}, t\' {T0}~{TTOP:.1f})를 떼고 계단 머리 서쪽 끝(s\' {SW})까지 마당')
fwell['geometry'] = geom(big(FORK_ALL.intersection(STAIR))); note(fwell, '새 통 계단 자리')
for s in SURF['features']:
    nm = s['properties']['name']
    if nm in ('FORK', 'X40-FORK-STAIRWELL'):
        allg = unary_union([shape(BASE['surface']['FORK']['geometry']), shape(BASE['surface']['X40-FORK-STAIRWELL']['geometry']), R(SW, 67.7, TTOP - 0.05, 17.4)]).buffer(0.02, join_style=2).buffer(-0.02, join_style=2)
        s['geometry'] = geom(big(allg.difference(STAIR) if nm == 'FORK' else allg.intersection(STAIR)))

# ---------- B6 차단기·말뚝, B8 노란 함 ----------
def move_box(i, newpoly, what):
    f = F(i); p = f['properties']; c0 = shape(f['geometry']).centroid; c1 = newpoly.centroid
    dz = way(c1.coords[0]) - way(c0.coords[0]); f['geometry'] = geom(newpoly); p['fromM'] = r2(p['fromM'] + dz); p['toM'] = r2(p['toM'] + dz); note(f, what)
def sq(s, t, ds, dt): return R(s - ds / 2, s + ds / 2, t - dt / 2, t + dt / 2)
TP, TA = 7.8, 3.6
for i in ('G03-BARRIER-POST', 'G03-BARRIER-POST-CAP'): move_box(i, sq(15.5, TP, 0.4, 0.4), f'기둥을 북쪽 화단 가 (s\' 15.5, t\' {TP})로(사진 04·거리뷰 21: 기둥이 북쪽, 정사 막대 띠)')
arms = ids(lambda i: i.startswith('G03-BARRIER-ARM-'))
for k, i in enumerate(arms):
    ta = TP - 0.2 - (TP - 0.2 - TA) * k / len(arms); tb = TP - 0.2 - (TP - 0.2 - TA) * (k + 1) / len(arms)
    move_box(i, R(15.45, 15.55, tb, ta), f'막대가 기둥에서 남쪽으로 t\' {TA} 까지(차로를 가로지름)')
for j, tb in ((1, 3.2), (2, 2.8)):
    for i in ids(lambda i, j=j: i.startswith(f'G03-BOLLARD-{j}-')): move_box(i, sq(15.5, tb, 0.2, 0.2), f'말뚝을 막대 끝 남쪽(t\' {tb}, 추정)으로')
gb = F('G03-GRIT-BIN'); gc = (201058.9, 557350.6); gs, gt = ST(gc)
move_box('G03-GRIT-BIN', sq(gs, gt, 1.2, 0.7), '노란 함을 정사 자리 (201058.9, 557350.6) 로(±1 m)')
REPORT.append(f"노란 함 s' {gs:.1f} t' {gt:.1f}")

# ---------- B3 U03: 전화부스 화단 밑 ----------
PLN = [shape(f['geometry']).buffer(0) for f in json.loads((STR / 'p01-parts.geojson').read_text(encoding='utf-8'))['features'] if f['properties']['id'] == 'P01-BONGWAN-WPLANTER-N'][0]
PIN = PLN.buffer(-0.12)
def u03(i, g, z0, z1, what):
    f = F(i); p = f['properties']; f['geometry'] = geom(big(g)); p['fromM'] = r2(z0); p['toM'] = r2(z1); note(f, what)
u03('U03-VOID-STEPS', R(1.5, 3.3, -5.6, -1.6).intersection(PIN), 128.5, 131.75, '계단은 아치(입구(2)) 안에서 북쪽으로 전화부스 화단 밑에 덮여 내려감(130.7 → 128.5, 단 수 모름). 빈 곳 윗면은 화단 윗면(131.9) 아래. 판독 B3, 추정(사용자 질문 1)')
u03('U03-VOID-LOBBY', R(-0.2, 3.3, -1.6, 0.15).intersection(PIN), 128.5, 131.1, '계단 발치·유리문 안 바닥(128.5): 화단 밑 북쪽 끝')
u03('U03-GLASS-DOOR', R(0.0, 2.4, 0.0, 0.12).intersection(PLN.buffer(-0.05)), 128.5, 130.9, '유리문을 화단 북쪽 끝 (201043.5, 557346.4) 쪽으로(판독 B3). 앞 장애인 칸 자리는 칠한 평지')
NEW.append(feat('R2-U03-VOID-LINK', 'void', R(-2.0, 2.4, 0.1, 1.2).difference(PLN), 128.5, 130.4,
                '유리문 앞 ~ 2층 유리문 노드·지하 보행 구간 머리·유리문 뒤 단 사이 땅 밑(128.5, 안 높이 1.9 m: 포장면 130.6 아래로 줄임, 추정)', G_EST, 'Z05-PLATFORM-TURN-PLAZA'))
NEW[-1]['properties']['kind'] = 'void'
NEW.append(feat('R2-U03-VOID-GLASS-STEPS', 'void', R(-4.0, -1.0, -2.1, 0.9), 127.6, 130.3, '유리문 뒤 4~5단(GLASS-STEP)의 빈 곳(땅 밑, 포장면 아래)', G_EST, 'Z05-PLATFORM-TURN-PLAZA'))
NEW[-1]['properties']['kind'] = 'void'

# ---------- 장애인 칸 칠 다시(R1 T5 그대로, 깎는 상자는 화단만) ----------
PLAT = []
for fp in sorted(STR.glob('*.geojson')):
    if fp.name.startswith('a2-') or fp.name in FILES or fp.name == OUT: continue
    for ft in json.loads(fp.read_text(encoding='utf-8'))['features']:
        if ft['properties'].get('kind') == 'platform': PLAT.append((shape(ft['geometry']).buffer(0), ft['properties']))
for fn in FILES:
    for ft in D[fn]['features']:
        if ft['properties'].get('kind') == 'platform': PLAT.append((shape(ft['geometry']).buffer(0), ft['properties']))
def plat_at(x, y):
    pt = Point(x, y); on = [(g, p) for g, p in PLAT if g.contains(pt)]
    pick = [q for q in on if 'TURN-PLAZA' in q[1]['id']] or on
    def z(q): return q[1]['topM'] if q[1].get('topM') is not None else prof_z(q[1]['topProfile'], x, y)
    return max(pick, key=z)[1]
def paint(fid, poly, what, color, lift, thick, old):
    c = poly.centroid; p = plat_at(c.x, c.y); f = copy.deepcopy(old); q = f['properties']
    if p.get('topProfile'):
        pr = copy.deepcopy(p['topProfile']); pr['points'] = [[a[0], r2(a[1] + lift)] for a in pr['points']]
        zs = [prof_z(pr, x, y) for x, y in poly.exterior.coords]; q.update(topProfile=pr, thicknessM=thick, fromM=r2(min(zs) - thick), toM=r2(max(zs)))
    else:
        z = p['topM'] + lift; q.update(fromM=r2(z - thick), toM=r2(z))
    f['geometry'] = geom(poly); note(f, 'U03 계단이 화단 밑으로 가 칸을 깎지 않음(칸 전체)'); return f
DC = np.array([201037.6, 557346.1]); DA = np.array([math.sin(math.radians(115.6)), math.cos(math.radians(115.6))]); DN = np.array([-DA[1], DA[0]])
def Q(a0, a1, b0, b1): return Polygon([tuple(DC + DA * a + DN * b) for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))])
CUT = PLN.buffer(0.05)
def Qc(*a): return big(Q(*a).difference(CUT))
HL, HD = 3.6, 2.35
shp = {}
for j, (a0, a1) in enumerate(((-HL, -0.8), (0.8, HL))):
    m = (a0 + a1) / 2; shp[f'X40-DISABLED-BAY-{j + 1}'] = (Qc(a0, a1, -HD, HD), '#2f6db5', 0.02, 0.02); shp[f'X40-DISABLED-BAY-{j + 1}-SIGN'] = (Qc(m - 0.6, m + 0.6, -0.6, 0.6), '#f2f2ee', 0.035, 0.02)
for k in range(4):
    a = -0.6 + k * 0.4; shp[f'X40-DISABLED-BAY-HATCH-{k + 1}'] = (big(affinity.rotate(Q(a - 0.08, a + 0.08, -2.1, 2.1), 20, origin=Point(*(DC + DA * a))).difference(CUT)), '#f2f2ee', 0.02, 0.02)
for nm, (a0, a1) in (('A', (-HL, -HL + 0.1)), ('B', (-0.8, -0.7)), ('C', (0.7, 0.8)), ('D', (HL - 0.1, HL))): shp[f'X40-DISABLED-BAY-LINE-{nm}'] = (Qc(a0, a1, -HD, HD), '#f2f2ee', 0.025, 0.02)
x40 = D['x40-parts.geojson']; before = {i: shape(F(i)['geometry']).area for i in shp}
x40['features'] = [paint(f['properties']['id'], *shp[f['properties']['id']][:1], '', *shp[f['properties']['id']][1:], f) if f['properties']['id'] in shp else f for f in x40['features']]
reindex()
REPORT.append(f"장애인 칸 넓이 {sum(before[i] for i in ('X40-DISABLED-BAY-1', 'X40-DISABLED-BAY-2')):.2f} → {sum(SH(i).area for i in ('X40-DISABLED-BAY-1', 'X40-DISABLED-BAY-2')):.2f} ㎡")

# ---------- 겹침 검사(칠·나무·빈 곳 빼고) ----------
BOXES = {}
for fp in sorted(STR.glob('*.geojson')):
    if fp.name.startswith('a2-') or fp.name in FILES or fp.name == OUT: continue
    for ft in json.loads(fp.read_text(encoding='utf-8'))['features']: BOXES[ft['properties']['id']] = ft
for fn in FILES:
    for ft in D[fn]['features']:
        if not ft['properties'].get('_drop'): BOXES[ft['properties']['id']] = ft
for ft in NEW: BOXES[ft['properties']['id']] = ft
def solid(ft):
    p = ft['properties']
    if p.get('kind') in ('platform', 'void') or p.get('surfaceMark') or p.get('type') in ('tree', 'surface', 'curb', 'void') or not ft['geometry'] or not ft['geometry'].get('coordinates'): return None
    lo, hi = p.get('fromM', 0), p.get('toM', 0)
    return shape(ft['geometry']).buffer(0), lo, hi
SOL = {i: s for i, ft in BOXES.items() if (s := solid(ft))}
CHECK = [i for i in WARPED + UPPER + ['G03-KERB-S2', 'G03-GRIT-BIN', 'G03-BARRIER-POST'] + [f['properties']['id'] for f in NEW] if i in SOL and not i.startswith('G03-LOGO')]
SKIP = ('G03-SIDEWALK', 'G03-KERB', 'G03-PAINT', 'R2-SIDEWALK', 'R2-KERB', 'X36-UPHILL', 'G03-LOGO', 'R2-UPHILL-TOP-APRON', 'G03-SLAB', 'G03-SWALL-LED', 'X22-LAMP', 'G03-PAINT-APRON')
seen = set()
for i in CHECK:
    g, lo, hi = SOL[i]
    for j, (h, lo2, hi2) in SOL.items():
        if j == i or (j, i) in seen or any(j.startswith(s) for s in SKIP) or any(i.startswith(s) for s in SKIP): continue
        if i.startswith('R2-FULL-STAIR') and j.startswith('R2-FULL-STAIR'): continue
        if hi2 > lo + 0.02 and lo2 < hi - 0.02:
            a = g.intersection(h).area
            if a > 0.05: REPORT.append(f'겹침 {i} × {j} {a:.2f} ㎡'); seen.add((i, j))

# ---------- 쓰기 ----------
for fn in FILES:
    D[fn]['features'] = [f for f in D[fn]['features'] if not f['properties'].pop('_drop', False)]
    dump(STR / fn, D[fn])
dump(REC / 'g02-surface.geojson', SURF)
dump(STR / OUT, {'type': 'FeatureCollection', 'name': 'r2-uphill', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': NEW})
STAIRS = {'full': {'foot': [r2(c) for c in P(72.1, T0)], 'footZ': r2(way_st(72.1, T0)), 'landing0': [r2(c) for c in P(72.1, TL0)], 'landing1': [r2(c) for c in P(72.1, TL1)], 'landingZ': r2(ZL),
          'top': [r2(c) for c in P(72.1, TTOP)], 'topZ': 144.2, 'rise': r2(RISE), 'risers': [NL, NU]}, 'podiumShift': [r2(c) for c in N * DT5]}
(HERE / 'stairs.json').write_text(json.dumps(STAIRS, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print('\n'.join(REPORT)); print(f'{OUT}: {len(NEW)}')
