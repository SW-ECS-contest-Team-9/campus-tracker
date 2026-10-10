"""B07 — 사용자 그림 14(본관·북악관 사이 지하 공간, S-MAP 위에서 본 화면)를 좌표로 옮기고 운영 길·학교 표지·S-MAP 지면과 견준다. 읽기 전용.

  python docs/audit/b07/drawing14.py <audit-dir> <backend-dir> docs/audit/b07/drawing14.json

사용자 범례(확정): 붉은 색 = 지하 공간, 점선 = 횡단보도, 짧은 실선 뭉치 = 계단, 상자 = 통로.
좌표 옮기기(추정): 화면에서 본관·북악관의 벽이 세로로 나란하다. 원천 외곽(building-outlines-5186.json)의 두 벽 방향 평균을 화면 아래 방향으로,
두 벽 사이 거리(22.1 m)를 화면의 두 지붕 가장자리 사이(x 396 -> 595 픽셀)에 맞춰 축척을 정하고, 본관 북서 모서리를 지붕 모서리 픽셀 (396, 440)에 놓았다.
기준점이 지붕 가장자리(처마·기운 정도 모름)라 평면 오차는 2 m 로 본다. 확인: 표지판 P1 입구(E09)가 화면 왼쪽 끝의 둥근 화단 자리에, 북악관 남동 모서리가
문예관 낮은 날개가 시작하는 자리에 떨어진다(둘 다 눈으로 본 확인). 손으로 그린 선의 굵기는 6~8 픽셀(약 0.8 m)이다.
"""
import json, math, pathlib, statistics, sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'b03'))
from common import TERRAIN, load_cells, entrances

audit, backend, out = map(pathlib.Path, sys.argv[1:4])
C = load_cells(audit / 'e05')
ROADS = {r['id'][:8]: r for r in json.loads((audit / 'claude-live/roads-live-2.json').read_text(encoding='utf-8'))['items']}
O = {b['name']: b['coordinates'][0][0] for b in json.loads((audit / 'building-outlines-5186.json').read_text(encoding='utf-8'))}
r1 = lambda v: round(float(v), 1)
MAIN_NW, MAIN_NE = (201044.7, 557344.2), (201104.2, 557314.9)      # 본관 북쪽 벽(북악관·문예관 쪽)
BUK_SW, BUK_SE = (201004.8, 557387.2), (201082.5, 557350.6)        # 북악관 남쪽 벽(본관 쪽)
assert all(any(math.hypot(p[0] - q[0], p[1] - q[1]) < 0.1 for q in O[n]) for n, pts in (('본관', (MAIN_NW, MAIN_NE)), ('북악관', (BUK_SW, BUK_SE))) for p in pts)
unit = lambda a, b: ((b[0] - a[0]) / math.hypot(b[0] - a[0], b[1] - a[1]), (b[1] - a[1]) / math.hypot(b[0] - a[0], b[1] - a[1]))
e1, e2 = unit(MAIN_NW, MAIN_NE), unit(BUK_SW, BUK_SE)
ex, ey = (e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2; k = math.hypot(ex, ey); ex, ey = ex / k, ey / k   # 화면 아래 = 벽을 따라 동쪽
nx, ny = -ey, ex                                                                                      # 화면 오른쪽 = 북악관 쪽
gap = (MAIN_NW[0] - BUK_SE[0]) * -nx + (MAIN_NW[1] - BUK_SE[1]) * -ny                                 # 본관 북서 모서리에서 북악관 남쪽 벽까지
PX_MAIN, PX_BUK, PY_CORNER = 396, 595, 440
S = gap / (PX_BUK - PX_MAIN)
W = lambda px, py: (MAIN_NW[0] + ex * S * (py - PY_CORNER) + nx * S * (px - PX_MAIN), MAIN_NW[1] + ey * S * (py - PY_CORNER) + ny * S * (px - PX_MAIN))
PIX = lambda x, y: (PX_MAIN + ((x - MAIN_NW[0]) * nx + (y - MAIN_NW[1]) * ny) / S, PY_CORNER + ((x - MAIN_NW[0]) * ex + (y - MAIN_NW[1]) * ey) / S)


def ground(x, y, r=1.5):
    c = sorted((math.hypot(a - x, b - y), z, i) for (a, b), (z, i, s) in C.items() if abs(a - x) <= r and abs(b - y) <= r)
    return None if not c else [r1(c[0][1]), 'terrain' if c[0][2] == TERRAIN else 'building']


def pt(px, py):
    x, y = W(px, py); return {'pixel': [round(px), round(py)], 'xy': [r1(x), r1(y)], 'smap': ground(x, y)}


im = np.array(Image.open(audit / '사용자-출입구·주차장-20261010/14-SMAP-본관·북악관사이-지하공간-사용자표시.webp').convert('RGB')).astype(int)
red = (im[..., 0] > 190) & (im[..., 1] < 90) & (im[..., 2] < 90)
H, Wd = red.shape


def cen(x0, y0, x1, y1):
    ys, xs = np.where(red[y0:y1, x0:x1]); return (x0 + xs.mean(), y0 + ys.mean(), x0 + xs.min(), y0 + ys.min(), x0 + xs.max(), y0 + ys.max(), len(xs))


# 1) 본관 옆 띠: 줄마다 붉은 픽셀을 두 무리(왼쪽 선·오른쪽 선)로 나눈다
strip = []
for py in range(450, H, 30):
    xs = np.where(red[py:py + 4, 390:470].any(axis=0))[0] + 390
    if len(xs) < 2: continue
    cut = xs[np.argmax(np.diff(xs))]; L = xs[xs <= cut]; R = xs[xs > cut]
    if not len(R) or R.mean() - L.mean() < 8: continue
    l, r = L.mean(), R.mean(); a = pt((l + r) / 2, py)
    a.update(widthM=r1((r - l) * S), fromMainWallM=[r1((l - PX_MAIN) * S), r1((r - PX_MAIN) * S)])
    strip.append(a)
ys, xs = np.where(red[:, 385:470]); strip_top = int(ys[xs + 385 > 395].min())
# 2) 그 밖의 표시(픽셀 상자는 그림을 보고 잡았다)
stA = cen(338, 395, 392, 446); dots = cen(445, 414, 496, 433); boxP = cen(497, 355, 559, 440); stB = cen(560, 345, 583, 390); wall = cen(584, 200, 600, 445)
feat = {
    'mainSideStrip': {'what': '본관 북쪽 벽 옆의 지하 공간(붉은 두 줄)', 'startsAt': pt(410, strip_top), 'runsOffImageBottom': True, 'lengthInImageM': r1((H - strip_top) * S),
                      'centreline': strip, 'widthM': [min(s['widthM'] for s in strip), max(s['widthM'] for s in strip)],
                      'centreFromMainWallM': [r1(min(sum(s['fromMainWallM']) / 2 for s in strip)), r1(max(sum(s['fromMainWallM']) / 2 for s in strip))]},
    'mainSideStairs': {'what': '띠의 회차 공간 쪽 끝, 본관 북서 모서리 앞의 계단(짧은 실선 뭉치)', 'centre': pt(stA[0], stA[1]), 'extentM': [r1((stA[4] - stA[2]) * S), r1((stA[5] - stA[3]) * S)]},
    'crossing': {'what': '횡단보도(점선)', 'from': pt(dots[2], dots[1]), 'to': pt(dots[4], dots[1]), 'lengthM': r1((dots[4] - dots[2]) * S)},
    'bukakPassage': {'what': '북악관 쪽 통로(상자)', 'centre': pt(boxP[0], boxP[1]), 'corners': [pt(502, 398), pt(553, 361), pt(553, 401), pt(502, 433)], 'extentM': [r1((boxP[4] - boxP[2]) * S), r1((boxP[5] - boxP[3]) * S)]},
    'bukakStairs': {'what': '북악관 벽 앞의 계단(짧은 실선 뭉치)', 'centre': pt(stB[0], stB[1]), 'extentM': [r1((stB[4] - stB[2]) * S), r1((stB[5] - stB[3]) * S)]},
    'bukakWallStrip': {'what': '북악관 남쪽 벽을 따라 그은 붉은 선(벽 쪽 지하 공간)', 'from': pt(wall[0], wall[3]), 'to': pt(wall[0], wall[5]), 'lengthM': r1((wall[5] - wall[3]) * S), 'fromBukakWallM': r1((wall[0] - PX_BUK) * S)},
}
# 3) 대조
d = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])


def to_seg(p, a, b):
    t = max(0, min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)))
    return math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])), t


def road_vs_strip(rid):
    rows = []
    for p in ROADS[rid]['coordinates']:
        px, py = PIX(p[0], p[1]); rows.append({'xy': [r1(p[0]), r1(p[1])], 'z': round(p[2], 2), 'pixel': [round(px), round(py)], 'fromMainWallM': r1((px - PX_MAIN) * S), 'insideImage': bool(0 <= px < Wd and 0 <= py < H)})
    return rows


ENT = {e['name']: (e['x'], e['y']) for e in entrances(backend)}
ws0, ws1 = feat['bukakWallStrip']['from']['xy'], feat['bukakWallStrip']['to']['xy']
marks = {}
for n, p in {**{k: v for k, v in ENT.items() if k.startswith('북악관 입구') or k == '본관 입구(2)'}, 'B06 GS25 문(북악관 입구(4)를 서쪽 끝 벽 앞으로 옮긴 자리)': (201008.5, 557395.0),
             'E09 표지판 P1 입구 문턱': (201021.9, 557307.1), 'E09 P-UP 시작(V3 끝)': None, '951c157d 아래 끝': tuple(ROADS['951c157d']['coordinates'][-1][:2]), '8fde6a04 끝(북악관 B1 진입 계단 아래)': tuple(ROADS['8fde6a04']['coordinates'][-1][:2])}.items():
    if p is None: continue
    px, py = PIX(*p); dw, t = to_seg(p, ws0, ws1)
    marks[n] = {'xy': [r1(p[0]), r1(p[1])], 'pixel': [round(px), round(py)], 'insideImage': bool(0 <= px < Wd and 0 <= py < H), 'smap': ground(*p),
                'toMainSideStairsM': r1(d(p, feat['mainSideStairs']['centre']['xy'])), 'toBukakPassageM': r1(d(p, feat['bukakPassage']['centre']['xy'])), 'toBukakStairsM': r1(d(p, feat['bukakStairs']['centre']['xy'])),
                'toBukakWallStripM': r1(dw), 'alongWallStrip': 'beyond west end' if t == 0 else 'beyond east end' if t == 1 else 'beside'}
c951 = road_vs_strip('951c157d'); cw = feat['mainSideStrip']['centreFromMainWallM']
res = {'method': __doc__, 'legend': {'red': '지하 공간', 'dotted': '횡단보도', 'shortLines': '계단', 'box': '통로', 'grade': '확정(사용자)'},
       'fit': {'downAxis': [round(ex, 3), round(ey, 3)], 'rightAxis': [round(nx, 3), round(ny, 3)], 'wallGapM': r1(gap), 'pixelsBetweenRoofEdges': PX_BUK - PX_MAIN, 'scaleMPerPixel': round(S, 4),
               'anchor': {'pixel': [PX_MAIN, PY_CORNER], 'xy': list(MAIN_NW)}, 'assumedPlanErrorM': 2.0,
               'checks': {'bukakSEcornerPixel': [round(v) for v in PIX(*BUK_SE)], 'p1EntrancePixel': [round(v) for v in PIX(201021.9, 557307.1)], 'busLengthM': r1(88 * S),
                          'note': '북악관 남동 모서리는 화면에서 문예관 낮은 날개가 시작하는 y 705~745 쯤, P1 입구는 왼쪽 끝 둥근 화단. 버스 한 대 길이 약 88 픽셀'}},
       'features': feat,
       'compare': {'road951c157d': {'vertices': c951, 'stripCentreFromMainWallM': cw,
                                    'reading': f"951c157d 는 본관 북쪽 벽에서 {min(v['fromMainWallM'] for v in c951)}~{max(v['fromMainWallM'] for v in c951)} m 떨어져 지난다. 사용자가 그린 띠의 가운데는 벽에서 {cw[0]}~{cw[1]} m. 띠 안이 아니라 그 북쪽 옆(위 보행로 포장면 가운데)에 저장돼 있다"},
                   'roadC52095ad': road_vs_strip('c52095ad')[::7], 'road8fde6a04': road_vs_strip('8fde6a04'), 'markers': marks},
       'smapAlongStrip': {'stripCentre': [s['smap'] for s in strip], 'pavedPathSameStations': [ground(*W(470, s['pixel'][1])) for s in strip],
                          'note': '띠 자리의 S-MAP 면과, 같은 줄에서 포장 보행로 가운데(픽셀 x 470)의 면. 띠가 덮여 있으면 S-MAP 은 그 위 면만 보인다'}}
out.write_text(json.dumps(res, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print('fit', res['fit'])
for k, v in feat.items(): print(k, {a: b for a, b in v.items() if a not in ('centreline', 'what')})
for s in strip: print('  strip', s)
print(res['compare']['road951c157d']['reading']); print(c951); print(res['compare']['road8fde6a04'])
for k, v in marks.items(): print(k, v)
print(res['smapAlongStrip'])
