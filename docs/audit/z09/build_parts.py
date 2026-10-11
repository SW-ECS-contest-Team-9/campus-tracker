"""Z09: 뒤편 숲 비탈의 듬성듬성한 나무와 문예관 3층 로비 입구의 차양을 구조물 상자로 만든다. DB·네트워크 접근 없음.   python build_parts.py
쓰는 파일: frontend/public/structures/z09-parts.geojson (형식 docs/audit/g02/STRUCTURES.md). 전부 estimated.
z05/build_inputs.py 를 다시 돌린 뒤에 돌린다(숲 비탈 기단의 외곽·윗면을 읽는다)."""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon, Point, LineString, shape
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
def load(fn): return {f['properties']['id']: f for f in json.loads((STR / fn).read_text(encoding='utf-8'))['features']}
FEATS = []
def box(id, typ, poly, fromM, toM, assumption, source, grade, basePlane, **extra):
    c = [[r2(x), r2(y)] for x, y in poly.exterior.coords]
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra}, 'geometry': {'type': 'Polygon', 'coordinates': [c]}})
def sq(c, h): return Polygon([(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)])

# ---------- 뒤편 숲 비탈: 듬성듬성한 나무 ----------
BACK = load('z05-back-paths.geojson'); TSRC = '사용자-서문·제2주차장·수인관-20261010/13-SMAP-뒤에서-청운·상승·대일관뒷문-사용자표시.webp(건물 뒤가 나무로 덮인 비탈), 구역 노트 뒤편 산책로와 북악관 옆길'
TG = '확정(나무 덮인 비탈: 사용자 그림 13), 추정(그루 수·자리·크기)'
rng = np.random.default_rng(9)   # 같은 결과가 다시 나오게 고정
for pid in ('Z05-PLATFORM-BACK-BANK-W', 'Z05-PLATFORM-BACK-BANK-E'):
    f = BACK[pid]; poly = shape(f['geometry']).buffer(0); pr = f['properties']['topProfile']; o, d, pts = np.array(pr['origin']), np.array(pr['direction']), np.array(pr['points'])
    top = lambda x, y: float(np.interp((x - o[0]) * d[0] + (y - o[1]) * d[1], pts[:, 0], pts[:, 1]))
    inner = poly.buffer(-3.5); x0, y0, x1, y1 = inner.bounds; k = 0
    for gx in np.arange(x0, x1, 8.5):
        for gy in np.arange(y0, y1, 8.5):
            c = (gx + rng.uniform(-2.5, 2.5), gy + rng.uniform(-2.5, 2.5))
            if not inner.contains(Point(c)): continue
            k += 1; z = top(*c); s = rng.uniform(0.9, 1.35)   # 크기를 조금씩 다르게
            for part, mat, h, z0, z1 in (('TRUNK', 'trunk', 0.2, 0.0, 3.2), ('CROWN', 'foliage', 1.5, 3.0, 5.0), ('TOP', 'foliage', 0.9, 5.0, 6.3)):
                box(f"Z09-{pid[-6:]}-TREE-{k:02d}-{part}", 'tree', sq(c, h * s), z + z0 * s, z + z1 * s, '뒤편 숲 비탈의 나무: 약 8.5 m 간격으로 흩어 놓은 단순한 나무(실제 그루 수·자리가 아니다. 숲은 훨씬 빽빽하다)', TSRC, TG, pid, material=mat)
    print(pid, k, 'trees')

# ---------- 문예관 3층 로비 입구(입구(1))의 차양 ----------
A, B = np.array([201097.25, 557335.75]), np.array([201108.75, 557330.75])   # 저층부 옥상 정원 띠(추가-문예관저층부)의 길 쪽 변
u = (B - A) / np.hypot(*(B - A)); n = np.array([u[1], -u[0]]); assert n[1] < 0   # 길 쪽(남남서)
door = np.array([201102.0, 557338.5]); s = float((door - A) @ u)
MSRC = '사용자-출입구·주차장-20261010/09-문예관입구1-3층로비-캠퍼스맵.webp(굽은 유리 저층부에서 문 위로 내민 톱니 모양 차양), 동 노트 문예관(입구(1) 201102.0, 557338.5, 3층 로비 144.8 추정)'
MG = '확정(문 위로 내민 차양이 있음: 학교 캠퍼스맵 사진), 추정(자리 = 입구 표지를 저층부 길 쪽 변에 내린 곳, 폭 6 m·내민 길이 2.4 m·높이 148.0 m)'
R = lambda s0, s1, d0, d1: Polygon([A + u * s0 + n * d0, A + u * s1 + n * d0, A + u * s1 + n * d1, A + u * s0 + n * d1])
box('Z09-MUNYE-3F-CANOPY', 'canopy', R(s - 3.0, s + 3.0, -0.1, 2.4), 148.0, 148.45, '문예관 3층 로비 입구 위의 차양: 저층부 유리 벽에서 길 쪽으로 2.4 m 내민 판(폭 6 m, 문 바닥 144.8 m 위 3.2 m). 사진의 톱니 모양은 한 판으로 그림', MSRC, MG, '없음(추가-문예관저층부 벽에 붙음)', color='#c9cdca')
box('Z09-MUNYE-3F-DOOR', 'wall', R(s - 1.6, s + 1.6, -0.02, 0.1), 144.8, 147.8, '3층 로비 입구의 큰 자동문 면(폭 3.2 m, 높이 3.0 m: 천장이 매우 높은 로비의 문, 추정). 벽면의 문 자리를 나타내는 어두운 판', MSRC, MG, '추가-문예관저층부 길 쪽 벽', material='opening')
out = {'type': 'FeatureCollection', 'name': 'z09-parts', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/z09/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '뒤편 숲 비탈의 나무(자리 추정)와 문예관 3층 로비 입구의 차양·문 면(치수 추정). 사진에 있는 것만.'}, 'features': FEATS}
(STR / 'z09-parts.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print('features', len(FEATS))
