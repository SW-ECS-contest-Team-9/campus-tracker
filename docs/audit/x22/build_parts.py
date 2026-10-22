"""X22(2026-10-22): 전경 영상·사진 비교(볼트 데이터/모델링 개선/2026-10-22 전경 영상 비교.md, X01~X17)와 같은 날 사용자 답으로 고친 구조물. DB·네트워크 접근 없음.
  python -I build_parts.py
쓰는 파일:
  frontend/public/structures/x22-photo-fixes.geojson   새 상자(가로등, 유리 연결 통로, 옥상 마당, 데크 둘레, 본관 입구(3) 문틀, 은주관 입구 골강판 상자, 청운관 앞 표지석·작은 계단, Skon Square 글자, 데크 뒤 나무 줄 화단)
  frontend/public/structures/z02-daeil-front.geojson   (고침) 대일관 앞 데크·앞 화단·동쪽 끝 계단을 항공사진대로. id 로 찾아 고치므로 몇 번 돌려도 같다
  frontend/public/structures/z05-upper-branch.geojson  (고침) Z07 덮인 복도의 옆벽·덮개와 데크 쪽 바닥 마디, 나무 난간을 걷음(X01)
  frontend/public/structures/u03-underground-walk.geojson (고침) 본관–한림관 파란 둥근 지붕 통로(2018 년 모습)를 걷음(X02: 지금은 유리 통로)
  frontend/public/structures/z06-trees.geojson          (고침) 대일관 앞 화단(앞쪽)의 소나무를 걷음: 나무는 데크 뒤 줄 화단에 있다(항공사진)
돌리는 차례: z02/build_inputs.py → b14/build_parts.py → (u01·u02) → z05 → u03 → z06/trees.py → 이 스크립트. 앞 스크립트를 다시 돌리면 이것도 다시 돌린다.
좌표 EPSG:5186. 등급: 확정(사용자) / 원천 / S-MAP / 추정. 치수는 거의 사진 눈대중(추정).
"""
import json, math, pathlib, sys, importlib.util
import numpy as np
from shapely.geometry import Polygon, Point, LineString
from shapely.ops import unary_union

HERE = pathlib.Path(__file__).parent; AUDIT = HERE.parent; REPO = AUDIT.parents[1]
STR = REPO / 'frontend' / 'public' / 'structures'
def _mod(name, path):
    sp = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m); return m
G = _mod('g02common', AUDIT / 'g02' / 'common.py')    # 오르막길 축 (s, t), way_z
Z = _mod('z02common', AUDIT / 'z02' / 'common.py')    # 대일관 정면 축 (u, v)
r2 = lambda v: round(float(v), 2)
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}
NOTE = '볼트 데이터/모델링 개선/2026-10-22 전경 영상 비교.md'
def load(fn): return json.loads((STR / fn).read_text(encoding='utf-8'))
def dump(fn, obj): (STR / fn).write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
def ring(pts):
    p = [[r2(x), r2(y)] for x, y in pts]
    if Polygon(p).exterior.is_ccw is False: p = p[::-1]
    return p + [p[0]]
def geom(poly):
    poly = poly.buffer(0)
    if poly.geom_type != 'Polygon': poly = max(poly.geoms, key=lambda g: g.area)
    return {'type': 'Polygon', 'coordinates': [ring(list(poly.exterior.coords)[:-1])] + [ring(list(i.coords)[:-1]) for i in poly.interiors]}
FEATS = []
def box(id, typ, pts_or_poly, z0, z1, assumption, source, grade='추정', base='', **extra):
    g = geom(pts_or_poly if isinstance(pts_or_poly, Polygon) else Polygon(pts_or_poly))
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base, 'fromM': r2(z0), 'toM': r2(z1),
        'assumption': assumption, 'source': source, **extra}, 'geometry': g})
def rect_frame(o, a, b, a0, a1, b0, b1):
    """원점 o, 단위 벡터 a·b 의 틀에서 [a0,a1] x [b0,b1] 네모의 네 꼭짓점."""
    o, a, b = map(np.asarray, (o, a, b))
    return [tuple(o + a * p + b * q) for p, q in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))]
def disc(c, r, n=14): return Polygon([(c[0] + r * math.cos(2 * math.pi * k / n), c[1] + r * math.sin(2 * math.pi * k / n)) for k in range(n)])
def st(s, t): return tuple(float(v) for v in G.st_to_xy(s, t))
def uv(u, v): return tuple(float(c) for c in Z.uv_to_xy(u, v))

# 이웃 상자(윗면 높이를 읽고 basePlane 으로 적는다)
ALL = {}
for fn in sorted(STR.glob('*.geojson')):
    if fn.name == 'x22-photo-fixes.geojson': continue
    for f in json.loads(fn.read_text(encoding='utf-8'))['features']:
        if f.get('geometry'): ALL[f['properties']['id']] = f
def top_at(fid, x, y):
    p = ALL[fid]['properties']; pr = p.get('topProfile')
    if not pr: return float(p.get('toM', p.get('topM')))
    L = math.hypot(*pr['direction']); d = ((x - pr['origin'][0]) * pr['direction'][0] + (y - pr['origin'][1]) * pr['direction'][1]) / L
    return float(np.interp(d, [q[0] for q in pr['points']], [q[1] for q in pr['points']]))
def holder(x, y, prefixes):
    """(x, y) 를 덮는 상자 가운데 id 가 prefixes 로 시작하는 것(가장 높은 윗면)."""
    best = None
    for fid, f in ALL.items():
        if f['properties'].get('kind') != 'extrude' or not fid.startswith(prefixes): continue
        if Polygon(f['geometry']['coordinates'][0]).contains(Point(x, y)):
            z = top_at(fid, x, y)
            if best is None or z > best[1]: best = (fid, z)
    if best is None: raise SystemExit(f'받칠 상자가 없음 {x:.1f},{y:.1f} {prefixes}')
    return best

# ===================== X03 가로등 =====================
SRC_A = '사진 05·06·08(KakaoTalk_20261022_143522517_05·06·08), 전경 영상 0~46 초, 사진 09·11'
LAMP_GREY, LAMP_LIGHT = '#8e9396', '#fff4cf'
def lamp_a(id, x, y, toward, prefixes, h=6.0, what=''):
    """가로등 A: 회색 둥근 기둥(네모 0.16 m 로 줄임) + 양쪽으로 뻗은 머리 둘(아래에 빛 판). toward = 길 쪽 단위 벡터."""
    fid, z = holder(x, y, prefixes); a = np.asarray(toward, float) / np.hypot(*toward); b = np.array([-a[1], a[0]])
    g = '확정(있음: 사진), 추정(자리 = 화단 안 고른 간격 약 12 m, 높이 6 m, 머리 모양)'
    box(id, 'wall', rect_frame((x, y), a, b, -0.08, 0.08, -0.08, 0.08), z, z + h, f'가로등 기둥{what}: 회색, 높이 {h} m(추정). 둥근 기둥을 0.16 m 네모로 줄임', SRC_A, g, fid, color=LAMP_GREY)
    for k, sg in ((1, 1), (2, -1)):
        box(f'{id}-HEAD{k}', 'wall', rect_frame((x, y), a, b, *sorted((sg * 0.08, sg * 0.7)), -0.14, 0.14), z + h - 0.18, z + h, '가로등 머리(납작한 LED 등, 양쪽: 사진 06 의 쌍머리)', SRC_A, g, id, color=LAMP_GREY)
        box(f'{id}-LIGHT{k}', 'wall', rect_frame((x, y), a, b, *sorted((sg * 0.2, sg * 0.66)), -0.11, 0.11), z + h - 0.2, z + h - 0.18, '머리 밑 빛 판', SRC_A, g, f'{id}-HEAD{k}', color=LAMP_LIGHT)
# 오르막 북쪽(문예관·북악관 쪽) 화단: 차도 쪽(-t)으로
N_AX = np.array([float(v) for v in G.st_to_xy(0, 1)]) - np.array([float(v) for v in G.st_to_xy(0, 0)])
k = 0
for s_ in (22.0, 29.0, 40.0, 52.0, 64.0, 78.0, 90.0):
    k += 1; lamp_a(f'X22-LAMP-UPN-{k:02d}', *st(s_, 5.1), -N_AX, ('G03-NPLANT', 'G02-NPLANT'))
# 남쪽(본관 쪽) 옹벽 뒤 화단: 차도 쪽(+t)으로. s 59.2~63.4 는 본관 입구(3) 앞이라 뺌
k = 0
for s_ in (24.0, 36.0, 48.0, 66.0, 78.0, 90.0, 102.0):
    t_ = -4.6 if s_ < 69.3 else -4.85
    k += 1; lamp_a(f'X22-LAMP-UPS-{k:02d}', *st(s_, t_), N_AX, ('G03-SBED',))
# 운동장 가장자리: 대일관 앞 화단(앞쪽) 위, 운동장 쪽(+v)으로
V_AX = np.array(uv(0, 1)) - np.array(uv(0, 0))
k = 0
for u_, pre in ((16.0, 'Z02-PLANTER-MAIN'), (22.0, 'Z02-PLANTER-MAIN'), (38.0, 'Z02-PLANTER-MAIN'), (47.0, 'Z02-PLANTER-EAST')):
    k += 1; lamp_a(f'X22-LAMP-FIELD-{k:02d}', *uv(u_, 5.6 if u_ < 40 else 4.4), V_AX, (pre,), h=5.0, what='(운동장 가장자리 화단)')

# 가로등 B: 북악관 정문 계단 앞 화단 가장자리 둘(짙은 빨강 각진 기둥 + 한쪽으로 뻗은 납작한 네모 LED 머리)
SRC_B = '사진 04(KakaoTalk_20261022_143522517_04, 야간), 사용자 2026-10-22 "화단과 고급스런 전봇대"'
GB = '확정(있음·모양: 사진 04, 사용자), 추정(자리 ±4 m: 동쪽 화단 서쪽 가장자리, 서쪽 화단 남동 모서리. 높이 5.5 m, 머리 1.3 m)'
STAIR_MID = np.array(st(-8.8, 9.0))
for nm, (x, y), pre in (('E', (201045.7, 557359.6), ('G02-BUKAK-PLANTER-E',)), ('W', (201032.6, 557369.0), ('Z10-BUKAK-FRONT-PLANTER-W4',))):
    fid, z = holder(x, y, pre); a = STAIR_MID - (x, y); a = a / np.hypot(*a); b = np.array([-a[1], a[0]]); id = f'X22-LAMP-BUKAK-{nm}'
    box(id, 'wall', rect_frame((x, y), a, b, -0.11, 0.11, -0.11, 0.11), z, z + 5.5, '고급 가로등 기둥: 짙은 빨강 각진 기둥(0.22 m 네모)', SRC_B, GB, fid, color='#6e1f24')
    box(id + '-ARM', 'wall', rect_frame((x, y), a, b, 0.11, 0.45, -0.06, 0.06), z + 5.2, z + 5.5, '기둥 머리에서 계단 쪽으로 뻗은 팔', SRC_B, GB, id, color='#6e1f24')
    box(id + '-HEAD', 'wall', rect_frame((x, y), a, b, 0.45, 1.75, -0.2, 0.2), z + 5.38, z + 5.5, '납작한 네모 LED 머리(한쪽으로 뻗음)', SRC_B, GB, id + '-ARM', color='#2a2a2d')
    box(id + '-LIGHT', 'wall', rect_frame((x, y), a, b, 0.5, 1.7, -0.16, 0.16), z + 5.36, z + 5.38, 'LED 머리 밑 빛 판', SRC_B, GB, id + '-HEAD', color=LAMP_LIGHT)

# ===================== X04 본관 입구(3) 문틀과 빨간 틀 유리문 =====================
# 옹벽 틈(s 59.2~63.4) 안쪽 본관 북쪽 벽(t = WALL_T, g02 build_inputs.py: 처마 선 t −4.9 에서 1.5 m 안쪽 + 5 cm)
SRC_D = '전경 영상 42~44 초(frames/t022.jpg), 동 노트 본관(입구(3) 문 앞 139.9 m)'
GD = '확정(있음: 영상, 학교 표지 입구(3)), 추정(폭 2.5 m·높이 3 m·자리 = 옹벽 틈 가운데)'
WT = -4.9 - 1.5 + 0.05; SC = 61.3; ZF = 139.9
TA = np.array(st(1, 0)) - np.array(st(0, 0)); NA = np.array(st(0, 1)) - np.array(st(0, 0))
o = np.array(st(SC, WT))
box('X22-BONGWAN-ENT3-JAMB-W', 'wall', rect_frame(o, TA, NA, -1.65, -1.2, 0.0, 0.35), ZF - 0.1, ZF + 2.6, '입구(3) 흰 돌 문틀(서쪽 기둥)', SRC_D, GD, color='#e6e3da')
box('X22-BONGWAN-ENT3-JAMB-E', 'wall', rect_frame(o, TA, NA, 1.2, 1.65, 0.0, 0.35), ZF - 0.1, ZF + 2.6, '입구(3) 흰 돌 문틀(동쪽 기둥)', SRC_D, GD, color='#e6e3da')
box('X22-BONGWAN-ENT3-LINTEL', 'wall', rect_frame(o, TA, NA, -1.65, 1.65, 0.0, 0.35), ZF + 2.6, ZF + 3.1, '입구(3) 흰 돌 문틀(위 보)', SRC_D, GD, 'X22-BONGWAN-ENT3-JAMB-W', color='#e6e3da')
box('X22-BONGWAN-ENT3-IVY', 'wall', rect_frame(o, TA, NA, -1.9, 1.9, 0.0, 0.12), ZF + 3.1, ZF + 4.6, '문틀 위 담쟁이 덮인 벽', SRC_D, GD, 'X22-BONGWAN-ENT3-LINTEL', color='#5f7f45')
box('X22-BONGWAN-ENT3-DOOR', 'wall', rect_frame(o, TA, NA, -1.2, 1.2, 0.0, 0.06), ZF, ZF + 2.6, '빨간 틀 유리문(어두운 유리)', SRC_D, GD, color='#2f3a44')
for nm, (a0, a1, z0, z1) in {'L': (-1.2, -1.08, ZF, ZF + 2.6), 'R': (1.08, 1.2, ZF, ZF + 2.6), 'M': (-0.05, 0.05, ZF, ZF + 2.6), 'T': (-1.2, 1.2, ZF + 2.48, ZF + 2.6)}.items():
    box(f'X22-BONGWAN-ENT3-FRAME-{nm}', 'wall', rect_frame(o, TA, NA, a0, a1, 0.06, 0.1), z0, z1, '유리문의 빨간 틀', SRC_D, GD, 'X22-BONGWAN-ENT3-DOOR', color='#c8262c')

# ===================== X01·X02 본관 5층–한림관 3층 유리 연결 통로와 바깥 데크, X08 옥상 마당 =====================
SRC_L = '사진 14(KakaoTalk_20261022_143522517_14: 유리 통로 안, "본관 5"), 사진 16(빨간 문에서 데크), 사진 15(남쪽 문 밖 옥상 마당), 사용자 2026-10-22'
GL = '확정(유리 통로·OSB 천장·빨간 틀 문·"본관 5"·데크는 바깥: 사진 14·16, 사용자), 추정(치수: 통로 폭 3 m·안 높이 3 m·처마 1.5 m)'
ZD = 137.8
dk = np.array([201098.0, 557302.7]); dv = np.array([201112.0, 557295.0]) - dk; dv = dv / np.hypot(*dv); dw = np.array([-dv[1], dv[0]])   # g02 G02-DECK-MAIN-HANLIM 과 같은 틀
L0, L1, HW = -1.8, 3.0, 1.5
for side, sg in (('N', 1), ('S', -1)):
    b0, b1 = sorted((sg * (HW - 0.08), sg * HW))
    door = (1.7, 2.7) if side == 'N' else (0.4, 1.4)   # 북쪽: 빨간 틀 문(데크로), 남쪽: 옥상 마당 문
    # 유리 면(문 자리는 비움) + 짙은 세로 살
    for k2, (a0, a1) in enumerate(((L0, door[0]), (door[1], L1))):
        box(f'X22-LINK-GLASS-{side}{k2 + 1}', 'wall', rect_frame(dk, dv, dw, a0, a1, b0, b1), ZD, ZD + 3.0, f'유리 통로 {"북" if sg > 0 else "남"}쪽 유리 벽', SRC_L, GL, 'G02-DECK-MAIN-HANLIM', color='#5f7482')
    a = L0 + 0.05
    k3 = 0
    while a < L1 - 0.1:
        if not (door[0] - 0.1 < a < door[1] + 0.1):
            k3 += 1; bb0, bb1 = sorted((sg * (HW - 0.2), sg * (HW - 0.08)))
            box(f'X22-LINK-MULLION-{side}{k3:02d}', 'wall', rect_frame(dk, dv, dw, a, a + 0.1, bb0, bb1), ZD, ZD + 3.0, '짙은 세로 살(안쪽)', SRC_L, GL, 'G02-DECK-MAIN-HANLIM', color='#2b2d30')
        a += 0.6
    box(f'X22-LINK-DOOR-{side}', 'wall', rect_frame(dk, dv, dw, door[0], door[1], b0, b1), ZD, ZD + 2.3, '유리문(어두운 유리)', SRC_L, GL, 'G02-DECK-MAIN-HANLIM', color='#33404a')
    if side == 'N':
        for nm, (a0, a1, z0, z1) in {'L': (door[0], door[0] + 0.1, ZD, ZD + 2.4), 'R': (door[1] - 0.1, door[1], ZD, ZD + 2.4), 'T': (door[0], door[1], ZD + 2.3, ZD + 2.4)}.items():
            bb0, bb1 = sorted((sg * HW, sg * (HW + 0.05)))
            box(f'X22-LINK-REDDOOR-{nm}', 'wall', rect_frame(dk, dv, dw, a0, a1, bb0, bb1), z0, z1, '데크로 나가는 빨간 틀 문', SRC_L, GL, 'X22-LINK-DOOR-N', color='#c8262c')
        box('X22-LINK-TRANSOM-N', 'wall', rect_frame(dk, dv, dw, door[0], door[1], b0, b1), ZD + 2.4, ZD + 3.0, '문 위 유리', SRC_L, GL, 'X22-LINK-DOOR-N', color='#5f7482')
    else:
        box('X22-LINK-TRANSOM-S', 'wall', rect_frame(dk, dv, dw, door[0], door[1], b0, b1), ZD + 2.3, ZD + 3.0, '문 위 유리', SRC_L, GL, 'X22-LINK-DOOR-S', color='#5f7482')
box('X22-LINK-CEILING', 'canopy', rect_frame(dk, dv, dw, L0, L1, -HW, HW + 1.5), ZD + 3.0, ZD + 3.15, '천장: OSB 나무판(간접등). 데크 쪽(북)으로 1.5 m 처마(사진 16, 추정)', SRC_L, GL, 'X22-LINK-GLASS-N1', color='#c9a15a')
box('X22-LINK-ROOF', 'canopy', rect_frame(dk, dv, dw, L0, L1, -HW - 0.1, HW + 1.6), ZD + 3.15, ZD + 3.4, '지붕 판(짙은 회색 테)', SRC_L, GL, 'X22-LINK-CEILING', color='#3a3d41')
# "본관 5" 표지: 서쪽 끝(본관 쪽 문) 위 짙은 남색 판과 흰 "5"
SG5 = '확정(표지 "본관 5": 사진 14), 추정(크기)'
box('X22-LINK-SIGN', 'wall', rect_frame(dk, dv, dw, L0 + 0.12, L0 + 0.2, -HW + 0.2, HW - 0.2), ZD + 2.25, ZD + 3.0, '"본관 5" 표지 판(짙은 남색)', SRC_L, SG5, 'Z07-DECK-DOOR-BONGWAN', color='#3f4a5a')
FIVE = '11111 10000 11110 00001 00001 10001 01110'
cw = 0.1
for row, bits in enumerate(FIVE.split()):
    c = 0
    while c < 5:
        if bits[c] == '1':
            e = c
            while e + 1 < 5 and bits[e + 1] == '1': e += 1
            q0 = -0.25 + c * cw; q1 = -0.25 + (e + 1) * cw; z1 = ZD + 2.95 - row * cw
            box(f'X22-LINK-SIGN-5-R{row}C{c}', 'wall', rect_frame(dk, dv, dw, L0 + 0.2, L0 + 0.23, q0, q1), z1 - cw, z1, '표지의 흰 "5"', SRC_L, SG5, 'X22-LINK-SIGN', color='#f1eee6')
            c = e + 1
        else: c += 1

# 바깥 데크(X01): 본관 동쪽 면, 통로 북쪽 벽, 한림관 둘레, 북쪽 가장자리(흰 난간) 사이
BON_FACE = LineString([(201092.65, 557290.68), (201104.2, 557314.95)])
HANLIM = Polygon([(201115.67, 557280.2), (201109.54, 557281.17), (201104.18, 557283.58), (201100.77, 557289.05), (201099.4, 557294.9), (201099.79, 557299.28), (201102.41, 557304.47), (201106.93, 557308.1), (201112.82, 557310.06), (201118.23, 557309.37), (201123.15, 557307.15), (201121.28, 557281.36)])
BONGWAN_E = Polygon([(201092.65, 557290.68), (201104.2, 557314.95), (201080, 557330), (201070, 557300)])
corridor = Polygon(rect_frame(dk, dv, dw, L0, L1, -HW, HW))
NORTH_EDGE = LineString([(201100.5, 557311.6), (201110.5, 557307.0)])   # 데크 북쪽 끝(흰 난간). 그 너머는 길 기단 밑 트인 곳(사진 16)
deck_area = Polygon([(201095.0, 557304.0), (201100.5, 557311.6), (201110.5, 557307.0), (201104.0, 557299.0)]).difference(corridor).difference(HANLIM).difference(BONGWAN_E)
SRC_DK = '사진 16(KakaoTalk_20261022_143522517_16), 사용자 2026-10-22(데크는 통로 옆 바깥 마당, 같은 높이)'
GDK = '확정(바깥 나무 데크, 통로와 같은 높이, 데크 앞 옹벽 아래 트인 곳과 흰 난간: 사진 16·사용자), 추정(외곽 ±1.5 m, 높이 137.8 m = 데크 추정값)'
box('X22-DECK-OUTDOOR', 'deck', deck_area, ZD - 0.25, ZD, '바깥 나무 데크(짙은 회색 목재), 윗면 137.8 m(추정). 외곽 = 본관 동쪽 면·유리 통로·한림관 둘레·북쪽 흰 난간 선', SRC_DK, GDK, 'Z05-PLATFORM-UPPER-HANLIM-WGAP-UP', color='#5c5852')
ne = deck_area.intersection(NORTH_EDGE.buffer(0.08))
# 흰 난간: 북쪽 가장자리. 가운데 1.6 m 는 지하 보행 구간이 들어오는 자리라 비움
_l = NORTH_EDGE.length; _gap = (0.38, 0.38 + 1.6 / _l)
for k2, (f0, f1) in enumerate(((0.0, _gap[0]), (_gap[1], 1.0))):
    seg = LineString([NORTH_EDGE.interpolate(f0, normalized=True), NORTH_EDGE.interpolate(f1, normalized=True)])
    rail = seg.buffer(0.04, cap_style=2).intersection(deck_area.buffer(0.3))
    if rail.is_empty: continue
    box(f'X22-DECK-RAIL-{k2 + 1}', 'wall', rail, ZD, ZD + 1.1, '데크 북쪽 가장자리의 흰 난간(높이 1.1 m, 가는 살을 판으로 줄임)', SRC_DK, GDK, 'X22-DECK-OUTDOOR', color='#f1f0ea')
# 옹벽 아래 트인 곳: 기둥 셋(길 기단 끝 판 밑, 틈 바닥 135.3 m 에서) + 안쪽 벽의 그라피티
SLAB = 'G03-SLAB-C'
for k2, s_ in enumerate((70.5, 75.0, 79.5)):
    x, y = st(s_, -4.9); zt = top_at(SLAB, x, y) - 0.6
    box(f'X22-OPEN-COLUMN-{k2 + 1}', 'wall', disc((x, y), 0.28, 10), 135.3, zt, '옹벽(길 기단 끝 판) 아래 트인 곳의 콘크리트 기둥(사진 16: 그라피티 벽 앞 기둥). 자리·수 추정', SRC_DK, GDK, 'Z05-PLATFORM-UPPER-HANLIM-NARC', color='#b9b6ad')
GRAF = ('#7d5ea8', '#e2b320', '#3f8fc4', '#c8504a', '#5f9e5c')
for k2 in range(5):
    s0, s1 = 69.8 + k2 * 2.2, 69.8 + (k2 + 1) * 2.2
    pa, pb = st(s0, -2.55), st(s1, -2.55); x, y = st(s0, -2.5)
    box(f'X22-OPEN-GRAFFITI-{k2 + 1}', 'wall', rect_frame(pa, TA, NA, 0.0, s1 - s0, 0.0, 0.05), 135.4, 135.4 + 2.6, '트인 곳 안쪽 벽(길 기단 옆면)의 그라피티 칠(색은 지어낸 것)', SRC_DK, '확정(그라피티 벽: 사진 16), 추정(자리·색)', 'G02-PLATFORM-WAY', color=GRAF[k2])

# 옥상 마당(X08, 사용자 2026-10-22: 후보 가에 가까움): 통로 남쪽, 본관 동쪽 면과 한림관 사이 쐐기 전체가 137.8 m 옥상. 남쪽은 1층 쪽으로 트임(추정)
SRC_R = '사진 15(KakaoTalk_20261022_143522517_15: 회색 바닥, 둥근 벽돌 화단, 소나무, 남산 조망, 오른쪽 콘크리트 난간벽과 둥근 콘크리트 기둥), 사진 14 왼쪽 유리 너머 회색 바닥, 사용자 2026-10-22(후보 가)'
GR = '확정(옥상 마당이 통로 남쪽 문 밖에 있음, 자리 = 후보 가: 사용자), 추정(외곽·남쪽 끝 북좌표 557286.5·화단 자리와 크기)'
yard = Polygon([(201092.65, 557290.68), (201094.0, 557296.0), (201096.5, 557301.6), (201101.0, 557300.5), (201101.2, 557286.0), (201094.0, 557287.0)])
yard = yard.difference(corridor.buffer(0.02)).difference(HANLIM).difference(BONGWAN_E)
box('X22-ROOF-YARD-MASS', 'wall', yard, 127.2, ZD - 0.3, '옥상 마당 밑 덩어리(1~4층, 본관·한림관 사이 낮은 부분). 짙은 기단 색', SRC_R, GR, 'Z05-PLATFORM-UPPER-HANLIM-WGAP-LOW', color='#55595e')
box('X22-ROOF-YARD-FLOOR', 'landing', yard, ZD - 0.3, ZD, '옥상 마당 바닥(회색 방수 바닥), 137.8 m = 통로와 같은 높이(사진 15 에 문턱만)', SRC_R, GR, 'X22-ROOF-YARD-MASS', color='#a9abab')
ys = yard.exterior
south = LineString([(201092.9, 557289.0), (201094.0, 557287.0), (201101.2, 557286.0)])
box('X22-ROOF-YARD-PARAPET-S', 'wall', south.buffer(0.15, cap_style=2).intersection(yard), ZD, ZD + 1.0, '남쪽 끝 콘크리트 난간벽(1층 쪽으로 트인 곳)', SRC_R, GR, 'X22-ROOF-YARD-FLOOR', color='#c4c2bb')
pl = LineString([(201094.3, 557288.6), (201100.6, 557287.6)]).buffer(0.45, cap_style=2).intersection(yard).difference(south.buffer(0.16, cap_style=2))
box('X22-ROOF-YARD-PLANTER-LONG', 'planter', pl, ZD, ZD + 0.75, '난간벽 앞 긴 벽돌 화단(관목·꽃)', SRC_R, GR, 'X22-ROOF-YARD-FLOOR', color='#8a5a46', topColor='#7f9a6b')
for k2, (c, r) in enumerate((((201098.6, 557292.6), 1.0), ((201096.6, 557290.6), 0.8))):
    d_ = disc(c, r).intersection(yard)
    box(f'X22-ROOF-YARD-PLANTER-ROUND-{k2 + 1}', 'planter', d_, ZD, ZD + 0.7, '둥근 벽돌 화단(소나무·관목)', SRC_R, GR, 'X22-ROOF-YARD-FLOOR', color='#8a5a46', topColor='#7f9a6b')
    for part, mat, hh, z0, z1 in (('TRUNK', 'trunk', 0.12, 0.0, 2.6), ('CROWN', 'foliage', 0.8, 2.3, 3.2), ('TOP', 'foliage', 0.45, 3.2, 3.9)):
        box(f'X22-ROOF-YARD-TREE-{k2 + 1}-{part}', 'tree', disc(c, hh, 4), ZD + 0.7 + z0, ZD + 0.7 + z1, '둥근 화단의 소나무(단순한 나무)', SRC_R, GR, f'X22-ROOF-YARD-PLANTER-ROUND-{k2 + 1}', material=mat)

# ===================== 은주관 입구 상자(2026-10-22 사양: 데이터/보완자료/학교-전경-20261022/확인/은주관-박스-탑다운-사양.png·-정면-사양.png) =====================
# 전 X22-EUNJU-KIOSK(2.8 x 3.2 m, 계단 머리 자리)는 없앰. 꼭짓점은 사용자 항공사진에서 읽은 사양 그대로(±1.5 m, 항공-한림관정문-은주1관 과 1 m 안에서 맞음).
# 틀: o = 남서 모서리, A = 긴 축(북, 은주1관 동벽과 나란, 방위 9.4도), B = 짧은 축(동). 북면 a = 8.5(운동장·오르막 어귀 쪽 문), 동면 b = 4.0
SRC_K = ('은주관 입구 상자 사양(2026-10-22, 근거 = 사용자 항공사진, 전경 영상 1 158~159 초·사용자 표시 사진), 사용자 항공사진 항공-한림관정문-은주1관(2026-10-22), '
         '시험용 DB 길 7e2741ec(지하 1층 계단 참 → 상자 북쪽 참)')
GK = '확정(있음·은주관 입구: 사용자, 골강판·노란 원형 표지·빨간 문틀·노란 글자판·처마 LED·동면 옆 출입구: 영상·사진), 원천(평면: 사용자 항공사진 ±1.5 m), 추정(치수·높이 5.2 m)'
KO = np.array([201143.02, 557291.74]); KA = (np.array([201144.40, 557300.13]) - KO) / 8.5; KB = (np.array([201146.96, 557291.09]) - KO) / 4.0
KA, KB = KA / np.hypot(*KA), KB / np.hypot(*KB)
KZ, KT, KW = 148.9, 154.1, 0.12          # 바닥(운동장, 문턱 없음), 벽 윗면, 벽 두께
STEEL, SEAM, EDGE, RED, YEL, GLASS = '#a9adb0', '#979b9e', '#55595e', '#c8262c', '#f2c21b', '#33404a'
kq = lambda a0, a1, b0, b1: rect_frame(KO, KA, KB, a0, a1, b0, b1)
kb = lambda id_, typ, a0, a1, b0, b1, z0, z1, what, color, base='Z02-PLATFORM-FIELD': box(id_, typ, kq(a0, a1, b0, b1), z0, z1, what, SRC_K, GK, base, color=color)
FR = (1.36, 3.06); DR = (1.51, 2.91)    # 북면 빨간 문틀(폭 1.7) · 유리 두짝문(1.4) 의 b 범위(동쪽 모서리에서 0.94~2.64 m)
OP = (6.75, 8.14)                       # 동면 북쪽 끝 옆 출입구 틀의 a 범위(북쪽 끝에서 0.36~1.75 m, 틀 안 1.4 m 가 문 자리 쪽)
# 벽: 서(은주1관 쪽)·남은 통벽, 북은 문틀 자리를 비우고 위만, 동은 옆 출입구 자리를 비우고 위만
kb('X22-EUNJU-BOX-WALL-W', 'wall', 0.0, 8.5, 0.0, KW, KZ, KT, '은주관 입구 상자 서쪽 벽(은주1관 동벽에서 0.3 m): 은회색 골강판', STEEL)
kb('X22-EUNJU-BOX-WALL-S', 'wall', 0.0, KW, KW, 4.0, KZ, KT, '남쪽 벽: 은회색 골강판', STEEL)
kb('X22-EUNJU-BOX-WALL-N-W', 'wall', 8.5 - KW, 8.5, KW, FR[0], KZ, KT, '북쪽 벽(문틀 서쪽): 은회색 골강판', STEEL)
kb('X22-EUNJU-BOX-WALL-N-E', 'wall', 8.5 - KW, 8.5, FR[1], 4.0 - KW, KZ, KT, '북쪽 벽(문틀 동쪽, 노란 원형 표지가 붙는 면)', STEEL)
kb('X22-EUNJU-BOX-WALL-N-TOP', 'wall', 8.5 - KW, 8.5, FR[0], FR[1], KZ + 3.5, KT, '북쪽 벽(문틀 위)', STEEL)
kb('X22-EUNJU-BOX-WALL-E-S', 'wall', KW, OP[0], 4.0 - KW, 4.0, KZ, KT, '동쪽 벽(옆 출입구 남쪽)', STEEL)
kb('X22-EUNJU-BOX-WALL-E-N', 'wall', OP[1], 8.5, 4.0 - KW, 4.0, KZ, KT, '동쪽 벽(옆 출입구 북쪽)', STEEL)
kb('X22-EUNJU-BOX-WALL-E-TOP', 'wall', OP[0], OP[1], 4.0 - KW, 4.0, KZ + 2.85, KT, '동쪽 벽(옆 출입구 위)', STEEL)
# 지붕 테: 북쪽으로 0.5 m 처마, 그 밑 선형 LED 3줄
kb('X22-EUNJU-BOX-ROOF', 'canopy', -0.1, 9.0, -0.1, 4.1, KT, KT + 0.25, '지붕과 지붕 테(짙은 회색). 북쪽(문 쪽)으로 0.5 m 처마', EDGE)
for k2, a0 in enumerate((8.58, 8.72, 8.86)):
    kb(f'X22-EUNJU-BOX-LED-{k2 + 1}', 'wall', a0, a0 + 0.05, 0.25, 3.75, KT - 0.06, KT - 0.01, '처마 밑 선형 LED(밝은 줄)', '#fffbe6', 'X22-EUNJU-BOX-ROOF')
# 북면: 빨간 문틀 1.7 x 3.5, 유리 두짝문 1.4 x 2.4(문턱 없음), 문 위 노란 글자판(글자 없음), 노란 원형 표지 다섯(Ø0.6, 중심 1.6~4.8 m)
kb('X22-EUNJU-BOX-FRAME-W', 'wall', 8.5 - KW, 8.56, FR[0], DR[0], KZ, KZ + 3.5, '빨간 문틀(서쪽 기둥)', RED)
kb('X22-EUNJU-BOX-FRAME-E', 'wall', 8.5 - KW, 8.56, DR[1], FR[1], KZ, KZ + 3.5, '빨간 문틀(동쪽 기둥)', RED)
kb('X22-EUNJU-BOX-FRAME-MID', 'wall', 8.5 - KW, 8.56, DR[0], DR[1], KZ + 2.4, KZ + 2.5, '빨간 문틀(문 위 가로대)', RED)
kb('X22-EUNJU-BOX-FRAME-TOP', 'wall', 8.5 - KW, 8.56, DR[0], DR[1], KZ + 3.38, KZ + 3.5, '빨간 문틀(위)', RED)
kb('X22-EUNJU-BOX-LETTERS', 'wall', 8.5 - KW, 8.5, DR[0], DR[1], KZ + 2.5, KZ + 3.38, '문 위 노란 글자판(그림 글자, 글자는 싣지 않음)', YEL)
kb('X22-EUNJU-BOX-DOOR', 'wall', 8.43, 8.47, DR[0], DR[1], KZ, KZ + 2.4, '유리 두짝문(어두운 유리, 문턱 없음)', GLASS)
for k2, zc in enumerate((1.6, 2.4, 3.2, 4.0, 4.8)):
    kb(f'X22-EUNJU-BOX-SIGN-{k2 + 1}', 'wall', 8.5, 8.53, 3.25, 3.85, KZ + zc - 0.3, KZ + zc + 0.3, '노란 원형 표지(Ø0.6, 금지 그림. 원을 네모로 줄임)', YEL)
# 동면: 북쪽 끝 옆 출입구(빨간 틀, 1.4 x 2.7), 그 위 짙은 원형 환기구 둘
kb('X22-EUNJU-BOX-SIDE-FRAME-S', 'wall', OP[0], OP[0] + 0.15, 4.0 - KW, 4.06, KZ, KZ + 2.85, '동면 옆 출입구 빨간 틀(남쪽 기둥)', RED)
kb('X22-EUNJU-BOX-SIDE-FRAME-N', 'wall', OP[1] - 0.15, OP[1], 4.0 - KW, 4.06, KZ, KZ + 2.85, '동면 옆 출입구 빨간 틀(북쪽 기둥)', RED)
kb('X22-EUNJU-BOX-SIDE-FRAME-T', 'wall', OP[0] + 0.15, OP[1] - 0.15, 4.0 - KW, 4.06, KZ + 2.7, KZ + 2.85, '동면 옆 출입구 빨간 틀(위)', RED)
for k2, zc in enumerate((3.6, 4.5)):
    kb(f'X22-EUNJU-BOX-VENT-{k2 + 1}', 'wall', 7.2, 7.7, 4.0, 4.04, KZ + zc - 0.25, KZ + zc + 0.25, '짙은 원형 환기구(추정, 네모로 줄임)', '#3c4044')
# 골강판 세로 골: 바탕과 대비가 낮은 이음 줄(북·동·남 바깥 면, 0.6 m 마다, 문·출입구 자리는 비움)
for k2, bb in enumerate(np.arange(0.3, 4.0, 0.6)):
    if FR[0] - 0.05 < bb < FR[1] + 0.05: continue
    if 3.2 < bb < 3.9: z0s = [(KZ, KZ + 1.25), (KZ + 5.15, KT)]
    else: z0s = [(KZ, KT)]
    for j2, (z0, z1) in enumerate(z0s):
        kb(f'X22-EUNJU-BOX-SEAM-N-{k2:02d}{j2}', 'wall', 8.5, 8.52, bb - 0.02, bb + 0.02, z0, z1, '골강판 세로 골(낮은 대비)', SEAM)
    kb(f'X22-EUNJU-BOX-SEAM-S-{k2:02d}', 'wall', -0.02, 0.0, bb - 0.02, bb + 0.02, KZ, KT, '골강판 세로 골(낮은 대비)', SEAM)
for k2, aa in enumerate(np.arange(0.3, 8.5, 0.6)):
    if OP[0] - 0.05 < aa < OP[1] + 0.05: continue
    z0s = [(KZ, KZ + 3.3), (KZ + 4.8, KT)] if 7.1 < aa < 7.8 else [(KZ, KT)]
    for j2, (z0, z1) in enumerate(z0s):
        kb(f'X22-EUNJU-BOX-SEAM-E-{k2:02d}{j2}', 'wall', aa - 0.02, aa + 0.02, 4.0, 4.02, z0, z1, '골강판 세로 골(낮은 대비)', SEAM)
# 안: 북쪽 끝 참(운동장 높이 148.9, 바닥 그대로) → 남쪽으로 내려가는 계단(빈 곳 U02-VOID-FIELD-STAIR-BOX 와 U02-VOID-FIELD-STAIR, 단은 그리지 않음)
# 화단 Z05-EUNJU-FIELD-PLANTER-4: 북쪽 끝을 상자 남쪽 벽 앞(약 557291)에서 자름(겹침 없앰)
z5 = load('z05-eunju.geojson'); BOXP = Polygon(kq(-0.05, 8.55, -0.05, 4.05))
for f in z5['features']:
    if f['properties']['id'] == 'Z05-EUNJU-FIELD-PLANTER-4' and Polygon(f['geometry']['coordinates'][0]).intersects(BOXP):
        f['geometry'] = geom(Polygon(f['geometry']['coordinates'][0]).difference(BOXP)); f['properties']['assumption'] = f['properties'].get('assumption', '') + ' 2026-10-22: 북쪽 끝을 은주관 입구 상자 남쪽 벽 앞에서 자름'
dump('z05-eunju.geojson', z5)

# ===================== 대일관 앞: 데크·화단·동쪽 끝 계단(사용자 항공사진 2026-10-22), 청운관 앞 표지석(X06), 상승관 쪽 작은 계단 =====================
SRC_AE = '사용자 항공사진 보완자료/학교-전경-20261022/항공-대일관앞-원본.webp·-데크-사용자표시.webp(운동장 칠 무늬 5점으로 S-MAP 정사 화면에 맞춤, 잔차 0.13 m 이하, 절대 ±1 m 추정), 사진 09·10·11'
GAE = '확정(데크 띠·앞 화단·뒤 나무 줄 화단·동쪽 끝 계단의 자리: 사용자 항공사진과 표시), 추정(치수 ±1 m, 높이는 기존 값: 운동장 148.9, 참 151.0, 데크 151.3)'
Z_FIELD, Z_PASS, Z_PLAZA, Z_YARD, Z_PLANT = 148.9, 151.3, 151.0, 153.1, 150.2
# 데크 뒤(건물 쪽) 나무 줄 화단: v 0.0~0.9(u 9.0~40.0). 나무 여섯
box('X22-DAEIL-BACK-PLANTER', 'planter', [uv(9.0, 0.0), uv(40.0, 0.0), uv(40.0, 0.9), uv(9.0, 0.9)], Z_PASS - 0.05, Z_PASS + 0.45, '데크 뒤(건물 쪽) 나무 줄 화단(항공사진: 나무와 갈색 화분 줄). 폭 0.9 m', SRC_AE, GAE, 'Z02-PLATFORM-PASSAGE', color='#b3ad9f', topColor='#7f9a6b')
for k2, u_ in enumerate(np.linspace(12.0, 37.0, 6)):
    c = uv(u_, 0.45)
    for part, mat, hh, z0, z1 in (('TRUNK', 'trunk', 0.14, 0.0, 3.2), ('CROWN', 'foliage', 1.0, 3.0, 4.2), ('TOP', 'foliage', 0.55, 4.2, 5.0)):
        box(f'X22-DAEIL-BACK-TREE-{k2 + 1}-{part}', 'tree', disc(c, hh, 4), Z_PASS + 0.45 + z0, Z_PASS + 0.45 + z1, '데크 뒤 줄 화단의 나무(단순한 나무). 그루 수·자리 추정', SRC_AE, GAE, 'X22-DAEIL-BACK-PLANTER', material=mat)
# 청운관 앞 계단 참의 "제206학생군사교육단" 표지석과 뒤 거친 돌 벽(X06, 사진 09)
SRC_9 = '사진 09(KakaoTalk_20261022_143522517_09: 참 위 표지석과 거친 돌 벽), 사진 11'
G9 = '확정(있음: 사진 09), 추정(크기 1.2 x 0.4 x 0.8 m, 자리 = 계단 머리 앞 참 ±1.5 m)'
box('X22-ROTC-SIGNSTONE', 'wall', [uv(51.6, 1.8), uv(52.8, 1.8), uv(52.8, 2.2), uv(51.6, 2.2)], Z_PLAZA, Z_PLAZA + 0.8, '"제206학생군사교육단" 표지석(짙은 돌, 글자는 싣지 않음)', SRC_9, G9, 'X22-DAEIL-EAST-LANDING', color='#5b5852')
box('X22-ROTC-SIGNSTONE-FACE', 'wall', [uv(51.7, 2.2), uv(52.7, 2.2), uv(52.7, 2.23), uv(51.7, 2.23)], Z_PLAZA + 0.3, Z_PLAZA + 0.7, '표지석 앞면의 밝은 글자 판', SRC_9, G9, 'X22-ROTC-SIGNSTONE', color='#d8d3c4')
# 상승관 쪽 작은 계단(사용자 표시 2026-10-22: 참에서 조금 더 올라 오른쪽 위로 굽어 상승관): 광장 북쪽에서 동쪽 안쪽 마당(153.1) 끝으로 12단
SRC_U = '사용자 표시 보완자료/학교-전경-20261022/비교/사용자표시-청운관앞계단-갈림.png(빨간 꺾은선), 건물 노트 청운관 2026-10-22'
GU = '확정(참에서 작은 계단으로 조금 더 올라 상승관으로: 사용자), 추정(자리 = 광장 북쪽 u 54.0~57.0·v −4.3~−1.2, 12단 x 0.175 m, 디딤 0.25 m)'
NR = 12
for k2 in range(1, NR + 1):
    box(f'X22-SANGSEUNG-STAIR-S{k2:02d}', 'stair_step', [uv(54.0 + 0.25 * (k2 - 1), -4.3), uv(54.0 + 0.25 * k2, -4.3), uv(54.0 + 0.25 * k2, -1.2), uv(54.0 + 0.25 * (k2 - 1), -1.2)], Z_PLAZA - 0.05, Z_PLAZA + (Z_YARD - Z_PLAZA) * k2 / NR,
        '광장(151.0)에서 안쪽 마당(153.1) 끝으로 오르는 작은 돌계단: 12단', SRC_U, GU, 'Z02-PLATFORM-PLAZA', stair='X22-SANGSEUNG-STAIR', riseM=r2((Z_YARD - Z_PLAZA) / NR), runM=0.25, widthM=3.1, material='stone')
box('X22-SANGSEUNG-STAIR-CHEEK', 'wall', [uv(54.0, -1.2), uv(57.0, -1.2), uv(57.0, -1.0), uv(54.0, -1.0)], Z_PLAZA - 0.05, Z_YARD + 0.4, '작은 계단 남쪽 옆 낮은 돌 벽(추정)', SRC_U, GU, 'Z02-PLATFORM-PLAZA', material='stone')
# Skon Square 흰 입체 글자(X11): 데크 앞 화단(동쪽) 앞선 위, 운동장 쪽을 보고 읽힘
FONT = {'S': '01111 10000 10000 01110 00001 00001 11110', 'K': '10001 10010 10100 11000 10100 10010 10001', 'O': '01110 10001 10001 10001 10001 10001 01110', 'N': '10001 11001 10101 10101 10011 10001 10001',
        'Q': '01110 10001 10001 10001 10101 10010 01101', 'U': '10001 10001 10001 10001 10001 10001 01110', 'A': '01110 10001 10001 11111 10001 10001 10001', 'R': '11110 10001 10001 11110 10100 10010 10001', 'E': '11111 10000 10000 11110 10000 10000 11111'}
SRC_S = '사진 10(KakaoTalk_20261022_143522517_10), 사용자 2026-10-22("스콘스퀘어 간판")'
GS = '확정(글자 "Skon Square", 화단 앞: 사진 10·사용자), S-MAP(u 27~33 의 화단 앞 부풂: z02 노트), 추정(자리 u 27~33.6, 글자 높이 0.7 m, 5 x 7 칸 글꼴, 대문자로)'
CW_ = 0.1; ADV = 6 * CW_; U0 = 27.0; VF = 5.9
for i, ch in enumerate('SKON SQUARE'):
    if ch == ' ': continue
    for row, bits in enumerate(FONT[ch].split()):
        c = 0
        while c < 5:
            if bits[c] == '1':
                e = c
                while e + 1 < 5 and bits[e + 1] == '1': e += 1
                ua = U0 + i * ADV + c * CW_; ub = U0 + i * ADV + (e + 1) * CW_; zt = Z_PLANT + 0.05 + (7 - row) * CW_
                box(f'X22-SKON-{i:02d}-R{row}C{c}', 'wall', [uv(ua, VF), uv(ub, VF), uv(ub, VF + 0.08), uv(ua, VF + 0.08)], zt - CW_, zt, '"Skon Square" 흰 입체 글자', SRC_S, GS, 'Z02-PLANTER-MAIN', color='#f4f2ec')
                c = e + 1
            else: c += 1

# ===================== 영상 2: 청운관 현관 틀 밑 통로(X19)와 주차장 쪽 청운관 문(X21) =====================
SRC_V2 = '전경 영상 2(전경-영상2.mp4) 2~12 초(틀 밑 통로·붉은 벽 칸), 31·33 초(청록 앞방·지하 1층 문), 52~56 초(주차장 쪽 문·"청운관" 세로 조명 글자), 사용자 2026-10-22'
GV2 = '확정(있음: 영상 2), 추정(치수·자리 ±1.5 m: 틀의 첫째·둘째 기둥 줄 사이 통로 안쪽)'
PO = np.array([201213.35, 557281.05]); PP = np.array([0.7205, 0.6935]); PQ = np.array([-0.6935, 0.7205])   # 통로 어귀(기둥 앞선) · 안쪽(북동) · 왼쪽(북서)
ZB1, ZR = 148.9, 149.2
for k2, (a0, a1, zt) in enumerate(((2.0, 2.3, 149.05), (2.3, 2.6, ZR))):
    box(f'X22-CHEONGUN-PASSAGE-STEP-{k2 + 1}', 'stair_step', rect_frame(PO, PP, PQ, a0, a1, -1.5, 1.5), ZB1, zt, '틀 밑 통로의 짙은 돌 디딤(2단, 줄무늬 철 코)', SRC_V2, GV2, 'B15-CHEONGUN-PORCH-FLOOR-B1', stair='X22-CHEONGUN-PASSAGE-STEPS', riseM=0.15, runM=0.3, widthM=3.0, color='#5b5852')
box('X22-CHEONGUN-REDCELL-FLOOR', 'landing', rect_frame(PO, PP, PQ, 2.6, 5.3, -1.5, 1.5), ZB1, ZR, '붉은 벽 칸 바닥(149.2 m 추정 = 운동장 + 디딤 2단)', SRC_V2, GV2, 'B15-CHEONGUN-PORCH-FLOOR-B1', color='#8d8a84')
box('X22-CHEONGUN-REDCELL-WALL-BACK', 'wall', rect_frame(PO, PP, PQ, 5.3, 5.45, -1.5, 1.5), ZR, 151.8, '붉게 칠한 안쪽 벽(사진 09 의 분홍 조명 문으로 보이던 것. 전에는 유리 면)', SRC_V2, GV2, 'X22-CHEONGUN-REDCELL-FLOOR', color='#c0392b')
box('X22-CHEONGUN-REDCELL-WALL-LEFT', 'wall', rect_frame(PO, PP, PQ, 2.6, 5.3, 1.45, 1.55), ZR, 151.8, '붉게 칠한 왼쪽 벽', SRC_V2, GV2, 'X22-CHEONGUN-REDCELL-FLOOR', color='#c0392b')
box('X22-CHEONGUN-REDCELL-DOOR', 'wall', rect_frame(PO, PP, PQ, 3.6, 4.6, 1.38, 1.45), ZR, ZR + 2.1, '왼쪽 벽의 회색 문', SRC_V2, GV2, 'X22-CHEONGUN-REDCELL-WALL-LEFT', color='#7d8287')
box('X22-CHEONGUN-REDCELL-CEILING', 'canopy', rect_frame(PO, PP, PQ, 2.0, 5.45, -1.5, 1.55), 151.8, 151.9, '나무 판 천장', SRC_V2, GV2, 'X22-CHEONGUN-REDCELL-WALL-BACK', color='#b88a55')
box('X22-CHEONGUN-PASSAGE-SIDEWALL', 'wall', rect_frame(PO, PP, PQ, 0.6, 2.6, 1.45, 1.6), ZB1, 150.3, '디딤 왼쪽 거친 돌 옆벽', SRC_V2, GV2, 'B15-CHEONGUN-PORCH-FLOOR-B1', color='#b3ad9f')
_lw = Polygon(ALL['B15-CHEONGUN-PORCH-PLANTER-LOW-W']['geometry']['coordinates'][0]); _ax = LineString([_lw.exterior.coords[0], _lw.exterior.coords[1]]); _off = np.array(_lw.centroid.coords[0]) - np.array(_ax.interpolate(0.5, normalized=True).coords[0])
for k2, c in enumerate(tuple(np.array(_ax.interpolate(f, normalized=True).coords[0]) + _off) for f in (0.3, 0.5, 0.7)):
    fid, z = holder(c[0], c[1], ('B15-CHEONGUN-PORCH-PLANTER-LOW-W',))
    box(f'X22-CHEONGUN-FIRE-POST-{k2 + 1}', 'wall', disc(c, 0.1, 6), z, z + 0.75, '낮은 돌 화단 위 소방 송수구 기둥(빨강)', SRC_V2, GV2, fid, color='#d0312d')
# 주차장(지하 1층) 쪽 청운관 문: 학교 지하도 지도 초록 점 "청운관 서"(201209.4, 557280.8)가 주차장 북쪽 벽 꺾이는 자리. 문은 앞방에서 내려가는 계단의 왼쪽(사용자 2026-10-22, 영상 2 31 초)
DW = np.array([0.866, -0.5]); DN = np.array([0.5, 0.866])   # 벽을 따라(남동) · 벽 안쪽(북동)
DO = np.array([201209.4, 557280.8]); ZP = 143.5   # 운동장 지하 1층 바닥(2026-10-22 사용자 결정, 전 141.4)
UG = dict(underground=True, inVoid=True)
box('X22-CHEONGUN-B1-DOOR', 'wall', rect_frame(DO, DW, DN, 0.3, 1.5, -0.05, 0.05), ZP, ZP + 2.2, '주차장 쪽 청운관 문(유리 붙은 갈색 철문)', SRC_V2, GV2, 'U02-VOID-B1', color='#6b4a2f', **UG)
box('X22-CHEONGUN-B1-WALL', 'wall', rect_frame(DO, DW, DN, -1.2, 3.4, 0.05, 0.25), ZP, ZP + 2.9, '문 둘레 벽: 청록 허리벽 위 콘크리트 면(청록으로 줄임)', SRC_V2, GV2, 'U02-VOID-B1', color='#2f8f8a', **UG)
box('X22-CHEONGUN-B1-SIGN', 'wall', rect_frame(DO, DW, DN, 1.8, 2.3, -0.08, 0.05), ZP + 0.8, ZP + 2.6, '"청운관" 세로 조명 글자 판(회색 세로 살 판에 밝은 글자, 글자는 싣지 않음)', SRC_V2, GV2, 'X22-CHEONGUN-B1-WALL', color='#8b9096', **UG)
box('X22-CHEONGUN-B1-SIGN-LIGHT', 'wall', rect_frame(DO, DW, DN, 1.95, 2.15, -0.1, -0.08), ZP + 0.95, ZP + 2.45, '세로 조명 글자(밝은 띠로 줄임)', SRC_V2, GV2, 'X22-CHEONGUN-B1-SIGN', color='#fff8dc', **UG)
# 2026-10-22: 계단실 빈 곳(붉은 벽 칸 어귀 149.2 → 지하 1층 앞방 143.5 → 지하 2층 140.0, 사용자 결정 2026-10-22). 평면은 시험용 DB 길 c9319f92·1eccfdaf(x22/build_group.py cheongun)의 선을 감싼 네모 + 0.4 m. 단·난간은 그리지 않음(X24)
FEATS.append({'type': 'Feature', 'properties': {'id': 'X22-CHEONGUN-STAIRWELL', 'type': 'void', 'kind': 'void', 'estimated': True, 'grade': '확정(계단실이 있다: 영상 2·사용자), 추정(평면·높이)',
    'fromM': 140.0, 'toM': 149.2, 'name': '청운관 계단실', 'assumption': '청운관 계단실: 붉은 벽 칸(149.2)에서 두 줄 26 단으로 지하 1층 앞방(143.5, 단 0.22 m), 앞방에서 되돌림 두 줄 약 20 단으로 지하 2층(140.0, 3.5 m: 사용자 결정 2026-10-22). 평면 추정', 'source': SRC_V2},
    'geometry': geom(Polygon([(201207.5, 557281.4), (201215.6, 557281.4), (201215.6, 557284.3), (201207.5, 557284.3)]))})
b15 = load('b15-cheongun.geojson'); n0 = len(b15['features'])
b15['features'] = [f for f in b15['features'] if f['properties']['id'] != 'B15-CHEONGUN-PORCH-GLASS-B1']; dump('b15-cheongun.geojson', b15); print('b15 유리 면 걷음', n0 - len(b15['features']))

# ===================== z02-daeil-front.geojson 고침(항공사진: 데크 띠 v 0.9~3.2, 앞 화단 v 3.2~6.3, 동쪽 끝 계단 u 50.6~55.0, 가운데 화단 u 55.2~57.7) =====================
z02 = load('z02-daeil-front.geojson'); F = {f['properties']['id']: f for f in z02['features']}
def setp(fid, uvs, **props):
    f = F[fid]; f['geometry'] = geom(Polygon([uv(a, b) for a, b in uvs])); f['properties'].update(props)
    f['properties']['grade'] = GAE; f['properties']['source'] = SRC_AE
PASS_V = 3.2
setp('Z02-PLATFORM-PASSAGE', [(8.4, -0.2), (40.0, -0.2), (40.1, 1.47), (50.0, 1.47), (50.0, 3.6), (40.1, 3.6), (40.1, PASS_V), (11.5, PASS_V), (11.5, 2.5), (8.4, 2.5)],
     assumption='높은 가장자리 길(데크 띠)의 몸통. X22: 항공사진대로 데크 앞선을 v 3.2 로(서쪽 끝 u 11.5 까지는 2.5), 동쪽 끝을 u 50.0 으로(그 동쪽은 참 151.0)')
setp('Z02-DECK-MAIN', [(9.0, 0.9), (40.1, 0.9), (40.1, PASS_V), (11.5, PASS_V), (11.5, 2.5), (9.0, 2.5)], assumption='나무 데크(X22: v 0.9~3.2, 폭 2.3 m = 항공사진 데크 띠. 그 뒤 v 0~0.9 는 나무 줄 화단)')
setp('Z02-DECK-EAST', [(40.1, 1.67), (49.4, 1.67), (49.4, 3.6), (40.1, 3.6)], assumption='나무 데크 동쪽 구간(X22: 동쪽 끝 u 49.4 에서 참으로 내려섬)')
setp('Z02-DECK-STEP-E', [(49.4, 1.67), (50.0, 1.67), (50.0, 3.6), (49.4, 3.6)], assumption='데크(151.3) 동쪽 끝에서 참(151.0)으로 내려서는 단(X22: 항공사진의 데크 끝)')
setp('Z02-RAILING-MAIN', [(8.4, 2.38), (11.5, 2.38), (11.5, PASS_V - 0.12), (40.1, PASS_V - 0.12), (40.1, PASS_V), (11.5, PASS_V), (11.5, 2.5), (8.4, 2.5)])
setp('Z02-RAILING-JOG', [(39.98, PASS_V), (40.1, PASS_V), (40.1, 3.6), (39.98, 3.6)])
setp('Z02-RAILING-EAST', [(40.1, 3.48), (50.0, 3.48), (50.0, 3.6), (40.1, 3.6)])
setp('Z02-PLANTER-MAIN', [(11.5, PASS_V), (40.1, PASS_V), (40.1, 6.3), (11.5, 6.3)], assumption='데크 앞(운동장 쪽) 화단: 거친 돌 옹벽(1.3 m) 위 꽃 화단(항공사진의 분홍 꽃은 한시적: 사용자 2026-10-22, 색은 보통 초록). X22: 뒷선 v 3.2', color='#b3ad9f', topColor='#7f9a6b')
setp('Z02-PLANTER-EAST', [(40.1, 3.6), (50.4, 3.6), (50.4, 6.3), (40.1, 6.3)], assumption='데크 앞 화단(동쪽). X22: 동쪽 끝을 계단 서쪽 옆(u 50.4)으로, 거친 돌 벽(사진 09 왼쪽 화단 벽)', color='#b3ad9f', topColor='#7f9a6b')
E_U = (50.6, 55.0); RUN = 0.30; RE = (Z_PLAZA - Z_FIELD) / 13
for k2 in range(1, 13):
    setp(f'Z02-EAST-STAIR-S{k2:02d}', [(E_U[0], 6.3 - RUN * k2), (E_U[1], 6.3 - RUN * k2), (E_U[1], 6.3 - RUN * (k2 - 1)), (E_U[0], 6.3 - RUN * (k2 - 1))],
         assumption=f'청운관 앞(대일관·청운관 사이) 계단: 운동장에서 참으로 오르는 13단. X22: 항공사진에서 데크 앞 화단 끝과 가운데 화단 사이 밝은 띠 = u 50.6~55.0(전보다 약 4 m 서쪽, 사진 11 판독 "약 5 m 북서쪽"과 맞음)', widthM=r2(E_U[1] - E_U[0]))
setp('Z02-EAST-STAIR-BLOCK', [(58.6, 2.7), (60.9, 2.0), (62.5, 2.0), (63.9, 8.0), (58.6, 6.3)], assumption='청운관 쪽 돌 화단 덩어리(X06: 거친 돌 화단 벽, 둥근 관목. 사진 09 오른쪽)', color='#b3ad9f', topColor='#7f9a6b')
F['Z02-EAST-STAIR-BLOCK']['properties'].pop('material', None); F['Z02-PLANTER-MAIN']['properties'].pop('material', None); F['Z02-PLANTER-EAST']['properties'].pop('material', None)
NEW = [
  ('X22-DAEIL-EAST-LANDING', 'landing', [(50.0, 1.67), (54.0, 1.67), (54.0, 2.7), (E_U[0], 2.7), (E_U[0], 3.6), (50.0, 3.6)], Z_FIELD, Z_PLAZA, 'Z02-PLATFORM-APRON', '청운관 앞 계단 머리의 참(서쪽 부분, 151.0 m): 데크 동쪽 끝과 계단 사이. 동쪽 부분은 기단 Z02-PLATFORM-PLAZA', {}),
  ('X22-DAEIL-CENTER-PLANTER', 'planter', [(55.2, 2.7), (57.7, 2.7), (57.7, 6.3), (55.2, 6.3)], Z_FIELD, 150.3, 'Z02-PLATFORM-APRON', '계단 오른쪽(동쪽) 가운데 화단: 흰 테두리의 거친 돌 화단 벽, 둥근 관목(항공사진, 사진 09 오른쪽)', {'color': '#b3ad9f', 'topColor': '#7f9a6b'}),
]
z02['features'] = [f for f in z02['features'] if not f['properties']['id'].startswith('X22-')]
for fid, typ, uvs, z0, z1, base, what, extra in NEW:
    z02['features'].append({'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': GAE, 'basePlane': base, 'fromM': z0, 'toM': z1, 'assumption': what, 'source': SRC_AE, **extra}, 'geometry': geom(Polygon([uv(a, b) for a, b in uvs]))})
dump('z02-daeil-front.geojson', z02)

# ===================== 걷는 것: Z07 덮인 복도의 옆벽·덮개, 데크 쪽 바닥 마디, 나무 난간(X01) / 파란 둥근 지붕 통로(X02) / 앞 화단 소나무 =====================
z05 = load('z05-upper-branch.geojson'); n0 = len(z05['features'])
drop = lambda i: (i.startswith('Z07-CORRIDOR-') and ('-WALL-' in i or i.endswith('-COVER') or i.split('-')[2] in ('03', '04', '05', '06', '07'))) or i == 'Z07-DECK-RAIL-S'
z05['features'] = [f for f in z05['features'] if not drop(f['properties']['id'])]; dump('z05-upper-branch.geojson', z05); print('z05 걷음', n0 - len(z05['features']))
u03 = load('u03-underground-walk.geojson'); n0 = len(u03['features'])
u03['features'] = [f for f in u03['features'] if not f['properties']['id'].startswith('U03-LINK-BONGWAN-HANLIM-')]; dump('u03-underground-walk.geojson', u03); print('u03 걷음', n0 - len(u03['features']))
tr = load('z06-trees.geojson'); n0 = len(tr['features'])
tr['features'] = [f for f in tr['features'] if f['properties'].get('basePlane') not in ('Z02-PLANTER-MAIN', 'Z02-PLANTER-EAST')]; dump('z06-trees.geojson', tr); print('z06 나무 걷음', n0 - len(tr['features']))

dump('x22-photo-fixes.geojson', {'type': 'FeatureCollection', 'name': 'x22-photo-fixes', 'crs': CRS,
  'provenance': {'builder': 'docs/audit/x22/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': f'X22 전경 영상·사진 비교 고침({NOTE}). 치수는 사진 눈대중이라 전부 estimated.'}, 'features': FEATS})
print('x22 상자', len(FEATS))
