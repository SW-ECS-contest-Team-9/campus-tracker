"""B08 — 사용자 확정(2026-10-10 그림 14 뒤의 답)으로 본관 옆 지하 차도와 북악관 B1 길을 다시 대조하고 제안·모의 적용을 만든다. 읽기 전용, DB·MCP 쓰기 없음.

  python docs/audit/b08/b08.py <audit-dir> <backend-dir> docs/audit/b08/results.json      (먼저 b07/drawing14.py)

확정(사용자): ① 본관 옆 긴 붉은 띠 = 지하 차도의 보행 구간(오르막 방향 오른쪽), 양방향 차도는 그 북악관·문예관 쪽 옆, 폭 = 그림의 횡단보도 길이.
② 차는 제2주차장 입구와 서문에서 그 지하 차도로 들어간다(두 자리는 사용자 그림 `사용자-서문·제2주차장·수인관-20261010/01-…webp`). ③ 본관 5층–한림관 3층 데크는 아래 길(보행 띠)에서만 간다. ④ 두 계단 모두 지상에서 내려간다.
⑤ 두 지하 공간은 지하에서 이어지지 않는다(지상 횡단보도로만). ⑥ 북악관 B1: 횡단보도 → 통로 → 계단(내려감) → 좌회전하면 편의점·라운지 → 직진하면 GS25 출입구. ⑦ GS25 문으로 들어가면 계단을 내려간다. ⑧ 북악관은 지하층·1층·7층 천장이 꽤 높고 나머지는 보통.
추정: 그림에서 옮긴 좌표(±2 m, b07/drawing14.json), 높이(S-MAP 지상 면, 운영 길 저장 높이, 층고 계산). 사실이 정하지 않는 선은 그리지 않고 unresolvedLinks 로만 적는다.
"""
import collections, copy, json, math, pathlib, sys
import numpy as np
from PIL import Image
from shapely.geometry import Point, Polygon
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'b03'))
from common import TERRAIN, load_cells

audit, backend, out = map(pathlib.Path, sys.argv[1:4])
C = load_cells(audit / 'e05')
ROADS = json.loads((audit / 'claude-live/roads-live-2.json').read_text(encoding='utf-8'))['items']
NODES = json.loads((audit / 'claude-live/nodes-live-2.json').read_text(encoding='utf-8'))['items']
R8 = {r['id'][:8]: r for r in ROADS}; N8 = {n['id'][:8]: n for n in NODES}
O = {b['name']: b['coordinates'][0][0] for b in json.loads((audit / 'building-outlines-5186.json').read_text(encoding='utf-8'))}
D14 = json.loads((HERE.parent / 'b07/drawing14.json').read_text(encoding='utf-8')); F = D14['features']
r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2)
d = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])


def ground(x, y, r=1.5):
    c = sorted((math.hypot(a - x, b - y), z, i) for (a, b), (z, i, s) in C.items() if abs(a - x) <= r and abs(b - y) <= r)
    return None if not c else (r1(c[0][1]), 'terrain' if c[0][2] == TERRAIN else 'building')


# ---- 그림 14 의 좌표 틀(drawing14.py 와 같은 값)
MAIN_NW = (201044.7, 557344.2); BUK_SW, BUK_SE = (201004.8, 557387.2), (201082.5, 557350.6)
ex, ey = D14['fit']['downAxis']; nx, ny = D14['fit']['rightAxis']; S = D14['fit']['scaleMPerPixel']; PXM, PYC = D14['fit']['anchor']['pixel']
W = lambda px, py: (MAIN_NW[0] + ex * S * (py - PYC) + nx * S * (px - PXM), MAIN_NW[1] + ey * S * (py - PYC) + ny * S * (px - PXM))
chain = lambda p: (p[0] - MAIN_NW[0]) * ex + (p[1] - MAIN_NW[1]) * ey          # 본관 북쪽 벽을 따라 동쪽으로 잰 거리(북서 모서리 = 0)
off = lambda p: (p[0] - MAIN_NW[0]) * nx + (p[1] - MAIN_NW[1]) * ny            # 본관 북쪽 벽에서 북악관 쪽으로 떨어진 거리

# ---- 1. 횡단보도 길이 = 양방향 차도 폭 (확정: 같다 / 추정: 그림에서 잰 값)
im = np.array(Image.open(audit / '사용자-출입구·주차장-20261010/14-SMAP-본관·북악관사이-지하공간-사용자표시.webp').convert('RGB')).astype(int)
red = (im[..., 0] > 190) & (im[..., 1] < 90) & (im[..., 2] < 90)
rows = slice(414, 434)
strip_right = int(np.where(red[rows, 385:444].any(axis=0))[0].max()) + 385      # 띠 맨 위 선의 북악관 쪽 가장자리
box_left = int(np.where(red[rows, 497:560].any(axis=0))[0].min()) + 497         # 통로(상자)의 본관 쪽 가장자리
dots = np.where(red[rows, 444:497].any(axis=0))[0] + 444
crossing = {'dotsOnlyM': r1((dots.max() - dots.min()) * S), 'stripEdgeToPassageM': r1((box_left - strip_right) * S), 'pixels': {'stripRightEdge': strip_right, 'dots': [int(dots.min()), int(dots.max())], 'passageLeftEdge': box_left},
            'fromMainWallM': [r1((strip_right - PXM) * S), r1((box_left - PXM) * S)],
            'reading': '점 세 개만 재면 짧고, 점선이 잇는 두 끝(띠 가장자리 ~ 통로 상자)을 재면 길다. 횡단보도는 두 끝 사이 전체이므로 긴 값을 차도 폭으로 쓴다(추정 ±2 m). 짧은 값은 양방향 차도로는 좁다'}
Wd = crossing['stripEdgeToPassageM']

# ---- 2. 951c157d 를 차도 선으로 다시 대조
c951 = R8['951c157d']['coordinates']; s951 = [chain(p) for p in c951]


def z951(s):  # 951c157d 저장 높이를 같은 거리에서 읽는다. 선 밖은 끝 값 그대로(늘이지 않음)
    xs, zs = s951[::-1], [p[2] for p in c951][::-1]
    return float(np.interp(s, xs, zs)), ('inside' if xs[0] <= s <= xs[-1] else 'beyond 951 end (clamped)')


stations = []
for st, up in zip(F['mainSideStrip']['centreline'], D14['smapAlongStrip']['pavedPathSameStations']):
    s = chain(st['xy']); z, how = z951(s); north = st['fromMainWallM'][1]
    stations.append({'chainageM': r1(s), 'stripCentre': st['xy'], 'stripNorthEdgeFromWallM': north, 'expectedCarriagewayCentreFromWallM': r1(north + Wd / 2), 'upperPathSmapM': up[0], 'z951M': r2(z), 'z951How': how, 'upperMinus951M': r1(up[0] - z)})
off951 = [r1(off(p)) for p in c951]
exp = [x['expectedCarriagewayCentreFromWallM'] for x in stations]
mid_crossing = r1((crossing['fromMainWallM'][0] + crossing['fromMainWallM'][1]) / 2)
up0, up1 = stations[0], stations[-1]
upper_grade = (up1['upperPathSmapM'] - up0['upperPathSmapM']) / (up1['chainageM'] - up0['chainageM']) * 100
deck = (201098.0, 557302.7); main_poly = Polygon(O['본관']); han_poly = Polygon(O['한림관'])
A_WEST = {'what': '본관 1층 계산 127.0 (본관 2층 = 입구(2) 지면 130.7, 층고 3.67. 추정) / 표지판 P1 입구 문턱 127.9 (S-MAP ±1.5)', 'chainageM': r1(chain(F['mainSideStrip']['startsAt']['xy'])), 'zM': [127.0, 127.9]}
A_EAST = {'what': '연결 데크: 한림관 3층 137.8 / 본관 5층 138.1 (둘 다 계산, 추정)', 'chainageM': r1(chain((201104.2, 557314.9))), 'zM': [137.8, 138.1], 'note': '거리는 본관 북동 모서리까지(데크는 모서리를 돌아 남쪽, 자리 추정)'}
line = lambda s: A_WEST['zM'][0] + (np.mean(A_EAST['zM']) - A_WEST['zM'][0]) * (s - A_WEST['chainageM']) / (A_EAST['chainageM'] - A_WEST['chainageM'])
top_ext = c951[0][2] + (A_EAST['chainageM'] - s951[0]) * R8['951c157d']['lengthM'] ** 0 * ((c951[0][2] - c951[-1][2]) / (s951[0] - s951[-1]))
fit951 = {
    'plan': {'road951FromMainWallM': [min(off951), max(off951)], 'expectedCentreAlongStripM': [min(exp), max(exp)], 'expectedCentreAtCrossingM': mid_crossing, 'carriagewayWidthM': Wd,
             'differenceM': [r1(min(off951) - max(exp)), r1(max(off951) - min(exp))], 'differenceAtCrossingM': [r1(min(off951) - mid_crossing), r1(max(off951) - mid_crossing)],
             'verdict': '맞음(±2 m 안): 띠의 북악관 쪽 가장자리에서 차도 폭의 절반만큼 떨어진 자리가 차도 가운데이고, 951c157d 가 그 자리에 있다. 위 보행로 c52095ad 와 평면이 겹친다 = 차도가 위 보행로 바로 밑(두 층)'},
    'pedestrianProhibited': '맞음: 보행 띠를 따로 두면 차도 선의 보행 금지는 사용자 말과 어긋나지 않는다. B07 의 "보행 허용으로 고치기" 제안은 거둔다',
    'z': {'stored': [[r1(s), p[2]] for s, p in zip(s951, c951)], 'gradePct': r1((c951[0][2] - c951[-1][2]) / R8['951c157d']['lengthM'] * 100), 'upperPathSmapGradePct': r1(upper_grade),
          'belowUpperPathM': [min(x['upperMinus951M'] for x in stations), max(x['upperMinus951M'] for x in stations)], 'belowUpperPathAtTopEndM': 3.4,
          'anchors': [A_WEST, A_EAST], 'anchorLineGradePct': r1((np.mean(A_EAST['zM']) - A_WEST['zM'][0]) / (A_EAST['chainageM'] - A_WEST['chainageM']) * 100),
          'storedMinusAnchorLineM': {'bottomEnd': r1(c951[-1][2] - line(s951[-1])), 'topEnd': r1(c951[0][2] - line(s951[0]))},
          'topEndExtendedToMainNEcornerM': r1(top_ext), 'mainSideStairTopSmapM': F['mainSideStairs']['centre']['smap'][0], 'stairDropIfStripAt951BottomM': r1(F['mainSideStairs']['centre']['smap'][0] - c951[-1][2]),
          'verdict': '위 끝은 맞음: 136.39 m 는 위 보행로 면보다 3.4 m 아래이고, 같은 기울기로 본관 북동 모서리까지 늘이면 데크 높이(137.8~138.1)와 0.3 m 안. 아래 끝은 낮게 저장된 것으로 보임(추정): 위 보행로보다 5.6 m 아래, 두 기준을 이은 선보다 낮다. 그래서 선의 기울기 19 % 가 위 보행로(S-MAP)나 두 기준을 이은 선보다 가파르다. 어느 높이도 측정이 아니라 고치지 않는다'},
    'ends': {'bottom': {'xy': [r1(v) for v in c951[-1][:2]], 'z': c951[-1][2], 'chainageM': r1(s951[-1]), 'reading': '횡단보도 선에서 동쪽으로 %.1f m 인 자리에서 끝난다. 차도는 여기서 끝나지 않고 서문·제2주차장 입구 쪽으로 이어진다(확정: 두 입구에서 들어온다 / 선은 모름)' % (s951[-1] - chain(F['crossing']['from']['xy']))},
             'top': {'xy': [r1(v) for v in c951[0][:2]], 'z': c951[0][2], 'chainageM': r1(s951[0]), 'reading': '문예관 아래층 길 66f166a8(136.39 m)에 붙는다. 차도가 그 동쪽으로 어디까지 가는지는 모름. 데크 표지까지 평면 %.1f m' % d(c951[0], deck)}}}

# ---- 3. 본관 쪽 제안 도형: 보행 띠(그림 안 구간만), 계단, 데크
strip_pts = [[*F['mainSideStrip']['startsAt']['xy'], r2(c951[-1][2])]] + [[*x['stripCentre'], x['z951M']] for x in stations]
stairA_top = [*F['mainSideStairs']['centre']['xy'], F['mainSideStairs']['centre']['smap'][0]]
stairA = {'top': stairA_top, 'bottom': strip_pts[0], 'planLengthM': r1(d(stairA_top, strip_pts[0])), 'dropM': r1(stairA_top[2] - strip_pts[0][2]),
          'toMainEntrance2M': D14['compare']['markers']['본관 입구(2)']['toMainSideStairsM'],
          'note': '위 끝 = 그림의 계단 뭉치 가운데(지상, S-MAP), 아래 끝 = 띠의 시작점(높이 = 951c157d 아래 끝 값, 추정). 평면 길이가 내림에 비해 짧다: 실제 계단은 더 길거나 꺾인다(모름). 본관 입구(2)("지하주차장과 본관 2층으로 연결", 지면 130.5~130.7 = 본관 2층 기준)와 같은 곳으로 보인다(추정): 지상 = 본관 2층 높이, 계단 아래 = 지하 차도 높이'}
deck_info = {'marker': list(deck), 'insideMainOutline': bool(main_poly.contains(Point(deck))), 'toMainOutlineM': r1(main_poly.exterior.distance(Point(deck))), 'toHanlimOutlineM': r1(han_poly.distance(Point(deck))),
             'levelM': [137.8, 138.1], 'stripDrawnEnd': strip_pts[-1], 'stripDrawnEndToMarkerM': r1(d(strip_pts[-1], deck)), 'stripDrawnEndToMainNEcornerM': r1(A_EAST['chainageM'] - stations[-1]['chainageM']),
             'candidateNook': '본관 동쪽 벽·한림관 북쪽 벽 사이 모퉁이 (201104~201114, 557309~557314), S-MAP 133.8~141.2 m (B07, 추정)',
             'reading': '띠는 그림 아래 끝을 넘어 이어진다(확정: 그림이 잘림). 데크가 띠에서 이어진다는 것은 확정, 띠가 어디까지 가서 어떻게 데크에 닿는지는 모름. 표지는 본관 외곽 안쪽이라 문 자리로 그대로 쓰지 못한다'}

# ---- 4. 북악관 B1
e2 = ((BUK_SE[0] - BUK_SW[0]) / d(BUK_SW, BUK_SE), (BUK_SE[1] - BUK_SW[1]) / d(BUK_SW, BUK_SE)); n2 = (-e2[1], e2[0])
along = lambda p: (p[0] - BUK_SW[0]) * e2[0] + (p[1] - BUK_SW[1]) * e2[1]      # 남쪽 벽을 따라 서쪽 끝에서 동쪽으로
inside = lambda p: (p[0] - BUK_SW[0]) * n2[0] + (p[1] - BUK_SW[1]) * n2[1]     # 남쪽 벽에서 건물 안쪽으로
DOOR = (201008.5, 557395.0); DOOR_GROUND = 131.7
stairB = F['bukakStairs']['centre']['xy']; f995 = R8['f99540e3']['coordinates']; c053 = R8['05378724']['coordinates']; c956 = R8['95632bb8']['coordinates']; c1fc = R8['1fc3a2f5']['coordinates']
wl0, wl1 = F['bukakWallStrip']['from']['xy'], F['bukakWallStrip']['to']['xy']
pix = lambda p: [round(PXM + off(p) / S), round(PYC + chain(p) / S)]
turn = c956[-1]
ang = lambda a, b: math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
left_turn = (ang(c1fc[0], c1fc[-1]) - ang(c956[0], c956[-1]) + 540) % 360 - 180
box_n = [F['bukakPassage']['corners'][1]['smap'][0], F['bukakPassage']['corners'][2]['smap'][0]]
surf_top = r1(sum(box_n) / 2)
STOREY = 3.44
bukak = {
    'stair': {'drawnCentre': stairB, 'drawnPixelBox': [[560, 345], [583, 390]], 'drawnRunM': F['bukakStairs']['extentM'][0],
              'f99540e3': {'from': f995[0], 'to': f995[1], 'pixels': [pix(f995[0]), pix(f995[1])], 'lengthM': R8['f99540e3']['lengthM'], 'name': R8['f99540e3']['name'], 'levelId': R8['f99540e3']['levelId'],
                           'toDrawnCentreM': r1(min(d(f995[0], stairB), d(f995[1], stairB))), 'storedDirection': '회차 공간 쪽 끝 131.10 m → 건물 쪽 끝 132.08 m: 건물로 들어가며 0.98 m 오른다(이어진 05378724 까지 1.70 m 오름)'},
              'stairPlanLengthWith05378724M': r1(R8['f99540e3']['lengthM'] + R8['05378724']['lengthM']), 'surfaceAtTopSmapM': surf_top, 'surfaceRangeM': sorted(box_n),
              'verdict': 'f99540e3 의 두 끝이 그림의 계단 뭉치 상자 안(픽셀)이다: 자리는 이 계단이 맞다(추정, ±2 m). 이름도 "B1 진입 계단". 그러나 저장 높이는 건물 쪽으로 오른다: 사용자 확정(지상에서 내려간다)과 방향이 반대다. 높이는 "추정"으로 저장된 값'},
    'storedRoute': {'roads': ['f99540e3', '05378724', '95632bb8', '1fc3a2f5'], 'names': [R8[k]['name'] for k in ('f99540e3', '05378724', '95632bb8', '1fc3a2f5')], 'storedZM': 132.8,
                    'turnAt': [r1(v) for v in turn[:2]], 'turnDeg': r1(left_turn), 'turnIsLeft': left_turn > 0, 'runAfterTurnM': R8['1fc3a2f5']['lengthM'],
                    'insideSouthWallM': [r1(inside(c1fc[0])), r1(inside(c1fc[-1]))], 'westEnd': [r1(v) for v in c1fc[-1][:2]], 'westEndToDoorM': r1(d(c1fc[-1], DOOR)), 'westEndToWestWallM': r1(along(c1fc[-1])),
                    'verdict': '계단 → 안쪽 통로 → 왼쪽으로 꺾음 → 벽과 나란히 서쪽으로 곧게 → 끝이 GS25 문에서 %.1f m. 사용자가 말한 B1 길과 모양이 같다(추정). 다만 이 건물은 층마다 복도 배치가 같을 수 있어 모양만으로 층을 가르지 못한다' % d(c1fc[-1], DOOR)},
    'door': {'xy': list(DOOR), 'insideSouthWallM': r1(inside(DOOR)), 'alongFromWestEndM': r1(along(DOOR)), 'groundM': DOOR_GROUND},
    'drawnWallLine': {'from': wl0, 'to': wl1, 'lengthM': F['bukakWallStrip']['lengthM'], 'insideSouthWallM': r1(inside(wl0)), 'alongM': [r1(along(wl0)), r1(along(wl1))], 'stairAlongM': r1(along(stairB)),
                      'westEndToDoorM': r1(d(wl0, DOOR)), 'reading': '그린 선은 남쪽 벽 선 위(±2 m)다. 문은 서쪽 끝 벽에서 남쪽 벽보다 %.1f m 안쪽이다. 벽 선을 그대로 서쪽으로 늘이면 문이 아니라 남서 모서리에 닿는다. 그린 선은 "이 벽 안쪽 아래"를 가리킨 것으로 읽는다(추정): 복도 가운데 선으로 쓰지 않는다' % inside(DOOR)},
    'straightStairFootToDoor': {'from': [r1(v) for v in f995[1][:2]], 'to': list(DOOR), 'lengthM': r1(d(f995[1], DOOR)), 'angleToWallDeg': r1(abs((ang(f995[1], DOOR) - ang(BUK_SE, BUK_SW) + 540) % 360 - 180)),
                                'lengthCheck': '계단에서 그린 선 서쪽 끝까지 벽을 따라 %.1f m + 거기서 문까지 %.1f m. 건물 긴 변 86.1 m, 계단은 서쪽 끝에서 %.1f m(가운데쯤)' % (along(stairB) - along(wl0), d(wl0, DOOR), along(stairB)),
                                'reading': '계단 아래와 문을 곧게 이으면 벽과 비스듬하다. 새로 그리는 대신 저장된 길(같은 모양, 벽과 나란)을 쓰는 쪽을 권한다'},
    'b1Height': None,
    'places': [{'name': '편의점 (북악관 B1)', 'xy': [r1(v) for v in turn[:2]], 'grade': '확정(계단 아래에서 좌회전하면 있다) / 위치 추정(꺾는 자리, ±10 m, 복도 어느 쪽인지 모름)'},
               {'name': '라운지 (북악관 B1)', 'xy': [r1(v) for v in turn[:2]], 'grade': '확정(계단 아래에서 좌회전하면 있다) / 위치 추정(꺾는 자리, ±10 m, 복도 어느 쪽인지 모름)'}]}

# ---- 4b. 북악관 층 표 다시 (사용자 확정 2026-10-10: 지하층·1층·7층은 천장이 꽤 높고 나머지는 보통. GS25 문으로 들어가면 계단을 내려간다)
WALK = json.loads((audit / 'claude-walk-1218-levels.json').read_text(encoding='utf-8'))['phones']
wz = {k: [x['z'] for x in WALK[k]['plateausFloorZ']['북악관']] for k in ('C02', 'C01')}          # 멈춘 층 = 1·5·6·7·8층 (4층 없음)
rise = {k: [r2(b - a) for a, b in zip(v, v[1:])] for k, v in wz.items()}                           # [1→5 (세 층), 5→6, 6→7, 7→8]
ordinary = [rise['C02'][1], rise['C01'][1], rise['C02'][2], rise['C01'][2], 2.72]                  # 5층·6층 층고(두 휴대폰) + 운영 길의 8→9
ORD = r2(float(np.median(ordinary)))
f1_storey = {k: r2(v[0] - 2 * ORD) for k, v in rise.items()}                                       # 1→5 에서 보통 층 둘(2·3층)을 뺀 것 = 1층 층고
f7_storey = {k: v[3] for k, v in rise.items()}
F1 = 133.1; F5 = 143.47                                                                            # 1층 기준(S-MAP 입구 지면), 5층(운영 길 = 보행 기록 단)
f1_anchor = r2(F5 - F1 - 2 * ORD)
tall_lo, tall_hi = min(f7_storey.values()), max(max(f1_storey.values()), f1_anchor)
tall_mid = r1((tall_lo + tall_hi) / 2)
table = {'B1': r1(F1 - tall_mid), '1': F1, '2': r1(F5 - 2 * ORD), '3': r1(F5 - ORD), '5': F5, '6': 146.18, '7': 148.92, '8': 151.79, '9': 154.51}
bukak['floors'] = {'userFact': '지하층·1층·7층은 천장이 꽤 높고 나머지 층은 보통이다(확정). 4층 없음(확정)',
                   'walk1218': {'stoppedFloors': [1, 5, 6, 7, 8], 'floorZ': wz, 'risesM': rise, 'note': '기압 상대 높이, 휴대 높이 1 m 가정. C01 의 절대값은 9 m 어긋나 차이만 쓴다. 2·3층에서는 멈추지 않아 1→2층을 따로 재지 못했다'},
                   'ordinaryStoreyM': {'samples': ordinary, 'median': ORD}, 'storey7M': f7_storey, 'storey7MinusOrdinaryM': {k: r2(v - ORD) for k, v in f7_storey.items()},
                   'storey1M': dict(f1_storey, fromEntranceAnchor133_1AndStored5F=f1_anchor), 'storey1How': '1→5층 오름에서 보통 층고 둘(2·3층)을 뺀 값. 2·3층이 보통 층이라는 사용자 말에 기댄 계산(추정)',
                   'check': '7→8층은 두 휴대폰 모두 가장 크다(보통보다 +%.2f~+%.2f m): 사용자 말과 맞는다. 1층은 직접 재지 못했지만 계산하면 %.1f~%.1f m 로 다른 층의 두 배쯤: 사용자 말과 맞는다' % (min(f7_storey.values()) - ORD, max(f7_storey.values()) - ORD, min(min(f1_storey.values()), f1_anchor), tall_hi),
                   'roof': {'smapM': 160.6, 'floor9M': 154.51, 'floor9ToRoofM': r1(160.6 - 154.51), 'note': '9층 바닥에서 S-MAP 지붕까지 6.1 m. 9층은 보통 층이라 했으므로 남는 약 3.4 m 는 경사 지붕·지붕창 부분으로 본다(추정). B1 을 정하는 데는 쓰이지 않는다'},
                   'table': table, 'tableGrade': {'1': 'S-MAP(기준)', '5': '추정(보행 기록 단)', 'others': '추정'},
                   'storedNote': '운영 길의 2·3층 단(136.7, 140.6)은 1→5층을 3.9+3.9+2.87 로 나눈 값이다. 1층이 높고 2·3층이 보통이면 2층 %.1f, 3층 %.1f m 가 된다(추정)' % (table['2'], table['3'])}
bukak['b1Height'] = {'proposedM': table['B1'], 'boundsM': [r1(F1 - tall_hi), r1(F1 - tall_lo)], 'grade': '추정', 'tallStoreyRangeM': [tall_lo, r2(tall_hi)],
                     'how': 'B1 바닥 = 1층 133.1 − 높은 층 하나. "꽤 높은" 층의 크기는 이 건물에서 나온 두 값 사이로 본다: 7층 %.2f m(작은 쪽) ~ 1층 %.2f m(큰 쪽). 제안 값은 그 가운데 %.1f m' % (tall_lo, tall_hi, tall_mid),
                     'upperLimitFromDoor': 'GS25 문 앞 지면 131.7 m 보다 낮다(확정: 문으로 들어가면 계단을 내려간다). 문 안 계단은 제안 값에서 %.1f m(약 %d칸), 범위로는 %.1f~%.1f m' % (DOOR_GROUND - table['B1'], round((DOOR_GROUND - table['B1']) / 0.17), DOOR_GROUND - (F1 - tall_lo), DOOR_GROUND - (F1 - tall_hi)),
                     'previous': '앞의 129.7 m(보통 층고 3.44 m)는 "지하층 천장이 꽤 높다"와 맞지 않아 거둔다. 지금 범위의 위쪽 끝과 같다',
                     'sideChecks': ['저장된 계단 두 구간의 평면 길이 %.1f m (보행 기록, ±2 m): 계단 기울기 0.5~0.65 면 3.3~4.2 m 내림' % (R8['f99540e3']['lengthM'] + R8['05378724']['lengthM']), '본관 옆 지하 차도 서쪽 끝 126.8~127.9 m 와는 지하에서 이어지지 않으므로 견주지 않는다'],
                     'closed': '"GS25 문 안에 단이 있는가"는 닫혔다(내려간다). "B1 이 문 앞 지면과 같은 131.7 m" 읽기는 없어졌다: 운영 길의 132.8 m 층은 B1 바닥이 아니다',
                     'question': '북악관 벽 앞 계단(또는 GS25 문 안 계단)은 몇 칸쯤인가. 한 칸 0.17 m 로 B1 바닥이 바로 나온다'}

# ---- 4c. 사용자 그림(서문·제2주차장): 지붕 모서리 4점에 맞춘 닮음 변환(화면이 기울어 지붕이 땅보다 화면 위쪽으로 밀린다: 높이 1 m 에 LEAN 픽셀 아래로 보정)
LEAN = 2.1   # 북악관 남쪽 벽이 화면에서 약 60 픽셀로 보임(지붕 160.7 − 광장 132 = 29 m)
PLANE = 131.5
ctrl = [('북악관 북서 모서리', (583, 140), (201016.5, 557412.1), 160.7), ('북악관 남서 모서리', (505, 232), (201004.8, 557387.2), 160.7), ('본관 북서 모서리', (640, 515), (201044.7, 557344.2), 153.8), ('본관 서쪽 모서리', (583, 610), (201033.4, 557319.4), 153.8)]
px = np.array([[p_[0], p_[1] + LEAN * (h - PLANE)] for _, p_, _, h in ctrl]); wxy = np.array([w_ for _, _, w_, _ in ctrl])
pc_, wc_ = px.mean(0), wxy.mean(0); u_ = (px - pc_) * [1, -1]; v_ = wxy - wc_
a_ = (u_ * v_).sum() / (u_ ** 2).sum(); b_ = (u_[:, 0] * v_[:, 1] - u_[:, 1] * v_[:, 0]).sum() / (u_ ** 2).sum(); SC = math.hypot(a_, b_)


def G(p_, z=PLANE):
    q = (p_[0] - pc_[0], -(p_[1] + LEAN * (z - PLANE) - pc_[1])); return (wc_[0] + a_ * q[0] - b_ * q[1], wc_[1] + b_ * q[0] + a_ * q[1])


resid = [r1(d(G(p_, h), w_)) for _, p_, w_, h in ctrl]


def spot(name, centre, extent, z, compare):
    g = G(centre, z)
    return {'what': name, 'pixel': list(centre), 'xy': [r1(g[0]), r1(g[1])], 'circleSizeM': [r1(extent[0] * SC), r1(extent[1] * SC)], 'assumedGroundM': z, 'smap': ground(*g, r=2.5), 'distancesM': {k: r1(d(g, w_)) for k, w_ in compare.items()}}


gates = {'image': '사용자-서문·제2주차장·수인관-20261010/01-SMAP-서문·제2주차장-사용자표시.webp', 'grade': '확정(두 입구가 이 자리라는 것: 사용자 표시) / 좌표 추정',
         'fit': {'controls': [{'name': n, 'pixel': list(p_), 'xy': list(w_), 'roofM': h, 'residualM': e} for (n, p_, w_, h), e in zip(ctrl, resid)], 'scaleMPerPixel': round(SC, 3), 'rotationDeg': r1(math.degrees(math.atan2(b_, a_))),
                 'leanPixelsPerM': LEAN, 'assumedPlanErrorM': 6.0, 'note': '눈으로 찍은 지붕 모서리 4점, 기운 화면. 동그라미 자체가 10~30 m 크기라 입구 자리는 동그라미 안 어디인지까지만 안다'},
         'westGate': spot('"서문" 동그라미 가운데', (390, 205), (90, 130), 117.0, {'E09 서문 터널 입구 (200984.0, 557399.5)': (200984.0, 557399.5), '학교 표지 서문 (200967.8, 557401.5)': (200967.8, 557401.5), '학교 표지 서문 주차장 출입구 (200969.0, 557402.8)': (200969.0, 557402.8), '북악관 남서 모서리': BUK_SW}),
         'lot2': spot('"2주차장" 동그라미 가운데', (518, 700), (55, 56), 128.0, {'E09 표지판 P1 입구 (201021.9, 557307.1)': (201021.9, 557307.1), '학교 표지 제2주차장 출입구 (201057.8, 557267.2)': (201057.8, 557267.2), '유담관 입구(2) 9층 (201038.5, 557283.0)': (201038.5, 557283.0),
                                                                              '버스정류장 1164 (201023.3, 557317.0)': (201023.3, 557317.0), '버스정류장 2115 (201031.0, 557319.0)': (201031.0, 557319.0), '951c157d 아래 끝': tuple(c951[-1][:2])}),
         'layout': '회차 공간 서쪽 가장자리를 따라 화단 띠(옹벽 위)가 남북으로 길게 있고, 그 서쪽 아래에 바깥 차도(서경로)가 나란히 지난다. 회차 공간이 바깥 차도보다 높다(S-MAP: 회차 공간 130~131 m, 서문 앞 차도 117.0 m)'}

# ---- 5. 제2주차장 입구 후보
lot2 = {'userStatement': '버스 정류장 근처. 유담관 9층으로 들어가는 보행 길이 그 위를 지붕처럼 덮는다. 차는 여기와 서문에서 지하 차도로 들어간다(확정)', 'position': None,
        'candidates': [
            {'what': '표지판 "P1" 입구(본관 남서 화단 아래, E09 P-UP 끝)', 'xy': [201021.9, 557307.1], 'thresholdM': 127.9, 'grade': '추정',
             'for': ['버스정류장 표지에서 10.0 / 15.0 m', '유담관 9층 앞마당(129.2 m)·입구(2)에서 29.3 m: 그 보행 길이 이 입구 위를 지난다고 읽을 수 있다', '문턱 127.9 m 가 지하 차도 서쪽 끝 높이(951c157d 아래 끝 126.8, 본관 1층 계산 127.0)와 한 층 안에서 맞는다', '거리뷰에서 화단 아래로 내려가는 차량 입구'],
             'against': ['사용자가 이 입구를 제2주차장이라고 부른 적은 없다', '951c157d 아래 끝까지 52.9 m 의 선은 자료에 없다'],
             'smapAtThreshold': ground(201021.9, 557307.1)},
            {'what': '학교 표지 "제2주차장 출입구"', 'xy': [201057.8, 557267.2], 'grade': '원천(표지 위치만)', 'for': ['이름이 같다'], 'against': ['유담관 외곽 안(지붕 아래)이고 S-MAP·거리뷰에서 차량 문을 찾지 못했다', '버스정류장에서 58~61 m'], 'smapAtMarker': ground(201057.8, 557267.2)}],
        'userDrawing': gates['lot2'], 'verdict': '사용자가 그림에 표시한 자리가 후보 1(표지판 P1 입구)에서 %.1f m 다. 제2주차장 입구 = 표지판 P1 입구로 본다(확정: 사용자 표시 / 좌표는 E09 의 S-MAP 판독, 대응은 추정). 학교 표지 "제2주차장 출입구"는 %.1f m 떨어져 있어 문 자리가 아니다. 지하 차도까지의 선은 여전히 모름' % (gates['lot2']['distancesM']['E09 표지판 P1 입구 (201021.9, 557307.1)'], gates['lot2']['distancesM']['학교 표지 제2주차장 출입구 (201057.8, 557267.2)'])}

# ---- 6. 편집 작업(제안)과 이어지지 않은 고리
N = lambda k: N8[k]['id']; RID = lambda k: R8[k]['id']
xo = [*W(strip_right, 423)]; x1 = [*W(box_left, 423)]; pc = F['bukakPassage']['centre']
X0 = [r1(xo[0]), r1(xo[1]), ground(*xo)[0]]; X1 = [r1(x1[0]), r1(x1[1]), ground(*x1)[0]]; PC = [*pc['xy'], pc['smap'][0]]
SIDE = [[201002, 557388, 131.4], [201005, 557395, 131.7], [201008, 557402, 131.9], [201012, 557409, 132.2], [201013, 557412, 132.4]]   # B06 옆길(S-MAP), 끝은 노드 7895ac0d
DOOR_OUT = [*DOOR, DOOR_GROUND]; DOOR_IN = [*DOOR, 132.8]
ops = [
    dict(id='B08-1', op='retire_feature', target=RID('8fde6a04'), kind='vehicle', grade='확정',
         why='두 지하 공간은 지하에서 이어지지 않는다(사용자 확정). 이 선은 951c157d 아래 끝에서 북악관 계단 아래로 가는 지하 차량 선이다("지하주차장-북악관 B1 연결 (추정)")',
         pre={'revision': R8['8fde6a04']['revision'], 'status': 'DRAFT', 'fromNode': '81ff89df', 'toNode': '18b2d87e', 'note': '지금 북악관 묶음(길 70개)과 나머지를 잇는 유일한 선이다. B08-2·B08-3 과 함께 적용해야 묶음이 갈라지지 않는다'},
         rollback='revert_changeset(이 작업의 변경 묶음): RETIRED 가 DRAFT 로 돌아온다'),
    dict(id='B08-2', op='create_road', kind='pedestrian', grade='확정(계단·횡단보도·통로·계단이 이 순서로 있다) / 평면 추정(±2 m) / 높이 S-MAP 지상 면',
         args=dict(roadClass='pedestrian', structure='ordinary', name='본관 모서리 앞 ~ 횡단보도 ~ 북악관 쪽 통로 (사용자 그림, 위치 추정)', path=[stairA_top, X0, X1, PC, {'at': {'nodeId': N('18b2d87e')}}], zMode='explicit'),
         why='지상 보행 선. 북악관 쪽 끝은 운영 계단 f99540e3 의 회차 공간 쪽 노드에 붙인다(그 노드 저장 131.10 m 는 지상 면 %.1f 보다 낮다: 높이는 B08 질문 뒤)' % surf_top,
         pre={'node18b2d87e': N8['18b2d87e']['coordinate'], 'replacesProposal': 'B07 의 같은 선(마지막 점 높이 없음)'}, rollback='revert_changeset: 새 길이 RETIRED'),
    dict(id='B08-3', op='create_road', kind='pedestrian', grade='확정(오르막 보행로는 북악관 앞 광장에서 시작한다) / 평면 추정',
         args=dict(roadClass='pedestrian', structure='ordinary', name='횡단보도 ~ 문예관 옆 오르막 보행로 아래 끝 (위치 추정)', path=[{'at': 'B08-2 의 X1 점'}, {'at': {'nodeId': N('04044da5')}}], zMode='explicit'),
         geometry=[X1, N8['04044da5']['coordinate']], why='c52095ad 아래 끝은 이웃 길이 지워져 끊겨 있다. 같은 포장면(S-MAP 한 면) 위 %.1f m' % d(X1, N8['04044da5']['coordinate']),
         pre={'node04044da5': N8['04044da5']['coordinate'], 'note': '이 노드 저장 129.78 m 는 S-MAP 지면 132.7 m 보다 2.9 m 낮다(B07). c52095ad 높이를 고치기 전에는 이 선에 단이 생긴다'}, rollback='revert_changeset'),
    dict(id='B08-4', op='create_road', kind='pedestrian', grade='확정(지상에서 내려가는 계단이 있다) / 평면 추정(±2 m) / 위 높이 S-MAP, 아래 높이 추정',
         args=dict(roadClass='pedestrian', structure='stairs', name='본관 모서리 앞 계단 (지상 ~ 지하 차도 보행 구간, 위치·높이 추정)', path=[{'at': 'B08-2 의 첫 점'}, strip_pts[0]], zMode='explicit'),
         geometry=[stairA_top, strip_pts[0]], why=stairA['note'], pre={}, rollback='revert_changeset'),
    dict(id='B08-5', op='create_road', kind='pedestrian', grade='확정(지하 차도의 보행 구간이 본관 북쪽 벽을 따라 있다) / 평면 추정(±2 m) / 높이 추정(951c157d 저장 높이를 같은 거리에서 읽음)',
         args=dict(roadClass='pedestrian', structure='ordinary', vehicleAccess='prohibited', name='지하 차도 보행 구간 (본관 북쪽 벽 옆, 그림 안 구간만, 위치·높이 추정)', widthM=r1(np.median([s['widthM'] for s in F['mainSideStrip']['centreline']])), path=strip_pts, zMode='explicit'),
         why='사용자가 그린 붉은 띠의 가운데 선. 그림이 끝나는 곳에서 멈춘다(그 뒤는 unresolvedLinks U3). 지하라 서버 지형·S-MAP 면보다 %.1f~%.1f m 아래' % (min(x['upperMinus951M'] for x in stations), max(x['upperMinus951M'] for x in stations)),
         pre={'note': '951c157d 와는 잇지 않는다(차도와 보행 구간은 나란한 별개 선)'}, rollback='revert_changeset'),
    dict(id='B08-6', op='update_road', target=RID('951c157d'), kind='vehicle', grade='확정(양방향 지하 차도, 폭 = 횡단보도 길이) / 추정(이 선이 그 차도라는 것, 폭의 값)',
         args=dict(id=RID('951c157d'), expectedRevision=R8['951c157d']['revision'], attrs=dict(name='지하 차도 (본관·문예관 사이, 선·높이 추정)', widthM=Wd)),
         why='종류(차량)·양방향·보행 금지는 지금 값이 맞다. 이름과 폭만 고친다. 평면·높이는 그대로', pre={'revision': R8['951c157d']['revision'], 'pedestrianAccess': 'prohibited', 'vehicleDirection': 'both', 'widthM': None},
         rollback='revert_changeset', supersedes='E09-FIX-951c157d (보행 허용으로 고치기: 거둠)'),
    dict(id='B08-7', op='create_place', kind='pedestrian', grade='확정(문) / 원천(위치) / S-MAP(문 앞 지면)', args=dict(name='북악관 입구(4) = GS25 출입구 (B1층)', category='building_entrance', buildingId='북악관', position={'xy': list(DOOR), 'z': DOOR_GROUND}),
         why='B06 의 문 자리. 길은 B08-8·9', pre={}, rollback='revert_changeset'),
    dict(id='B08-8', op='create_road', kind='pedestrian', grade='S-MAP(높이) / 평면은 2차 후보 선(추정)', args=dict(roadClass='pedestrian', structure='ordinary', name='북악관 서쪽 옆길 (S-MAP 높이, 위치 추정)', path=SIDE + [{'at': {'nodeId': N('7895ac0d')}}], zMode='explicit'),
         why='B06 제안 그대로(사슬 2a). 끝 노드 7895ac0d 저장 128.13 m 가 S-MAP 132.5 m 보다 4.4 m 낮아 단이 생긴다: 산책로 서쪽 끝 높이를 먼저 고쳐야 한다', pre={'node7895ac0d': N8['7895ac0d']['coordinate']}, rollback='revert_changeset', from_='B06'),
    dict(id='B08-9', op='create_road', kind='pedestrian', grade='S-MAP(두 끝 131.7 m) / 추정(포장 여부)', args=dict(roadClass='pedestrian', structure='ordinary', name='옆길 ~ GS25 출입구 앞', path=[{'at': 'B08-8 의 둘째 점'}, DOOR_OUT], zMode='explicit'),
         geometry=[SIDE[1], DOOR_OUT], why='사슬 2c: 옆길에서 문 앞까지 %.1f m. B06 의 "서쪽 벽을 따라 문 앞까지" 선을 이것으로 바꾼다(옆길이 문 앞을 지난다)' % d(SIDE[1], DOOR), pre={}, rollback='revert_changeset'),
    dict(id='B08-10', op='create_road', kind='pedestrian', blocked='B1 바닥 높이(계단 단수) 뒤', grade='확정(복도가 GS25 출입구까지 곧게 이어진다) / 추정(저장된 1fc3a2f5 가 그 복도라는 것) / 높이 모름',
         args=dict(roadClass='pedestrian', structure='indoor_corridor', buildingId='북악관', name='북악관 B1 복도 서쪽 끝 ~ GS25 출입구 안쪽', path=[{'at': {'nodeId': N('f645a7b9')}}, DOOR_IN], zMode='explicit'),
         geometry=[N8['f645a7b9']['coordinate'], DOOR_IN], why='1fc3a2f5 서쪽 끝에서 문까지 %.1f m. 높이는 그 복도의 저장 값 132.8 m 를 임시로 따른다(B1 바닥이 정해지면 복도 묶음과 함께 옮긴다)' % d(N8['f645a7b9']['coordinate'], DOOR),
         pre={'nodef645a7b9': N8['f645a7b9']['coordinate']}, rollback='revert_changeset'),
    dict(id='B08-11', op='create_place', kind='pedestrian', blocked='B1 바닥 높이(계단 단수) 뒤', grade=bukak['places'][0]['grade'], args=dict(name='편의점 (북악관 B1)', category='facility', buildingId='북악관', position={'xy': bukak['places'][0]['xy'], 'z': None}), why='사용자 확정 ⑥', pre={}, rollback='revert_changeset'),
    dict(id='B08-12', op='create_place', kind='pedestrian', blocked='B1 바닥 높이(계단 단수) 뒤', grade=bukak['places'][1]['grade'], args=dict(name='라운지 (북악관 B1)', category='facility', buildingId='북악관', position={'xy': bukak['places'][1]['xy'], 'z': None}), why='사용자 확정 ⑥', pre={}, rollback='revert_changeset'),
]
hold = dict(id='B08-HOLD', what='B03 제안 "북악관 132.8 m 층 이름 B1 → 1층"(길 7개)과 그 위 층 이름 바꾸기', status='보류',
            why='그 7개 중 f99540e3·05378724·95632bb8·1fc3a2f5 가 사용자가 말한 B1 길과 자리·모양이 같다. 문 안에서 내려간다는 답으로 132.8 m 층이 B1 바닥이 아닌 것은 정해졌다. 남은 갈래: 이 길들이 실제 B1 길이면 이름은 맞고 높이를 한 층 내려야 하고, 1층 복도면 이름을 바꿔야 한다. 계단 단수나 "기록하며 걸은 길이 편의점 층인가"를 받기 전에는 이름을 바꾸지 않는다',
            roads=[RID(k) for k in ('f99540e3', '05378724', '95632bb8', '1fc3a2f5', '23283481', 'cc1b136f', '499d8625')])
unresolved = [
    dict(id='U1', what='지하 차도: 951c157d 아래 끝 ↔ 서문 터널 입구', a=[r1(v) for v in c951[-1]], b=[200984.0, 557399.5, 117.0], straightM=r1(d(c951[-1], (200984.0, 557399.5))), dropM=r1(c951[-1][2] - 117.0), grade='확정(이어진다) / 선 모름', need='지하 차도의 선(지도에 그림)'),
    dict(id='U2', what='지하 차도 ↔ 제2주차장 입구', a=[r1(v) for v in c951[-1]], b=[201021.9, 557307.1, 127.9], straightM=r1(d(c951[-1], (201021.9, 557307.1))), grade='확정(이어진다, 입구 = 사용자 표시) / 입구 좌표 S-MAP 판독(E09) / 선 모름', need='지하 차도의 선(지도에 그림)'),
    dict(id='U3', what='보행 띠의 그림 밖 구간 ↔ 본관 5층–한림관 3층 연결 데크', a=strip_pts[-1], b=[*deck, 137.8], straightM=deck_info['stripDrawnEndToMarkerM'], grade='확정(띠에서만 데크로 간다) / 데크 자리·선 모름', need='데크 자리 지도 1점'),
    dict(id='U4', what='GS25 출입구 안쪽 ↔ 바깥(문 앞 지면 131.7 m)', a=DOOR_IN[:2] + [None], b=DOOR_OUT, straightM=0.0, grade='확정(문, 들어가면 계단을 내려간다) / 안쪽 바닥 높이 추정 %.1f (%.1f~%.1f)' % (bukak['b1Height']['proposedM'], *bukak['b1Height']['boundsM']), need='계단 단수'),
    dict(id='U5', what='지하 차도의 동쪽 끝(951c157d 위 끝 너머)과 하늘이 열린 구간', a=[r1(v) for v in c951[0]], b=None, grade='모름', need='지하 차도의 선'),
    dict(id='U6', what='보행 띠 ↔ 차도 건너 문예관 아래층(66f166a8, 136.39 m)', a=None, b=None, grade='모름(사람이 차도를 건너 문예관 아래층으로 들어가는지 받지 못함)', need='질문'),
]
not_linked = '본관 옆 지하 공간(B08-4·5, 951c157d)과 북악관 쪽(f99540e3 아래)은 지하에서 잇지 않는다. 둘 사이의 길은 지상 선 B08-2 뿐이고, 지하 선 8fde6a04 는 없앤다(B08-1)'


# ---- 7. 모의 적용(스냅숏 복사본)
def summary(rs):
    p = {}

    def f(x):
        while p[x] != x: p[x] = p[p[x]]; x = p[x]
        return x
    for r in rs:
        for n in (r['a'], r['b']): p.setdefault(n, n)
    for r in rs: p[f(r['a'])] = f(r['b'])
    comp = collections.Counter(f(r['a']) for r in rs); pairs = collections.Counter(tuple(sorted((r['a'], r['b']))) for r in rs)
    return {'roads': len(rs), 'componentsByRoadCount': sorted(comp.values(), reverse=True), 'selfLoops': [r['id'] for r in rs if r['a'] == r['b']], 'duplicateEdges': [list(k) for k, v in pairs.items() if v > 1]}, (lambda a, b: a in p and b in p and f(a) == f(b))


base = [dict(id=r['id'][:8], a=r['fromNodeId'][:8], b=r['toNodeId'][:8], ped=r['pedestrianAccess'] != 'prohibited') for r in ROADS]
E = lambda i, a, b, ped=True: dict(id=i, a=a, b=b, ped=ped)
now = [r for r in base if r['id'] != '8fde6a04'] + [E('B08-2a', 'nA', 'nX1'), E('B08-2b', 'nX1', '18b2d87e'), E('B08-3', 'nX1', '04044da5'), E('B08-4', 'nA', 'nS0'), E('B08-5', 'nS0', 'nS1'),
                                                    E('B08-8a', 'nSIDE', 'nSIDE2'), E('B08-8b', 'nSIDE2', '7895ac0d'), E('B08-9', 'nSIDE2', 'nDOORout')]
later = now + [E('B08-10', 'f645a7b9', 'nDOORin'), E('U4', 'nDOORin', 'nDOORout'), E('U3', 'nS1', 'nDECK')]
CH = {'2a 옆길 남쪽 끝 → 뒤편 산책로 → 대일관 측면': ('nSIDE', 'bd4051c1'), '2c 옆길 남쪽 끝 → GS25 출입구(바깥)': ('nSIDE', 'nDOORout'), '2d 북악관 정면 계단 → B1 진입 통로': ('18b2d87e', '7a32499f'),
      '새: 본관 모서리 앞 → 횡단보도 → 북악관 계단 → 복도 서쪽 끝': ('nA', 'f645a7b9'), '새: GS25 출입구 안쪽이 길망에 붙었는가(북악관 정면 계단에서)': ('18b2d87e', 'nDOORin'), '새: GS25 출입구 안쪽 ↔ 바깥': ('nDOORin', 'nDOORout'), '새: 본관 모서리 앞 계단 → 보행 띠 → 연결 데크': ('nA', 'nDECK'),
      '새: 북악관 정면 → 문예관 옆 오르막 보행로 위 끝': ('18b2d87e', '4f294196'), '2a+2d: 북악관 실내 ↔ 뒤편 산책로': ('7a32499f', '7895ac0d')}
sim = {}
for name, rs in (('before', base), ('afterOpsNow', now), ('afterOpsNowPlusBlockedAndU3U4', later)):
    s, con = summary(rs); sp, conp = summary([r for r in rs if r['ped']])
    sim[name] = dict(s, pedestrianOnlyComponents=sp['componentsByRoadCount'], chains={k: bool(con(*v)) for k, v in CH.items()}, chainsWalkable={k: bool(conp(*v)) for k, v in CH.items()})
sim['note'] = ('before 의 한 묶음 111 은 보행 금지 차량 선 8fde6a04·951c157d 로만 북악관과 나머지가 이어진 것이다(pedestrianOnlyComponents 참고). afterOpsNow = B08-1~9 (막힌 것 제외). '
               '마지막 = B08-10 과 이어지지 않은 고리 U3·U4 가 풀렸다고 가정. 높이 단(7895ac0d 4.4 m, 04044da5 2.9 m, 18b2d87e 1.8 m)은 이음과 별개로 남는다')
CLASS = {'B08-1': '확정', 'B08-2': '확정(있다는 사실) + 추정(위치·값)', 'B08-3': '확정(있다는 사실) + 추정(위치·값)', 'B08-4': '확정(있다는 사실) + 추정(위치·값)', 'B08-5': '확정(있다는 사실) + 추정(위치·값)', 'B08-6': '확정(있다는 사실) + 추정(위치·값)',
         'B08-7': '확정 + 원천 + S-MAP', 'B08-8': 'S-MAP + 추정(평면)', 'B08-9': 'S-MAP + 추정(평면)'}
for o in ops: o['gradeClass'] = '막힘(질문 뒤에만)' if o.get('blocked') else CLASS[o['id']]
grades = collections.Counter(o['gradeClass'] for o in ops)
res = {'method': __doc__, 'applied': False, 'crossing': crossing, 'fit951': fit951, 'stations': stations, 'strip': {'points': strip_pts, 'lengthM': r1(sum(d(a, b) for a, b in zip(strip_pts, strip_pts[1:]))), 'widthM': F['mainSideStrip']['widthM']},
       'mainSideStair': stairA, 'deck': deck_info, 'bukak': bukak, 'lot2': lot2, 'gates': gates, 'operations': ops, 'hold': hold, 'unresolvedLinks': unresolved, 'noUndergroundLink': not_linked, 'simulation': sim,
       'operationCountsByLeadGrade': dict(grades), 'operationCountsByKind': dict(collections.Counter(o['kind'] for o in ops))}
out.write_text(json.dumps(res, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print(json.dumps({k: res[k] for k in ('crossing', 'fit951', 'mainSideStair', 'deck', 'simulation', 'operationCountsByLeadGrade', 'operationCountsByKind')}, ensure_ascii=False, indent=1))
print(json.dumps(bukak['floors'], ensure_ascii=False, indent=1)); print(json.dumps(bukak['b1Height'], ensure_ascii=False, indent=1)); print(json.dumps(gates, ensure_ascii=False, indent=1)); print(lot2['verdict'])
for s in stations: print(s)
print(strip_pts)
