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
Z_B1 = 143.5               # 2026-10-22 사용자 결정 "143.5로 진행해"(±0.5): C02 10-15 기압(지하 1층 → 본관 5층 137.8 에 5.7 m), 영상 2 계단, 지하 2층 ↔ 지하 1층 30~40 단(구역 노트 같은 날 절). 아래는 전 값 141.4 의 근거: 지하 1층 바닥. 범위 140.1(사용자 선) ~ 141.7. 사용자가 맞다고 한 지하 차도 진입 높이(141.4~) 와 은주1관 3층(5층 148.9 에서 두 층 아래) 계산이 같이 맞는 값(구역 노트)
C_B1 = r2(Z_B1 + 3.0)      # 지하 1층 천장(보 밑). 2026-10-22: 빈 높이 3.0 m 를 그대로(전 141.4~144.4 = 사용자 윗선 ±1). 그 위 운동장 148.9 까지 2.4 m 는 구조
SLAB_B1 = 0.5              # U11: 지하 1층 바닥 가장자리의 보(사진 22: 낮은 벽 1.1 m 의 0.45배쯤). U02~U10 은 1.0 m(추정)였다
C_B2 = r2(Z_B1 - SLAB_B1)  # 140.9
Z_B2 = 137.9               # U11: 지하 2층 바닥 = 지하 1층 바닥 - 3.5 m (사진 23·22·26 에서 잰 한 층: 기둥 높이 2.9 m + 보 0.5 m, 곧은 경사 17.5 % × 20 m. 범위 3.1~3.8 m). U02~U10 의 133.0 m(사용자 붉은 선 ±1, 8.4 m 아래)에서 벗어난다: 그 선은 층이 틀린 모델 화면 위에 그린 것이고, 사진은 한 층만 오르내린다(구역 노트 U11 절)
BASE = 1.0                 # 추정: 기초 판
WALL = 1.0
ROAD_W, CLEAR, ROOF = 7.2, 3.5, 0.6
C_ROAD = C_B1              # 지하 차도 연장의 천장 상한 = 지하 1층 천장(2026-10-22. 전 144.7: U01 단면 그대로, 사용자가 "사진과 같다"고 한 141.4~144.7)

# ---------- 평면: 학교 지도의 주차장 외곽 ----------
NL0, NL1 = np.array(GEO['xy']['parking'][0]), np.array(GEO['xy']['parking'][5])   # 북쪽 변(은주1관 북동 모서리 ~ 청운관 서쪽 초록 점)
dn = (NL1 - NL0) / np.hypot(*(NL1 - NL0)); sn = np.array([dn[1], -dn[0]])          # sn = 남쪽
if sn[1] > 0: sn = -sn
south = Polygon([NL0 - dn * 300, NL1 + dn * 300, NL1 + dn * 300 + sn * 400, NL0 - dn * 300 + sn * 400])
INNER_U08 = FIELD.buffer(-WALL, join_style=2).intersection(south).difference(BLD.buffer(0.5)).buffer(0)   # U02~U08 의 평면(운동장 외곽·건물 외곽 안에 가둔 것). 견줌에만 쓴다
MAPPOLY = Polygon(GEO['xy']['parking'])
# U09(사용자 지시 2026-10-12 "운동장의 형상을 반드시 따르지 않아도 되지 않을까?"): 지하층 평면 = 학교 지하도 지도의 밝은 사다리꼴 그대로. 운동장 외곽·건물 외곽으로 자르지 않는다(지하층은 건물 가장자리 밑과 운동장 밖으로 나갈 수 있다).
#   빈 곳은 단면에서만 기단을 비운다(지형 칸·기단 윗면·건물은 그대로: docs/audit/g02/STRUCTURES.md). 운동장 슬래브 기단은 손대지 않는다
#   경사로 굽은 곳 옆만 서쪽으로 넓힌다(사용자 그림 17: 굽은 곳이 평면 가장자리에 끼어 있음): 지도의 서쪽 변에서 EXT_W m, 굽은 구간과 북쪽 다리의 트인 구간 옆 EXT_L m. 은주1관 외곽(서쪽 변 밖 3.2~4.1 m)은 넘지 않는다(같은 높이에 은주1관의 층이 있다). 추정
# U11: U09 의 '경사로 굽은 곳 옆 서쪽으로 2.7 m × 30 m 넓힌 곳'은 없앴다(지도에 없고, 굽은 곳이 이제 서쪽 변에서 5 m 넘게 떨어져 있다). 평면 = 지도의 사다리꼴 그대로
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
E0 = np.array(hit.coords[0]); L_APP = float(np.hypot(*(E0 - P0)))
# 2026-10-22: 시험용 DB 의 길은 P0 → 노드 496ea877(137.8 m = 본관 5층 높이, 지하 차도 보행 구간이 붙는 곳) → 들머리. 앞 14.45 m 는 그대로(9.8 %), 그 뒤 들머리까지를 지하 1층 143.5 로 다시 기울인다. 목(들머리 ~ J0 14 m)은 전처럼 평지
K0 = np.array([201112.93, 557320.56]); Z_K0 = 137.8; S_K0 = float((K0 - P0) @ D); G_APP0 = (Z_K0 - Z_P0) / S_K0; GRADE_APP = (Z_B1 - Z_K0) / (L_APP - S_K0)
z_app = lambda s: min(Z_B1, Z_P0 + G_APP0 * s if s <= S_K0 else Z_K0 + GRADE_APP * (s - S_K0))
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
# U11(사용자 지적 2026-10-12 "벌써 잘못된 것 같은데 주차선 위치부터 다르잖아", 그림 28): 층 사이 경사로를 사진 22·23·24·26 에서 잰 치수로 다시 놓는다. U07~U09 의 서쪽 벽 기준 ㄴ자(56 m 에 8.4 m)는 없다.
#   곧은 구간 = 주차 줄과 나란히(북동–남서), 한 줄 묶음 S04 의 북서 옆 통로 자리. 발치가 북동: 지하 2층의 통로가 그대로 경사로가 된다(사진 23: 발치 왼쪽 = S04 줄, 오른쪽 = 서쪽 벽 쪽 칸).
#   올라가며 S04 의 남서 끝(반원 섬)을 왼쪽에 끼고 굽어 지하 1층 바닥에 올라선다(사진 22·26). 곧은 구간 + 직각쯤 굽은 곳 = ㄴ자(사용자 확정).
#   학교 지도의 부채꼴(docs/audit/u07/crescent.json) = 위가 트인 곳(곧은 구간의 트인 부분 + 굽은 곳)을 양식화해 그린 것으로 읽는다: 부채꼴의 북쪽 끝 = 낮은 벽, 안쪽 = S04 의 남서 끝.
#   치수는 전부 사진에서 잰 값(추정). 범위와 잰 방법은 볼트 구역 노트 U11 절의 표
MW0, MW1 = np.array(GEO['xy']['parking'][1]), np.array(GEO['xy']['parking'][0]); lN = (MW1 - MW0) / np.hypot(*(MW1 - MW0)); lS = np.array([lN[1], -lN[0]])   # lN = 서쪽 벽을 따라 북, lS = 벽에서 직각으로 안쪽(동)
DOOR_NODE = np.array([201146.21, 557283.45]); S_DOOR = float((DOOR_NODE - WA) @ w)
ha, hb = np.array([201200.7, 557180.9]), np.array([201246.0, 557255.8]); ht = (hb - ha) / np.hypot(*(hb - ha)); hn = np.array([ht[1], -ht[0]])   # 혜인관 운동장 쪽 벽: ht = 주차 줄 방향(북동), hn = 혜인관 쪽(남동)
CR = json.loads((HERE.parent / 'u07' / 'crescent.json').read_text(encoding='utf-8'))
CC = np.array(CR['centre']); _cp = lambda r, b: CC + r * np.array([np.sin(np.radians(b)), np.cos(np.radians(b))])
CRESCENT = Polygon([_cp(CR['outerRadiusM'], b) for b in np.linspace(CR['bearingSouthEndDeg'], CR['bearingNorthEndDeg'], 30)] + [_cp(CR['innerRadiusM'], b) for b in np.linspace(CR['bearingNorthEndDeg'], CR['bearingSouthEndDeg'], 30)])   # 지도의 부채꼴(견줌에만 쓴다)
B_ROW = float(np.degrees(np.arctan2(ht[0], ht[1]))); B_WALL = float(np.degrees(np.arctan2(lN[0], lN[1])))
S04_C, S04_N, STALL_W, STALL_D = np.array([201163.26, 557270.11]), 12, 2.5, 5.0   # 지도에서 읽은 한 줄 묶음 S04(가운데, 칸 수: docs/audit/u04/stalls.json mapBlocks)
Q01_AISLE = 0.2                            # Q01: 섬과 긴 줄 S07 사이 통로가 4.1 m 였다(사진 22 는 5.5~6 m). 섬의 반지름을 2.8 m 로 줄이고 중심을 그만큼 북서로 옮긴다: 경사로 쪽(북서) 벽 선·발치·낮은 벽은 제자리, 섬의 S07 쪽만 0.4 m 물러난다(통로 4.5 m). 더 줄이면 섬 벽이 S04 의 칸(깊이 5.0 m)에 걸린다
ISL = S04_C - ht * (S04_N * STALL_W / 2) - hn * Q01_AISLE   # 섬의 중심 = S04 의 남서 끝(마지막 칸의 끝 선 가운데)에서 북서로 0.5 m
R_ISL = 3.0 - Q01_AISLE                    # 섬(반원)의 반지름. 사진 22: 2.5~3.5 m
RAMP_W = 6.4                               # 경사로 폭(벽에서 벽). 사진 23: 발치의 두 기둥 사이 6.4 m, 통로 6.0~6.8 m. 가운데 노란 선(두 방향)
R_OUT, R_C, V_C = R_ISL + RAMP_W, R_ISL + RAMP_W / 2, -(R_ISL + RAMP_W / 2)
S_TOE = 12.0                               # 발치(기둥 줄) ~ 안쪽 벽이 굽기 시작하는 곳. 사진 23: 12.3 m(11~13.5)
S_BAND = 6.5                               # 낮은 벽(지하 1층 바닥이 끝나는 가장자리)이 섬 중심에서 북동으로. 사진 22: 낮은 벽 밑 빈 높이 2.1 m → 발치에서 4.6~5.9 m 위
G_RAMP = 0.175                             # 사진 23: 소실점으로 17.5 %(15~19), 턱 선으로 17.3 %
L_RAMP = 20.0; G_RAMP_PHOTO = G_RAMP   # 2026-10-22: 평면(사진에서 잰 곧은 12 m + 굽은 8 m)은 그대로 두고 층 차가 3.5 → 5.6 m 로 커져 경사가 17.5 → 28 % 가 된다(사진과 어긋남: 구역 노트 같은 날 절)
DROP = Z_B1 - Z_B2; G_RAMP = DROP / L_RAMP; L_ARC = L_RAMP - S_TOE; PHI_CREST = float(np.degrees(L_ARC / R_C)); PHI_WALL = 95.0   # 굽은 곳에서 더 오르는 길이, 마루(지하 1층 바닥에 닿는 곳)의 각, 바깥 청록 벽이 끝나는 각
assert 60 < PHI_CREST < 90, PHI_CREST
G_RAMP_PCT = G_RAMP
sp = lambda s_, v_: ISL + ht * s_ + hn * v_                                                   # 띠 좌표: s = 섬 중심에서 주차 줄을 따라 북동, v = 혜인관 쪽(남동). 경사로는 v < 0(북서) 쪽
pol = lambda r, f: ISL - r * (np.cos(np.radians(f)) * hn + np.sin(np.radians(f)) * ht)      # 섬 중심 둘레: f = 0 북서(곧은 구간이 끝나는 곳), 90 남서, 180 남동
z_up = lambda d: min(Z_B1, Z_B2 + G_RAMP * d)                                                # 발치에서 가운데 선을 따라 올라간 길이 → 높이
def sector(r0, r1, f0, f1, n=None):
    ff = np.linspace(f0, f1, n or max(2, int(abs(f1 - f0) / 2.5) + 1)); return Polygon([pol(r1, f) for f in ff] + [pol(r0, f) for f in ff[::-1]])
strip = lambda s0, s1, v0=-R_OUT, v1=-R_ISL: Polygon([sp(s0, v0), sp(s1, v0), sp(s1, v1), sp(s0, v1)])
RB, NB, A0, T0 = sp(S_TOE, V_C), sp(S_BAND, V_C), sp(0.0, V_C), pol(R_C, PHI_CREST)   # 발치, 낮은 벽 밑, 굽기 시작하는 곳, 마루(머리)
ISLAND = Polygon([pol(R_ISL, f) for f in np.linspace(0, 180, 37)])                    # 섬 = S04 띠의 남서 끝 반원(지하 1층에서는 낮은 벽 안쪽 바닥, 지하 2층에서는 남색 벽 안쪽)
RAMP_FOOT = unary_union([strip(0.0, S_TOE), sector(R_ISL, R_OUT, 0.0, PHI_CREST)]).buffer(0.01)
opening = unary_union([strip(0.0, S_BAND), sector(R_ISL, R_OUT, 0.0, PHI_CREST)]).buffer(0.02, join_style=2).buffer(-0.02, join_style=2)
assert opening.geom_type == 'Polygon', opening.geom_type
# U11(사용자 확정 2026-10-12, 그림 29): 지하 1층 북서쪽 세모 = 주차관리센터(관리실)·화장실·은주관으로 가는 통로. 주차 바닥이 아니다. 간판 벽(사진 13·20·21)은 서쪽 외벽이 아니라 이 세모의 빗변(주차장 쪽 벽)이다.
#   빗변: 그림 29 에서 주차 줄과 나란하게 읽힌다(방위 209도, 줄 31도). 서쪽 변을 북서 모서리에서 남쪽으로 29~31 m 내려온 곳에서 시작해 지하 차도 목의 남쪽 가장자리까지. 섬 중심에서 북서로 V_HYP m 의 선(손그림 ±1.5 m)
V_HYP, S_MOUTH = -16.5 + Q01_AISLE, 17.6            # 빗변의 자리, 빗변 위 계단 어귀의 자리(옛 문 노드를 빗변에 직각으로 옮긴 곳). 추정
ROOM = INNER_OLD.intersection(Polygon([sp(-60, V_HYP), sp(90, V_HYP), sp(90, V_HYP - 60), sp(-60, V_HYP - 60)])).difference(LineString([E0 - D * 5, LANE_END]).buffer(ROAD_W / 2, cap_style=2)).buffer(0)
ROOM = max(ROOM.geoms, key=lambda g: g.area) if hasattr(ROOM, 'geoms') else ROOM
_hyp = LineString([sp(-60, V_HYP), sp(90, V_HYP)]).intersection(ROOM.buffer(0.05)); HYP_S = sorted(float((np.array(c) - ISL) @ ht) for c in _hyp.coords)   # 빗변이 놓인 s 범위
assert HYP_S[0] < S_MOUTH - 10 and HYP_S[1] > S_MOUTH + 3, HYP_S
INNER_B2 = INNER_OLD                     # 지하 2층 평면 = 지도의 사다리꼴(목 없음)
C1, C2 = np.array([201200.0, 557245.0]), np.array([201185.0, 557250.0])     # 종착 표지 자리(U01 그대로, 추정)

# ---------- 사람 길 ----------
DOT = np.array(GEO['xy']['dots']['은주1관 북서(3층)'])
DOOR_OLD = WA + w * (DOT[1] - WA[1]) / w[1] + e * 1.6    # U02~U10 의 문 자리(서쪽 벽에 붙인 초록 점). 이제 세모 안이다
DOOR = sp(S_MOUTH, V_HYP + 0.3)                          # U11: 은주관 간판 오른쪽 계단 어귀(빗변 위, 주차장 쪽 0.3 m). 문 노드 8e608a71 의 새 자리
SBN = sp(S_MOUTH, V_HYP - 2.2)                           # U11: 어귀 안 2.2 m 의 계단 참(내려가면 은주1관 3층, 올라가면 운동장: 사진 19·21 의 한 어귀). 노드 4eebbb98 의 새 자리
ST = np.array([201150.5, 557299.5])                      # 운동장 위 끝(추정): 은주1관 북쪽 끝 옆, 주차장 북쪽 벽 바깥
HD = np.array([201218.7, 557213.7])                      # 혜인관 입구(1) 문 노드(운동장 높이 = 혜인관 지하 1층 149.3)
H_L0, H_F1 = HD + hn * 3.0, HD + hn * 11.0; H_L1 = H_F1 + ht * 1.8; H_BOT = HD + hn * 3.0 + ht * 1.8
Z_HB1 = 149.3; Z_HMID = r2((Z_HB1 + Z_B1) / 2)
H_OUT = H_BOT - hn * 6.5                                 # 계단 발치에서 벽을 지나 주차장 안으로
PV1, PV2 = np.array([201203.0, 557247.0]), np.array([201170.0, 557285.0])   # 보행 동선이 지하 1층 차로 둘을 건너지 않고 돌아가는 점(주차 자리 동쪽, 들머리 차로 북동쪽)
for name, p in (('L0', H_L0), ('F1', H_F1), ('L1', H_L1), ('BOT', H_BOT)): assert HYEIN.contains(Point(p)), name
for name, p in (('J0', J0), ('T0', T0), ('A0', A0), ('NB', NB), ('RB', RB), ('C1', C1), ('C2', C2), ('DOOR', DOOR), ('SBN', SBN), ('H_OUT', H_OUT)): assert INNER.contains(Point(p)), (name, p)
assert INNER_OLD.buffer(-0.5).contains(unary_union([RAMP_FOOT, sector(R_ISL, R_OUT + 0.2, 0, PHI_WALL), ISLAND])), '경사로가 주차장 평면 밖으로 나간다'
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

G_LEVEL = f'확정(층이 있음, 지하 1층 바닥: 사용자 결정 2026-10-22 143.5 ±0.5 m), 원천(평면: 학교 지도, 잔차 RMS {RES} m), 추정(판 두께·벽)'
feat('U02-VOID-B1', 'void', 'void', INNER, G_LEVEL, f'운동장 지하 1층: 바닥 {Z_B1} m(사용자 결정 2026-10-22, 전 141.4), 천장 {C_B1} m(빈 높이 3.0 m). 그 위 {C_B1}~{Z_FIELD} m 는 빈 층 없이 구조. 평면은 학교 지하도 지도의 사다리꼴 그대로(U09) + 북서 모서리의 지하 차도 목 {INNER.area - INNER_OLD.area:.0f} ㎡(U05)', fromM=Z_B1, toM=C_B1, name='운동장 지하 1층')
feat('U02-VOID-B2', 'void', 'void', INNER_B2, '확정(층이 있음), 추정(바닥 높이: U11 137.9 그대로 = 사용자 결정 "약 138"(2026-10-22, 지하 1층 - 30~40 단)), 원천(평면: 학교 지도)', f'운동장 지하 2층: 바닥 {Z_B2} m = 지하 1층 바닥 - {Z_B1 - Z_B2:.1f} m(2026-10-22. U11 의 사진에서 잰 한 층 3.5 m 보다 크다), 천장 {C_B2} m = 지하 1층 바닥 가장자리 보({SLAB_B1} m) 밑. 평면은 학교 지하도 지도의 사다리꼴. 목 없음', fromM=Z_B2, toM=C_B2, name='운동장 지하 2층')

# 지하 차도 연장(내리막길 밑, U01 의 선) + 운동장 북쪽 띠를 지나 주차장으로 들어가는 평평한 통로
n = int(np.ceil((L_APP + WALL + 0.5) / 1.0)); step = (L_APP + WALL + 0.5) / n; covers = []
for k in range(n):
    a, b = k * step, (k + 1) * step; za, zb = (z_app(s) for s in (a, b)); mid = P0 + D * (a + b) / 2
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

# U11 층 사이 경사로: 곧은 구간(발치 ~ 낮은 벽: 지하 1층 바닥 밑, 낮은 벽 ~ 섬: 위가 트임) + 섬을 끼고 굽은 곳(마루까지). 기운 윗면의 상자들, 아래는 지하 2층 바닥까지 채움(판인지 채움인지 모름)
G_RAMP_T = (f'확정(평면이 ㄴ자: 사용자. 발치 왼쪽이 주차 칸 줄: 사용자 지적 2026-10-12·사진 23), 원천(자리: 학교 지도의 한 줄 묶음 S04 의 남서 끝과 부채꼴, 좌표 맞춤 잔차 RMS {RES} m), '
            '추정(사진에서 잰 치수: 폭·곧은 길이·경사·굽은 곳 반지름·한 층 높이)')
fs = np.linspace(0.0, PHI_CREST, 10)
segs = [(RB, NB, 0.0, S_TOE - S_BAND, strip(S_BAND, S_TOE), f'곧은 구간의 아래쪽 {S_TOE - S_BAND:.1f} m(발치 ~ 낮은 벽 밑: 지하 1층 바닥 아래)', False),
        (NB, A0, S_TOE - S_BAND, S_TOE, strip(0.0, S_BAND), f'곧은 구간의 위쪽 {S_BAND:.1f} m(낮은 벽 ~ 섬 옆: 위가 트임)', True)]
for k in range(len(fs) - 1):
    f0, f1 = fs[k], fs[k + 1]; d0, d1 = S_TOE + np.radians(f0) * R_C, S_TOE + np.radians(f1) * R_C
    segs.append((pol(R_C, f0), pol(R_C, f1), d0, d1, sector(R_ISL, R_OUT, f0, f1, 5), f'굽은 곳(섬을 왼쪽에 끼고 오름) {d0 - S_TOE:.1f}~{d1 - S_TOE:.1f} m', True))
def prof(a, b, d0, d1, up=0.0): d = (b - a) / np.hypot(*(b - a)); return {'origin': [r2(a[0]), r2(a[1])], 'direction': [float(d[0]), float(d[1])], 'points': [[0.0, r2(max(z_up(d0), Z_B2 + 0.02) + up)], [r2(np.hypot(*(b - a))), r2(z_up(d1) + up)]]}
GUIDE, TEAL, STRIPE, LOWWALL, NAVY = '#e3b505', '#2aa7b8', '#d8b000', '#6f8fa3', '#26405f'
GREEN_NOW, SIGNWALL_NOW = '#7d9080', '#465068'   # U12: 현장 사진 30·31(2026-10-12)에서 읽은 지금 색. 경사로 바깥 벽 = 회녹색(현수막이 걸린 초록 벽), 간판 벽 = 짙은 푸른 회색
for k, (a, b, d0, d1, poly, what, seen) in enumerate(segs):
    feat(f'U11-RAMP-SEG-{k:02d}', 'ramp', 'extrude', poly, G_RAMP_T, f'{what}: {z_up(d0):.2f} → {z_up(d1):.2f} m. 전체 {L_RAMP:.1f} m 에 {DROP:.1f} m, {G_RAMP * 100:.1f} %', basePlane='U02-VOID-B2 바닥', material='concrete', inVoid=True, color='#77756f', topProfile=prof(a, b, d0, d1), bottomM=Z_B2, openAbove=seen)
    gl = (sector(R_C - 0.1, R_C + 0.1, fs[k - 2], fs[k - 1], 5) if k >= 2 else LineString([a, b]).buffer(0.1, cap_style=2)).intersection(poly.buffer(0.01))   # 가운데의 노란 선(사진 23·26: 두 방향을 가르는 선)
    if not gl.is_empty and gl.area > 0.05: feat(f'U11-RAMP-CENTRELINE-{k:02d}', 'wall', 'extrude', gl, '확정(가운데 노란 선: 사진 23·26), 추정(자리)', '경사로 가운데의 노란 선', material='concrete', inVoid=True, color=GUIDE, topProfile=prof(a, b, d0, d1, 0.05), thicknessM=0.05, openAbove=seen)
    for side, v_, r_ in (('IN', -R_ISL - 0.37, R_ISL + 0.37), ('OUT', -R_OUT + 0.37, R_OUT - 0.37)):   # 양쪽 벽 밑의 노랑·검정 턱(사진 23·26). 노랑 한 색
        if k < 2:
            s0_, s1_ = (S_TOE, S_BAND) if k == 0 else (S_BAND, 0.0)
            feat(f'U11-RAMP-KERB-{side}-{k:02d}', 'wall', 'extrude', LineString([sp(s0_, v_), sp(s1_, v_)]).buffer(0.1, cap_style=2), '확정(있음·색: 사진 23·26), 추정(치수)', '경사로 벽 밑의 노랑·검정 턱', material='concrete', inVoid=True, color=STRIPE, topProfile=prof(sp(s0_, v_), sp(s1_, v_), d0, d1, 0.2), bottomM=Z_B2, openAbove=seen)
        else: box(f'U11-RAMP-KERB-{side}-{k:02d}', 'wall', sector(r_ - 0.1, r_ + 0.1, fs[k - 2], fs[k - 1], 4), Z_B2, z_up(d1) + 0.2, STRIPE, '경사로 벽 밑의 노랑·검정 턱', grade='확정(있음·색: 사진 23·26), 추정(치수)', openAbove=True)
feat('U02-VOID-RAMP-OPENING', 'void', 'void', opening, f'원천(자리: 학교 지도의 부채꼴 = 위가 트인 곳, 잔차 RMS {RES} m), 확정(아래층이 보인다: 사진 22·23·26), 추정(범위: 사진에서 잰 치수)',
     f'경사로 위로 지하 1층 바닥을 틔운 곳 = 곧은 구간의 위쪽 {S_BAND} m(낮은 벽 ~ 섬 옆) + 굽은 곳(마루까지 {PHI_CREST:.0f}도). {opening.area:.0f} ㎡. 지도의 부채꼴({CRESCENT.area:.0f} ㎡)과 겹치는 넓이 {opening.intersection(CRESCENT).area:.0f} ㎡. 낮은 벽 밑에서 경사로는 지하 1층 바닥보다 {Z_B1 - z_up(S_TOE - S_BAND):.2f} m 아래(보 밑 빈 높이 {C_B2 - z_up(S_TOE - S_BAND):.2f} m)', fromM=C_B2, toM=Z_B1, name='경사로 구멍')
G_SEEN = '확정(있음·색: 사진 22·23·26), 원천(자리: 학교 지도의 S04 남서 끝·부채꼴), 추정(치수)'
arc_band = lambda r, f0, f1, t=0.1: sector(r - t, r + t, f0, f1)
line_band = lambda s0, s1, v_, t=0.1: LineString([sp(s0, v_), sp(s1, v_)]).buffer(t, cap_style=2)
# 안쪽(섬 쪽)의 짙은 남색 벽: 발치의 기둥에서 섬 옆까지 곧게, 섬을 따라 굽는다. 지하 2층 바닥 ~ 지하 1층 바닥(사진 23 왼쪽, 사진 26 왼쪽)
box('U11-RAMP-INNERWALL-UNDER', 'wall', line_band(S_BAND, S_TOE, -R_ISL - 0.15), Z_B2, C_B2, NAVY, '경사로 안쪽(S04 쪽)의 짙은 남색 벽, 지하 1층 바닥 밑 구간(사진 23 왼쪽: 발치의 흰 기둥에서 시작)', grade=G_SEEN)
box('U11-RAMP-INNERWALL', 'wall', unary_union([line_band(0.0, S_BAND, -R_ISL - 0.15), arc_band(R_ISL + 0.15, 0.0, PHI_CREST)]), Z_B2, Z_B1, NAVY, '경사로 안쪽의 짙은 남색 벽, 위가 트인 구간과 섬 둘레(사진 23·26 왼쪽). 윗선 = 지하 1층 바닥', grade=G_SEEN)
ISL_WALL = unary_union([line_band(0.0, S_BAND, -R_ISL + 0.05, 0.12), arc_band(R_ISL - 0.05, 0.0, 180.0, 0.12)]).buffer(0.01, join_style=2).buffer(-0.01, join_style=2)
box('U02-ISLAND-WALL', 'wall', ISL_WALL, Z_B1, Z_B1 + 1.1, LOWWALL, '섬의 낮은 벽(사진 22: 푸른 회색, 높이 1.1 m 추정): S04 띠의 남서 끝 반원과 트인 곳 옆. 벽 뒤는 S04 의 주차 칸', grade=G_SEEN)
box('U02-ISLAND-STRIPE', 'wall', arc_band(R_ISL + 0.25, PHI_CREST, 180.0, 0.13), Z_B1, Z_B1 + 0.2, STRIPE, '섬 벽 밑의 노랑·검정 줄무늬 턱(사진 22: 지하 1층 바닥 위)', grade=G_SEEN)
# 바깥(서쪽 벽 쪽)의 청록 벽: 발치의 기둥에서 곧게, 굽은 곳 바깥을 돌아 마루를 조금 지난 곳까지(사진 22 왼쪽, 사진 23 먼 끝, 사진 26 오른쪽)
box('U11-RAMP-OUTERWALL-UNDER', 'wall', line_band(S_BAND, S_TOE, -R_OUT + 0.15), Z_B2, C_B2, TEAL, '경사로 바깥쪽 청록 벽, 지하 1층 바닥 밑 구간', grade=G_SEEN)
box('U07-RAMP-OUTERWALL', 'wall', unary_union([line_band(0.0, S_BAND, -R_OUT + 0.15), arc_band(R_OUT - 0.15, 0.0, PHI_WALL)]), Z_B2, C_B1, GREEN_NOW, f'경사로 바깥쪽 벽(U12: 현장 사진 30·31 의 지금 색 = 회녹색. 옛 사진 22 는 청록): 트인 구간과 굽은 곳 바깥({PHI_WALL:.0f}도까지). 지하 2층 바닥에서 지하 1층 천장까지(사진 22 왼쪽: 바닥에서 천장까지)', grade=G_SEEN)
box('U11-OUTERWALL-KERB-B1', 'wall', arc_band(R_OUT - 0.4, PHI_CREST, PHI_WALL, 0.13), Z_B1, Z_B1 + 0.2, STRIPE, '청록 벽 밑의 노랑·검정 턱(사진 22 왼쪽 아래: 지하 1층 바닥 위)', grade=G_SEEN)
# 낮은 벽: 트인 곳의 북동 가장자리(지하 1층 바닥이 다시 시작하는 곳). 밑으로 아래층이 보인다(사진 22). 은주관 벽 쪽에서 보면 오른쪽의 낮은 벽(사진 14·24)
G_BAND = '확정(있음·청록 벽과 섬 사이·밑으로 아래층이 보임: 사용자 표시 3, 사진 22), 추정(자리: 사진 22 의 빈 높이 2.1 m 에서 계산, 지도의 부채꼴 북쪽 끝과 견줌)'
box('U06-BAND-WALL', 'wall', LineString([sp(S_BAND - 0.14, -R_OUT), sp(S_BAND - 0.14, -R_ISL)]).buffer(0.12, cap_style=2), Z_B1, Z_B1 + 1.1, '#31486b', '경사로를 가로지르는 낮은 벽(사진 15 의 붉은 네모 = 사진 14 오른쪽의 낮은 벽): 짙은 남색, 높이 1.1 m. 벽 북동쪽은 지하 1층 바닥(통로)', grade=G_BAND)
box('U11-BAND-BEAM', 'wall', LineString([sp(S_BAND - 0.3, -R_OUT), sp(S_BAND - 0.3, -R_ISL)]).buffer(0.05, cap_style=2), C_B2, Z_B1, '#9aa0a4', f'낮은 벽 밑의 바닥 가장자리 보(회색 띠, {SLAB_B1} m: 사진 22)', grade=G_BAND)
sq_c = lambda p, h: Polygon([p + ht * a_ + hn * b_ for a_, b_ in ((-h, -h), (h, -h), (h, h), (-h, h))])
box('U07-ISLAND-PIER', 'wall', sq_c(sp(S_BAND, -R_ISL + 0.45), 0.4), Z_B1, C_B1, '#4f6f95', '섬 벽과 낮은 벽이 만나는 곳의 기둥(사진 22: 푸른 기둥. 사진 24 에서는 낮은 벽 왼쪽 끝의 흰 기둥)', grade=G_SEEN)
box('U11-BAND-JAMB', 'wall', sq_c(sp(S_BAND, -R_OUT - 0.3), 0.3), Z_B1, C_B1, '#dfe3e3', '청록 벽이 끝나는 곳(낮은 벽의 왼쪽 끝)의 흰 문설주(사진 22)', grade=G_SEEN)
TOE_COLS = [sp(S_TOE, -R_ISL + 0.45), sp(S_TOE, -R_OUT - 0.45)]
for nm, q in zip(('IN', 'OUT'), TOE_COLS): box(f'U11-TOE-COLUMN-{nm}', 'wall', sq_c(q, 0.45), Z_B2, C_B2, '#eceae2', '경사로 발치 양옆의 흰 네모 기둥(사진 23: 폭 0.9~1.0 m, 두 기둥 사이 6.4 m). 왼쪽 기둥에서 남색 벽이 시작하고 그 북동쪽이 S04 의 주차 칸', grade='확정(있음: 사진 23), 추정(치수)')
S_BUMP = S_TOE + 9.0
box('U08-SPEED-BUMP', 'wall', LineString([sp(S_BUMP, -R_OUT + 0.3), sp(S_BUMP, -R_ISL - 0.3)]).buffer(0.2, cap_style=2), Z_B2, Z_B2 + 0.08, '#d8b000', '지하 2층 통로를 가로지르는 과속방지턱(사진 23: 발치에서 8.6~10 m 앞). 노랑 한 색', grade='확정(있음·지하 2층 통로를 가로지름: 사진 23), 추정(자리)')
# 지하 1층 바닥의 노란 유도선(사진 22): 마루에서 섬 앞을 크게 돌아 S04 와 긴 줄 S07 사이 통로로
gpts = [pol(R_C, f) for f in np.linspace(PHI_CREST, 180.0, 14)] + [sp(8.0, R_C - 1.2)]
box('U06-GUIDE-LINE', 'wall', LineString(gpts).buffer(0.1, cap_style=2).difference(opening.buffer(0.05)), Z_B1, Z_B1 + 0.05, GUIDE, '지하 1층 바닥의 노란 유도선(사진 22): 경사로 마루에서 섬 앞을 돌아 S04·S07 사이 통로로. 자리 추정', grade='확정(있음·섬 앞을 돈다: 사진 22), 추정(자리)')

# U10(사진 13·19·20·21·22, 블로그-06): 은주관 간판 벽의 겉모습과 걸린 표지. 벽 = 서쪽 벽, 문 노드(DOOR)가 주황 벽 계단 어귀의 가운데(간판의 오른쪽 = 북쪽). 벽을 마주 보면 왼쪽(남)부터 주차관리센터 간판·문, 은주관 간판·정산기, 계단 어귀, 걸린 표지가 달린 기둥. 치수·간격은 사진에서 눈으로 읽음(추정)
G_EJ = '확정(있음·차례: 사진 20·21, 블로그-06), 추정(자리·치수)'
_wl = lambda s_, x0, x1, half: Polygon([DOOR + ht * (s_ - half) + hn * x0, DOOR + ht * (s_ + half) + hn * x0, DOOR + ht * (s_ + half) + hn * x1, DOOR + ht * (s_ - half) + hn * x1])   # U11: s_ = 어귀에서 빗변을 따라 북동(+, 주차장에서 보면 오른쪽)·남서(-), x = 주차장 쪽(+)
XW = -0.3   # 벽면(DOOR 는 빗변에서 0.3 m 주차장 쪽)
for nm, s0_, s1_ in (('SW', HYP_S[0], S_MOUTH - 1.0), ('NE', S_MOUTH + 1.0, HYP_S[1])): box(f'U10-EUNJU-WALL-{nm}', 'wall', LineString([sp(s0_, V_HYP), sp(s1_, V_HYP)]).buffer(0.1, cap_style=2), Z_B1, C_B1, SIGNWALL_NOW, '세모 구역(주차관리센터·화장실·통로)의 주차장 쪽 벽 = 간판 벽(사진 20·21·30·31: 짙은 푸른 회색. 블로그-06 때는 흰 벽). 계단 어귀 2 m 는 비움', grade='확정(세모가 관리실·화장실·통로이고 간판 벽이 그 주차장 쪽 벽: 사용자 2026-10-12, 그림 29), 추정(자리 ±1.5 m)')
_room = ROOM.difference(LineString([DOOR, SBN, SBN - hn * 3.0]).buffer(1.0, cap_style=2)).buffer(-0.12, join_style=2)
for k_, g_ in enumerate(_room.geoms if hasattr(_room, 'geoms') else [_room]):
    if g_.area > 2: box(f'U11-OFFICE-BLOCK-{k_}', 'wall', g_, Z_B1, C_B1, '#b3a996', f'주차관리센터(관리실)·화장실이 든 막힌 구역(세모 {ROOM.area:.0f} ㎡). 안의 방 나눔은 모름. 어귀에서 들어가는 통로 2 m 는 비움', grade='확정(주차 바닥이 아니다: 사용자 2026-10-12, 그림 29), 추정(외곽 ±1.5 m, 방 나눔)', name='주차관리센터·화장실')
box('U10-EUNJU-SIGN', 'wall', _wl(-2.3, XW + 0.08, XW + 0.2, 1.1), Z_B1 + 2.15, Z_B1 + 2.75, '#f2f4f6', '"은주관" 조명 간판(흰 바탕): 계단 어귀의 왼쪽(남쪽) 위', grade=G_EJ, name='은주관 간판')
box('U10-PARKING-OFFICE-SIGN', 'wall', _wl(-6.3, XW + 0.08, XW + 0.2, 1.5), Z_B1 + 2.1, Z_B1 + 2.8, '#d21f26', '"주차관리센터" 조명 간판(붉은 바탕): 은주관 간판의 왼쪽(남쪽)', grade=G_EJ, name='주차관리센터 간판')
box('U10-PARKING-OFFICE-DOOR', 'wall', _wl(-4.6, XW + 0.08, XW + 0.14, 0.45), Z_B1, Z_B1 + 2.05, '#6c7278', '주차관리센터 문(회색 철문): 붉은 간판의 오른쪽 끝 아래', grade=G_EJ, name='주차관리센터 문')
box('U10-PARKING-OFFICE-BOARD', 'wall', _wl(-7.6, XW + 0.08, XW + 0.12, 0.7), Z_B1 + 1.2, Z_B1 + 2.0, '#1c1e21', '주차관리센터 간판 아래의 검은 게시판(사진 21)', grade=G_EJ)
box('U10-PAY-MACHINE', 'wall', _wl(-2.2, XW + 0.08, XW + 0.6, 0.3), Z_B1, Z_B1 + 1.8, '#1f3f8f', '주차 정산기(파란 기계): 은주관 간판 바로 아래(사진 20·21)', grade=G_EJ, name='주차 정산기')
for sd, s_ in (('S', -1.0), ('N', 1.0)): box(f'U10-STAIR-MOUTH-WALL-{sd}', 'wall', _wl(s_, XW - 1.6, XW + 0.08, 0.06), Z_B1, Z_B1 + 2.4, '#e58a1f', '은주관 간판 오른쪽 계단 어귀의 주황 벽(사진 20·21). 이 어귀로 은주1관 3층으로 내려가고(블로그-06 의 난간) 운동장·풋살장으로 올라간다(사진 19 의 글)', grade=G_EJ)
SIGN_COL = DOOR + ht * 4.6 + hn * 2.4   # 사진 20: 계단 어귀 오른쪽 앞의 기둥(노란 세로 줄). 그 위 양쪽으로 표지가 걸려 있다
box('U10-SIGN-COLUMN', 'wall', Polygon([SIGN_COL + ht * a + hn * b for a, b in ((-0.3, -0.3), (0.3, -0.3), (0.3, 0.3), (-0.3, 0.3))]), Z_B1, C_B1, '#4f6f95', '걸린 표지가 달린 기둥(사진 20 오른쪽)', grade='확정(있음: 사진 20), 추정(자리 ±3 m)')
for nm, s0, s1, txt in (('A', -3.2, -0.4, '왼쪽 표지(노란 화살표): 사진 20 의 왼쪽 동그라미 = 사진 22 에서 낮은 벽 너머로 보이는 표지(사용자 표시)'), ('B', 0.4, 4.2, '"서경스포츠아카데미 ←" 현수막(사진 19·20 의 오른쪽 동그라미)')):
    box(f'U10-HANGING-SIGN-{nm}', 'wall', Polygon([SIGN_COL + ht * s0 - hn * 0.04, SIGN_COL + ht * s1 - hn * 0.04, SIGN_COL + ht * s1 + hn * 0.04, SIGN_COL + ht * s0 + hn * 0.04]), C_B1 - 0.75, C_B1 - 0.2, '#22252a', txt + '. 검은 바탕. 벽과 나란히 걸린 것으로 둠(추정)', grade='확정(있음·은주관 벽의 오른쪽: 사용자 표시, 사진 20·22), 추정(자리·방향)', name='걸린 표지')
SG18 = J0 + D * 6.0   # 사진 18: 통로 위에 가로 걸린 방향 표지(← 청운관 / ↑ 혜인관 / ↱ 은주관). 지하 차도에서 들어와 곧은 차로를 따라가는 방향으로 읽음: 곧장 = 혜인관(남동), 왼쪽 = 청운관(북동), 앞에서 오른쪽 = 은주관 벽(남서). 자리 추정
box('U10-DIRECTION-SIGN', 'wall', Polygon([SG18 + NRM * 3.4 - D * 0.04, SG18 - NRM * 3.4 - D * 0.04, SG18 - NRM * 3.4 + D * 0.04, SG18 + NRM * 3.4 + D * 0.04]), C_B1 - 0.7, C_B1 - 0.15, '#22252a', '천장에 가로 걸린 방향 표지(사진 18): "← 청운관(대일관·상승관)" 분홍, "↑ 혜인관" 청록, "↱ 은주관" 주황. 검은 판 하나로 둠. 들머리에서 20 m 안쪽의 곧은 차로 위(자리 추정: 사진의 찍은 자리는 모름)', grade='확정(있음·세 방향: 사진 18), 추정(자리)', name='방향 표지')
for nm, off, col in (('CHEONGUN', 2.3, '#e24f9e'), ('HYEIN', 0.0, '#2fb3b3'), ('EUNJU', -2.3, '#e09a2a')):
    box(f'U10-DIRECTION-SIGN-{nm}', 'wall', Polygon([SG18 + NRM * (off + 0.9) - D * 0.1, SG18 + NRM * (off - 0.9) - D * 0.1, SG18 + NRM * (off - 0.9) - D * 0.04, SG18 + NRM * (off + 0.9) - D * 0.04]), C_B1 - 0.62, C_B1 - 0.23, col, '방향 표지의 색 칸(사진 18)', grade='확정(색·차례: 사진 18), 추정(자리)')
print('U10 door', DOOR, 'sign column', SIGN_COL, 'door to band', float(np.hypot(*(DOOR - NB))), 'sign18', SG18, INNER.contains(Point(SG18)), INNER.contains(Point(SIGN_COL)))

# ---------- U12(사용자 현장 사진 30·31, 2026-10-12: 지하 1층의 지금 모습). 배치는 그대로, 사진이 새로 보여 준 것만 얹는다 ----------
#   두 사진은 S04·S07 사이 통로(섬 중심에서 북동 24~25 m)에서 찍었다(구역 노트 U12 절의 자리 맞춤). 통로 바닥의 흰 화살표는 남서(층 사이 경사로 쪽)를 가리킨다
SRC_U12 = '사용자 현장 사진 2026-10-12: 30-현장-지하1층-통로-화살표-사람.jpg, 31-현장-지하1층-통로-사용자표시-B2방향.webp. 구역 노트 운동장 아래 지하층과 지하 차도(U12 절)'; GUARDS = []
def box12(id, poly, lo, hi, color, assumption, grade, **kw): box(id, 'wall', poly, lo, hi, color, assumption, grade=grade, **kw); FEATS[-1]['properties']['source'] = SRC_U12
V_AISLE = 5.0                      # S04(가장자리 v = 2.7)와 S07 사이 통로의 가운데
ARROW = Polygon([sp(20.5, V_AISLE), sp(21.7, V_AISLE - 0.45), sp(21.7, V_AISLE - 0.08), sp(24.2, V_AISLE - 0.08), sp(24.2, V_AISLE + 0.08), sp(21.7, V_AISLE + 0.08), sp(21.7, V_AISLE + 0.45)])
box12('U12-AISLE-ARROW', ARROW, Z_B1, Z_B1 + 0.03, '#f1f0ea', 'S04·S07 사이 통로 바닥의 흰 화살표(길이 3.7 m): 남서(층 사이 경사로 쪽)를 가리킨다 = 이 통로의 차량 진행 방향. 두 사진에서 따로 잰 자리가 0.5 m 안에서 같다', '확정(있음·방향: 현장 사진 30·31), 추정(자리 ±2 m·치수)', name='진행 방향 화살표')
box12('U12-B2-SIGN', sector(R_OUT - 0.33, R_OUT - 0.25, 86.0, 93.5), Z_B1 + 1.9, Z_B1 + 2.4, '#f6f2df', '불 켜진 "B2 ▷" 표지: 통로의 남서 끝, 섬 너머 벽에 걸려 통로 쪽(북동)을 본다. 화살표는 오른쪽(섬을 돌아 내려가는 쪽). 사진에서는 통로 축 위(v = 5 쯤)로 보인다: 벽이 더 돌아 있을 수 있음. 모델은 바깥 벽의 끝(4.5 m 북서)에 붙임', '확정(있음·통로 남서 끝: 사용자 표시 사진 31), 추정(자리)', name='B2 표지')
box12('U12-B2-MIRROR', sector(R_OUT - 0.33, R_OUT - 0.25, 81.0, 84.5), Z_B1 + 1.8, Z_B1 + 2.35, '#b0672a', 'B2 표지 오른쪽의 둥근 반사경(주황 테, 네모로 줄임)', '확정(있음: 사진 31), 추정(자리·치수)')
box12('U12-BANNER', Polygon([sp(0.9, -R_OUT + 0.25), sp(2.1, -R_OUT + 0.25), sp(2.1, -R_OUT + 0.31), sp(0.9, -R_OUT + 0.31)]), Z_B1 + 1.7, Z_B1 + 2.3, '#efece6', '초록 벽(경사로 바깥 벽의 곧은 구간)에 걸린 흰 현수막("지정주차구역" 꼴). 두 사진의 방향에서 섬 중심 기준 북동 2 ±4 m', '확정(있음: 현장 사진 30·31), 추정(자리·치수)', name='현수막')
box12('U12-MURAL-WALL', Polygon([sp(HYP_S[1] - 3.5, V_HYP + 0.1), sp(HYP_S[1] - 0.3, V_HYP + 0.1), sp(HYP_S[1] - 0.3, V_HYP + 0.18), sp(HYP_S[1] - 3.5, V_HYP + 0.18)]), Z_B1, C_B1 - 0.3, '#b4aeab', '간판 벽 북동 끝 쪽의 무늬(낙서 꼴 그림) 벽: 민무늬 밝은 면으로 줄임. 사진 30 의 방향으로는 빗변의 북동 끝(섬 중심 기준 북동 31 ±4 m)', '확정(있음: 현장 사진 30), 추정(자리·크기·어느 벽인지)')

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
        # U10(사진 18·19·20·22·23): 기둥 겉모습이 층마다 다르다. 지하 1층 = 푸른 회색 바탕에 노란 세로 줄(지금 모습), 지하 2층 = 흰 네모 기둥에 초록·파랑·주황 띠. (사진 10·14·블로그-05 의 지하 1층 색 띠는 벽이 흰색이던 옛 모습으로 봄, 추정)
        box(f'U02-COLUMN-{cols:03d}', 'wall', sq, Z_B2, Z_B1, '#eceae2', f'네모 콘크리트 기둥 0.6 m, {GRID:.0f} m 격자(자리·간격 추정). 지하 2층 구간(흰색)', grade='확정(지하 2층: 흰 네모 기둥·색 띠, 사진 23), 추정(자리)', basePlane='U02-VOID-B2 바닥')
        box(f'U02-COLUMN-{cols:03d}-B1', 'wall', sq, Z_B1, C_B1, '#4f6f95', '같은 기둥의 지하 1층 구간: 푸른 회색(사진 22 의 섬 뒤 기둥, 사진 18·20)', grade='확정(지하 1층: 푸른 바탕·노란 세로 줄, 사진 18·20·22), 추정(자리)')
        box(f'U02-COLUMN-{cols:03d}-BAND-B2', 'wall', sq_at(p, 0.33), Z_B2 + 1.0, Z_B2 + 1.8, BANDS[j % 3], '지하 2층 흰 네모 기둥의 색 띠(사진 23: 초록·파랑·주황). 줄마다 한 색으로 둠(추정)')
        box(f'U02-COLUMN-{cols:03d}-STRIPE-B1', 'wall', unary_union([Polygon([p + U * a + V * (b + o_) for a, b in ((-0.33, -0.045), (0.33, -0.045), (0.33, 0.045), (-0.33, 0.045))]) for o_ in (-0.14, 0.14)] + [Polygon([p + U * (a + o_) + V * b for a, b in ((-0.045, -0.33), (0.045, -0.33), (0.045, 0.33), (-0.045, 0.33))]) for o_ in (-0.14, 0.14)]), Z_B1, Z_B1 + 1.9, '#e2b62c', '지하 1층 기둥의 노란 세로 줄(사진 18·22, 현장 사진 30·31): 면마다 두 줄')
        GUARDS += [sq_at(p + U * a + V * b, 0.05) for a in (-0.31, 0.31) for b in (-0.31, 0.31)]
FEATS.append({'type': 'Feature', 'properties': {'id': 'U12-COLUMN-GUARDS', 'type': 'wall', 'kind': 'extrude', 'estimated': True, 'grade': '확정(있음: 현장 사진 30·31), 추정(치수·기둥 자리)', 'assumption': f'지하 1층 기둥 모서리 보호대(검정·노랑, 높이 1.0 m): 기둥 {cols}개의 네 모서리', 'source': SRC_U12,
    'fromM': Z_B1, 'toM': r2(Z_B1 + 1.0), 'material': 'concrete', 'inVoid': True, 'color': '#1d1d1d', 'name': '기둥 모서리 보호대'}, 'geometry': {'type': 'MultiPolygon', 'coordinates': [ring(g_) for g_ in GUARDS]}})
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
OUTLINE = {'source': '학교 지하도 지도의 사다리꼴(georef.json xy.parking) 그대로. 운동장·건물 외곽으로 자르지 않음', 'u08AreaM2': r2(INNER_U08.area), 'b2AreaM2': r2(INNER_B2.area), 'b1AreaM2': r2(INNER.area), 'throatM2': r2(INNER.area - INNER_OLD.area), 'westExtension': None,
           'outsideFieldB1': [{'areaM2': r2(q.area), 'centre': [r2(q.centroid.x), r2(q.centroid.y)], 'maxBeyondFieldM': _far(q, FIELD)} for q in OUT_FIELD], 'outsideFieldB1M2': r2(sum(q.area for q in OUT_FIELD)), 'outsideFieldB2M2': r2(sum(q.area for q in OUT_B2)),
           'fieldNotCoveredM2': r2(FIELD.difference(INNER).area), 'underBuildings': {k: r2(v.intersection(INNER).area) for k, v in BLDS.items() if v.intersection(INNER).area > 0.5},
           'mapTrapezoidM2': r2(MAPPOLY.area), 'gainedVsU08M2': r2(INNER_B2.difference(INNER_U08).area), 'lostVsU08M2': r2(INNER_U08.difference(INNER_B2).area), 'u08Ring': [[r2(x), r2(y)] for x, y in INNER_U08.exterior.coords], 'ring': [[r2(x), r2(y)] for x, y in INNER.exterior.coords], 'fieldRing': [[r2(x), r2(y)] for x, y in FIELD.exterior.coords]}
pt = lambda p, z: {'xy': [r2(p[0]), r2(p[1])], 'z': r2(z)}
path = [pt(pol(R_C, f), z_up(S_TOE + np.radians(f) * R_C)) for f in fs[::-1]] + [pt(NB, z_up(S_TOE - S_BAND)), pt(RB, Z_B2)]; path[0] = pt(T0, Z_B1)
SYM = [np.array(q) for q in GEO['xy']['rampSymbol']]
model = {'heights': {'field': Z_FIELD, 'b1Floor': Z_B1, 'b1FloorRange': [143.0, 144.0], 'b1Ceiling': C_B1, 'b1SlabM': SLAB_B1, 'b2Ceiling': C_B2, 'b2Floor': Z_B2, 'solidAboveB1M': r2(Z_FIELD - C_B1), 'platformBottom': r2(Z_B2 - BASE), 'userLines': [144.4, 140.1, 133.0], 'storeyM': r2(Z_B1 - Z_B2), 'storeyRangeM': [3.1, 3.8], 'b2FloorU10': 133.0},
         'areaM2': r2(INNER.area), 'areaB2M2': r2(INNER_B2.area), 'areaU02M2': r2(INNER_OLD.area), 'outline': OUTLINE, 'fieldAreaM2': r2(FIELD.area), 'u01AreaM2': 8072.05, 'mapOutlineAreaM2': r2(MAPPOLY.area), 'mapOutlineOverlap': r2(MAPPOLY.intersection(INNER).area / MAPPOLY.union(INNER).area),
         'northWallInsetM': [r2(FIELD.exterior.distance(Point(NL0 + dn * s))) for s in (10, 30, 50)], 'columns': cols, 'bayRows': rows, 'georefRmsM': RES,
         'approach': {'from': pt(P0, Z_P0), 'entry': pt(E0, Z_B1), 'lengthM': r2(L_APP), 'gradePct': r2(GRADE_APP * 100), 'surfaceAboveFloorUnderWayM': [min(covers), max(covers)], 'widthM': ROAD_W,
                      'junction': pt(J0, Z_B1), 'direction': [float(D[0]), float(D[1])], 'azimuthSouthOfEastDeg': r2(np.degrees(np.arctan2(-D[1], D[0]))), 'bendAtMouthDeg': 0.0,
                      'bendAtFromDeg': {'vsRoad951c157d': r2(np.degrees(np.arctan2(-D[1], D[0])) - np.degrees(np.arctan2(557349.2 - 557327.58, 201100.3 - 201053.9))), 'vsWayDirection': r2(np.degrees(np.arccos(np.dot(D, D_WAY))))},
                      'laneEnd': pt(LANE_END, Z_B1), 'laneLengthM': LANE_L, 'buildingClipM2': r2(CLIP_BLD), 'throatAreaM2': r2(INNER.area - INNER_OLD.area), 'mapEndOffAxisM': r2(float((MAP_END - P0) @ NRM)), 'mapNwCornerOffAxisM': r2(float((MAP_NW - P0) @ NRM)),
                      'mapEndOffM': r2(np.hypot(*(E0 - MAP_END)))},
         'ramp': {'shape': 'L', 'top': pt(T0, Z_B1), 'arcStart': pt(A0, z_up(S_TOE)), 'band': pt(NB, z_up(S_TOE - S_BAND)), 'bottom': pt(RB, Z_B2), 'path': path, 'islandCentre': [r2(v) for v in ISL], 'islandRadiusM': R_ISL, 'outerRadiusM': R_OUT, 'centreRadiusM': r2(R_C), 'widthM': RAMP_W, 'clearWidthM': r2(RAMP_W - 0.4),
                  'straightM': S_TOE, 'underSlabM': r2(S_TOE - S_BAND), 'openStraightM': S_BAND, 'arcM': r2(L_ARC), 'crestAngleDeg': r2(PHI_CREST), 'outerWallEndDeg': PHI_WALL, 'lengthM': r2(L_RAMP), 'dropM': r2(DROP), 'gradePct': r2(G_RAMP * 100),
                  'rowAzimuthDeg': r2(B_ROW), 'upHeadingDeg': r2((B_ROW + 180) % 360), 'rowDirection': [float(ht[0]), float(ht[1])], 'towardHyein': [float(hn[0]), float(hn[1])], 'westWallAzimuthDeg': r2(B_WALL),
                  'belowFloorAtBandM': r2(Z_B1 - z_up(S_TOE - S_BAND)), 'clearUnderSlabAtBandM': r2(C_B2 - z_up(S_TOE - S_BAND)), 'outerWallToWestWallM': r2(INNER_OLD.exterior.distance(Point(ISL)) - R_OUT), 'doorToBandCentreM': r2(np.hypot(*(DOOR_NODE - NB))), 'doorToBandEndsM': [r2(np.hypot(*(DOOR_NODE - sp(S_BAND, -R_OUT)))), r2(np.hypot(*(DOOR_NODE - sp(S_BAND, -R_ISL))))],
                  'islandToCrescentCentreM': r2(np.hypot(*(ISL - CC))), 'crescentM2': r2(CRESCENT.area), 'openingM2': r2(opening.area), 'crescentInOpeningM2': r2(opening.intersection(CRESCENT).area), 'crescentIoU': r2(opening.intersection(CRESCENT).area / opening.union(CRESCENT).area),
                  'bandEndsToCrescentNorthEndM': [r2(np.hypot(*(sp(S_BAND, -R_OUT) - np.array(CR['northEnd']['outer'])))), r2(np.hypot(*(sp(S_BAND, -R_ISL) - np.array(CR['northEnd']['inner']))))],
                  'island': {'polygon': [[r2(x), r2(y)] for x, y in ISLAND.exterior.coords], 'wall': [[r2(x), r2(y)] for x, y in ISL_WALL.exterior.coords], 'radiusM': R_ISL},
                  'footprint': [[r2(x), r2(y)] for x, y in RAMP_FOOT.exterior.coords], 'opening': [[r2(x), r2(y)] for x, y in opening.exterior.coords], 'b2Aisle': [[r2(x), r2(y)] for x, y in strip(S_TOE, S_TOE + 19.0, -R_OUT + 0.5, -R_ISL - 0.5).exterior.coords], 'b2RightStalls': {'centre': [r2(v) for v in sp(S_TOE + 0.6 + 3.75, -R_OUT - 2.5)], 'n': 3},
                  'toeColumns': [[r2(v) for v in q] for q in TOE_COLS], 'speedBump': [r2(v) for v in sp(S_BUMP, V_C)],
                  'mapSymbol': {'source': 'docs/audit/u07/crescent.json'}},
         'points': {'C1': pt(C1, Z_B1), 'C2': pt(C2, Z_B2), 'DOOR': pt(DOOR, Z_B1), 'SBN': pt(SBN, Z_B1), 'ST': pt(ST, Z_FIELD), 'DOOR_OLD': pt(DOOR_OLD, Z_B1)},
         'office': {'ring': [[r2(x), r2(y)] for x, y in ROOM.exterior.coords], 'areaM2': r2(ROOM.area), 'hypotenuseV': V_HYP, 'hypotenuseS': [r2(v) for v in HYP_S], 'mouthS': S_MOUTH, 'hypotenuseAzimuthDeg': r2(B_ROW), 'doorMovedM': r2(np.hypot(*(DOOR - DOOR_NODE))), 'mouthToBandEndsM': [r2(np.hypot(*(DOOR - sp(S_BAND, -R_OUT)))), r2(np.hypot(*(DOOR - sp(S_BAND, -R_ISL))))], 'signColumn': [r2(v) for v in SIGN_COL]},
         'hyein': {'door': pt(HD, Z_HB1), 'l0': pt(H_L0, Z_HB1), 'f1': pt(H_F1, Z_HMID), 'l1': pt(H_L1, Z_HMID), 'bottom': pt(H_BOT, Z_B1), 'out': pt(H_OUT, Z_B1), 'via': [pt(PV1, Z_B1), pt(PV2, Z_B1)], 'dropM': r2(Z_HB1 - Z_B1), 'mapDotOffM': r2(np.hypot(*(HD - np.array(GEO['xy']['dots']['혜인관']))))},
         'eunju': {'doorMapDotOffM': r2(np.hypot(*(DOOR - DOT))), 'stairRiseM': r2(Z_FIELD - Z_B1), 'stairRunM': r2(np.hypot(*(ST - SBN)))}}
(HERE / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps(model, ensure_ascii=False)); print(len(FEATS), 'features')
