"""G03: 구조물 상자끼리 겹치는 곳을 찾는다(사용자 2026-10-12: 흡연장이 높은 화단과 겹쳤다).   python overlaps.py
대상: g02-way.geojson 의 상자 전부 + z02-daeil-front.geojson 의 내려오는 계단 + p01-parts.geojson(본관 서쪽 끝 것만: 이웃이라 견줌).
겹침 = 평면이 0.05 ㎡ 넘게 겹치고 높이 범위도 0.05 m 넘게 겹치는 두 상자. 일부러 얹은 것은 뺀다: 같은 계단의 단, 한쪽이 다른 쪽을 basePlane 으로 적은 것(붙인 판·나무), 두께 6 cm 이하의 바닥 칠 판끼리."""
import json, pathlib, itertools
from shapely.geometry import shape
STR = pathlib.Path(__file__).parents[3] / 'frontend' / 'public' / 'structures'
def load(fn, keep=lambda p: True):
    out = []
    for f in json.loads((STR / fn).read_text(encoding='utf-8'))['features']:
        p = f['properties']
        if p.get('kind') != 'extrude' or not keep(p): continue
        g = shape(f['geometry']).buffer(0); lo, hi = p['fromM'], p['toM']
        if 'topProfile' in p: zs = [q[1] for q in p['topProfile']['points']]; hi = max(zs); lo = min(zs) - p['thicknessM'] if 'thicknessM' in p else p.get('bottomM', lo)
        out.append(dict(id=p['id'], g=g, lo=lo, hi=hi, base=str(p.get('basePlane', '')), stair=p.get('stair'), thin=p.get('thicknessM', hi - lo) <= 0.06, thick=p.get('thicknessM'), type=p['type'], prof=p.get('topProfile')))
    return out
B = load('g02-way.geojson') + load('z02-daeil-front.geojson', lambda p: 'SIDE-STAIR' in p['id']) + load('p01-parts.geojson', lambda p: p['id'].startswith('P01-BONGWAN'))
def top_at(b, pt):
    if not b['prof']: return b['hi']
    pr = b['prof']; d = (pt.x - pr['origin'][0]) * pr['direction'][0] + (pt.y - pr['origin'][1]) * pr['direction'][1]
    import numpy as np
    return float(np.interp(d, [q[0] for q in pr['points']], [q[1] for q in pr['points']]))
n = 0
for a, b in itertools.combinations(B, 2):
    if a['stair'] and a['stair'] == b['stair']: continue
    if a['base'].startswith(b['id']) or b['base'].startswith(a['id']) or a['id'].startswith(b['id'] + '-') or b['id'].startswith(a['id'] + '-'): continue
    if a['thin'] and b['thin']: continue
    if a['id'].split('-')[0] == 'P01' and b['id'].split('-')[0] == 'P01': continue           # 남의 파일끼리는 보지 않는다
    if a['type'] == 'tree' and b['type'] == 'tree' and a['id'].rsplit('-', 1)[0] == b['id'].rsplit('-', 1)[0]: continue   # 한 나무의 줄기와 잎
    if 'BUKAK-PORCH' in a['id'] and 'BUKAK-PORCH' in b['id'] and {a['type'], b['type']} <= {'wall', 'canopy'}: continue   # 현관의 기둥·윗벽 이음
    if not a['g'].intersects(b['g']): continue
    i = a['g'].intersection(b['g'])
    if i.area < 0.05: continue
    c = i.representative_point(); za, zb = top_at(a, c), top_at(b, c)
    la = za - a['thick'] if a['thick'] else a['lo']; lb = zb - b['thick'] if b['thick'] else b['lo']
    ov = min(za, zb) - max(la, lb)
    if ov < 0.05: continue
    if (a['thick'] or b['thick']) and ov <= 0.2: continue     # 바닥 칠 판·인도 판 위에 선 것, 인도 판과 그 턱 띠
    n += 1; print(f"{a['id']}  x  {b['id']}: 평면 {i.area:.2f} ㎡, 높이 {ov:.2f} m")
print('겹침', n)
