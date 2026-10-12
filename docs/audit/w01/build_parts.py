"""W01: 캠퍼스 바깥 가장자리(정문 → 서경로 → 회전교차로 → 서문)를 네이버 거리뷰 25~42 대로. DB·네트워크 접근 없음.   python -X utf8 build_parts.py [--plan 그림.png]
쓰는 파일(형식 docs/audit/g02/STRUCTURES.md, 전부 estimated):
  frontend/public/structures/w01-parts.geojson
  frontend/public/structures/p02-parts.geojson   P02 의 유담관 3층 입구(P02-YUDAM3-*)와 공도 쪽 기와 띠(P02-YUDAM-STREET-TILEBAND-*)를 걷는다(여기서 서쪽 면에 맞춰 다시 만든다. 다시 돌려도 같다)
  frontend/public/structures/z05-west.geojson    옛 서문 문틀(Z06-WESTGATE-*)을 걷는다(새 자리에 다시 만든다)
  frontend/public/structures/z05-gate.geojson    옛 정문 기둥·보(Z05-GATE-POST-*, Z05-GATE-BEAM)를 걷는다(철골 탑과 보로 다시 만든다)
  docs/audit/w01/model.json                      치수 요약, 길 변경 묶음이 읽는 점
먼저 docs/audit/z11/build_parts.py 를 돌린다(공도 쪽 기단 벽의 선을 읽는다). p02·z05 를 다시 돌리면 이 스크립트도 다시 돌린다.
기단(지형 입력)은 건드리지 않는다: 전부 기단 위에 얹는 상자다. 높이가 다른 곳은 벽면으로 만난다.
근거: 볼트 데이터/보완자료/3d-map-audit-20261009/사용자-네이버거리뷰-20261012/ 의 25~42(색인.md), S-MAP 1 m 메시(z04), campus.gpkg 유담관 외곽, 사용자 표시(서문). 치수는 눈대중(추정)."""
import sys, json, math, pathlib
import numpy as np
from shapely.geometry import Polygon, Point, LineString, shape, box as sbox
from shapely.ops import unary_union, nearest_points
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
unit = lambda v: np.array(v, float) / np.hypot(*np.array(v, float))
load = lambda fn: json.loads((STR / fn).read_text(encoding='utf-8'))
def save(fn, d): (STR / fn).write_text(json.dumps(d, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

# ---------- 다른 파일에서 걷는 것(다시 돌려도 같다) ----------
def strip(fn, prefixes, note):
    d = load(fn); keep = [f for f in d['features'] if not f['properties']['id'].startswith(prefixes)]; n = len(d['features']) - len(keep)
    d['features'] = keep; d.setdefault('provenance', {})['w01'] = note; save(fn, d); return n
REMOVED = {'p02': strip('p02-parts.geojson', ('P02-YUDAM3-', 'P02-YUDAM-STREET-TILEBAND-'), 'W01 이 유담관 3층 입구와 공도 쪽 띠를 서쪽 면 선에 맞춰 다시 만들어 여기서 뺐다(docs/audit/w01/build_parts.py)'),
           'west': strip('z05-west.geojson', ('Z06-WESTGATE-',), 'W01 이 서문 문틀을 사용자 표시 자리에 다시 만들어 여기서 뺐다(docs/audit/w01/build_parts.py)'),
           'gate': strip('z05-gate.geojson', ('Z05-GATE-POST-', 'Z05-GATE-BEAM'), 'W01 이 정문 가로 보를 철골 탑과 보로 다시 만들어 여기서 뺐다(docs/audit/w01/build_parts.py)')}

ALL = [f for fn in sorted(STR.glob('*.geojson')) if fn.name != 'w01-parts.geojson' for f in json.loads(fn.read_text(encoding='utf-8'))['features']]
PLAT = {f['properties']['id']: (shape(f['geometry']).buffer(0), f['properties']) for f in ALL if f['properties']['kind'] == 'platform'}
SCENE = {b['id']: Polygon(b['ring']).buffer(0) for b in json.loads((REPO / 'docs/audit/z04/scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']}
def top_at(p, x, y):
    if 'topProfile' in p: o, d, pts = np.array(p['topProfile']['origin']), np.array(p['topProfile']['direction']), np.array(p['topProfile']['points']); return float(np.interp((x - o[0]) * d[0] + (y - o[1]) * d[1], pts[:, 0], pts[:, 1]))
    return float(p['topM'])
ROADS = ['Z05-PLATFORM-WEST-STREET', 'Z05-PLATFORM-GATE-ROUNDABOUT', 'Z05-PLATFORM-GATE-STREET-SW', 'Z05-PLATFORM-GATE-SEOGYEONG-RO']
def street(x, y):
    """그 자리 공도 윗면(공도 기단 안이면 그 기단, 밖이면 가장 가까운 공도 기단의 경사면을 늘린 값)."""
    q = Point(x, y); inside = [top_at(PLAT[k][1], x, y) for k in ROADS if PLAT[k][0].contains(q)]
    return min(inside) if inside else top_at(PLAT[min(ROADS, key=lambda k: PLAT[k][0].distance(q))][1], x, y)

FEATS = []
def box(id, typ, poly, fromM, toM, what, source, grade, base, **extra):
    poly = poly if isinstance(poly, Polygon) else Polygon([tuple(p) for p in poly]); poly = poly.buffer(0)
    if poly.geom_type != 'Polygon': poly = max(poly.geoms, key=lambda g: g.area)
    assert toM > fromM, id; assert not poly.is_empty and poly.area > 1e-4, id
    rings = [[[r2(x), r2(y)] for x, y in r.coords] for r in [poly.exterior] + list(poly.interiors)]
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': what, 'source': source, **extra}, 'geometry': {'type': 'Polygon', 'coordinates': rings}})
def slope(id, typ, poly, zfun, direction, what, source, grade, base, lift=0.0, thick=None, bottom=None, **extra):
    """윗면이 길과 나란한 상자: direction 축의 양 끝에서 zfun(x, y) + lift. thick = 기운 판, bottom = 벽."""
    poly = poly.buffer(0)
    if poly.geom_type != 'Polygon': poly = max(poly.geoms, key=lambda g: g.area)
    d = unit(direction); pts = np.array(poly.exterior.coords); s = pts @ d; i0, i1 = int(np.argmin(s)), int(np.argmax(s)); c = np.array(poly.centroid.coords[0]); n = np.array([-d[1], d[0]])
    p0, p1 = c + d * (s[i0] - c @ d), c + d * (s[i1] - c @ d); z0, z1 = zfun(*p0) + lift, zfun(*p1) + lift
    if abs(z1 - z0) < 0.01: z1 = z0 + 0.01
    prof = {'origin': [r2(p0[0]), r2(p0[1])], 'direction': [round(float(d[0]), 4), round(float(d[1]), 4)], 'points': [[0.0, r2(z0)], [r2(s[i1] - s[i0]), r2(z1)]]}
    lo = min(z0, z1) - thick if thick else bottom; assert lo < min(z0, z1), id
    box(id, typ, poly, lo, max(z0, z1), what, source, grade, base, topProfile=prof, **({'thicknessM': thick} if thick else {'bottomM': r2(bottom)}), **extra)
def pieces(poly, direction, step=2.5):
    """도형을 direction 축에 수직인 띠(step m)로 자른 조각들."""
    d = unit(direction); n = np.array([-d[1], d[0]]); pts = np.array(poly.exterior.coords); s = pts @ d; m = pts @ n; out = []; a = math.floor(s.min() / step) * step
    while a < s.max():
        o = d * a + n * float(m.mean()); band = Polygon([o - n * 500, o + n * 500, o + d * step + n * 500, o + d * step - n * 500]); g = poly.intersection(band)
        out += [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.geom_type == 'Polygon' and q.area > 0.02]; a += step
    return out
def tree(tid, c, z, what, src, base, s=1.0):
    sq = lambda h: [(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)]
    for part, mat, h, z0, z1 in (('TRUNK', 'trunk', 0.18, 0.0, 3.0), ('CROWN', 'foliage', 1.3, 2.8, 4.2), ('TOP', 'foliage', 0.75, 4.2, 5.2)):
        box(f'{tid}-{part}', 'tree', sq(h * s), z + z0 * s, z + z1 * s, f'{what}: 단순한 나무(실제 그루 수·자리·수종의 모양이 아니다)', src, '원천(이 자리에 소나무: 거리뷰), 추정(그루 수·자리·크기)', base, material=mat)
class Face:
    """곧은 벽면: o 에서 a 방향으로 t(m), 바깥(out)으로 d(m). d < 0 은 벽 안쪽."""
    def __init__(self, o, to, out):
        self.o = np.array(o, float); v = np.array(to, float) - self.o; self.len = float(np.hypot(*v)); self.a = v / self.len; n = np.array([-self.a[1], self.a[0]]); self.n = n if n @ np.array(out, float) > 0 else -n
    def P(self, t, d=0.0): return self.o + self.a * t + self.n * d
    def R(self, t0, t1, d0, d1): return Polygon([tuple(self.P(t0, d0)), tuple(self.P(t1, d0)), tuple(self.P(t1, d1)), tuple(self.P(t0, d1))])
    def z(self, t, d=1.0): return street(*self.P(t, d))
    def t_of(self, x, y): return float((np.array([x, y]) - self.o) @ self.a)

SV = '사용자-네이버거리뷰-20261012/'
# =====================================================================================================================
# 1. 유담관 서쪽 날개: 길가에 바로 선 짙은 돌 건물 면 (거리뷰 27~33)
# =====================================================================================================================
# 면의 선 = 원천 외곽(campus.gpkg 유담관)의 서쪽 변 (201003.84, 557264.26) → (200992.14, 557354.9). S-MAP 1 m 메시의 세로 면(반 높이 점)과 북좌표 557280~557372 에서 ±1 m, 557256~557268 에서 1.2 m 서쪽.
OUT_A, OUT_B = np.array([201003.84, 557264.26]), np.array([200992.14, 557354.9])
LX = lambda y: float(OUT_A[0] + (y - OUT_A[1]) * (OUT_B[0] - OUT_A[0]) / (OUT_B[1] - OUT_A[1]))
Y_SW, Y_Z11, Y_N = 557247.6, 557302.0, 557378.0     # 남서 모서리, 공도 쪽 기단 벽(Z11)의 북쪽 끝 = 서쪽 날개 덩어리의 남쪽 끝, 날개의 북쪽 끝(메시: 세로 면이 557376~380 에서 끝난다. 원천 외곽은 557370, 색인은 557380)
WF = Face((LX(Y_SW), Y_SW), (LX(Y_N), Y_N), (-1, 0)); T_Z11, T_N = WF.t_of(LX(Y_Z11), Y_Z11), WF.len
SF = Face((LX(Y_SW), Y_SW), (201039.0, 557226.2), (-1, -1))     # 남서쪽 면(회전교차로 ~ 공연실습소 맞은편). Z11 의 선 그대로
STONE_D, BAND_D, CORNER_D, GLASS, LOUVRE = '#5d5450', '#46403d', '#3a3634', '#7f97a3', '#34373b'
W_SRC = SV + '27-근접-유담관공도쪽-남서모서리.jpg·28-근접-유담관서쪽면-북쪽보기.jpg·30·31·32-근접-사용자시선.jpg·33-근접-유담관북쪽끝-남쪽보기.jpg, S-MAP 1 m 메시(z04/smap-mesh-z04-1m-w*), campus.gpkg 유담관 외곽(서쪽 변)'
W_G = '원천(길가에 바로 선 짙은 돌 건물 면, 층마다 거친 돌 띠와 흰 틀 띠창, 모서리의 거친 돌 세로 띠: 거리뷰), S-MAP·원천(면의 선: 메시의 세로 면 = 원천 외곽 서쪽 변 ±1 m), 추정(북쪽 끝 ±4 m, 창 줄 높이 = 건물 노트의 층 표, 칸 나눔)'
FLOORS = {'1F': 93.9, '2F': 99.0, '3F': 104.0, '5F': 109.0, '6F': 114.1, '7F': 121.6, '8F': 125.4}      # 건물 노트 유담관의 층 표(고치지 않는다)
DECK_TOP, WING_TOP = 129.3, 131.2      # 기단 데크 윗면(S-MAP), 그 북쪽은 회차 공간 높이의 띠(Z05 화단 띠 기단 131.2: 위에 아치 건물)
ENT = WF.t_of(200994.6, 557307.6); ENT_F = 104.0      # 3층 입구 가운데 = 사용자가 학교 지도에서 표시한 자리를 면에 내린 점(P02 와 같은 자리)
PORCH = (ENT - 5.5, ENT + 5.5)
SHOP = (ENT + 14.6, WF.t_of(LX(557350), 557350))      # 입구 북쪽 길가 가게 칸 구간

def west_wing():
    hi = unary_union([PLAT[k][0] for k in ('Z05-PLATFORM-WEST-WALLTOP-PLANTER', 'Z05-PLATFORM-WEST-WALLTOP-NORTH', 'Z05-PLATFORM-WEST-GATE-BANK')] + [SCENE['유담관#기단데크']] + [shape(f['geometry']).buffer(0) for f in ALL if f['properties']['id'] == 'Z11-YUDAM-STREET-PLINTH'])
    g = WF.R(T_Z11, T_N, -2.6, 0.0).difference(hi).buffer(0)
    body = max((q for q in (g.geoms if hasattr(g, 'geoms') else [g])), key=lambda q: q.area)
    depth = [body.intersection(LineString([WF.P(t, 0.01), WF.P(t, -2.6)])).length for t in np.arange(T_Z11 + 1, T_N - 1, 4)]
    zb = WF.z(T_Z11) - 1.5; notch = WF.R(PORCH[0], PORCH[1], -7.0, 0.01)
    for k, q in enumerate(sorted(body.difference(notch).geoms, key=lambda q: q.centroid.y)): box(f'W01-WESTWING-BODY-LOW-{k + 1}', 'wall', q, zb, ENT_F + 6.6, f'유담관 서쪽 날개의 길 쪽 벽 덩어리(아랫부분): 건물 면 선과 옛 "옹벽" 선(화단 띠 기단의 서쪽 변) 사이 {min(depth):.1f}~{max(depth):.1f} m 를 채운다. 3층 입구 현관 자리(폭 11 m)는 비운다', W_SRC, W_G, 'Z05-PLATFORM-WEST-STREET', color=STONE_D)
    box('W01-WESTWING-BODY-UP', 'wall', body, ENT_F + 6.6, WING_TOP, f'유담관 서쪽 날개의 길 쪽 벽 덩어리(현관 위): 윗면 {WING_TOP} m(회차 공간 쪽 띠와 같은 높이). 북쪽 끝 북좌표 {Y_N:.0f}', W_SRC, W_G, 'W01-WESTWING-BODY-LOW-1', color=STONE_D, topColor='#8f9296')
    # 모서리의 거친 돌 세로 띠: 남서 모서리와 북쪽 끝
    c = WF.o; box('W01-WESTWING-CORNER-SW', 'wall', Point(c).buffer(0.75, resolution=2), street(*WF.P(0, 1.5)) - 1.0, DECK_TOP + 0.9, '남서 모서리의 거친 돌 세로 띠(폭 1.5 m): 곧은 서쪽 면과 남서쪽 면이 여기서 만난다', W_SRC, W_G, 'Z11-YUDAM-STREET-PLINTH', color=CORNER_D)
    box('W01-WESTWING-CORNER-N', 'wall', WF.R(T_N - 1.3, T_N + 0.15, -1.0, 0.18), WF.z(T_N) - 1.0, WING_TOP + 0.05, '북쪽 끝의 거친 돌 세로 띠(폭 1.4 m): 여기서 건물이 끝나고 북쪽은 밝은 돌 옹벽', W_SRC, W_G, 'W01-WESTWING-BODY-LOW-1', color=CORNER_D)
    rows = {}
    def row(face, tag, name, t0, t1, z0, z1, color, what, clear=0.6, bay=6.0, gap=1.0, skip=(), proud=0.1, base='W01-WESTWING-BODY-LOW-1'):
        cl = lambda t: max(clear, 3.5) if face is WF and SHOP[0] - 1 < t < SHOP[1] + 1 else clear      # 가게 칸 구간에서는 가게 유리(보도 위 3.0 m) 위로 드러난 줄만
        ts = [t for t in np.arange(t0, t1, 0.5) if face.z(t) < z0 - cl(t) and face.z(t + 0.5) < z0 - cl(t) and not any(a - 0.3 < t < b + 0.3 for a, b in skip)]
        if not ts: return
        runs, cur = [], [ts[0]]
        for t in ts[1:]:
            if t - cur[-1] > 0.6: runs.append(cur); cur = [t]
            else: cur.append(t)
        runs.append(cur); k = 0
        for r in runs:
            a, b = r[0], r[-1] + 0.5
            if b - a < 2.0: continue
            n = max(1, int(round((b - a) / (bay + gap)))); w = (b - a) / n
            for j in range(n):
                k += 1; box(f'W01-{tag}-{name}-{k:02d}', 'wall', face.R(a + j * w + gap / 2, a + (j + 1) * w - gap / 2, 0.0, proud), z0, z1, what, W_SRC, W_G, base, color=color)
        rows[f'{tag}-{name}'] = k
    wtag = lambda f: '서쪽 면' if f is WF else '남서쪽 면'
    for face, tag, t0, t1 in ((WF, 'WESTWING', 1.2, T_N - 1.5), (SF, 'SOUTHFACE', 1.2, SF.len - 0.5)):
        top = (lambda t: DECK_TOP) if face is SF else (lambda t: DECK_TOP if t < T_Z11 else WING_TOP)
        for nm, f in FLOORS.items():      # 층마다 거칠게 깬 돌 띠(창 줄 밑)
            ts = [t for t in np.arange(t0, t1, 0.5) if face.z(t) < f - 0.6]
            if ts: box(f'W01-{tag}-STONEBAND-{nm}', 'wall', face.R(min(ts), max(ts) + 0.5, 0.0, 0.16), f - 0.35, f, f'{wtag(face)}의 층 사이 거친 돌 띠({nm} 바닥 {f} m 선, 길 위로 드러난 구간만)', W_SRC, W_G, 'Z11-YUDAM-STREET-PLINTH', color=BAND_D)
        w0 = t0 if face is WF else SF.len * 0.45      # 남서쪽 면의 창은 동쪽에 몰려 있다(거리뷰 27: 모서리 쪽은 창 없는 판벽에 돌 띠만)
        if face is WF:
            row(face, tag, 'LOUVRE-1F', w0, 14.0, FLOORS['1F'] + 0.9, FLOORS['1F'] + 2.0, LOUVRE, '서쪽 면 맨 아래의 환기 살창 줄(남쪽 끝에서만 길 위로 드러난다)', clear=0.3, bay=3.0, gap=1.2)
            row(face, tag, 'RECESS-2F', w0, T_Z11, FLOORS['2F'] + 0.4, FLOORS['2F'] + 3.6, '#24262a', '돌 기둥 사이의 깊은 칸(실외기·설비 살창. 어두운 판으로 나타냄: 벽을 파지 않는다)', clear=0.3, bay=5.0, gap=1.4)
        row(face, tag, 'WINDOW-3F', w0, t1 if face is SF else PORCH[0] - 1.0, FLOORS['3F'] + 1.0, FLOORS['3F'] + 2.6, GLASS, f'{wtag(face)}의 띠창 줄(3층 바닥 위 1.0~2.6 m)')
        for nm in ('5F', '6F', '7F'): row(face, tag, f'WINDOW-{nm}', w0, t1, FLOORS[nm] + 1.0, FLOORS[nm] + 2.6, GLASS, f'{wtag(face)}의 띠창 줄({nm} 바닥 위 1.0~2.6 m, 길 위로 드러난 구간만: 길이 북으로 올라 줄이 차례로 사라진다)')
        row(face, tag, 'WINDOW-8F', w0, T_Z11 if face is WF else t1, FLOORS['8F'] + 0.8, FLOORS['8F'] + 2.2, GLASS, f'{wtag(face)}의 맨 위 띠창 줄(8층 바닥 위)')
    # 북쪽 절반(아치 건물 밑)의 맨 윗단은 유리 면(거리뷰 32·33: 창 줄 둘 위에 한 단 물러난 유리 면. 물러난 깊이는 만들지 않고 유리 띠로)
    row(WF, 'WESTWING', 'GLASS-TOP', T_Z11 + 0.8, T_N - 1.5, FLOORS['8F'] + 0.4, WING_TOP - 0.5, '#6f8f9c', '서쪽 날개 북쪽 절반의 맨 윗단 유리 면(창 줄 둘 위의 물러난 유리 층을 벽면의 유리 띠로 줄임)', bay=9.0, gap=0.6)
    # 길가 가게 칸(입구 북쪽): 큰 유리, 길을 따라 오른다
    t = SHOP[0]; k = 0
    while t + 5.0 < SHOP[1]:
        k += 1; slope(f'W01-WESTWING-SHOP-{k:02d}', 'wall', WF.R(t, t + 5.0, 0.0, 0.1), lambda x, y: street(x, y), WF.a, '길가 가게 칸의 큰 유리(보도 위 0.6~3.0 m, 길을 따라 오른다. 칸 수·폭은 고르게 나눈 것)', SV + '30-근접-사용자시선.jpg·31-근접-사용자시선.jpg', W_G, 'W01-WESTWING-BODY-LOW-1', lift=3.0, thick=2.4, color='#8fa3aa'); t += 6.4
    # 북쪽 끝 가까이의 붉은 문 칸(거리뷰 32)
    tr = WF.t_of(LX(557366), 557366); box('W01-WESTWING-REDDOOR', 'wall', WF.R(tr, tr + 2.4, 0.0, 0.1), WF.z(tr) + 0.5, WF.z(tr) + 3.1, '북쪽 끝 가까이의 붉은 문이 있는 깊은 칸(문 앞 계단 3~4단은 만들지 않음, 자리 ±5 m)', SV + '32-근접-사용자시선.jpg', W_G, 'W01-WESTWING-BODY-LOW-1', color='#b3262c')
    return {'bodyDepthM': [round(min(depth), 2), round(max(depth), 2)], 'rows': rows}

# =====================================================================================================================
# 2. 유담관 3층 입구 = 서경스포렉스 입구 (거리뷰 29, P02 의 자리 그대로: 면에 맞춰 다시 앉힘)
# =====================================================================================================================
def entrance3():
    SRC = SV + '29-근접-스포렉스입구-우체국.jpg·29-근접-사용자시선.jpg, 사용자-SP카페·대일관계단·3생활관-20261012/06-유담관-3층입구-서경스포렉스.jpg, 사용자-출입구·주차장-20261010/06·07(사용자 표시)'
    G = '확정(서경스포렉스 간판의 이 입구 = 유담관 3층 입구, 우편취급국 옆: 사용자 2026-10-10·10-12. 자리 = 사용자가 학교 지도에서 표시한 표지), 원천(둥근 화강석 기둥 둘, 계단 8~9단, 어두운 유리문, 왼쪽 난간, 북쪽 칸 우체국·남쪽 칸 신한은행 간판: 거리뷰 29), 추정(현관 바닥 104.0 m, 폭·기둥 굵기. 현관 깊이는 벽 덩어리 두께 1.5 m 까지만: 실제는 더 깊다)'
    BASE = 'Z05-PLATFORM-WEST-STREET'; GR, DARK = '#a9a8a3', '#17191d'; F = ENT_F; E = lambda s0, s1, d0, d1: WF.R(ENT + s0, ENT + s1, d0, d1); back = -1.5
    floor = unary_union([E(-5.5, 5.5, back - 0.1, back + 0.4), E(-5.5, -4.0, back, 0.0), E(4.0, 5.5, back, 0.0)])
    box('W01-YUDAM3-PORCH-FLOOR', 'landing', floor, 101.0, F, '현관 바닥(3층 104.0 m): 문 앞 0.4 m 참과 기둥 뒤 양옆. 그 사이는 계단이 건물 면 안쪽에서 시작한다', SRC, G, BASE, color='#8e8f8c')
    box('W01-YUDAM3-PORCH-RECESS', 'wall', E(-4.0, 4.0, back - 0.02, back + 0.1), F, F + 5.0, '깊은 현관 안(어두운 판으로 나타냄)', SRC, G, BASE, material='opening', color=DARK)
    for j, (s0, s1) in enumerate(((-2.6, -1.35), (-1.3, -0.05), (0.05, 1.3), (1.35, 2.6))): box(f'W01-YUDAM3-DOOR-{j + 1}', 'wall', E(s0, s1, back + 0.1, back + 0.16), F, F + 2.5, '유리문 넷(짙은 유리)', SRC, G, 'W01-YUDAM3-PORCH-RECESS', color='#2f4048')
    box('W01-YUDAM3-DOOR-TRANSOM', 'wall', E(-2.6, 2.6, back + 0.1, back + 0.16), F + 2.6, F + 4.2, '문 위 유리', SRC, G, 'W01-YUDAM3-PORCH-RECESS', color='#263339')
    for j, s in enumerate((-4.7, 4.7)): box(f'W01-YUDAM3-COLUMN-{j + 1}', 'wall', Point(WF.P(ENT + s, -0.1)).buffer(0.7, resolution=3), 101.0, F + 6.6, '현관 양옆의 큰 둥근 화강석 기둥(지름 1.4 m, 건물 면 선 위)', SRC, G, BASE, color=GR)
    box('W01-YUDAM3-SIGNBAND', 'wall', E(-5.5, 5.5, back, 0.35), F + 5.0, F + 6.6, '현관 위 짙은 간판 띠("서경스포렉스")', SRC, G, 'W01-YUDAM3-COLUMN', color='#2a2530')
    box('W01-YUDAM3-SIGNBAND-TEXT', 'wall', E(-3.6, 0.8, 0.35, 0.41), F + 5.45, F + 6.1, '간판의 흰 글자 줄(글자를 밝은 띠로 줄임)', SRC, G, 'W01-YUDAM3-SIGNBAND', color='#e8e6e0')
    RISE, TREAD, NS = 0.156, 0.28, 8; d0 = back + 0.4
    for k in range(1, NS + 1): box(f'W01-YUDAM3-STAIR-S{k:02d}', 'stair_step', E(-4.0, 2.3, d0 + (k - 1) * TREAD, d0 + k * TREAD), 101.0, F - k * RISE, f'넓은 돌계단 {NS}단(단 높이 {RISE} m, 디딤 {TREAD} m, 폭 6.3 m). 기둥 사이에서 시작해 보도로 {d0 + NS * TREAD:.1f} m 나온다. 길이 북으로 올라 북쪽 끝은 길에 묻힌다', SRC, G, BASE, color='#9c9b96', stair='W01-YUDAM3-STAIR', riseM=RISE, runM=TREAD, widthM=6.3)
    for k in range(4): box(f'W01-YUDAM3-RAMP-{k + 1}', 'landing', E(2.4, 4.0, d0 + k * 0.56, d0 + (k + 1) * 0.56), 101.0, F - (k + 0.5) * 0.11, '계단 왼쪽(북쪽)의 경사로(폭 1.6 m, 낮은 판 넷으로 나타냄)', SRC, G, BASE, color='#8e8f8c')
    for j, s in enumerate((2.38, 3.96)): box(f'W01-YUDAM3-RAMP-RAIL-{j + 1}', 'wall', E(s, s + 0.06, d0, d0 + 2.2), F + 0.55, F + 0.62, '경사로 난간', SRC, G, 'W01-YUDAM3-RAMP', color='#2b2d30')
    p = WF.P(ENT + 5.9, 0.9); zb = street(*p); box('W01-YUDAM3-POSTBOX', 'wall', Point(p).buffer(0.24, resolution=1), zb - 0.3, zb + 1.4, '빨간 우체통(북쪽 기둥 발치)', SRC, G, BASE, color='#c8231f')
    for nm, s0, s1, col, what in (('POST', 6.2, 13.8, '#c9302a', '입구 북쪽 칸의 우체국(우편취급국) 붉은 간판 띠'), ('BANK', -13.8, -6.2, '#1f4fa3', '입구 남쪽 칸의 신한은행 파란 간판 띠')):
        zs = max(WF.z(ENT + s0), WF.z(ENT + s1)); box(f'W01-YUDAM3-SIGN-{nm}', 'wall', E(s0, s1, 0.0, 0.3), zs + 3.3, zs + 4.1, what, SRC, G, 'W01-WESTWING-BODY-LOW-1', color=col)
        box(f'W01-YUDAM3-SHOP-{nm}', 'wall', E(s0 + 0.2, s1 - 0.2, 0.0, 0.1), zs + 0.8, zs + 3.2, '간판 아래 가게 유리', SRC, G, 'W01-WESTWING-BODY-LOW-1', color='#8fa3aa')
    door, foot = WF.P(ENT - 0.8, back + 0.5), WF.P(ENT - 0.8, d0 + NS * TREAD + 0.35)
    return {'door': [r2(door[0]), r2(door[1]), F], 'foot': [r2(foot[0]), r2(foot[1]), r2(street(*foot) + 0.15)], 'center': [r2(v) for v in WF.P(ENT)]}

# =====================================================================================================================
# 3. 서문 (거리뷰 33~35, 사용자 표시)
# =====================================================================================================================
G_C = np.array([200976.8, 557408.2])      # 문 정면 가운데 = 사용자 표시(2026-10-10, ±6 m). 거리뷰 두 시선의 교차 (200972, 557401), 학교 표지 (200967.8, 557401.5), S-MAP 벽 면 x 200980.8~200986.6 사이
G_U = np.array([math.sin(math.radians(120)), math.cos(math.radians(120))])      # 문 면의 방향(왼쪽 → 오른쪽 = 서북서 → 동남동): 문은 남남서를 본다(거리뷰 35·33 에서 눈대중, ±15도)
BAYS = [('BAY', 3.8), ('PIER', 1.4), ('BAY', 3.4), ('PIER', 1.4), ('NARROW', 2.0), ('PIER', 1.0)]      # 왼쪽부터: 차량 칸, 기둥, 차량 칸, 기둥, 좁은 칸, 기둥 (Z06 의 칸 폭 3.8·3.4·2.0)
G_W = sum(w for _, w in BAYS); G_L, G_R = G_C - G_U * G_W / 2, G_C + G_U * G_W / 2
GF = Face(G_L, G_R, (-1, -1))
WING_A = np.array([math.sin(math.radians(250)), math.cos(math.radians(250))]); WING_END = G_L + WING_A * 8.0      # 왼쪽 날개벽: 문 왼쪽 끝에서 서남서로 8 m(비스듬히 꺾임)
WALL_E = np.array([LX(Y_N), Y_N])      # 밝은 돌 옹벽의 남쪽 끝 = 유담관 서쪽 날개의 북쪽 끝
PALE, PALE_CAP = '#bdb9b0', '#d2cfc6'
def west_gate():
    SRC = SV + '35-근접-서문정면.jpg·34-근접-서문.jpg·33-근접-사용자시선.jpg·33~35 전방위, 사용자-서문·제2주차장·수인관-20261010/01-SMAP-서문·제2주차장-사용자표시.webp(사용자 표시), 사용자-서문-공연실습소-생활관-20261010/서문.jpg'
    G = '확정(서문 자리 = 사용자 표시 ±6 m), 원천(밝은 회색 거친 돌 블록 옹벽에 뚫린 문, 글자 두 줄, 둥글게 부푼 돌 기둥 셋, 차량 칸 둘과 좁은 칸, 차단기 둘, 오른쪽 청록 유리, 비스듬한 왼쪽 날개벽, 문 위 소나무 비탈: 거리뷰 33~35), 추정(문이 보는 방향 ±15도, 칸 폭, 높이, 옹벽 선)'
    ST = PLAT['Z05-PLATFORM-WEST-STREET'][0]; sill = street(*GF.P(G_W / 2, 1.0)); H, LH = 4.0, 2.6; head = sill + H + LH
    # 문 뒤의 덩어리: 문 면·날개벽 뒤와 옛 벽 선 사이, 그리고 문 북쪽(길이 여기서 서쪽으로 꺾이므로 북쪽은 길이 아니다). 윗면은 옹벽 머리 높이의 소나무 비탈
    n_w = np.array([-WING_A[1], WING_A[0]]); n_w = n_w if n_w[1] > 0 else -n_w
    mass = Polygon([tuple(G_R), tuple(G_L), tuple(WING_END), tuple(WING_END + n_w * 5.0), (200958.0, 557427.0), (200992.0, 557427.0), (200992.0, 557405.0)]).buffer(0)
    mass = mass.intersection(ST.buffer(0.5).union(Polygon([(200983, 557395), (200992, 557395), (200992, 557427), (200983, 557427)])))
    box('W01-WESTGATE-MASS', 'wall', mass, sill - 2.0, head, f'서문 뒤의 옹벽 덩어리: 문 면(폭 {G_W:.1f} m)과 왼쪽 날개벽 뒤, 옛 벽 선까지. 윗면 {head:.1f} m 는 옹벽 머리 높이의 소나무 비탈(더 높은 뒤쪽 화단 비탈과는 벽면으로 만난다). 터널 안은 비우지 않았다', SRC, G, 'Z05-PLATFORM-WEST-STREET', color=PALE, topColor='#7f9a6b')
    # 밝은 돌 옹벽: 유담관 서쪽 날개 북쪽 끝 → 문 오른쪽 끝. 윗면은 길과 나란히(길 위 6.6 m)
    WL = Face(WALL_E, G_R, (-1, 0)); wall = Polygon([tuple(WALL_E), tuple(G_R), (200992.0, 557405.0), (200993.0, float(WALL_E[1]))]).buffer(0)
    for k, q in enumerate(pieces(wall, WL.a, 4.0)):
        slope(f'W01-WESTWALL-{k + 1:02d}', 'wall', q, street, WL.a, f'서쪽의 밝은 회색 거친 돌 블록 옹벽(유담관 서쪽 날개 북쪽 끝 ~ 서문, {WL.len:.1f} m). 윗면은 길 위 6.6 m 로 길과 나란히 오른다(4 m 마디)', SRC, G, 'Z05-PLATFORM-WEST-STREET', lift=6.6, bottom=street(*WALL_E) - 2.0, color=PALE, topColor=PALE_CAP)
    for j, (c0, c1, col) in enumerate(((0.30, 0.52, '#8fb04a'), (0.53, 0.75, '#2f8f88'), (0.76, 0.93, '#1f4fa3'))):      # 옹벽 윗단의 간판 띠(연두·청록·파랑)
        t0, t1 = WL.len * c0, WL.len * c1; slope(f'W01-WESTWALL-SIGN-{j + 1}', 'wall', WL.R(t0, t1, 0.0, 0.12), street, WL.a, '옹벽 윗단의 간판 띠(색만: 서경스포렉스·신한은행 안내)', SRC, G, 'W01-WESTWALL', lift=6.1, thick=1.0, color=col)
    # 문틀
    t = 0.0; piers = 0; bays = 0; openings = []
    for kind, w in BAYS:
        if kind == 'PIER':
            piers += 1
            for c in range(7):      # 둥글게 부푼 돌 7단: 단마다 가운데가 불룩(넓은 단과 좁은 줄눈 단을 번갈아)
                zc = sill - 0.3 if c == 0 else sill + c * H / 7
                box(f'W01-WESTGATE-PIER-{piers}-C{c + 1}', 'wall', GF.R(t - 0.08, t + w + 0.08, -0.3, 0.55), zc, sill + (c + 1) * H / 7 - 0.1, f'서문의 둥글게 부푼 돌 기둥(7단, 폭 {w} m)', SRC, G, 'Z05-PLATFORM-WEST-STREET', color='#c6c2b9')
                box(f'W01-WESTGATE-PIER-{piers}-J{c + 1}', 'wall', GF.R(t + 0.06, t + w - 0.06, -0.3, 0.42), sill + (c + 1) * H / 7 - 0.1, sill + (c + 1) * H / 7, '기둥 단 사이의 들어간 줄눈', SRC, G, 'Z05-PLATFORM-WEST-STREET', color='#8e8a82')
        else:
            bays += 1; openings.append((t, t + w))
            box(f'W01-WESTGATE-OPENING-{bays}', 'canopy', GF.R(t, t + w, 0.0, 0.12), sill, sill + H, '서문의 뚫린 칸(어두운 판으로 나타냄: 터널 안은 비우지 않았다)', SRC, G, 'W01-WESTGATE-MASS', material='opening', color='#1c1e22')
            if kind == 'BAY':
                box(f'W01-WESTGATE-BARRIER-{bays}-ARM', 'barrier', GF.R(t + 0.3, t + w - 0.2, 1.0, 1.12), sill + 0.95, sill + 1.08, '차단기 팔(노랑·검정)', SRC, G, 'Z05-PLATFORM-WEST-STREET', color='#e0b020')
                box(f'W01-WESTGATE-BARRIER-{bays}-POST', 'barrier', GF.R(t + 0.05, t + 0.4, 0.85, 1.25), sill - 0.2, sill + 1.15, '차단기 몸통', SRC, G, 'Z05-PLATFORM-WEST-STREET', color='#d8d4c8')
        t += w
    box('W01-WESTGATE-LINTEL', 'wall', GF.R(-0.1, G_W + 0.1, -0.3, 0.45), sill + H, head, f'서문 머리의 글자 면(높이 {LH} m)', SRC, G, 'W01-WESTGATE-MASS', color='#c6c2b9', topColor=PALE_CAP)
    for j, (c, w, z0) in enumerate(((0.47, 9.6, 1.55), (0.47, 5.2, 0.6))): box(f'W01-WESTGATE-TEXT-{j + 1}', 'wall', GF.R(G_W * c - w / 2, G_W * c + w / 2, 0.45, 0.5), sill + H + z0, sill + H + z0 + 0.5, '금빛 글자 두 줄 "SEOKYEONG UNIVERSITY / WEST GATE"(글자를 띠로 줄임)', SRC, G, 'W01-WESTGATE-LINTEL', color='#c9a94a')
    # 오른쪽 청록 유리, 그 앞 낮은 돌 화단과 소나무(옹벽 발치)
    tg = WL.len; box('W01-WESTGATE-TEAL-GLASS', 'wall', WL.R(tg - 3.0, tg - 0.3, 0.0, 0.12), sill + 0.5, sill + 3.3, '문 오른쪽의 청록 유리 벽', SRC, G, 'W01-WESTWALL', color='#2f8f88')
    pl = WL.R(tg - 15.0, tg - 3.4, 0.0, 1.3)
    slope('W01-WESTGATE-PLANTER', 'planter', pl, street, WL.a, '옹벽 발치의 낮은 돌 화단(길 위 0.9 m, 깊이 1.3 m, 길이 11.6 m): 둥글게 다듬은 소나무', SRC, G, 'Z05-PLATFORM-WEST-STREET', lift=0.9, bottom=street(*WL.P(tg - 15.0, 0.6)) - 0.5, color=PALE)
    for j, tt in enumerate((tg - 13.0, tg - 9.0, tg - 5.2)): p = WL.P(tt, 0.65); tree(f'W01-WESTGATE-PLANTER-PINE-{j + 1}', p, street(*p) + 0.9, '옹벽 발치 화단의 소나무', SRC, 'W01-WESTGATE-PLANTER', s=0.6)
    for j, (a, b) in enumerate(((0.25, 3.5), (0.55, 4.5), (0.8, 3.0), (0.45, 9.0), (0.15, 8.0))): p = GF.P(G_W * a, -b); tree(f'W01-WESTGATE-PINE-{j + 1}', p, head, '문 위 비탈의 소나무', SRC, 'W01-WESTGATE-MASS')
    v = GF.P((openings[1][0] + openings[1][1]) / 2, 0.6)      # 둘째 차량 칸(가운데 칸) 앞: 터널 길이 시작하는 점
    return {'center': [r2(v) for v in G_C], 'left': [r2(v) for v in G_L], 'right': [r2(v) for v in G_R], 'facingDeg': 210, 'sillM': r2(sill), 'headM': r2(head), 'widthM': r2(G_W), 'roadStart': [r2(v[0]), r2(v[1]), r2(street(*v))], 'wallLenM': r2(WL.len)}

# =====================================================================================================================
# 4. 서쪽 길의 캠퍼스 쪽 보도 (거리뷰 28~33): 붉은 벽돌 무늬 블록 + 노란 점자 띠, 화강석 경계석, 폭 2.5 m
# =====================================================================================================================
def west_sidewalk():
    SRC = SV + '28-근접-유담관서쪽면-북쪽보기.jpg·29~32-근접-사용자시선.jpg·33-근접-사용자시선.jpg'; G = '원천(붉은 벽돌 무늬 블록 보도와 노란 점자 띠, 화강석 경계석이 서쪽 면 전체를 따라간다: 거리뷰), 추정(폭 2.5 m, 턱 0.15 m)'
    WL = Face(WALL_E, G_R, (-1, 0)); line = LineString([tuple(WF.P(0.4)), tuple(WF.P(T_N)), tuple(WL.P(WL.len - 3.2))]); D = PLAT['Z05-PLATFORM-WEST-STREET'][1]['topProfile']['direction']
    def band(d0, d1):
        a, b = line.parallel_offset(d0, 'left', join_style=2), line.parallel_offset(d1, 'left', join_style=2)
        ca, cb = list(a.coords), list(b.coords)
        if Point(ca[0]).distance(Point(line.coords[0])) > Point(ca[-1]).distance(Point(line.coords[0])): ca = ca[::-1]
        if Point(cb[0]).distance(Point(line.coords[0])) > Point(cb[-1]).distance(Point(line.coords[0])): cb = cb[::-1]
        return Polygon(ca + cb[::-1]).buffer(0)
    n = {}
    for nm, typ, d0, d1, lift, col in (('SIDEWALK', 'landing', 0.0, 2.5, 0.15, '#b0584a'), ('TACTILE', 'wall', 1.45, 1.75, 0.17, '#e2c23a'), ('KERB', 'wall', 2.5, 2.7, 0.16, '#d2cfc6')):
        ps = pieces(band(d0, d1), D, 2.5); n[nm] = len(ps)
        for k, q in enumerate(ps): slope(f'W01-WEST-{nm}-{k + 1:03d}', typ, q, street, D, {'SIDEWALK': '서쪽 길의 캠퍼스 쪽 보도(붉은 벽돌 무늬 블록, 폭 2.5 m, 차도보다 0.15 m 높은 기운 판)', 'TACTILE': '보도의 노란 점자 띠', 'KERB': '화강석 경계석 줄'}[nm], SRC, G, 'Z05-PLATFORM-WEST-STREET', lift=lift, thick=0.3 if nm != 'TACTILE' else 0.05, color=col, **({'material': 'paving'} if nm == 'SIDEWALK' else {}))
    return {'lengthM': r2(line.length), 'pieces': n}

# =====================================================================================================================
# 5. 정문: 가로 보(검은 철골 격자 탑 + 상자 보 + 붉은 사선 부재), 북서쪽 길가 옹벽과 보도 (거리뷰 39~41)
# =====================================================================================================================
def main_gate():
    SRC = SV + '40-근접-정문-수인관.jpg·41-근접-수인관남쪽끝.jpg·39-근접-밝은돌옹벽.jpg'; BLACK, RED = '#2b2d30', '#d2232a'
    G = '원천(검은 철골 격자 탑 둘 위의 상자 보, 수인관 벽 쪽으로 비스듬히 오르는 붉은 상자 부재: 거리뷰 40·41), 추정(자리 = Z05 의 기둥 자리, 치수·높이)'
    PW, PE = np.array([201122.65, 557110.25]), np.array([201135.75, 557115.35]); ax = unit(PE - PW); nr = np.array([-ax[1], ax[0]]); z0 = 106.6
    def tower(tag, c, half, top, what):
        for j, (sx, sy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            p = c + ax * sx * half + nr * sy * half; box(f'W01-GATE-TOWER-{tag}-LEG-{j + 1}', 'wall', Point(p).buffer(0.16, resolution=1), z0, top, what, SRC, G, 'Z05-PLATFORM-GATE-APRON', color=BLACK)
        ring = Polygon([tuple(c + ax * sx * (half + 0.16) + nr * sy * (half + 0.16)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]); hole = Polygon([tuple(c + ax * sx * (half - 0.1) + nr * sy * (half - 0.1)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        z = z0 + 2.2; k = 0
        while z < top + 0.01: k += 1; box(f'W01-GATE-TOWER-{tag}-RING-{k}', 'wall', ring.difference(hole), min(z, top) - 0.2, min(z, top), what + ' (가로 띠)', SRC, G, 'Z05-PLATFORM-GATE-APRON', color=BLACK); z += 2.2
    tower('W', PW, 1.1, z0 + 8.0, '정문 가로 보의 서쪽(길 건너편 쪽) 철골 격자 탑: 2.2 m 네모, 높이 8 m')
    tower('E', PE, 1.1, z0 + 15.0, '정문 가로 보의 동쪽(수인관 벽 쪽) 철골 격자 탑: 2.2 m 네모, 높이 15 m')
    L = float(np.hypot(*(PE - PW))); B = lambda s0, s1, h: Polygon([tuple(PW + ax * s0 - nr * h), tuple(PW + ax * s1 - nr * h), tuple(PW + ax * s1 + nr * h), tuple(PW + ax * s0 + nr * h)])
    box('W01-GATE-BEAM-TOP', 'canopy', B(-1.3, L + 1.3, 0.9), z0 + 6.9, z0 + 7.15, '정문 가로 보(상자 보: 위·아래 판과 옆 줄, 포장면 위 5.7~7.15 m)', SRC, G, '없음(탑 위에 얹힘)', color=BLACK)
    box('W01-GATE-BEAM-BOTTOM', 'canopy', B(-1.3, L + 1.3, 0.9), z0 + 5.7, z0 + 5.95, '정문 가로 보의 아래 판', SRC, G, '없음(탑 위에 얹힘)', color=BLACK)
    for j, h in enumerate((-0.8, 0.8)): box(f'W01-GATE-BEAM-SIDE-{j + 1}', 'canopy', Polygon([tuple(PW + ax * -1.3 + nr * (h - 0.1)), tuple(PW + ax * (L + 1.3) + nr * (h - 0.1)), tuple(PW + ax * (L + 1.3) + nr * (h + 0.1)), tuple(PW + ax * -1.3 + nr * (h + 0.1))]), z0 + 5.95, z0 + 6.9, '정문 가로 보의 옆 줄', SRC, G, '없음(탑 위에 얹힘)', color=BLACK)
    red = B(-2.5, L + 0.6, 0.35); o = PW + ax * -2.5
    box('W01-GATE-RED-DIAGONAL', 'canopy', red, z0 + 1.0, z0 + 15.0, '붉은 사선 상자 부재: 서쪽 탑 발치 바깥에서 동쪽 탑 꼭대기로 오른다(두께 0.7 m 의 기운 판)', SRC, G, '없음(탑에 걸침)', color=RED, thicknessM=0.7,
        topProfile={'origin': [r2(o[0]), r2(o[1])], 'direction': [round(float(ax[0]), 4), round(float(ax[1]), 4)], 'points': [[0.0, r2(z0 + 1.7)], [r2(L + 3.1), r2(z0 + 15.0)]]})
    # 북서쪽 길가: 정문 안 포장(높은 쪽)과 공도(낮은 쪽)가 만나는 벽면에 돌 옹벽 면을 붙이고, 발치에 회색 블록 보도
    G2 = '원천(정문 북서쪽 길가는 밝은 회색 거친 돌 블록 옹벽 약 6 m 에 머릿돌과 소나무, 정문 가까이는 돌 무늬 콘크리트 옹벽 2.5~3 m 위 흰 3단 난간, 발치에 회색 블록 보도 약 2 m: 거리뷰 39·40), 추정(벽 선 = 지금 모델의 정문 안 포장 기단의 길 쪽 변, 구간 나눔)'
    apron = unary_union([PLAT[k][0] for k in ('Z05-PLATFORM-GATE-APRON', 'Z05-PLATFORM-GATE-APRON-b')]).buffer(0); AP = PLAT['Z05-PLATFORM-GATE-APRON'][1]; ap_top = lambda x, y: top_at(AP, x, y)
    st = PLAT['Z05-PLATFORM-GATE-STREET-SW'][0]; D = PLAT['Z05-PLATFORM-GATE-STREET-SW'][1]['topProfile']['direction']; sign = Point(201129.2, 557112.8)
    skin = apron.buffer(0.3, join_style=2).difference(apron).intersection(st.buffer(0.2)).buffer(0)
    skin = max((q for q in (skin.geoms if hasattr(skin, 'geoms') else [skin])), key=lambda q: q.area)
    ps = pieces(skin, D, 3.0); nc = ns = 0; drops = []
    for k, q in enumerate(ps):
        c = q.centroid; near = c.distance(sign) < 30.0; drop = ap_top(c.x, c.y) - street(c.x, c.y); drops.append(drop)
        if drop < 0.6: continue
        nc += near; ns += not near
        slope(f'W01-GATE-ROADWALL-{k + 1:02d}', 'wall', q, ap_top, D, ('정문 가까이의 돌 무늬 콘크리트 옹벽 면' if near else '정문 북서쪽 길가의 밝은 회색 거친 돌 블록 옹벽 면') + f'(벽 높이 {drop:.1f} m, 머리는 정문 안 포장보다 0.35 m 위)', SRC, G2, 'Z05-PLATFORM-GATE-STREET-SW', lift=0.35, bottom=street(c.x, c.y) - 1.0, color='#aaa69d' if near else PALE, topColor=PALE_CAP)
        if near:
            for r, h in enumerate((0.75, 1.1, 1.45)): slope(f'W01-GATE-ROADFENCE-{k + 1:02d}-R{r + 1}', 'wall', q.buffer(-0.09) if q.buffer(-0.09).area > 0.02 else q, ap_top, D, '옹벽 위 흰 3단 난간(가로대)', SRC, G2, 'W01-GATE-ROADWALL', lift=h, thick=0.08, color='#f0efea')
    for j, c in enumerate((0.25, 0.42, 0.6, 0.78)):      # 밝은 돌 옹벽 위의 소나무(거리뷰 39: 머릿돌 바로 위에 소나무와 관목)
        q = ps[int(len(ps) * c)]; cc = q.centroid
        if cc.distance(sign) < 30.0: continue
        inner = np.array(nearest_points(apron.buffer(-1.2), cc)[0].coords[0])
        tree(f'W01-GATE-ROADWALL-PINE-{j + 1}', inner, ap_top(*inner), '정문 북서쪽 옹벽 위의 소나무', SRC, 'Z05-PLATFORM-GATE-APRON', s=0.8)
    walk = apron.buffer(2.3, join_style=2).difference(apron.buffer(0.3, join_style=2)).intersection(st).buffer(0); kerb = apron.buffer(2.5, join_style=2).difference(apron.buffer(2.3, join_style=2)).intersection(st).buffer(0)
    nw = 0
    for nm, g, typ, lift, col in (('SIDEWALK', walk, 'landing', 0.15, '#a9a59c'), ('KERB', kerb, 'wall', 0.16, '#d2cfc6')):
        for q0 in (g.geoms if hasattr(g, 'geoms') else [g]):
            if q0.geom_type != 'Polygon' or q0.area < 1: continue
            for q in pieces(q0, D, 2.5): nw += 1; slope(f'W01-GATE-{nm}-{nw:03d}', typ, q, street, D, '정문 북서쪽 길가의 회색 블록 보도(폭 2 m, 턱 0.15 m)' if nm == 'SIDEWALK' else '화강석 경계석 줄', SRC, G2, 'Z05-PLATFORM-GATE-STREET-SW', lift=lift, thick=0.3, color=col, **({'material': 'paving'} if nm == 'SIDEWALK' else {}))
    return {'roadWallPieces': {'concrete': int(nc), 'paleStone': int(ns)}, 'wallDropM': [round(min(drops), 1), round(max(drops), 1)], 'walkPieces': nw}

model = {'removed': REMOVED, 'westWing': west_wing(), 'entrance3': entrance3(), 'westGate': west_gate(), 'westSidewalk': west_sidewalk(), 'mainGate': main_gate(),
         'faceLine': {'from': [r2(LX(Y_SW)), Y_SW], 'to': [r2(LX(Y_N)), Y_N], 'z11End': [r2(LX(Y_Z11)), Y_Z11]}}
ids = [f['properties']['id'] for f in FEATS]; assert len(ids) == len(set(ids)), [i for i in ids if ids.count(i) > 1][:5]
save('w01-parts.geojson', {'type': 'FeatureCollection', 'name': 'w01-parts', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
     'provenance': {'builder': 'docs/audit/w01/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': 'W01: 캠퍼스 바깥 가장자리(유담관 서쪽 날개의 길 쪽 면, 3층 입구, 서문, 서쪽 보도, 정문 가로 보와 길가 옹벽). 치수는 눈대중(추정).'}, 'features': FEATS})
model['features'] = len(FEATS); (HERE / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(json.dumps(model, ensure_ascii=False))
if '--plan' in sys.argv:
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(9, 16))
    for k in ('Z05-PLATFORM-WEST-STREET', 'Z05-PLATFORM-WEST-WALLTOP-PLANTER', 'Z05-PLATFORM-WEST-WALLTOP-NORTH', 'Z05-PLATFORM-WEST-GATE-BANK'): ax.plot(*PLAT[k][0].exterior.xy, lw=.8)
    ax.plot(*SCENE['유담관#기단데크'].exterior.xy, color='red', lw=.6)
    for f in FEATS:
        g = shape(f['geometry'])
        if g.bounds[0] < 201015: ax.fill(*g.exterior.xy, alpha=.45, color=f['properties'].get('color', '#888888'))
    ax.set_xlim(200955, 201015); ax.set_ylim(557240, 557430); ax.set_aspect('equal'); ax.grid(lw=.3); plt.savefig(sys.argv[sys.argv.index('--plan') + 1], dpi=70, bbox_inches='tight')
