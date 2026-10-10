"""Z05: S-MAP 1 m 메시를 등고선·기울기와 함께 그려 벽 선과 평면을 눈으로 고르는 보조 그림.  python look.py <이름> xa xb ya yb [out.png]"""
import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'z04'))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
from shapely.geometry import Polygon
def draw(nm, xa, xb, ya, yb, out, extra=None, scale=9.0, step=1.0):
    M = Mesh(); Z = np.where(np.isfinite(M.z), M.z, np.nan); G = M.g
    xs = MX0 + np.arange(MNX); ys = MY0 + np.arange(MNY)
    fig, ax = plt.subplots(figsize=((xb - xa) / scale, (yb - ya) / scale))
    Zg = np.where(G, Z, np.nan); sub = Zg[int(ya - MY0):int(yb - MY0), int(xa - MX0):int(xb - MX0)]
    lo, hi = np.nanpercentile(sub, [1, 99])
    ax.imshow(Zg, origin='lower', extent=[MX0 - .5, MX0 + MNX - .5, MY0 - .5, MY0 + MNY - .5], cmap='terrain', vmin=lo - 3, vmax=hi + 3, interpolation='nearest', alpha=.75)
    ax.imshow(np.where(~G & np.isfinite(Z), 1.0, np.nan), origin='lower', extent=[MX0 - .5, MX0 + MNX - .5, MY0 - .5, MY0 + MNY - .5], cmap='gray', vmin=0, vmax=1.6, alpha=.5)
    cs = ax.contour(xs, ys, Zg, levels=np.arange(np.floor(lo), hi + 1, step), colors='k', linewidths=.35)
    cs5 = ax.contour(xs, ys, Zg, levels=np.arange(np.floor(lo / 5) * 5, hi + 5, 5), colors='k', linewidths=1.0); ax.clabel(cs5, fmt='%d', fontsize=7)
    camp = json.loads((pathlib.Path(__file__).parents[1] / 'z04' / 'campus-outline-5186.json').read_text(encoding='utf-8'))['ring']; c = np.array(camp); ax.plot(c[:, 0], c[:, 1], 'm--', lw=1.5)
    for name, poly in building_polys().items(): ax.plot(*poly.exterior.xy, 'b-', lw=1.2); ax.text(poly.centroid.x, poly.centroid.y, name, color='b', fontsize=9, ha='center', clip_on=True)
    for p in pins():
        if xa <= p['x'] <= xb and ya <= p['y'] <= yb: ax.plot(p['x'], p['y'], 'r+', ms=6); ax.text(p['x'] + .5, p['y'] + .5, f"{p['value_m']}", color='r', fontsize=6, clip_on=True)
    # 5 m 마다 높이 숫자
    for y in np.arange(np.ceil(ya / 5) * 5, yb, 5):
        for x in np.arange(np.ceil(xa / 5) * 5, xb, 5):
            v = Zg[int(y - MY0), int(x - MX0)] if 0 <= int(y - MY0) < MNY and 0 <= int(x - MX0) < MNX else np.nan
            if np.isfinite(v): ax.text(x, y, f'{v:.1f}', fontsize=5, color='k', ha='center', va='center', clip_on=True)
    if extra: extra(ax)
    ax.set_xlim(xa, xb); ax.set_ylim(ya, yb); ax.set_aspect('equal'); ax.set_xticks(np.arange(np.ceil(xa / 10) * 10, xb, 10)); ax.set_yticks(np.arange(np.ceil(ya / 10) * 10, yb, 10)); ax.grid(lw=.3, color='k', alpha=.35); ax.tick_params(labelsize=6)
    ax.set_title(nm, fontsize=8); plt.savefig(out, dpi=100, bbox_inches='tight'); plt.close()
if __name__ == '__main__':
    a = sys.argv; draw(a[1], *map(float, a[2:6]), a[6])
