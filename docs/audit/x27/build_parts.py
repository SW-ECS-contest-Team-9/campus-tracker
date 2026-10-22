"""X27~X35(2026-10-22): 한림관 정문 앞(정문 계단·입구 면·차양·아치 틀·로비 안 계단, 은주1관 곡선 돌계단·반원 테라스, 바위 정원, 차단기, 과속방지턱, 유담관 북동 1층 기둥).
근거: 볼트 데이터/모델링 개선/2026-10-22 전경 영상 비교.md "한림관 정문 사진" 절(H01~H19, X27~X35), 동 노트 한림관·은주관·유담관 2026-10-22 절, 구역 노트 위쪽 갈래와 한림관 둘레.
평면은 사용자 항공사진(보완자료/학교-전경-20261022/항공/항공-한림관정문-은주1관.webp)을 땅 위 표시 셋(아래 차도 횡단보도, 위쪽 갈래 과속방지턱, 아래 차도 마름모 표시: S-MAP 정사 화면에서 읽음)으로 맞춘 것(잔차 0.4 m 이하, ±1.5 m 추정).
  python -I build_parts.py           DB·네트워크 접근 없음
쓰는 파일:
  frontend/public/structures/x27-hanlim-front.geojson   새 기단 4 + 상자
  frontend/public/structures/z05-upper-branch.geojson   (고침) 기단 UPPER-HANLIM-1F·HANLIM-FRONT·HANLIM-SOUTH·MAIN-FRONT-LOW 외곽, 옛 정문 계단 Z05-HANLIM-FRONT-STAIR-* 걷음
  frontend/public/structures/z05-eunju.geojson          (고침) 기단 EUNJU-EUNJU1-NW·EUNJU1-WEST 외곽(바위 정원·곡선 계단·테라스 자리를 뺌)
  frontend/public/structures/z10-parts.geojson          (고침) 옛 짙은 회색 차양 Z10-HANLIM-1F-CANOPY 걷음
  backend/data/terrain/recipes/z05-surface.geojson      (고침) 같은 기단의 지형 입력(같은 외곽) + 새 기단 넷
돌리는 차례: z05/build_inputs.py → … → x22/build_parts.py → 이 스크립트. id 로 찾아 고치므로 몇 번 돌려도 같다(첫 실행의 옛 외곽은 x27/base-platforms.json 에 남겨 두고 다음부터 그것에서 시작한다).
좌표 EPSG:5186. 등급: 확정(사용자) / 원천 / S-MAP / 추정. 치수는 사진 눈대중(추정)."""
import json, math, pathlib
import numpy as np
from shapely.geometry import Polygon, Point, LineString, shape, mapping
from shapely.ops import unary_union, substring

HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
STR = REPO / 'frontend' / 'public' / 'structures'; REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'
r2 = lambda v: round(float(v), 2)
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}
NOTE = '볼트 데이터/모델링 개선/2026-10-22 전경 영상 비교.md(한림관 정문 사진, X27~X35)'
AER = '사용자 항공사진 항공-한림관정문-은주1관.webp(땅 위 표시 셋으로 맞춤, ±1.5 m)'
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def dump(p, obj): p.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
def ring(pts):
    p = [[r2(x), r2(y)] for x, y in pts]
    if Polygon(p).exterior.is_ccw is False: p = p[::-1]
    return p + [p[0]]
def big(g):
    g = g.buffer(0)
    if g.geom_type == 'Polygon': return g
    return max(g.geoms, key=lambda q: q.area)
def geom(poly):
    poly = big(poly)
    return {'type': 'Polygon', 'coordinates': [ring(list(poly.exterior.coords)[:-1])] + [ring(list(i.coords)[:-1]) for i in poly.interiors if Polygon(i).area > 0.05]}
FEATS = []
def box(id, typ, poly, z0, z1, assumption, source, grade='추정', base='', **extra):
    poly = poly if isinstance(poly, Polygon) or hasattr(poly, 'geoms') else Polygon(poly)
    poly = poly.buffer(0)
    if poly.is_empty or poly.area < 0.01 or z1 - z0 < 0.005: return
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base, 'fromM': r2(z0), 'toM': r2(z1),
        'assumption': assumption, 'source': source, **extra}, 'geometry': geom(poly)})
def disc(c, r, n=16): return Polygon([(c[0] + r * math.cos(2 * math.pi * k / n), c[1] + r * math.sin(2 * math.pi * k / n)) for k in range(n)])
def tree(id, c, z, base, src, grade, h=1.0):
    for part, mat, hh, z0, z1 in (('TRUNK', 'trunk', 0.14, 0.0, 3.2 * h), ('CROWN', 'foliage', 1.3, 2.6 * h, 4.0 * h), ('TOP', 'foliage', 0.7, 4.0 * h, 4.9 * h)):
        box(f'{id}-{part}', 'tree', disc(c, hh, 6), z + z0, z + z1, '소나무(단순한 나무)', src, grade, base, material=mat)

# ---------- 정문 틀: 항공사진의 차양 긴 축(방위 122.7 도)과 그 수직(계단을 오르는 쪽, 방위 32.7 도) ----------
C = np.array([201109.33, 557280.05]); A = np.array([0.842, -0.54]); N = np.array([0.54, 0.842])
def P(u, v): return tuple(C + A * u + N * v)
def Q(u0, u1, v0, v1): return Polygon([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)])
HANLIM = Polygon([(201115.67, 557280.2), (201109.54, 557281.17), (201104.18, 557283.58), (201100.77, 557289.05), (201099.4, 557294.9), (201099.79, 557299.28), (201102.41, 557304.47), (201106.93, 557308.1), (201112.82, 557310.06), (201118.23, 557309.37), (201123.15, 557307.15), (201127.14, 557303.42), (201128.99, 557298.14), (201128.74, 557293.6), (201127.64, 557288.75), (201125.05, 557284.97), (201121.28, 557281.36)])
EUNJU = Polygon([(201118.5, 557246.9), (201120.5, 557258.2), (201124.5, 557257.5), (201131.4, 557300.0), (201135.0, 557300.0), (201135.0, 557245.0), (201134.2, 557240.0), (201121.4, 557240.0), (201122.3, 557246.3)])

# ---------- 이웃(지금 파일) ----------
OWN = 'x27-hanlim-front.geojson'
FILES = {fn.name: load(fn) for fn in sorted(STR.glob('*.geojson')) if fn.name != OWN}
def feat(fid):
    for fn, d in FILES.items():
        for f in d['features']:
            if f['properties']['id'] == fid: return fn, f
    raise SystemExit('없음 ' + fid)
BASEF = HERE / 'base-platforms.json'
EDIT = ['Z05-PLATFORM-UPPER-HANLIM-1F', 'Z05-PLATFORM-UPPER-HANLIM-FRONT', 'Z05-PLATFORM-UPPER-HANLIM-SOUTH', 'Z05-PLATFORM-UPPER-MAIN-FRONT-LOW', 'Z05-PLATFORM-EUNJU-EUNJU1-NW', 'Z05-PLATFORM-EUNJU-EUNJU1-WEST']
SURF = load(REC / 'z05-surface.geojson')
if not BASEF.exists():   # 첫 실행: 고치기 전 외곽(구조물·지형 입력)을 남긴다
    keep = {}
    for fid in EDIT:
        fn, f = feat(fid); sn = f['properties']['surfaceName']
        sf = [s for s in SURF['features'] if s['properties']['name'] == sn]
        keep[fid] = {'file': fn, 'surfaceName': sn, 'geometry': f['geometry'], 'surface': sf[0]['geometry'] if sf else None}
    dump(BASEF, keep)
BASE = load(BASEF)
OLD = {fid: shape(v['geometry']).buffer(0) for fid, v in BASE.items()}
OLDS = {fid: (shape(v['surface']).buffer(0) if v['surface'] else None) for fid, v in BASE.items()}
U1 = unary_union([shape(f['geometry']).buffer(0) for f in FILES['z05-upper-branch.geojson']['features'] if f['properties']['id'].startswith('Z05-PLATFORM-UPPER-U1-')])
ESLOT = shape(feat('Z05-PLATFORM-UPPER-HANLIM-ESLOT')[1]['geometry']).buffer(0)
PLATS = [(shape(f['geometry']).buffer(0), f['properties']) for d in FILES.values() for f in d['features'] if f['properties'].get('kind') == 'platform' and f['properties']['id'] not in EDIT]
def ptop(p, x, y):
    pr = p.get('topProfile')
    if not pr: return float(p['topM'])
    L = math.hypot(*pr['direction']); d = ((x - pr['origin'][0]) * pr['direction'][0] + (y - pr['origin'][1]) * pr['direction'][1]) / L
    return float(np.interp(d, [q[0] for q in pr['points']], [q[1] for q in pr['points']]))
def ground(x, y):
    hs = [(ptop(p, x, y), p['id']) for g, p in PLATS if g.contains(Point(x, y))]
    if not hs: raise SystemExit(f'기단 없음 {x:.1f},{y:.1f}')
    return max(hs)

# ===================== X27 정문 계단 =====================
SRC_S = f'사진 17·18·20·21·23(한림관-정문/), {AER}: 차양 남쪽의 짙은 띠(깊이 6.2 m, 차양과 나란함) = 계단, 그 남쪽 끝의 밝은 선 = 계단 발치'
GS = '확정(정문 계단이 있다: 사용자), 사진(한 줄 약 15단·짙은 광택 화강석·옆벽), 항공사진(자리·방향·깊이 ±1.5 m), 추정(단 높이·폭)'
Z0, ZL, NR = 125.1, 127.2, 15; RISE = (ZL - Z0) / NR; V0, VT = -8.0, -1.756; GO = (VT - V0) / (NR - 1)
UW, UE, UFL = -5.25, 5.25, -7.25
DARK = '#3c3f44'
for k in range(1, NR):
    v0, v1 = V0 + GO * (k - 1), V0 + GO * k; zt = Z0 + RISE * k
    box(f'X27-STAIR-S{k:02d}', 'stair_step', Q(UFL if k <= 3 else UW, UE, v0, v1), Z0 - 0.3, zt, f'정문 계단 {k}단(짙은 광택 화강석, 한 줄 15단: 125.1 → 127.2). 아래 3단은 서쪽으로 2 m 더 넓다(사진 17)', SRC_S, GS, 'X27-PLATFORM-UPPER-HANLIM-STAIR',
        stair='X27-STAIR', riseM=r2(RISE), runM=r2(GO), widthM=r2(UE - UW), color=DARK)
    if k >= 4:
        box(f'X27-STAIR-WALL-W-{k:02d}', 'wall', Q(-5.65, UW, v0, v1), Z0 - 0.3, max(zt + 1.0, 127.6), '서쪽 높은 짙은 화강석 난간벽(계단과 나란히 단마다)', SRC_S, GS, 'X27-PLATFORM-UPPER-HANLIM-STAIR', color='#33363a')
    box(f'X27-STAIR-WALL-E-{k:02d}', 'wall', Q(UE, 5.55, v0, v1), Z0 - 0.3, zt + 0.5, '동쪽 낮은 짙은 화강석 벽(그 너머 화단·바위 정원)', SRC_S, GS, 'X27-PLATFORM-UPPER-HANLIM-STAIR', color='#33363a')
box('X27-STAIR-WALL-W-04-POST', 'wall', Q(-5.75, UW + 0.1, V0 + GO * 3, V0 + GO * 3 + 0.45), Z0 - 0.3, max(Z0 + RISE * 4 + 1.3, 127.9), '서쪽 난간벽 끝 기둥(머릿돌)', SRC_S, GS, 'X27-PLATFORM-UPPER-HANLIM-STAIR', color='#2c2f33')
box('X27-LANDING', 'landing', Q(UW, UE, VT, 1.45), 127.0, ZL + 0.02, '문 앞 참: 광택 화강석, 깊이 3.2 m(계단 머리 ~ 유리 면)', SRC_S, GS, 'X27-PLATFORM-HANLIM-1F', color='#45484d')
box('X27-LANDING-WALL-W', 'wall', Q(-5.65, UW, VT, 0.6), 127.0, ZL + 1.0, '참 서쪽 끝벽(그 밖은 흰 돌 계단식 화단: 사진 21)', SRC_S, GS, 'X27-PLATFORM-HANLIM-1F', color='#33363a')
box('X27-LANDING-WALL-E', 'wall', Q(UE, 5.55, VT, 0.6), 127.0, ZL + 0.5, '참 동쪽 낮은 벽', SRC_S, GS, 'X27-PLATFORM-HANLIM-1F', color='#33363a')

# ===================== X28 입구 면·차양·큰 아치 틀(질문 1 = 다: 원통 면에 붙은 얕은 틀) =====================
SRC_E = f'사진 17·19·20·21(회전문 둘, 초록 녹청 동판 차양, 밝은 돌 아치 테, 남색 세로 루버), {AER}(밝은 차양 12 x 2.5 m 가 원통 외곽에 바로 붙음: 덩어리 없음)'
GE = '확정(정문: 사용자), 사진(모양·색), 항공사진(차양 자리 ±1.5 m), 추정(높이·아치 곡선)'
VF = 1.5                                              # 유리 면(문) 선
DR = [(-1.8, VF + 0.05), (1.8, VF + 0.05)]; RD = 1.15  # 회전문 둘(지름 2.3 m)
drums = [disc(P(u, v), RD) for u, v in DR]; DRUMS = unary_union(drums)
for k2, d in enumerate(drums):
    box(f'X27-DOOR-REV-{k2 + 1}', 'wall', d, ZL, ZL + 2.4, '회전문(스테인리스 틀 유리 원통)', SRC_E, GE, 'X27-LANDING', color='#9fb3bb')
    box(f'X27-DOOR-REV-{k2 + 1}-CAP', 'wall', d, ZL + 2.4, ZL + 2.65, '회전문 위 원통 덮개(스테인리스)', SRC_E, GE, f'X27-DOOR-REV-{k2 + 1}', color='#c0c3c5')
box('X27-FACADE-GLASS', 'wall', Q(-5.6, 5.6, VF, VF + 0.1).difference(DRUMS.buffer(0.02)), ZL, ZL + 3.8, '입구 철골 유리 면(동쪽 끝 여닫이 유리문 포함)', SRC_E, GE, 'X27-LANDING', color='#3f5866')
u = -5.6; k2 = 0
while u <= 5.6:
    m = Q(u - 0.05, u + 0.05, VF - 0.08, VF)
    if not m.intersects(DRUMS.buffer(0.05)):
        k2 += 1; box(f'X27-FACADE-MULLION-{k2:02d}', 'wall', m, ZL, ZL + 3.8, '유리 면의 짙은 철골 세로 살', SRC_E, GE, 'X27-LANDING', color='#2b2d30')
    u += 1.4
box('X27-DOOR-SWING-FRAME', 'wall', Q(4.3, 5.3, VF - 0.12, VF - 0.08), ZL, ZL + 2.5, '동쪽 끝 여닫이 유리문의 스테인리스 틀', SRC_E, GE, 'X27-LANDING', color='#c0c3c5')
CU0, CU1, CV0, CV1 = -6.0, 6.0, -1.6, VF - 0.05
GREEN = '#3d8c7a'
box('X27-CANOPY', 'canopy', Q(CU0, CU1, CV0, CV1), 130.9, 131.2, '정문 차양: 초록 녹청 동판(윗면)', SRC_E, GE, '없음(유리 면에서 내민 판)', color=GREEN)
box('X27-CANOPY-FASCIA-S', 'canopy', Q(CU0, CU1, CV0, CV0 + 0.15), 130.3, 130.9, '차양 앞 테(동판, 약 1 m)', SRC_E, GE, 'X27-CANOPY', color=GREEN)
box('X27-CANOPY-FASCIA-W', 'canopy', Q(CU0, CU0 + 0.15, CV0 + 0.15, CV1), 130.3, 130.9, '차양 옆 테(동판)', SRC_E, GE, 'X27-CANOPY', color=GREEN)
box('X27-CANOPY-FASCIA-E', 'canopy', Q(CU1 - 0.15, CU1, CV0 + 0.15, CV1), 130.3, 130.9, '차양 옆 테(동판)', SRC_E, GE, 'X27-CANOPY', color=GREEN)
box('X27-CANOPY-SOFFIT', 'canopy', Q(CU0 + 0.15, CU1 - 0.15, CV0 + 0.15, CV1), 130.85, 130.9, '차양 밑면: 밝은 돌판 천장(매입등)', SRC_E, GE, 'X27-CANOPY', color='#d9d5cc')
# 큰 아치 틀: 원통 남서쪽 면에 붙은 얕은 틀(깊이 1.8 m, v -0.3 ~ 1.5). 반폭 7.0 m, 꼭대기 136.2 m(사진 20 에서 차양 위로 문 높이의 약 2 배, 추정). 굽은 면이 형식에 없어 0.4 m 조각으로 나눈다
AW, AH, RIM = 7.0, 9.0, 0.9
def za(u): return ZL + AH * math.sqrt(max(0.0, 1 - (u / AW) ** 2))
GRAY = '#c9c7c2'
uu = np.round(np.arange(-7.6, 7.61, 0.4), 2)
for k3, (a0, a1) in enumerate(zip(uu[:-1], uu[1:])):
    lo, hi = min(za(a0), za(a1)), max(za(a0), za(a1))
    box(f'X27-ARCH-RIM-{k3 + 1:02d}', 'wall', Q(a0, a1, -0.3, 0.5), ZL if abs(a0) >= AW or abs(a1) >= AW else lo, hi + RIM, '큰 아치 틀: 밝은 회색 돌 마감 테(조각)', SRC_E, GE, 'X27-PLATFORM-HANLIM-1F', color=GRAY)
LOBBY = Q(-2.6, 2.6, VF + 0.1, 5.4).difference(DRUMS.buffer(0.02))
for k3, (a0, a1) in enumerate(zip(uu[:-1], uu[1:])):
    hi = max(za(a0), za(a1)) + RIM
    sl = Q(a0, a1, VF + 0.1, 6.0).difference(DRUMS.buffer(0.02)).difference(Q(-2.6, 2.6, VF + 0.1, 5.4))
    box(f'X27-ARCH-BACK-{k3 + 1:02d}', 'wall', sl, ZL, hi, '아치 안쪽 짙은 면(유리 뒤 1층 앞방·원통 밑동까지 채움)', SRC_E, GE, 'X27-PLATFORM-HANLIM-1F', color='#262a2f')
u = -6.4; k3 = 0
while u <= 6.41:
    top = za(u + 0.07) - 0.05
    if top > 131.6:
        k3 += 1; box(f'X27-ARCH-LOUVER-{k3:02d}', 'wall', Q(u, u + 0.14, 1.2, 1.4), 131.25, top, '아치 안 짙은 남색 세로 루버', SRC_E, GE, 'X27-ARCH-BACK', color='#1f2d5a')
    u += 0.4

# ===================== X34 로비 안 부채꼴 계단(1층 안: 127.2 → 128.1) =====================
SRC_L = '사진 22(회전문 안: 흰 대리석 띠 → 부채꼴 계단 5~6단 → 안쪽 로비, 유리 난간·흰 둥근 기둥), 사용자 지시 2026-10-22(1층은 한 층으로 둔다)'
GL = '사진(계단이 있다), 추정(6단·단 높이 0.15·자리. 부채꼴을 곧은 단으로 줄임)'
box('X27-LOBBY-LOW', 'landing', Q(-2.6, 2.6, VF + 0.1, 2.7).difference(DRUMS.buffer(0.02)), 127.0, ZL, '로비 문 안 바닥(흰 대리석 띠)', SRC_L, GL, 'X27-PLATFORM-HANLIM-1F', color='#e8e6e1')
for k in range(1, 7):
    box(f'X27-LOBBY-STAIR-S{k:02d}', 'stair_step', Q(-2.6 + 0.15 * k, 2.6 - 0.15 * k, 2.7 + 0.3 * (k - 1), 2.7 + 0.3 * k), 127.0, ZL + 0.15 * k, f'로비 안 부채꼴 계단 {k}단(곧은 단으로 줄임)', SRC_L, GL, 'X27-PLATFORM-HANLIM-1F',
        stair='X27-LOBBY-STAIR', riseM=0.15, runM=0.3, widthM=r2(5.2 - 0.3 * k), color='#d8d4cc')
box('X27-LOBBY-HIGH', 'landing', Q(-2.6, 2.6, 4.5, 5.4), 127.0, ZL + 0.9, '안쪽 로비 바닥(짙은 돌, 128.1 m 추정: 1층 안)', SRC_L, GL, 'X27-PLATFORM-HANLIM-1F', color='#4a4a4a')
box('X27-LOBBY-CEIL', 'wall', LOBBY, ZL + 3.8, za(2.6) + RIM, '로비 위(아치 안 짙은 면)', SRC_E, GE, 'X27-PLATFORM-HANLIM-1F', color='#262a2f')

# ===================== 기단 고침: 계단·참·바위 정원·곡선 계단 자리 =====================
STAIRZ = unary_union([Q(-5.65, 5.55, V0, VT), Q(UFL, -5.65, V0, V0 + GO * 3)])
LANDZ = Q(-6.0, 6.0, VT, 1.6)
ARCHZ = Q(-7.6, 7.6, -0.3, 6.0)
# 은주1관 곡선 돌계단 중심선(X29): 굽이 쪽 발치 → 남남동 → 반원 테라스
TC, TR = (201119.6, 557253.0), 6.0
TERR = disc(TC, TR, 40).intersection(Polygon([(201100, 557240), (201119.4, 557240), (201119.4, 557266), (201100, 557266)])).difference(EUNJU.buffer(0.02))
CL0 = [(201112.3, 557268.0), (201113.2, 557264.9), (201114.0, 557261.0), (201115.0, 557258.4)]
dvec = np.array(TC) - np.array(CL0[-1]); dist = np.hypot(*dvec); edge = np.array(CL0[-1]) + dvec / dist * (dist - TR + 0.05)
CLINE = LineString(CL0 + [tuple(edge)])
CSZ = CLINE.buffer(1.6, cap_style=2).difference(TERR)
OLDW = unary_union([OLD['Z05-PLATFORM-UPPER-HANLIM-SOUTH'], OLD['Z05-PLATFORM-EUNJU-EUNJU1-NW'], OLD['Z05-PLATFORM-EUNJU-EUNJU1-WEST'].intersection(Polygon([(201100, 557247), (201130, 557247), (201130, 557290), (201100, 557290)])),
                   OLD['Z05-PLATFORM-UPPER-HANLIM-FRONT'].difference(STAIRZ).intersection(Polygon([(201100, 557240), (201130, 557240), (201130, 557290)]))])
W = OLDW.difference(STAIRZ).difference(LANDZ).difference(ARCHZ).difference(U1).difference(ESLOT).difference(HANLIM).difference(EUNJU).buffer(0)
# 바위 정원 쪽(동·북)과 곡선 계단·화단 쪽(서·남)을 나누는 선: 곡선 계단 동쪽 가장자리
east_edge = CLINE.offset_curve(1.6)
ee = list(east_edge.coords)
if ee[0][1] < ee[-1][1]: ee = ee[::-1]
RGSIDE = Polygon([(201109.73, 557270.29), (ee[0][0], ee[0][1] + 1.0)] + ee + [(201119.4, 557259.0), (201130, 557259.0), (201130, 557292), (201109.0, 557292), (201109.0, 557272)]).buffer(0)
RG = W.intersection(RGSIDE).difference(TERR).difference(CSZ).buffer(0)
LOW = W.difference(RGSIDE).difference(TERR).buffer(0).union(CSZ.intersection(W.buffer(1.0)).difference(U1)).buffer(0)
TERRZ = TERR.intersection(W.buffer(0.5)).buffer(0)
# 길 따라 오르는 화단·곡선 계단 바닥: 북좌표 557266 125.2 → 557247 128.4(위쪽 갈래 차도 종단과 나란히)
LOWPROF = {'origin': [201111.0, 557266.0], 'direction': [0.0, -1.0], 'points': [[0.0, 125.2], [19.0, 128.4]]}
NEWP = {
    'X27-PLATFORM-UPPER-HANLIM-STAIR': (unary_union([OLD['Z05-PLATFORM-UPPER-HANLIM-FRONT'], STAIRZ]).difference(LANDZ).difference(RG).difference(LOW).difference(U1).buffer(0), 125.0, 'paving',
        '정문 계단 밑과 발치 앞(계단 상자가 얹히는 바탕): 차도 높이 한 면. 옛 HANLIM-FRONT 경사면(125.2→126.6)을 대신한다', '항공사진(계단 자리), S-MAP·사용자 핀(차도 125.1), 추정(외곽)'),
    'X27-PLATFORM-UPPER-ROCKGARDEN': (RG, 125.6, 'rock', '바위 정원 바탕(물 자리·흰 돌 바닥 높이): 그 위에 막돌 단 셋을 상자로 얹는다. 옛 HANLIM-SOUTH·EUNJU1-NW 경사면 자리', '사진 17·19(막돌 단·물 자리), 구역 노트 X30(바탕 125.6), 추정(외곽)'),
    'X27-PLATFORM-EUNJU-STAIR-BED': (LOW, LOWPROF, 'planting', '은주1관 곡선 돌계단 밑과 차도 쪽 철쭉 화단 바탕: 위쪽 갈래 차도와 나란히 남쪽으로 오르는 한 경사면', '사진 은주관-곡선계단(철쭉 화단), 항공사진, 추정(외곽·높이 = 차도 종단 + 0)'),
    'X27-PLATFORM-EUNJU-TERRACE-BASE': (TERRZ, 125.6, 'concrete', '반원 테라스(131.3) 밑 바탕: 테라스 상자가 얹힌다', '사진 19·은주관-곡선계단, B15 후보 A, 추정'),
}
# 옛 기단 외곽 고침(구조물·지형 입력 모두)
CUT = unary_union([STAIRZ, LANDZ, ARCHZ.intersection(OLD['Z05-PLATFORM-UPPER-HANLIM-SOUTH']), RG, LOW, TERRZ]).buffer(0)
CHANGED = {}
for fid in EDIT:
    if fid == 'Z05-PLATFORM-UPPER-HANLIM-1F':
        g = unary_union([OLD[fid].difference(STAIRZ), LANDZ.difference(HANLIM.buffer(-1.0))]).buffer(0); gs = unary_union([OLDS[fid].difference(STAIRZ), LANDZ.difference(HANLIM.buffer(-1.0))]).buffer(0) if OLDS[fid] else None
    elif fid == 'Z05-PLATFORM-UPPER-HANLIM-FRONT':
        g = None; gs = None                                   # X27-PLATFORM-UPPER-HANLIM-STAIR 가 대신한다
    else:
        g = OLD[fid].difference(CUT).buffer(0); gs = OLDS[fid].difference(CUT).buffer(0) if OLDS[fid] else None
    CHANGED[fid] = (g, gs)
for fn in ('z05-upper-branch.geojson', 'z05-eunju.geojson'):
    d = FILES[fn]; out = []
    for f in d['features']:
        i = f['properties']['id']
        if i.startswith('Z05-HANLIM-FRONT-STAIR-'): continue   # 옛 13단 정문 계단(X27 이 대신)
        if i in CHANGED:
            g = CHANGED[i][0]
            if g is None or g.is_empty or g.area < 1.0: continue
            f['geometry'] = geom(g)
            f['properties']['assumption'] = f['properties']['assumption'].split(' [X27')[0] + ' [X27 2026-10-22: 정문 계단·참·바위 정원·곡선 계단 자리를 뺌(사용자 항공사진)]'
        out.append(f)
    d['features'] = out; dump(STR / fn, d)
z10 = FILES['z10-parts.geojson']; z10['features'] = [f for f in z10['features'] if f['properties']['id'] != 'Z10-HANLIM-1F-CANOPY']; dump(STR / 'z10-parts.geojson', z10)
# 지형 입력
sname = {fid: BASE[fid]['surfaceName'] for fid in EDIT}
sfeats = []
for s in SURF['features']:
    nm = s['properties']['name']
    if nm.startswith('X27-'): continue
    hit = [fid for fid in EDIT if sname.get(fid) == nm]
    if hit:
        gs = CHANGED[hit[0]][1]
        if gs is None or gs.is_empty or gs.area < 1.0: continue
        s['geometry'] = geom(gs)
    sfeats.append(s)
for pid, (g, top, mat, what, grade) in NEWP.items():
    sp = {'name': pid.replace('-PLATFORM', ''), 'srid': 5186, 'reason': 'X27 ' + what.split(':')[0], 'grade': grade, 'source': AER}
    if isinstance(top, dict): sp['profile'] = top
    else: sp['heightM'] = top
    sfeats.append({'type': 'Feature', 'properties': sp, 'geometry': geom(g)})
lowz = lambda f: f['properties'].get('heightM', min([p[1] for p in f['properties'].get('profile', {}).get('points', [[0, 0]])]))
SURF['features'] = sorted(sfeats, key=lowz); dump(REC / 'z05-surface.geojson', SURF)
PFEATS = []
for pid, (g, top, mat, what, grade) in NEWP.items():
    pr = {'id': pid, 'type': 'platform', 'kind': 'platform', 'estimated': True, 'grade': grade, 'surfaceName': pid.replace('-PLATFORM', ''), 'bottomM': 122.0, 'bottomNote': '옆 기단의 윗면보다 아래(틈이 없게)', 'material': mat, 'assumption': what, 'source': AER}
    if isinstance(top, dict): pr['topProfile'] = top
    else: pr['topM'] = top
    PFEATS.append({'type': 'Feature', 'properties': pr, 'geometry': geom(g)})
    PLATS.append((big(g), pr))

# ===================== X29 은주1관 곡선 돌계단·반원 테라스 =====================
SRC_C = f'사진 은주관-곡선계단-차단기(아래 몇 단 + 휘는 난간벽 긴 한 줄 + 위 참), 은주관-횡단보도에서-화살표(사용자 화살표 ✓), 사진 19, {AER}(S자 밝은 난간 선·반원 테라스 호)'
GC = '확정(굽이에서 곡선 계단으로 올라 은주1관 입구(1): 사용자 화살표), 사진·항공사진(모양·자리 ±1.5 m), 추정(단 수·높이 나눔)'
ZF, ZT = 125.2, 131.3; NB, NM = 4, 37; RISE2 = (ZT - ZF) / (NB + NM); LAND1, LAND2 = 1.0, 1.2
Lp = CLINE.length; G2 = (Lp - LAND1 - LAND2) / ((NB - 1) + (NM - 1) + 2)
segs = []; s = 0.0; z = ZF
for k in range(1, NB):
    segs.append((s, s + G2, z + RISE2)); s += G2; z += RISE2
segs.append((s, s + LAND1, z + RISE2)); s += LAND1; z += RISE2           # 4단째 = 작은 참
for k in range(1, NM):
    segs.append((s, s + G2, z + RISE2)); s += G2; z += RISE2
segs.append((s, Lp, ZT))                                                 # 위 참(131.3)
CS_SEGS = segs
STONE = '#d8d3c7'
for k, (s0, s1, zt) in enumerate(segs, 1):
    sub = substring(CLINE, s0, s1)
    step = sub.buffer(1.2, cap_style=2).difference(TERR)
    typ = 'landing' if (s1 - s0) > G2 + 0.01 else 'stair_step'
    extra = dict(stair='X27-EUNJU-STAIR', riseM=r2(RISE2), runM=r2(G2), widthM=2.4) if typ == 'stair_step' else {}
    box(f'X27-EUNJU-STAIR-S{k:02d}', typ, step, ZF - 0.3, zt, f'은주1관 곡선 돌계단 {k}(밝은 화강석. 아래 3단 + 작은 참 + 긴 한 줄 + 위 참, {ZF} → {ZT} m)', SRC_C, GC, 'X27-PLATFORM-EUNJU-STAIR-BED', color='#cfcac0', **extra)
    band = lambda o0, o1: Polygon(list(sub.offset_curve(o0).coords) + list(sub.offset_curve(o1).coords)[::-1]).buffer(0)
    west = band(-1.2, -1.5)
    box(f'X27-EUNJU-STAIR-WALL-W-{k:02d}', 'wall', west.difference(TERR), ZF - 0.3, zt + 1.0, '차도 쪽 휘는 밝은 화강석 난간벽(S자)', SRC_C, GC, 'X27-PLATFORM-EUNJU-STAIR-BED', color=STONE)
    east = band(1.2, 1.45).difference(TERR)
    box(f'X27-EUNJU-STAIR-WALL-E-{k:02d}', 'wall', east, ZF - 0.3, zt + 0.5, '바위 정원 쪽 막돌 벽 머리', SRC_C, GC, 'X27-PLATFORM-EUNJU-STAIR-BED', color='#b49a86')
box('X27-EUNJU-TERRACE', 'landing', TERR, 125.6, ZT, '은주1관 아치 문 앞 반원 테라스(131.3 m = 입구(1) 1층 바닥). 서쪽 굽은 면은 분홍빛 막돌 쌓기', SRC_C, GC, 'X27-PLATFORM-EUNJU-TERRACE-BASE', color='#cbbfae')
ang_in = math.degrees(math.atan2(edge[1] - TC[1], edge[0] - TC[0])) % 360
for k, a in enumerate(range(100, 262, 6)):
    if abs(((a + 3) - ang_in + 180) % 360 - 180) < 11: continue
    seg = Polygon([(TC[0] + r * math.cos(math.radians(t)), TC[1] + r * math.sin(math.radians(t))) for r, t in ((TR - 0.3, a), (TR, a), (TR, a + 6), (TR - 0.3, a + 6))]).difference(EUNJU)
    box(f'X27-EUNJU-TERRACE-RAIL-{k + 1:02d}', 'wall', seg, ZT, ZT + 1.0, '테라스 가장자리 돌 난간("아치 다리" 위 난간)', SRC_C, GC, 'X27-EUNJU-TERRACE', color='#e3dfd5')
for k, a in enumerate((150, 172, 194, 216)):
    seg = Polygon([(TC[0] + r * math.cos(math.radians(t)), TC[1] + r * math.sin(math.radians(t))) for r, t in ((TR, a - 4), (TR + 0.06, a - 4), (TR + 0.06, a + 4), (TR, a + 4))])
    box(f'X27-EUNJU-TERRACE-ARCH-{k + 1}', 'wall', seg, 125.6, 128.9, '테라스 밑 아치 아케이드의 어두운 구멍(굽은 면에 붙인 판)', SRC_C, GC, 'X27-EUNJU-TERRACE', material='opening')
for k, dy in enumerate((2.6, -2.6)):
    c = (TC[0] - 3.9, TC[1] + dy)
    box(f'X27-EUNJU-TERRACE-POT-{k + 1}', 'planter', disc(c, 0.8, 12), ZT, ZT + 0.6, '테라스 둥근 돌 화분(B15)', SRC_C, GC, 'X27-EUNJU-TERRACE', color='#d6d0c4', topColor='#6f8a55')
# 차도 쪽 철쭉 화단(곡선 계단과 차도 사이): 2 m 마디로 경사를 따라
bed = LOW.difference(CLINE.buffer(1.55, cap_style=2)).difference(TERR.buffer(0.1))
for k, y0 in enumerate(np.arange(557246.0, 557268.0, 2.0)):
    part = bed.intersection(Polygon([(201100, y0), (201125, y0), (201125, y0 + 2.0), (201100, y0 + 2.0)]))
    if part.area < 0.3: continue
    zb = ptop({'topProfile': LOWPROF}, 201111.0, y0 + 2.0)
    box(f'X27-EUNJU-BED-{k + 1:02d}', 'planter', part, zb - 0.3, zb + 0.5, '곡선 계단과 차도 사이 철쭉 화단(낮은 돌 턱)', SRC_C, GC, 'X27-PLATFORM-EUNJU-STAIR-BED', color='#b9b3a8', topColor='#a2546f')

# ===================== X30 바위 정원 =====================
SRC_R = '사진 19(분홍빛 막돌 단·짙은 돌 상자·흰 돌 동물상 둘·선 돌·큰 바위·흰 돌 바닥), 17·20(소나무·대나무), ' + AER + '(물 자리 청록 점)'
GR = '사진(있음·모양), 추정(단 높이 1.0 m 씩·자리·크기. 단 꼭대기 128.6 = 옛 S-MAP 경사면 꼭대기)'
def vof(x, y): return (x - C[0]) * N[0] + (y - C[1]) * N[1]
def vband(v0, v1):
    return Polygon([P(-30, v0), P(40, v0), P(40, v1), P(-30, v1)])
LEVELS = [(-6.0, -3.5, 126.6), (-3.5, -1.0, 127.6), (-1.0, 9.0, 128.6)]
RGB = RG.difference(ARCHZ.buffer(0.05)).difference(CLINE.buffer(1.55, cap_style=2))
bands = []
for k, (v0, v1, zt) in enumerate(LEVELS, 1):
    part = RGB.intersection(vband(v0, v1)).buffer(-0.05).buffer(0.05)
    for j, g in enumerate([part] if part.geom_type == 'Polygon' else sorted(part.geoms, key=lambda q: -q.area)):
        if g.area < 1.0: continue
        box(f'X27-ROCK-TIER{k}-{j + 1}', 'planter', g, 125.3, zt, f'바위 정원 막돌 단 {k}(분홍빛 막돌 쌓기, 윗면은 심은 흙)', SRC_R, GR, 'X27-PLATFORM-UPPER-ROCKGARDEN', color='#b8a08e', topColor='#6f8a55')
        bands.append((k, g, zt))
lowz_ = RGB.intersection(vband(-30, -6.0))
wc = (201115.8, 557264.2)
water = disc(wc, 1.4, 14).intersection(lowz_)
box('X27-ROCK-WATER', 'wall', water, 125.6, 125.64, '물 자리(청록: 항공사진)', SRC_R, GR, 'X27-PLATFORM-UPPER-ROCKGARDEN', material='water')
box('X27-ROCK-PEBBLES', 'wall', lowz_.difference(disc(wc, 1.45, 14)).intersection(disc((201114.8, 557265.5), 3.2, 18)), 125.6, 125.63, '흰 돌 바닥(마른 물길)', SRC_R, GR, 'X27-PLATFORM-UPPER-ROCKGARDEN', color='#e6e4dc')
_bp = lowz_.difference(CLINE.buffer(2.7)).difference(disc(wc, 1.5)).representative_point()
box('X27-ROCK-BOULDER', 'wall', disc((_bp.x, _bp.y), 0.9, 7).intersection(lowz_), 125.6, 126.8, '큰 바위', SRC_R, GR, 'X27-PLATFORM-UPPER-ROCKGARDEN', color='#7c7f7a')
def inside_pt(g, frac):
    c = g.centroid
    return (c.x, c.y) if g.contains(c) else (g.representative_point().x, g.representative_point().y)
if len(bands) >= 2:
    k1 = [b for b in bands if b[0] == 1][0]; k2 = [b for b in bands if b[0] == 2][0]
    c1 = inside_pt(k1[1], 0.5); c2 = inside_pt(k2[1], 0.5)
    sq = lambda c, h: Polygon([(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)])
    box('X27-ROCK-DARKBOX', 'wall', sq(c2, 1.2).intersection(k2[1].buffer(-0.1)), k2[2], k2[2] + 2.2, '짙은 돌 상자(막돌 단 위)', SRC_R, GR, 'X27-ROCK-TIER2-1', color='#55595d')
    for j, dx in enumerate((-1.2, 0.9)):
        cc = (c1[0] + dx, c1[1] - 0.4)
        if k1[1].contains(Point(cc)): box(f'X27-ROCK-STATUE-{j + 1}', 'wall', sq(cc, 0.28), k1[2], k1[2] + 0.55, '흰 돌 동물상(단 위)', SRC_R, GR, 'X27-ROCK-TIER1-1', color='#efeee9')
    cs = (c1[0] - 0.2, c1[1] + 0.6)
    if k1[1].contains(Point(cs)): box('X27-ROCK-STANDINGSTONE', 'wall', sq(cs, 0.3), k1[2], k1[2] + 1.6, '선 돌', SRC_R, GR, 'X27-ROCK-TIER1-1', color='#8e8f8b')
    for j, (k, g, zt) in enumerate(bands[:3]):
        pt = g.representative_point(); tree(f'X27-ROCK-PINE-{j + 1}', (pt.x, pt.y), zt, f'X27-ROCK-TIER{k}-1', SRC_R, GR, h=1.1)

# ===================== X31 차단기 =====================
SRC_B = f'사진 은주관-곡선계단-차단기(빨강·흰 막대), {AER}(위쪽 갈래 북좌표 557262.5 의 밝은 막대)'
GB = '사진(있음), 항공사진(자리 ±1.5 m), 추정(기둥 = 동쪽, 높이)'
YB = 557262.5; zr, _ = ground(201107.5, YB)
box('X27-BARRIER-POST', 'barrier', Polygon([(201110.75, YB - 0.2), (201111.15, YB - 0.2), (201111.15, YB + 0.2), (201110.75, YB + 0.2)]), zr - 0.2, zr + 1.05, '차단기 기둥 함(동쪽, 회색)', SRC_B, GB, 'Z05-PLATFORM-UPPER-U1-10', color='#d6d6d2')
xs = np.arange(201104.6, 201110.75, 0.5)
for k, x0 in enumerate(xs):
    box(f'X27-BARRIER-ARM-{k + 1:02d}', 'barrier', Polygon([(x0, YB - 0.04), (min(x0 + 0.5, 201110.75), YB - 0.04), (min(x0 + 0.5, 201110.75), YB + 0.04), (x0, YB + 0.04)]), zr + 0.86, zr + 0.94,
        '차단기 막대(빨강·흰 띠, 길 폭 6.2 m). 길 속성은 그대로(보행 허용)', SRC_B, GB, 'X27-BARRIER-POST', color='#c8262c' if k % 2 == 0 else '#f2f2ee')

# ===================== X33 과속방지턱(위쪽 갈래, 항공사진에 보이는 것만) =====================
SRC_X = f'{AER}(밝은 띠), S-MAP 정사 화면(같은 자리 201108.4, 557255.9)'
GX = '항공사진·S-MAP(자리 ±1 m), 추정(무늬)'
YS_ = 557255.7; zb_, base_ = ground(201108.0, YS_)
for k, x0 in enumerate(np.arange(201105.6, 201111.0, 0.6)):
    box(f'X27-BUMP-UPPER-{k + 1:02d}', 'wall', Polygon([(x0, YS_ - 0.45), (x0 + 0.6, YS_ - 0.45), (x0 + 0.6, YS_ + 0.45), (x0, YS_ + 0.45)]), zb_ - 0.1, zb_ + 0.08, '과속방지턱(노랑·흰 줄)', SRC_X, GX, base_, color='#f2c230' if k % 2 == 0 else '#f2f2ee')

# ===================== X35 유담관 북동 1층 짙은 화강석 기둥 =====================
SRC_Y = '사진 은주관-횡단보도에서-화살표(오른쪽 가까운 건물 = 유담관 북동 모서리: 짙은 화강석 큰 기둥 + 유리, 위는 세로 루버)'
GY = '사진(있음), 추정(기둥 수·자리·크기: 외곽 북동 면에 0.5 m 띄움, 높이 = 1층 약 6 m)'
pa, pb = np.array([201076.39, 557260.18]), np.array([201060.0, 557270.87]); ta = (pb - pa) / np.hypot(*(pb - pa)); na = np.array([ta[1], -ta[0]])
if na @ (np.array([201080.0, 557275.0]) - pa) < 0: na = -na
for k, s_ in enumerate((1.2, 4.6, 8.0)):
    c = pa + ta * s_ + na * 0.95; zg, bp = ground(*c)
    sq4 = Polygon([tuple(c + ta * a + na * b) for a, b in ((-0.45, -0.45), (0.45, -0.45), (0.45, 0.45), (-0.45, 0.45))])
    box(f'X27-YUDAM-NE-COLUMN-{k + 1}', 'wall', sq4, zg - 0.2, zg + 6.0, '유담관 북동 1층 짙은 화강석 기둥(겉모습)', SRC_Y, GY, bp, color='#3b3c3f')

dump(STR / OWN, {'type': 'FeatureCollection', 'name': 'x27-hanlim-front', 'crs': CRS,
  'provenance': {'builder': 'docs/audit/x27/build_parts.py', 'basePlanes': 'backend/data/terrain/recipes/z05-surface.geojson', 'schema': 'docs/audit/g02/STRUCTURES.md',
                 'note': f'X27~X35 한림관 정문 앞({NOTE}). 평면 = {AER}. 치수는 사진 눈대중이라 전부 estimated.'}, 'features': PFEATS + FEATS})
json.dump({'frame': {'C': C.tolist(), 'A': A.tolist(), 'N': N.tolist()}, 'mainStair': {'foot': [r2(c) for c in P(0, V0)], 'top': [r2(c) for c in P(0, VT)], 'door': [r2(c) for c in P(0, VF)], 'rise': r2(RISE), 'going': r2(GO)},
           'eunjuStair': {'line': [[r2(x), r2(y)] for x, y in CLINE.coords], 'segs': [[r2(a), r2(b), r2(z)] for a, b, z in CS_SEGS], 'rise': round(RISE2, 3), 'going': r2(G2), 'length': r2(Lp)},
           'terrace': {'center': TC, 'r': TR}, 'barrierY': YB, 'zRoadBarrier': r2(zr)}, open(HERE / 'model.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('x27 기단', len(PFEATS), '상자', len(FEATS), '곡선 계단 길이', r2(Lp), '단', len(CS_SEGS), '단 높이', round(RISE2, 3), '디딤', r2(G2))
