"""B15 청운관 현관 틀: 사진 11(정면)에 맞춰 다시 세운다. DB·네트워크 접근 없음.   python porch.py
쓰는 파일: frontend/public/structures/b15-cheongun.geojson (형식 docs/audit/g02/STRUCTURES.md)
고치는 파일: frontend/public/structures/z05-cheongun.geojson 에서 Z06-CHEONGUN-PORCH-* 상자를 걷는다(z05/boxes_z06.py 도 더는 만들지 않는다).
좌표: s = 본체의 운동장 쪽 벽을 따라 북서 끝에서 남동으로, d = 벽에서 운동장 쪽으로. 치수는 건물 노트 청운관 B15 절(사진 11 에서 잰 값, ±1 m 추정)."""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
O = np.array([201212.59, 557290.34]); A = np.array([16.32, -16.88]); A /= np.linalg.norm(A); N = np.array([-16.88, -16.32]); N /= np.linalg.norm(N)
def P(s, d): return [round(float(v), 2) for v in O + A * s + N * d]
def R(s0, s1, d0, d1): return Polygon([P(s0, d0), P(s1, d0), P(s1, d1), P(s0, d1)])
r2 = lambda v: round(float(v), 2)
SRC = '사용자-청운관현관·은주1관돌계단-20261012/11(정면)·02·03·06·01(사용자 표시), 건물 노트 청운관 B15 절, S-MAP(지붕 163.8·1층 153.1 m)'
G = '확정(열린 기둥 구조·넓은 지붕·첫 단 판이 옆 계단참과 틈 없이 이어짐·운동장 높이 문은 지하 1층), S-MAP(벽 선·지붕 163.8·1층 153.1), 추정(사진 11 에서 잰 기둥 자리·판 끝·계단 끝 ±1 m, 깊이 6 m, 두께)'
FEATS = []
def box(id, typ, poly, fromM, toM, assumption, basePlane, grade=G, **extra):
    assert toM > fromM, id
    FEATS.append({'type': 'Feature', 'properties': {'id': 'B15-CHEONGUN-PORCH-' + id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': SRC, **extra},
                  'geometry': {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in poly.exterior.coords]]}})
CD, T = 6.0, 0.18                                   # 틀 깊이(S-MAP 돌출부 앞 모서리 4.5~7.1 m), 난간벽 두께
COLS = [5.2, 9.4, 14.6, 19.9]                       # 앞줄 기둥 가운데
LV = [153.1, 156.65, 160.2]                         # 층 판 윗면(Z05 값 그대로)
FIELD, DECK_W, DECK_E = 148.9, 1.4, COLS[2] + 0.45  # 첫 단 판: 안쪽 마당의 혀(s 2.9 까지)와 겹치게 서쪽 끝 1.4, 동쪽 끝 = 셋째 기둥(계단 머리)
UP_W, UP_E = 1.3, COLS[3] + 0.45                    # 2·3단 판
ST_FOOT, ST_D0, ST_D1 = 24.0, CD - 1.55, CD + 0.45  # 오른쪽 계단: 발치, 폭 2.0 m(앞줄 기둥 앞면과 나란히)
YARD_GAP = 2.6                                      # 첫 단 판 서쪽 끝에서 벽 쪽 2.6 m 는 안쪽 마당으로 트임

# 첫 단 판(1층 현관 153.1): 안쪽 마당(Z02-PLATFORM-YARD 153.1)에 겹쳐 닿는다
box('SLAB-1', 'deck', R(DECK_W, DECK_E, 0, CD), LV[0] - 0.6, LV[0], '첫 단 판 = 1층 로비 앞 현관 바닥 153.1 m. 서쪽 끝은 건물 모서리 옆 안쪽 마당(153.1 m)의 계단 머리에 겹쳐 닿는다(틈 없음: 사용자 확정 2026-10-12). 동쪽 끝은 셋째 기둥 = 계단 머리', '없음(기둥 위 뜬 판, 서쪽 끝은 Z02-PLATFORM-YARD)', material='concrete')
box('RAIL-1F', 'wall', R(DECK_W, DECK_E, CD - T, CD), LV[0] - 0.9, LV[0] + 1.0, '첫 단 앞 난간벽(밝은 돌 판, 사진에서 띠 높이 약 1.9 m = 보 0.9 + 난간 1.0)', 'SLAB-1', material='white_stone')
box('RAIL-1W', 'wall', R(DECK_W, DECK_W + T, YARD_GAP, CD), LV[0] - 0.9, LV[0] + 1.0, '첫 단 서쪽 끝 난간벽: 벽 쪽 2.6 m 는 안쪽 마당으로 트여 있다', 'SLAB-1', material='white_stone')
box('RAIL-1E', 'wall', R(DECK_E - T, DECK_E, 0, ST_D0), LV[0], LV[0] + 1.0, '첫 단 동쪽 끝 난간벽(계단 폭만큼은 트임)', 'SLAB-1', material='white_stone')
for k in (1, 2):
    z = LV[k]
    box(f'SLAB-{k + 1}', 'deck', R(UP_W, UP_E, 0, CD), z - 0.6, z, f'층 판 {k + 1}/3: 윗면 {z} m. 왼쪽은 첫째 기둥 밖으로 3.5 m 내민다(사진 11)', '없음(기둥 위 뜬 판)', material='concrete')
    for tag, poly in (('F', R(UP_W, UP_E, CD - T, CD)), ('W', R(UP_W, UP_W + T, 0, CD)), ('E', R(UP_E - T, UP_E, 0, CD))):
        box(f'RAIL-{k + 1}{tag}', 'wall', poly, z, z + 0.45, '층 판 가장자리의 낮은 턱(사진의 띠 두께 약 1.05 m = 판 0.6 + 턱 0.45)', f'SLAB-{k + 1}', material='white_stone')
box('GLASS-1', 'wall', R(COLS[0] + 0.5, COLS[2] - 0.5, 0.0, 0.25), LV[0], LV[0] + 2.6, '1층 현관 안쪽의 큰 유리 면(첫째~셋째 기둥 사이, 사진 11 의 짙은 초록 유리). 문 자리는 모름', 'SLAB-1', material='glass')
for k in (1, 2):
    box(f'GLASS-{k + 1}', 'wall', R(2.0, UP_E - 0.5, 0.0, 0.15), LV[k] + 1.0, LV[k] + 2.3, f'틀 뒤 본체 벽의 창 띠(층 {k + 1}). 벽 자체는 붉은 벽돌이다(사진 11)', f'SLAB-{k + 1}', material='glass')
box('GLASS-B1', 'wall', R(COLS[0] + 0.5, COLS[1] - 0.5, 0.0, 0.25), FIELD, FIELD + 2.4, '운동장 높이의 안쪽 문: 첫째~둘째 기둥 사이의 뚫린 통로 안쪽(지하 1층). 문 자리는 사진 11 의 게시판·사람 자리', '운동장 148.9', material='glass')
box('FLOOR-B1', 'landing', R(0.0, 23.5, 0.0, 8.0), FIELD - 0.3, FIELD, '틀 아래 바닥: 운동장과 같은 높이로 벽까지 평평하다(운동장 높이 문은 평지로 이어짐: 사용자 확정 2026-10-11)', '운동장 148.9', material='paving')
def stair_z(s): return LV[0] - (LV[0] - FIELD) * (s - DECK_E) / (ST_FOOT - DECK_E)
for k, sc in enumerate(COLS):
    z0 = FIELD if k < 3 else stair_z(sc - 0.45) + 0.4     # 넷째 기둥은 계단 난간벽 위에서 시작한다(계단 밑은 뚫림)
    box(f'COLUMN-{k + 1}F', 'wall', R(sc - 0.45, sc + 0.45, CD - 0.45, CD + 0.45), z0, 163.0, '앞줄 기둥(0.9 m 각, 사진에서 폭 약 20 px)' + ('. 넷째 기둥은 계단 위에서 시작한다(사진 11: 계단 밑으로 기둥이 보이지 않는다)' if k == 3 else ''), '운동장 148.9' if k < 3 else 'STAIR', material='white_stone')
    box(f'COLUMN-{k + 1}B', 'wall', R(sc - 0.45, sc + 0.45, 0.0, 0.9), FIELD, 163.0, '벽 쪽 기둥(앞줄과 같은 자리로 봄, 추정)', '운동장 148.9', material='white_stone')
box('EAVE', 'canopy', R(-0.3, 22.4, 0.0, CD + 1.8), 163.0, 163.4, '넓은 지붕의 처마: 본체 벽 폭 거의 전체(사진 11: 왼쪽 끝이 건물 모서리, 오른쪽은 넷째 기둥 밖 2 m)', '없음(기둥 위)', material='concrete')
box('ROOF', 'canopy', R(0.3, 21.8, 0.0, CD + 1.2), 163.4, 163.8, '넓은 지붕의 윗부분: 윗면 163.8 m(S-MAP)', 'EAVE', material='concrete')
# 오른쪽 곧은 계단 한 줄: 첫 단 판 끝(셋째 기둥)에서 남동으로 내려가 운동장 바닥에
NS = 26
for k in range(NS):
    a, b = ST_FOOT - (ST_FOOT - DECK_E) * k / NS, ST_FOOT - (ST_FOOT - DECK_E) * (k + 1) / NS; top = FIELD + (LV[0] - FIELD) * (k + 1) / NS
    box(f'STAIR-S{k + 1:02d}', 'stair_step', R(b, a, ST_D0, ST_D1), max(FIELD - 0.3, top - 0.7) if k > 3 else FIELD - 0.3, top, '현관 틀의 오른쪽 곧은 계단(운동장에서 볼 때): 계단은 이 한 줄뿐이다(사진 11). 26단 = 4.2 m ÷ 0.162, 디딤 0.34 m, 폭 2 m. 계단 밑은 뚫려 있다(두께 0.7 m 의 비스듬한 판)', '운동장 148.9', stair='B15-CHEONGUN-PORCH-STAIR', riseM=r2((LV[0] - FIELD) / NS), runM=r2((ST_FOOT - DECK_E) / NS), widthM=r2(ST_D1 - ST_D0))
for j in range(8):
    a, b = DECK_E + (ST_FOOT - DECK_E) * j / 8, DECK_E + (ST_FOOT - DECK_E) * (j + 1) / 8
    for tag, d0, d1 in (('O', ST_D1, ST_D1 + T), ('I', ST_D0 - T, ST_D0)):
        box(f'STAIR-RAIL{tag}{j + 1}', 'wall', R(a, b, d0, d1), max(FIELD - 0.3, stair_z(b) - 0.7), stair_z(a) + 0.9, '계단 난간벽(밝은 돌, 여덟 마디)', 'STAIR', material='white_stone')
# 첫 단 판 서쪽 끝 앞의 떠 있는 둥근 화단, 발치의 낮은 돌 화단과 소나무
GP = '확정(이 자리에 돌 화단과 소나무: 사진 11·02), 추정(평면·높이·그루 수)'
box('PLANTER-HIGH', 'planter', R(0.0, COLS[0] - 0.5, CD - 2.6, CD + 0.6), 150.4, 152.0, '첫 단 판 서쪽 끝 앞의 떠 있는 화단(사진 11: 둥근 두 굽이의 밝은 돌 통, 윗선이 난간벽 윗선보다 약 2 m 아래, 밑은 뚫림). 네모로 줄였다', '없음(뜬 통)', grade=GP, material='white_stone')
box('PLANTER-LOW-W', 'planter', R(0.3, COLS[0] - 0.6, CD - 0.4, CD + 1.8), FIELD - 0.3, FIELD + 0.7, '발치의 낮은 돌 화단(서쪽, 살 울타리)', '운동장 148.9', grade=GP, material='white_stone')
box('PLANTER-LOW-E', 'planter', R(COLS[1] + 2.8, ST_FOOT - 0.2, CD + 0.65, CD + 1.9), FIELD - 0.3, FIELD + 0.7, '발치의 낮은 돌 화단(셋째 기둥 앞에서 계단 발치까지). 둘째~셋째 기둥 사이의 둥근 굽이는 지하 1층 문으로 드는 길 자리라 싣지 않았다', '운동장 148.9', grade=GP, material='white_stone')
def tree(tid, s, d, z, k=1.0):
    c = O + A * s + N * d; sq = lambda h: Polygon([(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)])
    for part, mat, h, z0, z1 in (('TRUNK', 'trunk', 0.15, 0.0, 2.2), ('CROWN', 'foliage', 1.1, 2.0, 3.2), ('TOP', 'foliage', 0.6, 3.2, 4.0)):
        box(f'{tid}-{part}', 'tree', sq(h * k), z + z0 * k, z + z1 * k, '단순한 나무(소나무 자리. 실제 그루 수·모양이 아니다)', 'PLANTER', grade=GP, material=mat)
tree('TREE-1', 2.4, CD - 1.0, 152.0, 0.8); tree('TREE-2', 2.6, CD + 0.7, FIELD + 0.7, 0.8); tree('TREE-3', 16.8, CD + 1.25, FIELD + 0.7, 0.7); tree('TREE-4', 21.6, CD + 1.25, FIELD + 0.7, 0.7)
out = {'type': 'FeatureCollection', 'name': 'b15-cheongun', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/b15/porch.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '청운관 운동장 쪽 현관 틀(열린 기둥부). 건물 블록에서는 빠져 있다(건물 노트 청운관의 부분 운동장쪽돌출부)'}, 'features': FEATS}
(STR / 'b15-cheongun.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
f = STR / 'z05-cheongun.geojson'; d = json.loads(f.read_text(encoding='utf-8')); n = len(d['features'])
d['features'] = [x for x in d['features'] if not x['properties']['id'].startswith('Z06-CHEONGUN-PORCH')]
if len(d['features']) != n: f.write_text(json.dumps(d, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(FEATS), 'features; z05-cheongun', n, '->', len(d['features']))
json.dump({'stairTop': P(DECK_E, (ST_D0 + ST_D1) / 2), 'stairFoot': P(ST_FOOT + 0.3, (ST_D0 + ST_D1) / 2), 'deckMid': P(6.0, 2.6), 'deckWest': P(2.6, 1.3)}, open(pathlib.Path(__file__).parent / 'porch-points.json', 'w'), indent=1)
