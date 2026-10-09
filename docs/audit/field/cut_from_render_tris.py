"""사잇길 절단 면을 원 SF-CORRIDOR 렌더 삼각형에서 직접 만든다(내부 z 불변, 절단 경계 z = 같은 삼각형 평면).

render_z_check.ts --dump-tris 로 내보낸 삼각형(EPSG:5186 x,y,z)마다 구멍(계단 평면 + 0.3 m)을 빼고, 남은 조각 정점 z는 그 삼각형 평면에서 계산.
각 조각은 평면이라 Cesium이 어떻게 삼각화해도 z가 원 면과 같다.
사용: python cut_from_render_tris.py <tris.json> <repo-root> [대상 면 id, 기본 SF-CORRIDOR; v4는 SF-CORRIDOR-V4]
"""
import json, sys
from pathlib import Path
import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union

TRIS, ROOT = json.loads(Path(sys.argv[1]).read_text()), Path(sys.argv[2])
OUT = ROOT / 'frontend/public/corrections'
MARGIN = 0.3
REPLACES = sys.argv[3] if len(sys.argv) > 3 else 'SF-CORRIDOR'  # 잘라낼 대상 면 id(삼각형 입력과 같은 면)


def plane(t):
    a, b, c = map(np.array, t)
    n = np.cross(b - a, c - a)
    return lambda x, y: float(a[2] - (n[0] * (x - a[0]) + n[1] * (y - a[1])) / n[2])


for file, pick in (('corridor-stair-cut-v1.geojson', lambda f, est: [Polygon(g['geometry']['coordinates'][0]) for g in est if str(g['properties'].get('stair', '')).startswith(('ST-DAEIL-EXIT-SIDE', 'ST-A14'))]),
                   ('stairs-v6-est.geojson', lambda f, est: [Polygon(g['geometry']['coordinates'][0]) for g in f['features'] if g['properties']['type'] in ('stair_step', 'landing')])):
    fc = json.loads((OUT / file).read_text(encoding='utf-8'))
    est = json.loads((OUT / 'field-structures-est-v1.geojson').read_text(encoding='utf-8'))['features']
    holes = unary_union([p.buffer(MARGIN, join_style=2) for p in pick(fc, est)])
    pieces = []
    for t in TRIS:
        T = Polygon([p[:2] for p in t])
        if T.area < 1e-9:
            continue
        z = plane(t)
        r = T.difference(holes)
        for g in getattr(r, 'geoms', [r]):
            if g.geom_type != 'Polygon' or g.area < 1e-6:
                continue
            pieces.append([[[round(x, 3), round(y, 3), round(z(x, y), 3)] for x, y in ring.coords] for ring in [g.exterior, *g.interiors]])
    cut = [f for f in fc['features'] if f['properties'].get('replaces') in ('SF-CORRIDOR', 'SF-CORRIDOR-V4')][0]
    cut['properties']['replaces'] = REPLACES
    cut['geometry'] = {'type': 'MultiPolygon', 'coordinates': pieces}
    cut['properties']['assumption'] = (cut['properties']['assumption'].split(' | ')[0] +
                                       f' | 면 구성: {REPLACES} 렌더 삼각형에서 구멍만 뺀 평면 조각(내부 z 불변, 절단 경계 z = 같은 삼각형 평면, cut_from_render_tris.py)')
    # 구멍 가장자리 렌더 연결면 상단 z도 같은 삼각형 평면에서
    def zr(x, y):
        for t in TRIS:
            if Polygon([p[:2] for p in t]).buffer(1e-6).contains(__import__('shapely.geometry', fromlist=['Point']).Point(x, y)):
                return plane(t)(x, y)
        return None
    for f in fc['features']:
        if f['properties']['kind'] == 'skirt':
            for c in f['geometry']['coordinates']:
                z = zr(c[0], c[1])
                if z is not None:
                    c[2] = round(z, 3)
    (OUT / file).write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')
    print(file, 'pieces', len(pieces), 'hole area', round(holes.area, 1))
