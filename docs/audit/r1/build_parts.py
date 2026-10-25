"""R1(2026-10-25): 정문·정문 진입로·2주차장(P2) 어귀·회차 공간을 전수 판독 R1 대로 고친다. DB·네트워크 접근 없음.   python -X utf8 build_parts.py
근거: 볼트 데이터/보완자료/학교-전경-20261022/전수판독/R1/판독.md(보완 목록 G·T, 그림 20-종합-평면, S-MAP 정사 10·11),
  구역 노트 정문.md·북악관 앞 회차 공간과 본관 앞.md 의 "2026-10-25 R1 전수 판독 반영" 절.
옛 생성 스크립트(p02/parts2.py, x40/build_parts.py, z05/build_inputs.py, z13/sidewalks.py)는 뒤 작업(W01·D25 등)이 같은 파일을 id 로 고쳐
다시 돌릴 수 없다. 그래서 d25 처럼 id 로 고친다(몇 번 돌려도 같다. d25/build_parts.py 다음에 돌린다).
고치는 파일:
  frontend/public/structures/r1-gate.geojson        (새) 정산기 섬·말뚝·정산기, 관제센터, 정문 쪽 바닥 칠(횡단보도 넷·정지선)
  frontend/public/structures/z05-gate.geojson       차단기 기둥·막대(Z05-GATE-BARRIER-*)를 섬 북쪽 끝으로 (G7)
  frontend/public/structures/z13-gate-sidewalks.geojson  서쪽 인도 557139~557151 조각(W-01~07, 경계석 W-01~07)을 걷음: 그 자리는 차도·섬(G12)
  frontend/public/structures/p02-parts.geojson      버스 칸 둘째(T1) 자리, 긴 대각 횡단보도(T3), 둘째 횡단보도 걷음(T4)
  frontend/public/structures/x40-parts.geojson      장애인 주차 칸(T5) 자리·크기
G1(정문 철골 틀 14 m 이동)은 고치지 않는다(근거 한 장, 사용자 확인 대기). 높이는 기단 윗면에서 오고 기단은 그대로다."""
import json, math, pathlib, copy
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape
from shapely.ops import unary_union
from shapely import affinity

HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
def load(fn): return json.loads((STR / fn).read_text(encoding='utf-8'))
COMPACT = ('z13-gate-sidewalks.geojson',)   # 원래 한 줄로 쓰인 파일은 그대로 한 줄로
def dump(fn, obj): (STR / fn).write_text(json.dumps(obj, ensure_ascii=False, indent=None if fn in COMPACT else 1) + '\n', encoding='utf-8', newline='\n')

SRC = '판독 보완자료/학교-전경-20261022/전수판독/R1/판독.md(S-MAP 정사 10·11, 네이버 위성, 카카오 항공, 거리뷰 정문길-123·133·142·152, 사진 본관-서쪽-위에서)'
G_OK = '확정(판독 R1: 서로 다른 자료 둘 이상), 추정(치수 ±0.5~1.5 m)'
G_EST = '추정(판독 R1: 한 자료·눈대중)'
OUT = 'r1-gate.geojson'

# ---------- 기단 윗면 ----------
PLAT = []
for fp in sorted(STR.glob('*.geojson')):
    if fp.name.startswith('a2-'): continue
    for ft in json.loads(fp.read_text(encoding='utf-8'))['features']:
        p = ft['properties']
        if p.get('kind') == 'platform': PLAT.append((shape(ft['geometry']).buffer(0), p))
ROAD_FIRST = ('GATE-V1', 'GATE-V2S', 'GATE-PLOW', 'TURN-PLAZA')
def prof_z(pr, x, y):
    d = np.array(pr['direction'], float); L = float(np.hypot(*d)); t = ((x - pr['origin'][0]) * d[0] + (y - pr['origin'][1]) * d[1]) / L
    ps = pr['points']; return float(np.interp(t, [q[0] for q in ps], [q[1] for q in ps]))
def plat_at(x, y):
    """그 점의 바닥 기단: 차도·회차 포장 기단이 덮으면 그것(정문 안 포장 기단이 차도보다 최대 0.36 m 높아서), 아니면 가장 높은 것."""
    pt = Point(x, y); on = [(g, p) for g, p in PLAT if g.contains(pt)]
    assert on, (x, y)
    pick = [q for q in on if any(k in q[1]['id'] for k in ROAD_FIRST)] or on
    def z(q): return q[1]['topM'] if q[1].get('topM') is not None else prof_z(q[1]['topProfile'], x, y)
    return max(pick, key=z)[1]
def ground(x, y):
    p = plat_at(x, y); return p['topM'] if p.get('topM') is not None else prof_z(p['topProfile'], x, y)

def ring(poly):
    p = [[r2(x), r2(y)] for x, y in list(poly.exterior.coords)[:-1]]
    if Polygon(p).exterior.is_ccw is False: p = p[::-1]
    return p + [p[0]]
def geom(poly):
    poly = poly.buffer(0); assert poly.geom_type == 'Polygon' and poly.area > 0.003, poly
    return {'type': 'Polygon', 'coordinates': [ring(poly)]}
def unit(v): v = np.array(v, float); return v / np.hypot(*v)
def rect(c, along, L, W):
    """가운데 c, 긴 쪽 방향 along 으로 길이 L, 폭 W."""
    a = unit(along); n = np.array([-a[1], a[0]]); c = np.array(c, float)
    return Polygon([tuple(c + a * s + n * d) for s, d in ((-L / 2, -W / 2), (L / 2, -W / 2), (L / 2, W / 2), (-L / 2, W / 2))])
def seg(p0, p1, W):
    p0, p1 = np.array(p0, float), np.array(p1, float); return rect((p0 + p1) / 2, p1 - p0, float(np.hypot(*(p1 - p0))), W)

def feat(fid, typ, poly, z0, z1, what, grade, base, **extra):
    assert z1 > z0, fid
    return {'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base,
            'fromM': r2(z0), 'toM': r2(z1), 'assumption': 'R1: ' + what, 'source': SRC, **extra}, 'geometry': geom(poly)}
def paint(fid, poly, what, grade, color='#f2f2ee', lift=0.05, thick=0.03, **extra):
    """바닥 칠: 그 자리 기단 윗면과 같은 기울기의 얇은 판(x40 장애인 칸과 같은 방식). 칠 가운데의 기단을 쓴다."""
    c = poly.centroid; p = plat_at(c.x, c.y)
    if p.get('topProfile'):
        pr = copy.deepcopy(p['topProfile']); pr['points'] = [[q[0], r2(q[1] + lift)] for q in pr['points']]
        zs = [prof_z(pr, x, y) for x, y in poly.exterior.coords]
        f = feat(fid, 'wall', poly, min(zs) - thick, max(zs), what + '(바닥의 칠을 얇은 판으로 나타냄)', grade, p['id'], color=color, surfaceMark=True, **extra)
        f['properties'].update(topProfile=pr, thicknessM=thick)
    else:
        z = p['topM'] + lift; f = feat(fid, 'wall', poly, z - thick, z, what + '(바닥의 칠을 얇은 판으로 나타냄)', grade, p['id'], color=color, surfaceMark=True, **extra)
    return f
def stripes(pid, p0, p1, width, bar, gap, what, grade, color='#f2f2ee', margin=0.0):
    """횡단보도 줄: 걷는 선 p0 → p1, 폭 width(줄 길이). 줄은 걷는 방향으로 bar 두께, gap 사이."""
    p0, p1 = np.array(p0, float), np.array(p1, float); a = unit(p1 - p0); n = np.array([-a[1], a[0]]); L = float(np.hypot(*(p1 - p0)))
    out = []; s = margin; k = 0
    while s + bar <= L - margin + 1e-6:
        k += 1; c = p0 + a * (s + bar / 2); out.append(paint(f'{pid}-{k:02d}', rect(c, n, width, bar), what + f'의 흰 줄(길이 {width:g} m, 두께 {bar:g} m, 사이 {gap:g} m)', grade, color)); s += bar + gap
    return out

# 지금 구조물 상자(겹침 검사용: 칠·나무 빼고)
BOXES = {}
for fp in sorted(STR.glob('*.geojson')):
    if fp.name in ('a2-ground-surfaces.geojson', OUT): continue
    for ft in json.loads(fp.read_text(encoding='utf-8'))['features']:
        p = ft['properties']
        if p.get('kind') == 'platform' or p.get('surfaceMark') or p.get('type') in ('tree', 'surface', 'curb') or not ft['geometry']['coordinates']: continue
        BOXES[p['id']] = (shape(ft['geometry']).buffer(0), p, fp.name)
def hits(poly, z0, z1, skip=()):
    out = []
    for i, (g, p, fn) in BOXES.items():
        if any(i.startswith(s) for s in skip): continue
        lo, hi = p.get('fromM', 0), p.get('toM', 0)
        if p.get('topProfile'): zs = [q[1] for q in p['topProfile']['points']]; hi = max(zs); lo = min(zs) - (p.get('thicknessM') or 0)
        if hi > z0 + 0.02 and lo < z1 - 0.02 and g.intersection(poly).area > 0.01: out.append((i, round(g.intersection(poly).area, 2)))
    return out

FEATS = []
REPORT = []
# ======================= 1. 정문·2주차장 어귀 =======================
# G7 정산기 섬: 가운데 선 (201105.4, 557141.2) → (201101.0, 557151.5), 폭 2.0, 윗면 = 차로 + 0.15, 분홍 블록, 둘레 검은 말뚝
IS0, IS1 = np.array([201105.4, 557141.2]), np.array([201101.0, 557151.5])
isl = seg(IS0, IS1, 2.0)
pier = BOXES['Z05-PARKING1-PORTAL-PIER-1'][0]
isl = isl.difference(unary_union([pier, BOXES['Z05-PARKING1-PORTAL-OPENING'][0]]).buffer(0.05))
ia = unit(IS1 - IS0); z_s, z_n = ground(*IS0) + 0.15, ground(*IS1) + 0.15
ISL_PROF = {'origin': [r2(IS0[0]), r2(IS0[1])], 'direction': [r2(ia[0]), r2(ia[1])], 'points': [[0.0, r2(z_s)], [r2(np.hypot(*(IS1 - IS0))), r2(z_n)]]}
f = feat('R1-P2-ISLAND', 'landing', isl, min(z_s, z_n) - 0.45, max(z_s, z_n),
         'P2 차로와 진입로 사이 좁은 섬(정산기 섬): 가운데 선 (201105.4, 557141.2) → (201101.0, 557151.5), 폭 2.0 m, 윗면 = 차로 + 0.15 m, 분홍 블록(판독 6). '
         '주차장 문 동쪽 기둥 자리는 비움. 사람이 걷는지는 모름(사용자 질문 2) — 길은 긋지 않음', G_OK, plat_at(*((IS0 + IS1) / 2))['id'],
         color='#9c8f86', topColor='#c99a9c', material='stone')
def low(x, y):   # 그 점을 덮는 기단 가운데 가장 낮은 윗면(섬 옆 P2 차로가 내려가므로 섬 밑이 뜨지 않게)
    pt = Point(x, y); return min((p['topM'] if p.get('topM') is not None else prof_z(p['topProfile'], x, y)) for g, p in PLAT if g.buffer(0.3).contains(pt))
ISL_T = r2(max(prof_z(ISL_PROF, x, y) - low(x, y) for x, y in isl.exterior.coords) + 0.1)
f['properties'].update(topProfile=ISL_PROF, thicknessM=ISL_T, fromM=r2(min(z_s, z_n) - ISL_T)); FEATS.append(f)
REPORT.append(f'섬 두께 {ISL_T} m')
REPORT.append(f'섬 윗면 {z_s:.2f} → {z_n:.2f} m, 넓이 {isl.area:.1f} ㎡')
# 말뚝: 섬 둘레 양 긴 변에 4개씩(0.15 m 네모, 0.8 m)
nrm = np.array([-ia[1], ia[0]]); Ls = float(np.hypot(*(IS1 - IS0)))
k = 0
for side in (-1, 1):
    for s in (1.5, 4.5, 7.5, 10.5):
        c = IS0 + ia * s + nrm * side * 1.15; k += 1; zb = ground(*c)
        FEATS.append(feat(f'R1-P2-ISLAND-BOLLARD-{k}', 'wall', rect(c, ia, 0.15, 0.15), zb, zb + 0.8, '섬 둘레 검은 말뚝(수·간격 추정)', G_EST, 'R1-P2-ISLAND', color='#2a2a2a'))
# 정산기 둘: 섬 북쪽 끝(0.6 × 0.6 × 1.4)
for j, s in enumerate((Ls - 1.9, Ls - 0.8)):
    c = IS0 + ia * s; zt = prof_z(ISL_PROF, *c)
    FEATS.append(feat(f'R1-P2-PAY-{j + 1}', 'wall', rect(c, ia, 0.6, 0.6), zt, zt + 1.4, '섬 북쪽 끝 정산기(0.6 × 0.6 × 1.4 m)', G_OK, 'R1-P2-ISLAND', color='#3d4a57', topColor='#d6d6d6'))

# G9 관제센터: 가운데 (201130.5, 557127), 길 방향 333°, 8.0 × 2.6 × 3.2 m, 흰 판 지붕 앞(길 쪽)으로 0.8 m, 검은 앞면, 화강석 기단 2단
ROAD = np.array([math.sin(math.radians(333.0)), math.cos(math.radians(333.0))]); OUTN = np.array([-ROAD[1], ROAD[0]])   # OUTN = 길 쪽(서남서)
if OUTN @ np.array([-1.0, 0.0]) < 0: OUTN = -OUTN
cc = np.array([201130.5, 557127.0])
body = rect(cc, ROAD, 8.0, 2.6)
foot = lambda c: rect(c + OUTN * 0.15, ROAD, 8.4, 3.2)   # 기단 아랫단(가장 넓음)
over = [h for h in hits(foot(cc), 107.0, 110.5, skip=('W01-GATE-TOWER', 'W01-GATE-BEAM', 'W01-GATE-DIAG'))]
shift = 0.0
while over and shift < 3.0:   # 인도 판·경계석과 겹치면 길 반대쪽(동)으로 0.1 m 씩 민다(판독: 인도 뒤)
    shift += 0.1; body = rect(cc - OUTN * shift, ROAD, 8.0, 2.6); over = hits(foot(cc - OUTN * shift), 107.0, 110.5, skip=('W01-GATE-TOWER', 'W01-GATE-BEAM', 'W01-GATE-DIAG'))
cc2 = cc - OUTN * shift; zg = ground(*cc2)
REPORT.append(f'관제센터 가운데 ({cc2[0]:.1f}, {cc2[1]:.1f}) 동으로 {shift:.1f} m 밀림, 바닥 {zg:.2f}, 남은 겹침 {over}')
base = plat_at(*cc2)['id']
FEATS.append(feat('R1-CONTROL-BASE-1', 'wall', rect(cc2 + OUTN * 0.15, ROAD, 8.4, 3.2), zg - 0.3, zg + 0.15, '관제센터 화강석 기단 아랫단', G_EST, base, color='#b8b2a7', material='stone'))
FEATS.append(feat('R1-CONTROL-BASE-2', 'wall', rect(cc2, ROAD, 8.2, 2.8), zg + 0.15, zg + 0.3, '관제센터 화강석 기단 윗단', G_EST, 'R1-CONTROL-BASE-1', color='#c4beb3', material='stone'))
FEATS.append(feat('R1-CONTROL-BODY', 'wall', body, zg + 0.3, zg + 3.2, '통합보안 관제센터 한 층 상자(길 방향 8.0 × 2.6 m, 높이 3.2 m. 자리·크기 추정, 수인관 벽에 붙는지 모름)', G_EST, 'R1-CONTROL-BASE-2', color='#2b2d30', topColor='#e8e6e1'))
FEATS.append(feat('R1-CONTROL-ROOF', 'wall', rect(cc2 + OUTN * 0.4, ROAD, 8.4, 3.4), zg + 3.2, zg + 3.45, '흰 판 지붕(길 쪽으로 0.8 m 나옴)', G_EST, 'R1-CONTROL-BODY', color='#ecebe7'))
FEATS.append(feat('R1-CONTROL-FRONT', 'wall', rect(cc2 + OUTN * 1.32, ROAD, 7.6, 0.05), zg + 0.5, zg + 3.0, '검은 판 앞면(안내도 판 포함으로 줄임)', G_EST, 'R1-CONTROL-BODY', color='#151618'))

# 바닥 칠(G2~G6). 줄 두께 0.45, 사이 0.45 (p02 와 같음)
FEATS += stripes('R1-PAINT-GATE-XWALK', (201129.4, 557103.0), (201137.6, 557107.0), 6.0, 0.45, 0.45, '정문 앞 얼룩말 횡단보도(가운데 (201133.5, 557105), 약 9 × 6 m)', G_OK, margin=0.2)
FEATS.append(paint('R1-PAINT-GATE-STOPLINE', seg((201126.5, 557108.9), (201131.0, 557108.1), 0.4), '정문 횡단보도 북쪽 정지선', G_OK))
FEATS += stripes('R1-PAINT-P2-XWALK', (201113.0, 557130.5), (201108.0, 557141.0), 2.5, 0.45, 0.45, 'P2 어귀 횡단보도(진입로 서쪽 가장자리를 따라 P2 차로 어귀를 건넘, 폭 2.5 m)', G_OK, margin=0.2)
FEATS += stripes('R1-PAINT-ZEBRA', (201103.8, 557157.2), (201110.3, 557160.2), 4.5, 0.45, 0.45, '얼룩말 횡단보도(가운데 (201107, 557158.7), 약 7 × 4.5 m)', G_OK, margin=0.1)
# 고원식 횡단보도: 가운데 (201108.5, 557149), 길을 가로질러 8.5 m, 폭 4 m, 솟음 0.1 m. 위는 흰 줄, 길 쪽 양 끝 0.6 m 는 노랑 빗금(비탈)
RX0, RX1 = np.array([201104.6, 557147.2]), np.array([201112.5, 557150.9]); ra = unit(RX1 - RX0); rn = np.array([-ra[1], ra[0]])
# 판독은 "약 8.5 m" 이나 정사 10 에서 노랑 빗금이 동쪽 경계석까지 보인다: 서쪽 끝(섬 동쪽 변)에서 동쪽 인도 경계석까지 차도 폭 전체로 늘림
KERB_E = unary_union([BOXES[i][0] for i in BOXES if i.startswith('Z13-KERB-E-')])
hit = LineString([tuple(RX0), tuple(RX0 + ra * 20)]).intersection(KERB_E)
RL = min(LineString([tuple(RX0), tuple(RX0 + ra * 20)]).project(Point(c)) for g in getattr(hit, 'geoms', [hit]) for c in g.coords)
rc = RX0 + ra * RL / 2
hump = rect(rc, ra, RL, 4.0)
REPORT.append(f'고원식 길이 {RL:.2f} m, 가운데 ({rc[0]:.1f}, {rc[1]:.1f})')
FEATS.append(paint('R1-PAINT-RAISED-XWALK', hump, f'고원식 횡단보도 솟은 판({RL:.1f} × 4 m, 차도 위 0.1 m. 판독 약 8.5 m 를 섬 동쪽 변 ~ 동쪽 경계석으로 늘림)', G_OK, color='#d8d2c2', lift=0.1, thick=0.12))
k = 0; s = -RL / 2 + 0.3
while s + 0.45 <= RL / 2 - 0.3:
    k += 1; FEATS.append(paint(f'R1-PAINT-RAISED-XWALK-W{k:02d}', rect(rc + ra * (s + 0.225), rn, 2.6, 0.45), '고원식 횡단보도 위 흰 줄', G_OK, lift=0.11, thick=0.02)); s += 0.9
for j, d in enumerate((-1.7, 1.7)):
    for m in range(8):
        c = rc + rn * d + ra * (-RL / 2 + 0.6 + m * (RL - 1.2) / 7)
        FEATS.append(paint(f'R1-PAINT-RAISED-XWALK-Y{j + 1}{m + 1}', affinity.rotate(rect(c, ra, 0.35, 0.6), 35, origin=Point(*c)), '고원식 횡단보도 비탈의 노랑 빗금', G_OK, color='#e3b52b', lift=0.11, thick=0.02))

# ======================= 2. 차단기(z05-gate) =======================
z05 = load('z05-gate.geojson'); Z5 = {f['properties']['id']: f for f in z05['features']}
POST = np.array([201102.4, 557153.4]); ARM1 = np.array([201110.6, 557157.5]); zr = ground(*POST)
def setp(f, poly, z0, z1, what, grade):
    p = f['properties']; f['geometry'] = geom(poly); p.update(fromM=r2(z0), toM=r2(z1), grade=grade, source=SRC)
    p['assumption'] = p.get('assumption', '').split(' R1:')[0] + ' R1: ' + what
setp(Z5['Z05-GATE-BARRIER-POST'], rect(POST, ra, 0.4, 0.4), zr, zr + 1.2,
     '차단기 기둥을 섬 북쪽 끝으로(판독: 기둥 (201102.2, 557152.4)·막대 시작 (201102.6, 557153.8) ±1 m → 한 자리 (201102.4, 557153.4) 로 맞춤). 전: 북좌표 557165', G_OK)
setp(Z5['Z05-GATE-BARRIER-ARM'], seg(POST, ARM1, 0.1), zr + 0.95, zr + 1.05, '막대: 기둥 → (201110.6, 557157.5), 오르는 차로를 가로지름, 높이 1.0 m', G_OK)
for i in ('Z05-GATE-BARRIER-POST', 'Z05-GATE-BARRIER-ARM'): Z5[i]['properties']['basePlane'] = plat_at(*POST)['id']
dump('z05-gate.geojson', z05)
REPORT.append(f'차단기 바닥 {zr:.2f}')

# ======================= 3. Z13 서쪽 인도 557139~557151 을 걷음(G12) =======================
z13 = load('z13-gate-sidewalks.geojson')
GONE = {f'Z13-SIDEWALK-W-{k:02d}' for k in range(1, 8)} | {f'Z13-KERB-W-{k:02d}' for k in range(1, 8)}
n0 = len(z13['features']); z13['features'] = [f for f in z13['features'] if f['properties']['id'] not in GONE]
dump('z13-gate-sidewalks.geojson', z13); REPORT.append(f'z13 서쪽 인도 조각 걷음 {n0 - len(z13["features"])}')

# ======================= 4. 회차 공간 바닥 칠(p02) =======================
p02 = load('p02-parts.geojson')
old = {f['properties']['id']: f for f in p02['features'] if f['properties']['id'].startswith('P02-TURN-BUSBAY-2-')}
assert old, 'P02-TURN-BUSBAY-2 없음'
# T1: 버스 칸 북 = 가운데 (201007.4, 557359.9), 4.2 × 8.8 m, 긴 변 남북(아치 건물 정면과 나란히, 방위 약 352°). 글자 BUS 그대로 옮김
BA = np.array([math.sin(math.radians(352.0)), math.cos(math.radians(352.0))]); BN = np.array([-BA[1], BA[0]])
BC = np.array([201007.4, 557359.9]); BL, BW, T = 8.8, 4.2, 0.15
keep = [f for f in p02['features'] if not (f['properties']['id'].startswith('P02-TURN-BUSBAY-2-') or f['properties']['id'].startswith('P02-TURN-CROSSWALK-')
        or f['properties']['id'].startswith('R1-'))]
new = []
for q, (c, L, W) in enumerate(((BC - BN * (BW / 2 - T / 2), BL, T), (BC + BN * (BW / 2 - T / 2), BL, T), (BC - BA * (BL / 2 - T / 2), T, BW), (BC + BA * (BL / 2 - T / 2), T, BW))):
    new.append(paint(f'P02-TURN-BUSBAY-2-LINE{q + 1}', rect(c, BA, L, W), '버스 칸 북(아치 건물 북쪽 끝 앞, "1164" 표지 옆)의 흰 테두리. T1: 유담관 입구 화단 남쪽 끝 위에서 옮김', G_OK))
if True:   # 다시 돌리면 옛 글자 = 이미 옮긴 글자라 돌림 0·옮김 0
    txt = [i for i in old if '-TEXT-' in i]; tc = unary_union([shape(old[i]['geometry']) for i in txt]).centroid
    # 옛 글자 줄의 읽는 방향: B → S 가운데
    b = shape(old[[i for i in txt if i.endswith('-B')][0]]['geometry']).centroid; s_ = shape(old[[i for i in txt if i.endswith('-S')][0]]['geometry']).centroid
    ang_old = math.degrees(math.atan2(s_.y - b.y, s_.x - b.x)); ang_new = math.degrees(math.atan2(BA[1], BA[0]))   # 새 칸: 남 → 북으로 읽음
    moved = float(np.hypot(tc.x - BC[0], tc.y - BC[1])) < 0.05 and abs(ang_new - ang_old) < 0.5
    for i in sorted(txt):
        g = shape(old[i]['geometry'])
        if not moved: g = affinity.translate(affinity.rotate(g, ang_new - ang_old, origin=tc), BC[0] - tc.x, BC[1] - tc.y).buffer(0.006, join_style=2)
        new.append(paint(i, g, '버스 칸 북의 글자 BUS(옛 칸에서 옮김)', G_OK))
# T3: 긴 대각 횡단보도 (201006.5, 557346.7) → (201026.5, 557355.6), 폭 3.0, 줄 0.5 m 간격. T4: 북쪽 둘째 횡단보도는 걷음(두 항공 모두 없음)
new += stripes('P02-TURN-CROSSWALK-1', (201006.5, 557346.7), (201026.5, 557355.6), 3.0, 0.5, 0.5, '서쪽 아치 건물 앞 보도 → 회차 공간 가운데 긴 대각 횡단보도(약 21 m, 폭 3 m). T3', G_OK, margin=0.25)
# 버스 칸 북이 놓일 자리의 다른 칠과 겹치는지
for f in new:
    if f['properties']['id'].startswith('P02-TURN-BUSBAY-2-LINE'):
        h = hits(shape(f['geometry']), f['properties']['fromM'] - 0.2, f['properties']['toM'] + 0.2)
        if h: REPORT.append(f'{f["properties"]["id"]} 겹침 {h}')
p02['features'] = keep + new
dump('p02-parts.geojson', p02)
REPORT.append(f'p02: 버스 칸 북·대각 횡단보도 {len(new)}')

# ======================= 5. 장애인 주차 칸(x40, T5) =======================
x40 = load('x40-parts.geojson')
X = {f['properties']['id']: f for f in x40['features']}
# 판독 T5 의 "x 201033.8~201042 × y 557344~557349.8(8.2 × 5.8 m)" 는 축에 맞춘 둘레 상자다. 정사 11 에서 칸 네 모서리를 다시 재면
# (201035.3, 557349.7)·(201041.8, 557346.7)·(201039.7, 557342.7)·(201033.5, 557345.2): 본관 긴 축(방위 115.6°, X44 와 같음)으로 기운 7.2 × 4.7 m.
DC = np.array([201037.6, 557346.1]); DA = np.array([math.sin(math.radians(115.6)), math.cos(math.radians(115.6))]); DN = np.array([-DA[1], DA[0]])   # DA = 칸 줄(동남동), DN = 북북동
def Q(a0, a1, b0, b1): return Polygon([tuple(DC + DA * a + DN * b) for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))])
x40['features'] = [f for f in x40['features'] if not f['properties']['id'].startswith('X40-DISABLED-')]
# 칠이 닿으면 안 되는 상자: 출입부 북쪽 돌 화단, U03 본관 모서리 앞 계단 빈 곳·유리문(자리 추정. 정사에서는 칸이 그 자리까지 보임: 노트에 적음)
CUT = unary_union([BOXES[i][0] for i in BOXES if i in ('P01-BONGWAN-WPLANTER-N', 'U03-VOID-LOBBY', 'U03-VOID-STEPS', 'U03-GLASS-DOOR')]).buffer(0.05)
def Qc(*a):
    g = Q(*a).difference(CUT)
    if g.geom_type != 'Polygon': g = max(g.geoms, key=lambda q: q.area)
    return g
dis = []; HL, HD = 3.6, 2.35
for j, (a0, a1) in enumerate(((-HL, -0.8), (0.8, HL))):   # 칸 2.8 + 빗금 1.6 + 칸 2.8 = 7.2 m, 깊이 4.7 m
    dis.append(paint(f'X40-DISABLED-BAY-{j + 1}', Qc(a0, a1, -HD, HD), '장애인 주차 칸 파란 바닥(2.8 × 4.7 m). T5: 칸 둘 + 가운데 빗금, 본관 긴 축과 나란히', G_OK, color='#2f6db5', lift=0.02, thick=0.02))
    m = (a0 + a1) / 2
    dis.append(paint(f'X40-DISABLED-BAY-{j + 1}-SIGN', Qc(m - 0.6, m + 0.6, -0.6, 0.6), '바닥의 흰 휠체어 표시(네모로 줄임)', G_OK, lift=0.035, thick=0.02))
for k in range(4):
    a = -0.6 + k * 0.4
    dis.append(paint(f'X40-DISABLED-BAY-HATCH-{k + 1}', affinity.rotate(Q(a - 0.08, a + 0.08, -2.1, 2.1), 20, origin=Point(*(DC + DA * a))).difference(CUT), '가운데 빗금 칸의 흰 빗금(곧은 띠로 줄임)', G_OK, lift=0.02, thick=0.02))
for nm, (a0, a1) in (('A', (-HL, -HL + 0.1)), ('B', (-0.8, -0.7)), ('C', (0.7, 0.8)), ('D', (HL - 0.1, HL))):
    dis.append(paint(f'X40-DISABLED-BAY-LINE-{nm}', Qc(a0, a1, -HD, HD), '칸 흰 테두리', G_OK, lift=0.025, thick=0.02))
dis = [f for f in dis if f]
post = DC + DA * (HL - 0.3) + DN * (HD + 0.25)   # 칸 동쪽 끝(판독), 칸 머리 쪽
while hits(Point(*post).buffer(0.3, 4), ground(*post), ground(*post) + 2.5): post = post - DA * 0.2
zp = ground(*post)
dis.append(feat('X40-DISABLED-SIGN-POST', 'wall', Point(*post).buffer(0.05, 4), zp - 0.1, zp + 2.6, '파란 안내 표지 기둥(칸 동쪽 끝, 판독. 다른 상자와 0.3 m 띄움)', G_OK, plat_at(*post)['id'], color='#8a8d90'))
dis.append(feat('X40-DISABLED-SIGN-PLATE', 'wall', rect(post - DN * 0.08, DA, 0.6, 0.04), zp + 1.9, zp + 2.5, '파란 장애인 주차 안내 판', G_OK, 'X40-DISABLED-SIGN-POST', color='#2f6db5'))
REPORT.append(f'장애인 칸 표지 기둥 ({post[0]:.1f}, {post[1]:.1f}), 칸 깎인 넓이 {sum(Q(*a).area for a in ((-HL, -0.8, -HD, HD), (0.8, HL, -HD, HD))) - sum(shape(f["geometry"]).area for f in dis if f["properties"]["id"] in ("X40-DISABLED-BAY-1", "X40-DISABLED-BAY-2")):.2f} ㎡')
x40['features'] += dis
dump('x40-parts.geojson', x40)

# ======================= 새 파일 =======================
for f in FEATS:
    p = f['properties']
    if p['type'] in ('landing', 'wall') and not p.get('surfaceMark') and p['id'] not in ('R1-P2-ISLAND',):
        h = hits(shape(f['geometry']), p['fromM'], p['toM'], skip=('W01-GATE-TOWER', 'W01-GATE-BEAM', 'W01-GATE-DIAG', 'Z05-GATE-BARRIER'))
        if h: REPORT.append(f'{p["id"]} 겹침 {h}')
h = hits(isl, z_s - 0.4, z_n, skip=('Z05-GATE-BARRIER',)); REPORT.append(f'섬 겹침 {h}')
dump(OUT, {'type': 'FeatureCollection', 'name': 'r1-gate', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': FEATS})
print('\n'.join(REPORT)); print(f'{OUT}: {len(FEATS)}')
