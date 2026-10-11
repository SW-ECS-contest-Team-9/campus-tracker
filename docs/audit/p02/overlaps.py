"""P02: 한 네모 안의 구조물 상자끼리 겹치는 곳을 센다(평면 겹침 0.05 ㎡ 넘고 높이도 0.05 m 넘게 겹치는 쌍. 같은 묶음(id 앞 세 마디)은 뺀다).   python overlaps.py X0 Y0 X1 Y1"""
import json, pathlib, sys, collections
from shapely.geometry import shape, box
STR = pathlib.Path(__file__).parents[3] / 'frontend' / 'public' / 'structures'
bb = box(*map(float, sys.argv[1:5])); F = []
for f in sorted(STR.glob('*.geojson')):
    for ft in json.loads(f.read_text(encoding='utf-8'))['features']:
        p = ft['properties']
        if p.get('kind') != 'extrude': continue
        g = shape(ft['geometry']).buffer(0)
        if g.intersects(bb): F.append((f.stem, p, g))
grp = lambda i: '-'.join(i.split('-')[:3]); out = collections.defaultdict(list)
for a in range(len(F)):
    for b in range(a + 1, len(F)):
        fa, pa, ga = F[a]; fb, pb, gb = F[b]
        if grp(pa['id']) == grp(pb['id']): continue
        zo = min(pa['toM'], pb['toM']) - max(pa['fromM'], pb['fromM'])
        if zo <= 0.05: continue
        ar = ga.intersection(gb).area
        if ar > 0.05: out[(grp(pa['id']), grp(pb['id']))].append((round(ar, 2), round(zo, 2), pa['id'], pa['type'], pb['id'], pb['type']))
print(len(F), '상자,', sum(len(v) for v in out.values()), '쌍')
for k, v in sorted(out.items(), key=lambda kv: -sum(o[0] for o in kv[1])): print(k, len(v), '쌍, 넓이', round(sum(o[0] for o in v), 1), '예', v[0])
