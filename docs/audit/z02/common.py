"""Z02 공용: S-MAP 메시(서쪽 0.5 m = G02 d 조각, 동쪽 1 m = B09) 읽기, 건물 외곽, 대일관 정면 축(u, v)."""
import json, pathlib, re
import numpy as np
VAULT = pathlib.Path(r'C:\campus-tracker-backend\데이터')
AUDIT = VAULT / '보완자료' / '3d-map-audit-20261009'
OUT = AUDIT / 'z02'
HERE = pathlib.Path(__file__).parent
REPO = HERE.parents[2]
GROUND = 419430528

def load_g02d():
    L = (AUDIT / 'g02' / 'smap-mesh-g02-way-05m-d.txt').read_text(encoding='utf-8').splitlines()
    m = re.search(r'x=([\d.]+)\+([\d.]+)\*i \(i<(\d+)\), y=([\d.]+)\+', L[0])
    x0, step, y0 = float(m[1]), float(m[2]), float(m[4])
    idl = [int(v) for v in [l for l in L if l.startswith('# ids')][0][6:].split(',')]
    zs, ids = [], []
    for ln in L[1:]:
        if ln.startswith('#'): continue
        j, z, i = ln.split('|')
        zs.append(np.array(z.split(','), float) / 100); ids.append([idl[int(v)] for v in i.split(',')])
    return np.array(zs), np.array(ids, dtype=np.int64), x0, y0, step

def load_b09():
    L = (AUDIT / 'b09' / 'smap-mesh-b09-sangseung-1m.txt').read_text(encoding='utf-8').splitlines()
    m = re.search(r'x=([\d.]+)\+([\d.]+)\*i \(i<(\d+)\), y=([\d.]+)\+', L[0])
    x0, step, y0 = float(m[1]), float(m[2]), float(m[4])
    zs, ids = [], []
    for ln in L[1:]:
        if ln.startswith('#'): continue
        p = ln.split('|')
        zs.append(np.array(p[1].split(','), float) / 10); ids.append([int(v) for v in p[2].split(',')])
    return np.array(zs), np.array(ids, dtype=np.int64), x0, y0, step

def buildings():
    return json.loads((AUDIT / 'building-outlines-5186.json').read_text(encoding='utf-8'))

# 대일관 남쪽 벽(정면) 축: 벽 선 (201156.91, 557314.21) -> (201193.30, 557297.91). u = 벽을 따라 동쪽으로, v = 벽에서 운동장 쪽(남남서)으로 +
W0 = np.array([201156.91, 557314.21]); W1 = np.array([201193.30, 557297.91])
U = (W1 - W0) / np.hypot(*(W1 - W0)); V = np.array([U[1], -U[0]])   # V 는 남남서(운동장 쪽)
def uv_to_xy(u, v): return W0 + np.multiply.outer(u, U) + np.multiply.outer(v, V)
def xy_to_uv(x, y): d = np.stack([np.asarray(x) - W0[0], np.asarray(y) - W0[1]], -1); return d @ U, d @ V

class Mesh:
    """S-MAP 메시 최근접 칸 읽기(서쪽 0.5 m 조각이 먼저). ground=True 면 건물 모델 칸은 NaN."""
    def __init__(self): self.blocks = [load_g02d(), load_b09()]
    def at(self, x, y, ground=True, model=False):
        x = np.asarray(x, float); y = np.asarray(y, float); out = np.full(x.shape, np.nan); mid = np.zeros(x.shape, np.int64)
        for z, ids, x0, y0, st in self.blocks:
            ix = np.rint((x - x0) / st).astype(int); iy = np.rint((y - y0) / st).astype(int)
            ok = (ix >= 0) & (iy >= 0) & (ix < z.shape[1]) & (iy < z.shape[0]) & np.isnan(out)
            ix = np.clip(ix, 0, z.shape[1] - 1); iy = np.clip(iy, 0, z.shape[0] - 1)
            v = z[iy, ix]; i = ids[iy, ix]
            keep = ok & ((i == GROUND) if ground else True)
            mid = np.where(ok, i, mid); out = np.where(keep, v, out)
        return (out, mid) if model else out

GRID = dict(ox=200668.0, oy=556798.0, res=2.0, w=450, h=464)
def load_terrain(path): return np.fromfile(path, dtype='<f4').reshape(GRID['h'], GRID['w'])
def terrain_at(t, x, y):
    """서버와 같은 쌍선형 보간(칸 중심 기준)."""
    fx = (np.asarray(x, float) - GRID['ox']) / GRID['res'] - .5; fy = (np.asarray(y, float) - GRID['oy']) / GRID['res'] - .5
    ix = np.clip(np.floor(fx).astype(int), 0, GRID['w'] - 2); iy = np.clip(np.floor(fy).astype(int), 0, GRID['h'] - 2); a = fx - ix; b = fy - iy
    return t[iy, ix] * (1 - a) * (1 - b) + t[iy, ix + 1] * a * (1 - b) + t[iy + 1, ix] * (1 - a) * b + t[iy + 1, ix + 1] * a * b
