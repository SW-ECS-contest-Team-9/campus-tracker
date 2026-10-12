"""B14 상승관: 건물 자료(외곽·지붕)에 못 싣는 것을 구조물 상자로, 안쪽 마당 기단을 새 건물 외곽에 맞춘다. DB·네트워크 접근 없음.   python build_parts.py
쓰는 파일: frontend/public/structures/b14-sangseung.geojson (형식 docs/audit/g02/STRUCTURES.md)
고치는 파일: frontend/public/structures/z02-daeil-front.geojson 의 Z02-PLATFORM-YARD 외곽만(화면용 기단. 건물 안으로 0.44 m 들어가 있던 북쪽 끝을 벽 선에서 자른다).
  지형 조리법 입력(backend/data/terrain/recipes/z02-surface.geojson)은 그대로 둔다: 잘린 띠(1.8 ㎡)는 건물 안이라 지형 칸이 보이지 않고, 지형 id 가 바뀌지 않는다."""
import json, pathlib
from shapely.geometry import Polygon, shape, mapping
from frame import *
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'; HERE = pathlib.Path(__file__).parent
P = json.loads((HERE / 'parts.json').read_text(encoding='utf-8'))
r2 = lambda v: round(float(v), 2)
def geom(poly): return {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in poly.exterior.coords]]}
def rect(s0, s1, d0, d1): return Polygon([W(s0, d0), W(s1, d0), W(s1, d1), W(s0, d1)])
FEATS = []
def box(id, typ, poly, fromM, toM, assumption, grade, basePlane, **extra):
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': SRC, **extra}, 'geometry': geom(poly)})
SRC = 'S-MAP 건물 모델 0.5 m 격자(볼트 3d-map-audit-20261009/b14/smap-mesh-b14-sangseung-05m.txt, docs/audit/b14/parts.json), 사용자-상승관-SMAP-20261012/01·02'
ROOF, RIM, T = 163.1, 164.8, 0.15
G = 'S-MAP(난간 윗선 164.8 m: 66칸), 확정(평지붕 둘레에 난간: 사용자 S-MAP 화면), 추정(두께·재질)'
# 본체 지붕 둘레 난간: 북쪽·서쪽·대일관 쪽 세 변(동쪽은 더 높은 동쪽 끝 덩어리의 벽)
for tag, poly in (('N', rect(S_W, BLOCK_S, D_N, D_N + T)), ('S', rect(S_W, BLOCK_S, D_S - T, D_S)), ('W', rect(S_W, S_W + T, D_N, D_S))):
    box(f'B14-SANG-PARAPET-{tag}', 'wall', poly, ROOF, RIM, '상승관 본체 평지붕 둘레의 난간. S-MAP 화면에는 살이 있는 유리 난간처럼 보인다(한 장의 판으로 그림)', G, '추가-상승관 지붕 163.1', material='glass')
# 숲 쪽 벽 발치의 밝은 턱
box('B14-SANG-NORTH-LEDGE', 'wall', rect(S_W - 0.6, S_E_N + 0.3, D_N - 1.0, D_N), 147.4, 149.2,
    '상승관 숲 쪽 벽 발치를 따라 보이는 밝은 턱(옹벽 머리 또는 좁은 통로). 폭 1.0 m·윗면 149.2 m 는 눈대중(벽 앞 S-MAP 지면 148.4~148.9 m)', '확정에 준함(밝은 띠가 있음: 사용자 S-MAP 화면 2장), 추정(폭·높이·무엇인지)', 'Z05-BACK-BEHIND-DAEIL-E', material='white_stone')
# 대일관 뒷벽과 상승관 사이의 좁은 틈(1.15 m)의 바닥
box('B14-SANG-DAEIL-SLIT-FLOOR', 'landing', rect(-18.57, DAEIL_STEP_S, D_S, DAEIL_FAR), 147.4, 152.3,
    '대일관 뒷벽과 상승관 사이의 좁은 틈(폭 1.15 m, 길이 17 m)의 바닥. S-MAP 지면 152.2~152.4 m(78칸). 사람이 다니는지는 모른다(길을 넣지 않았다)', 'S-MAP(틈의 폭과 바닥 높이, ±0.5 m)', 'Z05-BACK-BEHIND-DAEIL-E', material='concrete')
out = {'type': 'FeatureCollection', 'name': 'b14-sangseung', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/b14/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '상승관(건물 추가 추가-상승관·추가-상승관동쪽끝)에 붙는 것: 지붕 난간, 숲 쪽 발치의 밝은 턱, 대일관과의 좁은 틈 바닥. 건물 외곽·지붕은 건물 보정 파일에 있다'}, 'features': FEATS}
(STR / 'b14-sangseung.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(len(FEATS), 'features')

# 안쪽 마당 기단(화면용)을 새 외곽에 맞춘다
roofs = json.loads((REPO / 'backend/data/scene/overrides/building-roofs.json').read_text(encoding='utf-8'))
polys = [Polygon(a['polygon'][0]) for a in roofs['added'] if a['id'].startswith(('추가-상승관', '추가-청운관'))]
polys += [Polygon(p['polygon'][0]) for e in roofs['parts'] if e['name'] == '대일관' for p in e['parts']]
assert len(polys) == 4, len(polys)
f = STR / 'z02-daeil-front.geojson'; d = json.loads(f.read_text(encoding='utf-8')); yard = next(x for x in d['features'] if x['properties']['id'] == 'Z02-PLATFORM-YARD')
g = shape(yard['geometry']).buffer(0); before = g.area
g = g.union(Polygon([[201216.71, 557306.86], P['daeilBackWall']['ring'][-1], [201219.15, 557307.7], [201218.54, 557306.01]]).convex_hull)   # 옛 외곽 모서리가 남긴 홈(1 ㎡)을 메운다: 마당은 대일관 동쪽 끝 벽에서 상승관 벽까지
for q in polys: g = g.difference(q.buffer(0))
if g.geom_type != 'Polygon': g = max(g.geoms, key=lambda x: x.area)
g = g.buffer(-0.02).buffer(0.02, join_style=2).simplify(0.02)
if abs(g.area - before) > 0.05:
    yard['geometry'] = geom(g); p = yard['properties']
    p['assumption'] = p['assumption'].split(' B14:')[0] + ' B14: 북쪽 끝을 상승관 동쪽 끝 덩어리의 벽·청운관 북서 낮은 부분·대일관 뒷벽 선에서 잘랐다(S-MAP 0.5 m 격자). 지형 입력 z02-surface 는 그대로(잘린 띠는 건물 안)'
    f.write_text(json.dumps(d, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('yard', round(before, 1), '->', round(g.area, 1), 'overlap with buildings', round(sum(g.intersection(q).area for q in polys), 3))
