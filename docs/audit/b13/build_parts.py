"""B13 혜인관: 운동장 쪽 출입부(벽돌 현관 + 양쪽 계단 + 줄무늬 가림벽), 북동 옆면의 작은 현관·쉼터·콘크리트 어귀, 전원 버튼 원판, 운동장 쪽 화단의 나무, 북동 옆면 앞 화단. DB·네트워크 접근 없음.   python build_parts.py
쓰는 파일: frontend/public/structures/b13-hyein.geojson (형식 docs/audit/g02/STRUCTURES.md). 치수는 따로 적지 않으면 사진 눈대중(추정)이다.
좌표계는 frame.py: s = 운동장 쪽 벽을 따라 남서 끝에서 북동으로, f = 그 벽에서 운동장 쪽으로. 출입부 가운데 s = C(근거는 derive.py 머리말).
z05/build_inputs.py 가 혜인관 현관 상자를 더는 만들지 않는다(boxes_z06.py). z10 의 혜인관 아치도 여기로 옮겼다."""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon
from frame import *
REPO = pathlib.Path(__file__).parents[3]; OUTF = REPO / 'frontend' / 'public' / 'structures' / 'b13-hyein.geojson'
r2 = lambda v: round(float(v), 2)
FEATS = []
def box(id, typ, poly, fromM, toM, assumption, source, grade, basePlane, **extra):
    c = [[r2(x), r2(y)] for x, y in Polygon(poly).exterior.coords]; assert toM > fromM, id
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra}, 'geometry': {'type': 'Polygon', 'coordinates': [c]}})
def F(s0, s1, f0, f1): return R(C + s0, C + s1, -f0, -f1)          # 출입부 가운데 기준: s 는 가운데에서, f 는 벽에서 운동장 쪽
def G(g0, g1, d0, d1): return R(LEN + g0, LEN + g1, d0, d1)        # 북동 옆면 기준: g = 옆면에서 북동으로, d = 운동장 쪽 모서리에서 건물 깊이 방향
def stairs(sid, s_foot, s_top, f0, f1, n, z0, z1, assumption, source, grade, basePlane):
    for k in range(n):
        a, b = s_foot + (s_top - s_foot) * k / n, s_foot + (s_top - s_foot) * (k + 1) / n
        box(f'{sid}-S{k + 1:02d}', 'stair_step', F(min(a, b), max(a, b), f0, f1), z0 - 0.3, z0 + (k + 1) * (z1 - z0) / n, assumption, source, grade, basePlane, stair=sid, riseM=r2((z1 - z0) / n), runM=r2(abs(s_top - s_foot) / n), widthM=r2(f1 - f0))
def arches(pid, rect, openings, a0, a1, crown, material, what, src, K=5):
    for n, (s0, s1) in enumerate(openings):
        r = (s1 - s0) / 2; c = (s0 + s1) / 2; spring = crown - r; xs = [r * np.cos(np.radians(90 * k / K)) for k in range(K + 1)]
        for k in range(K):
            xa, xb = xs[k + 1], xs[k]; z = spring + np.sqrt(max(r * r - ((xa + xb) / 2) ** 2, 0.0))
            if crown - z < 0.04: continue
            for side, (a, b) in (('L', (c - xb, c - xa)), ('R', (c + xa, c + xb))):
                box(f'{pid}-ARCH{n + 1}-{side}{k + 1}', 'wall', rect(a, b, a0, a1), z, crown, f'{what}: 뚫린 곳의 윗모서리를 채워 둥근 머리(반원, 반지름 {r:.2f} m)로 읽히게 한 조각', src, '확정(머리가 둥근 아치: 사진), 추정(반지름 = 칸 폭의 반, 조각 수)', f'{pid} 윗보', material=material)
def disc(pid, rect, c, zc, r, a0, a1, what, src, grade, base, K=7, **extra):
    """세로 면에 붙은 둥근 판: 폭 방향 조각 2K 개(조각마다 위아래 높이가 원을 따른다)."""
    for k in range(-K, K):
        x0, x1 = r * k / K, r * (k + 1) / K; h = float(np.sqrt(max(r * r - ((x0 + x1) / 2) ** 2, 0.0)))
        if h < 0.08: continue
        box(f'{pid}-{k + K + 1:02d}', 'wall', rect(c + x0, c + x1, a0, a1), zc - h, zc + h, f'{what}: 둥근 판을 세로 조각 {2 * K}개로', src, grade, base, **extra)
def tree(tid, c, z, what, src, base, s=1.0):
    sq = lambda h: [(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)]
    for part, mat, h, z0, z1 in (('TRUNK', 'trunk', 0.18, 0.0, 3.0), ('CROWN', 'foliage', 1.3, 2.8, 4.2), ('TOP', 'foliage', 0.75, 4.2, 5.2)):
        box(f'{tid}-{part}', 'tree', sq(h * s), z + z0 * s, z + z1 * s, f'{what}: 단순한 나무(실제 그루 수·자리·수종의 모양이 아니다)', src, '확정(이 자리에 낮은 나무 줄: 사진), 추정(그루 수·자리·크기)', base, material=mat)

U1, U2, U3 = '사용자-출입구·주차장-20261010/01-혜인관-운동장쪽-1층과B1.jpg', '사용자-혜인관-20261012/', '사용자-학교전경-20261012/'
GND, B1, F1 = 149.0, 149.3, 153.4     # 둘레 평면, 지하 1층 문, 1층(동 노트 층 표: 149.3 + 4.11, 추정). 계단은 둘레 평면에서 1층까지 4.4 m 를 그대로 오른다
PG = '확정(운동장 높이 문 = 지하 1층, 계단은 양쪽에 있고 위가 1층: 사용자 2026-10-10·2026-10-12), S-MAP(출입부 자리: 화단 틈 s 36.7~56.3, 메시 덩어리 s 35~55·윗면 157.0), 추정(현관·계단 치수, 1층 153.4 = 149.3 + 층고 4.11)'
PS = f'{U1}, {U2}01-혜인관-정면-운동장에서.jpg, {U3}02·08, S-MAP 1 m 메시(docs/audit/b13/derive.py), 건물 노트 혜인관'
# ---- 벽돌 현관(가림벽 안에 있는 옛 형상): 아래 지하 1층 문, 위 1층 아치 셋과 붉은 기와. 윗면 157.0(S-MAP) 아래에 들어가게 높이를 잡았다 ----
for k, (a, b) in enumerate(((-3.6, -3.2), (3.2, 3.6))): box(f'B13-HYEIN-PORCH-SIDE-{k + 1}', 'wall', F(a, b, 0, 3.8), GND, F1, '혜인관 현관 아래층(지하 1층) 옆 벽: 붉은 벽돌. 폭 7.2 m, 깊이 3.8 m', PS, PG, '혜인관 둘레 149.0', material='brick')
for k, (a, b) in enumerate(((-3.6, -1.4), (1.4, 3.6))): box(f'B13-HYEIN-PORCH-FRONT-{k + 1}', 'wall', F(a, b, 3.4, 3.8), GND, F1 - 0.4, '현관 아래층 앞 벽(벽돌). 가운데 2.8 m 는 지하 1층 유리문', PS, PG, '혜인관 둘레 149.0', material='brick')
box('B13-HYEIN-PORCH-DOOR-B1', 'wall', F(-1.4, 1.4, 3.45, 3.7), GND, 151.6, '지하 1층 유리문(운동장 높이의 문): 폭 2.8 m·높이 2.6 m 눈대중', PS, PG, '혜인관 둘레 149.0', material='glass')
box('B13-HYEIN-PORCH-DOOR-HEAD', 'wall', F(-1.4, 1.4, 3.4, 3.8), 151.6, F1 - 0.4, '지하 1층 문 위 벽', PS, PG, '없음', material='brick')
box('B13-HYEIN-PORCH-FLOOR-1F', 'deck', F(-3.6, 3.6, 0, 3.8), F1 - 0.4, F1, f'혜인관 현관의 1층 바닥(양쪽 계단이 닿는 곳, 로비 문 앞): {F1} m. 아래는 지하 1층 문 안쪽', PS, PG, '없음(벽 위)', material='concrete')
for k, sc in enumerate((-3.3, -1.1, 1.1, 3.3)): box(f'B13-HYEIN-PORCH-PIER-{k + 1}', 'wall', F(sc - 0.3, sc + 0.3, 3.2, 3.8), F1, 155.9, '1층 현관 앞면의 벽돌 기둥(기둥 넷 = 아치 셋)', PS, PG, 'B13-HYEIN-PORCH-FLOOR-1F', material='brick')
for k, sc in enumerate((-3.3, 3.3)): box(f'B13-HYEIN-PORCH-PIER-B{k + 1}', 'wall', F(sc - 0.3, sc + 0.3, 0.0, 0.6), F1, 155.9, '1층 현관 옆면의 벽 쪽 기둥(그 사이 2.6 m 로 계단이 들어온다)', PS, PG, 'B13-HYEIN-PORCH-FLOOR-1F', material='brick')
box('B13-HYEIN-PORCH-HEADER', 'wall', F(-3.6, 3.6, 3.2, 3.8), 155.3, 155.9, '아치 위 벽돌 벽(아치 꼭대기 155.3 m)', PS, PG, '없음(기둥 위)', material='brick')
for k, (a, b) in enumerate(((-3.6, -3.0), (3.0, 3.6))): box(f'B13-HYEIN-PORCH-SIDE-HEADER-{k + 1}', 'wall', F(a, b, 0.0, 3.2), 155.3, 155.9, '옆면 뚫린 곳 위 벽돌 벽', PS, PG, '없음(기둥 위)', material='brick')
box('B13-HYEIN-PORCH-EAVE', 'canopy', F(-4.2, 4.2, 0, 4.4), 155.9, 156.15, '흰 처마 띠', PS, PG, '없음(벽 위)', material='white_stone')
box('B13-HYEIN-PORCH-ROOF-1', 'canopy', F(-3.9, 3.9, 0, 4.1), 156.15, 156.55, '붉은 기와 모임지붕 아랫단(두 단 상자로 줄임. 가림벽 윗면 157.0 아래)', PS, PG, 'B13-HYEIN-PORCH-EAVE', material='roof_red')
box('B13-HYEIN-PORCH-ROOF-2', 'canopy', F(-2.6, 2.6, 0, 2.8), 156.55, 156.9, '붉은 기와 모임지붕 윗단', PS, PG, 'B13-HYEIN-PORCH-ROOF-1', material='roof_red')
arches('B13-HYEIN-PORCH', lambda a, b, f0, f1: F(a, b, f0, f1), [(-3.0, -1.4), (-0.8, 0.8), (1.4, 3.0)], 3.2, 3.8, 155.3, 'brick', '혜인관 현관 1층의 아치', U1)
# ---- 계단 양쪽(사용자 확정 2026-10-12): 바깥 끝에서 벽을 따라 현관 쪽으로 올라 1층 바닥에 닿는다. 화단 틈에 꼭 맞는 길이 ----
SG = '확정(계단이 양쪽에 있다: 사용자 2026-10-12. 위가 1층), S-MAP(바깥 끝 = 화단이 끝나는 곳), 추정(단 수 26 = 4.4 m ÷ 0.169, 디딤 0.24 m, 폭 2.6 m. 좌우 같은 모양으로 둠)'
for tag, sg, name in (('R', -1, '오른쪽'), ('L', 1, '왼쪽')):
    stairs(f'B13-HYEIN-PORCH-STAIR-{tag}', sg * 9.8, sg * 3.6, 0.6, 3.2, 26, GND, F1, f'혜인관 현관 {name} 계단(운동장에서 볼 때): 화단 끝에서 벽을 따라 현관 쪽으로 올라 1층 바닥에 닿는다. 26단, 높이 차 4.4 m 그대로', PS, SG, '혜인관 둘레 149.0')
    for j in range(1, 8):
        a, b = sg * (9.8 - 6.2 * j / 8), sg * (9.8 - 6.2 * (j + 1) / 8)
        box(f'B13-HYEIN-PORCH-STAIR-{tag}-RAIL{j}', 'wall', F(min(a, b), max(a, b), 3.2, 3.4), GND - 0.3, GND + 4.4 * (j + 1) / 8 + 0.9, '계단 운동장 쪽 돌 난간벽(마디로 줄임. 발치 첫 마디는 드나드는 곳이라 비움)', PS, SG, '혜인관 둘레 149.0', material='white_stone')
# ---- 줄무늬 가림벽(사용자 2026-10-12: "기존 형상에 저런 실루엣만 보이는 벽이 추가됨"): 현관과 계단 앞에 세운 노랑·회색 세로 살 벽. 살 사이로 안이 비친다 ----
SS = f'{U2}01-혜인관-정면-운동장에서.jpg, {U3}02-혜인관-정면-흐린날.jpg, {U3}08-혜인관-정면-전광판-줄무늬출입부.jpg, 사용자-SMAP높이-20261010/사진-28-운동장-고각전경.png, S-MAP 1 m 메시'
SGR = '확정(현관 앞에 노랑·회색 세로 줄무늬 가림벽이 더해졌고 운동장 높이 문이 둘: 사용자 사진·말 2026-10-12), S-MAP(윗면 157.0, 폭 20 m 쯤), 추정(폭 21.2 m·벽에서 5 m, 살 폭·간격, 색 나눔은 사진 01 의 비, 문 자리)'
HW, SF, TOP = 10.6, 5.0, 157.0
BANDS = [(0.068, 'y'), (0.192, 'g'), (0.257, 'y'), (0.289, 'g'), (0.478, 'y'), (0.700, 'g'), (0.896, 'y'), (0.948, 'g'), (1.001, 'y')]   # 사진 01 에서 왼쪽(북동)부터 잰 색 띠의 끝
DOORS = [(0.322, 0.394), (0.605, 0.678)]; COL = {'y': '#d39a2c', 'g': '#666b72'}
n = int(2 * HW / 0.45)
for k in range(n):
    s1 = HW - k * 0.45; s0 = s1 - 0.27; fr = (HW - (s0 + s1) / 2) / (2 * HW)
    col = COL[next(c for e, c in BANDS if fr < e)]; door = any(a <= fr <= b for a, b in DOORS)
    box(f'B13-HYEIN-SCREEN-SLAT-{k + 1:02d}', 'wall', F(s0, s1, SF, SF + 0.15), (GND + 2.3) if door else GND - 0.1, TOP - 0.4, '출입부 가림벽의 세로 살(폭 0.27 m, 간격 0.45 m). 살 사이는 비어 있어 안의 현관·계단이 비친다' + (' 문 자리는 2.3 m 위부터' if door else ''), SS, SGR, '혜인관 둘레 149.0', color=col)
for tag, sg in (('R', -1), ('L', 1)):
    for k in range(10):
        f1 = SF - k * 0.45; f0 = f1 - 0.27
        box(f'B13-HYEIN-SCREEN-SIDE-{tag}{k + 1:02d}', 'wall', F(min(sg * HW, sg * (HW + 0.15)), max(sg * HW, sg * (HW + 0.15)), f0, f1), GND - 0.1 if f0 > 3.4 else GND + 2.5, TOP - 0.4, '가림벽 옆면의 세로 살(계단 발치로 드나드는 곳은 2.5 m 위부터)', SS, SGR, '혜인관 둘레 149.0', color=COL['y'])
for k, (a, b, f0, f1) in enumerate(((-HW - 0.15, HW + 0.15, SF - 0.25, SF + 0.25), (-HW - 0.15, -HW + 0.35, 0.2, SF - 0.25), (HW - 0.35, HW + 0.15, 0.2, SF - 0.25))):
    box(f'B13-HYEIN-SCREEN-TOP-{k + 1}', 'canopy', F(a, b, f0, f1), TOP - 0.4, TOP, '가림벽 머리의 짙은 테두리(윗면 157.0 m: S-MAP). 윗면은 막지 않았다: 사진 28 에서는 막힌 윗면으로 보이나 안의 계단이 보이게 테두리만 둠', SS, SGR, '없음(살 위)', color='#3f4349')
box('B13-HYEIN-SCREEN-LED', 'wall', F(-7.5, 7.5, SF - 0.1, SF + 0.3), TOP, TOP + 2.2, '가림벽 위의 전광판(사진 08: 폭이 출입부의 0.7, 높이 2 m 남짓). 화면은 그리지 않음. 사진 01·02 에는 그 자리에 흰 현수막', f'{U3}08-혜인관-정면-전광판-줄무늬출입부.jpg', '확정(전광판이 있다: 사진 08), 추정(치수)', 'B13-HYEIN-SCREEN-TOP-1', color='#1f2a36')
disc('B13-HYEIN-POWER-SIGN', lambda a, b, f0, f1: F(a, b, f0, f1), 0.3, 163.6, 1.7, 0.0, 0.25, '출입부 위 벽의 전원 버튼 모양 조형(사진 08: 전광판 위, 2~3층 창 사이). 벽에 붙은 것으로 봄', f'{U3}08-혜인관-정면-전광판-줄무늬출입부.jpg', '확정(있다: 사진 08), 추정(자리·크기, 벽에 붙었는지)', '혜인관 운동장 쪽 벽', color='#cfd3d6')
# ---- 옥상 북동 높은 상자의 전원 버튼 원판(사진 01·02·05: 왼쪽 위) ----
TS = f'{U3}05-혜인관-윗부분-가까이-전원버튼-컨테이너.jpg, {U2}01-혜인관-정면-운동장에서.jpg'
disc('B13-HYEIN-ROOF-POWER', lambda a, b, f0, f1: R(a, b, 1.8 - f0, 1.8 - f1), 80.0, 176.0, 2.1, 0.0, 0.25, '옥상 북동 높은 상자의 운동장 쪽 면에 붙은 전원 버튼 원판(지름 4 m 남짓)', TS, '확정(둥근 전원 버튼 원판: 사진·글), 추정(자리·크기)', '혜인관#북동높은상자 벽', color='#c4c8cc')
disc('B13-HYEIN-ROOF-POWER-RING', lambda a, b, f0, f1: R(a, b, 1.8 - f0, 1.8 - f1), 80.0, 176.0, 1.35, 0.25, 0.33, '전원 버튼 원판의 안쪽 원', TS, '확정(사진), 추정(크기)', 'B13-HYEIN-ROOF-POWER', K=5, color='#8d939a')
box('B13-HYEIN-ROOF-POWER-BAR', 'wall', R(79.82, 80.18, 1.8 - 0.33, 1.8 - 0.4), 176.2, 177.6, '전원 버튼의 세로 막대', TS, '확정(사진), 추정(크기)', 'B13-HYEIN-ROOF-POWER', color='#eef0f1')
# ---- 화단의 낮은 나무 줄(사진 01·02: 출입부 양옆 벽 앞) ----
for tag, (a, b) in (('S', (6.5, 34.5)), ('N', (58.5, 86.0))):
    for k, s in enumerate(np.linspace(a, b, 6)):
        tree(f'B13-HYEIN-TREE-{tag}{k + 1}', P(s, -1.1), 149.5, '혜인관 운동장 쪽 화단의 낮은 나무 줄', f'{U2}01-혜인관-정면-운동장에서.jpg', f'Z05-HYEIN-PLANTER-{tag}', s=0.8)
# ---- 북동 옆면(정면에서 볼 때 왼쪽 옆면, 사용자 확정 2026-10-12): 붉은 기와 지붕의 작은 아치 현관과 문, 유리 지붕 쉼터와 벤치, 오른쪽의 콘크리트 어귀 ----
NS = f'{U2}02-혜인관-좌측면(정면기준)-현관과-정류장.jpg'
NG = '확정(이 면이 정면 기준 왼쪽 옆면: 사용자 2026-10-12. 작은 아치 현관·문·유리 지붕 쉼터·벤치·오른쪽 콘크리트 어귀: 사진), 추정(자리: 옆면 가운데에서 운동장 쪽으로 치우침, 치수 전부)'
Z0 = GND; PD = 7.0   # 옆면 앞 바닥(둘레 평면), 현관 가운데(운동장 쪽 모서리에서 7 m)
box('B13-HYEIN-NE-PORCH-BASE', 'wall', G(0, 3.0, PD - 2.8, PD + 2.8), Z0, Z0 + 2.6, '북동 옆면 현관의 아래 벽돌 덩어리(폭 5.6 m, 내밂 3 m, 높이 2.6 m). 가운데에 문', NS, NG, '혜인관 둘레 149.0', material='brick')
box('B13-HYEIN-NE-PORCH-DOOR', 'wall', G(3.0, 3.07, PD - 0.6, PD + 0.6), Z0, Z0 + 2.2, '북동 옆면의 문(붉은 문, 운동장 높이 = 학교 표기 지하 1층 입구(2)). 벽면의 문 자리를 나타내는 판', NS, NG, '혜인관 둘레 149.0', color='#7c2b27')
for tag, sg in (('A', -1), ('B', 1)):
    for j in range(4):
        d0, d1 = PD + sg * (2.8 + 1.1 * j), PD + sg * (2.8 + 1.1 * (j + 1))
        box(f'B13-HYEIN-NE-PORCH-FLANK-{tag}{j + 1}', 'wall', G(0.2, 2.2, min(d0, d1), max(d0, d1)), Z0 - 0.2, Z0 + 2.6 - 0.6 * (j + 1), '현관 양옆의 비스듬한 벽돌 옆벽(바깥으로 낮아진다: 네 마디로 줄임). 계단을 가린 벽인지는 모름', NS, NG, '혜인관 둘레 149.0', material='brick')
for k, dc in enumerate((PD - 1.1, PD + 1.1)): box(f'B13-HYEIN-NE-PORCH-PIER-{k + 1}', 'wall', G(1.0, 2.4, dc - 0.25, dc + 0.25), Z0 + 2.6, Z0 + 6.0, '현관 윗부분의 벽돌 기둥(아치 하나)', NS, NG, 'B13-HYEIN-NE-PORCH-BASE', material='brick')
box('B13-HYEIN-NE-PORCH-HEADER', 'wall', G(1.0, 2.4, PD - 1.35, PD + 1.35), Z0 + 5.4, Z0 + 6.0, '아치 위 벽돌 벽', NS, NG, '없음(기둥 위)', material='brick')
arches('B13-HYEIN-NE-PORCH', lambda a, b, g0, g1: G(g0, g1, a, b), [(PD - 0.85, PD + 0.85)], 1.0, 2.4, Z0 + 5.4, 'brick', '북동 옆면 현관의 아치', NS, K=4)
box('B13-HYEIN-NE-PORCH-EAVE', 'canopy', G(0, 3.0, PD - 1.9, PD + 1.9), Z0 + 6.0, Z0 + 6.25, '흰 처마 띠', NS, NG, '없음(벽 위)', material='white_stone')
box('B13-HYEIN-NE-PORCH-ROOF-1', 'canopy', G(0, 2.8, PD - 1.7, PD + 1.7), Z0 + 6.25, Z0 + 7.0, '붉은 기와 지붕 아랫단', NS, NG, 'B13-HYEIN-NE-PORCH-EAVE', material='roof_red')
box('B13-HYEIN-NE-PORCH-ROOF-2', 'canopy', G(0, 2.0, PD - 1.0, PD + 1.0), Z0 + 7.0, Z0 + 7.7, '붉은 기와 지붕 윗단', NS, NG, 'B13-HYEIN-NE-PORCH-ROOF-1', material='roof_red')
box('B13-HYEIN-NE-SHELTER-ROOF', 'canopy', G(3.3, 6.3, PD - 6.5, PD + 6.5), Z0 + 2.75, Z0 + 2.9, '문 앞 유리 지붕 쉼터(폭 13 m, 깊이 3 m, 높이 2.8 m)', NS, NG, '없음(기둥 위)', color='#86aeb0')
for k, (g, d) in enumerate(((3.4, PD - 6.4), (3.4, PD + 6.4), (6.2, PD - 6.4), (6.2, PD + 6.4), (6.2, PD))): box(f'B13-HYEIN-NE-SHELTER-POST-{k + 1}', 'wall', G(g - 0.07, g + 0.07, d - 0.07, d + 0.07), Z0, Z0 + 2.75, '쉼터의 청록 기둥', NS, NG, '혜인관 둘레 149.0', color='#3f857f')
for k, (d0, d1) in enumerate(((PD - 5.8, PD - 1.6), (PD + 1.6, PD + 5.8))): box(f'B13-HYEIN-NE-SHELTER-BENCH-{k + 1}', 'wall', G(3.5, 4.0, d0, d1), Z0, Z0 + 0.45, '쉼터 안의 벤치', NS, NG, '혜인관 둘레 149.0', material='timber')
# 콘크리트 어귀: 옆면 앞에서 볼 때 오른쪽(운동장 쪽), 아래로 내려가는 입구. 문틀 상자만(어디로 이어지는지는 추정: 지하 진입로로 보임)
OG = '확정(옆면 오른쪽에 아래로 내려가는 콘크리트 어귀가 있다: 사진 02), 추정(자리·폭 4.6 m·높이, 어디로 이어지는지: 지하 진입로로 보임. 안쪽은 만들지 않음)'
OD0, OD1, OGX = -9.6, -5.0, 4.5
for k, (d0, d1) in enumerate(((OD0 - 0.35, OD0), (OD1, OD1 + 0.35))): box(f'B13-HYEIN-NE-PORTAL-PIER-{k + 1}', 'wall', G(OGX - 3.0, OGX, d0, d1), Z0 - 0.3, Z0 + 2.3, '콘크리트 어귀의 옆벽', NS, OG, '혜인관 둘레 149.0', material='concrete')
box('B13-HYEIN-NE-PORTAL-LINTEL', 'wall', G(OGX - 3.0, OGX, OD0 - 0.35, OD1 + 0.35), Z0 + 2.3, Z0 + 2.8, '콘크리트 어귀의 윗판(위에 화단)', NS, OG, '없음(옆벽 위)', material='concrete', topColor='#7f9a6b')
box('B13-HYEIN-NE-PORTAL-OPENING', 'canopy', G(OGX - 0.6, OGX - 0.5, OD0, OD1), Z0 - 0.3, Z0 + 2.3, '어두운 판은 뚫린 곳을 나타내는 표시다(안쪽 빈 곳은 만들지 않음: 안의 선·바닥 높이 모름)', NS, OG, '혜인관 둘레 149.0', material='opening')
# ---- 북동 옆면 앞의 화단(사용자 2026-10-12: 화단도 대략 표현): 사진 02 왼쪽의 돌 턱 화단과 생울타리·나무, 오른쪽 어귀 옆의 둥근 돌 화분과 단풍나무. 기본 평면 위에 얹은 상자다(지형은 그대로) ----
HG_ = '확정(옆면 앞 왼쪽에 돌 턱 화단과 생울타리, 오른쪽에 둥근 돌 화분과 나무: 사진 02), 추정(외곽·높이·그루 수)'
box('B13-HYEIN-NE-PLANTER-EDGE', 'planter', G(2.5, 9.5, PD + 7.2, 21.0), Z0 - 0.2, Z0 + 0.5, '북동 옆면 앞 왼쪽(운동장 반대쪽)의 화단: 돌 턱 0.5 m, 윗면은 심은 곳', NS, HG_, '혜인관 둘레 149.0', material='stone')
box('B13-HYEIN-NE-PLANTER-HEDGE', 'planter', G(3.0, 9.0, PD + 7.6, 20.6), Z0 + 0.5, Z0 + 1.1, '화단 위의 생울타리(높이 0.6 m)', NS, HG_, 'B13-HYEIN-NE-PLANTER-EDGE', material='foliage')
for k, (g, d) in enumerate(((5.0, PD + 9.5), (6.5, 18.5))): tree(f'B13-HYEIN-NE-TREE-{k + 1}', P(LEN + g, d), Z0 + 0.5, '북동 옆면 앞 화단의 나무', NS, 'B13-HYEIN-NE-PLANTER-EDGE', s=0.9)
ang = [np.radians(22.5 + 45 * k) for k in range(8)]; oc = P(LEN + 6.6, -3.2)
box('B13-HYEIN-NE-ROUND-PLANTER', 'planter', [(oc[0] + 1.0 * np.cos(t), oc[1] + 1.0 * np.sin(t)) for t in ang], Z0 - 0.2, Z0 + 0.6, '어귀 옆의 둥근 돌 화분(지름 2 m: 여덟 모로)', NS, HG_, '혜인관 둘레 149.0', material='stone')
tree('B13-HYEIN-NE-TREE-3', P(LEN + 4.6, -1.6), Z0, '북동 옆면 운동장 쪽 모서리 앞의 단풍나무', NS, '혜인관 둘레 149.0', s=0.9)
ids = [f['properties']['id'] for f in FEATS]; assert len(ids) == len(set(ids))
out = {'type': 'FeatureCollection', 'name': 'b13-hyein', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/b13/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '혜인관 운동장 쪽 출입부(벽돌 현관, 양쪽 계단, 줄무늬 가림벽, 전광판), 옥상 전원 버튼 원판, 화단 나무, 북동 옆면의 작은 현관·쉼터·콘크리트 어귀. 치수는 눈대중(추정).'}, 'features': FEATS}
OUTF.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print('features', len(FEATS))
