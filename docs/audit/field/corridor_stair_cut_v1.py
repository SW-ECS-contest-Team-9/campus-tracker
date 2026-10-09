"""사잇길 면(SF-CORRIDOR) 계단 자리 국소 절단 후보 — 'S-MAP 경사면' 대 '계단 후보' 비교용 (DB·DEM 불변).

S-MAP 사잇길 면은 계단을 경사로처럼 매끈하게 덮었을 가능성이 있어, 현재 추정 계단(ST-DAEIL-EXIT-SIDE, ST-A14)의
평면 + 0.3 m 여유 안에서만 사잇길 면을 잘라낸 대체 면과 구멍 가장자리 렌더 연결면을 만든다.
v6 제안 위치(이동 10.5/12 m, 미검증)는 계단 형상이 없으므로 자르지 않고 경사면을 유지한다(제안 선만 표시).
사용: python corridor_stair_cut_v1.py <repo-root>
"""
import hashlib, json, sys
from pathlib import Path
import numpy as np
from shapely.geometry import MultiPolygon, Point, Polygon, shape
from shapely.ops import unary_union

ROOT = Path(sys.argv[1])
OUT = ROOT / 'frontend/public/corrections'
v3_raw = (OUT / 'field-surfaces-v3.geojson').read_bytes()
v3 = json.loads(v3_raw)
COR = [f for f in v3['features'] if f['properties']['id'] == 'SF-CORRIDOR'][0]
cpts = np.array(COR['geometry']['coordinates'][0])
CP = Polygon(cpts[:, :2]).buffer(0)
est = json.loads((OUT / 'field-structures-est-v1.geojson').read_text(encoding='utf-8'))
MARGIN = 0.3


def zc(x, y):
    d = np.hypot(cpts[:, 0] - x, cpts[:, 1] - y)
    k = int(np.argmin(d))
    if d[k] < 1e-6:
        return float(cpts[k, 2])  # 원 정점은 원값 그대로
    w = 1 / d ** 2
    return float((w * cpts[:, 2]).sum() / w.sum())


zones, lines = {}, []
for sid in ('ST-DAEIL-EXIT-SIDE', 'ST-A14'):
    polys = [Polygon(f['geometry']['coordinates'][0]) for f in est['features'] if str(f['properties'].get('stair', '')).startswith(sid)]
    fp = unary_union(polys)
    zmin = min(f['properties']['fromM'] for f in est['features'] if str(f['properties'].get('stair', '')).startswith(sid))
    zones[sid] = (fp, zmin)
holes = unary_union([fp.buffer(MARGIN, join_style=2) for fp, _ in zones.values()]).intersection(CP)
cut = CP.difference(holes)
parts = [p for p in getattr(cut, 'geoms', [cut]) if p.area > 0.01]


def ring3(r):
    return [[round(x, 3), round(y, 3), round(zc(x, y), 3)] for x, y in r.coords]


feats = [{'type': 'Feature', 'properties': {
    'id': 'SF-CORRIDOR-STAIRCUT', 'type': 'corridor_cut', 'kind': 'surface', 'replaces': 'SF-CORRIDOR', 'estimated': True,
    'assumption': f'계단 후보: 현재 추정 계단(ST-DAEIL-EXIT-SIDE·ST-A14) 평면 + {MARGIN} m 안만 사잇길 면을 잘라냄. 나머지 정점 z는 SF-CORRIDOR 원값, 새 구멍 가장자리 z는 원 정점 IDW',
    'source': 'field-surfaces-v3 SF-CORRIDOR(S-MAP) + field-structures-est-v1 계단 평면'},
    'geometry': {'type': 'MultiPolygon', 'coordinates': [[ring3(p.exterior), *[ring3(h) for h in p.interiors]] for p in parts]}}]
for sid, (fp, zmin) in zones.items():
    h = fp.buffer(MARGIN, join_style=2).intersection(CP)
    for k, g in enumerate(getattr(h, 'geoms', [h]), 1):
        if g.area < 0.01:
            continue
        r = g.exterior
        pts = [r.interpolate(t * r.length / max(4, int(np.ceil(r.length)))) for t in range(max(4, int(np.ceil(r.length))) + 1)]
        top = [round(zc(p.x, p.y), 3) for p in pts]
        feats.append({'type': 'Feature', 'properties': {
            'id': f'CUT-EDGE-{sid}-{k}', 'type': 'render_connection_face', 'kind': 'skirt', 'estimated': True, 'verifiedWall': False,
            'otherZ': [zmin] * len(pts),
            'assumption': f'렌더 연결면(벽 아님): 잘린 사잇길 면 가장자리 z ↔ 계단 최저 z {zmin}(운영 DRAFT 기반 추정 계단)', 'source': 'SF-CORRIDOR z(S-MAP) + 추정 계단 z'},
            'geometry': {'type': 'LineString', 'coordinates': [[round(p.x, 3), round(p.y, 3), t] for p, t in zip(pts, top)]}})
        lines.append(f'{sid} 절단 {g.area:.1f} m² (계단 평면 {fp.area:.1f} m² + 여유 {MARGIN} m, 사잇길 안), 사잇길 z 범위 {min(top):.2f}~{max(top):.2f}, 계단 최저 {zmin} → 후보 "계단 후보"')

fc = {'type': 'FeatureCollection', 'name': 'corridor-stair-cut-v1', 'crs': v3['crs'],
      'provenance': {'source': 'frontend/public/corrections/field-surfaces-v3.geojson SF-CORRIDOR + field-structures-est-v1', 'sha256': hashlib.sha256(v3_raw).hexdigest(),
                     'generator': 'docs/audit/field/corridor_stair_cut_v1.py', 'status': '비교 후보(추정). 숨겨진 계단을 구현 완료로 세지 않음'},
      'features': feats}
(OUT / 'corridor-stair-cut-v1.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')

# 검사
newA = sum(p.area for p in parts)
lines.append(f'사잇길 면적 원 {CP.area:.1f} → 절단 {newA:.1f} m² (차 {CP.area - newA:.1f} = 구멍 {holes.area:.1f})')
outside = CP.difference(holes.buffer(0.01))
mism = 0
for x, y, z in cpts:
    if outside.contains(Point(x, y)):
        hit = any(abs(c[0] - x) < 1e-6 and abs(c[1] - y) < 1e-6 and abs(c[2] - z) < 1e-6 for part in feats[0]['geometry']['coordinates'] for ring in part for c in ring)
        mism += not hit
lines.append(f'구역 밖 원 정점 유지(x,y,z 일치): 불일치 {mism}')
allstairs = unary_union([fp for fp, _ in zones.values()])
ov = cut.intersection(allstairs).area
lines.append(f'잘린 사잇길 면 × 추정 계단 평면 겹침: {ov:.3f} m² (허용 0.01)')
lines.append('v6 제안 위치(ST-DAEIL-EXIT-SIDE 하단 10.5 m·ST-A14 하단 12 m 이동): 계단 형상 없음 → 자르지 않음, "S-MAP 경사면" 유지 + 제안 선만')
(ROOT / 'docs/audit/field/corridor-stair-cut-checks.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('\n'.join(lines))
