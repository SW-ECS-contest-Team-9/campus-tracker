"""CT-M15 — user statement "북악관 B1 is clearly lower than the walking path behind the building" vs model floor hypotheses.

The path is not located; DEM beside each footprint side is kept as a reference only and no consistency
verdict is made (pathLocationVerified=false, phoneHeightAssumed=true, absoluteFloorVerified=false). Ground beside each side comes from the 2015 DEM only
(known to be 5-10 m off near the sports field), so results are tendencies, not values. No step height is generated.
  H0  model label: '북악관 B1' corridors at Z 132.8 (= raw phone height of walk level L1) are B1.
  H1  BM-1: Z 132.8 is 1F; B1 is a lower level not in the walk (CX-04 GS25 '지하 1층' door below the side path).

  python bukak_b1_constraint.py <audit-dir> <out.json>
"""
import json, sys, math, pathlib
import numpy as np
from shapely.geometry import Point, Polygon, LineString
from shapely.ops import unary_union

audit = pathlib.Path(sys.argv[1]); load = lambda p: json.loads(p.read_text(encoding='utf-8'))
meta = load(audit / 'terrain-grid-meta.json'); res = meta['resolution']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])
PHONE_M, MODEL_B1_Z = 1.0, 132.8


def ground(x, y):
    fx = (x - meta['originX']) / res - 0.5; fy = (y - meta['originY']) / res - 0.5
    i, j = int(math.floor(fx)), int(math.floor(fy)); tx, ty = fx - i, fy - j
    return float(dem[j, i] * (1 - tx) * (1 - ty) + dem[j, i + 1] * tx * (1 - ty) + dem[j + 1, i] * (1 - tx) * ty + dem[j + 1, i + 1] * tx * ty)


B = unary_union([Polygon(p[0], p[1:]) for o in load(audit / 'building-outlines-5186.json') if o['name'] == '북악관' for p in o['coordinates']])
sides = []
ring = list(B.exterior.coords)
for (ax, ay), (bx, by) in zip(ring, ring[1:]):
    l = math.hypot(bx - ax, by - ay)
    if l < 15: continue
    mx, my = (ax + bx) / 2, (ay + by) / 2; nx, ny = (by - ay) / l, -(bx - ax) / l
    if B.contains(Point(mx + nx, my + ny)): nx, ny = -nx, -ny
    ang = math.degrees(math.atan2(ny, nx))
    name = {0: '동', 90: '북', 180: '서', -90: '남'}[min((0, 90, 180, -90), key=lambda a: min(abs(ang - a), 360 - abs(ang - a)))]
    g = [round(ground(mx + nx * k, my + ny * k), 2) for k in (3, 8, 15)]
    sides.append({'side': name, 'edgeLengthM': round(l), 'demOutward3_8_15m': g})

# floor Z of the hypotheses (relative; L1 floor = raw phone height - 1 m)
l1_floor = MODEL_B1_Z - PHONE_M
hyp = {'H0_modelB1_is_L1': {'b1FloorApprox': round(l1_floor, 1), 'note': 'B1 = walk level L1'},
       'H1_BM1_L1_is_1F': {'b1FloorApprox': None, 'note': 'B1 below L1 by one storey (value not generated)'}}
rows = []
for s in sides:  # surrounding-DEM reference only: the real path is not located, so no consistency verdict is produced
    rows.append({**s, 'H0': '미판정 (산책로 위치 미대응; 주변 DEM 표본은 길 높이가 아님)',
                 'H1': '미판정 (B1 고도 없음; 한 층 아래라는 가정은 증명 아님)'})
report = {'statement': 'B1 < 실제 뒤편 산책로 (사용자, 정성적) — 제약 그대로 유지', 'pathLocationVerified': False, 'phoneHeightAssumed': True,
          'absoluteFloorVerified': False, 'thresholdUsed': None,
          'demCaveat': '2015 DEM, 운동장 주변 5-10 m 오차 사례 있음. 표본은 조사 참고용이며 BM-1 지지/기각 증거가 아님',
          'hypotheses': hyp, 'sidesSurroundingDemReference': rows}
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
print('verdict: 미판정', [(r['side'], r['demOutward3_8_15m']) for r in rows])
