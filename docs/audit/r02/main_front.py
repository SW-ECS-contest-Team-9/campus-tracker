"""R02: 본관 남쪽 앞(섬·계단) S-MAP 1 m 메시 높이·기울기 + 모델 상자 외곽 + 거리뷰 지점. python -X utf8 main_front.py"""
import json, re, pathlib, numpy as np
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from shapely.geometry import shape
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
A = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009'); OUT = A / 'r02'
REPO = pathlib.Path(__file__).parents[3]
L = (A / 'z04' / 'smap-mesh-z04-1m-w2.txt').read_text(encoding='utf-8').splitlines()
m = re.search(r'x=([\d.]+)\+1\*i \(i<(\d+)\), y=([\d.]+)\+1\*j \(j<(\d+)\)', L[0]); x0, nx, y0, ny = float(m[1]), int(m[2]), float(m[3]), int(m[4])
Z = np.full((ny, nx), np.nan)
for ln in L[1:]:
    if ln.startswith('#'): continue
    j, z, *_ = ln.split('|'); v = np.array(z.split(','), float) / 100; v[v < 0] = np.nan; Z[int(j)] = v
X = x0 + np.arange(nx); Y = y0 + np.arange(ny)
gy, gx = np.gradient(Z); sl = np.hypot(gx, gy)
CAM = {'04': (201039.2, 557298.6), '05': (201046.8, 557291.9), '06': (201066.7, 557280.4), '07': (201082.3, 557266.4)}
def boxes(pref):
    for f in (REPO / 'frontend' / 'public' / 'structures').glob('*.geojson'):
        for ft in json.loads(f.read_text(encoding='utf-8'))['features']:
            p = ft['properties']
            if p.get('type') in ('stair_step', 'planter') and any(p['id'].startswith(q) for q in pref): yield p, shape(ft['geometry'])
def base(ax, title):
    ax.pcolormesh(X, Y, Z, cmap='terrain', vmin=118, vmax=132, shading='auto', alpha=0.85)
    ax.contour(X, Y, sl, [0.35], colors='k', linewidths=0.5)
    for p, g in boxes(('P01-BONGWAN-SOUTH', 'Z05-HANLIM-FRONT')):
        x, y = g.exterior.xy; ax.fill(x, y, fc='red' if p['type'] == 'stair_step' else 'none', ec='red' if p['type'] == 'stair_step' else 'gray', lw=0.6, alpha=0.6)
    for k, (cx, cy) in CAM.items(): ax.plot(cx, cy, 'b^'); ax.text(cx + 0.5, cy + 0.5, '거리뷰 ' + k, color='b', fontsize=8)
    ax.set_xlim(201030, 201110); ax.set_ylim(557255, 557320); ax.set_aspect('equal'); ax.grid(alpha=.3); ax.set_title(title, fontsize=10)
if __name__ == '__main__':
    fig, ax = plt.subplots(figsize=(10, 8)); base(ax, '본관 남쪽 앞: S-MAP 1 m 메시 높이(색)·가파른 선(검정), 모델 계단(붉은 칠)·화단(회색)')
    plt.savefig(OUT / 'r02-본관남쪽-메시.png', dpi=90, bbox_inches='tight')
