"""B06 — 사용자 답변·사진 10장(2026-10-10)에서 좌표와 S-MAP 높이를 뽑는다. 읽기 전용, DB 없음.

  python docs/audit/b06/b06.py <audit-dir> <backend-dir> docs/audit/b06/results.json

입력: <audit-dir>/사용자-출입구·주차장-20261010/ 의 07(학교 지도 화면에 사용자가 유담관 3층 입구를 표시), 10(위성 화면에 사용자가 그린 빨간 선),
<audit-dir>/e05/smap-mesh-*.txt (S-MAP 격자), <audit-dir>/claude-live/*-live-2.json (운영 스냅숏), skuniv_places.json.
- 07: 노란 표지 30개를 skuniv_places.json 좌표에 맞춰(아핀) 사용자가 동그라미 친 표지의 좌표를 낸다.
- 10: 청록 건물 표지 5개(본관·문예관·한림관·대일관·상승관 = skuniv_places.json 의 건물 좌표)에 맞춰 빨간 선을 좌표로 옮기고 S-MAP 지면을 읽는다.
  표지 맞춤 잔차는 0.1 m 지만 선은 손으로 그린 것이고 위성 사진은 높은 건물이 기울어 찍혀 있어 평면 오차를 3 m 로 가정한다(추정).
- BUKAK_1M: S-MAP 3D 화면에서 2026-10-10T12:53Z 에 읽은 1 m 격자(북악관 서쪽 끝, x 200984~201017, y 557380~557413, e05/collect_grid.js 와 같은 방법) 중 쓴 칸만 옮겨 적었다.
필요: Pillow, numpy, scipy, scikit-image.
"""
import json, math, pathlib, sys
import numpy as np
from PIL import Image
from scipy import ndimage
from skimage.morphology import skeletonize
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'b03'))
from common import TERRAIN, load_cells
from tm5186 import to5186

audit, backend, out = map(pathlib.Path, sys.argv[1:4])
src = audit / '사용자-출입구·주차장-20261010'
C = load_cells(audit / 'e05'); r1 = lambda v: round(float(v), 1)
P = {p['장소명']: to5186(float(p['경도']), float(p['위도'])) for p in json.loads((backend / 'data/terrain/source/skuniv_places.json').read_text(encoding='utf-8')) if p.get('경도')}


def ground(x, y, r=2.1):
    """가장 가까운 S-MAP 칸(1 m 격자 우선)의 높이와 지형/건물 구분."""
    best = None
    for (a, b), (z, i, s) in C.items():
        d = math.hypot(a - x, b - y)
        if d <= r and (best is None or (s, d) < best[:2]): best = (s, d, z, i)
    return None if not best else [r1(best[2]), 'terrain' if best[3] == TERRAIN else 'building']


def blobs(mask, lo, hi):
    lab, n = ndimage.label(mask); o = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        if lo < len(xs) < hi: o.append((float(xs.mean()), float(ys.mean())))
    return o


def affine(px, en):
    M = np.c_[np.array(px), np.ones(len(px))]; en = np.array(en)
    cx = np.linalg.lstsq(M, en[:, 0], rcond=None)[0]; cy = np.linalg.lstsq(M, en[:, 1], rcond=None)[0]
    res = [math.hypot(M[i] @ cx - en[i, 0], M[i] @ cy - en[i, 1]) for i in range(len(px))]
    return (lambda x, y: (float(cx[0] * x + cx[1] * y + cx[2]), float(cy[0] * x + cy[1] * y + cy[2]))), res


# ---- 07: 유담관 3층 입구 (사용자 표시)
im = np.array(Image.open(src / '07-카카오맵-유담관3층입구-사용자표시.png').convert('RGB')).astype(int)
yel = blobs((im[..., 0] > 235) & (im[..., 1] > 180) & (im[..., 1] < 225) & (im[..., 2] < 80), 60, 600)
guess = lambda x, y: (218 + (x - 201013.8) / 0.415, 176 + (557382.7 - y) / 0.415)   # 북악관 입구(2)·(3) 두 표지로 잡은 첫 어림
pairs = []
for n, (x, y) in P.items():
    if not any(k in n for k in ('입구', '연결통로', '버스', '서문')): continue
    gx, gy = guess(x, y); d = sorted((math.hypot(bx - gx, by - gy), bx, by) for bx, by in yel)
    if d[0][0] < 8: pairs.append((n, x, y, d[0][1], d[0][2]))
to7, res7 = affine([p[3:] for p in pairs], [p[1:3] for p in pairs])
used = {(round(p[3]), round(p[4])) for p in pairs}
free = [b for b in yel if (round(b[0]), round(b[1])) not in used]
assert len(free) == 1, free                     # 목록의 어느 좌표와도 맞지 않는 표지 = 사용자가 동그라미 친 것
mx, my = to7(*free[0]); j3 = P['유담관 입구(3)']
road = sorted(z for (a, b), (z, i, s) in C.items() if 200990 <= a <= 200994 and 557304 <= b <= 557312 and i == TERRAIN)
yudam3 = {'circledMarker': [r1(mx), r1(my)], 'fit': {'markers': len(pairs), 'residualMeanM': round(sum(res7) / len(res7), 2), 'residualMaxM': round(max(res7), 2)},
          'repoListEntrance3': [r1(j3[0]), r1(j3[1])], 'offsetFromRepoListM': r1(math.hypot(mx - j3[0], my - j3[1])),
          'roadGroundM': r1(road[len(road) // 2]), 'roadGroundRangeM': [r1(road[0]), r1(road[-1])], 'roadCells': len(road),
          'wallProfileAtY557308': [[x, ground(x, 557308)] for x in (200990, 200992, 200994, 200996, 200998, 201000)],
          'note': '학교 지도 화면의 표지 자리가 저장소 목록 좌표와 다르다(학교가 좌표를 고쳤거나 목록이 옛 것. 어느 쪽인지 모름). 사용자 확정은 화면의 자리다'}

# ---- 10: 사용자 빨간 선 (문예관 입구 ~ 갈림 ~ 대일관 서쪽 끝 / 남서 갈래)
im = np.array(Image.open(src / '10-A14-문예관입구에서-대일관까지-사용자표시.webp').convert('RGB')).astype(int)
teal = sorted(blobs((im[..., 0] < 60) & (im[..., 1] > 170) & (im[..., 2] > 150) & (im[..., 2] < 200), 80, 1000))
names = ['본관', '문예관', '한림관', '대일관', '상승관']            # 화면 왼쪽에서 오른쪽 순서
to10, res10 = affine(teal, [P[n] for n in names])
ys, xs = np.where(skeletonize((im[..., 0] > 200) & (im[..., 1] < 60) & (im[..., 2] < 60)))
pts = [(to10(x, y), (int(x), int(y))) for x, y in zip(xs, ys)]
west = sorted((p for p in pts if p[1][0] <= 290), key=lambda p: p[1][1]); east = sorted((p for p in pts if p[1][0] > 290), key=lambda p: p[1][0])
samp = lambda L, n: [L[i] for i in sorted({round(k * (len(L) - 1) / (n - 1)) for k in range(n)})]
row = lambda p: [r1(p[0][0]), r1(p[0][1]), *(ground(*p[0]) or [None, None])]
westP = [row(p) for p in samp(west, 12)]; eastP = [row(p) for p in samp(east, 12)]
fork = eastP[0]; stub = [r for r in westP if r[3] == 'terrain' and r[1] <= fork[1] + 1.5]
live = audit / 'claude-live'
R = {r['id'][:8]: r for r in json.loads((live / 'roads-live-2.json').read_text(encoding='utf-8'))['items']}
N = {n['id'][:8]: n for n in json.loads((live / 'nodes-live-2.json').read_text(encoding='utf-8'))['items']}


def dist_to_roads(x, y, ids):
    best = 1e9
    for k in ids:
        c = R[k]['coordinates']
        for (ax, ay, _), (bx, by, _) in zip(c, c[1:]):
            t = max(0, min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2))); best = min(best, math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)))
    return best


chain = ('618385b9', 'a7a51d3c', 'fdb059c4', '9112314a', '3ab80c19')
dline = [dist_to_roads(r[0], r[1], chain) for r in eastP]
n4 = N['4f294196']['coordinate']; ez = [r[2] for r in eastP[1:]]
a14 = {'fit': {'markers': names, 'residualMaxM': round(max(res10), 2), 'assumedPlanErrorM': 3.0}, 'westPart_northToSouth': westP, 'eastPart_westToEast': eastP,
       'fork': fork[:2], 'forkZ': fork[2], 'eastEnd': eastP[-1][:3], 'eastBranchZ': [min(ez), max(ez)],
       'stub': [[r[0], r[1], r[2]] for r in ([fork] + stub)], 'stubEndToNodeM': r1(math.hypot(stub[-1][0] - n4[0], stub[-1][1] - n4[1])), 'node4f294196': n4,
       'lineToRoadsM': r1(max(dline)), 'lineToRoadsMedianM': r1(sorted(dline)[len(dline) // 2]), 'operationalChain': {k: [[r1(v) for v in p] for p in (R[k]['coordinates'][0], R[k]['coordinates'][-1])] for k in chain},
       'oldA14BottomCandidate': [201118, 557312, 141.3], 'oldCandidateToLineM': r1(min(math.hypot(201118 - p[0][0], 557312 - p[0][1]) for p in pts)),
       'road8e71c240': {'coords': [[r1(v) for v in p] for p in R['8e71c240']['coordinates']], 'toLineM': [r1(min(math.hypot(q[0] - p[0][0], q[1] - p[0][1]) for p in pts)) for q in R['8e71c240']['coordinates']],
                        'smapAlong': [ground(q[0], q[1]) for q in R['8e71c240']['coordinates']]},
       'landingCells144': sorted(r1(z) for (a, b), (z, i, s) in C.items() if 201110 <= a <= 201116 and 557332 <= b <= 557336 and i == TERRAIN),
       'reading': '문예관 표지에서 갈림 지점까지의 윗부분은 위성 사진에서 문예관 지붕(기울어 찍힘) 위에 그려져 건물 칸으로 읽힌다. 지면 높이는 갈림 지점부터 쓴다'}

# ---- 북악관 B1 (GS25 문): S-MAP 1 m 판독에서 옮겨 적은 칸
BUKAK_1M = {(201005, 557384): 131.3, (201005, 557388): 131.4, (201007, 557392): 131.6, (201008, 557393): 131.6, (201008, 557394): 131.7, (201008, 557395): 131.7, (201009, 557396): 131.7, (201008, 557397): 131.7,
            (201002, 557388): 131.4, (201005, 557395): 131.7, (201008, 557402): 131.9, (201012, 557409): 132.2, (201013, 557412): 132.4,
            (201000, 557395): 131.1, (200998, 557395): 129.7, (200996, 557395): 128.9, (200992, 557395): 127.4}
door = [201008.5, 557395.0, 131.7]; n7 = N['7895ac0d']['coordinate']; g7 = ground(n7[0], n7[1])
bukak = {'marker': [201009.8, 557395.0], 'door': door, 'doorGroundM': 131.7, 'doorGroundRangeM': [131.6, 131.8], 'firstFloorM': [132.8, 133.1], 'firstMinusDoorGroundM': [1.1, 1.4],
         'approach': [[x, y, z] for (x, y), z in BUKAK_1M.items() if (x, y) in ((201005, 557384), (201005, 557388), (201007, 557392))] + [door],
         'sideLane': [[x, y, z] for (x, y), z in BUKAK_1M.items() if (x, y) in ((201002, 557388), (201005, 557395), (201008, 557402), (201012, 557409), (201013, 557412))] + [[r1(n7[0]), r1(n7[1]), g7[0]]],
         'westwardProfileAtY557395': [[x, BUKAK_1M[(x, 557395)]] for x in (201008, 201005, 201000, 200998, 200996, 200992)],
         'promenadeEndNode7895ac0d': n7, 'promenadeEndSmap': g7, 'promenadeEndGapM': r1(g7[0] - n7[2]), 'read': 'S-MAP 3D viewer mesh pick 2026-10-10T12:53Z, 1 m grid, ortho-like (fov 0.12, tilt 90), miss 0, residual>0.3 m 3 of 1156'}

# ---- 한림관 1층 계단 (사진 05): 차도에서 문 앞까지 x=201107 의 남북 단면
land = sorted(z for (a, b), (z, i, s) in C.items() if 201105 <= a <= 201108 and 557278 <= b <= 557280 and i == TERRAIN)
hallim = {'profileX201107': [[y, ground(201107, y, 0.1)[0]] for y in range(557270, 557282)], 'laneM': [125.1, 125.2], 'landingM': r1(land[len(land) // 2]), 'landingRangeM': [r1(land[0]), r1(land[-1])],
          'photoSteps': '12 ± 3 (사진 05 확대, 추정)', 'marker': [r1(P['한림관 입구'][0]), r1(P['한림관 입구'][1])]}
# ---- 본관–한림관 연결(사진 04): 두 동 사이 칸
conn = {'marker': [r1(v) for v in P['본관-한림관 연결통로']], 'gapTerrainSouthToNorth': [[201100, y, ground(201100, y, 0.1)] for y in (557300, 557302, 557304)] + [[201102, y, ground(201102, y, 0.1)] for y in (557304, 557306, 557308)] + [[201104, y, ground(201104, y, 0.1)] for y in (557310, 557312)],
        'hallimEdgeCells': [[201100, y, ground(201100, y, 0.1)] for y in (557292, 557294, 557296, 557298)], 'flatDeckFound': False}
# ---- 주차장(사용자 말)과 E09 입구 사이 거리: 판단 없이 수치만
E09 = {'하단 입구(표지판 P2)': (201099.8, 557146.2), '표지판 P1 입구': (201021.9, 557307.1), '서문 옹벽 터널': (200984.0, 557399.5)}
ref = {'정문': (201129.2, 557112.8), '버스정류장 2115': P['서경대본관 2115번 버스정류장'], '버스정류장 1164': P['서경대본관 1164번 버스정류장'], '학교 표지 제1주차장 출입구': P['제1주차장 출입구'], '학교 표지 제2주차장 출입구': P['제2주차장 출입구'], '유담관 입구(2) 9층': P['유담관 입구(2)']}
parking = {'distancesM': {a: {b: r1(math.hypot(p[0] - q[0], p[1] - q[1])) for b, q in ref.items()} for a, p in E09.items()}, 'forecourt9F': {'box': [201018, 557288, 201030, 557296], 'smapM': 129.2}, 'note': '거리만 적는다. 어느 입구가 제1·제2주차장인지는 사용자 확인 전에는 정하지 않는다'}
res = {'yudam3F': yudam3, 'a14': a14, 'bukakB1': bukak, 'hallim1F': hallim, 'mainHallimConnector': conn, 'parking': parking}
json.dump({'method': __doc__, **res}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
a14p = {k: a14[k] for k in ('fit', 'fork', 'forkZ', 'eastEnd', 'eastBranchZ', 'stub', 'stubEndToNodeM', 'lineToRoadsM', 'lineToRoadsMedianM', 'oldCandidateToLineM', 'road8e71c240', 'landingCells144')}
print(json.dumps({**res, 'a14': a14p}, ensure_ascii=False))
