"""Z04 공용: S-MAP 1 m 메시(캠퍼스 안 전체, x 200984~201267, y 557086~557417, 조각 w0~w3·e0~e3) 읽기, 건물 외곽, 사용자 핀, 시험용 DB 길(작업 전 상태 파일)."""
import json, pathlib, re
import numpy as np
VAULT = pathlib.Path(r'C:\campus-tracker-backend\데이터')
AUDIT = VAULT / '보완자료' / '3d-map-audit-20261009'
Z04 = AUDIT / 'z04'
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
GROUND = 419430528   # S-MAP 뷰어에서 땅 메시의 모델 id (그 밖은 건물 모델)
MX0, MY0, MNX, MNY = 200984.0, 557086.0, 284, 332

def load_mesh():
    """z[ny,nx] (m, 없으면 NaN), 땅인지[ny,nx]."""
    z = np.full((MNY, MNX), np.nan); g = np.zeros((MNY, MNX), bool)
    for f in sorted(Z04.glob('smap-mesh-z04-1m-*.txt')):
        L = f.read_text(encoding='utf-8').splitlines()
        m = re.search(r'x=([\d.]+)\+([\d.]+)\*i \(i<(\d+)\), y=([\d.]+)\+', L[0]); x0, y0 = float(m[1]), float(m[4])
        idl = [int(v) for v in [l for l in L if l.startswith('# ids')][0][6:].split(',')]
        for ln in L[1:]:
            if ln.startswith('#'): continue
            j, zs, ids = ln.split('|'); r = int(y0 - MY0) + int(j); c = int(x0 - MX0)
            v = np.array(zs.split(','), float); v[v < 0] = np.nan
            z[r, c:c + len(v)] = v / 100; g[r, c:c + len(v)] = [idl[int(k)] == GROUND for k in ids.split(',')]
    return z, g

class Mesh:
    def __init__(self): self.z, self.g = load_mesh()
    def at(self, x, y, ground=True):
        """가장 가까운 1 m 칸의 값. ground=True 면 건물 모델 칸은 NaN."""
        ix = np.rint(np.asarray(x, float) - MX0).astype(int); iy = np.rint(np.asarray(y, float) - MY0).astype(int)
        ok = (ix >= 0) & (iy >= 0) & (ix < MNX) & (iy < MNY); ix = np.clip(ix, 0, MNX - 1); iy = np.clip(iy, 0, MNY - 1)
        v = self.z[iy, ix]
        if ground: ok = ok & self.g[iy, ix]
        return np.where(ok, v, np.nan)
    def inside(self, poly, ground=True, inset=0.0):
        """다각형(shapely) 안 칸의 높이 목록과 좌표."""
        from shapely import contains_xy
        p = poly.buffer(-inset) if inset else poly
        xs, ys = np.meshgrid(MX0 + np.arange(MNX), MY0 + np.arange(MNY)); m = contains_xy(p, xs, ys) & np.isfinite(self.z)
        if ground: m &= self.g
        return self.z[m], xs[m], ys[m]

def buildings(): return json.loads((AUDIT / 'building-outlines-5186.json').read_text(encoding='utf-8'))
def building_polys():
    from shapely.geometry import Polygon
    out = {}
    for b in buildings():
        c = b['coordinates']
        while isinstance(c[0][0], list): c = c[0]
        out[b['name']] = Polygon(c).buffer(0)
    return out
def pins(): return [p for p in json.loads((HERE.parent / 'v02' / 'user-readings.json').read_text(encoding='utf-8'))['points'] if p.get('x')]
def roads_before(): return json.loads((Z04 / '01-state-before.json').read_text(encoding='utf-8'))['roads']
