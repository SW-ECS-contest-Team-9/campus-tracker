"""R02: 오르막길 윗부분의 S-MAP 0.5 m 메시를 길 축(s, t)으로 펴서 높이차·기울기 그림과 지점별 가장자리 표. python -I st_relief.py"""
import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'g02'))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
OUT = AUDIT / 'r02'; OUT.mkdir(exist_ok=True)
m = Mesh()
S = np.arange(40, 140, 0.5); T = np.arange(-16, 22, 0.5)
gs, gt = np.meshgrid(S, T); xy = st_to_xy(gs, gt); z = m.at(xy[..., 0], xy[..., 1])
dz = z - way_z(gs)
gy, gx = np.gradient(z, 0.5); sl = np.hypot(gx, gy)
fig, ax = plt.subplots(2, 1, figsize=(18, 11))
im = ax[0].pcolormesh(S, T, dz, cmap='RdBu_r', vmin=-3, vmax=3, shading='auto'); fig.colorbar(im, ax=ax[0])
ax[0].contour(S, T, dz, [-0.3, 0.3], colors='k', linewidths=0.6)
ax[1].pcolormesh(S, T, sl, cmap='Greys', vmin=0, vmax=1.2, shading='auto')
for a in ax: a.set_aspect('equal'); a.grid(alpha=.3); a.set_xticks(range(40, 141, 5)); a.set_yticks(range(-16, 23, 2))
ax[0].set_title('mesh - way_z (m)'); ax[1].set_title('slope')
plt.savefig(OUT / 'r02-st-relief.png', dpi=80, bbox_inches='tight')
# 지점별: 길 경사면과 0.3 m 안인 띠(가운데 선 t=2 에서 이어진 구간)
print('s  t_south t_north width  centre(x,y)')
for s_ in range(60, 136, 4):
    j = np.argmin(abs(S - s_)); col = np.abs(dz[:, j]) < 0.35; i0 = np.argmin(abs(T - 2))
    if not col[i0]: print(s_, 'centre off', np.round(dz[i0, j], 2)); continue
    a = i0
    while a > 0 and col[a - 1]: a -= 1
    b = i0
    while b < len(T) - 1 and col[b + 1]: b += 1
    c = st_to_xy(s_, (T[a] + T[b]) / 2)
    print(s_, T[a], T[b], T[b] - T[a] + 0.5, np.round(c, 1))
