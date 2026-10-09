"""사잇길 내부 표본 TIN(다른 작업자: corridor-surface-v4/v5) → 앱 보정 레이어 파일 + 렌더 조각 JSON.

- SF-CORRIDOR-TIN: 표면 조각(삼각형 또는 v5처럼 경계에서 잘린 평면 다각형)을 그대로 MultiPolygon 평면 조각으로 둠 → Cesium 렌더 z = 조각 평면.
  Corrected를 켜면 경계 정점만 있던 SF-CORRIDOR(v3)를 대체(replaces). v3 파일은 비교용으로 남음.
- 빈칸: 채우지 않고 선(미검증)으로만. 빈칸 꼭짓점에 z가 없으면(v5) 그 꼭짓점이 닿는 같은 면 조각 평면에서 표시용 z를 계산하고, 닿는 조각이 없는 꼭짓점은 버림.
- 모든 좌표는 3차원이어야 함(all(len(point) >= 3)); 아니면 그 피처를 빼고 개수를 provenance에 남김(임의 고도 금지).
- 출력: frontend/public/corrections/corridor-surface-<ver>.geojson, <pieces.json>(cut_from_render_tris.py 입력: 조각 꼭짓점 목록)
사용: python integrate_corridor_v4.py <운동장구조 폴더> <repo-root> <pieces.json> [v4|v5]
"""
import hashlib, json, sys
from pathlib import Path
import numpy as np
from shapely.geometry import Point, Polygon

SRC, ROOT, OUTP = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
VER = sys.argv[4] if len(sys.argv) > 4 else 'v5'
raw = (SRC / f'corridor-surface-{VER}.geojson').read_bytes()
V = json.loads(raw)
pieces = [f for f in V['features'] if f['properties']['kind'].startswith('사잇길 표면')]
gaps = [f for f in V['features'] if f['properties']['kind'].startswith('빈칸')]
src = f'Obsidian 데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/운동장구조/corridor-surface-{VER}.geojson'
is3d = lambda ring: all(len(p) >= 3 and p[2] is not None for p in ring)
bad = [k for k, f in enumerate(pieces) if not all(is3d(r) for r in f['geometry']['coordinates'])]
pieces = [f for k, f in enumerate(pieces) if k not in bad]


def plane(ring):
    P = np.array(ring[:-1], float)
    best, tri = 0, None
    for i in range(len(P)):  # 넓이가 가장 큰 세 점으로 평면
        for j in range(i + 1, len(P)):
            for k in range(j + 1, len(P)):
                a = abs(np.cross(P[j] - P[i], P[k] - P[i])[2])
                if a > best:
                    best, tri = a, (P[i], P[j], P[k])
    a, b, c = tri
    n = np.cross(b - a, c - a)
    return lambda x, y: float(a[2] - (n[0] * (x - a[0]) + n[1] * (y - a[1])) / n[2])


PP = [(Polygon([p[:2] for p in f['geometry']['coordinates'][0]]), plane(f['geometry']['coordinates'][0])) for f in pieces]
feats = [{'type': 'Feature', 'properties': {
    'id': 'SF-CORRIDOR-TIN', 'type': 'corridor_tin', 'kind': 'surface', 'replaces': 'SF-CORRIDOR', 'estimated': True, 'version': VER,
    'assumption': f'사잇길 면 = 내부 S-MAP 표본 TIN {VER} 조각 {len(pieces)}개(꼭짓점 표본 원값, 절단 꼭짓점은 같은 원 삼각형 평면). 빈칸은 보간하지 않음', 'source': src + ' (S-MAP 메시 내부 표본)'},
    'geometry': {'type': 'MultiPolygon', 'coordinates': [f['geometry']['coordinates'] for f in pieces]}}]
dropped_gap_pts = 0
for k, g in enumerate(gaps, 1):
    ring = g['geometry']['coordinates'][0]
    runs, cur = [], []
    for p in ring:  # z를 못 얻은 꼭짓점에서 선을 끊음(가로지르는 직선을 만들지 않음)
        if len(p) >= 3 and p[2] is not None:
            cur.append(p)
            continue
        hit = [pl for P, pl in PP if P.distance(Point(p[0], p[1])) < 1e-3]
        if hit:
            cur.append([p[0], p[1], round(hit[0](p[0], p[1]), 3)])
        else:
            dropped_gap_pts += 1
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
    if len(cur) >= 2:
        runs.append(cur)
    for r, run in enumerate(runs, 1):
        feats.append({'type': 'Feature', 'properties': {
            'id': f'CORRIDOR-TIN-GAP-{k}-{r}', 'type': 'gap_unverified', 'kind': 'line', 'estimated': True,
            'assumption': '빈칸(표본 없음): 미검증, 채우지 않음(보간 없음). 선 z = 빈칸 경계 꼭짓점이 닿는 같은 면 조각 평면(표시용), 닿는 조각이 없는 꼭짓점에서 선을 끊음', 'source': src},
            'geometry': {'type': 'LineString', 'coordinates': run}})
fc = {'type': 'FeatureCollection', 'name': f'corridor-surface-{VER}', 'crs': V['crs'],
      'provenance': {'source': src, 'sha256': hashlib.sha256(raw).hexdigest(), 'generator': 'docs/audit/field/integrate_corridor_v4.py', 'status': V['properties']['status'],
                     'gaps': len(gaps), 'pieces_dropped_not_3d': len(bad), 'gap_vertices_dropped_no_surface': dropped_gap_pts}, 'features': feats}
(ROOT / f'frontend/public/corrections/corridor-surface-{VER}.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')
OUTP.write_text(json.dumps([f['geometry']['coordinates'][0][:-1] for f in pieces]), encoding='utf-8')
print(VER, 'pieces', len(pieces), 'dropped(not 3d)', len(bad), 'gaps', len(gaps), 'gap lines', sum(1 for f in feats if f['properties']['type'] == 'gap_unverified'), 'gap pts dropped', dropped_gap_pts)

# 면적 검사(렌더 조각 = 입력 조각 평면): 빈칸 ∩ 조각, 조각끼리 겹침, 사잇길 원 경계 밖, 다른 v3 면과 겹침
from shapely.ops import unary_union
v3 = json.loads((ROOT / 'frontend/public/corrections/field-surfaces-v3.geojson').read_text(encoding='utf-8'))
S3 = {f['properties']['id']: Polygon([p[:2] for p in f['geometry']['coordinates'][0]]).buffer(0) for f in v3['features']}
U = unary_union([P for P, _ in PP])
G = [Polygon([p[:2] for p in g['geometry']['coordinates'][0]]).buffer(0) for g in gaps]
over = sum(P.area for P, _ in PP) - U.area
chk = [f'{VER}: 조각 {len(PP)}개 합 {sum(P.area for P, _ in PP):.2f} m², 합집합 {U.area:.2f} m² → 조각끼리 겹침 {over:.3f} m²',
       f'빈칸 {len(G)}곳 합 {sum(g.area for g in G):.1f} m² ∩ 조각 {sum(g.intersection(U).area for g in G):.3f} m² (0이어야 보간·채움 없음)',
       f'사잇길 원 경계(v3 SF-CORRIDOR) 밖 조각 면적 {U.difference(S3["SF-CORRIDOR"]).area:.3f} m²']
for k, P in S3.items():
    if k != 'SF-CORRIDOR':
        a = U.intersection(P).area
        if a > 1e-3:
            chk.append(f'조각 ∩ {k} {a:.3f} m²')
chk.append('다른 v3 면과 겹침: 위에 나열된 것 외 0')
(ROOT / 'docs/audit/field/corridor-tin-checks.txt').write_text(chr(10).join(chk) + chr(10), encoding='utf-8')
print(chr(10).join(chk))
