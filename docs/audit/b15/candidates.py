"""B15 은주1관 굽은 돌계단: 지금 모델 평면과 후보 셋을 같은 축척·북이 위인 도면으로(적용하지 않는 제안). DB·네트워크 접근 없음.   python candidates.py <n02 state 파일>
쓰는 파일: 볼트 3d-map-audit-20261009/b15/후보-b15-은주1관-굽은돌계단.png"""
import json, glob, math, pathlib, sys
import numpy as np
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from matplotlib import font_manager
from shapely.geometry import shape, box, Polygon, LineString, Point
for f in ('Malgun Gothic', 'NanumGothic'):
    if any(f == x.name for x in font_manager.fontManager.ttflist): plt.rcParams['font.family'] = f; break
plt.rcParams['axes.unicode_minus'] = False
REPO = pathlib.Path(__file__).parents[3]; OUT = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/b15')
BB = (201092, 557236, 201128, 557282); bb = box(*BB)
roofs = json.loads((REPO / 'backend/data/scene/overrides/building-roofs.json').read_text(encoding='utf-8'))
st = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
def top(p, g):
    if p.get('topM') is not None: return f"{p['topM']}"
    tp = p.get('topProfile'); return f"{tp['points'][0][1]}→{tp['points'][-1][1]}" if tp else ''
def base(ax):
    for f in sorted(glob.glob(str(REPO / 'frontend/public/structures/*.geojson'))):
        if 'b15-' in f: continue
        for x in json.loads(pathlib.Path(f).read_text(encoding='utf-8'))['features']:
            g = shape(x['geometry']); p = x['properties']
            if not g.intersects(bb) or g.geom_type != 'Polygon': continue
            if p['kind'] == 'platform':
                ax.fill(*g.exterior.xy, color={'planting': '#cfe3c4', 'asphalt': '#9a9a9a'}.get(p.get('material'), '#e9e4d8'), ec='#8a8578', lw=0.6, zorder=1)
                c = g.buffer(0).intersection(bb).representative_point(); ax.text(c.x, c.y, top(p, g), fontsize=6, color='#5b5548', ha='center', zorder=3)
            elif p['kind'] == 'extrude' and p.get('type') != 'tree': ax.fill(*g.exterior.xy, color='#b7ae9c', ec='#6f6a5f', lw=0.3, zorder=2)
    for e in roofs['parts']:
        for p in e['parts']:
            g = Polygon(p['polygon'][0])
            if g.intersects(bb): ax.fill(*g.exterior.xy, color='#d9c9b8', ec='k', lw=1.4, zorder=4)
    for r in st['roads']:
        l = LineString([c[:2] for c in r['coordinates']])
        if l.intersects(bb): ax.plot(*l.xy, color='#c2185b', lw=1.0, zorder=5)
    ax.text(201123.5, 557270, '은주1관', fontsize=9, zorder=6); ax.text(201112, 557280.3, '한림관 원통', fontsize=8, zorder=6); ax.text(201119.2, 557251.2, '아치 문 둘\n131.3', fontsize=6.5, ha='left', zorder=6)
    ax.plot([201095, 201105], [557238, 557238], 'k', lw=2); ax.text(201100, 557238.6, '10 m', ha='center', fontsize=7); ax.annotate('북', (201094, 557280), (201094, 557276), arrowprops={'arrowstyle': '->'}, ha='center', fontsize=8)
    ax.set_xlim(BB[0], BB[2]); ax.set_ylim(BB[1], BB[3]); ax.set_aspect('equal'); ax.set_xticks([]); ax.set_yticks([])
D0 = np.array([201119.45, 557252.55])                           # 돌출부 벽 가운데(아치 문 둘 사이)
def arc(c, r, a0, a1, n=24): return [(c[0] + r * math.cos(math.radians(a0 + (a1 - a0) * k / n)), c[1] + r * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]
def stair(ax, pts, w=2.2, label=None):
    l = LineString(pts); ax.fill(*l.buffer(w / 2, cap_style=2).exterior.xy, color='#f3efe6', ec='#444', lw=0.9, zorder=7)
    for k in range(1, int(l.length / 0.6)):
        q = l.interpolate(k * 0.6); q2 = l.interpolate(k * 0.6 + 0.05); t = np.array([q2.x - q.x, q2.y - q.y]); t /= np.linalg.norm(t) or 1; n = np.array([-t[1], t[0]]) * w / 2
        ax.plot([q.x - n[0], q.x + n[0]], [q.y - n[1], q.y + n[1]], color='#888', lw=0.35, zorder=8)
    if label: q = l.interpolate(0.5, normalized=True); ax.text(q.x, q.y, label, fontsize=6, zorder=9, ha='center', bbox={'fc': 'white', 'ec': 'none', 'pad': 0.5, 'alpha': 0.8})
def disc(ax, c, r, text, col='#f3efe6'): ax.fill(*Point(c).buffer(r).exterior.xy, color=col, ec='#444', lw=0.9, zorder=7); ax.text(c[0], c[1], text, fontsize=6, ha='center', va='center', zorder=9)
def terrace(ax):
    g = Polygon(arc(D0 + (0.2, 0), 5.2, 100, 260) ); ax.fill(*g.exterior.xy, color='#f3efe6', ec='#444', lw=0.9, zorder=6); ax.text(D0[0] - 2.6, D0[1], '테라스\n131.3', fontsize=6, ha='center', va='center', zorder=9)
    for dy in (2.6, -2.6): ax.fill(*Point(D0[0] - 3.9, D0[1] + dy).buffer(0.8).exterior.xy, color='#9cc08a', ec='#444', lw=0.6, zorder=8)
fig, axs = plt.subplots(1, 4, figsize=(22, 7.6))
base(axs[0]); axs[0].set_title('지금 모델: 굽은 계단·테라스 없음\n(건물 옆 131.8 m 띠가 벽면 하나로 길 128 m 에 닿음)', fontsize=9)
ax = axs[1]; base(ax); terrace(ax)
M = D0 + (-7.6, 3.2); disc(ax, M, 1.9, '둥근 참\n129.6')
stair(ax, [tuple(M + (1.5, 1.0)), *arc(D0 + (-4.4, 5.6), 2.6, 215, 300, 8)][:1] + [tuple(D0 + (-5.0, 3.6))], 2.0, '윗갈래 북')
stair(ax, [tuple(M + (1.3, -1.4)), tuple(D0 + (-5.2, -1.0))], 2.0, '윗갈래 남')
stair(ax, [tuple(M + (-1.2, 1.5)), *arc(M + (-1.4, 5.6), 4.2, -80, -150, 10)], 2.2, '아랫단 127.7→129.6')
ax.set_title('후보 A: S자 한 줄 + 둥근 참에서 두 갈래\n발치는 북서(바위 정원·아치 다리 쪽 길가). 사진 07·08·10 에 가장 가까움(추정)', fontsize=9)
ax = axs[2]; base(ax); terrace(ax)
M = D0 + (-7.4, 0.0); disc(ax, M, 1.9, '둥근 참\n129.6')
stair(ax, arc(D0 + (-5.0, 0), 3.4, 150, 100, 8)[::-1][:1] + arc(D0 + (-5.3, 0.3), 3.3, 110, 165, 8), 1.9, '북 갈래'); stair(ax, arc(D0 + (-5.3, -0.3), 3.3, 250, 195, 8), 1.9, '남 갈래')
stair(ax, [tuple(M + (-1.8, 0)), tuple(M + (-5.6, 0))], 2.6, '곧은 아랫단 128.3→129.6')
ax.set_title('후보 B: 문 정면의 곧은 아랫단 + 말굽꼴 두 갈래\n(좌우 대칭. 사진의 S자와는 덜 맞음)', fontsize=9)
ax = axs[3]; base(ax); terrace(ax)
stair(ax, [tuple(D0 + (-4.6, 3.4)), *arc(D0 + (-7.4, 6.6), 3.6, -50, -170, 12), *arc(D0 + (-13.4, 8.4), 2.8, 20, 100, 6)], 2.2, 'S자 한 줄 127.2→131.3')
stair(ax, [tuple(D0 + (-3.2, -4.4)), tuple(D0 + (-2.2, -15.0))], 1.8, '남쪽 곧은 계단·보도')
ax.set_title('후보 C: 북서로 길게 도는 S자 한 줄(참 없음)\n+ 건물 벽을 따라 남쪽으로 내려가는 곧은 갈래(사진 10 오른쪽 긴 보도)', fontsize=9)
fig.suptitle('B15 제안(적용 안 함): 은주1관 아치 문 앞 테라스와 굽은 돌계단 — 같은 축척, 북이 위. 분홍 선 = 지금 길, 숫자 = 기단 윗면 높이(m). 치수는 전부 추정', fontsize=11)
fig.tight_layout(); fig.savefig(OUT / '후보-b15-은주1관-굽은돌계단.png', dpi=120); print('saved')
