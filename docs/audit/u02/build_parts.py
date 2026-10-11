"""U02: 운동장 아래 지하 1층·지하 2층을 사용자 붉은 선(단면)·학교 지하도 지도(평면)·사용자 사진(U자 경사로)으로 다시 만든다. DB·네트워크 접근 없음.   python build_parts.py
쓰는 파일:
  frontend/public/structures/u01-field-basement.geojson   (파일 이름은 U01 그대로. 안의 id 는 U02-…) 형식 docs/audit/g02/STRUCTURES.md (U02 절)
  docs/audit/u02/model.json                               높이·경사·길 선(build_groups.py 의 입력)
읽는 파일: georef.json(georef.py), 운동장 슬래브 기단, 내리막길 기단. z02/build_inputs.py 를 먼저 돌린다(슬래브 기단 아랫면을 지하 2층 아래로).
근거와 추정은 볼트 구역 노트 "운동장 아래 지하층과 지하 차도"(U02 절). 높이 띠는 사용자 표시(±1 m), 평면은 학교 지도(잔차 RMS 3.3 m), 나머지는 estimated."""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape
from shapely.ops import unary_union
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'; HERE = pathlib.Path(__file__).parent
r2 = lambda v: round(float(v), 2)
load = lambda fn: json.loads((STR / fn).read_text(encoding='utf-8'))['features']
BLDS = {b['id']: Polygon(b['ring']).buffer(0) for b in json.loads((REPO / 'docs/audit/z04/scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']}
BLD = unary_union(list(BLDS.values())); HYEIN = BLDS['건물5']   # 장면 갈무리의 id(지금 서버 id 는 혜인관)
FIELD = next(shape(f['geometry']) for f in load('z02-daeil-front.geojson') if f['properties']['id'] == 'Z02-PLATFORM-FIELD')
WAYF = next(f for f in load('g02-way.geojson') if f['properties']['id'] == 'G02-PLATFORM-WAY'); WAY = shape(WAYF['geometry']); WP = WAYF['properties']['topProfile']
GEO = json.loads((HERE / 'georef.json').read_text(encoding='utf-8')); RES = GEO['residualM']['rms']
def way_top(x, y):
    o, d, pts = np.array(WP['origin']), np.array(WP['direction']), np.array(WP['points']); return float(np.interp((x - o[0]) * d[0] + (y - o[1]) * d[1], pts[:, 0], pts[:, 1]))

# ---------- 높이 ----------
Z_FIELD = 148.9            # 측정(E06). 바꾸지 않는다
Z_B1 = 141.4               # 지하 1층 바닥. 범위 140.1(사용자 선) ~ 141.7. 사용자가 맞다고 한 지하 차도 진입 높이(141.4~) 와 은주1관 3층(5층 148.9 에서 두 층 아래) 계산이 같이 맞는 값(구역 노트)
C_B1 = 144.4               # 지하 1층 천장 = 사용자 윗선(±1)
SLAB_B1 = 1.0              # 추정: 지하 1층 바닥 구조(판 + 보). 밑면 140.4 = 사용자 가운데 선 140.1 과 0.3 m
C_B2 = r2(Z_B1 - SLAB_B1)  # 140.4
Z_B2 = 133.0               # 지하 2층 바닥 = 사용자 아랫선(±1)
BASE = 1.0                 # 추정: 기초 판
WALL = 1.0
ROAD_W, CLEAR, ROOF = 7.2, 3.5, 0.6
C_ROAD = 144.7             # 지하 차도 연장의 천장 상한(U01 단면 그대로: 사용자가 "사진과 같다"고 한 141.4~144.7)

# ---------- 평면: 학교 지도의 주차장 외곽 ----------
NL0, NL1 = np.array(GEO['xy']['parking'][0]), np.array(GEO['xy']['parking'][5])   # 북쪽 변(은주1관 북동 모서리 ~ 청운관 서쪽 초록 점)
dn = (NL1 - NL0) / np.hypot(*(NL1 - NL0)); sn = np.array([dn[1], -dn[0]])          # sn = 남쪽
if sn[1] > 0: sn = -sn
south = Polygon([NL0 - dn * 300, NL1 + dn * 300, NL1 + dn * 300 + sn * 400, NL0 - dn * 300 + sn * 400])
INNER = FIELD.buffer(-WALL, join_style=2).intersection(south).difference(BLD.buffer(0.5)).buffer(0)
assert INNER.geom_type == 'Polygon', INNER.geom_type
MAPPOLY = Polygon(GEO['xy']['parking'])

# ---------- 지하 차도: 내리막길 밑(U01 의 선 그대로) → 운동장 서쪽 벽 → 주차장 북서 모서리 ----------
P0 = np.array([201100.3, 557327.58]); Z_P0 = 136.39
D = np.array(WP['direction']); D = D / np.hypot(*D)
hit = LineString([P0, P0 + D * 200]).intersection(FIELD.buffer(-WALL, join_style=2)); hit = hit if hit.geom_type == 'LineString' else max(hit.geoms, key=lambda g: g.length)
E0 = np.array(hit.coords[0]); L_APP = float(np.hypot(*(E0 - P0))); GRADE_APP = (Z_B1 - Z_P0) / L_APP
W1 = NL0 + dn * 6.0                     # 북쪽 벽을 뚫는 자리: 북서 모서리에서 6 m
J0 = W1 + sn * 6.5 + dn * 2.0           # 들어와서 처음 갈리는 곳
MAP_END = np.array(GEO['xy']['carriageway'][-1])

# ---------- 서쪽 벽 기준 축, U자 경사로(사진 03·04, 지도의 서쪽 반원 표시) ----------
WA, WB = np.array([201140.1, 557255.5]), np.array([201146.2, 557293.5])   # 운동장 서쪽 변(은주1관 벽)
w = (WB - WA) / np.hypot(*(WB - WA)); e = np.array([w[1], -w[0]])           # w = 북, e = 동(안쪽)
CC = WA + w * (557246.0 - WA[1]) / w[1] + e * 11.0                          # 섬의 중심
R_LANE, LANE_W, L_STRAIGHT = 7.5, 5.0, 36.4
arc = lambda r, th: CC + r * (np.cos(th) * e - np.sin(th) * w)              # th 0 = 동쪽(지하 1층에서 들어섬), pi/2 = 남쪽, pi = 서쪽
S0, W0 = arc(R_LANE, 0.0), arc(R_LANE, np.pi); RB = W0 + w * L_STRAIGHT
L_ARC = np.pi * R_LANE; L_RAMP = L_ARC + L_STRAIGHT; DROP = Z_B1 - Z_B2; GRADE_RAMP = DROP / L_RAMP
z_at = lambda s: Z_B1 - GRADE_RAMP * s
E1 = S0 + w * 40.0                                                          # 지하 1층 차로가 경사로 머리로 내려오는 선(섬 동쪽)
C1, C2 = np.array([201200.0, 557245.0]), np.array([201185.0, 557250.0])     # 종착 표지 자리(U01 그대로, 추정)
K2 = np.array([201160.0, 557274.0])

# ---------- 사람 길 ----------
DOT = np.array(GEO['xy']['dots']['은주1관 북서(3층)'])
DOOR = WA + w * (DOT[1] - WA[1]) / w[1] + e * 1.6        # 은주1관 3층 문: 지도의 초록 점을 서쪽 벽에 붙임
SBN = DOOR + w * 4.5 + e * 0.6                           # 문 오른쪽(북쪽) 계단 발치
ST = np.array([201150.5, 557299.5])                      # 운동장 위 끝(추정): 은주1관 북쪽 끝 옆, 주차장 북쪽 벽 바깥
HD = np.array([201218.7, 557213.7])                      # 혜인관 입구(1) 문 노드(운동장 높이 = 혜인관 지하 1층 149.3)
ha, hb = np.array([201200.7, 557180.9]), np.array([201246.0, 557255.8]); ht = (hb - ha) / np.hypot(*(hb - ha)); hn = np.array([ht[1], -ht[0]])   # hn = 건물 안쪽
H_L0, H_F1 = HD + hn * 3.0, HD + hn * 11.0; H_L1 = H_F1 + ht * 1.8; H_BOT = HD + hn * 3.0 + ht * 1.8
Z_HB1 = 149.3; Z_HMID = r2((Z_HB1 + Z_B1) / 2)
H_OUT = H_BOT - hn * 6.5                                 # 계단 발치에서 벽을 지나 주차장 안으로
PV1, PV2 = np.array([201203.0, 557247.0]), np.array([201170.0, 557285.0])   # 보행 동선이 지하 1층 차로 둘을 건너지 않고 돌아가는 점(주차 자리 동쪽, 들머리 차로 북동쪽)
for name, p in (('L0', H_L0), ('F1', H_F1), ('L1', H_L1), ('BOT', H_BOT)): assert HYEIN.contains(Point(p)), name
for name, p in (('J0', J0), ('S0', S0), ('W0', W0), ('RB', RB), ('E1', E1), ('C1', C1), ('C2', C2), ('K2', K2), ('DOOR', DOOR), ('SBN', SBN), ('H_OUT', H_OUT)): assert INNER.contains(Point(p)), (name, p)
assert FIELD.contains(Point(ST)) and not INNER.contains(Point(ST))
assert not LineString([P0, E0]).buffer(ROAD_W / 2, cap_style=2).intersects(BLD)

FEATS = []
SRC = '사용자 2026-10-12: 단면 표시(01-단면-사용자표시-B1-B2.png), 학교 캠퍼스맵 지하도 연결 지점(02, 원천), 지하 1층→2층 내려가는 길 사진(03·04), 학교 지하도 안내 글. 구역 노트 운동장 아래 지하층과 지하 차도'
def ring(poly): return [[[r2(x), r2(y)] for x, y in r.coords] for r in [poly.exterior] + list(poly.interiors)]
def feat(id, typ, kind, poly, grade, assumption, **props):
    poly = poly.buffer(0)
    if poly.geom_type != 'Polygon': poly = max(poly.geoms, key=lambda g: g.area)
    assert not poly.is_empty, id
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': kind, 'estimated': True, 'grade': grade, 'assumption': assumption, 'source': SRC, **props}, 'geometry': {'type': 'Polygon', 'coordinates': ring(poly)}})
def box(id, typ, poly, lo, hi, color, assumption, grade='추정', **kw):
    feat(id, typ, 'extrude', poly, grade, assumption, fromM=r2(lo), toM=r2(hi), material='concrete', inVoid=True, color=color, **kw)

G_LEVEL = f'확정(층이 있음, 높이 띠: 사용자 붉은 선 ±1 m), 원천(평면: 학교 지도, 잔차 RMS {RES} m), 추정(판 두께·벽)'
feat('U02-VOID-B1', 'void', 'void', INNER, G_LEVEL, f'운동장 지하 1층: 바닥 {Z_B1} m(범위 140.1~141.7), 천장 {C_B1} m(사용자 윗선). 그 위 {C_B1}~{Z_FIELD} m 는 빈 층 없이 구조. 평면은 학교 지도의 주차장 외곽(북쪽 변만 운동장보다 안쪽, 나머지는 운동장 외곽에서 벽 {WALL} m)', fromM=Z_B1, toM=C_B1, name='운동장 지하 1층')
feat('U02-VOID-B2', 'void', 'void', INNER, G_LEVEL, f'운동장 지하 2층: 바닥 {Z_B2} m(사용자 아랫선 ±1), 천장 {C_B2} m = 지하 1층 바닥 구조({SLAB_B1} m) 밑. 평면은 지하 1층과 같게 둠(추정)', fromM=Z_B2, toM=C_B2, name='운동장 지하 2층')

# 지하 차도 연장(내리막길 밑, U01 의 선) + 운동장 북쪽 띠를 지나 주차장으로 들어가는 평평한 통로
n = int(np.ceil((L_APP + WALL + 0.5) / 1.0)); step = (L_APP + WALL + 0.5) / n; covers = []
for k in range(n):
    a, b = k * step, (k + 1) * step; za, zb = (min(Z_B1, Z_P0 + GRADE_APP * s) for s in (a, b)); mid = P0 + D * (a + b) / 2
    seg = LineString([P0 + D * a, P0 + D * b]).buffer(ROAD_W / 2, cap_style=2); under = WAY.contains(Point(mid))
    top = r2(min(zb + CLEAR, min(way_top(*(P0 + D * a)), way_top(*(P0 + D * b))) - ROOF)) if under else r2(zb + CLEAR)
    top = min(top, C_ROAD)
    if under: covers.append(r2(way_top(*mid) - (za + zb) / 2))
    feat(f'U02-VOID-ROAD-{k:02d}', 'void', 'void', seg, '확정(지하 차도가 지하 1층으로 들어온다: 사용자가 단면 그림대로라고 함), 추정(선·폭)', f'지하 차도 연장 {a:.0f}~{b:.0f} m: 바닥 {za:.2f} → {zb:.2f} m (경사 {GRADE_APP * 100:.1f} %), 폭 {ROAD_W} m', fromM=r2(za), toM=top, name='지하 차도')
link = LineString([E0, W1, J0]).buffer(ROAD_W / 2, cap_style=2, join_style=2).intersection(FIELD.buffer(-0.2)).difference(INNER.buffer(-0.5))
feat('U02-VOID-ROAD-LINK', 'void', 'void', link, f'원천(학교 지도: 지하 차도는 주차장 북서 모서리로 들어간다. 지도의 끝점과 {np.hypot(*(W1 - MAP_END)):.1f} m), 추정(선)', f'운동장 서쪽 벽에서 주차장 북쪽 벽(북서 모서리에서 6 m)까지의 평평한 차로: 바닥 {Z_B1}, 천장 {C_B1} m', fromM=Z_B1, toM=C_B1, name='지하 차도')

# U자 경사로: 굽은 구간(180도, 차로 가운데 반지름 7.5 m) + 곧은 구간. 한 경사
N_ARC = 12; lane_cut = []
for k in range(N_ARC):
    t0, t1 = np.pi * k / N_ARC, np.pi * (k + 1) / N_ARC; s0, s1 = R_LANE * t0, R_LANE * t1
    poly = Polygon([arc(R_LANE - LANE_W / 2, t0), arc(R_LANE + LANE_W / 2, t0), arc(R_LANE + LANE_W / 2, t1), arc(R_LANE - LANE_W / 2, t1)]); lane_cut.append(poly)
    a, b = arc(R_LANE, t0), arc(R_LANE, t1); d = (b - a) / np.hypot(*(b - a))
    feat(f'U02-RAMP-CURVE-{k:02d}', 'ramp', 'extrude', poly, '확정(섬을 끼고 도는 U자 경사로: 사진 03), 추정(자리·반지름·경사)', f'굽은 구간 {s0:.1f}~{s1:.1f} m: {z_at(s0):.2f} → {z_at(s1):.2f} m', basePlane='U02-VOID-B2 바닥', material='concrete', inVoid=True, color='#9a9892',
         topProfile={'origin': [r2(a[0]), r2(a[1])], 'direction': [float(d[0]), float(d[1])], 'points': [[0.0, r2(z_at(s0))], [r2(np.hypot(*(b - a))), r2(z_at(s1))]]}, bottomM=Z_B2)
leg = LineString([W0, RB]).buffer(LANE_W / 2, cap_style=2)
feat('U02-RAMP-STRAIGHT', 'ramp', 'extrude', leg, '확정(곧은 한 차로 경사로: 사진 04), 추정(자리·길이·경사)', f'곧은 구간 {L_STRAIGHT} m: {z_at(L_ARC):.2f} → {Z_B2} m. U자 전체 {L_RAMP:.1f} m 에 {DROP:.1f} m, 경사 {GRADE_RAMP * 100:.1f} %', basePlane='U02-VOID-B2 바닥', material='concrete', inVoid=True, color='#9a9892',
     topProfile={'origin': [r2(W0[0]), r2(W0[1])], 'direction': [float(w[0]), float(w[1])], 'points': [[0.0, r2(z_at(L_ARC))], [L_STRAIGHT, Z_B2 + 0.02]]}, bottomM=Z_B2)
OPEN_L = float(min(L_STRAIGHT, max(0.0, (z_at(L_ARC) + 3.0 - C_B2) / GRADE_RAMP) + 1.0))   # 곧은 구간에서 지하 1층 바닥 밑으로 3 m 가 될 때까지는 바닥을 틔운다
opening = unary_union(lane_cut + [LineString([W0, W0 + w * OPEN_L]).buffer(LANE_W / 2, cap_style=2)]).buffer(0.05)
feat('U02-VOID-RAMP-OPENING', 'void', 'void', opening, '확정(층 사이가 트여 있다: 사진 03), 추정(범위)', f'U자 경사로 위로 지하 1층 바닥을 틔운 곳(굽은 구간 전부 + 곧은 구간 첫 {OPEN_L:.1f} m)', fromM=C_B2, toM=Z_B1, name='경사로 구멍')
def half(r0, r1, t0=0.0, t1=np.pi):
    outer = [arc(r1, t) for t in np.linspace(t0, t1, 25)]; inner = [arc(r0, t) for t in np.linspace(t1, t0, 25)] if r0 > 0 else []
    return Polygon(outer + inner)
TEAL, STRIPE = '#2f7f86', '#d8b000'; R_IN = R_LANE - LANE_W / 2
box('U02-ISLAND-WALL', 'wall', half(R_IN - 0.25, R_IN), Z_B2, Z_B1 + 1.1, TEAL, '반원 섬의 청록색 낮은 벽(사진 03). 높이 1.1 m 추정', grade='확정(있음·색), 추정(치수)')
box('U02-ISLAND-STRIPE', 'wall', half(R_IN, R_IN + 0.06), Z_B2, Z_B1 + 0.25, STRIPE, '섬 벽 밑의 노랑·검정 줄무늬 띠(사진 03). 노랑 한 색으로 그림', grade='확정(있음), 추정(치수)')
box('U02-RAMP-OUTER-WALL', 'wall', half(R_LANE + LANE_W / 2, R_LANE + LANE_W / 2 + 0.2, 0.35, np.pi), Z_B2, Z_B1 + 0.9, TEAL, '굽은 구간 바깥 낮은 벽(사진 03 왼쪽의 청록 벽). 치수 추정', grade='확정(있음·색), 추정(치수)')
for side, off in (('W', -LANE_W / 2 - 0.1), ('E', LANE_W / 2 + 0.1)):
    a, b = W0 + e * off, RB + e * off
    feat(f'U02-RAMP-SIDEWALL-{side}', 'wall', 'extrude', LineString([a, b]).buffer(0.1, cap_style=2), '확정(양옆 낮은 벽: 사진 04), 추정(치수)', '곧은 구간 옆벽: 경사로 윗면 + 0.9 m', basePlane='U02-VOID-B2 바닥', material='concrete', inVoid=True, color='#3c6f78',
         topProfile={'origin': [r2(a[0]), r2(a[1])], 'direction': [float(w[0]), float(w[1])], 'points': [[0.0, r2(z_at(L_ARC) + 0.9)], [L_STRAIGHT, r2(Z_B2 + 0.9)]]}, bottomM=Z_B2)

# 사람 통로의 빈 곳: 혜인관 계단 발치 ~ 주차장(운동장 슬래브 가장자리 밑), 은주1관 북쪽 끝 옆 계단(주차장 ~ 운동장 슬래브 밑)
hy = LineString([H_BOT, H_OUT]).buffer(1.2, cap_style=2).intersection(FIELD).difference(INNER.buffer(-0.3))
feat('U02-VOID-HYEIN-PASSAGE', 'void', 'void', hy, '확정(혜인관 안 계단으로 내려와 주차장으로 나온다: 사용자, 안내 글), 추정(자리·크기)', f'혜인관 계단 발치에서 주차장으로 나오는 문 자리: 폭 2.4 m, {Z_B1}~{Z_B1 + 2.4:.1f} m', fromM=Z_B1, toM=r2(Z_B1 + 2.4), name='혜인관 쪽 통로')
st = LineString([SBN, ST]).buffer(1.1, cap_style=2).intersection(FIELD.buffer(-0.3))
feat('U02-VOID-FIELD-STAIR', 'void', 'void', st, '원천(은주관 문 오른쪽 계단으로 운동장에 바로 올라간다: 학교 안내 글), 추정(자리·크기)', f'은주1관 문 오른쪽 계단의 계단실: 폭 2.2 m, {Z_B1} m 에서 운동장 슬래브 밑({Z_FIELD - 0.7:.1f} m)까지. 계단 단과 운동장 위의 출입구 덮개는 만들지 않음', fromM=Z_B1, toM=r2(Z_FIELD - 0.7), name='운동장 계단')

# 기둥(8 m 격자, 주차 줄 방향 = 혜인관 벽과 나란한 북동–남서)과 색 띠, 주차 줄 선
U, V = ht, np.array([-ht[1], ht[0]]); c = np.array(INNER.centroid.coords[0]); GRID = 8.0; cols = 0
ramp_zone = unary_union([half(0.0, R_LANE + LANE_W / 2 + 0.6), LineString([W0, RB]).buffer(LANE_W / 2 + 0.8, cap_style=2)])
lanes = unary_union([ramp_zone, LineString([E0, W1, J0, E1, S0]).buffer(4.0), LineString([S0, C1]).buffer(3.6), LineString([RB, K2, C2]).buffer(3.6), LineString([H_BOT, H_OUT, PV1, PV2, J0]).buffer(1.6), LineString([J0, SBN, DOOR]).buffer(1.6), LineString([SBN, ST]).buffer(1.6)])
BANDS = ['#2f6fb5', '#e0b400', '#3f9a4a', '#c8402f']
sq_at = lambda p, h: Polygon([p + U * a + V * b for a, b in ((-h, -h), (h, -h), (h, h), (-h, h))])
for i in range(-14, 15):
    for j in range(-14, 15):
        p = c + U * (i * GRID + 4.0) + V * (j * GRID); sq = sq_at(p, 0.3)
        if not INNER.buffer(-1.5).contains(sq) or lanes.intersects(sq): continue
        cols += 1
        box(f'U02-COLUMN-{cols:03d}', 'wall', sq, Z_B2, C_B1, '#b9b6ad', f'네모 콘크리트 기둥 0.6 m, {GRID:.0f} m 격자(자리·간격 추정). 지하 2층 바닥에서 지하 1층 천장까지', grade='확정(네모 콘크리트 기둥·색 띠: 사진 03·04), 추정(자리)', basePlane='U02-VOID-B2 바닥')
        for lv, z in (('B1', Z_B1), ('B2', Z_B2)): box(f'U02-COLUMN-{cols:03d}-BAND-{lv}', 'wall', sq_at(p, 0.33), z + 1.0, z + 1.8, BANDS[j % 4], '기둥의 색 띠(사진: 파랑·노랑·초록·빨강). 줄마다 한 색으로 둠(추정)')
rows = 0
for j in range(-14, 15):
    o = c + V * (j * GRID + 4.0); strip = LineString([o - U * 200, o + U * 200]).buffer(0.08, cap_style=2).intersection(INNER.buffer(-3.0)).difference(lanes.buffer(1.0))
    for g in (strip.geoms if hasattr(strip, 'geoms') else [strip]):
        if g.is_empty or g.area < 1.0: continue
        rows += 1
        for lv, z in (('B1', Z_B1), ('B2', Z_B2)): box(f'U02-BAYLINE-{rows:03d}-{lv}', 'wall', g, z, z + 0.03, '#e8e6dc', '주차 줄의 가운데 선(학교 지도: 주차 줄이 북동–남서 방향). 칸마다의 선은 그리지 않음, 자리 추정', grade='원천(줄 방향), 추정(자리)')

out = {'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'provenance': {'script': 'docs/audit/u02/build_parts.py', 'note': '운동장 슬래브 기단(Z02-PLATFORM-FIELD 등) 안의 빈 곳과 그 안의 상자. inside 가 없는 빈 곳은 겹치는 모든 기단에서 비운다. U01 의 것을 대신한다'}, 'features': FEATS}
(STR / 'u01-field-basement.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
pt = lambda p, z: {'xy': [r2(p[0]), r2(p[1])], 'z': r2(z)}
arc_pts = [pt(arc(R_LANE, t), z_at(R_LANE * t)) for t in np.linspace(0, np.pi, 10)[1:-1]]
model = {'heights': {'field': Z_FIELD, 'b1Floor': Z_B1, 'b1FloorRange': [140.1, 141.7], 'b1Ceiling': C_B1, 'b1SlabM': SLAB_B1, 'b2Ceiling': C_B2, 'b2Floor': Z_B2, 'solidAboveB1M': r2(Z_FIELD - C_B1), 'platformBottom': r2(Z_B2 - BASE), 'userLines': [144.4, 140.1, 133.0]},
         'areaM2': r2(INNER.area), 'fieldAreaM2': r2(FIELD.area), 'u01AreaM2': 8072.05, 'mapOutlineAreaM2': r2(MAPPOLY.area), 'mapOutlineOverlap': r2(MAPPOLY.intersection(INNER).area / MAPPOLY.union(INNER).area),
         'northWallInsetM': [r2(FIELD.exterior.distance(Point(NL0 + dn * s))) for s in (10, 30, 50)], 'columns': cols, 'bayRows': rows, 'georefRmsM': RES,
         'approach': {'from': pt(P0, Z_P0), 'entry': pt(E0, Z_B1), 'lengthM': r2(L_APP), 'gradePct': r2(GRADE_APP * 100), 'surfaceAboveFloorUnderWayM': [min(covers), max(covers)], 'widthM': ROAD_W,
                      'wall': pt(W1, Z_B1), 'junction': pt(J0, Z_B1), 'linkM': r2(np.hypot(*(W1 - E0)) + np.hypot(*(J0 - W1))), 'bendDeg': r2(np.degrees(np.arccos(np.dot(D, (W1 - E0) / np.hypot(*(W1 - E0)))))), 'mapEndOffM': r2(np.hypot(*(W1 - MAP_END)))},
         'ramp': {'top': pt(S0, Z_B1), 'curveEnd': pt(W0, z_at(L_ARC)), 'bottom': pt(RB, Z_B2), 'arc': arc_pts, 'center': [r2(CC[0]), r2(CC[1])], 'laneRadiusM': R_LANE, 'laneWidthM': LANE_W, 'arcM': r2(L_ARC), 'straightM': L_STRAIGHT, 'lengthM': r2(L_RAMP), 'dropM': r2(DROP), 'gradePct': r2(GRADE_RAMP * 100), 'openingStraightM': r2(OPEN_L),
                  'mapSymbolOffM': r2(min(np.hypot(*(CC - np.array(q))) for q in GEO['xy']['rampSymbol']))},
         'points': {'E1': pt(E1, Z_B1), 'C1': pt(C1, Z_B1), 'C2': pt(C2, Z_B2), 'K2': pt(K2, Z_B2), 'DOOR': pt(DOOR, Z_B1), 'SBN': pt(SBN, Z_B1), 'ST': pt(ST, Z_FIELD)},
         'hyein': {'door': pt(HD, Z_HB1), 'l0': pt(H_L0, Z_HB1), 'f1': pt(H_F1, Z_HMID), 'l1': pt(H_L1, Z_HMID), 'bottom': pt(H_BOT, Z_B1), 'out': pt(H_OUT, Z_B1), 'via': [pt(PV1, Z_B1), pt(PV2, Z_B1)], 'dropM': r2(Z_HB1 - Z_B1), 'mapDotOffM': r2(np.hypot(*(HD - np.array(GEO['xy']['dots']['혜인관']))))},
         'eunju': {'doorMapDotOffM': r2(np.hypot(*(DOOR - DOT))), 'stairRiseM': r2(Z_FIELD - Z_B1), 'stairRunM': r2(np.hypot(*(ST - SBN)))}}
(HERE / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps(model, ensure_ascii=False)); print(len(FEATS), 'features')
