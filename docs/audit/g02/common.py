"""G02 공용: S-MAP 0.5 m 메시 격자 읽기, 건물 외곽, 길 축(s, t)."""
import json, pathlib, re
import numpy as np
VAULT = pathlib.Path(r'C:\campus-tracker-backend\데이터')
G02 = VAULT / '보완자료' / '3d-map-audit-20261009' / 'g02'
AUDIT = G02.parent
HERE = pathlib.Path(__file__).parent
GROUND = 419430528  # S-MAP 뷰어에서 땅 메시의 모델 id (그 밖은 건물 모델)

def load_block(names):
    """y 로 이어지는 조각들을 붙인 z[ny,nx] (m), 모델 id[ny,nx], x0, y0, step."""
    zs, ids = [], []
    for k, name in enumerate(names):
        L = (G02 / f'smap-mesh-g02-way-05m-{name}.txt').read_text(encoding='utf-8').splitlines()
        m = re.search(r'x=([\d.]+)\+([\d.]+)\*i \(i<(\d+)\), y=([\d.]+)\+', L[0])
        x0, step, y0 = float(m[1]), float(m[2]), float(m[4])
        idl = [int(v) for v in [l for l in L if l.startswith('# ids')][0][6:].split(',')]
        if k == 0: X0, Y0 = x0, y0
        for ln in L[1:]:
            if ln.startswith('#'): continue
            j, z, i = ln.split('|')
            zs.append(np.array(z.split(','), float) / 100); ids.append([idl[int(v)] for v in i.split(',')])
    return np.array(zs), np.array(ids, dtype=np.int64), X0, Y0, step

def buildings():
    return json.loads((AUDIT / 'building-outlines-5186.json').read_text(encoding='utf-8'))

# 길 축: s = 아래(차단기 쪽)에서 위로 가는 거리, t = 축에서 북쪽(문예관 쪽, 오르는 방향의 왼쪽)으로의 거리. 본관 북벽과 나란하다.
O = np.array([201044.0, 557350.0]); U = np.array([60.0, -29.5]); U = U / np.hypot(*U); N = np.array([-U[1], U[0]])
def st_to_xy(s, t): return O + np.multiply.outer(s, U) + np.multiply.outer(t, N)
def xy_to_st(x, y): d = np.stack([np.asarray(x) - O[0], np.asarray(y) - O[1]], -1); return d @ U, d @ N

class Mesh:
    def __init__(self):
        self.blocks = [load_block('abc'), load_block('d')]
    def at(self, x, y, ground=True):
        """쌍선형 보간. ground=True 면 네 귀 중 하나라도 건물 모델이면 NaN."""
        x = np.asarray(x, float); y = np.asarray(y, float); out = np.full(x.shape, np.nan)
        for z, ids, x0, y0, step in self.blocks:
            fx = (x - x0) / step; fy = (y - y0) / step
            ix = np.floor(fx).astype(int); iy = np.floor(fy).astype(int)
            ok = (ix >= 0) & (iy >= 0) & (ix < z.shape[1] - 1) & (iy < z.shape[0] - 1)
            ix = np.clip(ix, 0, z.shape[1] - 2); iy = np.clip(iy, 0, z.shape[0] - 2); a = fx - ix; b = fy - iy
            v = z[iy, ix] * (1 - a) * (1 - b) + z[iy, ix + 1] * a * (1 - b) + z[iy + 1, ix] * (1 - a) * b + z[iy + 1, ix + 1] * a * b
            if ground:
                g = ids == GROUND; ok &= g[iy, ix] & g[iy, ix + 1] & g[iy + 1, ix] & g[iy + 1, ix + 1]
            out = np.where(np.isnan(out) & ok, v, out)
        return out

# 길의 기본 경사면(가운데 경사로의 S-MAP 높이에 맞춘 평면 조각 3개, 폭 방향으로 평평). s -> z
WAY_PROFILE = [(-6.8, 130.6), (20.0, 133.75), (55.0, 138.95), (112.9, 148.9)]
def way_z(s): return np.interp(s, [p[0] for p in WAY_PROFILE], [p[1] for p in WAY_PROFILE])
