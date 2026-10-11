"""Z10: 사진에 있는데 지도에 없던 것을 구조물 상자로 더한다. DB·네트워크 접근 없음.   python build_parts.py
쓰는 파일: frontend/public/structures/z10-parts.geojson (형식 docs/audit/g02/STRUCTURES.md). 전부 estimated(치수는 사진 눈대중).
z05/build_inputs.py 를 다시 돌린 뒤에 돌린다(기단 윗면 높이를 읽는다).
 - 둥근 아치: 현관 기둥 사이의 네모난 뚫린 곳 윗모서리를 계단 모양 상자로 채워 반원으로 읽히게(북악관 정문 둘, 대일관 정문 둘, 혜인관 현관 셋)
 - 북악관 서쪽 옆길: 길 서쪽의 자연석 쌓기와 생울타리·나무, 입구(3) 계단과 길 사이의 풀밭과 바위, GS25 문과 차양, 정면 화단과 소나무
 - 외국인 생활관: 가운데 유리 띠와 문, 지붕 위 가운데 상자와 세모 지붕창.  공연실습소: 검은 간판 면, 길가 탑, 옥상 틀
 - 서문 위 화단 비탈의 소나무"""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon, Point, shape
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
ALL = [f for fn in sorted(STR.glob('*.geojson')) if fn.name != 'z10-parts.geojson' for f in json.loads(fn.read_text(encoding='utf-8'))['features']]
PLATS = [(shape(f['geometry']).buffer(0), f['properties']) for f in ALL if f['properties']['kind'] == 'platform']
def ground(x, y):
    """그 자리 기단 윗면 높이(겹치면 높은 쪽)."""
    best = None
    for poly, p in PLATS:
        if not poly.contains(Point(x, y)): continue
        if 'topProfile' in p: o, d, pts = np.array(p['topProfile']['origin']), np.array(p['topProfile']['direction']), np.array(p['topProfile']['points']); v = float(np.interp((x - o[0]) * d[0] + (y - o[1]) * d[1], pts[:, 0], pts[:, 1]))
        else: v = float(p['topM'])
        best = v if best is None else max(best, v)
    assert best is not None, (x, y); return best
FEATS = []
def box(id, typ, poly, fromM, toM, assumption, source, grade, basePlane, **extra):
    c = [[r2(x), r2(y)] for x, y in Polygon(poly).exterior.coords]; assert toM > fromM, id
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra}, 'geometry': {'type': 'Polygon', 'coordinates': [c]}})
def unit(v): v = np.array(v, float); return v / np.hypot(*v)
def frame(o, along, out):
    """o 에서 along 으로 s, out 쪽으로 d. R(s0, s1, d0, d1) = 그 네모, P(s, d) = 그 점."""
    o, a = np.array(o, float), unit(along); n = np.array([-a[1], a[0]]); n = n if n @ np.array(out, float) > 0 else -n
    return (lambda s0, s1, d0, d1: [o + a * s0 + n * d0, o + a * s1 + n * d0, o + a * s1 + n * d1, o + a * s0 + n * d1]), (lambda s, d: o + a * s + n * d)
def sq(c, h): return [(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)]
def tree(tid, c, z, what, src, base, s=1.0):
    for part, mat, h, z0, z1 in (('TRUNK', 'trunk', 0.18, 0.0, 3.0), ('CROWN', 'foliage', 1.3, 2.8, 4.2), ('TOP', 'foliage', 0.75, 4.2, 5.2)):
        box(f'{tid}-{part}', 'tree', sq(c, h * s), z + z0 * s, z + z1 * s, f'{what}: 단순한 나무(실제 그루 수·자리·수종의 모양이 아니다)', src, '확정(이 자리에 나무가 줄지어 있음: 사진), 추정(그루 수·자리·크기)', base, material=mat)

# ---------- 둥근 아치 ----------
def arches(pid, R, openings, d0, d1, crown, material, what, src, K=6):
    """네모난 뚫린 곳(s0~s1, 위는 crown)의 윗모서리를 채운다: 반지름 = 폭의 반인 반원. 반쪽마다 K 조각(가운데로 갈수록 좁게), 조각의 밑은 그 가운데의 아치 높이."""
    for n, (s0, s1) in enumerate(openings):
        r = (s1 - s0) / 2; c = (s0 + s1) / 2; spring = crown - r; xs = [r * np.cos(np.radians(90 * k / K)) for k in range(K + 1)]   # r → 0
        for k in range(K):
            xa, xb = xs[k + 1], xs[k]; z = spring + np.sqrt(max(r * r - ((xa + xb) / 2) ** 2, 0.0))
            if crown - z < 0.04: continue
            for side, (a, b) in (('L', (c - xb, c - xa)), ('R', (c + xa, c + xb))):
                box(f'{pid}-ARCH{n + 1}-{side}{k + 1}', 'wall', R(a, b, d0, d1), z, crown, f'{what}: 뚫린 곳의 윗모서리를 채워 둥근 머리(반원, 반지름 {r:.2f} m, 아치 시작 {spring:.2f} m)로 읽히게 한 조각. 반원을 계단 모양 {K}조각으로 줄였다', src,
                    '확정(머리가 둥근 아치: 사진), 추정(반지름 = 칸 폭의 반, 조각 수)', f'{pid} 윗보', material=material)
# 북악관 정문: 기둥 셋(정면을 따라 0~1, 5~6, 10~11 m), 윗보 밑 136.3 m, 벽 두께 1 m
R, _ = frame((201036.6, 557367.3), (9.9, -4.8), (0.4, 0.9))
arches('Z10-BUKAK-PORCH', R, [(1.0, 5.0), (6.0, 10.0)], 0.0, 1.0, 136.3, 'stone', '북악관 정문 현관의 아치', '사용자-서문·제2주차장·수인관-20261010/10-북악관-정문계단-거리뷰-202502.webp, 사용자-SMAP높이-20261010/사진-19-북악관-정면.png')
# 대일관 정문: 기둥 셋(0~1.0, 3.95~5.15, 8.2~9.2 m), 윗보 밑 154.2 m, 벽 두께 0.65 m
R, _ = frame((201152.9, 557312.3), (8.4, -3.8), (-0.3, -0.6))
arches('Z10-DAEIL-PORCH', R, [(1.0, 3.95), (5.15, 8.2)], 0.0, 0.65, 154.2, 'brick', '대일관 정문 현관의 아치', '사용자-공연실습소-은주관-20261010/대일관-현관-계단-가까이.webp')
# 혜인관 운동장 쪽 현관 1층: 기둥 넷, 칸 폭 1.6 m, 윗보 밑 155.5 m
R, _ = frame((201213.6, 557212.5), (3.6, 6.2), (0.5, -0.3))
arches('Z10-HYEIN-PORCH', R, [(0.6, 2.2), (2.8, 4.4), (5.0, 6.6)], 0.0, 0.6, 155.5, 'brick', '혜인관 현관 1층의 아치', '사용자-출입구·주차장-20261010/01-혜인관-운동장쪽-1층과B1.jpg', K=5)

# ---------- 북악관 서쪽 옆길과 정면 화단 ----------
GS = 'streetview-bukak-gs25-202502-02.png, streetview-bukak-gs25-202502-01.png'
BW, BN = np.array([201004.8, 557387.2]), np.array([201016.5, 557412.1]); LANE_W = 3.8
LR, LP = frame(BW, BN - BW, (-1.0, 0.45))   # s = 서쪽 끝 벽을 따라 북으로(모서리 0), d = 벽에서 길 쪽
LEN = float(np.hypot(*(BN - BW)))
for k, s0 in enumerate(np.arange(-7.0, LEN - 0.1, 3.0)):
    s1 = min(s0 + 3.0, LEN); z = ground(*LP((s0 + s1) / 2, LANE_W - 0.3))
    box(f'Z10-SIDEWAY-ROCKWALL-{k + 1:02d}', 'wall', LR(s0, s1, LANE_W, LANE_W + 0.6), z - 0.6, z + 0.6, '옆길 서쪽 가장자리의 자연석 쌓기(높이 0.6 m, 폭 0.6 m: 거리뷰 눈대중). 3 m 마디마다 길 높이를 따른다', GS, '확정(길 서쪽에 낮은 자연석 쌓기와 생울타리: 거리뷰), 추정(선·높이)', 'Z05-PLATFORM-BACK-SIDE-WAY', material='stone')
    box(f'Z10-SIDEWAY-HEDGE-{k + 1:02d}', 'planter', LR(s0, s1, LANE_W + 0.6, LANE_W + 1.6), z - 0.6, z + 1.2, '자연석 쌓기 위의 생울타리(높이 0.6 m)', GS, '확정(생울타리: 거리뷰), 추정(폭·높이)', 'Z10-SIDEWAY-ROCKWALL', material='foliage')
for k, s in enumerate((-3.0, 4.0, 11.0, 18.0, 25.0)):
    c = LP(s, LANE_W + 4.0); tree(f'Z10-SIDEWAY-TREE-{k + 1}', c, ground(*c), '옆길 서쪽 화단 비탈의 소나무 줄', GS, 'Z05-PLATFORM-WEST-GATE-BANK')
z = ground(*LP(8.6, 1.8))
box('Z10-BUKAK-GS25-DOOR', 'wall', LR(7.6, 9.6, -0.02, 0.1), z, z + 2.3, '북악관 입구(4) GS25 문 면(폭 2 m: 눈대중). 벽면의 문 자리를 나타내는 어두운 판', GS + ', 건물 노트 북악관(GS25 문 201008.5, 557395.0)', '확정(GS25 문 = 지하 1층 입구), 추정(폭·높이)', '북악관 서쪽 끝 벽', material='opening')
box('Z10-BUKAK-GS25-AWNING', 'canopy', LR(6.6, 10.6, 0.0, 1.1), z + 2.4, z + 2.75, 'GS25 문 위의 차양(붉은 줄무늬 천 차양: 폭 4 m, 내민 길이 1.1 m 눈대중)', GS, '확정(문 위 차양: 거리뷰), 추정(치수)', '없음(벽에 붙음)', color='#7a3b38')
bf = unit((78.0, -41.0)); FR, FP = frame(BW, bf, (-0.465, -0.885))   # s = 정면을 따라 남동으로(서쪽 모서리 0), d = 포장면 쪽
z = ground(*FP(0.6, 3.0))
box('Z10-BUKAK-ENTRANCE3-LAWN', 'planter', FR(-0.4, 1.1, 0.2, 6.2), z - 0.3, z + 0.15, '입구(3) 계단 서쪽 난간벽과 옆길 사이의 풀밭 띠(연석 높이 0.15 m)', GS, '확정(풀밭과 바위: 거리뷰), 추정(외곽)', '회차 공간 포장면')
for k, (s, d, h) in enumerate(((0.4, 2.2, 0.45), (0.2, 5.0, 0.6))):
    box(f'Z10-BUKAK-ENTRANCE3-ROCK-{k + 1}', 'wall', FR(s - 0.45, s + 0.45, d - 0.3, d + 0.3), z + 0.15, z + 0.15 + h, '풀밭 위의 바위(거리뷰에 둘 보인다)', GS, '확정(바위: 거리뷰), 추정(자리·크기)', 'Z10-BUKAK-ENTRANCE3-LAWN', material='stone')
# 정면 화단: 입구(3) 계단 동쪽 난간벽에서 정문 계단 서쪽 난간벽까지, 벽에서 4.3 m. 자연석 쌓기 + 소나무
PSRC = 'streetview-bukak-gs25-202502-01.png, 사용자-SMAP높이-20261010/사진-19-북악관-정면.png'
PG = '확정(정면 벽 앞에 돌 쌓기 화단과 소나무 줄: 거리뷰·사진 19), 추정(외곽·높이·그루 수)'
segs = np.linspace(7.6, 34.2, 5)
for k in range(4):
    s0, s1 = segs[k], segs[k + 1]; z = ground(*FP((s0 + s1) / 2, 5.0))
    box(f'Z10-BUKAK-FRONT-PLANTER-W{k + 1}', 'planter', FR(s0, s1, 0.2, 4.3), z - 0.4, z + 0.9, '북악관 정면 서쪽 화단(입구(3) 계단 ~ 정문 계단): 돌 쌓기 높이 0.9 m, 벽에서 4.3 m. 네 마디로 나눠 포장 높이를 따른다', PSRC, PG, 'Z05-PLATFORM-TURN-BUKAK-FRONT', material='stone')
    c = FP((s0 + s1) / 2, 2.4); tree(f'Z10-BUKAK-FRONT-TREE-W{k + 1}', c, z + 0.9, '북악관 정면 서쪽 화단의 소나무 줄', PSRC, f'Z10-BUKAK-FRONT-PLANTER-W{k + 1}')

# ---------- 서문 위 화단 비탈의 소나무 ----------
wx = lambda y: 201007.0 - 0.1375 * (y - 557255.0)
for k, y in enumerate((557388.0, 557394.0, 557405.0, 557411.0, 557418.0)):
    c = (wx(y) + 3.0, y); tree(f'Z10-WESTGATE-TREE-{k + 1}', c, ground(*c), '서문 위 화단의 소나무 줄(옹벽 머리 안쪽 3 m)', '사용자-서문-공연실습소-생활관-20261010/서문.jpg', 'Z05-PLATFORM-WEST-GATE-BANK')

# ---------- 외국인 생활관 ----------
DS = '사용자-서문-공연실습소-생활관-20261010/외국인생활관.jpg'; DG = '확정(있음: 사용자 사진), 추정(자리·치수)'
DR, DP = frame((200987.5, 557232.5), (14.0, -1.0), (0.07, 1.0))   # s = 회전교차로 쪽 벽을 따라 동으로(폭 14.04 m), d = 벽 밖
zg = ground(*DP(7.0, 2.0))
box('Z10-DORM-GLASS-STRIP', 'wall', DR(5.9, 8.1, -0.02, 0.1), zg + 2.6, 104.0, '외국인 생활관 회전교차로 쪽 가운데의 세로 유리 띠(계단실 창: 폭 2.2 m, 2층 ~ 벽돌 벽 끝)', DS, DG, '추가-외국인생활관 북쪽 벽', material='glass')
box('Z10-DORM-DOOR', 'wall', DR(5.8, 8.2, -0.02, 0.1), zg, zg + 2.5, '회전교차로 쪽 가운데의 문(폭 2.4 m). 벽면의 문 자리를 나타내는 어두운 판. 출입구 자료는 없다(길에 잇지 않음)', DS, DG, '추가-외국인생활관 북쪽 벽', material='opening')
box('Z10-DORM-ROOF-BOX', 'canopy', DR(5.0, 9.0, -3.6, -0.1), 104.1, 109.2, '지붕층 가운데에 솟은 금속판 상자(계단실 머리: 폭 4 m, 깊이 3.5 m, 지붕 위 2.2 m)', DS, DG, '추가-외국인생활관 지붕', color='#5b6068')
for k, s in enumerate((2.3, 11.7)):   # 지붕층 앞면의 세모 지붕창: 가운데 상자 양옆에 하나씩(가운데 것은 상자에 가려 그리지 않음). 세모를 두 단 상자로
    box(f'Z10-DORM-DORMER-{k + 1}A', 'canopy', DR(s - 1.1, s + 1.1, -1.6, 0.0), 106.2, 107.0, '지붕층 앞면의 세모 지붕창(아랫단)', DS, DG, '추가-외국인생활관 지붕', color='#5b6068')
    box(f'Z10-DORM-DORMER-{k + 1}B', 'canopy', DR(s - 0.55, s + 0.55, -1.6, 0.0), 107.0, 107.7, '지붕층 앞면의 세모 지붕창(윗단)', DS, DG, '추가-외국인생활관 지붕', color='#5b6068')

# ---------- 공연실습소 ----------
PS = '사용자-서문-공연실습소-생활관-20261010/공연실습소.webp'
CR, CP = frame((201027.5, 557215.5), (22.0, -14.0), (0.54, 0.84))   # s = 길(남서쪽 공도) 쪽 벽을 따라 남동으로(북쪽 모서리 0), d = 벽 밖
box('Z10-CREATIVE-SIGN', 'wall', CR(0.6, 6.2, -0.02, 0.12), 95.9, 101.3, '공연실습소 길 쪽 벽의 검은 간판 면("SEOKYEONG UNIVERSITY CREATIVE CENTER", 2~3층 높이, 폭 5.6 m). 글자는 그리지 않음', PS, DG, '추가-공연실습소 길 쪽 벽', color='#1f2023')
box('Z10-CREATIVE-TOWER', 'canopy', CR(0.0, 4.5, -5.0, 0.0), 107.0, 110.0, '길가 모서리의 탑(지붕 위로 3 m 솟은 블록 덩어리: 사진 왼쪽 위)', PS, DG, '추가-공연실습소 지붕', color='#a9a8a2')
FRM = [np.array(p) for p in ((201012.6, 557210.6), (201016.6, 557215.4), (201021.6, 557211.3), (201017.6, 557206.5))]
for k in range(4):
    a, b = FRM[k], FRM[(k + 1) % 4]; u = unit(b - a); n = np.array([-u[1], u[0]]) * 0.2
    box(f'Z10-CREATIVE-ROOFFRAME-BEAM-{k + 1}', 'canopy', [a + n, b + n, b - n, a - n], 109.6, 110.0, '옥상의 콘크리트 틀(보): 북서쪽 덩어리 위', PS, DG, '없음(기둥 위)', color='#a9a8a2')
    box(f'Z10-CREATIVE-ROOFFRAME-POST-{k + 1}', 'wall', sq(a, 0.2), 107.0, 109.6, '옥상의 콘크리트 틀(기둥)', PS, DG, '추가-공연실습소 지붕', color='#a9a8a2')
# ---------- 위쪽 갈래 굽이 안쪽의 섬과 한림관 1층 문 ----------
HS = '사용자-출입구·주차장-20261010/05-한림관1층-가는길-네이버거리뷰-202506.webp'
isl = next(poly for poly, p in PLATS if p['id'] == 'Z05-PLATFORM-UPPER-HAIRPIN-ISLAND')
for k, c in enumerate(((201096.0, 557258.5), (201102.5, 557258.5), (201096.0, 557264.5), (201102.5, 557264.5), (201099.5, 557269.0))):
    assert isl.contains(Point(c)); tree(f'Z10-HAIRPIN-TREE-{k + 1}', c, ground(*c), '위쪽 갈래 굽이 안쪽 섬의 소나무', HS, 'Z05-PLATFORM-UPPER-HAIRPIN-ISLAND')
box('Z10-HANLIM-1F-CANOPY', 'canopy', [(201102.0, 557280.2), (201109.5, 557280.2), (201109.5, 557283.4), (201102.0, 557283.4)], 130.6, 130.9, '한림관 1층 문 위의 차양(짙은 틀의 유리 차양: 폭 7.5 m, 내민 길이 3 m, 문 앞 단 127.2 m 위 3.4 m). 문 자리는 문 앞 단의 건물 쪽으로 봄', HS, DG, '없음(건물 벽에 붙음)', color='#3a4046')
ids = [f['properties']['id'] for f in FEATS]; assert len(ids) == len(set(ids))
out = {'type': 'FeatureCollection', 'name': 'z10-parts', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/z10/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '사진에 있는 것만: 둥근 아치(계단 모양 조각), 북악관 옆길의 돌 쌓기·생울타리·풀밭·GS25 문, 북악관 정면 화단, 서문 위 소나무, 외국인 생활관·공연실습소의 덧붙은 덩어리. 치수는 눈대중(추정).'}, 'features': FEATS}
(STR / 'z10-parts.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print('features', len(FEATS))
