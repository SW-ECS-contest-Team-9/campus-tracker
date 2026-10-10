"""B03 3단계 — 유담관을 S-MAP 격자에서 다시 읽어 부분(탑 띠, 기단 데크)의 외곽·지붕 높이와 서버 지형 위 예상값을 낸다. 읽기 전용, DB 없음.

  python docs/audit/b03/tower.py <audit-dir> <backend-dir> <out.json>

입력: <audit-dir>/e05/smap-mesh-yudam-2m.txt (2 m 격자, 2026-10-10), <audit-dir>/terrain-grid.f32(+meta) = 운영 지형 seoul5000-2015 스냅숏,
<backend-dir>/data/scene/source/campus.gpkg. S-MAP 은 독립 측량이 아니다. 경계는 2 m 격자에서 읽어 ±2 m.
- 탑: S-MAP 건물 모델 172425217 의 칸(지붕 z >= 160). 외곽 = 칸 합집합의 볼록 껍질을 원천 외곽으로 자른 것(껍질과 칸 넓이 차를 함께 적는다).
  지붕이 긴 축을 따라 기울어 있어 축 방향으로 BANDS 개 띠로 나누고 띠마다 칸 중앙값을 평지붕 높이로 둔다.
- 기단 데크: 원천 외곽 안에서 탑에 붙은 평탄한 S-MAP 지형 칸(DECK_Z 범위). S-MAP 은 이 면을 지형으로 분류한다.
- 서버 지형 위 값: scene-import 와 같은 규칙(외곽 2 m 표본 + 안쪽 한 점, 쌍선형)으로 바닥·지형 최저·최고·높이를 계산한다(안쪽 점은 shapely 것이라 PostGIS 와 cm 단위로 다를 수 있다).
"""
import json, math, pathlib, statistics, sys
import numpy as np
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import TERRAIN, Grid, outlines
from shapely.geometry import Point, Polygon, MultiPoint, box
from shapely.ops import unary_union

audit, backend, out = map(pathlib.Path, sys.argv[1:4])
TOWER = 172425217; BANDS = 3; DECK_Z = (128.5, 131.5)
med = statistics.median; r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2); r3 = lambda v: round(float(v) * 1000) / 1000
g = Grid(audit / 'e05/smap-mesh-yudam-2m.txt'); cells = list(g.cells()); half = g.step / 2
F = outlines(backend)['유담관'].geoms[0]
meta = json.loads((audit / 'terrain-grid-meta.json').read_text(encoding='utf-8')); res = meta['resolution']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])
sq = lambda x, y: box(x - half, y - half, x + half, y + half)


def stats(v):
    s = sorted(float(x) for x in v); q = lambda p: s[min(len(s) - 1, int(len(s) * p))]
    return {'n': len(s), 'min': r1(s[0]), 'p10': r1(q(.1)), 'median': r1(med(s)), 'p90': r1(q(.9)), 'max': r1(s[-1])} if s else {'n': 0}


def bilinear(x, y):  # dem.ts
    fx = (x - meta['originX']) / res - 0.5; fy = (y - meta['originY']) / res - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    d = lambda a, b: float(dem[b, a])
    return d(ix, iy) * (1 - tx) * (1 - ty) + d(ix + 1, iy) * tx * (1 - ty) + d(ix, iy + 1) * (1 - tx) * ty + d(ix + 1, iy + 1) * tx * ty


def on_server(p, roof):  # scene-heights.ts outlineSamples + blockHeights, scene-overrides.ts overrideHeights
    rg = list(p.exterior.coords); pts = []
    for (ax, ay), (bx, by) in zip(rg, rg[1:]):
        n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2))
        pts += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    c = p.representative_point(); pts.append((c.x, c.y))
    s = sorted(bilinear(x, y) for x, y in pts); m = med(s)
    return {'baseM': r3(s[0] - 1), 'terrainMinM': r3(s[0]), 'terrainMedianM': r3(m), 'terrainMaxM': r3(s[-1]), 'roofM': roof, 'heightM': r3(roof - m),
            'roofMinusTerrainMaxM': r2(roof - s[-1]), 'samplesAboveRoof': sum(1 for v in s if v >= roof), 'samples': len(s)}


ring = lambda p: [[r2(x), r2(y)] for x, y in p.exterior.coords]

# ---- 탑
tw = [(x, y, z) for x, y, z, i in cells if i == TOWER]
roofc = [(x, y, z) for x, y, z in tw if z >= 160]
cellU = unary_union([sq(x, y) for x, y, z in roofc])
hull = MultiPoint([c for x, y, z in roofc for c in sq(x, y).exterior.coords]).convex_hull.simplify(0.5)
tower = hull.intersection(F)
if tower.geom_type != 'Polygon': tower = max(tower.geoms, key=lambda q: q.area)
# 긴 축: 지붕 칸 좌표의 주축. 높은 끝에서 낮은 끝 방향으로 잡는다
P = np.array([(x, y) for x, y, z in roofc]); c0 = P.mean(axis=0); w, v = np.linalg.eigh(np.cov((P - c0).T)); ax = v[:, np.argmax(w)]
t = (P - c0) @ ax; zs = np.array([z for x, y, z in roofc])
if np.polyfit(t, zs, 1)[0] > 0: ax = -ax; t = -t
slope, icpt = np.polyfit(t, zs, 1)
t0, t1 = float(t.min()) - half, float(t.max()) + half; n = np.array([-ax[1], ax[0]])
edges = [t0 + (t1 - t0) * k / BANDS for k in range(BANDS + 1)]
bands = []
for k in range(BANDS):
    a, b = edges[k], edges[k + 1]
    strip = Polygon([tuple(c0 + ax * a + n * 200), tuple(c0 + ax * b + n * 200), tuple(c0 + ax * b - n * 200), tuple(c0 + ax * a - n * 200)])
    p = tower.intersection(strip)
    if p.geom_type != 'Polygon': p = max(p.geoms, key=lambda q: q.area)
    zin = [z for (x, y, z), tt in zip(roofc, t) if a <= tt < b + (1e-9 if k == BANDS - 1 else 0)]
    roof = r1(med(zin))
    bands.append({'band': k + 1, 'alongAxisM': [r1(a - t0), r1(b - t0)], 'areaM2': r1(p.area), 'meshRoof': stats(zin), 'flatRoofM': roof,
                  'within1_5m': r2(np.mean([abs(z - roof) <= 1.5 for z in zin])), 'within2_5m': r2(np.mean([abs(z - roof) <= 2.5 for z in zin])), 'onServerDem': on_server(p, roof), 'polygon5186': [ring(p)], '_p': p})
whole = r1(med(zs))
# ---- 기단 데크: 외곽 안, 평탄한 지형 칸 중 탑에 이어진 덩어리
flat = {(x, y): z for x, y, z, i in cells if i == TERRAIN and DECK_Z[0] <= z <= DECK_Z[1] and F.contains(Point(x, y)) and not tower.contains(Point(x, y))}
seed = [k for k in flat if tower.distance(Point(k)) <= g.step]; seen = set(seed); stack = list(seed)
while stack:
    x, y = stack.pop()
    for dx, dy in ((2, 0), (-2, 0), (0, 2), (0, -2)):
        k = (x + dx * g.step / 2, y + dy * g.step / 2)
        if k in flat and k not in seen: seen.add(k); stack.append(k)
deckU = unary_union([sq(x, y) for x, y in seen]).buffer(1.0).buffer(-1.0)
deck = deckU.intersection(F).difference(tower.buffer(0.01))
if deck.geom_type != 'Polygon': deck = max(deck.geoms, key=lambda q: q.area)
deck = Polygon(deck.exterior).simplify(1.0).intersection(F).difference(tower.buffer(0.01))
if deck.geom_type != 'Polygon': deck = max(deck.geoms, key=lambda q: q.area)
deck = Polygon(deck.exterior)
dz = [z for (x, y), z in flat.items() if (x, y) in seen]; deck_roof = r1(med(dz))
# 외곽 안에서 그리지 않는 나머지
rest = F.difference(unary_union([tower, deck]))
rest_z = [z for x, y, z, i in cells if rest.contains(Point(x, y))]
hist = {}
for z in rest_z: hist[int(z // 4 * 4)] = hist.get(int(z // 4 * 4), 0) + 1
# 탑 둘레 지면(탑 밖 4 m 안의 지형 칸)을 방위별로
side = {}
tc = tower.centroid
for x, y, z, i in cells:
    if i != TERRAIN: continue
    d = tower.distance(Point(x, y))
    if 0 < d <= 4:
        u = (np.array([x, y]) - np.array([tc.x, tc.y])); a_ = float(u @ ax); b_ = float(u @ n)
        key = '낮은 끝(남동, 분수 광장 쪽)' if a_ > (t1 - t0) * 0.35 else '높은 끝(북서, 버스 정류장 쪽)' if a_ < -(t1 - t0) * 0.35 else ('긴 변 한쪽(+n)' if b_ > 0 else '긴 변 다른쪽(-n)')
        side.setdefault(key, []).append(z)
R = {
    'source': 'S-MAP 3D viewer mesh picks 2026-10-10, 2 m grid (smap-mesh-yudam-2m.txt); server DEM snapshot ' + meta['versionId'],
    'sourceOutlineAreaM2': r1(F.area),
    'tower': {'modelId': TOWER, 'roofCells': len(roofc), 'cellsAreaM2': r1(cellU.area), 'hullAreaM2': r1(hull.area), 'hullMinusCellsM2': r1(hull.area - cellU.area), 'hullOutsideCellsM2': r1(hull.difference(cellU).area),
              'cellsOutsideHullM2': r1(cellU.difference(hull).area), 'hullOutsideSourceOutlineM2': r1(hull.difference(F).area), 'drawnAreaM2': r1(tower.area),
              'roofAll': stats(zs), 'singleFlatRoofM': whole, 'singleWithin2_5m': r2(np.mean(np.abs(zs - whole) <= 2.5)),
              'axis': {'direction': [r3(ax[0]), r3(ax[1])], 'lengthM': r1(t1 - t0), 'roofSlopeMPerM': r3(slope), 'fitHighEndM': r1(icpt + slope * float(t.min())), 'fitLowEndM': r1(icpt + slope * float(t.max()))},
              'groundAround4m': {k: stats(v) for k, v in side.items()},
              'lowCellsOfModel': stats([z for x, y, z in tw if z < 160]), 'bands': [{k: v for k, v in b.items() if k != '_p'} for b in bands]},
    'deck': {'cells': len(seen), 'areaM2': r1(deck.area), 'meshSurface': stats(dz), 'flatRoofM': deck_roof, 'smapClass': 'terrain (not a building model)', 'onServerDem': on_server(deck, deck_roof), 'polygon5186': [ring(deck)]},
    'notDrawn': {'areaM2': r1(rest.area), 'cells': len(rest_z), 'surface': stats(rest_z), 'histogram4m': dict(sorted(hist.items()))},
    'coverage': {'partsAreaM2': r1(tower.area + deck.area), 'ofOutline': r2((tower.area + deck.area) / F.area), 'overlapM2': r2(sum(b['_p'].intersection(deck).area for b in bands)),
                 'bandsSumM2': r1(sum(b['_p'].area for b in bands)), 'partsOutsideOutlineM2': r2(sum(b['_p'].difference(F).area for b in bands) + deck.difference(F).area)},
    'wholeOutlineOnServerDem': on_server(F, 169.739),
}
json.dump(R, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
T = R['tower']
print('탑', {k: T[k] for k in ('roofCells', 'cellsAreaM2', 'hullAreaM2', 'hullOutsideCellsM2', 'cellsOutsideHullM2', 'hullOutsideSourceOutlineM2', 'drawnAreaM2', 'roofAll', 'singleFlatRoofM', 'singleWithin2_5m', 'axis', 'lowCellsOfModel')})
for k, v in T['groundAround4m'].items(): print('  지면', k, v)
for b in T['bands']: print('  띠', {k: v for k, v in b.items() if k != 'polygon5186'}, len(b['polygon5186'][0]), '점')
print('데크', {k: v for k, v in R['deck'].items() if k != 'polygon5186'}, len(R['deck']['polygon5186'][0]), '점')
print('그리지 않음', R['notDrawn']); print('덮음', R['coverage']); print('전체 외곽', R['wholeOutlineOnServerDem'])
