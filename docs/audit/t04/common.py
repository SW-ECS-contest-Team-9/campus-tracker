"""T04 공용: S-MAP 메시 격자(2 m), 옛 지형 격자, E09 차도 중심선 읽기."""
import json, math, pathlib, re
import numpy as np

TERRAIN_ID = 419430528  # S-MAP 3D 화면에서 지형 모델 칸의 id (E05·E09 와 같음)


def read_grid(path):
    L = pathlib.Path(path).read_text(encoding='utf-8').splitlines()
    m = re.search(r'x=(\d+)\+(\d+)\*i \(i<(\d+)\), y=(\d+)\+\d+\*j \(j<(\d+)\)', L[0])
    x0, step, nx, y0, ny = map(int, m.groups())
    out = {}
    for ln in L[1:]:
        if ln.startswith('#'): continue
        j, zs, ids, rs = ln.split('|'); j = int(j)
        for i, (z, mid, r) in enumerate(zip(zs.split(','), ids.split(','), rs.split(','))):
            if int(z) < 0: continue
            out[(x0 + step * i, y0 + step * j)] = (int(z) / 10, int(mid), int(r) / 100)
    return out, step


class Dem:
    def __init__(self, audit, f32=None):
        self.meta = json.loads((audit / 'terrain-grid-meta.json').read_text(encoding='utf-8-sig'))
        m = self.meta
        self.h = np.fromfile(f32 or audit / 'terrain-grid.f32', dtype='<f4').reshape(m['height'], m['width'])

    def at(self, x, y, h=None):  # dem.ts bilinear
        m = self.meta; g = self.h if h is None else h
        fx = (x - m['originX']) / m['resolution'] - 0.5; fy = (y - m['originY']) / m['resolution'] - 0.5
        ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
        return float(g[iy, ix] * (1 - tx) * (1 - ty) + g[iy, ix + 1] * tx * (1 - ty) + g[iy + 1, ix] * (1 - tx) * ty + g[iy + 1, ix + 1] * tx * ty)


def segments(repo):
    d = json.loads((repo / 'docs/audit/e09/vehicle-roads-proposal.geojson').read_text(encoding='utf-8'))
    return {f['properties']['id']: f['geometry']['coordinates'] for f in d['features'] if f['geometry']['type'] == 'LineString'}


def dist_line(x, y, line):
    best = 1e9
    for a, b in zip(line, line[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, math.hypot(x - a[0] - t * dx, y - a[1] - t * dy))
    return best
