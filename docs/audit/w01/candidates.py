"""W01: 후보 평면도(같은 축척, 북쪽이 위). 그림은 볼트에만 쓴다.   python -X utf8 candidates.py
 1) 서문 자리 셋: 가 = 사용자 표시(지금 모델), 나 = 거리뷰 두 시선의 교차·학교 표지 쪽, 다 = S-MAP 벽 면(옛 모델)
 2) 회전교차로 가운데 섬 셋(만들지 않았다: 자리의 근거가 거리뷰 27 지점뿐)"""
import json, math, pathlib
import numpy as np
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from shapely.geometry import shape, Polygon, Point
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; STR = REPO / 'frontend/public/structures'
OUT = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009\w01')
F = {f['properties']['id']: f for fn in STR.glob('*.geojson') for f in json.loads(fn.read_text(encoding='utf-8'))['features']}
SC = {b['id']: Polygon(b['ring']) for b in json.loads((REPO / 'docs/audit/z04/scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']}
def base(ax, xlim, ylim):
    for k, col in (('Z05-PLATFORM-WEST-STREET', '#2b2d30'), ('Z05-PLATFORM-GATE-ROUNDABOUT', '#2b2d30'), ('Z05-PLATFORM-GATE-STREET-SW', '#2b2d30'), ('Z05-PLATFORM-WEST-GATE-BANK', '#8fae7a'), ('Z05-PLATFORM-WEST-WALLTOP-NORTH', '#c8c4ba'), ('Z05-PLATFORM-WEST-WALLTOP-PLANTER', '#8fae7a')):
        ax.fill(*shape(F[k]['geometry']).exterior.xy, color=col, alpha=.55, lw=0)
    for k, g in SC.items():
        if g.bounds[0] < xlim[1] and g.bounds[2] > xlim[0] and g.bounds[1] < ylim[1] and g.bounds[3] > ylim[0]: ax.fill(*g.exterior.xy, color='#b9b4a8', ec='k', lw=.6)
    for k in ('W01-WESTWING-BODY-UP', 'Z11-YUDAM-STREET-PLINTH'): ax.fill(*shape(F[k]['geometry']).exterior.xy, color='#5d5450')
    ax.set_xlim(*xlim); ax.set_ylim(*ylim); ax.set_aspect('equal'); ax.grid(lw=.3); ax.tick_params(labelsize=7)
def gate(ax, c, deg, col):
    u = np.array([math.sin(math.radians(deg - 90)), math.cos(math.radians(deg - 90))]); n = np.array([math.sin(math.radians(deg)), math.cos(math.radians(deg))]); c = np.array(c)
    a, b = c - u * 6.5, c + u * 6.5; ax.plot([a[0], b[0]], [a[1], b[1]], color=col, lw=5); ax.annotate('', xy=c + n * 7, xytext=c, arrowprops=dict(arrowstyle='->', color=col, lw=2))
fig, axs = plt.subplots(1, 3, figsize=(16, 7.4)); XL, YL = (200950, 201000), (557370, 557430)
EVD = [((200976.8, 557408.2), 'r*', '사용자 표시 ±6 m'), ((200972, 557401), 'bo', '거리뷰 두 시선 교차(색인)'), ((200967.8, 557401.5), 'g^', '학교 표지'), ((200969.0, 557402.8), 'g^', None), ((200983.7, 557399.5), 'ks', 'S-MAP 벽 면(E09)')]
for ax, (nm, c, deg, note) in zip(axs, (('가 (지금 모델)', (200976.8, 557408.2), 210, '사용자 표시 자리, 남남서를 봄'), ('나', (200971.0, 557404.5), 225, '거리뷰 교차·학교 표지 쪽으로 6.9 m, 남서를 봄'), ('다 (옛 모델)', (200986.9, 557399.1), 262, 'S-MAP 벽 면, 서쪽을 봄'))):
    base(ax, XL, YL); gate(ax, c, deg, '#d2232a')
    for p, m, lb in EVD: ax.plot(*p, m, ms=9, label=lb)
    ax.add_patch(plt.Circle((200976.8, 557408.2), 6, fill=False, ec='r', ls='--', lw=.8)); ax.set_title(f'서문 후보 {nm}: {note}\n문 가운데 ({c[0]:.1f}, {c[1]:.1f}), 폭 13 m', fontsize=10)
axs[0].legend(fontsize=7, loc='lower left'); fig.suptitle('W01 서문 자리 후보 (붉은 굵은 선 = 문 면, 화살표 = 문이 보는 쪽. 짙은 띠 = 유담관 서쪽 날개, 검정 = 공도 기단)', fontsize=11)
fig.savefig(OUT / '후보-w01-서문-자리.png', dpi=110, bbox_inches='tight'); plt.close(fig)
fig, axs = plt.subplots(1, 3, figsize=(16, 6.6)); XL, YL = (200968, 201022), (557212, 557262)
SVP = {'25': (200970.0, 557217.5), '26': (200981.2, 557236.7), '27': (200994.3, 557236.9), '28': (200994.6, 557265.8), '36': (201018.0, 557230.4)}
for ax, (nm, c, note) in zip(axs, (('가', (200991.0, 557239.5), '거리뷰 27 지점의 서북서 3.5 m(27 화면: 섬이 왼쪽 발치)'), ('나', (200994.0, 557243.5), '세 갈래 길 축이 만나는 곳(기단의 가운데)'), ('다', (200988.5, 557235.0), '거리뷰 26·27 지점 사이'))):
    base(ax, XL, YL); ax.add_patch(plt.Circle(c, 3.0, color='#7f9a6b', ec='w', lw=1.5)); ax.plot(*c, 'k+')
    for k, p in SVP.items(): ax.plot(*p, 'bo', ms=5); ax.annotate(k, p, fontsize=8, color='b', xytext=(3, 3), textcoords='offset points')
    ax.set_title(f'회전교차로 섬 후보 {nm}: {note}\n가운데 ({c[0]:.1f}, {c[1]:.1f}), 지름 6 m(추정)', fontsize=10)
fig.suptitle('W01 회전교차로 가운데 섬 후보 (만들지 않음. 파란 점 = 거리뷰 지점: 길 방향 오차 ±8 m)', fontsize=11)
fig.savefig(OUT / '후보-w01-회전교차로-섬.png', dpi=110, bbox_inches='tight'); print('ok')
