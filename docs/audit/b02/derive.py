"""B02 — 청운관·대일관·한림관(·유담관 점검)의 부분 외곽과 지붕 높이를 E05 의 S-MAP 격자에서 구한다. 읽기 전용, DB 없음.

  python derive.py <audit-dir> <backend-dir> <out.json>

입력은 E05 와 같다: <audit-dir>/e05/smap-mesh-*-2m.txt (S-MAP 3D 화면 모델 표면 z 와 모델 id, 2 m 격자, 2026-10-10),
<audit-dir>/claude-live/scene-live.json, <audit-dir>/terrain-grid.f32(+meta), <backend-dir>/data/scene/source/campus.gpkg.
S-MAP 은 독립 측량이 아니다. 부분 경계는 원천 외곽의 변과 나란한 선(또는 원)이고 2 m 격자에서 높이가 바뀌는 칸 사이다(±1 m).
부분의 평지붕 높이 = 그 부분 안 S-MAP 건물 칸의 중앙값. 결과의 값은 동 노트 머리에 옮겨 적고, 보정 파일은 노트에서 만든다(docs/audit/registry).
"""
import json, sys, math, pathlib, statistics, collections
import numpy as np
from shapely.geometry import Point, box
from shapely.affinity import affine_transform
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'e05'))
from grids import Grid, gpkg_buildings

audit, backend, out = map(pathlib.Path, sys.argv[1:4])
E05 = audit / 'e05'
load = lambda p: json.loads(pathlib.Path(p).read_text(encoding='utf-8'))
r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2); r3 = lambda v: round(float(v) * 1000) / 1000
TERRAIN = 419430528
med = statistics.median


def stats(v):
    s = sorted(float(x) for x in v)
    if not s: return {'n': 0}
    q = lambda p: s[min(len(s) - 1, int(len(s) * p))]
    return {'n': len(s), 'min': r1(s[0]), 'p10': r1(q(.1)), 'median': r1(med(s)), 'p90': r1(q(.9)), 'max': r1(s[-1])}


B = {b['name']: b for b in gpkg_buildings(backend / 'data/scene/source/campus.gpkg')}
poly = lambda n: B[n]['geom'].geoms[0]
scene = {b['name']: b for b in load(audit / 'claude-live/scene-live.json')['buildings']}
meta = load(audit / 'terrain-grid-meta.json'); res = meta['resolution']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])
G = {}
for f in ('south-2m', 'ne-2m', 'nw-2m', 'yudam-2m'):
    for x, y, z, i in Grid(E05 / f'smap-mesh-{f}.txt').cells(): G[(x, y)] = (z, i)


def bilinear(x, y):  # dem.ts
    fx = (x - meta['originX']) / res - 0.5; fy = (y - meta['originY']) / res - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    g = lambda a, b: float(dem[b, a])
    return g(ix, iy) * (1 - tx) * (1 - ty) + g(ix + 1, iy) * tx * (1 - ty) + g(ix, iy + 1) * (1 - tx) * ty + g(ix + 1, iy + 1) * tx * ty


def block(p, roof):  # scene-heights.ts + overrideHeights: outline every 2 m + one interior point (shapely's; PostGIS' may differ by cm)
    rg = list(p.exterior.coords); pts = []
    for (ax, ay), (bx, by) in zip(rg, rg[1:]):
        n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2))
        pts += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    c = p.representative_point(); pts.append((c.x, c.y))
    s = sorted(bilinear(x, y) for x, y in pts); m = med(s)
    return {'baseM': r3(s[0] - 1), 'terrainMinM': r3(s[0]), 'terrainMedianM': r3(m), 'terrainMaxM': r3(s[-1]), 'roofM': roof, 'heightM': r3(roof - m), 'roofAboveGroundBy': r1(roof - s[-1])}


def frame(a, b):  # t along a->b, o to the right of it
    L = math.hypot(b[0] - a[0], b[1] - a[1]); u = ((b[0] - a[0]) / L, (b[1] - a[1]) / L); n = (u[1], -u[0])
    to = lambda x, y: ((x - a[0]) * u[0] + (y - a[1]) * u[1], (x - a[0]) * n[0] + (y - a[1]) * n[1])
    back = lambda q: affine_transform(q, [u[0], n[0], u[1], n[1], a[0], a[1]])
    return to, back


def cells_in(p, pad=0):
    x0, y0, x1, y1 = p.bounds
    return [(x, y, *G[(x, y)]) for x in range(int(x0 - pad) // 2 * 2, int(x1 + pad) + 2, 2) for y in range(int(y0 - pad) // 2 * 2, int(y1 + pad) + 2, 2)
            if (x, y) in G and (pad or p.contains(Point(x, y)))]


def describe(name, parts, order, ids, labels):
    P = poly(name); cur = scene[name]
    assert all(q.geom_type == 'Polygon' for q in parts.values()), {k: v.geom_type for k, v in parts.items()}
    rows = []
    for k in order:
        q = parts[k]; c = cells_in(q); zin = [z for x, y, z, i in c if i != TERRAIN]
        roof = r1(med(zin)); bl = block(q, roof)
        ring = lambda rg: [[r2(x), r2(y)] for x, y in rg.coords]
        rows.append({'part': k, 'id': ids[k], 'label': labels.get(k), 'areaM2': r1(q.area), 'gridCells': len(c), 'buildingModelCells': len(zin), 'terrainCellsInside': stats([z for x, y, z, i in c if i == TERRAIN]),
                     'meshRoof': stats(zin), 'chosenFlatRoofM': roof, 'cellsWithin1_5m': r2(np.mean([abs(z - roof) <= 1.5 for z in zin])),
                     'currentRoofM': cur['roofM'], 'currentMinusChosenM': r1(cur['roofM'] - roof), 'onServerDem': bl, 'gateRoofAboveGround': roof > bl['terrainMaxM'],
                     'polygon5186': [ring(q.exterior), *[ring(h) for h in q.interiors]]})
    return {'footprintAreaM2': r1(P.area), 'partsAreaM2': r1(sum(q.area for q in parts.values())), 'partsOutsideFootprintM2': r2(sum(q.difference(P).area for q in parts.values())),
            'current': {k: cur[k] for k in ('buildingId', 'baseM', 'roofM', 'heightM', 'heightSource', 'terrainMinM', 'terrainMaxM')}, 'parts': rows}


def ground_split(name, main_roof, sides):
    """지금 지붕 - S-MAP 지붕 = (서버 지형 - S-MAP 지면) + (모델 높이 - S-MAP 건물 높이). S-MAP 지면 = 외곽 밖 2~8 m 의 지형 칸."""
    P = poly(name); cur = scene[name]
    ring = [(x, y, z) for x, y, z, i in cells_in(P, 10) if i == TERRAIN and 2 <= P.distance(Point(x, y)) <= 8]
    c = P.centroid

    def side(x, y):
        a = math.degrees(math.atan2(x - c.x, y - c.y)) % 360
        return next(k for k, (lo, hi) in sides.items() if (lo <= a < hi) or (lo > hi and (a >= lo or a < hi)))
    by = collections.defaultdict(list)
    for x, y, z in ring: by[side(x, y)].append(z)
    g = med(z for _, _, z in ring); srv = block(P, cur['roofM'])['terrainMedianM']
    return {'smapGroundRing2to8m': stats([z for _, _, z in ring]), 'smapGroundBySide': {k: stats(v) for k, v in by.items()},
            'smapMainRoofM': main_roof, 'smapBuildingHeightM': r1(main_roof - g), 'serverTerrainMedianM': srv, 'modelHeightM': cur['heightM'], 'modelRoofM': cur['roofM'],
            'roofDiffM': r1(cur['roofM'] - main_roof), 'ofWhichTerrainM': r1(srv - g), 'ofWhichBuildingHeightM': r1(cur['heightM'] - (main_roof - g)),
            'registerHeightM': None, 'registerNote': 'buildings_al_d010.json: the polygon of this building has no height, floors or name (heightM 0); building_heights.csv height is ESTIMATE'}


BIG = 500
R = {}

# ---------------------------------------------------------------- 청운관: 북동 변(v0 -> v1) 기준, o = 남서(운동장) 쪽 거리
P = poly('청운관'); c = list(P.exterior.coords)
to, back = frame(c[0], c[1])
O1, O2 = 14.6, 32.5   # 낮은 북동부 | 높은 본체 | 운동장 쪽 돌출부
parts = {'북동 저층부': P.intersection(back(box(-BIG, -BIG, BIG, O1))), '고층 본체': P.intersection(back(box(-BIG, O1, BIG, O2))), '운동장 쪽 돌출부': P.intersection(back(box(-BIG, O2, BIG, BIG)))}
R['청운관'] = describe('청운관', parts, ['고층 본체', '북동 저층부', '운동장 쪽 돌출부'], {'고층 본체': '본체', '북동 저층부': '북동저층부', '운동장 쪽 돌출부': '운동장쪽돌출부'}, {'고층 본체': '청운관'})
R['청운관']['cuts'] = {'frame': 'origin v0 (201235.30, 557313.61), t along the north-east edge to v1, o = distance to the south-west (field side)', 'oSplitsM': [O1, O2]}
R['청운관']['terrainVsHeight'] = ground_split('청운관', R['청운관']['parts'][0]['chosenFlatRoofM'], {'북동': (0, 90), '남동': (90, 180), '남서(운동장)': (180, 270), '북서': (270, 360)})
low = [(to(x, y)[0], z) for x, y, z, i in cells_in(parts['북동 저층부']) if i != TERRAIN]
R['청운관']['lowPartAlongT'] = {'t<20': stats([z for t, z in low if t < 20]), 't>=20': stats([z for t, z in low if t >= 20])}

# ---------------------------------------------------------------- 대일관: 동쪽 덩어리의 북쪽 변(v8 -> v9) 기준, o = 남남서(운동장) 쪽 거리
P = poly('대일관'); c = list(P.exterior.coords)
to, back = frame(c[8], c[9])
OA, TA = 9.95, -5.0
annex = P.intersection(back(box(TA, -BIG, BIG, OA)))
parts = {'본체': P.difference(annex), '동쪽 부속부': annex}
R['대일관'] = describe('대일관', parts, ['본체', '동쪽 부속부'], {'본체': '본체', '동쪽 부속부': '동쪽부속부'}, {'본체': '대일관'})
R['대일관']['cuts'] = {'frame': 'origin v8 (201195.62, 557327.77), t along the edge to v9, o = distance to the south-south-west (field side)', 'annex': f'o < {OA} and t > {TA}'}
R['대일관']['annexModelIds'] = dict(collections.Counter(str(i) for x, y, z, i in cells_in(annex) if i != TERRAIN))
R['대일관']['mainModelIds'] = dict(collections.Counter(str(i) for x, y, z, i in cells_in(parts['본체']) if i != TERRAIN))
R['대일관']['terrainVsHeight'] = ground_split('대일관', R['대일관']['parts'][0]['chosenFlatRoofM'], {'북(뒤편)': (295, 115), '남(운동장)': (115, 295)})

# ---------------------------------------------------------------- 한림관: 가운데 원판(위 단) + 바깥 고리
P = poly('한림관')
top = [(x, y) for x, y, z, i in cells_in(P) if i != TERRAIN and z > 195]
C = (r1(np.mean([p[0] for p in top])), r1(np.mean([p[1] for p in top]))); RAD = r1(math.sqrt(len(top) * 4 / math.pi))
disk = Point(C).buffer(RAD, 6)   # 24각형
assert disk.within(P)
parts = {'가운데 원판': disk, '바깥 고리': P.difference(disk)}
R['한림관'] = describe('한림관', parts, ['가운데 원판', '바깥 고리'], {'가운데 원판': '원판', '바깥 고리': '고리'}, {'가운데 원판': '한림관'})
R['한림관']['cuts'] = {'topCells': len(top), 'centre': C, 'equivalentRadiusM': RAD, 'drawnAs': '24-gon', 'centreToFootprintCentroidM': r1(Point(C).distance(P.centroid))}

# ---------------------------------------------------------------- 유담관: 점검만(모델에 넣지 않음)
P = poly('유담관'); cs = cells_in(P)
tower = [(x, y, z) for x, y, z, i in cs if i == 172425217]
rest = [(x, y, z) for x, y, z, i in cs if i == TERRAIN]
allmodel = [(x, y) for (x, y), (z, i) in G.items() if i == 172425217]
hist = collections.Counter(int(z // 2 * 2) for x, y, z in rest)
u = (math.sin(math.radians(123.1)), math.cos(math.radians(123.1)))   # 북동 변(v10 -> v11) 방향
along = collections.defaultdict(list)
for x, y, z in tower: along[int(((x - 201017.39) * u[0] + (y - 557298.66) * u[1]) // 10 * 10)].append(z)
R['유담관'] = {'footprintAreaM2': r1(P.area), 'cellsInside': len(cs), 'towerModelCellsInside': len(tower), 'towerModelCellsAll': len(allmodel), 'towerModelCellsOutsideFootprint': len(allmodel) - len(tower),
            'towerRoof': stats([z for _, _, z in tower]), 'towerRoofAlongNorthEastEdgeBy10m': {str(k): stats(v) for k, v in sorted(along.items())},
            'notTowerInside': {'cells': len(rest), 'z': stats([z for _, _, z in rest]), 'histogram2m': {str(k): v for k, v in sorted(hist.items())}},
            'serverDemUnderFootprint': block(P, scene['유담관']['roofM']), 'current': {k: scene['유담관'][k] for k in ('buildingId', 'baseM', 'roofM', 'heightM', 'heightSource', 'terrainMinM', 'terrainMaxM')}}

roads = load(audit / 'claude-live/roads-live-2.json')['items']
refs = collections.Counter(str(r.get('buildingId')) for r in roads)
R['roadReferences'] = {'roads': len(roads), **{k: refs.get(scene[k]['buildingId'], 0) for k in ('청운관', '대일관', '한림관', '유담관', '문예관', '은주관')}}
out.write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding='utf-8')
for n in ('청운관', '대일관', '한림관'):
    for p in R[n]['parts']: print(n, p['part'], p['areaM2'], p['meshRoof'], p['chosenFlatRoofM'], p['cellsWithin1_5m'], p['terrainCellsInside'].get('n'), p['onServerDem'])
    print(' ', {k: v for k, v in R[n].items() if k not in ('parts',)})
print(json.dumps(R['유담관'], ensure_ascii=False))
print(R['roadReferences'])
