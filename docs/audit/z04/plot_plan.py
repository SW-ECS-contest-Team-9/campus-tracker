"""Z04: 구조물 파일의 기단·상자를 평면에 그린다(자리·높이 확인).  python plot_plan.py -> <볼트>/z04/평면-기단-북.png, 평면-기단-남.png"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
STR = REPO / 'frontend/public/structures'; B = building_polys()
fs = [(fn.stem, f) for fn in sorted(STR.glob('*.geojson')) for f in json.loads(fn.read_text(encoding='utf-8'))['features']]
def Polygon_area(c): return 0.5 * abs(np.dot(c[:-1, 0], c[1:, 1]) - np.dot(c[1:, 0], c[:-1, 1]))
cm = plt.get_cmap('terrain')
for nm, (xa, xb, ya, yb) in {'북': (200984, 201267, 557255, 557420), '남': (200984, 201267, 557090, 557262)}.items():
    fig, ax = plt.subplots(figsize=((xb - xa) / 11, (yb - ya) / 11))
    for stem, f in fs:
        p = f['properties']; c = np.array(f['geometry']['coordinates'][0]); new = stem.startswith('z04')
        if p['kind'] == 'platform':
            top = p.get('topM'); pr = p.get('topProfile'); zc = top if top is not None else np.mean([q[1] for q in pr['points']])
            ax.fill(c[:, 0], c[:, 1], color=cm((zc - 95) / 65), alpha=.85 if new else .35, ec='k' if new else 'gray', lw=.5, hatch=None if top is not None else '///')
            if new and Polygon_area(c) > 40:
                t = (p['id'].split('-')[-1] + '\n' + (f'{top}' if top is not None else '~'.join(f'{q[1]:.0f}' for q in pr['points'])))
                ax.text(c[:-1, 0].mean(), c[:-1, 1].mean(), t, fontsize=5.5, ha='center', va='center', clip_on=True)
        elif p['kind'] == 'extrude' and new: ax.plot(c[:, 0], c[:, 1], 'r-', lw=.6)
    for name, poly in B.items(): ax.plot(*poly.exterior.xy, 'b-', lw=1); ax.text(poly.centroid.x, poly.centroid.y, name, color='b', fontsize=9, ha='center', clip_on=True)
    ax.set_xlim(xa, xb); ax.set_ylim(ya, yb); ax.set_aspect('equal'); ax.set_xticks(np.arange(xa, xb, 20)); ax.set_yticks(np.arange(ya, yb, 20)); ax.grid(lw=.3, alpha=.4); ax.tick_params(labelsize=6)
    ax.set_title(f'Z04 기단 평면({nm}): 진한 색 = Z04(빗금 = 경사면), 옅은 색 = G02·Z02·Z03, 빨강 = Z04 상자, 파랑 = 건물 원천 외곽. 글자 = 기단 번호와 윗면 높이', fontsize=8)
    plt.savefig(Z04 / f'평면-기단-{nm}.png', dpi=62, bbox_inches='tight'); plt.close()
