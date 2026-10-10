"""N02 공용: S-MAP 메시 격자(1 m 우선, 없으면 2 m)에서 지면 높이를 읽는다. 읽기 전용."""
import sys, pathlib, json
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'e05'))
from grids import Grid
TERRAIN_ID = 419430528

def load(audit):
    audit = pathlib.Path(audit)
    names = ['b10/smap-mesh-b10-front-1m.txt', 'b10/smap-mesh-b10-west-1m.txt', 'b10/smap-mesh-b10-north-1m.txt', 't04/smap-mesh-t04-plaza-2m.txt', 'e05/smap-mesh-nw-2m.txt']
    return [Grid(audit / n) for n in names]

def cells(grids, terrain_only=True):
    """(x, y, z, step, id) of every picked cell; 1 m grids first."""
    for g in grids:
        for x, y, z, i in g.cells():
            if terrain_only and i != TERRAIN_ID: continue
            yield x, y, z, g.step, i

def read(grids, x, y, r=1.5):
    """Median/range of terrain cells within r (1 m grids); falls back to 2 m grids with r+1."""
    for step, rr in ((1, r), (2, r + 1.0)):
        zs = [z for g in grids if g.step == step for (cx, cy, z, i) in g.cells() if i == TERRAIN_ID and (cx - x) ** 2 + (cy - y) ** 2 <= rr * rr]
        if len(zs) >= 2: return {'n': len(zs), 'medianM': round(float(np.median(zs)), 2), 'rangeM': [round(min(zs), 1), round(max(zs), 1)], 'gridM': step}
    return None
