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
INNER_U08 = FIELD.buffer(-WALL, join_style=2).intersection(south).difference(BLD.buffer(0.5)).buffer(0)   # U02~U08 의 평면(운동장 외곽·건물 외곽 안에 가둔 것). 견줌에만 쓴다
MAPPOLY = Polygon(GEO['xy']['parking'])
# U09(사용자 지시 2026-10-12 "운동장의 형상을 반드시 따르지 않아도 되지 않을까?"): 지하층 평면 = 학교 지하도 지도의 밝은 사다리꼴 그대로. 운동장 외곽·건물 외곽으로 자르지 않는다(지하층은 건물 가장자리 밑과 운동장 밖으로 나갈 수 있다).
#   빈 곳은 단면에서만 기단을 비운다(지형 칸·기단 윗면·건물은 그대로: docs/audit/g02/STRUCTURES.md). 운동장 슬래브 기단은 손대지 않는다
INNER = MAPPOLY.buffer(0)
assert INNER.geom_type == 'Polygon', INNER.geom_type

# ---------- 지하 차도: 내리막길 밑(U01 의 선 그대로) → 운동장 서쪽 벽 → 주차장 북서 모서리 ----------
P0 = np.array([201100.3, 557327.58]); Z_P0 = 136.39
# U05(사용자 2026-10-12 "지하차도에서 일직선으로 빠지는 곳", 붉은 선 그림 07): 본관 옆 구간의 위 끝(P0)에서 주차장 안까지 한 직선.
#   방향 = P0 를 지나면서 사용자 붉은 선 1(띄운 지하 2층 화면을 판 외곽으로 좌표에 맞춰 읽음, docs/audit/u05/strokes.json)에 가장 잘 맞는 직선. 내리막길 방향(WP)과 2.9도, 본관 옆 구간과 4.1도 다르다.
#   그 직선의 폭 7.2 m 띠가 운동장 서쪽 벽을 지나 주차장 북서 모서리에 남쪽 가장자리를 대고 들어온다(꺾임 없음). 띠가 옛 북쪽 변 밖으로 나가는 삼각형은 지하 1층 평면에 더한다(목).
D_WAY = np.array(WP['direction']); D_WAY = D_WAY / np.hypot(*D_WAY)
D = np.array([0.87402234, -0.48588573]); D = D / np.hypot(*D); NRM = np.array([-D[1], D[0]])   # NRM = 축의 왼쪽(북)
hit = LineString([P0, P0 + D * 200]).intersection(FIELD.buffer(-WALL, join_style=2)); hit = hit if hit.geom_type == 'LineString' else max(hit.geoms, key=lambda g: g.length)
E0 = np.array(hit.coords[0]); L_APP = float(np.hypot(*(E0 - P0))); GRADE_APP = (Z_B1 - Z_P0) / L_APP
LANE_L = 97.4                           # 곧은 차로의 길이(들머리에서): 사용자 붉은 선 1 의 끝(동쪽 한 줄 앞)
LANE_END = E0 + D * LANE_L
J0 = E0 + D * 14.0                      # 통로 면에 닿는 노드(들머리에서 14 m, 축 위)
MAP_END = np.array(GEO['xy']['carriageway'][-1]); MAP_NW = np.array(GEO['xy']['parking'][0])
THROAT = LineString([E0 - D * 0.3, E0 + D * 70]).buffer(ROAD_W / 2, cap_style=2).intersection(FIELD.buffer(-WALL, join_style=2)).difference(BLD.buffer(0.5))
INNER_OLD = INNER
INNER = INNER.union(THROAT).buffer(0.3, join_style=2).buffer(-0.3, join_style=2).buffer(0)   # 지하 1층 평면 = 옛 평면 + 목. 띠와 옛 모서리 사이의 0.6 m 안 되는 실금은 메운다
assert INNER.geom_type == 'Polygon', INNER.geom_type
LANE = LineString([E0, LANE_END]).buffer(ROAD_W / 2, cap_style=2)
assert INNER.buffer(0.01).contains(LANE.intersection(FIELD.buffer(-WALL - 0.01, join_style=2))) or LANE.difference(INNER).area < 1.0, LANE.difference(INNER).area

# ---------- 서쪽 벽 기준 축, 층 사이 경사로(U07: 학교 지하도 지도의 부채꼴, 사용자 표시 3, 사진 03·04·11·13·14·15) ----------
WA, WB = np.array([201140.1, 557255.5]), np.array([201146.2, 557293.5])   # 운동장 서쪽 변(은주1관 벽)
w = (WB - WA) / np.hypot(*(WB - WA)); e = np.array([w[1], -w[0]])           # w = 북, e = 동(안쪽)
ws_ = lambda s_, x_: WA + w * s_ + e * x_                                   # 서쪽 벽 좌표(s = 벽을 따라 북으로, x = 벽에서 안쪽으로) → 좌표
# U08(사용자 확정 2026-10-12 "딱 그냥 ㄴ자야"): 층 사이 경사로의 평면은 ㄴ자다. 곧은 다리 둘이 직각으로 만나고, 학교 지도의 굽은 부채꼴(docs/audit/u07/crescent.json)은 그 모서리의 굽은 부분이다(부채꼴 자리는 그대로).
#   두 다리는 주차 줄 격자에 맞춘다(구조물의 축): 북쪽 다리 = 주차 줄 방향(북동), 남쪽 다리 = 그 직각(남동). 가운데 선은 부채꼴과 같은 원을 90도 돌고 양 끝에서 접선으로 곧게 나간다.
#   (부채꼴 두 끝의 접선은 방위 51도·131도로 80도를 이룬다. 서쪽 벽(9도)을 따라가는 다리와 주차 줄(31도)에 나란한 다리는 22도 또는 158도라 ㄴ자가 되지 않는다. 그래서 줄 격자의 31도·121도로 두었다: 접선과 20도·10도 차)
#   내려가는 방향(추정): 남쪽 다리의 먼 끝이 머리(지하 1층 바닥, 과속방지턱) → 모서리(부채꼴) → 부채꼴 북쪽 끝의 낮은 벽 밑 → 북쪽 다리(지하 1층 바닥 아래) → 지하 2층. 확정된 것은 "낮은 벽 밑이 낮은 쪽"뿐이다.
#   U07 의 "같은 원을 260도까지 더 도는 구간 + 곧은 구간", U06 의 되도는 고리, U05 의 두 차로는 없다.
# U09: ㄴ자의 두 다리를 서쪽 벽에 맞춘다(주차 줄 격자가 아니라). 서쪽 벽 = 새 평면(학교 지도)의 서쪽 변. 북쪽 다리 = 벽과 나란히(북), 남쪽 다리 = 벽의 직각(동, 주차장 안쪽).
#   가운데 선은 부채꼴과 같은 원을 90도 돌고 양 끝에서 접선으로 곧게 나간다. 북쪽 다리의 첫 구간(낮은 벽 앞)과 굽은 구간·남쪽 다리는 위가 트이고, 낮은 벽부터는 지하 1층 바닥 아래다(은주관 문 앞 바닥 밑을 지난다).
MW0, MW1 = np.array(GEO['xy']['parking'][1]), np.array(GEO['xy']['parking'][0]); lN = (MW1 - MW0) / np.hypot(*(MW1 - MW0)); lS = np.array([lN[1], -lN[0]])   # lN = 서쪽 벽을 따라 북, lS = 벽에서 직각으로 안쪽(동)
DOOR_NODE = np.array([201146.21, 557283.45]); S_DOOR = float((DOOR_NODE - WA) @ w)
ha, hb = np.array([201200.7, 557180.9]), np.array([201246.0, 557255.8]); ht = (hb - ha) / np.hypot(*(hb - ha)); hn = np.array([ht[1], -ht[0]])   # 혜인관 운동장 쪽 벽: ht = 주차 줄 방향(북동), hn = 혜인관 쪽(남동)
CR = json.loads((HERE.parent / 'u07' / 'crescent.json').read_text(encoding='utf-8'))
CC = np.array(CR['centre']); R_OUT, R_IN = CR['outerRadiusM'], CR['innerRadiusM']; R_C = (R_OUT + R_IN) / 2; LANE_W = R_OUT - R_IN
B_S, B_N = CR['bearingSouthEndDeg'], CR['bearingNorthEndDeg']               # 중심에서 본 두 끝의 방위(북 0, 시계 방향)
pol = lambda r, b: CC + r * np.array([np.sin(np.radians(b)), np.cos(np.radians(b))])
B_ROW = float(np.degrees(np.arctan2(ht[0], ht[1]))); B_WALL = float(np.degrees(np.arctan2(lN[0], lN[1])))
B_A, B_B = B_WALL + 180, B_WALL + 270   # 가운데 선이 도는 범위(시계 방향으로 돌 때 진행 방향 = 방위 + 90): 남쪽 다리의 끝(진행 방향 = 벽 쪽, 서) ~ 북쪽 다리의 머리(진행 방향 = 벽과 나란히, 북)
assert B_A < B_S < B_B < B_N, (B_A, B_S, B_B, B_N)
LEG_S, LEG_N, LANE_W_S = 11.5, 29.1, 5.0   # 추정: 남쪽 다리(위가 트임. 머리가 긴 줄 S07·S08 사이 통로에 닿는 길이)·북쪽 다리의 길이, 한 차로 폭(사진 04)
DROP = Z_B1 - Z_B2; L_ARC = float(np.radians(B_B - B_A) * R_C); L_VIS = float(np.radians(B_N - B_S) * R_C); L_RAMP = LEG_S + L_ARC + LEG_N; G_RAMP_PCT = DROP / L_RAMP   # 한 경사. 높이 차 8.4 m 는 줄이지 않는다
assert G_RAMP_PCT <= 0.1505, G_RAMP_PCT
z_at = lambda s: Z_B1 - G_RAMP_PCT * s                                       # 경사로 가운데 선을 따라 잰 길이 → 높이
A0, B0 = pol(R_C, B_A), pol(R_C, B_B); T0 = A0 + lS * LEG_S; RB = B0 + lN * LEG_N   # 굽은 구간의 두 끝, 머리(남쪽 다리의 먼 끝), 발치(북쪽 다리의 먼 끝)
T_BAND = float(R_OUT * np.sin(np.radians(B_N - B_B))); NB = B0 + lN * T_BAND; S_BAND = LEG_S + L_ARC + T_BAND; Z_BAND = z_at(S_BAND)   # 낮은 벽(부채꼴 북쪽 끝 변)이 북쪽 다리의 가운데 선을 지나는 곳
sector_pre = lambda b0, b1: Polygon([pol(R_OUT + 0.25, b) for b in np.linspace(b0, b1, 30)] + [pol(R_IN, b) for b in np.linspace(b1, b0, 30)])
def sector(r0, r1, b0, b1, n=None):
    bb = np.linspace(b0, b1, n or max(2, int(abs(b1 - b0) / 2.5) + 1)); return Polygon([pol(r1, b) for b in bb] + [pol(r0, b) for b in bb[::-1]])
CRESCENT = sector(R_IN, R_OUT, B_S, B_N)
ISL_FLAT = -1.2                          # 섬의 곧은 변: 중심에서 혜인관 쪽으로 잰 거리(주차 줄 S04 의 동쪽 끝 선). 섬 = 안쪽 원에서 이 선의 서쪽
ISLAND = Polygon([CC] + [pol(R_IN, b) for b in np.linspace(B_A, B_B, 19)] + [B0 + lS * (R_C - R_IN) + lN * T_BAND, CC + lN * T_BAND])   # 섬 = 굽은 구간과 북쪽 다리 첫 구간의 안쪽(낮은 벽 뒤)
INNER_B2 = INNER_OLD                     # 지하 2층 평면 = 지도의 사다리꼴(목 없음)
C1, C2 = np.array([201200.0, 557245.0]), np.array([201185.0, 557250.0])     # 종착 표지 자리(U01 그대로, 추정)

# ---------- 사람 길 ----------
DOT = np.array(GEO['xy']['dots']['은주1관 북서(3층)'])
DOOR = WA + w * (DOT[1] - WA[1]) / w[1] + e * 1.6        # 은주1관 3층 문: 지도의 초록 점을 서쪽 벽에 붙임
SBN = DOOR + w * 4.5 + e * 0.6                           # 문 오른쪽(북쪽) 계단 발치
ST = np.array([201150.5, 557299.5])                      # 운동장 위 끝(추정): 은주1관 북쪽 끝 옆, 주차장 북쪽 벽 바깥
HD = np.array([201218.7, 557213.7])                      # 혜인관 입구(1) 문 노드(운동장 높이 = 혜인관 지하 1층 149.3)
H_L0, H_F1 = HD + hn * 3.0, HD + hn * 11.0; H_L1 = H_F1 + ht * 1.8; H_BOT = HD + hn * 3.0 + ht * 1.8
Z_HB1 = 149.3; Z_HMID = r2((Z_HB1 + Z_B1) / 2)
H_OUT = H_BOT - hn * 6.5                                 # 계단 발치에서 벽을 지나 주차장 안으로
PV1, PV2 = np.array([201203.0, 557247.0]), np.array([201170.0, 557285.0])   # 보행 동선이 지하 1층 차로 둘을 건너지 않고 돌아가는 점(주차 자리 동쪽, 들머리 차로 북동쪽)
for name, p in (('L0', H_L0), ('F1', H_F1), ('L1', H_L1), ('BOT', H_BOT)): assert HYEIN.contains(Point(p)), name
for name, p in (('J0', J0), ('T0', T0), ('A0', A0), ('B0', B0), ('NB', NB), ('RB', RB), ('C1', C1), ('C2', C2), ('DOOR', DOOR), ('SBN', SBN), ('H_OUT', H_OUT)): assert INNER.contains(Point(p)), (name, p)
assert INNER_OLD.buffer(-0.5).contains(sector_pre(B_A, B_B)), '굽은 구간이 주차장 평면 밖으로 나간다'
assert FIELD.contains(Point(ST)) and not INNER_OLD.contains(Point(ST))
CLIP_BLD = LineString([P0, LANE_END]).buffer(ROAD_W / 2, cap_style=2).intersection(BLD).area   # U05: 띠의 남쪽 가장자리가 은주1관 북동 모서리를 스친다(지도에서 지하 차도가 닿는 그 모서리). 그 조각은 빈 곳에서 뺀다
assert CLIP_BLD < 1.0, CLIP_BLD

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
feat('U02-VOID-B1', 'void', 'void', INNER, G_LEVEL, f'운동장 지하 1층: 바닥 {Z_B1} m(범위 140.1~141.7), 천장 {C_B1} m(사용자 윗선). 그 위 {C_B1}~{Z_FIELD} m 는 빈 층 없이 구조. 평면은 학교 지하도 지도의 사다리꼴 그대로(U09: 운동장 외곽·건물 외곽으로 자르지 않음. 운동장 밖 {sum(q.area for q in INNER.difference(FIELD).geoms) if hasattr(INNER.difference(FIELD), "geoms") else INNER.difference(FIELD).area:.0f} ㎡) + 북서 모서리의 지하 차도 목 {INNER.area - INNER_OLD.area:.0f} ㎡(U05: 지하 차도가 꺾이지 않고 들어오는 폭 {ROAD_W} m 띠가 옛 북쪽 변 밖으로 나가는 부분)', fromM=Z_B1, toM=C_B1, name='운동장 지하 1층')
feat('U02-VOID-B2', 'void', 'void', INNER_B2, G_LEVEL, f'운동장 지하 2층: 바닥 {Z_B2} m(사용자 아랫선 ±1), 천장 {C_B2} m = 지하 1층 바닥 구조({SLAB_B1} m) 밑. 평면은 학교 지하도 지도의 사다리꼴(목 없음)', fromM=Z_B2, toM=C_B2, name='운동장 지하 2층')

# 지하 차도 연장(내리막길 밑, U01 의 선) + 운동장 북쪽 띠를 지나 주차장으로 들어가는 평평한 통로
n = int(np.ceil((L_APP + WALL + 0.5) / 1.0)); step = (L_APP + WALL + 0.5) / n; covers = []
for k in range(n):
    a, b = k * step, (k + 1) * step; za, zb = (min(Z_B1, Z_P0 + GRADE_APP * s) for s in (a, b)); mid = P0 + D * (a + b) / 2
    seg = LineString([P0 + D * a, P0 + D * b]).buffer(ROAD_W / 2, cap_style=2).difference(BLD.buffer(0.3)); under = WAY.contains(Point(mid))
    top = r2(min(zb + CLEAR, min(way_top(*(P0 + D * a)), way_top(*(P0 + D * b))) - ROOF)) if under else r2(zb + CLEAR)
    top = min(top, C_ROAD)
    if under: covers.append(r2(way_top(*mid) - (za + zb) / 2))
    for side, off in (('N', ROAD_W / 2 - 0.06), ('S', -ROAD_W / 2 + 0.06)):   # U06: 벽면의 청록·짙은 회색 세로 줄무늬(2 m 마다 바뀜)와 벽 밑 노랑 턱(사진 08·09). 벽 안쪽 면에 얇은 판으로
        pa, pb = P0 + D * a + NRM * off, P0 + D * b + NRM * off; wl = LineString([pa, pb]).buffer(0.05, cap_style=2).difference(BLD.buffer(0.3))
        if wl.is_empty or wl.area < 0.02: continue
        box(f'U06-ROADWALL-{side}-{k:02d}', 'wall', wl, za, top, '#2f7f86' if (k // 2) % 2 == 0 else '#39424a', '지하 차도 벽면의 청록·짙은 회색 세로 줄무늬(사진 08·09). 줄 너비 추정', grade='확정(색·줄무늬: 사진 08·09), 추정(줄 너비·자리)')
        kb = LineString([pa - NRM * np.sign(off) * 0.12, pb - NRM * np.sign(off) * 0.12]).buffer(0.07, cap_style=2).difference(BLD.buffer(0.3))
        if not kb.is_empty and kb.area > 0.02: box(f'U06-ROADKERB-{side}-{k:02d}', 'wall', kb, za, zb + 0.22, '#d8b000' if k % 2 == 0 else '#2a2a2a', '벽 밑 노랑·검정 턱(사진 08)', grade='확정(있음: 사진 08·09), 추정(치수)')
    feat(f'U02-VOID-ROAD-{k:02d}', 'void', 'void', seg, '확정(지하 차도가 지하 1층으로 들어온다: 사용자가 단면 그림대로라고 함), 추정(선·폭)', f'지하 차도 연장 {a:.0f}~{b:.0f} m: 바닥 {za:.2f} → {zb:.2f} m (경사 {GRADE_APP * 100:.1f} %), 폭 {ROAD_W} m', fromM=r2(za), toM=top, name='지하 차도')
# U05 목(들머리): 벽을 지나는 자리의 문틀(양쪽 기둥과 위 보). 빈 곳은 위의 지하 차도 마디와 지하 1층 평면(목 포함)이 이어져 있다
G_THROAT = '확정(지하 차도가 곧게 들어오는 곳이 북서 모서리에 있다: 사용자 2026-10-12), 사용자 그림(위치: 붉은 선 1), 추정(치수·모양)'
for side, off in (('N', ROAD_W / 2 + 0.3), ('S', -ROAD_W / 2 - 0.3)):
    c0 = E0 + NRM * off; box(f'U05-THROAT-JAMB-{side}', 'wall', Polygon([c0 + D * a + NRM * b for a, b in ((-0.5, -0.3), (0.7, -0.3), (0.7, 0.3), (-0.5, 0.3))]), Z_B1, C_B1, '#2f7f86', '지하 차도 들머리 문틀 기둥(청록, 사진 09 의 벽 색). 치수 추정', grade=G_THROAT)
box('U05-THROAT-LINTEL', 'wall', Polygon([E0 + D * a + NRM * b for a, b in ((-0.5, -ROAD_W / 2 - 0.6), (0.7, -ROAD_W / 2 - 0.6), (0.7, ROAD_W / 2 + 0.6), (-0.5, ROAD_W / 2 + 0.6))]), C_B1 - 0.4, C_B1, '#3c6f78', '지하 차도 들머리 위 보. 치수 추정', grade=G_THROAT)
for side, off in (('N', ROAD_W / 2 - 0.1), ('S', -ROAD_W / 2 + 0.1)):   # 벽 밑 노랑 턱 띠(사진 08·09): 목의 첫 12 m
    box(f'U05-THROAT-KERB-{side}', 'wall', LineString([E0 + NRM * off, E0 + NRM * off + D * 12.0]).buffer(0.1, cap_style=2), Z_B1, Z_B1 + 0.25, '#d8b000', '벽 밑 노랑·검정 턱(사진 08·09). 노랑 한 색으로 그림', grade='확정(있음: 사진), 추정(자리·치수)')

# U07: 곧은 차로의 짙은 바닥은 주차 칸을 알아야 해서 u04/build.py 가 그린다(U07-THROUGH-LANE-FLOOR). U06 의 갈림 구조물(가운데 기둥·표지·신호등·둥근 벽·파란 기둥 줄)은 없앴다: 사진 09 의 자리가 지도·사진에서 나오지 않는다

# U08 층 사이 경사로(ㄴ자): 남쪽 다리(위가 트임) + 굽은 구간(부채꼴) + 북쪽 다리(낮은 벽부터 지하 1층 바닥 아래). 기운 윗면의 상자들, 아래는 지하 2층 바닥까지 채움
G_RAMP = f'확정(평면이 ㄴ자: 사용자 2026-10-12), 원천(모서리 자리: 학교 지도의 굽은 부채꼴, 좌표 맞춤 잔차 RMS {RES} m), 확정(낮은 벽이 은주관 문 쪽·그 밑이 낮은 쪽: 사용자 표시 3), 사용자 그림(북쪽 다리가 서쪽 벽·문 쪽: 붉은 화살표), 추정(다리 길이·내려가는 방향·경사)'
LEG_S_RECT = LineString([T0, A0]).buffer(LANE_W_S / 2, cap_style=2); LEG_N_RECT = LineString([B0, RB]).buffer(LANE_W_S / 2, cap_style=2)
assert INNER_OLD.buffer(-0.5).contains(LEG_S_RECT) and INNER_OLD.buffer(-0.5).contains(LEG_N_RECT), '다리가 주차장 평면 밖으로 나간다'
WALL_GAP = float((B0 - MW0) @ lS) - LANE_W_S / 2   # 북쪽 다리의 서쪽 가장자리 ~ 서쪽 벽
LANE_GAP = LEG_N_RECT.distance(LANE); assert LANE_GAP > 1.0, LANE_GAP        # 북쪽 다리는 곧은 차로(U05)의 띠에 닿지 않는다
OPEN_S = LineString([T0, A0]).buffer(LANE_W_S / 2 + 0.2, cap_style=2)        # 남쪽 다리 위의 구멍(옆벽까지)
OPEN_N = LineString([B0, NB]).buffer(LANE_W_S / 2 + 0.2, cap_style=2)        # 북쪽 다리의 첫 구간(낮은 벽 앞) 위의 구멍
opening = unary_union([sector(R_IN, R_OUT, B_A, B_B), OPEN_S, OPEN_N]).buffer(0.02, join_style=2).buffer(-0.02, join_style=2)
assert opening.geom_type == 'Polygon', opening.geom_type
N_ARC = 9; bs = np.linspace(B_A, B_B, N_ARC + 1); segs = [(T0, A0, 0.0, LEG_S, LEG_S_RECT, f'남쪽 다리 {LEG_S} m(위가 트임: 지하 1층 바닥에서 내려간다)', True)]
for k in range(N_ARC):
    b0, b1 = bs[k], bs[k + 1]; s0, s1 = LEG_S + np.radians(b0 - B_A) * R_C, LEG_S + np.radians(b1 - B_A) * R_C
    segs.append((pol(R_C, b0), pol(R_C, b1), s0, s1, sector(R_IN, R_OUT, b0, b1, 5), f'굽은 구간(모서리, 학교 지도의 부채꼴) {s0 - LEG_S:.1f}~{s1 - LEG_S:.1f} m', True))
LN_OPEN = LineString([B0, NB]).buffer(LANE_W_S / 2, cap_style=2)
segs.append((B0, RB, LEG_S + L_ARC, L_RAMP, LN_OPEN, f'북쪽 다리의 첫 {T_BAND:.1f} m(서쪽 벽과 나란히, 위가 트임. 낮은 벽 앞)', True))
segs.append((B0, RB, LEG_S + L_ARC, L_RAMP, LineString([NB, RB]).buffer(LANE_W_S / 2, cap_style=2), f'북쪽 다리 {LEG_N} m(서쪽 벽과 나란히. 낮은 벽부터 지하 1층 바닥 아래, 은주관 문 앞 바닥 밑). 전체 {L_RAMP:.1f} m 에 {DROP:.1f} m, 경사 {G_RAMP_PCT * 100:.1f} %', False))
def prof(a, b, s0, s1, up=0.0): d = (b - a) / np.hypot(*(b - a)); return {'origin': [r2(a[0]), r2(a[1])], 'direction': [float(d[0]), float(d[1])], 'points': [[0.0, r2(z_at(s0) + up)], [r2(np.hypot(*(b - a))), r2((z_at(s1) if s1 < L_RAMP - 1e-6 else Z_B2 + 0.02) + up)]]}
GUIDE = '#e3b505'
for k, (a, b, s0, s1, poly, what, seen) in enumerate(segs):
    feat(f'U08-RAMP-SEG-{k:02d}', 'ramp', 'extrude', poly, G_RAMP, f'{what}: {z_at(s0):.2f} → {z_at(s1):.2f} m', basePlane='U02-VOID-B2 바닥', material='concrete', inVoid=True, color='#9a9892', topProfile=prof(a, b, s0, s1), bottomM=Z_B2, openAbove=seen)
    # 경사로 바닥의 노란 유도선(사진 04·11): 가운데 선을 따라 얇은 기운 판
    gl = (sector(R_C - 0.12, R_C + 0.12, bs[k - 1], bs[k], 5) if 1 <= k <= N_ARC else LineString([a, b]).buffer(0.12, cap_style=2)).intersection(poly.buffer(0.01))
    if not gl.is_empty and gl.area > 0.05: feat(f'U08-RAMP-GUIDE-{k:02d}', 'wall', 'extrude', gl, '확정(유도선이 있다: 사진 04·11), 추정(자리)', '경사로 가운데의 노란 유도선', material='concrete', inVoid=True, color=GUIDE, topProfile=prof(a, b, s0, s1, 0.05), thicknessM=0.05, openAbove=seen)
RAMP_FOOT = unary_union([sg[4] for sg in segs]).buffer(0.01)
feat('U02-VOID-RAMP-OPENING', 'void', 'void', opening, f'원천(모서리 = 학교 지도의 부채꼴, 잔차 RMS {RES} m), 확정(아래층이 보인다: 사진 03·11, 곧은 경사로가 주차 칸 옆에서 트여 있다: 사진 04), 추정(두 다리의 범위)', f'경사로 위로 지하 1층 바닥을 틔운 곳 = 굽은 구간(지도의 부채꼴과 같은 원의 90도) + 남쪽 다리({LEG_S} m × {LANE_W_S + 0.4:.1f} m) + 북쪽 다리의 첫 {T_BAND:.1f} m. 합 {opening.area:.0f} ㎡, 지도의 부채꼴({CRESCENT.area:.0f} ㎡) 가운데 {opening.intersection(CRESCENT).area:.0f} ㎡ 가 겹친다. 낮은 벽 밑에서 경사로는 지하 1층 바닥보다 {Z_B1 - Z_BAND:.2f} m 아래', fromM=C_B2, toM=Z_B1, name='경사로 구멍')
TEAL, STRIPE, LOWWALL = '#2f7f86', '#d8b000', '#6f8fa3'
G_SEEN = '확정(있음·색: 사진 11·15), 원천(자리: 학교 지도의 부채꼴 가장자리), 추정(치수)'
box('U07-RAMP-OUTERWALL', 'wall', unary_union([sector(R_OUT, R_OUT + 0.25, B_A, B_B), LineString([B0 - lS * (LANE_W_S / 2 + 0.2), NB - lS * (LANE_W_S / 2 + 0.2)]).buffer(0.12, cap_style=2), LineString([B0 - lS * (R_OUT - R_C + 0.12), B0 - lS * (LANE_W_S / 2 + 0.1)]).buffer(0.12, cap_style=2)]), C_B2, C_B1, TEAL, '굽은 구간 바깥쪽과 북쪽 다리 첫 구간의 서쪽(서쪽 벽 쪽)의 청록 벽(사진 11 왼쪽, 사진 04 의 먼 끝). 바닥에서 천장까지', grade=G_SEEN)
ISL_WALL = unary_union([sector(R_IN - 0.25, R_IN, B_A, B_B), LineString([B0 + lS * (LANE_W_S / 2 + 0.2), NB + lS * (LANE_W_S / 2 + 0.2)]).buffer(0.12, cap_style=2), LineString([B0 + lS * (R_C - R_IN + 0.12), B0 + lS * (LANE_W_S / 2 + 0.1)]).buffer(0.12, cap_style=2)])
box('U02-ISLAND-WALL', 'wall', ISL_WALL, C_B2, Z_B1 + 1.1, LOWWALL, '섬의 낮은 벽(사진 11: 푸른 회색, 높이 1.1 m 추정) = 굽은 구간의 안쪽 가장자리와 북쪽 다리 첫 구간의 동쪽. 벽 뒤는 주차 줄 S04 의 남서 끝', grade=G_SEEN)
bk = np.linspace(B_A, B_B, 10)
for k in range(len(bk) - 1):   # 벽 밑의 노랑·검정 턱(노랑 한 색): 경사로 바닥을 따라 내려간다
    b0, b1 = bk[k], bk[k + 1]; zl = z_at(LEG_S + np.radians(b1 - B_A) * R_C); zh = z_at(LEG_S + np.radians(b0 - B_A) * R_C)
    box(f'U02-ISLAND-STRIPE-{k:02d}', 'wall', sector(R_IN, R_IN + 0.08, b0, b1, 4), zl, zh + 0.25, STRIPE, '섬 벽 밑의 노랑·검정 줄무늬 턱(사진 11)', grade=G_SEEN, openAbove=True)
    box(f'U07-OUTERWALL-KERB-{k:02d}', 'wall', sector(R_OUT - 0.08, R_OUT, b0, b1, 4), zl, zh + 0.2, STRIPE, '청록 벽 밑의 노랑·검정 턱(사진 11)', grade=G_SEEN, openAbove=True)
box('U06-BAND-WALL', 'wall', LineString([NB - lS * (LANE_W_S / 2 + 0.3) + lN * 0.12, NB + lS * (LANE_W_S / 2 + 0.3) + lN * 0.12]).buffer(0.12, cap_style=2), Z_B1, Z_B1 + 1.1, LOWWALL, '북쪽 다리를 가로지르는 낮은 벽(사진 15 의 붉은 네모 = 사진 14 오른쪽의 낮은 벽): 청록 벽과 섬 벽 사이, 지도의 부채꼴 북쪽 끝 높이. 북쪽 다리는 이 벽 밑으로 지하 1층 바닥 아래에 든다. 벽 북쪽은 지하 1층 바닥(문 앞 주차 칸)',
    grade='확정(있음·은주관 문 벽을 등지면 오른쪽·청록 벽과 섬 사이: 사용자 표시 3, 사진 11·15), 원천(자리: 지도의 부채꼴 북쪽 끝), 추정(치수)')
pc = NB + lS * (LANE_W_S / 2 + 0.5)
box('U07-ISLAND-PIER', 'wall', Polygon([pc + lN * a_ + lS * b_ for a_, b_ in ((-0.4, -0.4), (0.4, -0.4), (0.4, 0.4), (-0.4, 0.4))]), C_B2, C_B1, '#5f7f93', '섬 벽의 북쪽 끝과 낮은 벽이 만나는 곳의 기둥(사진 11: 푸른 회색 기둥)', grade=G_SEEN)
G_SIDE = '확정(곧은 한 차로 경사로의 양옆 낮은 벽: 사진 04), 추정(자리·치수)'
for side, off in (('N', -LANE_W_S / 2 - 0.1), ('S', LANE_W_S / 2 + 0.1)):   # 남쪽 다리 옆벽: 윗선이 평평하다(지하 1층 바닥 + 0.9 m), 밑은 경사로 바닥
    box(f'U08-LEGS-SIDEWALL-{side}', 'wall', LineString([T0 - lN * off, A0 - lN * off]).buffer(0.1, cap_style=2), Z_B2, Z_B1 + 0.9, '#3c6f78', '남쪽 다리 옆의 낮은 벽: 지하 1층 바닥 + 0.9 m. 옆은 주차 칸(긴 줄 S07 의 잘린 끝)', grade=G_SIDE)
for side, off in (('E', LANE_W_S / 2 + 0.1), ('W', -LANE_W_S / 2 - 0.1)):   # 북쪽 다리 옆벽: 경사로 윗면 + 0.9 m (지하 2층에서 보인다)
    a_, b_ = NB + lS * off, RB + lS * off
    feat(f'U08-LEGN-SIDEWALL-{side}', 'wall', 'extrude', LineString([a_, b_]).buffer(0.1, cap_style=2), G_SIDE, '북쪽 다리 옆벽: 경사로 윗면 + 0.9 m', basePlane='U02-VOID-B2 바닥', material='concrete', inVoid=True, color='#3c6f78',
         topProfile={'origin': [r2(a_[0]), r2(a_[1])], 'direction': [float(lN[0]), float(lN[1])], 'points': [[0.0, r2(Z_BAND + 0.9)], [r2(LEG_N - T_BAND), r2(Z_B2 + 0.9)]]}, bottomM=Z_B2)
# 머리 앞(지하 1층 바닥): 과속방지턱(사진 04)과 유도선
box('U08-SPEED-BUMP', 'wall', LineString([T0 + lS * 1.2 - lN * 2.6, T0 + lS * 1.2 + lN * 2.6]).buffer(0.2, cap_style=2), Z_B1, Z_B1 + 0.08, '#d8b000', '경사로 머리 앞의 과속방지턱(사진 04: 노랑·검정). 노랑 한 색, 자리 추정', grade='확정(있음: 사진 04), 추정(자리·어느 끝인지)')
gpts = [T0 + lS * 2.0 + ht * 9.0, T0 + lS * 2.0 + ht * 2.0, T0 + lS * 1.0, T0 - lS * 0.2]
box('U06-GUIDE-LINE', 'wall', LineString(gpts).buffer(0.12, cap_style=2).difference(opening.buffer(0.05)), Z_B1, Z_B1 + 0.09, GUIDE, '통로(긴 줄 S07·S08 사이)에서 경사로 머리로 꺾어 드는 바닥의 노란 유도선. 자리 추정', grade='확정(있음: 사진 04·11), 추정(자리)')

# 사람 통로의 빈 곳: 혜인관 계단 발치 ~ 주차장(운동장 슬래브 가장자리 밑), 은주1관 북쪽 끝 옆 계단(주차장 ~ 운동장 슬래브 밑)
hy = LineString([H_BOT, H_OUT]).buffer(1.2, cap_style=2).difference(INNER.buffer(-0.3)).difference(HYEIN.buffer(-0.3))   # U09: 평면이 혜인관 벽까지(일부는 벽 밑까지) 가서 통로는 벽 두께만 남는다
print('hyein passage', hy.area, 'H_BOT in plan', INNER.contains(Point(H_BOT)), INNER.exterior.distance(Point(H_BOT)), 'H_OUT', INNER.exterior.distance(Point(H_OUT)))
if hy.area > 0.3: feat('U02-VOID-HYEIN-PASSAGE', 'void', 'void', hy, '확정(혜인관 안 계단으로 내려와 주차장으로 나온다: 사용자, 안내 글), 추정(자리·크기)', f'혜인관 계단 발치에서 주차장으로 나오는 문 자리: 폭 2.4 m, {Z_B1}~{Z_B1 + 2.4:.1f} m', fromM=Z_B1, toM=r2(Z_B1 + 2.4), name='혜인관 쪽 통로')
st = LineString([SBN, ST]).buffer(1.1, cap_style=2).intersection(FIELD.buffer(-0.3)).difference(LANE.buffer(0.3))   # U05: 곧은 차로 위로는 계단실을 내지 않는다(계단은 차로 천장 144.4 m 위로 지난다)
feat('U02-VOID-FIELD-STAIR', 'void', 'void', st, '원천(은주관 문 오른쪽 계단으로 운동장에 바로 올라간다: 학교 안내 글), 추정(자리·크기)', f'은주1관 문 오른쪽 계단의 계단실: 폭 2.2 m, {Z_B1} m 에서 운동장 슬래브 밑({Z_FIELD - 0.7:.1f} m)까지. 계단 단과 운동장 위의 출입구 덮개는 만들지 않음', fromM=Z_B1, toM=r2(Z_FIELD - 0.7), name='운동장 계단')

# 기둥(8 m 격자, 주차 줄 방향 = 혜인관 벽과 나란한 북동–남서)과 색 띠, 주차 줄 선
U, V = ht, np.array([-ht[1], ht[0]]); c = np.array(INNER_OLD.centroid.coords[0]); GRID = 8.0; cols = 0
ramp_zone = unary_union([ISLAND.buffer(0.6), RAMP_FOOT.buffer(0.8)])
lanes = unary_union([ramp_zone, LineString([E0, LANE_END]).buffer(4.0), LineString([H_BOT, H_OUT, PV1, PV2, J0]).buffer(1.6), LineString([J0, SBN, DOOR]).buffer(1.6), LineString([SBN, ST]).buffer(1.6)])
BANDS = ['#3f9a4a', '#2f6fb5', '#e07a2f']   # U06: 사진 10·14 의 띠 색(초록·파랑·주황)
# U04: 주차 칸 묶음(docs/audit/u04/stalls.json)이 있으면 기둥은 두 층 모두 주차 칸 묶음 안에 드는 격자점에만 세우고(통로에는 세우지 않는다), 줄 가운데 선은 그리지 않는다(칸 선은 u04-parking.geojson)
U04 = HERE.parent / 'u04' / 'stalls.json'
STALLS = None
if U04.exists():
    u4 = json.loads(U04.read_text(encoding='utf-8')); STALLS = unary_union([Polygon(b['polygon']) for b in u4['B1']['blocks']]).intersection(unary_union([Polygon(b['polygon']) for b in u4['B2']['blocks']]))
sq_at = lambda p, h: Polygon([p + U * a + V * b for a, b in ((-h, -h), (h, -h), (h, h), (-h, h))])
for i in range(-14, 15):
    for j in range(-14, 15):
        p = c + U * (i * GRID + 4.0) + V * (j * GRID); sq = sq_at(p, 0.3)
        if not INNER_OLD.buffer(-1.5).contains(sq) or (lanes.intersects(sq) if STALLS is None else not STALLS.contains(sq)): continue
        cols += 1
        box(f'U02-COLUMN-{cols:03d}', 'wall', sq, Z_B2, C_B1, '#eceae2', f'네모 콘크리트 기둥 0.6 m, {GRID:.0f} m 격자(자리·간격 추정). 지하 2층 바닥에서 지하 1층 천장까지', grade='확정(네모 콘크리트 기둥·색 띠: 사진 03·04), 추정(자리)', basePlane='U02-VOID-B2 바닥')
        for lv, z in (('B1', Z_B1), ('B2', Z_B2)): box(f'U02-COLUMN-{cols:03d}-BAND-{lv}', 'wall', sq_at(p, 0.33), z + 1.0, z + 1.8, BANDS[j % 3], '흰 네모 기둥의 색 띠(사진 10·14: 초록·파랑·주황). 줄마다 한 색으로 둠(추정)')
rows = 0
for j in (range(-14, 15) if STALLS is None else ()):
    o = c + V * (j * GRID + 4.0); strip = LineString([o - U * 200, o + U * 200]).buffer(0.08, cap_style=2).intersection(INNER_OLD.buffer(-3.0)).difference(lanes.buffer(1.0))
    for g in (strip.geoms if hasattr(strip, 'geoms') else [strip]):
        if g.is_empty or g.area < 1.0: continue
        rows += 1
        for lv, z in (('B1', Z_B1), ('B2', Z_B2)): box(f'U02-BAYLINE-{rows:03d}-{lv}', 'wall', g, z, z + 0.03, '#e8e6dc', '주차 줄의 가운데 선(학교 지도: 주차 줄이 북동–남서 방향). 칸마다의 선은 그리지 않음, 자리 추정', grade='원천(줄 방향), 추정(자리)')

out = {'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'provenance': {'script': 'docs/audit/u02/build_parts.py', 'note': '운동장 슬래브 기단(Z02-PLATFORM-FIELD 등) 안의 빈 곳과 그 안의 상자. inside 가 없는 빈 곳은 겹치는 모든 기단에서 비운다. U01 의 것을 대신한다'}, 'features': FEATS}
(STR / 'u01-field-basement.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
def _parts(g): return [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.area > 0.5]
def _far(g, ref): return r2(max(ref.exterior.distance(Point(c)) for c in g.exterior.coords))
OUT_FIELD = _parts(INNER.difference(FIELD)); OUT_B2 = _parts(INNER_B2.difference(FIELD))
OUTLINE = {'source': '학교 지하도 지도의 사다리꼴(georef.json xy.parking) 그대로. 운동장·건물 외곽으로 자르지 않음', 'u08AreaM2': r2(INNER_U08.area), 'b2AreaM2': r2(INNER_B2.area), 'b1AreaM2': r2(INNER.area), 'throatM2': r2(INNER.area - INNER_OLD.area),
           'outsideFieldB1': [{'areaM2': r2(q.area), 'centre': [r2(q.centroid.x), r2(q.centroid.y)], 'maxBeyondFieldM': _far(q, FIELD)} for q in OUT_FIELD], 'outsideFieldB1M2': r2(sum(q.area for q in OUT_FIELD)), 'outsideFieldB2M2': r2(sum(q.area for q in OUT_B2)),
           'fieldNotCoveredM2': r2(FIELD.difference(INNER).area), 'underBuildings': {k: r2(v.intersection(INNER).area) for k, v in BLDS.items() if v.intersection(INNER).area > 0.5},
           'gainedVsU08M2': r2(INNER_B2.difference(INNER_U08).area), 'lostVsU08M2': r2(INNER_U08.difference(INNER_B2).area), 'u08Ring': [[r2(x), r2(y)] for x, y in INNER_U08.exterior.coords], 'ring': [[r2(x), r2(y)] for x, y in INNER.exterior.coords], 'fieldRing': [[r2(x), r2(y)] for x, y in FIELD.exterior.coords]}
pt = lambda p, z: {'xy': [r2(p[0]), r2(p[1])], 'z': r2(z)}
path = [pt(T0, Z_B1)] + [pt(pol(R_C, b), z_at(LEG_S + np.radians(b - B_A) * R_C)) for b in bs] + [pt(NB, Z_BAND), pt(RB, Z_B2)]
SYM = [np.array(q) for q in GEO['xy']['rampSymbol']]
model = {'heights': {'field': Z_FIELD, 'b1Floor': Z_B1, 'b1FloorRange': [140.1, 141.7], 'b1Ceiling': C_B1, 'b1SlabM': SLAB_B1, 'b2Ceiling': C_B2, 'b2Floor': Z_B2, 'solidAboveB1M': r2(Z_FIELD - C_B1), 'platformBottom': r2(Z_B2 - BASE), 'userLines': [144.4, 140.1, 133.0]},
         'areaM2': r2(INNER.area), 'areaB2M2': r2(INNER_B2.area), 'areaU02M2': r2(INNER_OLD.area), 'outline': OUTLINE, 'fieldAreaM2': r2(FIELD.area), 'u01AreaM2': 8072.05, 'mapOutlineAreaM2': r2(MAPPOLY.area), 'mapOutlineOverlap': r2(MAPPOLY.intersection(INNER).area / MAPPOLY.union(INNER).area),
         'northWallInsetM': [r2(FIELD.exterior.distance(Point(NL0 + dn * s))) for s in (10, 30, 50)], 'columns': cols, 'bayRows': rows, 'georefRmsM': RES,
         'approach': {'from': pt(P0, Z_P0), 'entry': pt(E0, Z_B1), 'lengthM': r2(L_APP), 'gradePct': r2(GRADE_APP * 100), 'surfaceAboveFloorUnderWayM': [min(covers), max(covers)], 'widthM': ROAD_W,
                      'junction': pt(J0, Z_B1), 'direction': [float(D[0]), float(D[1])], 'azimuthSouthOfEastDeg': r2(np.degrees(np.arctan2(-D[1], D[0]))), 'bendAtMouthDeg': 0.0,
                      'bendAtFromDeg': {'vsRoad951c157d': r2(np.degrees(np.arctan2(-D[1], D[0])) - np.degrees(np.arctan2(557349.2 - 557327.58, 201100.3 - 201053.9))), 'vsWayDirection': r2(np.degrees(np.arccos(np.dot(D, D_WAY))))},
                      'laneEnd': pt(LANE_END, Z_B1), 'laneLengthM': LANE_L, 'buildingClipM2': r2(CLIP_BLD), 'throatAreaM2': r2(INNER.area - INNER_OLD.area), 'mapEndOffAxisM': r2(float((MAP_END - P0) @ NRM)), 'mapNwCornerOffAxisM': r2(float((MAP_NW - P0) @ NRM)),
                      'mapEndOffM': r2(np.hypot(*(E0 - MAP_END)))},
         'ramp': {'shape': 'L', 'top': pt(T0, Z_B1), 'arcStart': pt(A0, z_at(LEG_S)), 'arcEnd': pt(B0, z_at(LEG_S + L_ARC)), 'band': pt(NB, Z_BAND), 'bottom': pt(RB, Z_B2), 'path': path, 'centre': [r2(v) for v in CC], 'outerRadiusM': R_OUT, 'innerRadiusM': R_IN, 'centreRadiusM': r2(R_C), 'laneWidthM': r2(LANE_W), 'straightWidthM': LANE_W_S,
                  'legSouthM': LEG_S, 'legNorthM': LEG_N, 'arcM': r2(L_ARC), 'legSouthAzimuthDeg': r2((B_WALL + 90) % 360), 'legNorthAzimuthDeg': r2(B_WALL), 'legNorthDir': [float(lN[0]), float(lN[1])], 'legSouthDir': [float(lS[0]), float(lS[1])], 'legNorthWestEdgeToWallM': r2(WALL_GAP), 'outerArcToWallM': r2(INNER_OLD.exterior.distance(Point(CC)) - R_OUT), 'outerArcToWallU08M': r2(INNER_U08.exterior.distance(Point(CC)) - R_OUT), 'crescentInOpeningM2': r2(opening.intersection(CRESCENT).area), 'crescentM2': r2(CRESCENT.area), 'openingM2': r2(opening.area), 'levelBelowDoorM': r2(Z_B1 - z_at(LEG_S + L_ARC + float((DOOR_NODE - B0) @ lN))), 'doorAlongLegNorthM': r2(float((DOOR_NODE - B0) @ lN)), 'westWallAzimuthDeg': r2(B_WALL), 'fieldWestWallAzimuthDeg': r2(np.degrees(np.arctan2(w[0], w[1]))), 'crescentTangentAzimuthDeg': [r2((B_S + 270) % 360), r2((B_N + 90) % 360)],
                  'bearingArcDeg': [r2(B_A), r2(B_B)], 'bearingTopDeg': B_S, 'bearingBandDeg': B_N, 'visibleM': r2(L_VIS), 'lengthM': r2(L_RAMP), 'dropM': r2(DROP), 'gradePct': r2(G_RAMP_PCT * 100),
                  'bandAlongM': r2(S_BAND), 'belowFloorAtBandM': r2(Z_B1 - Z_BAND), 'clearUnderSlabAtBandM': r2(C_B2 - Z_BAND), 'clearUnderSlabLegNorthM': [r2(C_B2 - Z_BAND), r2(C_B2 - Z_B2)], 'openDepthAtArcM': [r2(Z_B1 - z_at(LEG_S)), r2(Z_B1 - z_at(LEG_S + L_ARC))],
                  'legNorthToThroughLaneM': r2(LANE_GAP), 'legNorthEndToDoorM': r2(np.hypot(*(DOOR_NODE - RB))), 'legNorthToDoorM': r2(LEG_N_RECT.distance(Point(DOOR_NODE))), 'bottomToB2WallAheadM': r2(Point(RB).distance(LineString([RB, RB + lN * 60]).intersection(INNER_B2.exterior))), 'bottomToB2WallM': r2(INNER_B2.exterior.distance(Point(RB))),
                  'doorToBandM': r2(float((DOOR_NODE - NB) @ lN)), 'doorToTopM': r2(np.hypot(*(DOOR_NODE - T0))), 'westWallToOuterArcM': r2(float((CC - WA) @ e) - R_OUT), 'rowDirection': [float(ht[0]), float(ht[1])],
                  'island': {'polygon': [[r2(x), r2(y)] for x, y in ISLAND.exterior.coords], 'wall': [[r2(x), r2(y)] for x, y in sector(R_IN - 0.25, R_IN, B_A, B_N).exterior.coords], 'radiusM': R_IN},
                  'footprint': [[r2(x), r2(y)] for x, y in RAMP_FOOT.exterior.coords], 'opening': [[r2(x), r2(y)] for x, y in opening.exterior.coords], 'guide': [[r2(x), r2(y)] for x, y in gpts], 'legSouthRect': [[r2(x), r2(y)] for x, y in LEG_S_RECT.exterior.coords], 'legNorthRect': [[r2(x), r2(y)] for x, y in LEG_N_RECT.exterior.coords],
                  'mapSymbol': {'source': 'docs/audit/u07/crescent.json', 'oldThreePointsOffM': [r2(CRESCENT.distance(Point(q))) for q in SYM]}},
         'points': {'C1': pt(C1, Z_B1), 'C2': pt(C2, Z_B2), 'DOOR': pt(DOOR, Z_B1), 'SBN': pt(SBN, Z_B1), 'ST': pt(ST, Z_FIELD)},
         'hyein': {'door': pt(HD, Z_HB1), 'l0': pt(H_L0, Z_HB1), 'f1': pt(H_F1, Z_HMID), 'l1': pt(H_L1, Z_HMID), 'bottom': pt(H_BOT, Z_B1), 'out': pt(H_OUT, Z_B1), 'via': [pt(PV1, Z_B1), pt(PV2, Z_B1)], 'dropM': r2(Z_HB1 - Z_B1), 'mapDotOffM': r2(np.hypot(*(HD - np.array(GEO['xy']['dots']['혜인관']))))},
         'eunju': {'doorMapDotOffM': r2(np.hypot(*(DOOR - DOT))), 'stairRiseM': r2(Z_FIELD - Z_B1), 'stairRunM': r2(np.hypot(*(ST - SBN)))}}
(HERE / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps(model, ensure_ascii=False)); print(len(FEATS), 'features')
