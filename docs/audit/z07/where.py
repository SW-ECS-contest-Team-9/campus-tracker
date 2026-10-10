"""Z07: 점이 어느 기단·빈 곳·상자 안인지와 그 윗면 높이.  python where.py x y [x y ...]"""
import sys, json, pathlib
import numpy as np
from shapely.geometry import shape, Point
REPO = pathlib.Path(__file__).parents[3]
def feats():
    for f in sorted((REPO / 'frontend/public/structures').glob('*.geojson')):
        for ft in json.loads(f.read_text(encoding='utf-8'))['features']: yield f.name, ft['properties'], shape(ft['geometry']).buffer(0)
def top(p, x, y):
    if 'topProfile' not in p: return p.get('topM', p.get('toM'))
    t = p['topProfile']; o, d = t['origin'], t['direction']; s = (x - o[0]) * d[0] + (y - o[1]) * d[1]
    return round(float(np.interp(s, [q[0] for q in t['points']], [q[1] for q in t['points']])), 2)
if __name__ == '__main__':
    F = list(feats()); a = list(map(float, sys.argv[1:]))
    for x, y in zip(a[::2], a[1::2]):
        print(x, y, [(p['id'], p.get('fromM', p.get('bottomM')), top(p, x, y)) for f, p, g in F if p.get('type') != 'tree' and g.contains(Point(x, y))])
