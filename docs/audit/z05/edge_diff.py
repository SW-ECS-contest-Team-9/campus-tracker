import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'z04'))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from shapely.geometry import Polygon; from shapely import contains_xy
W, H, X0, Y0, R = 450, 464, 200668, 556798, 2
g = np.fromfile(sys.argv[1], dtype='<f4').reshape(H, W)
M = Mesh(); xs, ys = np.meshgrid(MX0 + np.arange(MNX), MY0 + np.arange(MNY)); ok = M.g & np.isfinite(M.z)
gz = g[((ys - Y0) // R).astype(int), ((xs - X0) // R).astype(int)]; d = np.where(ok, gz - M.z, np.nan)
C = Polygon(json.loads((pathlib.Path(__file__).parents[1] / 'z04/campus-outline-5186.json').read_text())['ring']); inc = contains_xy(C, xs, ys)
o = d[ok & ~inc]; print('off-campus ground pts', o.size, 'median', np.median(o), 'p10 p90', np.percentile(o, [10, 90]), 'p90abs', np.percentile(abs(o), 90))
fig, ax = plt.subplots(figsize=(12, 13)); im = ax.imshow(d, origin='lower', extent=[MX0 - .5, MX0 + MNX - .5, MY0 - .5, MY0 + MNY - .5], cmap='RdBu_r', vmin=-12, vmax=12); plt.colorbar(im)
c = np.array(C.exterior.coords); ax.plot(c[:, 0], c[:, 1], 'm--'); ax.grid(lw=.3); ax.set_title('terrain grid - S-MAP mesh (m)'); plt.savefig(sys.argv[2], dpi=70, bbox_inches='tight')
