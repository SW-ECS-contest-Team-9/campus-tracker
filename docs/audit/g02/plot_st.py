"""G02: 길 축 좌표(s, t)로 편 그림 — 위: 정사 그림, 아래: S-MAP 0.5 m 메시 높이 − 기본 경사면. python -I plot_st.py"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from PIL import Image
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
m = Mesh(); S = np.arange(-12, 125, 0.25); T = np.arange(-14, 22, 0.25)
ss, tt = np.meshgrid(S, T); p = st_to_xy(ss, tt); x, y = p[..., 0], p[..., 1]
rel = m.at(x, y) - way_z(ss)
orth = np.asarray(Image.open(G02 / 'smap-ortho-rectified-01m.png'))
u = ((x - 201030) / 0.1).astype(int); v = ((557366 - y) / 0.1).astype(int)
ok = (u >= 0) & (v >= 0) & (u < orth.shape[1]) & (v < orth.shape[0])
img = np.zeros(x.shape + (3,), np.uint8); img[ok] = orth[v[ok], u[ok]]
fig, ax = plt.subplots(2, 1, figsize=(26, 15)); ext = [S[0], S[-1], T[0], T[-1]]
ax[0].imshow(img, origin='lower', extent=ext)
im = ax[1].imshow(np.clip(rel, -6, 6), origin='lower', extent=ext, cmap='RdBu_r', vmin=-6, vmax=6); plt.colorbar(im, ax=ax[1], shrink=.6, label='mesh - base plane (m)')
cs = ax[1].contour(ss, tt, rel, levels=[-4, -2, -1, -0.3, 0.3, 1, 2, 4], colors='k', linewidths=.5); ax[1].clabel(cs, fontsize=7)
for a in ax:
    for b in buildings():
        for poly in b['coordinates']:
            r = np.array(poly[0]); s_, t_ = xy_to_st(r[:, 0], r[:, 1]); a.plot(s_, t_, 'y-', lw=1.2)
    a.set_xlim(ext[0], ext[1]); a.set_ylim(ext[2], ext[3]); a.set_xticks(np.arange(-10, 125, 5)); a.set_yticks(np.arange(-14, 22, 2)); a.grid(alpha=.35); a.set_xlabel('s (m, uphill)'); a.set_ylabel('t (m, north +)')
plt.tight_layout(); plt.savefig(G02 / 'st-ortho-and-relief.png', dpi=75)
