"""Z03 공용: S-MAP 0.5 m 메시(분수 광장 일대, x 201026~201104, y 557160~557270) 읽기, 건물 외곽, 사용자 핀."""
import json, pathlib, re
import numpy as np
VAULT = pathlib.Path(r'C:\campus-tracker-backend\데이터')
AUDIT = VAULT / '보완자료' / '3d-map-audit-20261009'
Z03 = AUDIT / 'z03'
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]

def load_mesh():
    """z[ny,nx] (m), 땅인지[ny,nx], x0, y0, step. 조각 a~d 를 y 로 이어 붙임."""
    zs, gs = [], []
    for k, name in enumerate('abcd'):
        L = (Z03 / f'smap-mesh-z03-plaza-05m-{name}.txt').read_text(encoding='utf-8').splitlines()
        m = re.search(r'x=([\d.]+)\+([\d.]+)\*i \(i<(\d+)\), y=([\d.]+)\+', L[0])
        if k == 0: X0, step, Y0 = float(m[1]), float(m[2]), float(m[4])
        idl = [int(v) for v in [l for l in L if l.startswith('# ids')][0][6:].split(',')]
        for ln in L[1:]:
            if ln.startswith('#'): continue
            j, z, i = ln.split('|')
            zs.append(np.array(z.split(','), float) / 100); gs.append([idl[int(v)] == 419430528 for v in i.split(',')])
    return np.array(zs), np.array(gs), X0, Y0, step

class Mesh:
    def __init__(self): self.z, self.g, self.x0, self.y0, self.step = load_mesh()
    def at(self, x, y, ground=False):
        x = np.asarray(x, float); y = np.asarray(y, float)
        fx = (x - self.x0) / self.step; fy = (y - self.y0) / self.step
        ix = np.floor(fx).astype(int); iy = np.floor(fy).astype(int)
        ok = (ix >= 0) & (iy >= 0) & (ix < self.z.shape[1] - 1) & (iy < self.z.shape[0] - 1)
        ix = np.clip(ix, 0, self.z.shape[1] - 2); iy = np.clip(iy, 0, self.z.shape[0] - 2); a = fx - ix; b = fy - iy
        z = self.z; v = z[iy, ix] * (1 - a) * (1 - b) + z[iy, ix + 1] * a * (1 - b) + z[iy + 1, ix] * (1 - a) * b + z[iy + 1, ix + 1] * a * b
        if ground: g = self.g; ok = ok & g[iy, ix] & g[iy, ix + 1] & g[iy + 1, ix] & g[iy + 1, ix + 1]
        return np.where(ok, v, np.nan)

def buildings(): return json.loads((AUDIT / 'building-outlines-5186.json').read_text(encoding='utf-8'))
def pins(): return [p for p in json.loads((HERE.parent / 'v02' / 'user-readings.json').read_text(encoding='utf-8'))['points'] if p.get('x')]
