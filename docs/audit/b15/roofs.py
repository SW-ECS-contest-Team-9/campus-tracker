"""B15 대일관 지붕 윗면(초록 평지붕)과 옥상 설비. DB·네트워크 접근 없음.   python roofs.py
쓰는 파일: frontend/public/structures/b15-roofs.geojson. 건물 외곽은 건물 보정 파일(동 노트 대일관)에서 읽는다."""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon
REPO = pathlib.Path(__file__).parents[3]; r2 = lambda v: round(float(v), 2)
roofs = json.loads((REPO / 'backend/data/scene/overrides/building-roofs.json').read_text(encoding='utf-8'))
part = next(p for e in roofs['parts'] if e['name'] == '대일관' for p in e['parts']); body = Polygon(part['polygon'][0]); ROOF = part['roofM'] + 2.0   # 겉모습의 모임지붕(오름 4.0)은 저장된 지붕 높이 172.1 을 가운데로 벽 꼭대기 170.1 ~ 윗면 174.1 로 그려진다(building-appearance.ts wallTopM)
SRC = '사용자-SMAP-건물전후면-20261012/02-SMAP-대일관뒷면-청운관-문예관-북악관-동쪽에서.webp, 건물 노트 대일관 B15 절'
FEATS = []
def box(id, typ, poly, fromM, toM, assumption, grade, **extra):
    FEATS.append({'type': 'Feature', 'properties': {'id': 'B15-DAEIL-' + id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': f'건물 대일관의 그려지는 지붕 윗면 {ROOF}', 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': SRC, **extra},
                  'geometry': {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in poly.exterior.coords]]}})
top = body.buffer(-2.2, join_style=2)
if top.geom_type != 'Polygon': top = max(top.geoms, key=lambda g: g.area)
top = top.simplify(0.05)
box('ROOF-GREEN', 'landing', top, ROOF - 0.1, ROOF + 0.15, '지붕 윗면의 초록 평지붕(가장자리 기와 비탈 안쪽). 그려지는 지붕 윗면(174.1 m) 위의 얇은 판', 'S-MAP(화면: 긴 초록 평지붕), 추정(가장자리에서 2.2 m 안쪽)', color='#4fae7c')
mr = body.minimum_rotated_rectangle; c = np.array(mr.exterior.coords)[:4]; e = [c[1] - c[0], c[2] - c[1]]; long = max(e, key=np.linalg.norm); L = float(np.linalg.norm(long)); u = long / L
if u[0] < 0: u = -u                      # u = 서쪽 끝 -> 동쪽 끝
n = np.array([-u[1], u[0]])              # 뒷면(북동, 숲) 쪽
o = np.array(body.centroid.coords[0]); smax = max((np.array(p) - o) @ u for p in body.exterior.coords)
GU = 'S-MAP(화면: 흰 옥상 설비 둘과 작은 설비), 추정(자리는 화면에서 잰 비, 크기·높이)'
for name, t, w, d, h, col in (('UNIT-1', 0.59, 6.0, 5.0, 3.5, '#eceeee'), ('UNIT-2', 0.71, 6.0, 5.0, 3.5, '#eceeee'), ('UNIT-SMALL', 0.12, 3.0, 2.0, 1.2, '#8b8f90')):
    q = o + u * (smax - t * L) + n * 1.5
    poly = Polygon([q + u * a + n * b for a, b in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))])
    assert top.contains(poly), name
    box(name, 'wall', poly, ROOF, ROOF + h, f'옥상 설비(동쪽 끝에서 건물 길이의 {t} 자리, 뒷면 쪽으로 1.5 m)', GU, color=col)
out = {'type': 'FeatureCollection', 'name': 'b15-roofs', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/b15/roofs.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': '대일관 지붕 윗면과 옥상 설비(표시 전용)'}, 'features': FEATS}
(REPO / 'frontend/public/structures/b15-roofs.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(len(FEATS), 'features, length', round(L, 1))
