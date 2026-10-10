"""Z03: S-MAP 0.5 m 메시를 높이 색·기울기 그림으로(광장 가장자리·벽·둑 자리 찾기). python -I plot_mesh.py"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
M = Mesh(); z = M.z; ext = [M.x0, M.x0 + M.step * z.shape[1], M.y0, M.y0 + M.step * z.shape[0]]
fig, ax = plt.subplots(1, 3, figsize=(30, 14))
im = ax[0].imshow(np.clip(z, 92, 135), origin='lower', extent=ext, cmap='terrain'); plt.colorbar(im, ax=ax[0], shrink=.6); ax[0].set_title('높이 92~135 m')
im = ax[1].imshow(np.clip(z, 111, 118), origin='lower', extent=ext, cmap='turbo'); plt.colorbar(im, ax=ax[1], shrink=.6); ax[1].set_title('높이 111~118 m (광장 114.1 둘레)')
gy, gx = np.gradient(z, M.step); im = ax[2].imshow(np.clip(np.hypot(gx, gy), 0, 1.5), origin='lower', extent=ext, cmap='gray_r'); ax[2].set_title('기울기(검을수록 가파름) + 건물 모델(붉은 점)')
bm = ~M.g; yy, xx = np.nonzero(bm[::2, ::2]); ax[2].scatter(M.x0 + xx * 2 * M.step, M.y0 + yy * 2 * M.step, s=1, c='r', alpha=.3)
for a in ax:
    for p in pins():
        if ext[0] < p['x'] < ext[1] and ext[2] < p['y'] < ext[3]: a.plot(p['x'], p['y'], 'k+'); a.text(p['x'], p['y'], f"{p['value_m']}", fontsize=7)
    a.set_xticks(np.arange(201030, 201105, 10)); a.set_yticks(np.arange(557160, 557271, 10)); a.grid(alpha=.3)
plt.tight_layout(); plt.savefig(Z03 / 'smap-메시-분수광장-05m.png', dpi=70); print('ok', z.shape)
