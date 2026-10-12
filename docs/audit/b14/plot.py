"""B14: S-MAP 0.5 m 메시(건물 객체별 색, 높이) 위에 지금 모델의 건물 외곽과 구조물(기단·상자)을 겹쳐 그린다. 북쪽이 위.   python plot.py <out.png> [after]"""
import sys, json, glob, pathlib, numpy as np
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from matplotlib import font_manager
from mesh import *
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
REPO = pathlib.Path(__file__).resolve().parents[3]
xs, ys, Z, M = load()
fig, ax = plt.subplots(figsize=(15, 12))
col = {GROUND: None, DAEIL: '#9bd29b', CHEONGUN: '#9bb8e8', SANG: '#f0b27a'}
img = np.ones(Z.shape + (3,))
for k, c in col.items():
    if c: img[M == k] = matplotlib.colors.to_rgb(c)
g = M == GROUND; zz = np.clip((Z - 148) / 6, 0, 1); img[g] = np.stack([0.95 - 0.35 * zz[g]] * 3, -1)
ax.imshow(img, origin='lower', extent=(X0 - .25, X0 + STEP * Z.shape[1] - .25, Y0 - .25, Y0 + STEP * Z.shape[0] - .25))
for j in range(0, Z.shape[0], 4):
    for i in range(0, Z.shape[1], 6): ax.text(xs[j, i], ys[j, i], '%.1f' % Z[j, i], fontsize=4.5, ha='center', va='center', color='#333')
roofs = json.loads((REPO / 'backend/data/scene/overrides/building-roofs.json').read_text(encoding='utf-8'))
def rings(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ('polygon', 'footprint', 'rings', 'coordinates') and isinstance(v, list): yield o, v
            else: yield from rings(v)
    elif isinstance(o, list):
        for v in o: yield from rings(v)
for o, r in rings(roofs):
    try:
        for ring in (r if isinstance(r[0][0], list) else [r]):
            a = np.array(ring)
            if a[:, 0].max() > 201180 and a[:, 0].min() < 201236 and a[:, 1].max() > 557292 and a[:, 1].min() < 557336:
                ax.plot(a[:, 0], a[:, 1], 'k-', lw=1.6); ax.text(a[:, 0].mean(), a[:, 1].mean(), str(o.get('id') or o.get('buildingId') or o.get('name') or '')[:14], fontsize=8, weight='bold')
    except Exception: pass
def flat(c):
    if isinstance(c[0], (int, float)): yield c
    else:
        for q in c: yield from flat(q)
for f in sorted(glob.glob(str(REPO / 'frontend/public/structures/*.geojson'))):
    for ft in json.load(open(f, encoding='utf-8'))['features']:
        p = ft['properties']; g = ft['geometry']
        if p.get('surfaceMark') or p.get('underground') or p.get('type') == 'void' or g['type'] not in ('Polygon',): continue
        a = np.array(g['coordinates'][0])[:, :2]
        if a[:, 0].max() < 201186 or a[:, 0].min() > 201234 or a[:, 1].max() < 557294 or a[:, 1].min() > 557334 or np.ptp(a[:, 0]) > 80: continue
        plat = p.get('kind') == 'platform'
        ax.plot(a[:, 0], a[:, 1], '-', color='#c0392b' if plat else '#6c3483', lw=1.3 if plat else 0.6)
        if plat or np.ptp(a[:, 0]) * np.ptp(a[:, 1]) > 6: ax.text(a[:, 0].mean(), a[:, 1].mean(), p['id'].replace('PLATFORM-', 'P-')[:26] + ('\n%s' % p.get('topM', p.get('toM', ''))), fontsize=5.5, color='#c0392b' if plat else '#6c3483', ha='center')
ax.set_xlim(201184, 201234.5); ax.set_ylim(557294, 557335.5); ax.set_aspect('equal'); ax.grid(lw=0.2)
ax.set_title('B14 상승관: S-MAP 0.5 m 메시(주황 = 상승관 객체 173604866, 초록 = 대일관, 파랑 = 청운관, 회색 = 지면) + 지금 모델 외곽(검정)·구조물(빨강 기단, 보라 상자). 북쪽이 위')
fig.savefig(sys.argv[1], dpi=110, bbox_inches='tight'); print(sys.argv[1])
