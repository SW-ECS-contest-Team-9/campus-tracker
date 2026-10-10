"""B09 — 수인관 옥상(풋살장) 다시 읽기, 상승관 사용자 그림 좌표 옮기기, 운동장 출입 지점 보강. 읽기 전용(DB·MCP 없음).

  python docs/audit/b09/b09.py <3d-map-audit-20261009> <backend-dir> docs/audit/b09/results.json

입력
- <audit>/b09/smap-mesh-b09-suin-1m-{a,b}.txt, smap-mesh-b09-sangseung-1m.txt: S-MAP 3D 뷰어 1 m 격자(2026-10-10, e05/collect_grid.js 의 __grid,
  같은 호출을 두 번 이상 되풀이해 전 칸이 같음을 확인). 호출: ('b09-suin-1m-a', 201080, 557100, 121, 57, 1, 125, 1700),
  ('b09-suin-1m-b', 201080, 557157, 121, 57, 1, 125, 1700), ('b09-sangseung-1m', 201170, 557266, 78, 75, 1, 155, 1500).
- <audit>/b09/kakao-skyview-L1-상승관-x201178-y557323-12.5pxm.jpg: 카카오맵 스카이뷰 L1 타일(행 8082~8083, 열 3612~3613)을 화면에 2배로 놓고 찍은 화면.
  왼쪽 위 = (201178, 557323), 12.5 픽셀/m, 위가 북. 타일 격자 = EPSG:5181 원점 (-30000, -60000), L1 타일 64 m (지도 주소의 중심 좌표로 0.25 m 안에서 확인).
  EPSG:5186 = EPSG:5181 + (0, 100000).
- <audit>/사용자-서문·제2주차장·수인관-20261010/07-카카오위성-상승관-사용자표시.webp: 사용자 그림(같은 항공사진 위).
그림 -> 기준 화면은 SIFT 특징 맞춤(닮음 변환). 좌표는 항공사진의 땅 평면 좌표다: 지붕은 건물 높이만큼 북북동으로 밀려 보인다(보정하지 않음).
S-MAP 은 독립 측량이 아니다.
"""
import collections, json, math, pathlib, statistics, sys
import cv2, numpy as np
from shapely.geometry import Point, Polygon
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'e05'))
from grids import Grid, stack, gpkg_buildings
sys.stdout.reconfigure(encoding='utf-8')
audit, backend, out = map(pathlib.Path, sys.argv[1:4])
T = 419430528
r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2)
B = {b['name']: (b['geom'].geoms[0] if hasattr(b['geom'], 'geoms') else b['geom']) for b in gpkg_buildings(backend / 'data/scene/source/campus.gpkg')}
q = lambda v, p: sorted(v)[min(len(v) - 1, int(len(v) * p))]
st = lambda v: {'n': len(v), 'min': r1(min(v)), 'p10': r1(q(v, .1)), 'median': r1(statistics.median(v)), 'p90': r1(q(v, .9)), 'max': r1(max(v))} if v else {'n': 0}

# ------------------------------------------------------------ 1. 수인관
g = stack([audit / 'b09/smap-mesh-b09-suin-1m-a.txt', audit / 'b09/smap-mesh-b09-suin-1m-b.txt'])
cells = list(g.cells()); zmap = {(x, y): (z, i) for x, y, z, i in cells}
P = B['수인관']; ring = list(P.exterior.coords)
ins = [(x, y, z, i) for x, y, z, i in cells if P.contains(Point(x, y))]
terr = [z for *_, z, i in ins if i == T]
DECK = statistics.median(terr)
SIDES = ['북서(은주1관 뒤 아래 땅 쪽)', '북동(은주2관 쪽)', '남동(대일외고 쪽)', '남(끝 모서리)', '남서(서경로 쪽)']
cx, cy = P.centroid.x, P.centroid.y
sides = []
for name, a, b in zip(SIDES, ring, ring[1:]):
    L = math.hypot(b[0] - a[0], b[1] - a[1]); ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L; nx, ny = uy, -ux
    if ((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0: nx, ny = -nx, -ny
    drop, wall, prof, thirds = [], [], collections.defaultdict(list), collections.defaultdict(list)
    for s in np.arange(3, L - 3 + .01, 2):
        px, py = a[0] + ux * s, a[1] + uy * s; d1 = d2 = None
        for d in np.arange(-10, 16.01, .5):
            v = zmap.get((round(px + nx * d), round(py + ny * d)))
            if not v: continue
            if v[1] == T: prof[float(d)].append(v[0])
            if v[1] == T and 8 <= d <= 14: thirds[min(2, int(3 * s / L))].append(v[0])
            if d1 is None and v[1] == T and v[0] < DECK - 2: d1 = float(d)
            if d2 is None and (v[1] != T or v[0] > DECK + 2): d2 = float(d)
        drop.append(d1); wall.append(d2)

    def f(v):
        w = [x for x in v if x is not None]
        return None if not w else {'medianM': r1(statistics.median(w)), 'minM': min(w), 'maxM': max(w), 'profiles': len(w), 'of': len(v)}
    sides.append({'side': name, 'from': [r1(a[0]), r1(a[1])], 'to': [r1(b[0]), r1(b[1])], 'lengthM': r1(L),
                  'deckEndsAt_offsetFromOutline': f(drop), 'higherGroundOrBuildingAt_offset': f(wall),
                  'terrainMedianByOffsetM': {str(d): r1(statistics.median(prof[d])) for d in (-8., -4., -2., -1., 0., 1., 2., 3., 4., 6., 8., 10., 12., 15.) if prof[d]},
                  'ground8to14mOut_byThirdAlongSide': [st(thirds[k]) for k in range(3)]})
meta = json.loads((audit / 'terrain-grid-meta.json').read_text()); res = meta['resolution']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])


def bil(x, y):
    fx = (x - meta['originX']) / res - .5; fy = (y - meta['originY']) / res - .5; ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    return float(dem[iy, ix] * (1 - tx) * (1 - ty) + dem[iy, ix + 1] * tx * (1 - ty) + dem[iy + 1, ix] * (1 - tx) * ty + dem[iy + 1, ix + 1] * tx * ty)


def block_samples(p):  # scene-heights.ts: 외곽선 2 m + 안쪽 한 점(shapely 의 점. PostGIS 점과 cm 수준 차)
    rg = list(p.exterior.coords); pts = []
    for (ax, ay), (bx, by) in zip(rg, rg[1:]):
        n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2)); pts += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    c = p.representative_point(); return sorted(bil(x, y) for x, y in pts + [(c.x, c.y)])


s = block_samples(P); med = statistics.median(s); ROOF = 132.1
inside_dem = [bil(x, y) for x, y, *_ in ins]
sw = next(x for x in sides if x['side'].startswith('남서'))
gs = [t['median'] for t in sw['ground8to14mOut_byThirdAlongSide'] if t['n']]
suin = {
    'sourceOutline': {'ring': [[r1(x), r1(y)] for x, y in ring], 'areaM2': round(P.area)},
    'insideOutline_1mCells': {'n': len(ins), 'terrainCells': len(terr), 'buildingModelCells': len(ins) - len(terr), 'modelIds': dict(collections.Counter(str(i) for *_, i in ins if i != T))},
    'deck': {'medianM': r1(DECK), 'stats': st(terr), 'cellsWithin0_2m': sum(abs(z - DECK) <= .2 for z in terr), 'cellsWithin0_5m': sum(abs(z - DECK) <= .5 for z in terr),
             'cellsMoreThan1mAbove': sum(z > DECK + 1 for z in terr), 'highestM': r1(max(terr)), 'cellsMoreThan1mBelow': sum(z < DECK - 1 for z in terr),
             'form': 'one flat surface; the lower cells are the smoothed edge on the street side and the north-west corner; nothing above the deck is in the S-MAP surface (fences, lights are not modelled)'},
    'sides': sides,
    'heightFromStreetM': {'streetGroundM_byThird_alongSouthWestSide': gs, 'deckMinusStreet': [r1(DECK - v) for v in gs]},
    'serverDemGate': {'outlineSamples': len(s), 'minM': round(s[0], 3), 'medianM': round(med, 3), 'maxM': round(s[-1], 3), 'roofM': ROOF, 'samplesAtOrAboveRoof': sum(v >= ROOF for v in s),
                      'plainRoofOverride': 'refused: roof %.1f is not above the ground %.3f' % (ROOF, s[-1]), 'terraceRoofOverride': {'passes': ROOF > med, 'heightM': round(ROOF - med, 3), 'baseM': round(s[0] - 1, 3)},
                      'footprintCellsWhereServerDemAboveRoof_pct': r1(100 * sum(v > ROOF for v in inside_dem) / len(inside_dem)), 'serverDemInsideFootprint': st(inside_dem)},
}

# ------------------------------------------------------------ 2. 상승관: 사용자 그림 -> 좌표
rd = lambda p: cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_COLOR)
U = rd(audit / '사용자-서문·제2주차장·수인관-20261010/07-카카오위성-상승관-사용자표시.webp'); R = rd(audit / 'b09/kakao-skyview-L1-상승관-x201178-y557323-12.5pxm.jpg')
X0, Y1, PXM = 201178, 557323, 12.5
bb, gg, rr = [U[..., k].astype(int) for k in range(3)]
red = ((rr > 170) & (gg < 90) & (bb < 90)).astype(np.uint8)
cv2.setRNGSeed(0)
sift = cv2.SIFT_create(nfeatures=6000, contrastThreshold=0.02)
ku, du = sift.detectAndCompute(cv2.cvtColor(U, cv2.COLOR_BGR2GRAY), (cv2.dilate(red, np.ones((9, 9), np.uint8)) == 0).astype(np.uint8) * 255)
kr, dr = sift.detectAndCompute(cv2.cvtColor(R, cv2.COLOR_BGR2GRAY), None)
good = [a for a, b2 in cv2.BFMatcher().knnMatch(du, dr, k=2) if a.distance < .75 * b2.distance]
pu = np.float32([ku[a.queryIdx].pt for a in good]); pr = np.float32([kr[a.trainIdx].pt for a in good])
M, inl = cv2.estimateAffinePartial2D(pu, pr, method=cv2.RANSAC, ransacReprojThreshold=2.0); inl = inl.ravel().astype(bool)
resid = np.hypot(*((pu[inl] @ M[:, :2].T + M[:, 2]) - pr[inl]).T)
W = lambda u, v: (X0 + (M[0, 0] * u + M[0, 1] * v + M[0, 2]) / PXM, Y1 - (M[1, 0] * u + M[1, 1] * v + M[1, 2]) / PXM)
gs_ = Grid(audit / 'b09/smap-mesh-b09-sangseung-1m.txt'); sm = {(x, y): (z, i) for x, y, z, i in gs_.cells()}
ANNEX = 173604866
NAMES = {173604865: '대일관 모델', ANNEX: '대일관 동쪽 부속부 모델', 173670401: '청운관 모델', T: '지면'}


def smap(x, y):
    v = sm.get((round(x), round(y))); return None if not v else {'zM': r1(v[0]), 'what': NAMES.get(v[1], str(v[1]))}


n, lab, stt, cen = cv2.connectedComponentsWithStats(red, connectivity=8)
comp = [{'bbox': stt[k][:4].tolist(), 'c': W(*cen[k])} for k in range(1, n) if stt[k][4] >= 25]
left = [c for c in comp if c['bbox'][1] >= 440 and c['bbox'][0] + c['bbox'][2] <= 245]
right = [c for c in comp if c['bbox'][1] >= 440 and c['bbox'][0] >= 262]
BOX_PX = [(364, 212), (490, 234), (410, 372), (305, 360)]   # 상자 네 모서리(그림에서 읽은 픽셀, ±5 픽셀 = 0.3 m)
box = Polygon([W(*p) for p in BOX_PX])
field = Polygon(json.loads((HERE.parent / 'e10/field-area.geojson').read_text(encoding='utf-8'))['features'][0]['geometry']['coordinates'][0])


def on_field(x, y):
    p = field.exterior.interpolate(field.exterior.project(Point(x, y))); return [r2(p.x), r2(p.y)], r1(Point(x, y).distance(p))


def bundle(cs):
    cs = sorted(cs, key=lambda c: c['c'][1]); foot, top = cs[0]['c'], cs[-1]['c']; at, d = on_field(*foot)
    return {'strokes': len(cs), 'strokeCentres': [[r1(c['c'][0]), r1(c['c'][1])] for c in cs], 'fieldSideEnd': [r1(foot[0]), r1(foot[1])], 'upperEnd': [r1(top[0]), r1(top[1])],
            'smapAtFieldSideEnd': smap(*foot), 'smapAtUpperEnd': smap(*top), 'footOnFieldBoundary': at, 'footToBoundaryM': d}


src, dae, che = B['상승관'], B['대일관'], B['청운관']
boxcells = [(z, i) for (x, y), (z, i) in sm.items() if box.contains(Point(x, y))]
yard = [z for (x, y), (z, i) in sm.items() if i == T and 201213 <= x <= 201221 and 557291 <= y <= 557307 and z >= 152.9]
annex = np.array([(x, y) for (x, y), (z, i) in sm.items() if i == ANNEX], float)
srccells = [(z, i) for (x, y), (z, i) in sm.items() if src.contains(Point(x, y))]
MARK, ENTR = (201202.7, 557302.7), (201200.5, 557294.2)
stairs = {'left': bundle(left), 'right': bundle(right)}
sang = {
    'georeference': {'method': 'SIFT matches user image -> reference screenshot of the same Kakao aerial tiles, similarity transform (RANSAC 2 px)', 'matches': len(good), 'inliers': int(inl.sum()),
                     'userPixelPerM': r2(PXM / math.hypot(M[0, 0], M[1, 0])), 'rotationDeg': r2(math.degrees(math.atan2(M[1, 0], M[0, 0]))), 'rmsM': r2(float(np.sqrt((resid ** 2).mean())) / PXM), 'maxM': r2(float(resid.max()) / PXM),
                     'tileGridCheckM': 0.25,
                     'notChecked': 'registration of the Kakao aerial photo against EPSG:5186 on the ground (no independent point). Against S-MAP ground edges and building footprints the same features differ by 1-4 m, part of it roof lean and S-MAP smoothing',
                     'statedErrorM': {'groundFeatures': 3, 'roofs': 'ground error plus lean to the north-north-east, about 0.15 m per m of roof height (read on 청운관: about 6 m for 39 m)'}},
    'box': {'cornersXY': [[r1(x), r1(y)] for x, y in list(box.exterior.coords)[:4]], 'centreXY': [r1(box.centroid.x), r1(box.centroid.y)], 'areaM2': r1(box.area),
            'smapUnderBox_1mCells': {NAMES.get(k, str(k)): {'cells': sum(i == k for _, i in boxcells), 'minM': r1(min(z for z, i in boxcells if i == k)), 'medianM': r1(statistics.median(z for z, i in boxcells if i == k)), 'maxM': r1(max(z for z, i in boxcells if i == k))} for k in sorted({i for _, i in boxcells})},
            'separateRoofedVolumeAtBox': False,
            'toSourceBlock': {'centreToCentreM': r1(box.centroid.distance(src.centroid)), 'gapM': r1(box.distance(src)), 'overlapM2': r1(box.intersection(src).area), 'sourceBlockCentre': [r1(src.centroid.x), r1(src.centroid.y)]},
            'toUniversityMarkerM': r1(box.distance(Point(MARK))), 'toUniversityEntranceMarkerM': r1(box.distance(Point(ENTR))), 'overlapWith대일관OutlineM2': r1(box.intersection(dae).area), 'overlapWith청운관OutlineM2': r1(box.intersection(che).area),
            'toAnnexModelM': r1(min(box.distance(Point(x, y)) for x, y in annex))},
    'yardBetweenBuildings': {'where': 'x 201213-201221, y 557291-557307 (S-MAP ground between the 대일관 model and the 청운관 model)', 'levelM': st(yard)},
    'smapAtSourceBlock': {'cells': len(srccells), 'terrainCells': sum(i == T for _, i in srccells), 'ground': st([z for z, i in srccells if i == T])},
    'annexModel': {'id': ANNEX, 'cells': len(annex), 'roof': st([z for (x, y), (z, i) in sm.items() if i == ANNEX]), 'bbox': [annex[:, 0].min(), annex[:, 1].min(), annex[:, 0].max(), annex[:, 1].max()],
                   'centre': [r1(annex[:, 0].mean()), r1(annex[:, 1].mean())], 'offsetFromSourceBlockCentre': [r1(annex[:, 0].mean() - src.centroid.x), r1(annex[:, 1].mean() - src.centroid.y)]},
    'stairs': stairs,
    'universityMarkers': {'상승관': {'xy': list(MARK), 'smap': smap(*MARK)}, '상승관 입구(1층 로비)': {'xy': list(ENTR), 'smap': smap(*ENTR), 'toLeftStairUpperEndM': r1(math.dist(ENTR, stairs['left']['upperEnd']))}},
}

# ------------------------------------------------------------ 3. 한림관 6층 계단 위 끝, 대일관 현관 계단 (S-MAP eunju-1m-c)
ge = Grid(audit / 'e05/smap-mesh-eunju-1m-c.txt'); em = {(x, y): (z, i) for x, y, z, i in ge.cells()}
row = lambda y, xs: {str(x): r1(em[(x, y)][0]) if em[(x, y)][1] == T else 'model' for x in xs}
hl = [(x, y, z) for (x, y), (z, i) in em.items() if i == T and 201134 <= x <= 201152 and 557302 <= y <= 557307]
land = [(x, y) for x, y, z in hl if 147.6 <= z <= 148.1]; top = [(x, y) for x, y, z in hl if 148.6 <= z <= 148.8]
han = {'profile_y557304': row(557304, range(201130, 201153, 2)), 'profile_y557306': row(557306, range(201130, 201153, 2)),
       'cells147_6to148_1': {'cells': len(land), 'centre': [r1(statistics.mean(x for x, _ in land)), r1(statistics.mean(y for _, y in land))]},
       'cells148_6to148_8': {'cells': len(top), 'centre': [r1(statistics.mean(x for x, _ in top)), r1(statistics.mean(y for _, y in top))]},
       'proposedStairTopOnFieldBoundary': on_field(201148, 557304)[0], 'proposedLowerEnd': [201140.0, 557304.0], 'positionErrorM': 3,
       'note': 'S-MAP smooths a 1 m stair into a ramp: 147.0-148.0 m at x 201136-201141 just north of the north end of 은주1관, 148.9 m from x 201150. No bridge to 한림관 is in the S-MAP surface (ground drops to 132-146 m between x 201128 and 201136)'}
dael = {'profile_x201157': {str(y): (r1(em[(201157, y)][0]) if em[(201157, y)][1] == T else 'model') for y in range(557300, 557311)}, 'node561a12b4': [201157.33, 557301.3],
        'footOnFieldBoundary': on_field(201157.0, 557306.0)[0], 'upperEnd_universityMarker입구1': [201155.2, 557310.0], 'risers': '13 (building note: counted on a photo, +-1)', 'floor1M': 151.0}
doc = {'title': 'B09 수인관·상승관·운동장 출입 지점', 'applied': False, 'suin': suin, 'sangseung': sang, 'hanlim6F': han, 'daeilFront': dael}
out.write_text(json.dumps(doc, ensure_ascii=False, indent=1, default=float), encoding='utf-8', newline='\n')

# ------------------------------------------------------------ 그림
K = 2; img = cv2.resize(R, None, fx=K, fy=K, interpolation=cv2.INTER_CUBIC); PP = lambda x, y: (int(round((x - X0) * PXM * K)), int(round((Y1 - y) * PXM * K)))
for p, col in ((dae, (0, 255, 255)), (che, (255, 255, 0)), (src, (255, 0, 255)), (field, (0, 255, 0))): cv2.polylines(img, [np.array([PP(x, y) for x, y in p.exterior.coords], np.int32)], True, col, 2)
ys, xs = np.where(red > 0); ref = np.c_[xs, ys, np.ones(len(xs))] @ M.T
for rx, ry in ref[::3]: cv2.circle(img, (int(rx * K), int(ry * K)), 1, (0, 0, 255), -1)
for k in ('left', 'right'): cv2.circle(img, PP(*stairs[k]['footOnFieldBoundary']), 8, (0, 165, 255), -1)
for x, y in (MARK, ENTR): cv2.drawMarker(img, PP(x, y), (255, 255, 255), cv2.MARKER_CROSS, 22, 3)
cv2.imencode('.png', img)[1].tofile(str(audit / 'b09/상승관-사용자그림-좌표.png'))
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(9, 8)); im = ax.imshow(np.clip(g.z, 104, 150), origin='lower', extent=[g.xs[0] - .5, g.xs[-1] + .5, g.ys[0] - .5, g.ys[-1] + .5], cmap='terrain'); plt.colorbar(im, label='S-MAP surface (m), clipped 104-150')
ax.plot(*zip(*ring), 'r-', lw=2); ax.set_title('B09 Suin-gwan: S-MAP 1 m surface, red = source outline (EPSG:5186)'); fig.savefig(str(audit / 'b09/수인관-SMAP-1m.png'), dpi=110)
show = {'deck': suin['deck'], 'sides': [[x['side'], x['deckEndsAt_offsetFromOutline'], x['higherGroundOrBuildingAt_offset'], x['ground8to14mOut_byThirdAlongSide']] for x in sides], 'street': suin['heightFromStreetM'], 'gate': suin['serverDemGate'],
        'geo': {k: v for k, v in sang['georeference'].items() if k not in ('method', 'notChecked')}, 'box': sang['box'], 'yard': sang['yardBetweenBuildings'], 'src': sang['smapAtSourceBlock'], 'annex': sang['annexModel'], 'stairs': stairs, 'marks': sang['universityMarkers'], 'han': han, 'dael': dael}
print(json.dumps(show, ensure_ascii=False, default=float))
