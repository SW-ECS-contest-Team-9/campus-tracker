"""문예관 고층부 평면 정리(직선 벽) + 저층부 분리 후보. 정확도 주장 없음.

MY-T(v1)는 2 m 격자 지붕 표본 셀 ∩ 원외곽선이라 벽이 셀 계단 모양이다. 격자 지붕 표본은 지붕 위 점이지 벽 위치가 아니다(한계).
여기서는 원외곽선(직선 8변)을 고층부 벽 방향의 근거로 쓰고, 셀 면적과 같은 면적이 되도록 외곽선을 일정 거리 d만큼 안쪽으로 줄인다.
저층부(MY-L)는 외곽선 남쪽 바깥 148.8 저층 표본 셀(2 m)의 합집합을 외곽선과 겹치지 않게 둔다.
사용: python build_munye_clean.py <문예관고층부 폴더> <repo-root>
"""
import hashlib, json, sys
from pathlib import Path
import numpy as np
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

SRC, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
v1 = json.loads((ROOT / 'frontend/public/corrections/munye-highrise-v1.geojson').read_text(encoding='utf-8'))
T = shape(v1['features'][0]['geometry'])
O = shape({'type': 'MultiPolygon', 'coordinates': [b for b in json.loads((ROOT / 'docs/audit/m16/preview/data/building-outlines-5186.json').read_text(encoding='utf-8')) if b['name'] == '문예관'][0]['coordinates']}).geoms[0]

# 셀 면적과 같아지는 안쪽 이격 d (이분법)
lo, hi = 0.0, 3.0
for _ in range(40):
    d = (lo + hi) / 2
    if O.buffer(-d, join_style=2).area > T.area:
        lo = d
    else:
        hi = d
clean = O.buffer(-d, join_style=2)
haus = clean.hausdorff_distance(T)
sym = clean.symmetric_difference(T).area

cls_raw = (SRC / 'munye-sample-class-5186.geojson').read_bytes()
cls = json.loads(cls_raw)
low_cells = [f['geometry']['coordinates'] for f in cls['features'] if f['properties']['class'] == '저층 날개' and abs(f['geometry']['coordinates'][2] - 148.8) < 0.01]
L = unary_union([box(x - 1, y - 1, x + 1, y + 1) for x, y, _ in low_cells]).difference(O)
m = json.loads((ROOT / 'docs/audit/m16/preview/data/terrain-grid-meta.json').read_text())
G = np.fromfile(ROOT / 'docs/audit/m16/preview/data/terrain-grid.f32', dtype='<f4').reshape(m['height'], m['width'])
dem = [float(G[int(round((y - m['originY']) / 2)), int(round((x - m['originX']) / 2))]) for x, y, _ in low_cells]
base_low = round(min(dem), 2)

def rnd(g):
    return json.loads(json.dumps(mapping(g)), parse_float=lambda s: round(float(s), 3))

fc = {'type': 'FeatureCollection', 'name': 'munye-highrise-v2', 'crs': v1['crs'],
      'provenance': {**v1['provenance'], 'sample_class_sha256': hashlib.sha256(cls_raw).hexdigest(), 'generator': 'docs/audit/munye/build_munye_clean.py',
                     'limit': 'MY-T-CLEAN은 외곽선 정리(톱니 완화) 추정값이다. 격자 지붕 표본(2 m)은 지붕 위 점이며 벽 위치 근거가 아니다. 벽 방향은 원외곽선 직선, 위치는 셀 면적과 같게 하는 조건으로만 정함(면적 일치는 정확도 검증 아님) — 실측 정확도 주장 없음, 사진 외벽 대응 미실시'},
      'features': [
          {'type': 'Feature', 'properties': {'id': 'MY-T-CLEAN', 'type': 'high_rise', 'buildingId': '문예관', 'kind': 'extrude', 'fromM': 153.238, 'toM': 189.4, 'estimated': True,
                                             'assumption': f'벽 = 원외곽선 직선을 안쪽 {d:.2f} m 평행 이동(셀 면적 {T.area:.1f} m²와 같게). 셀 윤곽과 하우스도르프 {haus:.2f} m, 대칭차 {sym:.1f} m²',
                                             'source': 'MY-T(S-MAP 고층 지붕 표본 셀) 면적 + building-outlines 문예관 외곽선 방향; 상단 189.4 = S-MAP 지붕 z 중앙값'},
           'geometry': rnd(clean)},
          {'type': 'Feature', 'properties': {'id': 'MY-L-ROOF', 'type': 'low_wing', 'kind': 'surface', 'estimated': True,
                                             'assumption': f'저층부 지붕 면만(148.8). 평면 = 148.8 저층 표본 2 m 셀 {len(low_cells)}개 합집합 − 원외곽선(실제 벽 아님). 하부 벽·기둥·바닥은 미생성: 사진25(문예관 하행)에 경로 쪽 1층 차양·상가 벽이 보이나 이 셀들과의 평면 대응 근거 없음, 사진30·영상 01:20도 위치 대응 불가 → 하부 공간을 채우지 않음',
                                             'source': 'munye-sample-class-5186.geojson 저층 날개 표본(S-MAP 148.8)'},
           'geometry': {'type': 'Polygon', 'coordinates': [[[round(x, 3), round(y, 3), 148.8] for x, y in L.exterior.coords]]}},
      ]}
(ROOT / 'frontend/public/corrections/munye-highrise-v2.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')
print(f'd={d:.3f} cells={T.area:.1f} clean={clean.area:.1f} 변화={clean.area - T.area:+.1f} 하우스도르프={haus:.2f} 대칭차={sym:.1f} 꼭짓점 {len(T.exterior.coords) - 1}→{len(clean.exterior.coords) - 1}')
print(f'MY-L 지붕 면적={L.area:.1f} 셀={len(low_cells)} (DEM 최소 {base_low}는 바닥 근거가 아니어서 쓰지 않음)')
print(f'비교(면적 일치는 정확도 아님): 원외곽선 {O.area:.1f} / 셀 {T.area:.1f} / 직선 {clean.area:.1f} m²; 하우스도르프 원-셀 {O.hausdorff_distance(T):.2f}, 원-직선 {O.hausdorff_distance(clean):.2f}, 셀-직선 {haus:.2f} m; 대칭차 원-셀 {O.symmetric_difference(T).area:.1f}, 셀-직선 {sym:.1f} m²')
