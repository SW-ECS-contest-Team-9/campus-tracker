"""E05 공용: S-MAP 메시 격자 읽기, 원천 외곽·대학 좌표 읽기."""
import json, pathlib, re, sqlite3
import numpy as np
from shapely import wkb


class Grid:
    def __init__(self, path):
        L = pathlib.Path(path).read_text(encoding='utf-8').splitlines()
        m = re.search(r'x=(\d+)\+(\d+)\*i \(i<(\d+)\), y=(\d+)\+\d+\*j \(j<(\d+)\)', L[0])
        self.x0, self.step, self.nx, self.y0, self.ny = map(int, m.groups())
        self.z = np.full((self.ny, self.nx), np.nan); self.id = np.zeros((self.ny, self.nx), dtype=np.int64); self.res = np.zeros((self.ny, self.nx))
        for ln in L[1:]:
            if ln.startswith('#'): continue
            j, zs, ids, rs = ln.split('|'); j = int(j)
            z = np.array(zs.split(','), dtype=float); self.z[j] = np.where(z < 0, np.nan, z / 10)
            self.id[j] = np.array(ids.split(','), dtype=np.int64); self.res[j] = np.array(rs.split(','), dtype=float) / 100
        self.xs = self.x0 + self.step * np.arange(self.nx); self.ys = self.y0 + self.step * np.arange(self.ny)

    def cells(self):
        for j in range(self.ny):
            for i in range(self.nx):
                if not np.isnan(self.z[j, i]): yield float(self.xs[i]), float(self.ys[j]), float(self.z[j, i]), int(self.id[j, i])


def stack(paths):  # same x-range, consecutive y blocks -> one grid
    gs = [Grid(p) for p in paths]; g = gs[0]
    for h in gs[1:]:
        assert h.x0 == g.x0 and h.nx == g.nx and h.y0 == g.y0 + g.step * g.ny
        g.z = np.vstack([g.z, h.z]); g.id = np.vstack([g.id, h.id]); g.res = np.vstack([g.res, h.res]); g.ny += h.ny
    g.ys = g.y0 + g.step * np.arange(g.ny)
    return g


def gpkg_buildings(gpkg):
    con = sqlite3.connect(f'file:{pathlib.Path(gpkg).as_posix()}?mode=ro', uri=True)
    out = []
    cols = [r[1] for r in con.execute('pragma table_info(buildings_3d)')]
    for row in con.execute('select * from buildings_3d order by fid'):
        d = dict(zip(cols, row)); blob = d.pop('geom')
        env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(blob[3] >> 1) & 7]
        d['geom'] = wkb.loads(bytes(blob[8 + env:])); out.append(d)
    return out
