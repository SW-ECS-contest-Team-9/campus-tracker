"""Z02: S-MAP 메시 높이(땅만)와 건물 모델 칸을 한 장에. python -I plot_mesh.py"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(22, 13))
for z, ids, x0, y0, st in (load_b09(), load_g02d()):
    g = np.where(ids == GROUND, z, np.nan); ext = [x0 - st / 2, x0 + st * (z.shape[1] - .5), y0 - st / 2, y0 + st * (z.shape[0] - .5)]
    ax.imshow(np.where(ids != GROUND, 1, np.nan), origin='lower', extent=ext, cmap='gray', vmin=0, vmax=2, alpha=.5)
    im = ax.imshow(g, origin='lower', extent=ext, cmap='turbo', vmin=144, vmax=154)
    cs = ax.contour(np.arange(z.shape[1]) * st + x0, np.arange(z.shape[0]) * st + y0, g, levels=np.arange(144, 154.1, 0.5), colors='k', linewidths=.3)
for b in buildings():
    if b['name'] in ('대일관', '청운관', '상승관', '한림관', '문예관'):
        c = b['coordinates']; rings = c if isinstance(c[0][0], (int, float)) is False and isinstance(c[0][0][0], (int, float)) else [r for p in c for r in p]
        for r in rings:
            r = np.array(r); ax.plot(r[:, 0], r[:, 1], 'm-', lw=1)
for u in range(-30, 70, 5):
    p = uv_to_xy(np.array([u, u]), np.array([0, 12])); ax.plot(p[:, 0], p[:, 1], 'w-', lw=.4); ax.text(p[1, 0], p[1, 1], f'u{u}', color='w', fontsize=7)
ax.set_xlim(201118, 201247); ax.set_ylim(557266, 557336); ax.set_aspect('equal'); plt.colorbar(im, shrink=.6); ax.grid(lw=.2)
ax.set_xticks(range(201120, 201248, 5)); ax.set_yticks(range(557270, 557336, 5)); ax.tick_params(labelsize=6)
fig.savefig(OUT / 'smap-메시-구역B.png', dpi=110, bbox_inches='tight')
