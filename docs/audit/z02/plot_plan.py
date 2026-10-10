"""Z02: 기단·상자 평면을 S-MAP 메시 높이 위에. python plot_plan.py"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'
d = json.loads((REPO / 'frontend/public/structures/z02-daeil-front.geojson').read_text(encoding='utf-8'))
fig, ax = plt.subplots(figsize=(24, 13))
for z, ids, x0, y0, st in (load_b09(), load_g02d()):
    ext = [x0 - st / 2, x0 + st * (z.shape[1] - .5), y0 - st / 2, y0 + st * (z.shape[0] - .5)]
    ax.imshow(np.where(ids == GROUND, z, np.nan), origin='lower', extent=ext, cmap='turbo', vmin=144, vmax=154, alpha=.55)
for b in buildings():
    c = b['coordinates']; r = np.array(c[0] if isinstance(c[0][0][0], (int, float)) else c[0][0])
    ax.plot(r[:, 0], r[:, 1], 'm-', lw=1.2)
COL = {'platform': 'k', 'stair_step': '#444', 'landing': '#444', 'planter': 'g', 'wall': 'r', 'deck': '#a60', 'canopy': 'b'}
for f in d['features']:
    p = f['properties']; r = np.array(f['geometry']['coordinates'][0])
    if p['id'].endswith('FIELD'): continue
    ax.plot(r[:, 0], r[:, 1], color=COL[p['type']], lw=1.6 if p['kind'] == 'platform' else .7, ls='--' if p['kind'] == 'platform' else '-')
    if p['kind'] == 'platform': ax.text(r[:, 0].mean(), r[:, 1].mean(), f"{p['id'][13:]} {p['topM']}", fontsize=8)
ax.set_xlim(201128, 201226); ax.set_ylim(557278, 557330); ax.set_aspect('equal'); ax.grid(lw=.2)
fig.savefig(OUT / '평면-기단과-상자.png', dpi=100, bbox_inches='tight')
