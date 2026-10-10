"""B07 — 한림관 층 높이 다시 추론, 나란한 두 내리막길(위 보행로 / 한 층 아래 지하 차도) 대조. 읽기 전용, DB 없음, 적용 없음.

  python docs/audit/b07/b07.py <audit-dir> docs/audit/b07/results.json

입력: <audit-dir>/e05/smap-mesh-*.txt (S-MAP 화면 판독 격자, 독립 측량 아님), <audit-dir>/claude-live/roads-live-2.json (운영 스냅숏 2).
사용자 확정(2026-10-10, 근거: <audit-dir>/사용자-출입구·주차장-20261010/근거.md 와 허브 표):
  - 한림관 6층에서 운동장 높이 길로 나가려면 계단 6칸쯤을 올라간다 -> 6층 바닥 = 운동장 148.9 − 6단.
  - 한림관 1층은 앞 길(사용자 S-MAP 판독 125.1~126.1 m)에서 계단 몇 개 위.
  - 문예관·대일관 쪽과 본관·한림관 쪽 사이에 내리막길이 두 줄 나란히 있다. 위 = 문예관 3층 계단으로 이어지는 바깥 보행로,
    한 층 아래 = "지하 경사로 통로" = 지하 차도(서문·제2 지하주차장 입구로 드나드는 차가 씀, 오르막 방향 오른쪽이 보행 구간).
    본관 5층–한림관 3층 연결(실외 나무 데크)은 아래 길에서만 갈 수 있다.
여기서 계산한 층 높이는 기준 3개를 빼면 전부 추정이다. 지하 차도의 선은 자료에 없다(모름): 알려진 점만 적는다.
"""
import json, math, pathlib, statistics, sys
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'b03'))
from common import TERRAIN, FIELD_M, load_cells

audit, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
C = load_cells(audit / 'e05')
ROADS = {r['id'][:8]: r for r in json.loads((audit / 'claude-live/roads-live-2.json').read_text(encoding='utf-8'))['items']}
r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2)


def surf(x, y, r=1.5):
    """가장 가까운 S-MAP 칸: (z, 'terrain'|'building', 격자 간격)."""
    c = sorted((math.hypot(a - x, b - y), z, i, s) for (a, b), (z, i, s) in C.items() if abs(a - x) <= r and abs(b - y) <= r)
    return None if not c else (r1(c[0][1]), 'terrain' if c[0][2] == TERRAIN else 'building', c[0][3])


def box(x0, y0, x1, y1):
    v = [z for (a, b), (z, i, s) in C.items() if x0 <= a <= x1 and y0 <= b <= y1 and i == TERRAIN]
    return {'box': [x0, y0, x1, y1], 'cells': len(v), 'min': r1(min(v)), 'median': r1(statistics.median(v)), 'max': r1(max(v))} if v else {'box': [x0, y0, x1, y1], 'cells': 0}


# ---------------------------------------------------------------- 1. 한림관 층 높이
F1 = 127.2; F1_RANGE = [126.6, 127.5]      # 계단 위 평탄면(B06, S-MAP 1 m 격자 126.9~127.5). 아래 끝 = 사용자 판독 126.1 + 3단
MAIN_2F = 130.7; MAIN_LANDING = 139.9       # 본관 입구(2) = 2층, 입구(3) = 5·6층 사이 계단(B03 anchors.json, S-MAP 벽 앞 지면)
RISER = [0.15, 0.18]; STEPS = 6
F6 = r1(FIELD_M - STEPS * 0.165); F6_RANGE = [r1(FIELD_M - STEPS * RISER[1]), r1(FIELD_M - STEPS * RISER[0])]
RING, DISC = 188.1, 197.3                   # S-MAP 지붕 두 단(B02)
REG_H, REG_FLOORS = 55.05, 12               # 대장 42233: 높이, 지상층


def main5(frac):
    """본관 5층: 입구(3)이 5층과 6층 사이의 frac 지점이라고 볼 때. 2층→5층은 2개 층(3·5)."""
    h = (MAIN_LANDING - MAIN_2F) / (2 + frac); return r1(MAIN_2F + 2 * h), r2(h)


m5 = {str(f): main5(f) for f in (0.25, 0.5, 0.75)}
M5 = m5['0.5'][0]
uni = (F6 - F1) / 4                                             # 1→6층 4개 층(1·2·3·5 → 6)을 고르게
tests = []
for name, f6 in (('6층 = 운동장 − 6단 (확정 방향)', F6), ('견주기: 6층 = 운동장', FIELD_M), ('견주기: 6층 = 운동장 + 6단 (사용자 답과 반대, 거둠)', r1(2 * FIELD_M - F6))):
    h = (f6 - F1) / 4
    tests.append({'case': name, 'f6M': f6, 'uniformStoreyM': r2(h), 'f3UniformM': r1(F1 + 2 * h), 'f3UniformMinusMain5M': r1(F1 + 2 * h - M5),
                  'storey1to3IfF3IsMain5M': r2((M5 - F1) / 2), 'storey3to6IfF3IsMain5M': r2((f6 - M5) / 2)})
F3_UNI = r1(F1 + 2 * uni); F3 = r1((F3_UNI + M5) / 2)           # 표에 쓰는 3층: 두 읽기(고른 간격 / 본관 5층)의 가운데
low = {'1': F1, '2': r1((F1 + F3) / 2), '3': F3, '5': r1((F3 + F6) / 2), '6': F6}
# 6층 위: 6~16층 11개 층(13 있음)
hA = (RING - F6) / 11                                           # 읽기 A: 고리 지붕 = 16층 지붕
hB = (RING - F6) / 9; hB2 = (DISC - RING) / 2                   # 읽기 B: 고리 지붕 = 15층 바닥(옥상 테라스), 15·16층은 가운데 원통 안
hU = (DISC - F6) / 11                                           # 원판 지붕까지 고르게 나눈 값(읽기 B 를 따로 확인하는 숫자)
upA = {str(n): r1(F6 + hA * k) for k, n in enumerate(range(6, 17))}
upB = {str(n): r1(F6 + hB * k) if n <= 15 else r1(RING + hB2) for k, n in enumerate(range(6, 17))}
hanlim = {
    'anchors': [
        {'floor': 1, 'heightM': F1, 'rangeM': F1_RANGE, 'grade': '확정(앞 길에서 계단 몇 개 위) + S-MAP(계단 위 평탄면 126.9~127.5, 앞 길 사용자 판독 125.1~126.1)'},
        {'floor': 3, 'heightM': F3, 'rangeM': [min(F3_UNI, m5['0.75'][0]), max(M5, m5['0.25'][0])], 'grade': '원천(본관 5층과 이어진다) + 추정(높이: 본관 5층 계산값과 고른 간격 값의 가운데)'},
        {'floor': 6, 'heightM': F6, 'rangeM': F6_RANGE, 'grade': '확정(운동장 높이 길보다 계단 6칸쯤 아래) + 측정(운동장 148.9) + 추정(한 단 0.15~0.18 m)'}],
    'mainBuilding5F': {'f2M': MAIN_2F, 'landingBetween5And6M': MAIN_LANDING, 'byLandingFraction': {k: {'f5M': v[0], 'storeyM': v[1]} for k, v in m5.items()},
                       'note': '입구(3)이 5층과 6층의 한가운데라는 것은 가정. 1/4~3/4 지점이면 5층은 137.4~138.9 m'},
    'uniformTests': tests,
    'storeysBelowFieldM': {'1to3': r2((F3 - F1) / 2), '3to6': r2((F6 - F3) / 2), 'uniform1to6': r2(uni)},
    'residualsM': {'f3Table minus main5F(138.1)': r1(F3 - M5), 'f3Table minus uniform': r1(F3 - F3_UNI), 'uniform minus main5F': r1(F3_UNI - M5)},
    'ladderBelowField': low,
    'aboveField': {
        'A ring roof is the roof of 16F': {'storeyM': r2(hA), 'floors': upA},
        'B ring roof is the 15F floor (terrace), 15-16F in the inner drum': {'storey6to15M': r2(hB), 'storey15to16M': r2(hB2), 'floors': upB, 'roofM': DISC},
        'check: uniform to the disc roof': {'storeyM': r2(hU), 'f15M': r1(F6 + 9 * hU), 'f15MinusRingRoofM': r1(F6 + 9 * hU - RING)},
        'maxDifferenceAminusBM': {n: r1(upA[n] - upB[n]) for n in ('10', '14', '16')}},
    'register': {'heightM': REG_H, 'groundFloors': REG_FLOORS, 'discRoofMinusHeightM': r2(DISC - REG_H), 'schoolFloors5to16': 12, 'f5M': low['5'],
                 'meanStoreyM': r2(REG_H / REG_FLOORS), 'readingBTotal5toRoofM': r1(DISC - low['5']),
                 'note': '대장 지상 12층 = 학교 표기 5~16층(4 없음, 13 있음) 12개 층으로 읽을 수 있다(추정). 원판 지붕 − 대장 높이 = 142.25 m 는 5층 바닥(142.9)·북쪽 위 보행로 지면(141~143)과 가깝다. 대장 지하 2층 대 학교 1·2·3층 3개 층은 하나 어긋난다'},
}
# 은주1관: 1층 131.3(S-MAP 입구 지면), 2층 = 한림관 3층, 5층 = 운동장(확정)
E1 = 131.3
eunju1 = {'f1GroundM': E1, 'f2M': F3, 'f5M': FIELD_M, 'storey1to2M': r2(F3 - E1), 'storey2to5M': r2((FIELD_M - F3) / 2), 'storeys2to5': 2,
          'f1IfUniformM': r1(F3 - (FIELD_M - F3) / 2), 'f1UniformMinusGroundM': r1(F3 - (FIELD_M - F3) / 2 - E1),
          'hanlim6FMinusEunju5FM': r1(F6 - FIELD_M),
          'note': '2→5층이 층당 5.55 m 이면 1→2층 6.5 m 는 그보다 1 m 크다. 1층 바닥이 입구 지면보다 약 1 m 높거나(문 앞 계단), 1층이 실제로 높거나, 연결통로에 단이 있다: 미정'}

# ---------------------------------------------------------------- 2. 나란한 두 길
prof = {}
for rid in ('c52095ad', '951c157d', '8fde6a04', '66f166a8', '8e71c240'):
    r = ROADS[rid]; c = r['coordinates']; n = len(c)
    idxs = range(n) if n <= 6 else sorted({0, n - 1, *range(0, n, 5)})
    rows = []
    for k in idxs:
        s = surf(*c[k][:2]); rows.append({'i': k, 'xy': [r1(c[k][0]), r1(c[k][1])], 'storedZ': r2(c[k][2]), 'smap': s[0] if s else None, 'smapKind': s[1] if s else None,
                                          'storedMinusSmapM': r1(c[k][2] - s[0]) if s and s[1] == 'terrain' else None})
    prof[rid] = {'name': r['name'], 'roadClass': r['roadClass'], 'structure': r['structure'], 'vehicleAccess': r['vehicleAccess'], 'pedestrianAccess': r['pedestrianAccess'],
                 'lengthM': r['lengthM'], 'gradePct': r1(100 * abs(c[0][2] - c[-1][2]) / r['lengthM']), 'vertices': rows}
# 위 길의 가로 단면: 길 방향에 수직으로 ±8 m. 한 면인지(층이 둘로 보이는지)
c5 = ROADS['c52095ad']['coordinates']; ux, uy = c5[-1][0] - c5[0][0], c5[-1][1] - c5[0][1]; L = math.hypot(ux, uy); ux, uy = ux / L, uy / L
cross = []
for k in (0, 7, 14, 21, 29):
    x, y = c5[k][:2]; row = []
    for o in range(-8, 9, 2):
        s = surf(x - uy * o, y + ux * o, 1.1); row.append(None if not s else s[0] if s[1] == 'terrain' else 'B')
    t = [v for v in row if isinstance(v, float)]
    cross.append({'at': [r1(x), r1(y)], 'offsetsM': list(range(-8, 9, 2)), 'smap': row, 'terrainRangeM': r1(max(t) - min(t)) if t else None})
z951 = [p[2] for p in ROADS['951c157d']['coordinates']]; below = [-v['storedMinusSmapM'] for v in prof['951c157d']['vertices']]
DECK = (201098.0, 557302.7); top = ROADS['951c157d']['coordinates'][0]; bot = ROADS['951c157d']['coordinates'][-1]
WEST_PORTAL = (200984.0, 557399.5, 117.0)   # E09: 서문 옹벽 면 가운데, 문 앞 공도 117.0 m
P1 = (201021.9, 557307.1, 127.9); BUS = {'1164': (201023.3, 557317.0, 129.0), '2115': (201031.0, 557319.0, 128.9)}; MAIN_ENT2 = (201041.5, 557338.5, 130.5)
d = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])
fit = {
    'oneStoreyBelowUpperPath': {'belowSmapSurfaceM': below, 'reading': '저장된 선은 위 보행로 면보다 3.4~5.6 m 아래 = 한 층 안팎. 사용자 말 "한 층 아래 나란히"와 맞는다'},
    'deckEnd': {'deckMarker': list(DECK), 'top951': [r1(top[0]), r1(top[1]), r2(top[2])], 'planDistanceM': r1(d(top, DECK)), 'hanlim3FTableM': F3, 'main5FM': M5,
                'top951MinusHanlim3FM': r1(top[2] - F3), 'reading': '위 끝 136.39 m 는 한림관 3층·본관 5층 계산값보다 1.4~1.7 m 낮다. 136.39 는 문예관 아래층 추정 높이를 옮긴 값이라 이 차이로 가르지 못한다'},
    'westGateEnd': {'portal': list(WEST_PORTAL), 'bottom951': [r1(bot[0]), r1(bot[1]), r2(bot[2])], 'planDistanceM': r1(d(bot, WEST_PORTAL)), 'dropM': r1(bot[2] - WEST_PORTAL[2]),
                    'gradePctStraight': r1(100 * (bot[2] - WEST_PORTAL[2]) / d(bot, WEST_PORTAL)), 'stored951GradePct': prof['951c157d']['gradePct'],
                    'reading': '아래 끝 126.82 m 에서 서문 117.0 m 까지 직선 86 m 에 9.8 m 내림(11 %): 차도로 가능한 경사. 그 사이 선은 자료에 없다(모름). 저장된 선 자체는 19 % 로 차도로는 가파르다(높이가 추정값)'},
    'busStopSide': {'bottom951ToP1SignEntranceM': r1(d(bot, P1)), 'p1ThresholdM': P1[2], 'bottom951ToBusStopsM': {k: r1(d(bot, v)) for k, v in BUS.items()}, 'busStopGroundM': {k: v[2] for k, v in BUS.items()},
                    'bottom951ToMainEntrance2M': r1(d(bot, MAIN_ENT2)), 'mainEntrance2GroundM': MAIN_ENT2[2], 'surfaceAbove951BottomM': prof['951c157d']['vertices'][-1]['smap'],
                    'p1ToBusStopsM': {k: r1(d(P1, v)) for k, v in BUS.items()},
                    'reading': '아래 끝은 본관 입구(2)("지하주차장과 본관 2층 연결", 원천)에서 16 m, 표지판 P1 입구에서 53 m. 그 자리 지면 132.4 m 보다 5.6 m 아래. 표지판 P1 입구는 버스 정류장에서 10~15 m 이고 문턱 127.9 m: 사용자의 "버스 정류장 근처 제2 지하주차장 입구" 후보(추정, 확인 전)'},
}
nook = {'northOfHanlim': box(201104, 557309, 201114, 557314), 'gapMainHanlimWest': box(201099, 557296, 201104, 557308), 'eastStrip': box(201128, 557286, 201131, 557303),
        'terraceSE': box(201126, 557273, 201128, 557282),
        'reading': '한림관 북쪽 모퉁이(본관 동쪽 벽·한림관 북쪽 벽·위 보행로 사이)는 S-MAP 에서 하늘이 보이는 낮은 면이다(133.8~141.2, 중앙 135.1 m, 북쪽으로 오름). 위 보행로(같은 자리 북쪽 141~143 m)보다 낮아 나무 데크가 이 모퉁이일 수 있다(추정). 중앙값은 한림관 3층 계산값(137.8)보다 2.7 m 낮다: 벽 사이 좁은 곳의 1~2 m 격자라 데크 높이로 쓰지 않고, 어긋남으로만 적는다'}
under = {
    'what': '지하 차도 + 오르막 방향 오른쪽 보행 구간(사용자 확정). 위 보행로와 층이 다르다',
    'geometry': '모름(사용자 그림 대기). 선을 만들지 않는다',
    'knownPoints': [
        {'what': '서문 터널 입구 두 칸', 'xy': [200984.0, 557399.5], 'z': 117.0, 'grade': '확정(서문으로 드나드는 차가 이 차도를 쓴다) / 좌표·높이 S-MAP·사진(E09)'},
        {'what': '제2 지하주차장 입구', 'xy': None, 'z': None, 'grade': '확정(버스 정류장 근처, 유담관 9층으로 가는 보행 길 아래) / 위치 모름', 'candidate': {'what': '표지판 P1 입구', 'xy': list(P1[:2]), 'z': P1[2], 'grade': '추정'}},
        {'what': '본관 5층–한림관 3층 연결 데크(보행)', 'xy': list(DECK), 'z': F3, 'grade': '확정(이 길에서만 간다) / 좌표 = 학교 표지(원천) / 높이 추정'},
        {'what': '북악관 B1(GS25 문)로 가는 길이 갈리는 곳', 'xy': None, 'z': None, 'grade': '확정(지하 차도가 시작하는 부근) / 위치 모름'},
        {'what': '본관 입구(2): 지하주차장과 본관 2층 연결', 'xy': list(MAIN_ENT2[:2]), 'z': MAIN_ENT2[2], 'grade': '원천(학교 문구). 이 지하 차도와 이어지는지는 모름'}],
    'onlyExistingGeometryHint': {'roads': ['951c157d', '8fde6a04', '66f166a8'], 'grade': '추정(운영 도로망의 "추정" 선. 이 지하 차도라는 확인은 없다)'},
    'openToSky': 'S-MAP 에서 951c157d 의 선 위는 끊김 없는 포장면(위 보행로)이다: 그 구간은 덮여 있다. 열린 곳으로 보이는 것은 서문 입구, 표지판 P1 입구, 한림관 북쪽 모퉁이뿐(추정)'}
res = {'method': __doc__, 'fieldM': FIELD_M, 'hanlim': hanlim, 'eunju1': eunju1,
       'corridor': {'roads': prof, 'upperPathCrossSections': cross, 'fit951': fit, 'nook': nook, 'undergroundRoad': under,
                    'upperPath': {'road': 'c52095ad', 'smapAlongM': [v['smap'] for v in prof['c52095ad']['vertices']], 'sideStairToMunye3F': {'leavesAt': [201108.9, 557326.2], 'smapM': 141.3, 'topAt': [201113.5, 557332.9], 'topSmapM': 144.1, 'source': 'B06 사용자 그림(사진 10) 옮김, 평면 ±3 m'},
                                  'reading': 'S-MAP 은 이 통로에서 이어진 한 면만 보인다(가로 단면은 가장자리에서 0.3~3.8 m 기울 뿐, 한 층 높이의 단이 길을 따라 이어지지 않는다). 그 면이 위 보행로다. 아래 길은 S-MAP 에 보이지 않는다'}}}
out.write_text(json.dumps(res, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print('한림관', low, '| 층고', hanlim['storeysBelowFieldM'], '| 잔차', hanlim['residualsM'])
for t in tests: print(' ', t)
print(' 본관 5층', m5); print(' 위 A', r2(hA), upA); print(' 위 B', r2(hB), r2(hB2), upB, '고르게', hanlim['aboveField']['check: uniform to the disc roof']); print(' 대장', hanlim['register'])
print('은주1관', eunju1)
for k, v in prof.items(): print(k, v['name'], v['gradePct'], [(q['storedZ'], q['smap'], q['smapKind'][0] if q['smapKind'] else None) for q in v['vertices']])
for c in cross: print(c)
for k, v in fit.items(): print(k, {a: b for a, b in v.items() if a != 'reading'})
print(nook)
