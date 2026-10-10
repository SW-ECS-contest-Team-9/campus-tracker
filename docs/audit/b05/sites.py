"""B05: 추가 건물(공연실습소, 외국인 생활관) 자리의 서버 지형과 S-MAP 지면 비교, scene:import 예상 값.

  python docs/audit/b05/sites.py <audit-dir> [<building-roofs.json>]  ->  docs/audit/b05/sites.json

- 외곽·지붕: 보정 파일의 "added" (동 노트에서 생성). 서버 지형: <audit-dir>/terrain-grid.f32 (스냅숏 seoul5000-2015-ba7fcb19).
- 가져오기 규칙을 그대로 옮김: scene-heights.ts outlineSamples + blockHeights, dem.ts bilinear. 안쪽 대표점은 PostGIS
  ST_PointOnSurface 대신 shapely representative_point (cm 단위 차이 가능).
- 겹침: 원천 campus.gpkg 외곽(캠퍼스 지도 외곽과 겹침 0.99 이상인 도형)과의 겹친 넓이와 가장 가까운 거리. 가져오기는 PostGIS로 다시 본다.
- 방향별 지면: 외곽에서 2~6 m 떨어진 1 m 격자 칸을 중심에서 본 8방위로 나눠 중앙값. S-MAP은 지형 칸(modelId 419430528)만.
"""
import json, math, pathlib, sys
import numpy as np
from shapely.geometry import Point, Polygon
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'e05'))
from grids import Grid, gpkg_buildings

audit = pathlib.Path(sys.argv[1])
overrides = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(__file__).resolve().parents[3] / 'backend/data/scene/overrides/building-roofs.json'
meta = json.loads((audit / 'terrain-grid-meta.json').read_text(encoding='utf-8')); res = meta['resolution']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])
smap = Grid(audit / 'e05/smap-mesh-cluster-1m.txt')
TERRAIN = 419430528  # S-MAP 지형 타일의 modelId (e05/analyze.py)
SOURCE = gpkg_buildings(pathlib.Path(__file__).resolve().parents[3] / 'backend/data/scene/source/campus.gpkg')
DIRS = ['동', '북동', '북', '북서', '서', '남서', '남', '남동']


def bilinear(x, y):  # dem.ts
    fx = (x - meta['originX']) / res - 0.5; fy = (y - meta['originY']) / res - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    return float(dem[iy, ix] * (1 - tx) * (1 - ty) + dem[iy, ix + 1] * tx * (1 - ty) + dem[iy + 1, ix] * (1 - tx) * ty + dem[iy + 1, ix + 1] * tx * ty)


def outline_samples(ring):  # scene-heights.ts
    out = []
    for (ax, ay), (bx, by) in zip(ring, ring[1:]):
        n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2))
        out += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    return out


med = lambda v: float(np.median(v))
r1 = lambda v: round(v, 1)
out = {'terrain': meta['versionId'], 'buildings': {}}
for b in json.loads(overrides.read_text(encoding='utf-8'))['added']:
    poly = Polygon(b['polygon'][0], b['polygon'][1:]); rp = poly.representative_point(); c = poly.centroid
    s = sorted(bilinear(x, y) for x, y in outline_samples(b['polygon'][0]) + [(rp.x, rp.y)])
    m = s[len(s) >> 1] if len(s) % 2 else (s[len(s) // 2 - 1] + s[len(s) // 2]) / 2
    side = {d: {'server': [], 'smap': []} for d in DIRS}
    inside = []
    for x, y, z, mid in smap.cells():
        p = Point(x, y); dist = poly.exterior.distance(p)
        if poly.contains(p):
            inside.append(bilinear(x, y)); continue
        if not 2 <= dist <= 6: continue
        d = DIRS[int(((math.degrees(math.atan2(y - c.y, x - c.x)) + 22.5) % 360) // 45)]
        side[d]['server'].append(bilinear(x, y))
        if mid == TERRAIN: side[d]['smap'].append(z)
    sides = {d: {'server': r1(med(v['server'])), 'smap': r1(med(v['smap'])) if v['smap'] else None, 'smapCells': len(v['smap']),
                 'serverMinusSmap': r1(med(v['server']) - med(v['smap'])) if v['smap'] else None} for d, v in side.items()}
    all_smap = [z for d in side.values() for z in d['smap']]
    out['buildings'][b['name']] = {
        'id': b['id'], 'areaM2': r1(poly.area), 'outlineSamples': len(s),
        'sourceFootprints': {'overlapM2': round(sum(poly.intersection(f['geom']).area for f in SOURCE), 2),
                             'nearest': min(((r1(poly.distance(f['geom'])), f['name']) for f in SOURCE))},
        'import': {'base': round(s[0] - 1, 3), 'roof': b['roofM'], 'height': round(b['roofM'] - m, 3), 'terrainMin': round(s[0], 3), 'terrainMedian': round(m, 3), 'terrainMax': round(s[-1], 3),
                   'roofAboveGround': b['roofM'] > s[-1]},
        'serverUnderFootprint': {'min': r1(min(inside)), 'median': r1(med(inside)), 'max': r1(max(inside))},
        'smapGroundRing': {'min': r1(min(all_smap)), 'median': r1(med(all_smap)), 'max': r1(max(all_smap)), 'cells': len(all_smap)},
        'sides': sides,
        'drawnWall': {'lowSide': r1(b['roofM'] - (s[0] - 1)), 'smapLowSide': r1(b['roofM'] - min(v['smap'] for v in sides.values() if v['smap'] is not None)),
                      'smapHighSide': r1(b['roofM'] - max(v['smap'] for v in sides.values() if v['smap'] is not None))},
    }
dest = pathlib.Path(__file__).with_name('sites.json')
dest.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps(out, ensure_ascii=False, indent=1))
