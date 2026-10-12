"""U12: 지금 지어진 배치(U11 + Q01 + U12)의 평면도. 북이 위, 1 화소 = 5 cm, 왼쪽 지하 1층·오른쪽 지하 2층. 자리를 맞춘 사진마다 카메라 표시. 볼트 u12 폴더에만 쓴다.   python plan.py"""
import json, pathlib
import numpy as np
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from shapely.geometry import shape
font_manager.fontManager.addfont('C:/Windows/Fonts/malgun.ttf'); plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; OUT = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/u12'); OUT.mkdir(exist_ok=True)
J = lambda p: json.loads(p.read_text(encoding='utf-8'))
M = J(HERE.parent / 'u02' / 'model.json'); RP = M['ramp']; OF = M['office']; H = M['heights']; ST = J(HERE.parent / 'u04' / 'stalls.json')
F = {f['properties']['id']: f for fn in ('u01-field-basement', 'u04-parking') for f in J(REPO / f'frontend/public/structures/{fn}.geojson')['features']}
V = {**J(HERE.parent / 'u11' / 'views.json'), **J(HERE / 'views.json')}
ISL = np.array(RP['islandCentre']); ht = np.array(RP['rowDirection']); hn = np.array(RP['towardHyein']); sp = lambda s, v: ISL + ht * s + hn * v
X0, X1, Y0, Y1, PX = 201130, 201190, 557236, 557308, 20   # 60 × 72 m, 1 m = 20 화소
def geom(ax, fid, hole=None, **kw):
    g = shape(F[fid]['geometry'])
    for q in (g.geoms if hasattr(g, 'geoms') else [g]):
        ax.fill(*q.exterior.xy, **kw)
        for r in (q.interiors if hole else ()): ax.fill(*r.xy, color=hole, zorder=kw.get('zorder', 1))
def fill(ax, ring, **kw): r = np.array(ring); ax.fill(r[:, 0], r[:, 1], **kw)
CAMS = [('23', '01-1인칭-지하2층-사진23', 'B2', '#1565c0'), ('26', '02-1인칭-경사로위-사진26', 'B2', '#1565c0'), ('22', '03-1인칭-지하1층-섬앞-사진22', 'B1', '#6a1b9a'), ('14·24', '04-1인칭-지하1층-사진24', 'B1', '#6a1b9a'),
        ('20·21', '05-1인칭-간판벽-사진20·21', 'B1', '#6a1b9a'), ('30', '30-1인칭-지하1층-현장사진30', 'B1', '#c2185b'), ('31', '31-1인칭-지하1층-현장사진31', 'B1', '#c2185b')]
def cams(ax, lv):
    for n, k, l, col in CAMS:
        if l != lv: continue
        w = V[k]['walk']; p = np.array(w['at'][:2]); hd = w['heading']; half = np.radians(min(w['fov'], 90) / 2)
        pts = [p] + [p + 11 * np.array([np.sin(hd + a), np.cos(hd + a)]) for a in np.linspace(-half, half, 14)]
        ax.fill(*np.array(pts).T, fc=col, alpha=0.10, ec=col, lw=0.8, zorder=7); ax.plot(*p, 'o', color=col, ms=15, zorder=8); ax.annotate(n, p, color='white', fontsize=7 if len(n) < 3 else 5.5, ha='center', va='center', zorder=9, weight='bold')
def plan(ax, lv):
    L = ST[lv]; a = L['aisle']; dark = lv == 'B1'
    fill(ax, a[0], color='#4a4c50' if dark else '#d9d3c4', zorder=1)
    for r in a[1:]: fill(ax, r, color='white', zorder=1)
    for b in L['blocks']:
        geom(ax, f"U04-STALLS-{lv}-{b['id']}", fc='#74777c' if dark else '#c4bdae', ec='none', zorder=2); geom(ax, f"U04-BAYLINE-{lv}-{b['id']}", hole='#74777c' if dark else '#c4bdae', color='#f3f1e6', zorder=3); geom(ax, f"U06-WHEELSTOP-{lv}-{b['id']}", color='#111111', zorder=4)
        c = np.array(b['polygon'][:-1]).mean(0); ax.text(c[0], c[1], f"{b['id']} · {b['stalls']}칸", fontsize=7, ha='center', va='center', zorder=5, clip_on=True, color='white' if dark else '#333333', rotation=90 - RP['rowAzimuthDeg'], bbox={'fc': '#00000055' if dark else '#ffffff88', 'ec': 'none', 'pad': 1})
    for k in F:
        if k.startswith('U02-COLUMN-') and (k.endswith('-B1') if dark else k[-1].isdigit()): geom(ax, k, fc='#4f6f95' if dark else '#f4f2ea', ec='#e2b62c' if dark else '#555555', lw=0.8, zorder=6)
    if dark:
        geom(ax, 'U07-THROUGH-LANE-FLOOR', color='#2c2e33', zorder=1.5)
        fill(ax, OF['ring'], fc='#b3a996', ec='#465068', lw=3, zorder=3); c = np.array(OF['ring'][:3]).mean(0); ax.text(c[0] - 1, c[1] + 2, '주차관리센터\n화장실·통로\n(막힌 구역)', fontsize=8, ha='center', color='#333333', zorder=4)
        fill(ax, RP['opening'], fc='#fff3c4', ec='#c0392b', lw=1.2, zorder=3, hatch='//')
        for k, c_ in (('U02-ISLAND-WALL', '#6f8fa3'), ('U06-BAND-WALL', '#1d2f4f'), ('U07-RAMP-OUTERWALL', '#5f8a66'), ('U06-GUIDE-LINE', '#e3b505'), ('U12-AISLE-ARROW', '#ffffff'), ('U12-B2-SIGN', '#ffe14d'), ('U12-B2-MIRROR', '#b0672a'), ('U12-BANNER', '#ffffff'), ('U12-MURAL-WALL', '#d9c7e8'), ('U07-ISLAND-PIER', '#4f6f95'), ('U11-BAND-JAMB', '#dfe3e3')):
            geom(ax, k, fc=c_, ec='#222222' if k.startswith('U12') else 'none', lw=0.6, zorder=6)
        for k in F:
            if k.startswith('U10-') and 'WALL' not in k: geom(ax, k, color=F[k]['properties']['color'], zorder=6)
        an = lambda t, p, d: ax.annotate(t, p, np.array(p) + d, fontsize=7.5, arrowprops={'arrowstyle': '->', 'lw': 0.8}, zorder=10, bbox={'fc': '#ffffffcc', 'ec': 'none', 'pad': 1})
        an('계단 어귀(은주관·운동장)\n왼쪽으로 은주관·주차관리센터 간판', M['points']['DOOR']['xy'], [-19, 9]); an('낮은 벽(밑으로 지하 2층)', sp(RP['openStraightM'], -6.0), [-17, 5]); an('섬(낮은 벽 1.1 m)', ISL - ht * 1.5, [-3, -11])
        an('초록 벽(경사로 바깥 벽)과 현수막', sp(1.5, -RP['outerRadiusM'] + 0.3), [-15, -1]); an('"B2 ▷" 표지·반사경\n(자리 추정)', sp(-RP['outerRadiusM'] + 0.3, 0), [-10, -7]); an('무늬 벽(추정)', sp(OF['hypotenuseS'][1] - 2, OF['hypotenuseV']), [-14, 3])
        an('바닥 화살표(확정: 사진 30·31)\n이 통로는 남서(경사로 쪽)로 진행', sp(22.5, 5.0), [5, 9]); an('사진 18 의 방향 표지(자리 추정)', np.array(shape(F['U10-DIRECTION-SIGN']['geometry']).centroid.coords[0]), [4, 4])
    else:
        fill(ax, RP['footprint'], fc='#bdb7a8', ec='#555555', lw=1, zorder=3)
        for k in ('U11-RAMP-INNERWALL', 'U11-RAMP-INNERWALL-UNDER'): geom(ax, k, color='#26405f', zorder=5)
        for k in ('U11-RAMP-OUTERWALL-UNDER', 'U07-RAMP-OUTERWALL'): geom(ax, k, color='#2aa7b8', zorder=5)
        for k in ('U11-TOE-COLUMN-IN', 'U11-TOE-COLUMN-OUT'): geom(ax, k, fc='white', ec='black', lw=0.8, zorder=6)
        geom(ax, 'U08-SPEED-BUMP', color='#d8b000', zorder=5)
    path = np.array([q['xy'] for q in RP['path']]); ax.plot(path[:, 0], path[:, 1], color='#d35400', lw=2, zorder=6); ax.annotate('', path[-1], path[-3], arrowprops={'arrowstyle': '-|>', 'color': '#d35400', 'lw': 2}, zorder=6)
    ax.text(*(path[0] + [-10, -3]), f"마루 {H['b1Floor']} m", fontsize=8, color='#d35400', zorder=9); ax.text(*(path[-1] + [1.5, 1.2]), f"발치 {H['b2Floor']} m", fontsize=8, color='#d35400', zorder=9)
    cams(ax, lv)
    ax.set_aspect('equal'); ax.set_xlim(X0, X1); ax.set_ylim(Y0, Y1); ax.set_xticks([]); ax.set_yticks([])
    ax.plot([X0 + 2, X0 + 12], [Y0 + 2, Y0 + 2], 'k-', lw=3); ax.text(X0 + 7, Y0 + 2.8, '10 m', fontsize=8, ha='center'); ax.annotate('북', (X1 - 3, Y1 - 2), (X1 - 3, Y1 - 8), fontsize=9, ha='center', arrowprops={'arrowstyle': '-|>'})
W, Hh, TOP, GAP = (X1 - X0) * PX, (Y1 - Y0) * PX, 90, 20
fig = plt.figure(figsize=((2 * W + GAP) / 100, (Hh + TOP) / 100), dpi=100)
for i, (lv, t) in enumerate((('B1', f"지하 1층 {H['b1Floor']} m — 빗금 = 바닥이 트인 곳(아래로 경사로), 주황 = 경사로 가운데(화살표 = 내려가는 쪽), 검은 토막 = 차 막이"), ('B2', f"지하 2층 {H['b2Floor']} m (배치 추정) — 경사로 {RP['lengthM']} m 에 {RP['dropM']} m, {RP['gradePct']} %"))):
    ax = fig.add_axes([i * (W + GAP) / (2 * W + GAP), 0, W / (2 * W + GAP), Hh / (Hh + TOP)]); plan(ax, lv); fig.text((i * (W + GAP) + W / 2) / (2 * W + GAP), (Hh + 12) / (Hh + TOP), t, fontsize=10, ha='center')
fig.text(0.5, (Hh + 50) / (Hh + TOP), 'U12 지금 지어진 배치(U11 + Q01 + U12). 북이 위, 1 화소 = 5 cm. 동그라미·부채 = 사진을 찍은 자리와 방향: 분홍 = 현장 사진 30·31(±3 m, ±5도), 보라 = 사진 22·14(24)·20·21, 파랑 = 사진 23·26(지하 2층)', fontsize=11, ha='center')
fig.savefig(OUT / '평면-현재.png', dpi=100); print('saved', fig.get_size_inches() * 100)
