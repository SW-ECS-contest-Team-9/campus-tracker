"""Z06: 사진에 나무가 줄지어 보이는 화단에만 단순한 나무(줄기 상자 + 잎 상자 둘)를 얹는다. DB·네트워크 접근 없음.   python trees.py
자리의 근거는 이미 만든 화단 상자·화단 기단(구조물 파일)이다: 나무는 그 화단의 긴 축을 따라 고르게 둔다(그루 수·간격·크기는 추정, 한 그루 한 그루의 실제 자리가 아니다).
쓰는 파일: frontend/public/structures/z06-trees.geojson (형식 docs/audit/g02/STRUCTURES.md, type=tree, material=trunk / foliage)"""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
def load(fn): return {f['properties']['id']: f for f in json.loads((STR / fn).read_text(encoding='utf-8'))['features']}
G02, Z02, WEST = load('g02-way.geojson'), load('z02-daeil-front.geojson'), load('z05-west.geojson')
# (화단 id 들, 화단마다 그루 수, 근거 사진, 무엇)
# G03(2026-10-12): 오르막길 양쪽 화단의 소나무 줄은 화단을 다시 만들면서 g02-way.geojson(docs/audit/g02/build_inputs.py, id G03-TREE-…)으로 옮겼다
ROWS = [
  (G02, ['G02-BUKAK-PLANTER-E'], 1, '사용자-서문·제2주차장·수인관-20261010/10-북악관-정문계단-거리뷰-202502.webp', '북악관 정문 동쪽 화단의 소나무'),
  (Z02, ['Z02-PLANTER-MAIN'], 5, '사용자-공연실습소-은주관-20261010/대일관-현관-계단-가까이.webp, 대일관-운동장에서-정면.webp', '대일관 앞 흰 돌 화단의 소나무 줄'),
  (Z02, ['Z02-PLANTER-EAST'], 2, '사용자-공연실습소-은주관-20261010/대일관-운동장에서-정면.webp', '대일관 앞 화단(동쪽)의 소나무'),
  (Z02, ['Z02-PLANTER-W1', 'Z02-PLANTER-W2'], 1, '사용자-공연실습소-은주관-20261010/대일관-현관-계단-가까이.webp', '대일관 현관 계단 서쪽 화단의 소나무'),
  (WEST, ['Z05-PLATFORM-WEST-WALLTOP-PLANTER'], 8, '사용자-서문-공연실습소-생활관-20261010/서문.jpg, 11-네이버위성-회차공간·오르막길-포장면-사용자표시.webp', '서쪽 옹벽 위 화단 띠의 소나무 줄'),
]
feats = []
def sq(c, h): return {'type': 'Polygon', 'coordinates': [[[r2(c[0] + a * h), r2(c[1] + b * h)] for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1))]]}
def tree(tid, c, z, what, src, base):
    for part, typ, mat, h, z0, z1 in (('TRUNK', 'tree', 'trunk', 0.18, 0.0, 3.0), ('CROWN', 'tree', 'foliage', 1.3, 2.8, 4.2), ('TOP', 'tree', 'foliage', 0.75, 4.2, 5.2)):
        feats.append({'type': 'Feature', 'properties': {'id': f'{tid}-{part}', 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': '확정(이 화단에 나무가 줄지어 있음: 사진), 추정(그루 수·자리·크기)', 'basePlane': base,
            'fromM': r2(z + z0), 'toM': r2(z + z1), 'material': mat, 'assumption': f'{what}: 화단의 긴 축을 따라 고르게 둔 단순한 나무(줄기 0.36 m 각 3 m, 잎 덩어리 2.6 m 각 + 1.5 m 각, 전체 5.2 m). 실제 그루 수·자리·수종의 모양이 아니다', 'source': src}, 'geometry': sq(c, h)})
n = 0
for files, ids, per, src, what in ROWS:
    for pid in ids:
        if pid not in files: print('없음', pid); continue
        f = files[pid]; p = f['properties']; poly = Polygon(f['geometry']['coordinates'][0]); z = p.get('toM', p.get('topM'))
        c = np.array(poly.minimum_rotated_rectangle.exterior.coords)[:4]; e = [np.hypot(*(c[(i + 1) % 4] - c[i])) for i in range(4)]; i = int(np.argmax(e[:2]))
        a, b = (c[i] + c[(i + 3) % 4]) / 2, (c[(i + 1) % 4] + c[(i + 2) % 4]) / 2
        for k in range(per):
            n += 1; tree(f'Z06-TREE-{n:02d}', a + (b - a) * (k + 0.5) / per, z, what, src, pid)
out = {'type': 'FeatureCollection', 'name': 'z06-trees', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/z06/trees.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '사진에 나무 줄이 분명한 화단에만 얹은 단순한 나무. 자리는 화단 상자의 긴 축을 고르게 나눈 것(추정). 근거 없는 곳에는 두지 않는다.'}, 'features': feats}
(STR / 'z06-trees.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('trees', n, 'features', len(feats))
