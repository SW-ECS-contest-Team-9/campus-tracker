"""X22: 이번에 만들거나 고친 상자(x22-photo-fixes 전부 + 고친 z02 상자 + g02 의 바뀐 상자)가 다른 모든 구조물 상자와 겹치는지 본다.   python -I overlaps.py
겹침 판정은 g03/overlaps.py 와 같다(평면 0.05 ㎡ 넘고 높이 0.05 m 넘게 겹침. 같은 계단, basePlane 관계, 한 나무, 얇은 칠 판끼리는 뺀다)."""
import json, pathlib, itertools, sys
import numpy as np
from shapely.geometry import shape
from shapely.strtree import STRtree
import os
STR = pathlib.Path(os.environ.get('X22_STR') or pathlib.Path(__file__).parents[3] / 'frontend' / 'public' / 'structures')
B = []
for fn in sorted(STR.glob('*.geojson')):
    for f in json.loads(fn.read_text(encoding='utf-8'))['features']:
        p = f['properties']
        if p.get('kind') != 'extrude' or not f.get('geometry'): continue
        g = shape(f['geometry']).buffer(0); lo, hi = p.get('fromM', p.get('bottomM', 0)), p.get('toM', p.get('topM', 0))
        if 'topProfile' in p: zs = [q[1] for q in p['topProfile']['points']]; hi = max(zs); lo = min(zs) - p['thicknessM'] if 'thicknessM' in p else p.get('bottomM', lo)
        B.append(dict(id=p['id'], file=fn.name, g=g, lo=lo, hi=hi, base=str(p.get('basePlane', '')), stair=p.get('stair'), thin=p.get('thicknessM', hi - lo) <= 0.06, thick=p.get('thicknessM'), type=p['type'], prof=p.get('topProfile'), inv=p.get('inVoid'), und=p.get('underground')))
FOCUS = tuple(sys.argv[1:]) or ('X22-', 'Z02-EAST-STAIR', 'Z02-PLANTER', 'Z02-DECK', 'Z02-RAILING', 'G03-SWALL', 'G03-SBED', 'G03-SLAB', 'G03-SIDEWALK', 'G03-KERB', 'G03-PAINT-LANE', 'R02-TREE', 'G02-NPLANT-D', 'G03-TREE-ND', 'G03-BARRIER', 'G03-BOLLARD', 'G03-CAFE-RAIL', 'G03-SWALL-LED', 'G02-PODIUM')
def top_at(b, pt):
    if not b['prof']: return b['hi']
    pr = b['prof']; L = np.hypot(*pr['direction']); d = ((pt.x - pr['origin'][0]) * pr['direction'][0] + (pt.y - pr['origin'][1]) * pr['direction'][1]) / L
    return float(np.interp(d, [q[0] for q in pr['points']], [q[1] for q in pr['points']]))
tree = STRtree([b['g'] for b in B])
n = 0; seen = set()
for ia, a in enumerate(B):
    if not a['id'].startswith(FOCUS): continue
    for ib in tree.query(a['g']):
        b = B[ib]
        if ib == ia or (min(ia, ib), max(ia, ib)) in seen: continue
        seen.add((min(ia, ib), max(ia, ib)))
        if a['stair'] and a['stair'] == b['stair']: continue
        if a['base'].startswith(b['id']) or b['base'].startswith(a['id']) or a['id'].startswith(b['id'] + '-') or b['id'].startswith(a['id'] + '-'): continue
        if a['thin'] and b['thin']: continue
        if a['type'] == 'tree' and b['type'] == 'tree' and a['id'].rsplit('-', 1)[0] == b['id'].rsplit('-', 1)[0]: continue
        if not a['g'].intersects(b['g']): continue
        i = a['g'].intersection(b['g'])
        if i.area < 0.05: continue
        c = i.representative_point(); za, zb = top_at(a, c), top_at(b, c)
        la = za - a['thick'] if a['thick'] else a['lo']; lb = zb - b['thick'] if b['thick'] else b['lo']
        ov = min(za, zb) - max(la, lb)
        if ov < 0.05: continue
        if (a['thick'] or b['thick']) and ov <= 0.2: continue
        n += 1; print(f"{a['id']} ({a['file']})  x  {b['id']} ({b['file']}): 평면 {i.area:.2f} ㎡, 높이 {ov:.2f} m")
print('겹침', n)
