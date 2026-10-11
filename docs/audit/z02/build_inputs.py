"""Z02: 대일관 정면·운동장 북쪽 가장자리의 기단(땅 덩어리)과 그 위 상자를 만든다. DB·네트워크 접근 없음.
  python build_inputs.py
쓰는 파일:
  frontend/public/structures/z02-daeil-front.geojson     기단(platform) + 상자(extrude). 형식은 docs/audit/g02/STRUCTURES.md
  backend/data/terrain/recipes/z02-surface.geojson       같은 기단에서 나온 지형 조리법 surface 입력
  backend/data/terrain/recipes/z02-smooth-ground.json    조리법 = G02 조리법 단계 + 위 surface 단계
  docs/audit/z02/model.json                              높이·치수·근거 요약, 길 끝점
좌표는 대일관 정면 벽 축 (u, v) 로 적고 EPSG:5186 으로 옮긴다(common.py): u = 벽을 따라 동쪽, v = 벽에서 운동장 쪽.
등급: 확정(사용자) / S-MAP / 추정.
"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union
REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'
r2 = lambda v: round(float(v), 2)
def ring(uv):
    p = [[r2(x), r2(y)] for x, y in (uv_to_xy(u, v) for u, v in uv)]; return p + [p[0]]
def rect(u0, u1, v0, v1): return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
dump = lambda path, obj: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}
MESH = 'S-MAP 메시(g02/smap-mesh-g02-way-05m-d.txt 0.5 m, b09/smap-mesh-b09-sangseung-1m.txt 1 m)'
P13, P14, P18, P23, P24, P27 = ('사용자 사진 13', '사용자 사진 14', '사용자 사진 18', '사용자 사진 23', '사용자 사진 24', '사용자 사진 27')
FRONT, CLOSE = '대일관-운동장에서-정면.webp', '대일관-현관-계단-가까이.webp'

# ---------- 높이 ----------
Z_FIELD = 148.9      # 측정(E06)
Z_ENT = 151.3        # 추정(Z06): 계단 위 참. 운동장 + 13단 x 0.185. 사진(현관-계단-가까이)을 다시 세면 참까지 13단, 그 위 아치 밑에 2~3단이 더 있다. 높은 띠 151.3(S-MAP·사용자 핀)과 같은 높이라 데크로 그대로 걸어 들어간다(사용자: 그대로 또는 1~2칸)
Z_1F = 151.8         # S-MAP: 1층 복도(입구(2) 151.7, 뒷문 152.0). 참에서 아치 밑 3단(추정) 위가 1층 로비 바닥
Z_PASS = 151.3       # 추정: S-MAP 151.0~151.8, 사용자 핀 151.3 / 151.6, 현관 앞에서 0~2칸(확정) -> 2칸
Z_PLANT = 150.2      # S-MAP 화단 윗면 150.1~150.2 (한 곳), 나머지 추정
Z_PLAZA = 151.0      # S-MAP 150.9~151.0
Z_YARD = 153.1       # S-MAP 152.9~153.3 (60칸)
Z_TOP = 145.5        # G02 기단 TOP (대일관 서쪽 끝 앞 평탄부)
RISE13 = (Z_ENT - Z_FIELD) / 13

# ---------- 평면 치수 (u, v) ----------
PORCH_ROOF = (-5.0, 8.4, 5.0)          # S-MAP 건물 모델의 낮은 지붕: u -5.0~8.4, 벽에서 5.0 m
BOX = (-2.9, 6.3, 4.0)                 # 벽돌 상자(추정: 지붕 폭의 0.69 = 사진 폭 비)
BAY_V = 1.9                            # 벽이 1.8~2.1 m 앞으로 나온 구간(u < 0)
def wall_v(u): return BAY_V if -14.6 <= u < 0 else (1.67 if 40.1 <= u <= 54.0 else 0.0)
ST_U = (-3.6, 7.0); ST_TOP, RUN = 6.2, 0.30   # 넓은 계단: 폭 10.6 m(추정), 위 끝 v 6.2, 디딤 0.30
ST_BOT = ST_TOP + 12 * RUN                    # 9.8: S-MAP 에서 148.9 가 되는 곳(v 9~10)
ENT_U = (-5.6, 8.4)
PASS_V, PASS_V_E = 2.5, 3.6           # 통로 바깥 가장자리(본 구간 폭 2.5, 동쪽 돌출 구간 폭 1.9)
PL_V = 6.3                            # 흰 화단 벽 선(S-MAP 평지 가장자리 v 6~7 에서 뭉개진 몫 0.5 를 뺌)
E_U = (54.2, 58.6); E_TOP = PL_V - 12 * RUN   # 동쪽 끝 계단: 폭 4.4 m(추정), 아래 v 6.3, 위 v 2.7
R_U0, R_V = 57.3, (-2.0, 2.0)         # 오른쪽 계단: 광장에서 동쪽으로 오름

B = {b['name']: Polygon(b['coordinates'][0] if isinstance(b['coordinates'][0][0][0], (int, float)) else b['coordinates'][0][0]) for b in buildings()}
BLD = unary_union([B['대일관'].buffer(0), B['청운관'].buffer(0)])
def P(uv): return Polygon([tuple(uv_to_xy(u, v)) for u, v in uv])
def geom(poly):
    poly = poly.buffer(0)
    if poly.geom_type != 'Polygon': poly = max(poly.geoms, key=lambda g: g.area)
    c = [[r2(x), r2(y)] for x, y in poly.exterior.coords]; c[-1] = c[0]
    return {'type': 'Polygon', 'coordinates': [c]}

feats, surf = [], []
NARROW = '없음(폭 1.9~2.5 m 로 지형 격자 2 m 한 칸보다 좁아 지형에 싣지 않음. 아래 기단 Z02-PLATFORM-APRON 의 칸이 그대로 남고 형상은 이 기단이 싣는다)'
def platform(name, poly, top, bottom, bottom_note, material, grade, assumption, source, reason, terrain=True):
    g = geom(poly)
    feats.append({'type': 'Feature', 'properties': {'id': 'Z02-PLATFORM-' + name, 'type': 'platform', 'kind': 'platform', 'estimated': True, 'grade': grade, 'surfaceName': 'Z02-' + name if terrain is True else NARROW if terrain == 'narrow' else 'field (f05-plateaus.geojson)',
        'topM': top, 'bottomM': bottom, 'bottomNote': bottom_note, 'material': material, 'assumption': assumption, 'source': source}, 'geometry': g})
    if terrain is True: surf.append({'type': 'Feature', 'properties': {'name': 'Z02-' + name, 'srid': 5186, 'heightM': top, 'reason': reason, 'grade': grade, 'source': source}, 'geometry': g})
def box(id, typ, uv, fromM, toM, base, grade, assumption, source, **extra):
    feats.append({'type': 'Feature', 'properties': {'id': 'Z02-' + id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra},
                  'geometry': {'type': 'Polygon', 'coordinates': [ring(uv)]}})

# ---------- 1. 기단 ----------
field = json.loads((REPO / 'docs/audit/e10/field-area-f05.geojson').read_text(encoding='utf-8'))
fgeo = (field['features'][0] if 'features' in field else field)['geometry'] if field.get('type') != 'Polygon' else field
platform('FIELD', Polygon(fgeo['coordinates'][0]), Z_FIELD, 132.0, '운동장 지하 2층 바닥(133.0 m, 사용자 표시 ±1) 아래 기초 판 1.0 m(U02). 지하 1층·2층은 u01-field-basement.geojson 의 빈 곳', 'paving', '측정(높이 148.9 m: E06), S-MAP(외곽: F05 곧은 변 22개)',
         '외곽은 F05 운동장 영역 그대로(다시 그리지 않음). 북쪽 변은 화단 벽 선과 최대 2 m 어긋난다(위에 얹은 화단 상자가 덮는다)', 'docs/audit/e10/field-area-f05.geojson, 실험 E06', '', terrain=False)
apron = P([(-9.5, -0.5), (40.0, -0.5), (40.0, 1.3), (53.9, 1.3), (53.9, -4.8), (58.2, -4.8), (60.5, -0.6), (64.0, 8.2), (64.0, 10.5), (-9.5, 10.5)])
platform('APRON', apron, Z_FIELD, 141.0, '옛 지형(141.6 m)보다 아래의 안전 깊이', 'paving', '측정(높이: 운동장과 같은 슬래브), 추정(외곽)',
         '운동장 슬래브를 대일관 정면 벽까지 이은 바닥 기단. 현관 단·통로·광장·화단·계단은 모두 이 위에 얹는다. 서쪽 끝(u −9.5)은 G02 길 경사면 기단과 맞닿는다', MESH,
         'Z02 운동장 슬래브를 대일관 정면 벽까지 이음(148.9 m). 그 위의 단은 뒤의 기단이 덮는다. 옛 지형이 141~148 m 로 남아 골처럼 보이던 자리.')
ent = P([(ENT_U[0], BAY_V - 0.2), (-0.1, BAY_V - 0.2), (0.0, -0.2), (ENT_U[1], -0.2), (ENT_U[1], ST_TOP), (ENT_U[0], ST_TOP)])
platform('ENTRANCE', ent, Z_ENT, Z_FIELD, '바닥 기단 Z02-PLATFORM-APRON 윗면', 'paving', '추정(높이 151.3 ±0.3 = 운동장 + 13단), S-MAP(자리: 현관 지붕 아래와 앞), 추정(외곽 ±1 m)',
         '현관 단(문 앞 바닥). 현관 지붕 아래 바닥과 계단 위 참을 한 평면으로 봄. 깊이 = 벽에서 6.2 m(계단 13단이 v 9.8 에서 끝나도록)', f'{CLOSE}, {P18}, {MESH}',
         'Z02 대일관 현관 단(계단 위 참) 151.3 m (운동장 + 13단, 추정 ±0.3). 1층 로비 바닥 151.8 m 는 아치 밑 3단 위(상자).')
pas = P([(ENT_U[1], -0.2), (40.0, -0.2), (40.1, 1.47), (54.0, 1.47), (54.0, PASS_V_E), (40.1, PASS_V_E), (40.1, PASS_V), (ENT_U[1], PASS_V)])
platform('PASSAGE', pas, Z_PASS - 0.05, Z_FIELD, '바닥 기단 Z02-PLATFORM-APRON 윗면', 'concrete', '확정(있음, 운동장보다 2 m 이상 높음, 양 끝: 사용자 그림 02), S-MAP·사용자 핀(높이 151.0~151.8 범위), 추정(151.3 으로 고른 것, 폭)',
         '높은 가장자리 길의 몸통(옹벽 + 채움). 길이 방향으로 평평하다(S-MAP 벽 앞 값이 u 10~40 에서 ±0.15 m). 높이는 현관 참과 같은 높이(사용자: 그대로 또는 1~2칸. Z06 에서 그대로로 고름). 폭 2.5 m(동쪽 돌출 구간 1.9 m)',
         f'사용자 그림 02, {P14}, 사진 6(핀 151.3 / 151.6), {MESH}', '', terrain='narrow')
plaza = P([(54.0, -4.6), (58.3, -4.6), (59.6, -2.2), (R_U0, -2.2), (R_U0, E_TOP), (54.0, E_TOP)])
platform('PLAZA', plaza, Z_PLAZA, Z_FIELD, '바닥 기단 Z02-PLATFORM-APRON 윗면', 'paving', 'S-MAP(높이 150.9~151.0), 추정(외곽 ±1.5 m)',
         '동쪽 끝 계단을 올라선 작은 광장. 외곽은 대일관 동쪽 끝 벽과 계단 사이', f'{MESH}, 사용자 그림 07, {P23}', 'Z02 대일관·청운관 사이 작은 광장 151.0 m.')
yard_raw = P([(R_U0 + 12 * RUN, R_V[0]), (62.5, R_V[0]), (62.5, 2.0), (R_U0 + 12 * RUN, 2.0)]).union(P([(57.0, -19.5), (66.0, -19.5), (66.0, -1.0), (57.0, -1.0)]))
annex = Polygon([(201195.62, 557327.77), (201221.91, 557315.41), (201218.54, 557306.02), (201216.83, 557307.19), (201216.71, 557306.86), (201191.55, 557318.68)])
yard = yard_raw.difference(B['대일관'].buffer(0).union(annex)).difference(B['청운관'].buffer(0).difference(P([(60, -3), (63, -3), (63, 2.5), (60, 2.5)])))
platform('YARD', yard, Z_YARD, Z_FIELD, '바닥 기단 높이(148.9 m). 북쪽 뒤편 땅도 S-MAP 148.9 m', 'paving', 'S-MAP(높이 152.9~153.3, 60칸), 확정(상승관으로 가는 안쪽 자리: 사용자 그림 07), 추정(외곽 = 건물 외곽 사이)',
         '대일관 동쪽 끝과 청운관 사이 안쪽 마당. 남쪽 끝 한 조각(약 6 ㎡)은 청운관 원천 외곽 안이지만 S-MAP 은 그 자리를 153.1 m 땅으로 읽는다(청운관 열린 돌출부 아래 단으로 보임, 추정)', f'{MESH}, 사용자 그림 07·13, b09/상승관-사용자그림-좌표.png',
         'Z02 대일관·청운관 사이 안쪽 마당 153.1 m (상승관 앞).')

# ---------- 2. 현관 돌출부 (B2) ----------
SRCP = f'{P18}, {CLOSE}, {P13}, {MESH} (낮은 지붕 처마 155.8 / 용마루 158.0)'
EN = 'Z02-PLATFORM-ENTRANCE'
piers = [(-2.9, -1.9), (1.1, 2.3), (5.3, 6.3)]
for k, (a, b) in enumerate(piers):
    box(f'PORCH-PIER-{k + 1}', 'wall', rect(a, b, 3.4, BOX[2]), Z_ENT, 155.2, EN, 'S-MAP(자리), 추정(치수)', '현관 앞면 벽돌 기둥. 아치 문 둘(폭 3.0 m, 추정)은 기둥 사이의 빈 곳. 벽돌 상자 폭 9.2 m = 지붕 폭 13.4 m x 사진의 폭 비 0.69', SRCP, material='brick')
box('PORCH-HEADER', 'wall', rect(BOX[0], BOX[1], 3.4, BOX[2]), 154.2, 155.2, '없음(기둥 위에 걸침)', '추정', '아치 위 벽돌 벽. 아치 꼭대기 154.2 m(바닥 + 3.2 m, 사진 눈대중). 아치의 둥근 모양은 싣지 않음', SRCP, material='brick')
# Q01: 서쪽 옆은 막힌 벽이 아니라 아치로 뚫려 있다(사용자-SP카페·대일관계단·3생활관-20261012/03: 내려가는 계단 머리에서 본 현관, 회색 기와지붕 밑의 벽돌 아치). 아치 위 벽과 앞 모서리의 기둥만 둔다
box('PORCH-SIDE-W', 'wall', [(BOX[0], BAY_V), (BOX[0] + 0.6, BAY_V), (BOX[0] + 0.6, 3.4), (BOX[0], 3.4)], 154.0, 155.2, '없음(아치 위에 걸침)', '원천(서쪽 옆이 아치로 뚫림: 사용자 사진 03), 추정(치수)', '현관 서쪽 옆의 아치 위 벽돌 벽(아래는 뚫림: 옆 계단에서 현관으로 들어옴)', SRCP + ', 사용자-SP카페·대일관계단·3생활관-20261012/03-SP카페-사용자표시-대일관-계단.png', material='brick')
box('PORCH-SIDE-W-HEAD', 'wall', [(BOX[0], BAY_V), (BOX[0] + 0.6, BAY_V), (BOX[0] + 0.6, BAY_V + 0.25), (BOX[0], BAY_V + 0.25)], 153.5, 154.0, 'Z02-PORCH-SIDE-W', '추정', '아치 머리의 어깨(계단 모양 조각, 건물 쪽)', SRCP, material='brick')
box('PORCH-SIDE-W-HEAD-2', 'wall', [(BOX[0], 3.15), (BOX[0] + 0.6, 3.15), (BOX[0] + 0.6, 3.4), (BOX[0], 3.4)], 153.5, 154.0, 'Z02-PORCH-SIDE-W', '추정', '아치 머리의 어깨(계단 모양 조각, 앞쪽)', SRCP, material='brick')
box('PORCH-SIDE-E', 'wall', rect(BOX[1] - 0.6, BOX[1], 0.0, 3.4), Z_ENT, 155.2, EN, '추정', '현관 동쪽 옆벽(막혔는지 뚫렸는지 사진으로 확인 못 함)', SRCP, material='brick')
for k in range(1, 3):
    box(f'PORCH-INNER-STEP-{k}', 'stair_step', rect(BOX[0] + 0.6, BOX[1] - 0.6, 3.4 - 0.3 * k, 3.4 - 0.3 * (k - 1)), Z_ENT, Z_ENT + (Z_1F - Z_ENT) * k / 3, EN, '추정(단 수 3: 사진에 아치 밑 2~3단), S-MAP(1층 151.8)', '아치 밑에서 1층 로비 바닥으로 오르는 3단 중 아래 두 단(한 단 0.167 m, 디딤 0.30 m)', SRCP, stair='Z02-PORCH-INNER-STAIR', riseM=r2((Z_1F - Z_ENT) / 3), runM=0.3, widthM=r2(BOX[1] - BOX[0] - 1.2), material='stone')
box('PORCH-FLOOR-1F', 'landing', [(BOX[0] + 0.6, BAY_V), (0.0, BAY_V), (0.0, 0.0), (BOX[1] - 0.6, 0.0), (BOX[1] - 0.6, 2.8), (BOX[0] + 0.6, 2.8)], Z_ENT, Z_1F, EN, 'S-MAP(1층 151.8), 추정(범위)', '현관 안 1층 로비 바닥 151.8 m(문·실내 길과 같은 높이). 대일관 노트의 0.8 m 차를 계단 위 참 151.3 + 아치 밑 3단으로 풂(Z06, 추정)', SRCP, material='stone')
roof = lambda i: [(PORCH_ROOF[0] + i, BAY_V), (0.0, BAY_V), (0.0, 0.0), (PORCH_ROOF[1] - i, 0.0), (PORCH_ROOF[1] - i, PORCH_ROOF[2] - i), (PORCH_ROOF[0] + i, PORCH_ROOF[2] - i)]
box('PORCH-EAVE', 'canopy', roof(0), 155.2, 155.8, '없음(벽돌 상자 위)', 'S-MAP(외곽·처마 155.8), 추정(두께)', '흰 처마 띠. 외곽은 S-MAP 건물 모델의 낮은 지붕 칸(u −5.0~8.4, 벽에서 5.0 m)', SRCP, material='stone')
box('PORCH-ROOF-1', 'canopy', roof(1.0), 155.8, 156.9, 'Z02-PORCH-EAVE', 'S-MAP(높이), 추정(계단식으로 줄인 것)', '기와 경사 지붕을 두 단 상자로 줄임(평평한 윗면만 그릴 수 있어서). 처마 155.8 → 용마루 158.0', SRCP, material='roof_tile')
box('PORCH-ROOF-2', 'canopy', roof(2.0), 156.9, 158.0, 'Z02-PORCH-ROOF-1', 'S-MAP(높이), 추정(계단식으로 줄인 것)', '기와 경사 지붕 윗단. 용마루 158.0 m 는 벽 쪽', SRCP, material='roof_tile')

# ---------- 3. 현관 앞 넓은 계단 (B3) + 옆벽 (B4) ----------
AP = 'Z02-PLATFORM-APRON'
for k in range(1, 13):
    box(f'FRONT-STAIR-S{k:02d}', 'stair_step', rect(ST_U[0], ST_U[1], ST_BOT - RUN * k, ST_BOT - RUN * (k - 1)), Z_FIELD, Z_FIELD + RISE13 * k, AP, '추정(13단 ±1: 사진에서 셈), 측정(아래 148.9)',
        f'현관 앞 넓은 돌계단: 13단(디딤판 12 + 현관 단), 한 단 {RISE13:.4f} m, 디딤 0.30 m(가정), 폭 10.6 m(사진 눈대중), 곧은 한 줄', f'{CLOSE}, {P18}, 건물 노트 대일관(13단)', stair='Z02-FRONT-STAIR', riseM=r2(RISE13), runM=RUN, widthM=r2(ST_U[1] - ST_U[0]), material='stone')
for side, (a, b) in (('W', (ST_U[0] - 0.5, ST_U[0])), ('E', (ST_U[1], ST_U[1] + 0.5))):
    for j, (v0, v1, top) in enumerate([(ST_TOP, ST_TOP + 1.8, Z_ENT + 0.5), (ST_TOP + 1.8, ST_BOT, Z_PLANT + 0.1)]):
        box(f'FRONT-STAIR-CHEEK-{side}{j + 1}', 'wall', rect(a, b, v0, v1), Z_FIELD, top, AP, '추정', '계단 옆벽(흰 돌). 실제는 비스듬한데 두 단으로 줄임', f'{CLOSE}, {P18}', material='white_stone')

# ---------- 4. 화단 (B5), 통로 데크·난간 (B7, B8) ----------
PH = f'{FRONT}, {P18}, {P24}, {MESH}'
box('PLANTER-W1', 'planter', rect(ENT_U[0], ST_U[0] - 0.5, ST_TOP, 8.6), Z_FIELD - 1.0, Z_PLANT + 0.1, AP, '추정', '계단 서쪽 화단(철쭉). 서쪽으로 층층이 낮아지는 것을 두 덩어리로 줄임', f'{CLOSE}, {P18}', material='white_stone')
box('PLANTER-W2', 'planter', rect(-9.5, ENT_U[0], 4.7, 8.0), Z_FIELD - 1.5, 149.6, AP, '추정', '계단 서쪽 화단의 낮은 단. G02 길 경사면(이 자리 148.4~148.9 m)과 맞닿는 턱을 덮는다', f'{CLOSE}, {P18}', material='white_stone')
bast = [(ST_U[1] + 0.5, ST_TOP), (ENT_U[1], ST_TOP), (ENT_U[1], PASS_V), (11.5, PASS_V), (11.5, PL_V), (9.0, ST_BOT), (ST_U[1] + 0.5, ST_BOT)]
box('PLANTER-BASTION', 'planter', bast, Z_FIELD, Z_PLANT, AP, 'S-MAP(앞선: 148.9 가 되는 곳 v 9→6.5), 추정(윗면)', '계단 동쪽 옆에서 앞으로 나온 화단 모서리(계단 발치까지 나왔다가 물러남)', PH, material='white_stone')
box('PLANTER-MAIN', 'planter', [(11.5, PASS_V), (40.1, PASS_V), (40.1, PL_V), (11.5, PL_V)], Z_FIELD, Z_PLANT, AP, 'S-MAP(앞선 v 6~7, 윗면 150.1~150.2 한 곳), 추정(직선으로 본 것)',
    '흰 돌 화단 벽과 그 위 화단(소나무·철쭉). 벽 높이 1.3 m. S-MAP 이 u 27~33 에서 v 8~9 까지 150 m 로 부풀어 읽히는 것은 게시판·글자 조형물로 보고 넣지 않음(추정)', PH, material='white_stone')
box('PLANTER-EAST', 'planter', [(40.1, PASS_V_E), (54.0, PASS_V_E), (54.0, PL_V), (40.1, PL_V)], Z_FIELD, Z_PLANT, AP, 'S-MAP(앞선), 추정(윗면)', '동쪽 돌출 구간 앞 화단(Skon Square 글자 조형물 자리). 동쪽 끝 계단에서 끝남', PH, material='white_stone')
PA = 'Z02-PLATFORM-PASSAGE'
DK = '통로 바닥의 나무 데크(사용자 말). 사진에는 바닥이 안 보여 판 두께·결 방향은 가정'
box('DECK-MAIN', 'deck', rect(ENT_U[1] + 0.6, 40.1, 0.0, PASS_V), Z_PASS - 0.05, Z_PASS, PA, '확정(나무 데크, 양 끝: 사용자 그림 02), 추정(높이 151.3, 폭 2.5)', DK, f'사용자 그림 02, {P14}', material='timber')
box('DECK-EAST', 'deck', rect(40.1, 53.4, 1.67, PASS_V_E), Z_PASS - 0.05, Z_PASS, PA, '확정(나무 데크, 동쪽 끝은 약간 튀어나온 곳 근처: 사용자 그림 02), 추정(높이, 폭 1.9)', DK, f'사용자 그림 02, {P14}', material='timber')
box('DECK-WEST-END', 'deck', rect(ENT_U[1], ENT_U[1] + 0.6, 0.0, PASS_V), Z_PASS - 0.05, Z_PASS, PA, '확정(그대로 또는 1~2칸), 추정(그대로로 고름: 참과 통로가 둘 다 151.3)', '현관 참(151.3)에서 통로(151.3)로 그대로 이어지는 데크 서쪽 끝(Z06)', '사용자 답 2026-10-11', material='timber')
box('DECK-STEP-E', 'stair_step', rect(53.4, 54.0, 1.67, PASS_V_E), Z_FIELD, Z_PLAZA + 0.15, PA, '추정', '통로 동쪽 끝에서 광장(151.0)으로 내려서는 2칸 중 가운데 칸', f'{P24}, {MESH}', stair='Z02-DECK-STEPS-E', riseM=0.15, runM=0.6, widthM=r2(PASS_V_E - 1.67), material='stone')
for nm, uv in (('MAIN', rect(ENT_U[1], 40.1, PASS_V - 0.12, PASS_V)), ('JOG', rect(39.98, 40.1, PASS_V, PASS_V_E)), ('EAST', rect(40.1, 54.0, PASS_V_E - 0.12, PASS_V_E))):
    box(f'RAILING-{nm}', 'wall', uv, Z_PASS, Z_PASS + 1.1, PA, '확정(붉은 난간이 있음: 사진), 추정(높이 1.1 m)', '통로의 운동장 쪽 붉은 난간. 그 아래 어두운 돌 옹벽은 통로 기단의 옆면(화단 윗면 위로 1.1 m)', f'{P18}, {P24}', material='red_railing')

# ---------- 5. 동쪽 끝 계단 (B10), 오른쪽 계단 (B12) ----------
RE = (Z_PLAZA - Z_FIELD) / 13
for k in range(1, 13):
    box(f'EAST-STAIR-S{k:02d}', 'stair_step', rect(E_U[0], E_U[1], PL_V - RUN * k, PL_V - RUN * (k - 1)), Z_FIELD, Z_FIELD + RE * k, AP, '확정(있음: 사용자 그림 07), S-MAP(높이 148.9 → 151.0), 추정(단 수·폭·자리 ±1.5 m)',
        f'대일관·청운관 사이, 운동장에서 광장으로 오르는 넓은 돌계단: 13단 = 2.1 ÷ 0.16(사진에 열 단쯤 보임), 디딤 0.30, 폭 4.4 m', f'사용자 그림 07, {P23}, {P24}, {MESH}', stair='Z02-EAST-STAIR', riseM=r2(RE), runM=RUN, widthM=r2(E_U[1] - E_U[0]), material='stone')
box('EAST-STAIR-BLOCK', 'planter', [(E_U[1], E_TOP), (R_U0 + 12 * RUN, 2.0), (62.5, 2.0), (63.9, 8.0), (E_U[1], PL_V)], Z_FIELD, 150.6, AP, '추정', '동쪽 끝 계단 오른쪽의 돌 화단 덩어리(청운관 돌출부 왼쪽 계단 발치). 평면·높이 모두 사진 눈대중', f'{P23}, {P24}', material='white_stone')
RR = (Z_YARD - Z_PLAZA) / 13
for k in range(1, 13):
    box(f'RIGHT-STAIR-S{k:02d}', 'stair_step', rect(R_U0 + RUN * (k - 1), R_U0 + RUN * k, R_V[0], R_V[1]), Z_FIELD, Z_PLAZA + RR * k, AP, '확정(있음: 사용자 그림 07, 주석 "광장에서 청운관으로 가는 계단"), S-MAP(151.0 → 153.1 비탈 자리), 추정(단 수·폭·방향)',
        '광장에서 안쪽 마당으로 오르는 계단: 13단 = 2.1 ÷ 0.16, 디딤 0.30, 폭 4 m. 아래 끝을 광장으로 봄(그림 07 은 운동장 쪽에 그려져 있어 미정)', f'사용자 그림 07, 운동장 구조 주석, {MESH}', stair='Z02-RIGHT-STAIR', riseM=r2(RR), runM=RUN, widthM=4.0, material='stone')

# ---------- 6. 대일관에서 내려오는 계단 (B6): 현관 단 서쪽 끝 → 내리막길 맨 위(SP 카페 데크 끝 옆) ----------
# G03(2026-10-12): 사용자 표시 사진(사용자-SP카페·대일관계단·3생활관-20261012/03, "대일")과 영상 05 로 다시. 넓은 돌계단(여럿이 나란히 다님), 가운데 난간, 발치는 카페 데크 끝과 돌 화단 바로 너머.
# 폭 = 현관 단의 깊이 그대로(v 1.9~6.2, 4.3 m). 발치는 평탄부 145.5 가 아니라 그 동쪽의 길 경사면 위(S-MAP: s 96 에서 145.8, s 110 에서 150.5 로 오름): 디딤 0.36 m 로 두고 높이차에서 단 수를 셈(줄이지 않음)
import importlib.util as _ilu
_sp = _ilu.spec_from_file_location('g02common', HERE.parent / 'g02' / 'common.py'); _g = _ilu.module_from_spec(_sp); _sp.loader.exec_module(_g)
def _s_of(u_): return float(_g.xy_to_st(*uv_to_xy(u_, 4.05))[0])
SU0, SV, LAND, GO = ENT_U[0], (BAY_V, ST_TOP), 2.0, 0.36
NR = min(range(16, 44), key=lambda n_: abs((Z_ENT - float(_g.way_z(_s_of(SU0 - LAND - (n_ - 2) * GO)))) / n_ - 0.16))
SU1 = SU0 - LAND - (NR - 2) * GO; Z_FOOT = float(_g.way_z(_s_of(SU1))); RS = (Z_ENT - Z_FOOT) / NR
P03 = '사용자-SP카페·대일관계단·3생활관-20261012/03·05'
u = SU0; side = []
for k in range(1, NR):           # k 번째 디딤판(위에서 아래로), 윗면 = 151.3 − k x 한 단
    d = LAND if k == NR // 2 else GO
    side.append((u - d, u, Z_ENT - RS * k, k == NR // 2)); u -= d
for n, (a, b, top, landing) in enumerate(reversed(side), 1):
    box(f'SIDE-STAIR-S{n:02d}', 'landing' if landing else 'stair_step', rect(a, b, SV[0], SV[1]), 145.0, top, 'G02-PLATFORM-WAY (길 경사면), Z02-PLATFORM-APRON (동쪽 끝)',
        '확정(대일관 현관 앞 바닥에서 갈라져 내려오는 계단, SP 카페 데크 끝 옆으로 내려옴: 사용자 2026-10-11·2026-10-12), S-MAP(비탈 자리 s 96~110, 145.8 → 150.5), 추정(단 수·참·폭)',
        f'현관 단 서쪽 끝에서 벽을 따라 서쪽으로 내려가는 넓은 돌계단: {NR}단 = {Z_ENT - Z_FOOT:.2f} ÷ 0.16, 한 단 {RS:.3f} m, 디딤 {GO} m, 가운데 참 {LAND} m 하나(추정), 폭 {SV[1] - SV[0]:.1f} m(사진 03·영상: 여럿이 나란히). 발치 {Z_FOOT:.2f} m 는 길 경사면. 맨 위 참은 붉은 벽돌 바닥(사진 27)',
        f'{P03}, {P27}, {P18}, 사용자 확정, {MESH}', stair='Z02-SIDE-STAIR', riseM=r2(RS), runM=r2(LAND if landing else GO), widthM=r2(SV[1] - SV[0]), material='stone')
    box(f'SIDE-STAIR-RAIL-{n:02d}', 'wall', rect(a, b, 4.02, 4.08), top + 0.82, top + 0.9, 'Z02-SIDE-STAIR', '원천(가운데 난간: 사진 03·영상 05), 추정(높이)', '넓은 계단의 가운데 난간(손잡이 줄)', P03, color='#4b4f55')
    if n % 4 == 1: box(f'SIDE-STAIR-RAILPOST-{n:02d}', 'wall', rect((a + b) / 2 - 0.03, (a + b) / 2 + 0.03, 4.02, 4.08), top, top + 0.82, 'Z02-SIDE-STAIR', '추정', '가운데 난간의 기둥', P03, color='#4b4f55')
for j, a in enumerate(np.arange(SU1, SU0, 2.0)):
    b = min(a + 2.0, SU0); top = max(t for (x0, x1, t, _) in side if x1 > a and x0 < b) + 0.9
    box(f'SIDE-STAIR-WALL-{j + 1:02d}', 'wall', rect(a, b, SV[1], SV[1] + 0.3), 145.0, top, 'G02-PLATFORM-WAY', '추정', '내려오는 계단의 길 쪽 돌 옆벽과 난간(디딤 + 0.9 m, 2 m 마디: 계단 옆이라 계단을 따라 단이 짐)', f'{P03}, {P27}, {P18}', material='stone')

# ---------- 쓰기 ----------
STRUCT = REPO / 'frontend' / 'public' / 'structures' / 'z02-daeil-front.geojson'
dump(STRUCT, {'type': 'FeatureCollection', 'name': 'z02-daeil-front', 'crs': CRS, 'provenance': {'builder': 'docs/audit/z02/build_inputs.py', 'basePlanes': 'backend/data/terrain/recipes/z02-surface.geojson', 'schema': 'docs/audit/g02/STRUCTURES.md',
    'note': '기단이 먼저이고 상자는 그 위에 얹힌다. 상자에도 material 을 적었다(brick, stone, white_stone, timber, red_railing, roof_tile). 치수는 대부분 추정이라 estimated.'}, 'features': feats})
dump(REC / 'z02-surface.geojson', {'type': 'FeatureCollection', 'name': 'z02-surface', 'crs': CRS, 'features': surf})
g02 = json.loads((REC / 'g02-smooth-ground.json').read_text(encoding='utf-8'))
dump(REC / 'z02-smooth-ground.json', {'crs': 'EPSG:5186', 'protectBuildings': True,
    'reason': 'Z02: G02 조리법에 대일관 정면·운동장 북쪽 가장자리의 기단을 더함: 운동장 슬래브를 정면 벽까지 이은 바닥(148.9), 현관 단 151.3, 작은 광장 151.0, 안쪽 마당 153.1 m(높은 가장자리 길 151.25 m 는 격자 한 칸보다 좁아 지형에 싣지 않음). 지형 칸은 구조물 파일(frontend/public/structures/z02-daeil-front.geojson)의 기단 윗면에서 나온다. 계단·화단·현관·데크는 구조물 파일이 싣는다.',
    'steps': g02['steps'] + [{'type': 'surface', 'file': 'z02-surface.geojson'}]})
xy = lambda u, v: [r2(c) for c in uv_to_xy(u, v)]
dump(HERE / 'model.json', {'crs': 'EPSG:5186', 'sideStairFootS': r2(_s_of(SU1)), 'axis': {'origin': W0.tolist(), 'u': U.tolist(), 'v': V.tolist(), 'note': 'u = 대일관 정면 벽을 따라 동쪽, v = 벽에서 운동장 쪽'},
    'levels': {'field': Z_FIELD, 'entrance': Z_ENT, 'floor1F': Z_1F, 'passage': Z_PASS, 'planterTop': Z_PLANT, 'plaza': Z_PLAZA, 'yard': Z_YARD, 'sideStairFoot': r2(Z_FOOT)},
    'stairs': {'front': {'risers': 13, 'riseM': r2(RISE13)}, 'east': {'risers': 13, 'riseM': r2(RE)}, 'right': {'risers': 13, 'riseM': r2(RR)}, 'side': {'risers': NR, 'riseM': r2(RS), 'goingM': r2(GO), 'landingM': LAND}},
    'points': {'frontStairFoot': xy(1.7, ST_BOT), 'frontStairTop': xy(1.7, ST_TOP), 'entranceDoor': xy(1.7, 2.0), 'entranceWest': xy(SU0 + 0.8, 5.2), 'entranceEast': xy(ENT_U[1] - 0.5, 1.25),
               'sideStairTop': xy(SU0, 4.05), 'sideStairLandingE': xy([s for s in side if s[3]][0][1], 4.05), 'sideStairLandingW': xy([s for s in side if s[3]][0][0], 4.05), 'sideStairFoot': xy(SU1, 4.05), 'sideStairLandingZ': r2([s for s in side if s[3]][0][2]),
               'deckWest': xy(ENT_U[1] + 0.6, 1.25), 'deckDoor2': xy(31.9, 1.25), 'deckJog': xy(40.1, 2.2), 'deckEast': xy(53.4, 2.6), 'plazaW': xy(54.6, 2.2), 'plaza': xy(56.4, 0.5),
               'eastStairFoot': xy(56.4, PL_V), 'eastStairTop': xy(56.4, E_TOP), 'rightStairFoot': xy(R_U0, 0.0), 'rightStairTop': xy(R_U0 + 12 * RUN, 0.0), 'yardSouth': xy(61.6, -3.0), 'yardNorth': [201217.9, 557305.0], 'sangseungDoor': [201217.6, 557306.4],
               'rearDoor': [201182.5, 557321.4]},
    'counts': {t: sum(1 for f in feats if f['properties']['type'] == t) for t in sorted({f['properties']['type'] for f in feats})}})
print('features', len(feats), json.loads((HERE / 'model.json').read_text(encoding='utf-8'))['counts'], 'side stair', NR, 'risers', round(RS, 3), 'going', round(GO, 3))
