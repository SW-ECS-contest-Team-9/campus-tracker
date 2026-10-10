"""G02: 0.5 m 메시를 높이 색·음영으로 그려 본다(건물 외곽, 옛 길 축 겹침). python -I plot_mesh.py"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
z, ids, x0, y0, st = load_mesh(); ny, nx = z.shape
ext = [x0 - st/2, x0 + st*(nx-0.5), y0 - st/2, y0 + st*(ny-0.5)]
GROUND = 419430528
fig, ax = plt.subplots(1, 2, figsize=(26, 10))
zz = np.where(ids == GROUND, z, np.nan)
im = ax[0].imshow(zz, origin='lower', extent=ext, cmap='turbo', vmin=129, vmax=150); plt.colorbar(im, ax=ax[0], shrink=.7)
gy, gx = np.gradient(np.where(ids == GROUND, z, np.nan), st)
ax[1].imshow(np.clip(np.hypot(gx, gy), 0, 1.5), origin='lower', extent=ext, cmap='gray_r')
for a in ax:
    for b in buildings():
        for poly in b['coordinates']:
            r = np.array(poly[0]); a.plot(r[:,0], r[:,1], 'k-' if a is ax[0] else 'r-', lw=1)
        c = np.array(b['coordinates'][0][0]).mean(0)
        if ext[0] < c[0] < ext[1] and ext[2] < c[1] < ext[3]: a.text(c[0], c[1], b['name'], fontfamily='Malgun Gothic', fontsize=12)
    up = np.array([[201106.22,557324.73],[201103.5,557326],[201094,557330.4],[201085.8,557334.2],[201076.3,557338.7],[201066.3,557343.3],[201056.8,557347.8],[201050.5,557348.9],[201044.2,557350]])
    a.plot(up[:,0], up[:,1], 'm--', lw=1)
    a.set_xlim(ext[0], ext[1]); a.set_ylim(ext[2], ext[3]); a.set_aspect('equal'); a.grid(alpha=.3); a.set_xticks(np.arange(201030, 201131, 10)); a.set_yticks(np.arange(557300, 557366, 5))
ax[0].set_title('S-MAP mesh 0.5 m, ground model only (m)'); ax[1].set_title('slope magnitude (dark = step/wall)')
plt.tight_layout(); plt.savefig(G02 / 'mesh-05m-overview.png', dpi=80)
