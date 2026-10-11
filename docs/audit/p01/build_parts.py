"""P01: 사용자 전경 사진·아치 건물 사진·네이버 거리뷰에 있는데 지도에 없던 것을 구조물 상자로 더한다. DB·네트워크 접근 없음.   python build_parts.py
쓰는 파일: frontend/public/structures/p01-parts.geojson (형식 docs/audit/g02/STRUCTURES.md). 전부 estimated(치수는 사진 눈대중, 자리는 S-MAP 메시와 거리뷰 지점).
근거 그림은 볼트의 데이터/보완자료/3d-map-audit-20261009/ 아래 폴더(사용자-회차공간서쪽-유담관아케이드-20261012, 사용자-네이버거리뷰-20261012, 사용자-학교전경-20261012)."""
import json, math, pathlib
import numpy as np
from shapely.geometry import Polygon
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
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
        box(f'{tid}-{part}', 'tree', sq(c, h * s), z + z0 * s, z + z1 * s, f'{what}: 단순한 나무(실제 그루 수·자리·수종의 모양이 아니다)', src, '확정(이 자리에 소나무: 사진), 추정(그루 수·자리·크기)', base, material=mat)
def arch_panel(pid, R, c, w, z0, spring, d0, d1, color, what, src, grade, base, K=5):
    """벽면의 머리가 둥근 칸: 곧은 부분(z0~spring) + 반원(반지름 w/2)을 가로 띠 K 개로 줄인 것."""
    r = w / 2; box(f'{pid}-BODY', 'wall', R(c - r, c + r, d0, d1), z0, spring, what, src, grade, base, color=color)
    for k in range(K):
        za, zb = r * k / K, r * (k + 1) / K; hw = math.sqrt(max(r * r - ((za + zb) / 2) ** 2, 0.0))
        box(f'{pid}-HEAD{k + 1}', 'wall', R(c - hw, c + hw, d0, d1), spring + za, spring + zb, f'{what}: 둥근 머리(반지름 {r:.2f} m)를 가로 띠 {K}개로 줄인 조각', src, grade, base, color=color)
def disc(pid, R, c, zc, r, d0, d1, color, what, src, grade, base, K=4):
    for k in range(2 * K):
        za, zb = -r + r * k / K, -r + r * (k + 1) / K; hw = math.sqrt(max(r * r - ((za + zb) / 2) ** 2, 0.0))
        box(f'{pid}-{k + 1}', 'wall', R(c - hw, c + hw, d0, d1), zc + za, zc + zb, what, src, grade, base, color=color)
SLAT = {'y': '#d39a2c', 'g': '#666b72'}   # 노랑·회색 세로 살(혜인관 출입부 B13 과 같은 색을 쓴다)
GRANITE, GLASS_DARK, TRACERY = '#3f4146', '#252b30', '#c9d2cf'
EV = '데이터/보완자료/3d-map-audit-20261009/'

# ================= 1. 회차 공간 서쪽의 아치 건물(유담관 간판) =================
ASRC = '사용자-회차공간서쪽-유담관아케이드-20261012/12-거리뷰화면-사용자표시-유담관입구.webp, 같은 폴더 04·05·07·09·02·06, 10-네이버거리뷰(2025-12-18), S-MAP 1 m 메시(z04/smap-mesh-z04-1m-w0)'
AG = '확정(회차 공간 서쪽 가장자리는 유담관 간판의 한 층 아치 건물, 맨 남쪽 아치 문 = 유담관 입구: 사용자 2026-10-12), 원천(칸 차례: 사용자 사진·거리뷰), S-MAP(벽 선·길이·윗면 135.3 m), 추정(칸 폭·창과 문 치수)'
wx = lambda y: 201007.7 + (y - 557250) * (200983.5 - 201007.7) / 176   # 서쪽 옹벽 선(Z05)
A_DIR = (200983.5 - 201007.7, 176.0); A_O = (wx(557308.0) + 9.8, 557308.0)
AR, AP = frame(A_O, A_DIR, (1, 0))   # s = 정면을 따라 북으로(남쪽 끝 0), d = 회차 공간 쪽(동)
BAY, NB, DEPTH, FOOT, SILL, TOP = 3.6, 14, 8.8, 130.0, 131.2, 135.3
ALEN = BAY * NB
BAYS = 'D' + 'W' * 5 + 'DD' + 'W' * 5 + 'D'   # 남 → 북: 유담관 입구, 창 5, 문 2(출입구·THE BEAUTY SHOP), 창 5, 문(1164 정류장 표지), 그 북쪽에 세로 살 구조물
DOOR_NAMES = {0: '맨 남쪽 아치 문 = 유담관 입구(사용자 표시)', 6: '가운데 아치 문(출입구)', 7: '가운데 아치 문(THE BEAUTY SHOP 유리)', 13: '북쪽 끝 아치 문(1164 정류장 표지 옆)'}
ENTRANCE = AP(0.5 * BAY, 0.0)   # 유담관 입구 문 가운데(길 노드를 여기에 둔다)
def arcade():
    box('P01-ARCADE-BLOCK', 'wall', AR(0, ALEN, -DEPTH, 0), FOOT, TOP, f'아치 건물 덩어리: 정면 {ALEN:.1f} m(칸 {NB} × {BAY} m), 깊이 {DEPTH} m(옹벽 머리 안쪽 1 m 까지), 윗면 135.3 m. 지붕은 소나무 화단. 옹벽 쪽·남쪽·북쪽 면은 사진에 없어 민무늬 짙은 돌', ASRC, AG, 'Z05-PLATFORM-WEST-WALLTOP-PLANTER', color=GRANITE, topColor='#7f9a6b')
    box('P01-ARCADE-CORNICE', 'wall', AR(-0.1, ALEN + 0.1, 0, 0.15), TOP - 0.45, TOP + 0.05, '벽 머리의 가는 돌 띠', ASRC, AG, 'P01-ARCADE-BLOCK', color='#55585e')
    box('P01-ARCADE-WALK', 'landing', AR(-4.0, ALEN + 7.4, -0.05, 2.25), SILL - 0.6, SILL + 0.05, '벽 발치의 돌 단(문턱 높이 131.2 m, 폭 2.2 m): 창 밑의 낮은 돌 기단 띠이자 맨 남쪽 문으로 돌아 들어가는 걷는 자리. 전의 초록 화단 띠 가장자리를 덮는다', ASRC, AG, 'Z05-PLATFORM-WEST-WALLTOP-PLANTER', color='#8f9296')
    for k, kind in enumerate(BAYS):
        c = (k + 0.5) * BAY; pid = f'P01-ARCADE-BAY{k + 1:02d}'
        if kind == 'D':
            arch_panel(pid + '-DOOR', AR, c, 2.7, SILL, 133.0, 0.0, 0.08, GLASS_DARK if k != 7 else '#2c5f66', DOOR_NAMES[k] + ': 폭 2.7 m, 머리 134.35 m', ASRC, AG, 'P01-ARCADE-BLOCK')
            box(pid + '-TRANSOM', 'wall', AR(c - 1.35, c + 1.35, 0.0, 0.12), 133.0, 133.14, '문 위 가로대(그 위는 부채꼴 살 창)', ASRC, AG, 'P01-ARCADE-BLOCK', color=TRACERY)
            box(pid + '-MULLION', 'wall', AR(c - 0.05, c + 0.05, 0.0, 0.12), 133.14, 134.3, '부채꼴 살 창의 가운데 살', ASRC, AG, 'P01-ARCADE-BLOCK', color=TRACERY)
        else:
            arch_panel(pid + '-WINDOW', AR, c, 2.0, 131.9, 133.2, 0.0, 0.08, TRACERY, '바퀴 살 무늬의 머리 둥근 창: 폭 2.0 m, 창턱 131.9, 머리 134.2 m(흰 살이 촘촘해 밝게 그림)', ASRC, AG, 'P01-ARCADE-BLOCK')
            disc(pid + '-HUB', AR, c, 133.3, 0.5, 0.08, 0.11, GLASS_DARK, '창의 바퀴 가운데(짙은 유리)', ASRC, AG, 'P01-ARCADE-BLOCK', K=3)
            for j, cc in enumerate((c - 0.5, c + 0.5)): box(f'{pid}-PANE{j + 1}', 'wall', AR(cc - 0.3, cc + 0.3, 0.08, 0.11), 132.05, 132.6, '창 아래쪽 네모 칸(짙은 유리)', ASRC, AG, 'P01-ARCADE-BLOCK', color=GLASS_DARK)
    for name, (s0, s1) in (('MID', (6 * BAY, 8 * BAY)), ('NORTH', (13 * BAY, 14 * BAY))):   # 문 앞 두 단(문턱 131.2 → 포장 130.6)
        for j, top in enumerate((131.0, 130.8)): box(f'P01-ARCADE-STEPS-{name}-S{2 - j:02d}', 'stair_step', AR(s0 + 0.2, s1 - 0.2, 2.25 + 0.3 * j, 2.55 + 0.3 * j), 130.0, top, '문 앞 돌 단(사진 09: 두세 단). 단 높이 0.2 m', ASRC, AG, '회차 공간 포장면', stair=f'P01-ARCADE-STEPS-{name}')
    box('P01-ARCADE-SIGN', 'wall', AR(8.6 * BAY, 10.4 * BAY, 0.0, 0.14), 134.2, 135.15, '"유담관" 현수막(사진 05: 가운데 문 북쪽 둘째~셋째 창 위)', '사용자-회차공간서쪽-유담관아케이드-20261012/05-유담관간판-아치벽.jpg', '확정(유담관 간판이 이 벽에 붙음: 사진), 추정(자리·크기)', 'P01-ARCADE-BLOCK', color='#eef0ea')
    box('P01-ARCADE-SIGN-MARK', 'wall', AR(8.6 * BAY, 8.6 * BAY + 1.2, 0.0, 0.17), 134.2, 135.15, '현수막 왼쪽의 초록 표지', '같음', '추정', 'P01-ARCADE-SIGN', color='#4a9a5c')
    LSRC = '사용자-회차공간서쪽-유담관아케이드-20261012/09-아치벽-밤-정면-전광판.jpg, 10-네이버거리뷰-면-r·b.jpg'
    box('P01-ARCADE-LED-EAST', 'wall', AR(8.2 * BAY, ALEN, -0.6, -0.3), TOP, TOP + 2.2, '지붕 가장자리의 전광판(가운데 문 북쪽부터 북쪽 끝까지, 높이 2.2 m 눈대중). 화면은 그리지 않음', LSRC, '확정(전광판: 사진·거리뷰), 추정(범위·높이)', 'P01-ARCADE-BLOCK', color='#2a2f45')
    box('P01-ARCADE-LED-NORTH', 'wall', AR(ALEN - 0.6, ALEN - 0.3, -6.0, -0.6), TOP, TOP + 2.2, '전광판이 북쪽 면으로 돌아간 부분(거리뷰 01)', LSRC, '원천(거리뷰), 추정(길이)', 'P01-ARCADE-BLOCK', color='#2a2f45')
    # 북쪽 끝의 노랑·회색 세로 살 구조물(전경 사진 11 과 같은 것)
    TS = '사용자-회차공간서쪽-유담관아케이드-20261012/02·06, 사용자-학교전경-20261012/11-주차장입구옆-줄무늬구조물-4컷.jpg, 10-네이버거리뷰-면-b.jpg'
    TG = '확정(북쪽 끝 아치 문 옆의 노랑·회색 세로 살 구조물: 사진·거리뷰), 추정(평면 3 × 3.8 m·높이 6.8 m)'
    T0, T1, TD0, TD1, TZ = ALEN, ALEN + 3.0, -3.4, 0.4, 137.4
    box('P01-ARCADE-SLAT-CORE', 'wall', AR(T0, T1, TD0, TD1), FOOT, TZ, '세로 살 구조물의 몸(회색 살). 안에 긴 의자가 있는 쉼터(사진 11)', TS, TG, 'Z05-PLATFORM-WEST-WALLTOP-PLANTER', color=SLAT['g'])
    for j in range(4): box(f'P01-ARCADE-SLAT-E{j + 1}', 'wall', AR(T0 + 0.2 + 0.75 * j, T0 + 0.55 + 0.75 * j, TD1, TD1 + 0.06), SILL, TZ, '노랑 살(정면)', TS, TG, 'P01-ARCADE-SLAT-CORE', color=SLAT['y'])
    for j in range(5):
        box(f'P01-ARCADE-SLAT-N{j + 1}', 'wall', AR(T1, T1 + 0.06, TD0 + 0.2 + 0.75 * j, TD0 + 0.55 + 0.75 * j), SILL, TZ, '노랑 살(북쪽 면)', TS, TG, 'P01-ARCADE-SLAT-CORE', color=SLAT['y'])
        box(f'P01-ARCADE-SLAT-S{j + 1}', 'wall', AR(T0 - 0.06, T0, TD0 + 0.2 + 0.75 * j, TD0 + 0.55 + 0.75 * j), TOP + 0.05, TZ, '노랑 살(남쪽 면, 지붕 위로 보이는 부분)', TS, TG, 'P01-ARCADE-SLAT-CORE', color=SLAT['y'])
    # 지붕의 소나무 줄, 북쪽 문 옆 낮은 화분과 소나무(사진 02)
    for j, s in enumerate((2.0, 8.5, 15.0, 21.5, 28.0, 34.5, 41.0, 47.0)): tree(f'P01-ARCADE-PINE-{j + 1}', AP(s, -3.6 - 1.8 * (j % 2)), TOP, '아치 건물 지붕의 소나무 줄', ASRC, 'P01-ARCADE-BLOCK', s=1.15)
    box('P01-ARCADE-DOORPLANTER', 'planter', AR(12.1 * BAY, 12.9 * BAY, 0.4, 1.9), SILL, SILL + 0.55, '북쪽 끝 문 왼쪽의 낮은 검은 돌 화분(사진 02)', TS, '확정(화분과 소나무: 사진 02), 추정(외곽)', 'P01-ARCADE-WALK', color='#2f3136')
    tree('P01-ARCADE-DOORPINE', AP(12.5 * BAY, 1.15), SILL + 0.55, '북쪽 끝 문 옆 화분의 소나무', TS, 'P01-ARCADE-DOORPLANTER', s=0.8)
    # 맨 남쪽 문 앞의 굽은 여러 단 흰 돌 화단(사용자 표시 그림 12: 돌아서 들어간다)
    PS = '사용자-회차공간서쪽-유담관아케이드-20261012/12-거리뷰화면-사용자표시-유담관입구.webp, S-MAP 1 m 메시(그 자리 131.1~131.3 m)'
    PG = '확정(유담관 입구 앞의 굽은 여러 단 흰 돌 화단과 소나무, 돌아 들어감: 사용자 표시 그림), S-MAP(윗면 131.2 m 쯤), 추정(외곽·단 수)'
    def tier(s0, s1, d0, d1, cut): return [AP(s0, d0), AP(s1 - cut, d0), AP(s1, d0 + cut), AP(s1, d1 - cut), AP(s1 - cut, d1), AP(s0, d1)]
    box('P01-ARCADE-FRONTPLANTER-1', 'planter', tier(-3.0, 15.5, 2.25, 8.6, 2.2), 128.6, 131.25, '입구 앞 화단 아랫단(흰 돌 쌓기). 북쪽 끝은 모를 죽임(굽은 끝)', PS, PG, 'Z05-PLATFORM-TURN-WEST-EDGE', material='white_stone')
    box('P01-ARCADE-FRONTPLANTER-2', 'planter', tier(-3.0, 13.0, 3.6, 7.2, 1.4), 131.25, 131.8, '입구 앞 화단 윗단', PS, PG, 'P01-ARCADE-FRONTPLANTER-1', material='white_stone')
    for j, s in enumerate((0.5, 6.0, 11.0)): tree(f'P01-ARCADE-FRONTPINE-{j + 1}', AP(s, 5.4), 131.8, '입구 앞 화단의 소나무', PS, 'P01-ARCADE-FRONTPLANTER-2')
    # 아치 건물 남쪽의 더 높은 짙은 돌 덩어리(큰 둥근 머리 창 하나와 초록 현수막)
    MS = '사용자-회차공간서쪽-유담관아케이드-20261012/12-거리뷰화면-사용자표시-유담관입구.webp, S-MAP 1 m 메시(141.9 m 칸 10개)'
    MG = 'S-MAP(자리·윗면 141.9 m), 원천(짙은 돌·둥근 머리 창: 거리뷰 화면), 추정(외곽 7 × 7 m, 무엇인지: 유담관의 낮은 덩어리로 봄)'
    MASS = [(201009.2, 557298.2), (201015.6, 557297.0), (201017.2, 557303.2), (201010.8, 557305.2)]
    box('P01-ARCADE-SOUTHMASS', 'wall', MASS, 129.0, 141.9, '아치 건물 남쪽 끝 옆의 높은 짙은 돌 덩어리', MS, MG, 'Z05-PLATFORM-YUDAM9-YUDAM-NORTH', color=GRANITE)
    MR, _ = frame(MASS[3], np.array(MASS[2]) - np.array(MASS[3]), (0.3, 1))
    arch_panel('P01-ARCADE-SOUTHMASS-WINDOW', MR, 3.3, 2.6, 135.0, 137.6, 0.0, 0.08, '#1d2a44', '높은 덩어리의 북쪽 면 큰 둥근 머리 창(짙은 파랑 유리)', MS, MG, 'P01-ARCADE-SOUTHMASS')

# ================= 2. 본관 서쪽 끝: 흰 돌 아치 출입부(입구(2)), 빨간 전화 부스, 돌 화단, 북서 모서리의 흡연장 =================
BW_A, BW_B = np.array([201033.39, 557319.39]), np.array([201044.69, 557344.2])   # 본관 서쪽 끝 면(외곽 = 처마 선). 벽은 1.5 m 안쪽
WR, WP = frame(BW_A, BW_B - BW_A, (-1, 0.4))   # s = 남서 모서리에서 북으로, d = 회차 공간 쪽(처마 선 0, 벽 -1.5)
PORCH_S = 19.8; PORCH_DOOR, PORCH_FRONT = WP(PORCH_S, 1.9), WP(PORCH_S, 4.0)
def bongwan_west():
    SRC = '사용자-네이버거리뷰-20261012/23-사용자표시-지하통로입구-흰아치-빨간전화부스옆.webp, 02-네이버거리뷰-전방위.jpg, 사용자-학교전경-20261012/10-돌벽건물-아치입구-빨간전화부스.jpg, 학교 표지 본관 입구(2) (201041.5, 557338.5)'
    G = '확정(본관 서쪽 끝 발치의 흰 돌 아치 구조물을 사용자가 표시), 원천(자리 = 학교 표지 본관 입구(2), 모습: 거리뷰), 추정(치수)'
    z = 130.7
    for k, (a, b) in enumerate(((17.3, 18.8), (20.8, 22.6))): box(f'P01-BONGWAN-WPORCH-WALL-{k + 1}', 'wall', WR(a, b, -1.5, 1.9), z - 0.5, z + 3.3, '본관 서쪽 끝 출입부의 흰 돌 벽(아치 양옆). 폭 5.3 m, 벽에서 3.4 m 나옴, 높이 3.3 m', SRC, G, '회차 공간 포장면', material='white_stone')
    box('P01-BONGWAN-WPORCH-HEAD', 'wall', WR(18.8, 20.8, -1.5, 1.9), z + 2.5, z + 3.3, '아치 위 흰 돌 벽', SRC, G, '없음(옆벽 위)', material='white_stone')
    box('P01-BONGWAN-WPORCH-INSIDE', 'wall', WR(18.8, 20.8, -1.5, -1.3), z, z + 2.5, '아치 안쪽으로 보이는 주황빛 벽(안은 계단으로 내려감: 추정)', SRC, G, '없음', color='#b9772e')
    r = 1.0
    for k in range(4):   # 아치의 둥근 머리(윗모서리 채움)
        xa, xb = r * math.cos(math.radians(90 * (k + 1) / 4)), r * math.cos(math.radians(90 * k / 4)); zz = z + 1.5 + math.sqrt(max(r * r - ((xa + xb) / 2) ** 2, 0))
        if z + 2.5 - zz < 0.04: continue
        for side, (a, b) in (('L', (PORCH_S - xb, PORCH_S - xa)), ('R', (PORCH_S + xa, PORCH_S + xb))): box(f'P01-BONGWAN-WPORCH-ARCH-{side}{k + 1}', 'wall', WR(a, b, 1.3, 1.9), zz, z + 2.5, '아치 문의 둥근 머리(반지름 1.0 m)를 채운 조각', SRC, G, 'P01-BONGWAN-WPORCH-HEAD', material='white_stone')
    box('P01-BONGWAN-WPORCH-WINDOW', 'wall', WR(21.2, 22.3, 1.9, 1.96), z + 1.3, z + 2.2, '아치 오른쪽의 작은 창', SRC, G, 'P01-BONGWAN-WPORCH-WALL-2', color=GLASS_DARK)
    box('P01-BONGWAN-WPORCH-PLATE', 'wall', WR(20.3, 21.4, 1.9, 1.97), z + 2.65, z + 3.05, '아치 위의 짙은 번호판(2115)', SRC, G, 'P01-BONGWAN-WPORCH-HEAD', color='#3a3d40')
    box('P01-BONGWAN-WPORCH-CANOPY', 'canopy', WR(16.9, 21.2, -1.5, 2.6), z + 3.6, z + 3.8, '출입부 위의 검은 평 차양', SRC, G, '없음(기둥 위)', color='#26282b')
    for k, (s, d) in enumerate(((17.1, 2.4), (21.0, 2.4))): box(f'P01-BONGWAN-WPORCH-POST-{k + 1}', 'wall', WR(s - 0.08, s + 0.08, d - 0.08, d + 0.08), z + 3.3 if k else z, z + 3.6, '차양 기둥', SRC, G, '회차 공간 포장면', color='#26282b')
    box('P01-BONGWAN-WPORCH-BENCH', 'wall', WR(22.9, 24.9, 3.6, 4.1), z, z + 0.45, '아치 왼쪽 화단 앞의 긴 의자', SRC, G, '회차 공간 포장면', color='#5a5d63')
    PG = '원천(출입부 양옆의 돌 화단과 소나무: 거리뷰 02·23, 사진 10), 추정(외곽·높이)'
    box('P01-BONGWAN-WPLANTER-N', 'planter', WR(22.6, 28.6, -1.5, 3.6), z - 0.5, z + 1.2, '출입부 북쪽 돌 화단(흰 돌 쌓기, 높이 1.2 m). 위에 빨간 전화 부스', SRC, PG, '회차 공간 포장면', material='white_stone')
    box('P01-BONGWAN-PHONEBOOTH', 'wall', WR(23.4, 24.5, 1.6, 2.7), z + 1.2, z + 3.7, '빨간 전화 부스', SRC, '확정(빨간 전화 부스: 사진 10·거리뷰), 추정(자리·크기)', 'P01-BONGWAN-WPLANTER-N', color='#c2343a')
    box('P01-BONGWAN-PHONEBOOTH-ROOF', 'canopy', WR(23.3, 24.6, 1.5, 2.8), z + 3.7, z + 3.95, '전화 부스의 둥근 지붕(상자로 줄임)', SRC, '추정', 'P01-BONGWAN-PHONEBOOTH', color='#a8272d')
    box('P01-BONGWAN-WPLANTER-S', 'planter', WR(2.5, 17.3, -1.5, 2.6), z - 2.5, z + 0.9, '출입부 남쪽 돌 화단(흰 돌 쌓기, 높이 0.9 m, 소나무 줄)', SRC, PG, '회차 공간 내리막', material='white_stone')
    for k, s in enumerate((4.5, 9.5, 14.5)): tree(f'P01-BONGWAN-WPINE-{k + 1}', WP(s, 0.9), z + 0.9, '본관 서쪽 끝 화단의 소나무', SRC, 'P01-BONGWAN-WPLANTER-S')
    tree('P01-BONGWAN-WPINE-4', WP(26.8, 1.2), z + 1.2, '본관 서쪽 끝 북쪽 화단의 소나무', SRC, 'P01-BONGWAN-WPLANTER-N', s=0.9)
    # 북서 모서리의 흡연장(노란 세로 살 상자). 입구가 아니다(사용자 2026-10-12)
    NB_ = np.array([201104.2, 557314.95]); NR, NP = frame(BW_B, NB_ - BW_B, (0.44, 0.9))   # s = 북서 모서리에서 내리막길을 따라 동으로, d = 길 쪽
    SS = '사용자-네이버거리뷰-20261012/22-사용자표시-노란상자는-흡연장-X.webp, 21-네이버거리뷰-면-r.jpg'
    SG = '확정(노란 세로 살 상자 = 흡연장, 입구 아님: 사용자 2026-10-12), 원천(본관 북서 모서리의 북쪽 벽 앞: 거리뷰 21), 추정(자리 ±2 m·크기 4.6 × 2.6 × 2.8 m)'
    zs = 131.5
    box('P01-SMOKING-BOOTH', 'wall', NR(1.0, 5.6, -1.5, 1.1), zs - 0.6, zs + 2.8, '흡연장: 노란 세로 살로 싼 상자. 길을 잇지 않는다', SS, SG, 'G02-PLATFORM-WAY', color=SLAT['y'])
    for j in range(9): box(f'P01-SMOKING-BOOTH-SLAT-{j + 1}', 'wall', NR(1.15 + 0.5 * j, 1.35 + 0.5 * j, 1.1, 1.15), zs, zs + 2.8, '살 사이의 어두운 틈(세로 살로 읽히게)', SS, SG, 'P01-SMOKING-BOOTH', color='#8a6a1c')
    box('P01-SMOKING-BOOTH-MAP', 'wall', NR(2.6, 5.0, 1.1, 1.19), zs + 1.1, zs + 2.3, '살 위의 캠퍼스 안내도 판', SS, SG, 'P01-SMOKING-BOOTH', color='#3d3d3f')
    box('P01-SMOKING-BOOTH-DOOR', 'wall', NR(1.5, 2.3, 1.1, 1.19), zs, zs + 2.2, '들어간 어두운 문 판(노란 원 표지)', SS, SG, 'P01-SMOKING-BOOTH', color='#35373a')
    disc('P01-SMOKING-BOOTH-SIGN', NR, 1.9, zs + 1.75, 0.22, 1.19, 1.23, '#e3b322', '문 판의 노란 원 표지', SS, SG, 'P01-SMOKING-BOOTH-DOOR', K=2)
    box('P01-SMOKING-BOOTH-INFO', 'wall', NR(4.3, 5.7, 0.2, 1.2), zs + 2.8, zs + 3.4, '위의 ⓘ INFORMATION 판', SS, SG, 'P01-SMOKING-BOOTH', color='#4a4a4c')
    box('P01-SMOKING-BOOTH-PLANTER', 'planter', [WP(27.4, 0.2), WP(30.2, 0.2), NP(0.8, 2.6), NP(0.8, -1.2)], zs - 1.2, zs + 0.9, '흡연장 옆(모서리)의 돌 화단', SS, '원천(거리뷰 22), 추정(외곽)', 'G02-PLATFORM-WAY', material='white_stone')

# ================= 3. 본관 남서·남쪽 앞: 둥근 여러 단 돌 화단, 계단식 돌 화단과 돌계단 =================
def bongwan_south():
    SRC = '사용자-네이버거리뷰-20261012/03·04·05·06-네이버거리뷰-전방위.jpg, S-MAP 1 m 메시(본관 남쪽 단 127.0~127.9 m, 차도 123~127 m)'
    G = '원천(본관 남서 모서리 앞의 둥근 여러 단 돌 화단과 소나무, 남쪽 앞의 계단식 돌 화단·넓은 돌 단·돌계단: 거리뷰 03~06), S-MAP(위아래 높이), 추정(외곽·단 수·단 높이)'
    c = np.array([201041.5, 557310.8])
    def ngon(r, n=12): return [c + r * np.array([math.cos(2 * math.pi * k / n), math.sin(2 * math.pi * k / n)]) for k in range(n)]
    for k, (r, top) in enumerate(((7.4, 129.2), (5.8, 129.9), (4.2, 130.6))): box(f'P01-BONGWAN-ROUNDPLANTER-{k + 1}', 'planter', ngon(r), 127.0 if k == 0 else top - 0.7, top, f'본관 남서 모서리 앞 둥근 돌 화단 {k + 1}단(반지름 {r} m). 건물과 겹치는 부분은 건물에 가린다', SRC, G, 'Z05-PLATFORM-YUDAM9-MAIN-WEST', material='white_stone')
    for k, a in enumerate((200, 250, 300, 345)): tree(f'P01-BONGWAN-ROUNDPINE-{k + 1}', c + 2.6 * np.array([math.cos(math.radians(a)), math.sin(math.radians(a))]), 130.6, '둥근 화단의 소나무', SRC, 'P01-BONGWAN-ROUNDPLANTER-3')
    # 남쪽 앞: 차도 동쪽 인도 바깥에서 본관 앞 단(127.6 m)까지 오르는 계단식 화단. 인도 선을 따라 6 m 마디
    side = [(201039.6, 557298.2, 127.3), (201044.6, 557295.2, 126.5), (201049.8, 557292.1, 125.7), (201055.0, 557289.1, 124.8), (201060.2, 557286.0, 124.0), (201065.3, 557282.8, 123.3), (201070.2, 557279.2, 122.6), (201074.9, 557275.2, 122.1)]
    TERR = 127.6; STAIR = 4   # 다섯째 마디는 돌계단(본관 정문 앞쪽)
    for k in range(len(side) - 1):
        p, q = np.array(side[k][:2]), np.array(side[k + 1][:2]); zs = (side[k][2] + side[k + 1][2]) / 2
        R, P = frame(p, q - p, (0.5, 0.86)); L = float(np.hypot(*(q - p))); rise = TERR - zs
        if rise < 0.6: continue
        if k == STAIR:
            n = int(round(rise / 0.16))
            for j in range(n): box(f'P01-BONGWAN-SOUTHSTAIR-S{j + 1:02d}', 'stair_step', R(0.6, L - 0.6, 1.0 + 0.32 * j, 1.0 + 0.32 * (j + 1)), zs - 0.5, zs + rise * (j + 1) / n, f'본관 남쪽 앞 돌계단(인도에서 본관 앞 단으로, {n}단 = {rise:.1f} m ÷ 0.16, 폭 {L - 1.2:.1f} m)', SRC, G, 'Z05-PLATFORM-UPPER-MAIN-FRONT-LOW', stair='P01-BONGWAN-SOUTHSTAIR', riseM=r2(rise / n), runM=0.32, widthM=r2(L - 1.2))
            continue
        n = max(1, min(3, int(math.ceil(rise / 1.2))))
        for j in range(n): box(f'P01-BONGWAN-SOUTHPLANTER-{k + 1}-T{j + 1}', 'planter', R(0.0, L, 1.0 + 2.4 * j, 1.0 + 2.4 * (j + 1) if j < n - 1 else 1.0 + 2.4 * n + 1.2), zs - 0.6, zs + rise * (j + 1) / n, f'본관 남쪽 앞 계단식 돌 화단(마디 {k + 1}, {j + 1}단째 / {n}단)', SRC, G, 'Z05-PLATFORM-UPPER-MAIN-FRONT-LOW', material='white_stone')
        if k % 2 == 0: tree(f'P01-BONGWAN-SOUTHPINE-{k + 1}', P(L / 2, 1.0 + 2.4 * n), TERR, '계단식 화단 윗단의 소나무', SRC, f'P01-BONGWAN-SOUTHPLANTER-{k + 1}-T{n}')

# ================= 4. 운동장 바닥: 회색 바탕, 주황 방사 줄무늬, 글자 SEOKYEONG UNIVERSITY =================
FIELD = [[201197.68, 557175.65], [201135.95, 557230.72], [201137.27, 557243.5], [201134.79, 557243.5], [201136.75, 557255.5], [201140.1, 557255.5], [201146.24, 557293.5], [201143.2, 557293.5], [201145.05, 557311.01], [201178.11, 557300.1], [201179.43, 557296.96], [201206.06, 557288.63], [201213.32, 557280], [201221.2, 557275], [201227.21, 557273.8], [201237.3, 557262.9], [201244.16, 557257.31], [201228.26, 557229.99], [201229.84, 557229.09], [201219.73, 557212.37], [201217.86, 557213.44], [201201.71, 557185.81]]
FONT = {'S': '01111 10000 10000 01110 00001 00001 11110', 'E': '11111 10000 10000 11110 10000 10000 11111', 'O': '01110 10001 10001 10001 10001 10001 01110', 'K': '10001 10010 10100 11000 10100 10010 10001', 'Y': '10001 10001 01010 00100 00100 00100 00100', 'N': '10001 11001 10101 10101 10011 10001 10001',
        'G': '01110 10001 10000 10111 10001 10001 01110', 'U': '10001 10001 10001 10001 10001 10001 01110', 'I': '11111 00100 00100 00100 00100 00100 11111', 'V': '10001 10001 10001 10001 01010 01010 00100', 'R': '11110 10001 10001 11110 10100 10010 10001', 'T': '11111 00100 00100 00100 00100 00100 00100'}
def field_pattern():
    from shapely.geometry import Polygon as SP
    from shapely.ops import unary_union
    SRC = '사용자-학교전경-20261012/19-운동장-위에서-대일관-청운관-혜인관-은주관지붕.jpg, 06·02·08(혜인관 앞에서: 줄무늬가 혜인관 출입부 쪽으로 모인다)'
    G = '확정(운동장은 148.9 m 평면), 원천(회색 바닥에 주황 줄무늬가 혜인관 출입부 쪽에서 퍼지고, 남서 가장자리에 흰 글자 SEOKYEONG UNIVERSITY: 사용자 사진 19), 추정(줄의 수·폭·각도, 글자 크기·자리)'
    field = SP(FIELD).buffer(0); Z0 = 148.9
    def plates(pid, g, z0, z1, what, color):
        gs = [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.geom_type == 'Polygon' and q.area > 0.05]
        for n, q in enumerate(gs):
            c = [[r2(x), r2(y)] for x, y in q.exterior.coords]
            FEATS.append({'type': 'Feature', 'properties': {'id': pid if len(gs) == 1 else f'{pid}-{n + 1}', 'type': 'wall', 'kind': 'extrude', 'estimated': True, 'grade': G, 'basePlane': 'Z02-PLATFORM-FIELD(운동장 148.9)', 'fromM': r2(z0), 'toM': r2(z1), 'assumption': what + '. 바닥의 칠(두께 2 cm 판으로 나타냄): 운동장은 평평한 한 면 그대로이고 걷는 면(영역)도 그대로다', 'source': SRC, 'color': color, 'surfaceMark': True}, 'geometry': {'type': 'Polygon', 'coordinates': [c] + [[[r2(x), r2(y)] for x, y in h.coords] for h in q.interiors]}})
    plates('P01-FIELD-BASE', field.buffer(-0.15), Z0 - 0.3, Z0 + 0.02, '운동장 바닥의 회색 바탕', '#9b9d9f')
    o = np.array([201250.0, 557206.0])   # 줄무늬가 모이는 곳: 혜인관 출입부 뒤 30 m(건물 안)
    for k, a0 in enumerate(range(99, 207, 12)):
        w = SP([o] + [o + 200 * np.array([math.cos(math.radians(a)), math.sin(math.radians(a))]) for a in (a0, a0 + 2.5, a0 + 5)])
        plates(f'P01-FIELD-STRIPE-{k + 1}', field.buffer(-0.3).intersection(w), Z0 + 0.02, Z0 + 0.04, f'주황 줄무늬 {k + 1}(방위각 {a0}~{a0 + 5}도의 부채꼴 띠)', '#d98a2e')
    e = unit((201135.95 - 201197.68, 557230.72 - 557175.65)); n = np.array([-e[1], e[0]]); n = n if n @ np.array([1, 1]) > 0 else -n   # e = 남서 가장자리를 따라 북서로, n = 운동장 안쪽(북동)
    mid = np.array([201166.8, 557203.2]) + n * 13.0; text = 'SEOKYEONG UNIVERSITY'; cw, ch, gap = 0.5, 0.5, 0.6
    adv = 5 * cw + gap; s0 = -len(text) * adv / 2
    for i, chr_ in enumerate(text):   # 북동쪽에서 남서를 보고 읽는 글자: 글줄은 남동 → 북서(e 방향), 글자 위쪽은 남서(-n)
        if chr_ == ' ': continue
        cells = []
        for row, bits in enumerate(FONT[chr_].split()):
            for col, b in enumerate(bits):
                if b != '1': continue
                p = mid + e * (s0 + i * adv + col * cw) - n * (3.5 - row) * ch   # 칸의 왼쪽 위 모서리(읽는 쪽에서 볼 때)
                cells.append(SP([p, p + e * cw, p + e * cw + n * ch, p + n * ch]))
        plates(f'P01-FIELD-TEXT-{i + 1:02d}-{chr_}', unary_union(cells).buffer(0.001), Z0 + 0.04, Z0 + 0.06, f'바닥 글자 {chr_}(높이 3.5 m)', '#f2f2ee')
    for k, s in enumerate((-36.0, 33.0)): plates(f'P01-FIELD-SQUARE-{k + 1}', SP([mid + e * s + n * 2, mid + e * (s + 6) + n * 2, mid + e * (s + 6) - n * 2.5, mid + e * s - n * 2.5]).intersection(field), Z0 + 0.04, Z0 + 0.06, '글자 옆의 주황 네모', '#e09a3a')

# ================= 5. 수인관 옥상 풋살장: 코트 셋, 글자, 유리 지붕 줄 =================
FONT.update({'F': '11111 10000 10000 11110 10000 10000 10000', 'A': '01110 10001 10001 11111 10001 10001 10001', 'L': '10000 10000 10000 10000 10000 10000 11111', 'P': '11110 10001 10001 11110 10000 10000 10000'})
SUIN = [[201102.94, 557190.11], [201125.57, 557204.29], [201192.29, 557144.08], [201174.74, 557125.62], [201148.21, 557110.27]]
def suin_roof():
    from shapely.geometry import Polygon as SP
    from shapely.ops import unary_union
    SRC = '사용자-학교전경-20261012/07-풋살장-바로위에서-수인관옥상.jpg, 20-전경-남서-원경3.jpg'
    G = '확정(풋살장이 수인관 옥상: 사용자), 원천(코트 세 면·글자 SKU Futsal PARK·유리 지붕 줄: 사용자 사진 07), S-MAP(옥상 132.1 m), 추정(코트 자리·크기, 글자 크기)'
    roof = SP(SUIN).buffer(-1.2); Z0 = 132.2
    o = np.array(SUIN[4]); a = unit(np.array(SUIN[0]) - o); n = np.array([-a[1], a[0]]); n = n if n @ np.array([1, 1]) > 0 else -n   # a = 기둥 면을 따라 북서로, n = 옥상 안쪽(북동)
    rect = lambda s0, s1, d0, d1: SP([o + a * s0 + n * d0, o + a * s1 + n * d0, o + a * s1 + n * d1, o + a * s0 + n * d1])
    def plates(pid, g, z0, z1, what, color):
        gs = [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.geom_type == 'Polygon' and q.area > 0.05]
        for k, q in enumerate(gs): FEATS.append({'type': 'Feature', 'properties': {'id': pid if len(gs) == 1 else f'{pid}-{k + 1}', 'type': 'wall', 'kind': 'extrude', 'estimated': True, 'grade': G, 'basePlane': '수인관 옥상 132.1', 'fromM': r2(z0), 'toM': r2(z1), 'assumption': what, 'source': SRC, 'color': color}, 'geometry': {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in q.exterior.coords]] + [[[r2(x), r2(y)] for x, y in h.coords] for h in q.interiors]}})
    plates('P01-SUIN-ROOF-PAVING', roof, Z0 - 0.08, Z0, '옥상 바닥(회색 포장)', '#8f9194')
    for k, (s0, s1, d0, d1) in enumerate(((5, 27, 3, 41), (28.5, 50.5, 3, 41), (53.5, 86, 3, 15.5))):
        c = rect(s0, s1, d0, d1).intersection(roof)
        plates(f'P01-SUIN-COURT-{k + 1}', c, Z0, Z0 + 0.03, f'풋살 코트 {k + 1}(인조 잔디)', '#3d9a52')
        for j in range(0, int((s1 - s0) // 4), 2): plates(f'P01-SUIN-COURT-{k + 1}-BAND{j // 2 + 1}', rect(s0 + 4 * j, s0 + 4 * j + 4, d0, d1).intersection(c), Z0 + 0.03, Z0 + 0.04, '코트의 밝은 잔디 띠', '#4fae62')
        plates(f'P01-SUIN-COURT-{k + 1}-LINES', c.buffer(-0.6).difference(c.buffer(-0.78)).union(rect((s0 + s1) / 2 - 0.09, (s0 + s1) / 2 + 0.09, d0, d1).intersection(c.buffer(-0.6)) if k < 2 else rect(s0, s1, (d0 + d1) / 2 - 0.09, (d0 + d1) / 2 + 0.09).intersection(c.buffer(-0.6))), Z0 + 0.04, Z0 + 0.06, '코트의 흰 선(둘레와 가운데 선)', '#f1f1ec')
    text = 'SKU FUTSAL PARK'; cw = 0.36; adv = 5 * cw + 0.42; s0 = 55.6; d0 = 20.5
    for i, ch in enumerate(text):
        if ch == ' ': continue
        cells = [rect(s0 + i * adv + col * cw, s0 + i * adv + (col + 1) * cw, d0 - (3.5 - row) * cw, d0 - (3.5 - row) * cw + cw) for row, bits in enumerate(FONT[ch].split()) for col, b in enumerate(bits) if b == '1']
        plates(f'P01-SUIN-TEXT-{i + 1:02d}-{ch}', unary_union(cells).buffer(0.001).intersection(roof), Z0, Z0 + 0.03, f'옥상 글자 {ch}(SKU Futsal PARK, 높이 2.5 m)', '#f3f3ef')
    for k, (sa, sb) in enumerate(((51.8, 54.6), (89.6, 91.6))): plates(f'P01-SUIN-TEXT-MARK-{k + 1}', rect(sa, sb, 18.8, 21.8).intersection(roof), Z0, Z0 + 0.03, '글자 옆의 주황 무늬(네모로 줄임)', '#e09a3a')
    strip = SP(SUIN).buffer(-0.3).difference(SP(SUIN).buffer(-3.3)).intersection(SP([np.array(SUIN[1]) + n * 3, np.array(SUIN[2]) + n * 3, np.array(SUIN[2]) - n * 6, np.array(SUIN[1]) - n * 6]))
    plates('P01-SUIN-GLASSROOF', strip, Z0, Z0 + 1.6, '옥상 북동 가장자리(은주관 쪽)의 유리 지붕 줄(폭 3 m, 높이 1.6 m 눈대중)', '#9fd0cf')

# ================= 6. 문예관 고층부 동쪽 끝 면: 흰 판 벽의 주황 로고, 세로 통풍구 줄, 꼭대기 근처 둥근 유리 돌출 =================
def munye_end():
    SRC = '사용자-학교전경-20261012/03-문예관-고층부-옆면-주황로고-둥근유리.jpg, 18-내리막길-하행-본관과문예관사이.jpg'
    G = '확정(문예관 측면의 주황 로고와 둥근 유리 돌출: 사용자 사진), 추정(어느 면인지: 저층부·소나무가 왼쪽 아래, 긴 유리 면이 왼쪽인 것으로 보아 동쪽 끝 면으로 읽음. 치수는 눈대중)'
    p0, p1 = np.array([201118.17, 557333.89]), np.array([201126.65, 557352.12]); R, P = frame(p0, p1 - p0, (1, -0.4)); L = float(np.hypot(*(p1 - p0)))
    box('P01-MUNYE-END-VENT', 'wall', R(1.2, 3.6, 0, 0.12), 150.0, 188.6, '끝 면의 세로 통풍구 줄(회색 판에 둥근 구멍 줄)', SRC, G, '문예관 동쪽 끝 벽', color='#a9a8a2')
    for j in range(12): box(f'P01-MUNYE-END-VENT-HOLE{j + 1:02d}', 'wall', R(2.1, 2.7, 0.12, 0.16), 152.0 + 3.0 * j, 152.6 + 3.0 * j, '통풍구(둥근 구멍을 네모로 줄임)', SRC, G, 'P01-MUNYE-END-VENT', color='#4b4d50')
    box('P01-MUNYE-END-LOUVRE-1', 'wall', R(3.6, 6.2, 0, 0.1), 150.0, 188.6, '통풍구 줄과 흰 판 사이의 가로 살 띠', SRC, G, '문예관 동쪽 끝 벽', color='#6f7377')
    box('P01-MUNYE-END-PANEL', 'wall', R(6.2, 11.8, 0, 0.14), 150.0, 188.6, '흰 판 벽(로고가 붙은 면)', SRC, G, '문예관 동쪽 끝 벽', color='#e4e2dc')
    box('P01-MUNYE-END-LOUVRE-2', 'wall', R(11.8, min(L, 14.4), 0, 0.1), 150.0, 188.6, '흰 판 오른쪽의 가로 살 띠', SRC, G, '문예관 동쪽 끝 벽', color='#6f7377')
    OR = '#e8873a'; c = 9.0
    for k in range(7):   # 아래 굽은 획: 반원 아래쪽을 조각으로
        t0, t1 = math.radians(200 + 20 * k), math.radians(200 + 20 * (k + 1)); xs = sorted((c + 1.9 * math.cos(t0), c + 1.9 * math.cos(t1))); zm = 170.5 + 1.9 * (math.sin(t0) + math.sin(t1)) / 2
        box(f'P01-MUNYE-LOGO-ARC{k + 1}', 'wall', R(xs[0], xs[1] + 0.05, 0.14, 0.2), zm - 0.45, zm + 0.45, '주황 로고의 아래 굽은 획(조각)', SRC, G, 'P01-MUNYE-END-PANEL', color=OR)
    box('P01-MUNYE-LOGO-DIAMOND', 'wall', R(c - 0.2, c + 1.3, 0.14, 0.2), 173.6, 175.1, '주황 로고의 가운데 마름모(네모로 줄임)', SRC, G, 'P01-MUNYE-END-PANEL', color=OR)
    for k in range(3): box(f'P01-MUNYE-LOGO-TOP{k + 1}', 'wall', R(c - 1.6 + 0.6 * k, c - 0.9 + 0.6 * k, 0.14, 0.2), 176.0 + 0.8 * k, 177.1 + 0.8 * k, '주황 로고의 위 비낀 획(조각)', SRC, G, 'P01-MUNYE-END-PANEL', color=OR)
    drum = [P(0.2, 0.3) + 2.3 * np.array([math.cos(math.radians(a)), math.sin(math.radians(a))]) for a in range(0, 360, 30)]
    box('P01-MUNYE-DRUM', 'wall', drum, 178.0, 186.0, '꼭대기 근처 모서리의 둥근 유리 돌출(반지름 2.3 m, 높이 8 m)', SRC, G, '없음(벽에 붙음)', color='#8fbcb6')
    for k, z in enumerate((178.0, 181.9, 185.6)): box(f'P01-MUNYE-DRUM-BAND{k + 1}', 'wall', [P(0.2, 0.3) + 2.42 * np.array([math.cos(math.radians(a)), math.sin(math.radians(a))]) for a in range(0, 360, 30)], z, z + 0.45, '둥근 돌출의 흰 띠', SRC, G, 'P01-MUNYE-DRUM', color='#e7e6e1')

# ================= 7. 한림관 첨탑, 굽잇길 아래의 바위 정원 =================
def hanlim_rock():
    HS = '사용자-학교전경-20261012/04-한림관-원통-아래에서-바위정원-계단.jpg, 15·16·20, 사용자-네이버거리뷰-20261012/09-네이버거리뷰-전방위.jpg'
    c = (201114.0, 557295.0)
    box('P01-HANLIM-SPIRE-BASE', 'wall', sq(c, 1.1), 197.3, 198.4, '한림관 원통 꼭대기 첨탑의 받침', HS, '확정(꼭대기 첨탑: 사용자 사진 04), 추정(크기)', '한림관 지붕 197.3', color='#3d5d78')
    box('P01-HANLIM-SPIRE', 'wall', sq(c, 0.22), 198.4, 203.0, '첨탑(가는 기둥 4.6 m)', HS, '확정(첨탑), 추정(높이)', 'P01-HANLIM-SPIRE-BASE', color='#3a3f47')
    box('P01-HANLIM-SPIRE-BALL', 'wall', sq(c, 0.5), 200.2, 201.1, '첨탑의 구슬(상자로 줄임)', HS, '추정', 'P01-HANLIM-SPIRE', color='#3a3f47')
    G = '원천(굽잇길 아래 옹벽 자리는 큰 바위 절벽과 소나무의 바위 정원: 사용자 사진 04·거리뷰 09), 추정(바위 덩어리의 자리·크기: 벽면 앞에 쌓은 상자)'
    R, P = frame((201099.3, 557232.0), (0.0, 1.0), (-1, 0))   # s = 가운데 옹벽 서쪽 면을 따라 북으로, d = 차도 쪽(서)
    rocks = [(0, 4.5, 3.2, 122.5), (3.5, 8, 4.4, 125.0), (7, 11, 2.6, 121.0), (10, 15.5, 4.8, 126.0), (14.5, 18, 3.0, 123.0), (17, 22, 4.0, 124.5), (21, 24.5, 2.4, 120.5)]
    for k, (s0, s1, d, top) in enumerate(rocks):
        box(f'P01-ROCKGARDEN-ROCK-{k + 1}', 'wall', R(s0, s1, -0.6, d), 113.0, top, '바위 정원의 바위 덩어리(절벽을 상자로 줄임)', HS, G, 'Z05-PLATFORM-EUNJU-CENTRAL-WALLTOP 의 서쪽 벽면', color='#8f8a7f' if k % 2 else '#7d786e')
        box(f'P01-ROCKGARDEN-ROCK-{k + 1}-B', 'wall', R(s0 + 0.6, s1 - 0.8, -0.6, d * 0.55), top, top + 1.4, '바위 덩어리의 윗단', HS, G, f'P01-ROCKGARDEN-ROCK-{k + 1}', color='#9a958a')
    for k, (s, d, z) in enumerate(((2.0, 1.5, 122.5), (6.0, 1.2, 126.4), (12.5, 1.5, 127.4), (19.5, 1.2, 125.9), (9.0, 1.4, 121.0))): tree(f'P01-ROCKGARDEN-PINE-{k + 1}', P(s, d), z, '바위 정원의 소나무', HS, 'P01-ROCKGARDEN-ROCK')

PARTS = [arcade, bongwan_west, bongwan_south, field_pattern, suin_roof, munye_end, hanlim_rock]
def write():
    for part in PARTS: part()
    out = {'type': 'FeatureCollection', 'name': 'p01-parts', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'provenance': {'script': 'docs/audit/p01/build_parts.py', 'note': '사용자 전경 사진·아치 건물 사진·네이버 거리뷰로 더한 덩어리. 전부 추정 치수'}, 'features': FEATS}
    (STR / 'p01-parts.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    ids = [f['properties']['id'] for f in FEATS]; assert len(ids) == len(set(ids)), [i for i in ids if ids.count(i) > 1]
    print(len(FEATS), 'features', 'entrance', [r2(v) for v in ENTRANCE])
if __name__ == "__main__": write()
