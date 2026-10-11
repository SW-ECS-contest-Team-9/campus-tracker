"""U11: 고른 배치의 평면도(북이 위)와 학교 지하도 지도 위에 겹친 그림을 볼트 u11 폴더에 그린다(사용자·블로그 그림은 저장소에 넣지 않는다).   python plan.py"""
import json, pathlib
import numpy as np
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from PIL import Image
from shapely.geometry import shape
font_manager.fontManager.addfont('C:/Windows/Fonts/malgun.ttf'); plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u11'; OUT.mkdir(exist_ok=True)
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); RP = M['ramp']; OF = M['office']; H = M['heights']
ST = json.loads((HERE.parent / 'u04' / 'stalls.json').read_text(encoding='utf-8')); V = json.loads((HERE / 'views.json').read_text(encoding='utf-8'))
GEO = json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8')); MX = np.array(GEO['matrix'])
CR = json.loads((HERE.parent / 'u07' / 'crescent.json').read_text(encoding='utf-8'))
F = {f['properties']['id']: f for f in json.loads((REPO / 'frontend/public/structures/u01-field-basement.geojson').read_text(encoding='utf-8'))['features']}
ISL = np.array(RP['islandCentre']); ht = np.array(RP['rowDirection']); hn = np.array(RP['towardHyein']); sp = lambda s, v: ISL + ht * s + hn * v
def fill(ax, ring, **kw): r = np.array(ring); ax.fill(r[:, 0], r[:, 1], **kw)
def geom(ax, fid, **kw):
    g = shape(F[fid]['geometry'])
    for q in (g.geoms if hasattr(g, 'geoms') else [g]): x, y = q.exterior.xy; ax.fill(x, y, **kw)
CAMS = [('23', '01-1인칭-지하2층-사진23', 'B2'), ('26', '02-1인칭-경사로위-사진26', 'B2'), ('22', '03-1인칭-지하1층-섬앞-사진22', 'B1'), ('24', '04-1인칭-지하1층-사진24', 'B1')]
def cams(ax, lv):
    for n, k, l in CAMS:
        w = V[k]['walk']; p = np.array(w['at'][:2]); hd = w['heading']; half = np.radians(w['fov'] / 2); col = '#c2185b' if l == lv else '#bbbbbb'
        pts = [p] + [p + 9 * np.array([np.sin(hd + a), np.cos(hd + a)]) for a in np.linspace(-half, half, 12)]
        ax.fill(*np.array(pts).T, color=col, alpha=0.13 if l == lv else 0.06, zorder=6); ax.plot(*p, 'o', color=col, ms=9, zorder=7); ax.annotate(n, p, color='white', fontsize=6.5, ha='center', va='center', zorder=8, weight='bold')
def plan(ax, lv):
    L = ST[lv]; a = L['aisle']
    fill(ax, a[0], color='#e9e9e6', zorder=1)
    for r in a[1:]: fill(ax, r, color='white', zorder=1)
    for b in L['blocks']: fill(ax, b['polygon'], fc='#b9c6d3', ec='#5b6b7c', lw=0.8, zorder=2); c = np.array(b['polygon'][:-1]).mean(0); ax.text(c[0], c[1], f"{b['id']}\n{b['stalls']}", fontsize=6, ha='center', va='center', zorder=3, clip_on=True)
    if lv == 'B1':
        fill(ax, OF['ring'], fc='#8d9299', ec='#33373c', lw=1.5, zorder=3); c = np.array(OF['ring'][:3]).mean(0); ax.text(c[0], c[1] + 1, '주차관리센터\n화장실·통로', fontsize=6.5, ha='center', color='white', zorder=4)
        fill(ax, RP['opening'], fc='#fff3c4', ec='#c0392b', lw=1.2, zorder=3, hatch='//')
        geom(ax, 'U02-ISLAND-WALL', color='#6f8fa3', zorder=5); geom(ax, 'U06-BAND-WALL', color='#1d2f4f', zorder=5); geom(ax, 'U07-RAMP-OUTERWALL', color='#2aa7b8', zorder=5); geom(ax, 'U06-GUIDE-LINE', color='#e3b505', zorder=4)
        for k in F:
            if k.startswith('U10-') and 'DIRECTION' not in k: geom(ax, k, color=F[k]['properties']['color'], zorder=6)
        d = np.array(M['points']['DOOR']['xy']); ax.annotate('계단 어귀\n(은주관·운동장)', d, d + [-13, 6], fontsize=6.5, arrowprops={'arrowstyle': '->', 'lw': 0.7}, zorder=9)
        b = sp(RP['openStraightM'], -6.2); ax.annotate('낮은 벽', b, b + [-12, 3], fontsize=6.5, arrowprops={'arrowstyle': '->', 'lw': 0.7}, zorder=9)
        ax.annotate('섬(S04 남서 끝)', ISL - ht * 1.5, ISL + [6, -9], fontsize=6.5, arrowprops={'arrowstyle': '->', 'lw': 0.7}, zorder=9)
    else:
        fill(ax, RP['footprint'], fc='#cfcabd', ec='#555', lw=1, zorder=3)
        for k in ('U11-RAMP-INNERWALL', 'U11-RAMP-INNERWALL-UNDER'): geom(ax, k, color='#26405f', zorder=5)
        for k in ('U11-RAMP-OUTERWALL-UNDER', 'U07-RAMP-OUTERWALL'): geom(ax, k, color='#2aa7b8', zorder=5)
        for k in ('U11-TOE-COLUMN-IN', 'U11-TOE-COLUMN-OUT'): geom(ax, k, fc='white', ec='black', lw=0.8, zorder=6)
        geom(ax, 'U08-SPEED-BUMP', color='#d8b000', zorder=5)
    path = np.array([q['xy'] for q in RP['path']]); ax.plot(path[:, 0], path[:, 1], color='#d35400', lw=1.6, zorder=6)
    ax.annotate('', path[-1], path[-3], arrowprops={'arrowstyle': '-|>', 'color': '#d35400', 'lw': 1.6}, zorder=6)
    ax.text(*(path[0] + [-9.5, -2.5]), f"마루 {H['b1Floor']} m", fontsize=7, color='#d35400', zorder=9); ax.text(*(path[-1] + [1.5, 1.0]), f"발치 {H['b2Floor']} m", fontsize=7, color='#d35400', zorder=9)
    cams(ax, lv)
    ax.set_aspect('equal'); ax.set_xlim(201132, 201186); ax.set_ylim(557236, 557306); ax.set_xticks([]); ax.set_yticks([])
    ax.plot([201134, 201144], [557238, 557238], 'k-', lw=2); ax.text(201139, 557238.8, '10 m', fontsize=7, ha='center'); ax.annotate('북', (201183, 557303), (201183, 557297), fontsize=8, ha='center', arrowprops={'arrowstyle': '-|>'})
fig, axs = plt.subplots(1, 2, figsize=(15.4, 10.6))
plan(axs[0], 'B1'); axs[0].set_title(f"지하 1층 {H['b1Floor']} m — 빗금 = 바닥이 트인 곳(아래로 경사로), 주황 선 = 경사로 가운데(화살표 = 내려가는 쪽)", fontsize=9)
plan(axs[1], 'B2'); axs[1].set_title(f"지하 2층 {H['b2Floor']} m — 경사로 {RP['lengthM']} m 에 {RP['dropM']} m, {RP['gradePct']} % (곧은 {RP['straightM']} + 굽은 {RP['arcM']} m), 폭 {RP['widthM']} m", fontsize=9)
fig.suptitle('U11 고른 배치 평면도 (북이 위, 같은 틀). 분홍 점·부채 = 사진 23·26·22·24 를 찍은 자리와 방향(추정). 묶음 이름 아래 숫자 = 칸 수', fontsize=10)
fig.tight_layout(); fig.savefig(OUT / '평면-u11-01-고른배치-지하1층·지하2층.png', dpi=130); plt.close(fig)

# 학교 지하도 지도 위에
im = Image.open(A / '사용자-운동장지하-20261012' / '블로그-사진' / '블로그-03.jpg').convert('RGB'); sc = 816 / 800   # 좌표 맞춤은 800 화소본
Ainv = np.linalg.inv(np.vstack([MX.T, [0, 0, 1]]))
def px(p): q = Ainv @ np.r_[p, 1.0]; return q[:2] * sc
fig, ax = plt.subplots(figsize=(11, 11)); ax.imshow(im)
def over(ring, **kw): r = np.array([px(p) for p in ring]); ax.plot(r[:, 0], r[:, 1], **kw)
for b in ST['B1']['blocks']: over(b['polygon'], color='#ffd400', lw=0.9)
over(RP['opening'], color='#ff3b30', lw=1.6); over(OF['ring'], color='#00e5ff', lw=1.4); over(RP['island']['polygon'] + [RP['island']['polygon'][0]], color='#7CFC00', lw=1.2); over(CR['outline'] + [CR['outline'][0]], color='white', lw=0.8, ls=':')
over([q['xy'] for q in RP['path']], color='#ff9500', lw=1.6); d = px(M['points']['DOOR']['xy']); ax.plot(*d, 'o', color='#00e5ff', ms=5)
ax.set_xlim(360, 500); ax.set_ylim(450, 300); ax.axis('off')
ax.set_title(f"학교 지하도 지도 위에: 노랑 = 주차 칸 묶음, 빨강 = 바닥이 트인 곳, 주황 = 경사로 가운데, 연두 = 섬, 하늘 = 세모 구역과 계단 어귀, 흰 점선 = 지도에서 읽은 부채꼴\n부채꼴과 트인 곳의 겹침 {RP['crescentInOpeningM2']}/{RP['crescentM2']} ㎡ (IoU {RP['crescentIoU']}), 낮은 벽 양 끝 ~ 부채꼴 북쪽 끝 {RP['bandEndsToCrescentNorthEndM']} m, 좌표 맞춤 잔차 RMS {M['georefRmsM']} m", fontsize=9)
fig.tight_layout(); fig.savefig(OUT / '평면-u11-02-학교지도-위에.png', dpi=140); print('saved')
