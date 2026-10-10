"""Z03: 유담관 분수 광장과 주변의 기단(땅 덩어리)과 그 위 상자를 만든다. DB·네트워크 접근 없음.
  python -I build_inputs.py
쓰는 파일:
  frontend/public/structures/z03-fountain.geojson        기단(platform) + 상자(extrude). 형식은 docs/audit/g02/STRUCTURES.md
  backend/data/terrain/recipes/z03-surface.geojson       같은 기단에서 나온 지형 조리법 surface 입력
  backend/data/terrain/recipes/z03-smooth-ground.json    조리법 = Z02 조리법 단계 + 위 surface 단계
  docs/audit/z03/model.json                              높이·치수·근거 요약, 길 끝점
좌표는 EPSG:5186 그대로 적는다(이 구역은 길이 굽어 있어 따로 축을 두지 않는다). 등급: 확정(사용자) / 원천 / S-MAP / 추정.
"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from collections import Counter
from shapely.geometry import Polygon, LineString, box as sbox
from shapely.ops import unary_union
REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'
r2 = lambda v: round(float(v), 2)
dump = lambda path, obj: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}
MESH = 'S-MAP 3D 뷰어 메시 0.5 m 판독(z03/smap-mesh-z03-plaza-05m-a~d.txt, 2026-10-11)'
ORTHO = 'S-MAP 위에서 본 화면을 편 그림(z03/smap-정사-분수광장-01m.png, 자리 ±1 m)'
P_UP, P_WIDE = '사용자 사진 유담관-분수광장-위에서.jpg', '사용자 사진 유담관-분수광장-넓게.jpg'
def SV(*n): return '거리뷰 ' + '·'.join(f'Y{k:02d}' for k in n) + '(streetview-yudam-approach-202602)'
X, Y = 201000.0, 557000.0
def pts(lst): return [(X + a, Y + b) for a, b in lst]
def big(g):
    g = g.buffer(0); return max(g.geoms, key=lambda q: q.area) if g.geom_type != 'Polygon' else g
def geom(poly):
    poly = big(poly); c = [[r2(x), r2(y)] for x, y in poly.exterior.coords]; c[-1] = c[0]
    return {'type': 'Polygon', 'coordinates': [c]}
def circle(cx, cy, r, n=32, a0=0.0, a1=360.0):
    return [(cx + r * np.cos(np.radians(a)), cy + r * np.sin(np.radians(a))) for a in np.linspace(a0, a1, n, endpoint=abs(a1 - a0) < 360)]

# ---------- 높이 ----------
Z_PLAZA = 114.1     # 확정(광장 = 유담관 6층) + S-MAP(평탄 칸 5,363개 가운데값 114.04, 사용자 핀 7개 113.9~114.2)
Z_TERR = 114.3      # S-MAP: 광장 남쪽 나무 심은 단 114.0~114.8
V2 = np.array([f for f in json.loads((HERE.parent / 'v02' / 'road-profile.geojson').read_text(encoding='utf-8'))['features'] if f['properties']['id'] == 'V2'][0]['geometry']['coordinates'])
def road_z(y): return float(np.interp(Y + y, V2[:, 1], V2[:, 2]))   # 차도 종단(V02): 이 구간은 거의 북쪽으로 올라 북좌표(557000 을 뺀 값)로 읽는다

# ---------- 평면 (S-MAP 0.5 m 메시에서 읽은 가장자리, ±1 m) ----------
_b = next(b for b in buildings() if b['name'] == '유담관')['coordinates']
while isinstance(_b[0][0], list): _b = _b[0]
BLD = Polygon(_b).buffer(0)     # 유담관 원천 외곽: 남동 끝의 둥근 선이 둥근 기단부의 벽
# 포장 띠(서쪽 보도 + 차도 + 동쪽 계단식 보도)의 서쪽·동쪽 가장자리: (북좌표, x)
RW = [(180, 86.5), (184, 85.5), (188, 84.0), (192, 83.5), (196, 82.5), (200, 82.0), (204, 82.0), (208, 82.0), (212, 83.0), (216, 84.0), (220, 84.0), (224, 83.5), (228, 82.5), (232, 82.0), (236, 82.0), (240, 82.0), (244, 82.0), (248, 82.5), (252, 81.5)]
RE = [(180, 102.0), (184, 100.0), (188, 98.0), (192, 96.5), (196, 95.5), (200, 94.5), (204, 94.5), (208, 95.5), (212, 94.0), (216, 94.5), (220, 94.0), (224, 94.0), (228, 94.0), (232, 95.0), (236, 95.5), (240, 95.0), (244, 96.0), (248, 97.0), (252, 98.0)]
def re_(y): return float(np.interp(y, [a for a, _ in RE], [b for _, b in RE]))   # 차도 띠(평평한 띠)의 동쪽 끝
W_E = 3.5   # 동쪽 계단식 보도 폭(정사 그림의 밝은 띠 x 201094~201098, S-MAP 에서 벽이 서는 x 201098.5~201099)
RE_OUT = [(y, x + (W_E if y >= 212 else 0.0)) for y, x in RE]; RE_OUT.insert(8, (211.9, 95.5))
ROAD = Polygon(pts([(x, y) for y, x in RW] + [(x, y) for y, x in RE_OUT[::-1]]))
Y_SPLIT = 214.0
ROAD_A = ROAD.intersection(sbox(X, Y + 180, X + 120, Y + Y_SPLIT)); ROAD_B = ROAD.intersection(sbox(X, Y + Y_SPLIT, X + 120, Y + 252))
# 광장: 서쪽 가장자리(바깥 길 위 18~20 m 벽의 윗선) -> 남쪽 끝 -> 동쪽 가장자리 -> 차도 쪽 출입 자리 -> 북쪽은 유담관 외곽(원천)
W_EDGE = [(41.0, 223.3), (45.5, 220.3), (51.5, 217.3), (55.0, 214.3), (59.5, 211.2), (61.5, 208.2), (63.5, 205.2), (65.5, 202.1), (67.5, 199.1), (69.5, 196.0), (71.5, 193.0), (73.0, 190.0), (73.6, 187.0), (74.0, 184.0), (75.2, 181.5), (75.5, 180.0)]
E_EDGE = [(84.3, 180.0), (83.0, 184.0), (82.3, 187.0), (81.0, 190.0), (80.4, 193.0), (79.9, 196.0), (79.0, 199.0), (78.6, 202.0), (80.3, 205.0), (80.9, 208.0), (82.3, 211.0), (83.5, 213.5), (85.0, 215.5), (85.0, 221.5), (81.0, 222.2), (80.0, 226.0), (79.0, 229.0), (78.9, 232.0), (78.5, 236.0)]
PLAZA_RAW = Polygon(pts(W_EDGE + E_EDGE + [(74.0, 240.0), (50.0, 236.0), (41.0, 227.0)]))
PLAZA = big(PLAZA_RAW.difference(BLD).difference(ROAD))
# 남쪽 나무 단(광장과 같은 높이로 이어진 좁은 쐐기, 정문 쪽으로 가늘어짐)
TERR = Polygon(pts([(75.5, 180.0), (76.0, 176.0), (77.5, 172.0), (78.5, 169.0), (83.5, 166.0), (86.0, 163.0), (87.5, 160.0), (90.0, 156.5), (93.0, 154.5), (95.0, 156.0), (92.5, 160.0), (90.5, 163.0), (89.5, 166.0), (88.0, 169.0), (87.0, 172.0), (86.0, 175.0), (85.5, 178.0), (84.3, 180.0)]))
# 둑: 광장과 포장 띠 사이. 남쪽(광장이 차도보다 높음)은 한 단, 북쪽(차도가 광장보다 높음)은 두 단
BANK_S = big(sbox(X + 74, Y + 180, X + 90, Y + 215.5).difference(unary_union([PLAZA, ROAD, TERR])))
BANK_N = big(sbox(X + 70, Y + 221.5, X + 86, Y + 250).difference(unary_union([PLAZA, ROAD, BLD])))
near_road = ROAD.buffer(2.0)
BANK_N_UP, BANK_N_LOW = big(BANK_N.intersection(near_road)), big(BANK_N.difference(near_road))

def profile(y0, y1, f, step=4.0):
    """북쪽으로 오르는 종단: origin (X+89, Y+y0), direction (0,1), points [거리, 높이]."""
    ys = list(np.arange(y0, y1, step)) + [y1]
    return {'origin': [X + 89.0, Y + y0], 'direction': [0.0, 1.0], 'points': [[r2(y - y0), r2(f(y))] for y in ys]}
def road_axis(ya, yb):
    """차도 조각의 종단: 축 = 그 조각의 V2 방향. 폭 방향으로 평평."""
    ya, yb = Y + ya, Y + yb
    pa = np.array([np.interp(ya, V2[:, 1], V2[:, 0]), ya]); pb = np.array([np.interp(yb, V2[:, 1], V2[:, 0]), yb]); d = (pb - pa) / np.hypot(*(pb - pa))
    m = (V2[:, 1] >= ya - 8) & (V2[:, 1] <= yb + 8); s = (V2[m, :2] - pa) @ d
    return {'origin': [r2(pa[0]), r2(pa[1])], 'direction': [round(float(d[0]), 4), round(float(d[1]), 4)], 'points': [[r2(a), r2(z)] for a, z in zip(s, V2[m, 2])]}

feats, surf = [], []
def platform(name, poly, top, bottom, bottom_note, material, grade, assumption, source, reason):
    pr = {'id': 'Z03-PLATFORM-' + name, 'type': 'platform', 'kind': 'platform', 'estimated': True, 'grade': grade, 'surfaceName': 'Z03-' + name,
          'bottomM': bottom, 'bottomNote': bottom_note, 'material': material, 'assumption': assumption, 'source': source}
    sp = {'name': 'Z03-' + name, 'srid': 5186, 'reason': reason, 'grade': grade, 'source': source}
    if isinstance(top, dict): pr['topProfile'] = top; sp['profile'] = top
    else: pr['topM'] = top; sp['heightM'] = top
    g = geom(poly); feats.append({'type': 'Feature', 'properties': pr, 'geometry': g}); surf.append({'type': 'Feature', 'properties': sp, 'geometry': g})
def box(id, typ, poly, fromM, toM, assumption, source, grade='추정', basePlane='Z03-PLAZA', **extra):
    g = geom(poly if isinstance(poly, Polygon) else Polygon(poly))
    feats.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra}, 'geometry': g})

# ---------- 1. 기단 ----------
V2SRC = MESH + ', docs/audit/v02/road-profile.geojson V2'
platform('ROAD-A', ROAD_A, road_axis(180, Y_SPLIT), 104.0, '옆 낮은 땅보다 아래의 안전 깊이', 'paving', 'S-MAP·사용자 핀(종단, V02), S-MAP(가장자리 ±1 m)',
         '차도와 양쪽 보도를 한 포장 띠로 본다(서쪽 보도 약 1.5 + 차도 약 7 + 동쪽 보도. 북좌표 557212 부터는 동쪽 계단식 보도 3.5 m 의 밑판까지). 폭 방향은 평평. 종단은 V02(사용자 S-MAP 핀) 그대로', V2SRC,
         'Z03 분수 광장 옆 차도 포장 띠(남쪽 조각, 북좌표 557180~557214): V02 종단 109.7 → 113.4 m, 폭 방향 평평')
platform('ROAD-B', ROAD_B, road_axis(Y_SPLIT, 252), 108.0, '광장 높이보다 아래의 안전 깊이', 'paving', 'S-MAP·사용자 핀(종단, V02), S-MAP(가장자리 ±1 m)',
         '위와 같음. 북좌표 557218~557220 에서 광장 높이 114.1 m 를 지난다', V2SRC,
         'Z03 분수 광장 옆 차도 포장 띠(북쪽 조각, 북좌표 557214~557252): V02 종단 113.4 → 119.1 m')
platform('BANK-S', BANK_S, profile(180, 215.5, lambda y: (Z_PLAZA + min(road_z(y), Z_PLAZA)) / 2), 104.0, '차도 아래의 안전 깊이', 'rock', 'S-MAP(위·아래 높이), 추정(가운데 한 단으로 줄임)',
         '광장(114.1)과 그보다 낮은 차도 사이의 돌 화단 둑과 옹벽 발치: 윗면 = 광장과 차도의 가운데 높이 한 단. 실제는 남쪽(북좌표 557180~557192)이 4 m 높이의 곧은 돌 옹벽 + 발치 돌 화단, 그 북쪽이 폭 2~3 m 의 비탈 돌 화단', MESH + ', ' + P_UP + ', ' + SV(2, 3),
         'Z03 광장 동쪽 둑(남쪽): 광장이 차도보다 0~4.4 m 높은 구간. 광장과 차도 사이를 한 단으로 받친다')
platform('BANK-N-LOW', BANK_N_LOW, profile(221.5, 250, lambda y: Z_PLAZA + (road_z(y) - Z_PLAZA) * 0.45), 110.0, '광장보다 아래의 안전 깊이', 'rock', 'S-MAP(위·아래 높이), 추정(두 단으로 나눔)',
         '차도가 광장보다 높아지는 구간의 돌 화단 둑, 아랫단: 윗면 = 광장 + 높이차의 45 %', MESH + ', ' + P_UP + ', ' + SV(4, 5, 8),
         'Z03 광장 동쪽 둑(북쪽, 아랫단): 차도가 광장보다 0.4~4.7 m 높은 구간. 유담관 둥근 기단부 벽과 보도 사이')
platform('BANK-N-UP', BANK_N_UP, profile(221.5, 250, lambda y: road_z(y) + 0.3), 110.0, '광장보다 아래의 안전 깊이', 'rock', 'S-MAP(보도 옆이 차도보다 0.3~0.4 m 높게 읽힘), 추정(폭 2 m)',
         '돌 화단 둑, 윗단(보도 옆 폭 2 m): 윗면 = 차도 + 0.3 m(보도 경계의 돌 턱과 소나무 자리)', MESH + ', ' + SV(4, 5, 8),
         'Z03 광장 동쪽 둑(북쪽, 윗단): 보도 경계 돌 턱')
platform('TERRACE-S', TERR, Z_TERR, 104.0, '차도 아래의 안전 깊이', 'rock', 'S-MAP(114.0~114.8), 추정(외곽 ±1 m, 남쪽 끝은 2 m 메시)',
         '광장 남쪽으로 가늘어지는 나무 심은 단. 동쪽은 차도 위 4~5 m 돌 옹벽(거리뷰 Y01·Y02 의 긴 어두운 돌벽), 서쪽은 바깥 길 쪽 벽. 사람이 다니는 곳인지는 모름', MESH + ', t04/smap-mesh-t04-gate-s-2m.txt, ' + SV(1, 2) + ', 사용자 핀 U023 114.1',
         'Z03 광장 남쪽 나무 단 114.3 m: 광장과 같은 높이로 이어진 쐐기')
platform('PLAZA', PLAZA, Z_PLAZA, 93.0, '서쪽 바깥 길(서경로) 지면 93.7~97 m 보다 아래. 서쪽 면은 높이 약 18~20 m 의 벽(유담관 아래층의 바깥 벽으로 보임, 추정)', 'paving', '확정(광장 = 유담관 6층 로비 앞), S-MAP(114.1 m, 가장자리 ±1 m), 원천(북쪽 경계 = 유담관 외곽)',
         '외곽: 서쪽은 S-MAP 메시에서 20 m 떨어지는 벽의 윗선, 동쪽은 114 m 평탄면이 끝나는 선, 북쪽은 유담관 원천 외곽(둥근 기단부와 유리 날개의 벽). 북좌표 557215.5~557221.5 에서 동쪽으로 내밀어 보도와 같은 높이로 만난다(출입 자리). 북좌표 557180 남쪽은 나무 단(TERRACE-S)', MESH + ', ' + ORTHO + ', ' + P_UP + ', 사용자 핀 U027·U039·U040·U041·U045, building-outlines-5186.json',
         'Z03 유담관 분수 광장 114.1 m(= 유담관 6층, 사용자 확정): 밝은 돌 포장의 평평한 슬래브. 옆 면과는 벽으로 만난다')

# ---------- 2. 상자 ----------
FX, FY = X + 73.0, Y + 203.0       # 분수 가운데(정사 그림, ±1 m. 2차 기록 (201072.6, 557204.1))
R_RIM, R_IN = 6.3, 5.85            # 바깥 지름 12.6 m(정사 그림에서 63 px), 테두리 두께 0.45(추정)
FSRC = ORTHO + ', ' + P_UP + ', 네이버 위성(08-네이버위성-유담관·공연실습소·생활관3동.webp)'
N = 24
for k in range(N):
    a0, a1 = 360 / N * k, 360 / N * (k + 1)
    box(f'Z03-FOUNTAIN-RIM-{k + 1:02d}', 'wall', circle(FX, FY, R_RIM, 2, a0, a1) + circle(FX, FY, R_IN, 2, a1, a0), Z_PLAZA, Z_PLAZA + 0.45,
        '분수 물받이 테두리(어두운 돌): 바깥 반지름 6.3 m(정사 그림), 높이 0.45 m·두께 0.45 m(사진 눈대중). 둥근 테두리를 24조각으로', FSRC, grade='S-MAP(자리·지름 ±1 m), 추정(높이)')
box('Z03-FOUNTAIN-WATER', 'landing', circle(FX, FY, R_IN, 32), Z_PLAZA - 0.3, Z_PLAZA + 0.25, '물 면: 광장 + 0.25 m(테두리보다 0.2 m 아래, 추정). S-MAP 메시는 이 자리를 113.6~113.9 m 로 읽는다(물이라 믿기 어려움)', FSRC, material='water')
for nm, r, h in (('TIER1', 3.8, 0.75), ('TIER2', 2.2, 1.45), ('TIER3', 1.0, 2.2)):
    box(f'Z03-FOUNTAIN-{nm}', 'planter', circle(FX, FY, r, 24), Z_PLAZA, Z_PLAZA + h, f'분수 단({nm}): 반지름 {r} m(정사 그림의 고리), 윗면 광장 + {h} m(사진에서 물줄기 받침이 세 단으로 높아짐, 눈대중)', FSRC)
# 굽은 열주: 분수 가운데에서 반지름 12 m 원호(북서~북북동), 기둥 7개(사진에서 셈), 윗보
R_COL, A0, A1, NCOL, H_COL, H_LINTEL = 12.0, 66.0, 155.0, 7, 4.3, 0.6
CSRC = P_UP + '(기둥 7개가 보임), ' + ORTHO + '(원호 자리), ' + SV(8)
angs = np.linspace(A1, A0, NCOL)
for k, a in enumerate(angs):
    c = (FX + R_COL * np.cos(np.radians(a)), FY + R_COL * np.sin(np.radians(a)))
    box(f'Z03-COLONNADE-COL-{k + 1}', 'wall', circle(c[0], c[1], 0.35, 8), Z_PLAZA, Z_PLAZA + H_COL, f'열주 기둥 {k + 1}/7(흰 둥근 기둥, 서쪽부터): 지름 0.7 m, 높이 {H_COL} m(옆 사람 키의 2.5배, 눈대중). 기둥 수 7 은 사진에서 센 값, 간격 3.1 m 는 원호 길이를 고르게 나눈 것', CSRC, grade='S-MAP(원호 자리 ±1 m), 추정(수·치수)', material='white-stone')
for k in range(NCOL - 1):
    a, b = angs[k] + 1.5, angs[k + 1] - 1.5
    box(f'Z03-COLONNADE-LINTEL-{k + 1}', 'canopy', circle(FX, FY, R_COL + 0.45, 4, a, b) + circle(FX, FY, R_COL - 0.45, 4, b, a), Z_PLAZA + H_COL, Z_PLAZA + H_COL + H_LINTEL, f'열주 윗보(굽은 흰 보) {k + 1}/6: 폭 0.9 m, 두께 {H_LINTEL} m(눈대중)', CSRC, basePlane='Z03-COLONNADE-COL', material='white-stone')
for k in range(NCOL - 1):
    a = (angs[k] + angs[k + 1]) / 2; c = (FX + 10.0 * np.cos(np.radians(a)), FY + 10.0 * np.sin(np.radians(a)))
    box(f'Z03-PLANTER-{k + 1}', 'planter', sbox(c[0] - 0.4, c[1] - 0.4, c[0] + 0.4, c[1] + 0.4), Z_PLAZA, Z_PLAZA + 0.5, '열주 안쪽의 네모 돌 화분(붉은 꽃): 0.8 m 각, 높이 0.5 m. 사진에서 기둥 사이마다 하나씩 6개로 보임. 자리는 기둥 사이 가운데에서 분수 쪽 2 m(눈대중)', P_UP)
# 유리 차양(6층 로비 입구): 둥근 기단부 남쪽 벽에서 광장 쪽으로. 정사 그림의 부채꼴(높이 5 m 라 0.5~1 m 밀려 보임)을 벽 쪽으로 붙임
CAN = Polygon(pts([(61.0, 231.5), (65.1, 231.0), (70.3, 233.0), (77.6, 234.0), (78.4, 226.3), (62.3, 224.4)])).difference(BLD)
box('Z03-CANOPY-GLASS', 'canopy', CAN, Z_PLAZA + 5.0, Z_PLAZA + 5.4, '6층 로비 입구 유리 차양: 폭 약 16 m, 내민 길이 약 6~7 m(정사 그림의 부채꼴), 높이 광장 + 5.0 m·두께 0.4 m(눈대중: 로비층 유리 높이 아래). 기둥 자리·수는 눈대중', ORTHO + ', ' + P_UP + ', ' + P_WIDE + ', ' + SV(4, 5), grade='S-MAP(평면 ±1.5 m), 추정(높이)', material='glass')
for k, (cx, cy) in enumerate(pts([(63.2, 225.3), (68.2, 225.9), (73.2, 226.5), (77.7, 227.0)])):
    box(f'Z03-CANOPY-COL-{k + 1}', 'wall', circle(cx, cy, 0.3, 8), Z_PLAZA, Z_PLAZA + 5.0, '차양 앞줄 기둥(흰 둥근 기둥, 4개로 봄): 지름 0.6 m', P_UP + ', ' + SV(3, 4, 5), material='white-stone')
# 둥근 돌 기단부(유담관 6~9층, 옥상 정원): 원천 외곽의 둥근 남동 끝에서 탑(건물 노트의 부분)을 뺀 초승달. S-MAP 에 이 덩어리의 면이 없어 높이는 추정 -> 건물 자료가 아니라 여기 상자로 둔다
import yaml
_head = yaml.safe_load((VAULT / '모델링 개선' / '건물' / '유담관.md').read_text(encoding='utf-8').split(chr(10) + '---', 1)[0][3:])
PARTS = unary_union([Polygon(q['외곽']['좌표'][0]) for q in _head['부분'] if str(q.get('모델_반영', '')).startswith('예')])
DRUM = big(BLD.intersection(sbox(X + 53.2, Y + 221, X + 80, Y + 251.5)).difference(PARTS.buffer(0.05)))
Z_DRUM = 133.0   # 추정: 9층 바닥 129.2(건물 노트) + 한 층 3.77. 사진에서 유리 로비층 위 창 줄 3개 = 7·8·9층으로 읽음. 창 줄을 2개 층으로 읽으면 129.2
box('Z03-YUDAM-DRUM', 'wall', DRUM, Z_PLAZA, Z_DRUM, '유담관 둥근 돌 기단부(6층 로비 + 창 줄 3개, 위는 소나무 옥상 정원): 평면 = 원천 외곽의 둥근 남동 끝에서 탑 부분을 뺀 초승달(원천·S-MAP), 윗면 133.0 m 는 추정(9층 바닥 129.2 + 한 층 3.77. 창 줄을 달리 읽으면 129.2). S-MAP 은 이 덩어리를 싣지 않았다(그 자리를 114~124 m 땅으로 읽음). 건물인데 높이 등급이 추정이라 건물 보정 파일에 넣지 못하고 여기 둔다',
    P_UP + ', ' + P_WIDE + ', ' + SV(3, 4, 5) + ', building-outlines-5186.json, docs/audit/z03/tower-se.json', grade='원천(둥근 외곽), S-MAP(탑 쪽 경계), 추정(높이)', material='stone', building='유담관')
DOOR = (X + 67.7, Y + 231.2)   # 회전문: 차양 가운데의 벽 자리(추정 ±3 m). 학교 표지 입구(1)은 (201057.2, 557234.5)
# 출입 자리(보도 ↔ 광장)의 붉은 말뚝 3개
for k, yy in enumerate((217.3, 218.5, 219.7)):
    box(f'Z03-ENTRY-BOLLARD-{k + 1}', 'barrier', sbox(X + 84.2, Y + yy - 0.15, X + 84.5, Y + yy + 0.15), Z_PLAZA, Z_PLAZA + 0.7, '보도에서 광장으로 들어가는 자리의 붉은 말뚝(3개로 보임). 자리는 정사 그림의 어두운 네모와 과속방지턱 바로 아래(±2 m)', SV(5, 8) + ', ' + ORTHO)
# 난간: 광장 동쪽 가장자리(차도보다 높은 구간)와 서쪽 가장자리(바깥 길 위 벽)
def rail(id_, line, assumption, source):
    ln = LineString(line); n = max(1, int(np.ceil(ln.length / 4.0)))
    for k in range(n):
        seg = LineString([ln.interpolate(ln.length * k / n), ln.interpolate(ln.length * (k + 1) / n)])
        box(f'{id_}-{k + 1:02d}', 'wall', seg.buffer(0.08, cap_style=2), Z_PLAZA, Z_PLAZA + 1.1, assumption, source)
rail('Z03-RAIL-E', pts(E_EDGE[:12]), '광장 동쪽 가장자리의 검은 난간(광장이 차도·둑보다 높은 구간): 높이 1.1 m(가정)', P_UP)
rail('Z03-PARAPET-W', pts(W_EDGE), '광장 서쪽 가장자리(바깥 길 위 18~20 m 벽)의 난간 벽: 높이 1.1 m(가정). 사진에서는 나무에 가려 형태 미확인', P_UP + ', ' + MESH)
# 동쪽 계단식 보도(포장 띠의 동쪽 3.5 m): 계단 6단 + 참을 되풀이. 단 수는 세지 않고 높이차에서 계산
RISE, RUN, NR = 0.155, 0.35, 6
y = 212.0; k = 0; flights = []
grid_y = np.arange(205, 262, 0.25); grid_z = np.array([road_z(v) for v in grid_y])
while y + NR * RUN < 249.0:
    base = road_z(y); k += 1
    for s in range(NR):
        ya, yb = y + s * RUN, y + (s + 1) * RUN
        box(f'Z03-EAST-STAIR-F{k}-S{s + 1:02d}', 'stair_step', Polygon(pts([(re_(ya), ya), (re_(ya) + W_E, ya), (re_(yb) + W_E, yb), (re_(yb), yb)])), base - 0.1, base + (s + 1) * RISE,
            f'동쪽 계단식 보도의 계단 묶음 {k}: {NR}단 x {RISE} m, 디딤 {RUN} m, 폭 {W_E} m(모두 가정). 묶음과 참의 수·자리는 사진에서 세지 않았다(차도 경사 약 15 % 에 맞춰 되풀이)', SV(3, 4, 5, 6, 7), basePlane='Z03-ROAD-B', stair=f'Z03-EAST-STAIR-F{k}', riseM=RISE, runM=RUN, widthM=W_E)
    top = base + NR * RISE; y1 = y + NR * RUN
    y2 = min(float(np.interp(top, grid_z, grid_y)), 250.0)   # 참은 차도가 그 높이에 닿는 곳까지
    box(f'Z03-EAST-LANDING-{k}', 'landing', Polygon(pts([(re_(y1), y1), (re_(y1) + W_E, y1), (re_(y2) + W_E, y2), (re_(y2), y2)])), base - 0.1, top, f'계단 묶음 {k} 위의 참(벤치가 놓인 넓은 포장면): 길이 {y2 - y1:.1f} m, 차도가 같은 높이에 닿는 곳까지(가정)', SV(4, 5, 8), basePlane='Z03-ROAD-B')
    flights.append({'flight': k, 'y0': r2(y), 'y1': r2(y1), 'landingTo': r2(y2), 'baseM': r2(base), 'topM': r2(top)}); y = y2
dump(REPO / 'frontend' / 'public' / 'structures' / 'z03-fountain.geojson', {'type': 'FeatureCollection', 'name': 'z03-fountain', 'crs': CRS,
  'provenance': {'builder': 'docs/audit/z03/build_inputs.py', 'basePlanes': 'backend/data/terrain/recipes/z03-surface.geojson', 'schema': 'docs/audit/g02/STRUCTURES.md',
                 'note': '기단 윗면 높이는 S-MAP·사용자 핀, 평면은 S-MAP 0.5 m 메시(±1 m). 상자 치수는 사진 눈대중이라 전부 estimated.'}, 'features': feats})
dump(REC / 'z03-surface.geojson', {'type': 'FeatureCollection', 'name': 'z03-surface', 'crs': CRS, 'features': surf})
z02 = json.loads((REC / 'z02-smooth-ground.json').read_text(encoding='utf-8'))
dump(REC / 'z03-smooth-ground.json', {'crs': 'EPSG:5186', 'protectBuildings': True,
  'reason': 'Z03: Z02 조리법에 유담관 분수 광장과 주변의 기단을 더함: 광장 슬래브 114.1 m, 남쪽 나무 단 114.3 m, 광장 옆 차도 포장 띠(V02 종단, 두 조각), 광장과 차도 사이 둑(남쪽 한 단, 북쪽 두 단). 지형 칸은 구조물 파일(frontend/public/structures/z03-fountain.geojson)의 기단 윗면에서 나온다. 분수·열주·차양·난간·계단식 보도는 구조물 파일이 싣는다.',
  'steps': z02['steps'] + [{'type': 'surface', 'file': 'z03-surface.geojson'}]})
ENTRY = (X + 84.6, Y + 218.5)
dump(HERE / 'model.json', {'crs': 'EPSG:5186', 'heights': {'plaza': Z_PLAZA, 'terraceS': Z_TERR, 'roadAtEntry': r2(road_z(218.5)), 'roadAtFountain': r2(road_z(203)), 'roadAtNorthEnd': r2(road_z(250))},
  'fountain': {'centre': [FX, FY], 'rimRadiusM': R_RIM, 'grade': 'S-MAP 정사 그림 ±1 m'}, 'colonnade': {'radiusM': R_COL, 'fromDeg': A0, 'toDeg': A1, 'columns': NCOL, 'grade': '추정(사진에서 셈)'},
  'areas_m2': {f['properties']['id']: round(Polygon(f['geometry']['coordinates'][0]).area, 1) for f in feats if f['properties']['kind'] == 'platform'},
  'door6F': {'xy': [r2(DOOR[0]), r2(DOOR[1])], 'z': Z_PLAZA, 'grade': '추정(차양 가운데, ±3 m)'}, 'entry': {'xy': [r2(ENTRY[0]), r2(ENTRY[1])], 'z': Z_PLAZA, 'grade': 'S-MAP(광장과 보도가 같은 높이인 자리) + 거리뷰 Y05·Y08(붉은 말뚝)'},
  'eastStair': {'riseM': RISE, 'runM': RUN, 'risersPerFlight': NR, 'flights': flights, 'grade': '추정'},
  'counts': {'platform': sum(f['properties']['kind'] == 'platform' for f in feats), 'extrude': sum(f['properties']['kind'] == 'extrude' for f in feats)}})
print(Counter(f['properties']['type'] for f in feats)); print({f['properties']['id']: round(Polygon(f['geometry']['coordinates'][0]).area) for f in feats if f['properties']['kind'] == 'platform'}); print('flights', len(flights), flights[-1])
