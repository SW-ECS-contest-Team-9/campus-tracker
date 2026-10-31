"""TP1(2026-10-25): R6 의 상승관·청운관 뒤 단(R6-PLATFORM-BEHIND-SANGSEUNG)이 대일관·상승관 뒤 기단(Z05-PLATFORM-BACK-BEHIND-DAEIL-E)과
572 ㎡ 겹친 채로 남은 것을 정리한다. R6 는 숲 비탈 BANK-E 에서만 그 자리를 뺐고(0.5 m 는 새 단 밑으로 겹침), R6 지형 입력에서는 새 단이
그 자리를 가졌다(판독: S-MAP 지면 148.0~149.1). BEHIND-DAEIL-E 에서도 새 단 자리를 뺀다. 이 자리에서는 BEHIND-DAEIL-E 가 새 단보다 0.6~0.8 m 높아(높은 쪽이 낮은 쪽 밑으로
들어가지 않는 Z05 규칙) 겹침 띠를 두지 않고 새 단 외곽에서 벽면으로 만나게 한다.
다시 돌려도 같다. DB·네트워크 접근 없음.   python docs/audit/tp1/cut_daeil_e.py [--dry]"""
import json, pathlib, sys
from shapely.geometry import Polygon, shape

DRY = '--dry' in sys.argv
STR = pathlib.Path(__file__).resolve().parents[3] / 'frontend' / 'public' / 'structures'
FN, ID, NEW_ID = 'z05-back-paths.geojson', 'Z05-PLATFORM-BACK-BEHIND-DAEIL-E', 'R6-PLATFORM-BEHIND-SANGSEUNG'
NOTE = f' [TP1 2026-10-25: {NEW_ID} 자리를 뺌(겹침 없이 벽면으로 만남)]'
r2 = lambda v: round(float(v), 2)

def ring1(coords, ccw):
    p = []
    for x, y in list(coords)[:-1]:
        q = [r2(x), r2(y)]
        if not p or q != p[-1]: p.append(q)
    if p[0] == p[-1]: p.pop()
    if Polygon(p).exterior.is_ccw is not ccw: p = p[::-1]
    return p + [p[0]]

doc = json.loads((STR / FN).read_text(encoding='utf-8'))
sg = [shape(f['geometry']) for f in json.loads((STR / 'r6-back.geojson').read_text(encoding='utf-8'))['features'] if f['properties']['id'] == NEW_ID][0].buffer(0)
ft = [f for f in doc['features'] if f['properties']['id'] == ID][0]
g0 = shape(ft['geometry']).buffer(0)
if g0.intersection(sg).area < 0.5: print(f'{ID}: 이미 뺐음'); sys.exit(0)
gs = sorted((q for q in getattr(g0.difference(sg).buffer(0), 'geoms', [g0.difference(sg).buffer(0)]) if q.area >= 0.5), key=lambda q: -q.area)
geom = lambda g: {'type': 'Polygon', 'coordinates': [ring1(g.exterior.coords, True)] + [ring1(r.coords, False) for r in g.interiors if Polygon(r).area > 0.05]}
ft['geometry'] = geom(gs[0])
p = ft['properties']; p['assumption'] = p.get('assumption', '').split(' [TP1')[0] + NOTE
for k, g in enumerate(gs[1:]):   # 새 단이 가로질러 떨어진 조각: 기존 관례대로 -b, -c … 기단으로(빈 틈이 생기지 않게)
    sfx = '-' + chr(98 + k); q = json.loads(json.dumps(ft)); q['geometry'] = geom(g)
    q['properties']['id'] = ID + sfx; q['properties']['surfaceName'] = p['surfaceName'] + sfx
    doc['features'].insert(doc['features'].index(ft) + 1 + k, q)
    print(f'떨어진 조각 {ID + sfx}: {g.area:.1f} ㎡')
on = [f['properties']['id'] for f in doc['features'] if f['properties'].get('basePlane') == ID and sg.buffer(-0.5).contains(shape(f['geometry']).centroid)]
print(f'{ID}: {g0.area:.1f} -> {shape(ft["geometry"]).area:.1f} ㎡, 겹침 {shape(ft["geometry"]).intersection(sg).area:.1f} ㎡; 새 단 안에 선 상자 {on}')
if not DRY: (STR / FN).write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
