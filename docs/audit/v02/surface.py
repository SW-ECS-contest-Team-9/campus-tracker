"""V02 공용: 캐시된 S-MAP 메시 격자(지형 모델 칸)로 1 m 지면 격자를 만든다. 건물 칸은 NaN."""
import pathlib, re, json, math
import numpy as np

TERRAIN_ID = 419430528
X0, Y0, X1, Y1 = 200950, 557080, 201280, 557430  # 1 m 격자 범위
GRIDS = ['e05/smap-mesh-south-2m.txt', 'e05/smap-mesh-nw-2m.txt', 'e05/smap-mesh-ne-2m.txt', 'e05/smap-mesh-yudam-2m.txt',
         't04/smap-mesh-t04-gate-n-2m.txt', 't04/smap-mesh-t04-gate-s-2m.txt', 't04/smap-mesh-t04-plaza-2m.txt',
         'e05/smap-mesh-cluster-1m.txt', 'e05/smap-mesh-eunju-1m-a.txt', 'e05/smap-mesh-eunju-1m-b.txt', 'e05/smap-mesh-eunju-1m-c.txt',
         'b10/smap-mesh-b10-front-1m.txt', 'b10/smap-mesh-b10-north-1m.txt', 'b10/smap-mesh-b10-west-1m.txt', 'v02/smap-mesh-v02-extra.txt']


def read_grid(path):
    L = pathlib.Path(path).read_text(encoding='utf-8').splitlines()
    m = re.search(r'x=(\d+)\+(\d+)\*i \(i<(\d+)\), y=(\d+)\+\d+\*j \(j<(\d+)\)', L[0])
    if not m: return []
    x0, step, nx, y0, ny = map(int, m.groups())
    out = []
    for ln in L[1:]:
        if ln.startswith('#') or '|' not in ln: continue
        j, zs, ids, rs = ln.split('|'); j = int(j)
        for i, (z, mid, r) in enumerate(zip(zs.split(','), ids.split(','), rs.split(','))):
            if int(z) < 0: continue
            out.append((x0 + step * i, y0 + step * j, int(z) / 10, int(mid), int(r) / 100))
    return out


def load_cells(audit):
    cells = {}
    for g in GRIDS:
        p = pathlib.Path(audit) / g
        if not p.exists(): continue
        for x, y, z, mid, r in read_grid(p):
            cells.setdefault((x, y), []).append((z, mid, r))
    return cells


class Surface:
    """ground[y, x]: 지형 모델 칸의 메시 높이(여러 화면 값의 중앙값). any[y,x]: 건물 포함 메시 높이."""
    def __init__(self, audit):
        cells = load_cells(audit)
        self.nx, self.ny = X1 - X0 + 1, Y1 - Y0 + 1
        g = np.full((self.ny, self.nx), np.nan); a = np.full((self.ny, self.nx), np.nan)
        for (x, y), v in cells.items():
            if not (X0 <= x <= X1 and Y0 <= y <= Y1): continue
            t = [z for z, mid, r in v if mid == TERRAIN_ID and r <= 0.3]
            a[y - Y0, x - X0] = float(np.median([z for z, mid, r in v]))
            if t and len(t) == len(v): g[y - Y0, x - X0] = float(np.median(t))
        self.known = g.copy(); self.any = a
        # 2 m 격자의 빈 칸(홀수 좌표)을 이웃 평균으로 메운다(1 m 안 이웃 2개 이상일 때만)
        for _ in range(2):
            pad = np.pad(g, 1, constant_values=np.nan)
            nb = np.stack([pad[1:-1, :-2], pad[1:-1, 2:], pad[:-2, 1:-1], pad[2:, 1:-1], pad[:-2, :-2], pad[:-2, 2:], pad[2:, :-2], pad[2:, 2:]])
            cnt = np.sum(~np.isnan(nb), axis=0); mean = np.nanmean(nb, axis=0)
            fill = np.isnan(g) & (cnt >= 2) & (np.nanmax(nb, axis=0) - np.nanmin(nb, axis=0) < 1.5)
            g = np.where(fill, mean, g)
        self.g = g

    def at(self, x, y):
        """쌍선형. 네 귀 중 하나라도 없으면 NaN. 배열 입력 가능."""
        x = np.asarray(x, float); y = np.asarray(y, float)
        fx, fy = x - X0, y - Y0
        ix = np.clip(np.floor(fx).astype(int), 0, self.nx - 2); iy = np.clip(np.floor(fy).astype(int), 0, self.ny - 2)
        tx, ty = fx - ix, fy - iy
        ok = (fx >= 0) & (fx <= self.nx - 1) & (fy >= 0) & (fy <= self.ny - 1)
        z = self.g[iy, ix] * (1 - tx) * (1 - ty) + self.g[iy, ix + 1] * tx * (1 - ty) + self.g[iy + 1, ix] * (1 - tx) * ty + self.g[iy + 1, ix + 1] * tx * ty
        return np.where(ok, z, np.nan)
