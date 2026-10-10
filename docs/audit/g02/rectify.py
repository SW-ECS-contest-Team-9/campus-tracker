"""G02: S-MAP 화면 갈무리(위에서 본 모습)를 화면 격자점 좌표(lattice)로 펴서 0.1 m 정사 그림으로. python -I rectify.py"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from PIL import Image
from scipy.interpolate import LinearNDInterpolator
im = np.asarray(Image.open(G02 / 'smap-ortho-c201080_557335-r520.jpg').convert('RGB')).astype(float)
lat = np.array(json.loads((G02 / 'smap-ortho-c201080_557335-r520-lattice.json').read_text()))  # [row][col] = (x-201000)*100,(y-557000)*100,z*10 at pixel (25c,25r) of 1900x1150
s = im.shape[1] / 1900
pts, vals = [], []
for r in range(lat.shape[0]):
    for c in range(lat.shape[1]):
        x, y, z = lat[r, c]
        if x == 0: continue
        pts.append((201000 + x / 100, 557000 + y / 100)); vals.append((c * 25 * s, r * 25 * s))
f = LinearNDInterpolator(np.array(pts), np.array(vals))
X0, X1, Y0, Y1, R = 201030, 201130, 557300, 557366, 0.1
xs = np.arange(X0, X1, R) + R / 2; ys = np.arange(Y1, Y0, -R) - R / 2
gx, gy = np.meshgrid(xs, ys); uv = f(gx, gy); u, v = uv[..., 0], uv[..., 1]
ok = np.isfinite(u) & (u >= 0) & (v >= 0) & (u < im.shape[1] - 1) & (v < im.shape[0] - 1)
u0 = np.clip(np.nan_to_num(u), 0, im.shape[1] - 2); v0 = np.clip(np.nan_to_num(v), 0, im.shape[0] - 2)
iu, iv = u0.astype(int), v0.astype(int); fu, fv = (u0 - iu)[..., None], (v0 - iv)[..., None]
o = im[iv, iu] * (1 - fu) * (1 - fv) + im[iv, iu + 1] * fu * (1 - fv) + im[iv + 1, iu] * (1 - fu) * fv + im[iv + 1, iu + 1] * fu * fv
o[~ok] = 0
o = np.clip((o / 255) ** 0.6 * 255 * 1.25, 0, 255)  # 그늘 밝히기
Image.fromarray(o.astype(np.uint8)).save(G02 / 'smap-ortho-rectified-01m.png')
print('ok', o.shape, 'origin(top-left)', X0, Y1, 'm/px', R)
