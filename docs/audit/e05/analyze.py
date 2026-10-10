"""E05 — 은주관 부분별 지붕, 공연실습소 위치 후보, 12개 건물 선별 점검. 읽기 전용, DB 없음.

  python analyze.py <audit-dir> <backend-dir> <out.json> <plot-dir>

입력: <audit-dir>/e05/smap-mesh-*.txt (S-MAP 3D 뷰어 화면의 건물·지형 모델 표면 z 와 모델 id, 2026-10-10, collect_grid.js),
<audit-dir>/e05/smap-elevation-raw.json, <audit-dir>/claude-live/{scene-live,roads-live-2}.json, <audit-dir>/terrain-grid.f32(+meta),
<backend-dir>/data/scene/source/campus.gpkg, <backend-dir>/data/terrain/source/{buildings_al_d010,skuniv_buildings,skuniv_places}.json
S-MAP 은 독립 측량이 아니다. 아래 "차이"는 S-MAP 화면 모델과의 차이다.
"""
import json, sys, math, pathlib, statistics, collections
import numpy as np
from shapely.geometry import Point, Polygon, box, mapping
from grids import Grid, stack, gpkg_buildings
from eunju_parts import parts, to1, to2, TOWER_C, TOWER_R
from tm5186 import to5186

audit, backend, out, plots = map(pathlib.Path, sys.argv[1:5])
E05 = audit / 'e05'
load = lambda p: json.loads(pathlib.Path(p).read_text(encoding='utf-8'))
r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2); r3 = lambda v: round(float(v) * 1000) / 1000
TERRAIN = 419430528


def stats(v):
    s = sorted(float(x) for x in v)
    if not s: return {'n': 0}
    q = lambda p: s[min(len(s) - 1, int(len(s) * p))]
    return {'n': len(s), 'min': r1(s[0]), 'p10': r1(q(.1)), 'median': r1(statistics.median(s)), 'p90': r1(q(.9)), 'max': r1(s[-1])}


B = {b['name']: b for b in gpkg_buildings(backend / 'data/scene/source/campus.gpkg')}
poly = lambda n: (B[n]['geom'].geoms[0] if hasattr(B[n]['geom'], 'geoms') else B[n]['geom'])
scene = {b['name']: b for b in load(audit / 'claude-live/scene-live.json')['buildings']}
meta = load(audit / 'terrain-grid-meta.json'); res = meta['resolution']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])


def bilinear(x, y):  # dem.ts
    fx = (x - meta['originX']) / res - 0.5; fy = (y - meta['originY']) / res - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    g = lambda a, b: float(dem[b, a])
    return g(ix, iy) * (1 - tx) * (1 - ty) + g(ix + 1, iy) * tx * (1 - ty) + g(ix, iy + 1) * (1 - tx) * ty + g(ix + 1, iy + 1) * tx * ty


def block(p, roof):  # scene-heights.ts: outline every 2 m + one interior point (shapely's; PostGIS' point may differ, cm-level effect)
    rg = list(p.exterior.coords); pts = []
    for (ax, ay), (bx, by) in zip(rg, rg[1:]):
        n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2))
        pts += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    c = p.representative_point(); pts.append((c.x, c.y))
    s = sorted(bilinear(x, y) for x, y in pts); med = statistics.median(s)
    return {'baseM': r3(s[0] - 1), 'terrainMinM': r3(s[0]), 'terrainMedianM': r3(med), 'terrainMaxM': r3(s[-1]), 'roofM': roof, 'heightM': r3(roof - med)}


# ---------------------------------------------------------------- A. 은주관
g = stack([E05 / f'smap-mesh-eunju-1m-{c}.txt' for c in 'abc'])
EJ = 172556289
P = poly('은주관')
cells = list(g.cells())
inside = [(x, y, z, i) for x, y, z, i in cells if P.contains(Point(x, y))]
model = [(x, y, z) for x, y, z, i in cells if i == EJ]
cur = scene['은주관']
ps = parts(P)
A_parts = []
for name, p in ps.items():
    zin = [z for x, y, z, i in inside if i == EJ and p.contains(Point(x, y))]
    nall = sum(1 for x, y, z, i in inside if p.contains(Point(x, y)))
    roof = r1(statistics.median(zin))
    bl = block(p, roof)
    A_parts.append({'part': name, 'areaM2': r1(p.area), 'gridCells': nall, 'buildingModelCells': len(zin), 'meshRoof': stats(zin), 'chosenFlatRoofM': roof,
                    'cellsWithin1m': r2(np.mean([abs(z - roof) <= 1 for z in zin])), 'cellsWithin1_5m': r2(np.mean([abs(z - roof) <= 1.5 for z in zin])),
                    'currentRoofM': cur['roofM'], 'currentMinusMeshMedianM': r1(cur['roofM'] - roof),
                    'onServerDem': bl, 'gateRoofAboveGround': roof > bl['terrainMaxM'],
                    'polygon5186': [[[r2(x), r2(y)] for x, y in rg.coords] for rg in (p.exterior, *p.interiors)]})
PART = {a['part']: a for a in A_parts}
# roof form: profile across each arm (1 m bins), away from the junction and the ends
prof1, prof2 = collections.defaultdict(list), collections.defaultdict(list)
for x, y, z, i in cells:
    s, o = to1(x, y)
    if 20 <= s <= 86 and -22 <= o <= 8 and not (30 <= s <= 44 and o > -1): prof1[math.floor(o)].append((z, i == EJ))
    t, o = to2(x, y)
    if 2 <= t <= 66 and -8 <= o <= 28: prof2[math.floor(o)].append((z, i == EJ))
pr = lambda d: [{'offsetM': k, 'medianZ': r1(statistics.median(z for z, _ in v)), 'buildingShare': r2(np.mean([b for _, b in v]))} for k, v in sorted(d.items())]
# ground on both sides (terrain cells just outside each arm)
hal = poly('한림관')
g1w = [z for x, y, z, i in cells if i == TERRAIN and 20 <= to1(x, y)[0] <= 86 and 3 <= to1(x, y)[1] <= 8 and Point(x, y).distance(hal) > 3]
g1e = [z for x, y, z, i in cells if i == TERRAIN and 20 <= to1(x, y)[0] <= 86 and -22 <= to1(x, y)[1] <= -17]
g2s = [z for x, y, z, i in cells if i == TERRAIN and 2 <= to2(x, y)[0] <= 66 and -8 <= to2(x, y)[1] <= -3]
g2n = [z for x, y, z, i in cells if i == TERRAIN and 2 <= to2(x, y)[0] <= 66 and 24 <= to2(x, y)[1] <= 28]
moat = [z for x, y, z, i in cells if i == TERRAIN and 2 <= to2(x, y)[0] <= 66 and 19 <= to2(x, y)[1] <= 21]
tower = [(x, y) for x, y, z in model if abs(z - 162.5) < 0.3 and x < 201145]
uni = {b['건물명']: to5186(float(b['경도']), float(b['위도'])) for b in load(backend / 'data/terrain/source/skuniv_buildings.json')}
entr = [{'name': p['장소명'], 'xy': [r1(v) for v in to5186(float(p['경도']), float(p['위도']))], 'text': p['설명']}
        for p in load(backend / 'data/terrain/source/skuniv_places.json') if '은주' in p['장소명'] and ('입구' in p['장소명'] or '연결' in p['장소명'])]
n_model_in = sum(1 for x, y, z in model if P.contains(Point(x, y)))
med = statistics.median
res_A = {
    'source': 'S-MAP 3D viewer building model 172556289 surface, 1 m grid x 201105-201215, y 557140-557310 (18,981 points, 0 missing)',
    'footprint': {'sourceOutlineAreaM2': r1(P.area), 'gridCellsInsideOutline': len(inside), 'ofThemBuildingModel': sum(1 for c in inside if c[3] == EJ),
                  'modelCells': len(model), 'modelCellsInsideOutline': n_model_in, 'modelCellsOutside': len(model) - n_model_in,
                  'modelCellsOutsideMaxDistM': r1(max(P.distance(Point(x, y)) for x, y, z in model)),
                  'notModelInsideOutline': stats([z for x, y, z, i in inside if i != EJ])},
    'current': {k: cur[k] for k in ('baseM', 'roofM', 'heightM', 'heightSource', 'terrainMinM', 'terrainMaxM')},
    'parts': A_parts,
    'profileAcross1관': {'convention': 'offset from the west edge line, + = west (outside), - = east (field side); s 20-86 m without the west bay', 'bins': pr(prof1)},
    'profileAcross2관': {'convention': 'offset from the south-west edge line, + = north-east (field side); t 2-66 m', 'bins': pr(prof2)},
    'ground': {'1관 서쪽 3-8 m 밖': stats(g1w), '1관 동쪽(운동장) 5-10 m 밖': stats(g1e), '2관 남서쪽 3-8 m 밖': stats(g2s), '2관 북동쪽(운동장) 5-9 m 밖': stats(g2n),
               '2관 운동장 쪽 벽 바로 앞 0-2 m': stats(moat)},
    'tower': {'cellsAt162_5': len(tower), 'centre': [r1(np.mean([p[0] for p in tower])), r1(np.mean([p[1] for p in tower]))], 'equivalentRadiusM': r1(math.sqrt(len(tower) / math.pi)),
              'usedCircle': {'centre': TOWER_C, 'radiusM': TOWER_R}, 'bbox': [min(p[0] for p in tower), min(p[1] for p in tower), max(p[0] for p in tower), max(p[1] for p in tower)]},
    'universityPoints': {k: [r1(v[0]), r1(v[1])] for k, v in uni.items() if '은주' in k}, 'universityEntrances': entr,
    'register42228': {'heightM': 25.5, 'groundFloors': 7},
    'derived': {'1관 roof - west ground': r1(PART['은주1관']['chosenFlatRoofM'] - med(g1w)), '1관 roof - field': r1(PART['은주1관']['chosenFlatRoofM'] - med(g1e)),
                '2관 roof - south-west ground': r1(PART['은주2관']['chosenFlatRoofM'] - med(g2s)), '2관 roof - field': r1(PART['은주2관']['chosenFlatRoofM'] - med(g2n)),
                'field - 1관 west ground': r1(med(g1e) - med(g1w)), 'field - 2관 south-west ground': r1(med(g2n) - med(g2s))},
}

# ---------------------------------------------------------------- B. 공연실습소
cg = Grid(E05 / 'smap-mesh-cluster-1m.txt')
reg = load(backend / 'data/terrain/source/buildings_al_d010.json')['features']
rpoly = {f['attributes']['sourceId']: Polygon(f['rings'][0]) for f in reg}
rattr = {f['attributes']['sourceId']: f['attributes'] for f in reg}
ccells = list(cg.cells())
elev = {e['name']: {'x': e['x'], 'y': e['y'], **json.loads(e['raw'])['result']} for e in load(E05 / 'smap-elevation-raw.json')}
cand = []
for label, mid in (('A 큰 흰 지붕 건물', 171376641), ('B 팔각 건물', 172359682), ('C 작은 건물', 171311108), ('D 작은 건물', 171311113)):
    c = [(x, y, z) for x, y, z, i in ccells if i == mid]
    hull = Polygon([(x, y) for x, y, z in c]).convex_hull
    near = lambda p: min(math.hypot(p[0] - x, p[1] - y) for x, y, z in c[::5])
    ring = [p[2] for p in ccells if p[3] == TERRAIN and hull.distance(Point(p[0], p[1])) <= 7 and 2 <= near(p) <= 6]
    over = sorted(((sid, r2(sum(1 for x, y, z in c if q.contains(Point(x, y))) / len(c))) for sid, q in rpoly.items() if q.intersects(hull)), key=lambda t: -t[1])
    api = next((v for k, v in elev.items() if k.startswith('묶음 ' + label[0])), None)
    cand.append({'label': label, 'smapModelId': mid, 'cells': len(c), 'areaM2approx': len(c),
                 'bbox5186': [min(x for x, y, z in c), min(y for x, y, z in c), max(x for x, y, z in c), max(y for x, y, z in c)],
                 'centre': [r1(np.mean([x for x, y, z in c])), r1(np.mean([y for x, y, z in c]))], 'roof': stats([z for x, y, z in c]), 'groundRing2to6m': stats(ring),
                 'smapElevationApi': api, 'roofMinusSmapDem': r1(med(z for x, y, z in c) - api['dem_z']) if api else None,
                 'registerPolygonsUnder': [{'sourceId': s, 'shareOfModelCells': sh, **{k: rattr[s][k] for k in ('jibun', 'use', 'footprintM2', 'heightM', 'groundFloors', 'undergroundFloors', 'approvedOn', 'dongName')}} for s, sh in over if sh > 0.05],
                 'hull5186': [[r1(x), r1(y)] for x, y in hull.exterior.coords]})
# the polygon labelled 공연실습소 on 혜인관
scells = list(Grid(E05 / 'smap-mesh-south-2m.txt').cells())
dup, hy = rpoly['53636'], rpoly['42232']


def cover(q):
    c = [(z, i) for x, y, z, i in scells if q.contains(Point(x, y))]
    return {'cells': len(c), 'models': {str(k): v for k, v in collections.Counter(i for z, i in c).most_common(4)}, 'buildingZ': stats([z for z, i in c if i != TERRAIN]), 'terrainZ': stats([z for z, i in c if i == TERRAIN])}


hm = collections.Counter(i for x, y, z, i in scells if hy.contains(Point(x, y)) and i != TERRAIN).most_common(1)[0][0]
hcells = [(x, y, z) for x, y, z, i in scells if i == hm]
gp = poly('공연실습소')
res_B = {
    'label평생교육원': {'smapLabelOn': '유담관 외곽 위의 타원형 건물(같은 건물 위에 "평생교육원", "YUDAM도서관" 표기)', 'register42013dongName': rattr['42013']['dongName'],
                    'universityPoint유담관': [r1(v) for v in uni['유담관']], 'universityPointInsideOutline': poly('유담관').contains(Point(uni['유담관']))},
    'userImageOrientation': '화면 위쪽이 대략 남쪽(은주2관 왼쪽 위, 한림관 왼쪽 아래, 평생교육원 가운데). 회전교차로는 (200990, 557237) 부근이고 묶음은 그 남쪽, 유담관에서 길 건너 남서쪽',
    'cluster': {'bbox5186': [200982, 557184, 201050, 557232], 'candidates': cand},
    'register53636': {**rattr['53636'], 'polygonAreaM2': r1(dup.area), 'polygonBounds': [r1(v) for v in dup.bounds],
                      'overlapWith42232': {'shareOf53636': r2(dup.intersection(hy).area / dup.area), 'iou': r2(dup.intersection(hy).area / dup.union(hy).area)},
                      'gpkg공연실습소AreaM2': r1(gp.area), 'gpkgVsRegisterPolygonSymDiffM2': r2(gp.symmetric_difference(dup).area)},
    'meshOn혜인관': {'under42232(혜인관)': cover(hy), 'under53636(공연실습소 표기 도형)': cover(dup), 'modelId': hm, 'modelCells': len(hcells),
                  'modelCellsInside42232': sum(1 for x, y, z in hcells if hy.contains(Point(x, y))), 'modelCellsInside53636': sum(1 for x, y, z in hcells if dup.contains(Point(x, y))),
                  'in53636notIn42232': cover(dup.difference(hy)), 'in42232notIn53636': cover(hy.difference(dup))},
}

# ---------------------------------------------------------------- C. 12 건물 선별 점검
G = {}  # (x, y) on the 2 m lattice -> (z, id); the 1 m 은주 grid is thinned to even coordinates
for f in ('south-2m', 'ne-2m', 'nw-2m', 'yudam-2m'):
    for x, y, z, i in Grid(E05 / f'smap-mesh-{f}.txt').cells(): G[(x, y)] = (z, i)
for x, y, z, i in cells:
    if x % 2 == 0 and y % 2 == 0: G[(x, y)] = (z, i)
res_C = []
for name in B:
    p = poly(name); x0, y0, x1, y1 = p.bounds
    pts = [(x, y) for x in range(int(x0) // 2 * 2 - 6, int(x1) + 8, 2) for y in range(int(y0) // 2 * 2 - 6, int(y1) + 8, 2)]
    have = [k for k in pts if k in G]
    ins = [k for k in have if p.contains(Point(k))]
    need = sum(1 for k in pts if p.contains(Point(k)))
    ids = collections.Counter(G[k][1] for k in ins if G[k][1] != TERRAIN)
    s = scene[name]
    row = {'name': name, 'buildingId': s['buildingId'], 'outlineAreaM2': round(p.area), 'gridCoverage': r2(len(ins) / need) if need else 0, 'cellsInside': len(ins),
           'currentBaseM': s['baseM'], 'currentRoofM': s['roofM'], 'heightSource': s['heightSource'], 'buildingModelsInside': {str(k): v for k, v in ids.most_common(4)}}
    if ids:
        mz = [G[k][0] for k in ins if G[k][1] != TERRAIN]
        mc = [k for k in have if G[k][1] in ids]   # cells of those models within 6 m of the bounds
        outside = [k for k in mc if not p.contains(Point(k))]
        top = sorted(mz)[min(len(mz) - 1, int(len(mz) * .9))]
        row.update({'buildingModelShareInside': r2(len(mz) / len(ins)), 'terrainCellsInside': stats([G[k][0] for k in ins if G[k][1] == TERRAIN]),
                    'meshRoof': stats(mz), 'currentMinusMeshMedianM': r1(s['roofM'] - med(mz)), 'currentMinusMeshP90M': r1(s['roofM'] - top),
                    'modelCellsOutsideOutline': len(outside), 'modelCellsOutsideBeyond2m': sum(1 for k in outside if p.distance(Point(k)) > 2),
                    'iouModelVsOutline': r2(len(mz) / (len(ins) + len(outside)))})
    else:
        row.update({'buildingModelShareInside': 0.0, 'surfaceInside': stats([G[k][0] for k in ins]),
                    'currentMinusSurfaceMedianM': r1(s['roofM'] - med(G[k][0] for k in ins)) if ins else None})
    res_C.append(row)

# ---------------------------------------------------------------- roads that reference the touched buildings
roads = load(audit / 'claude-live/roads-live-2.json')['items']
refs = collections.Counter(r.get('buildingId') for r in roads)
res_refs = {'roads': len(roads), 'byBuildingId': {str(k): v for k, v in refs.items()},
            '은주관': refs.get('은주관', 0), '혜인관(공연실습소 표기 도형의 buildingId)': refs.get('혜인관', 0), '건물5(혜인관 도형의 buildingId)': refs.get('건물5', 0)}

out.write_text(json.dumps({'A_은주관': res_A, 'B_공연실습소': res_B, 'C_screen': res_C, 'roadReferences': res_refs}, ensure_ascii=False, indent=1), encoding='utf-8')
(plots / 'eunju-parts-5186.geojson').write_text(json.dumps({'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'EPSG:5186'}}, 'features': [
    {'type': 'Feature', 'properties': {'part': a['part'], 'roofM': a['chosenFlatRoofM']}, 'geometry': mapping(ps[a['part']])} for a in A_parts]}, ensure_ascii=False), encoding='utf-8')

# ---------------------------------------------------------------- plots
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = ['Malgun Gothic', 'DejaVu Sans']; plt.rcParams['axes.unicode_minus'] = False
fig, ax = plt.subplots(figsize=(9, 12)); ext = [g.x0 - .5, g.xs[-1] + .5, g.y0 - .5, g.ys[-1] + .5]
im = ax.imshow(g.z, origin='lower', extent=ext, cmap='turbo', vmin=128, vmax=166); plt.colorbar(im, ax=ax, shrink=.6, label='S-MAP 화면 모델 표면 높이 (m)')
for n in ('혜인관', '수인관', '한림관', '대일관'):
    x, y = poly(n).exterior.xy; ax.plot(x, y, color='0.35', lw=.8)
x, y = P.exterior.xy; ax.plot(x, y, 'k--', lw=2, label=f"지금 모델: 한 덩어리, 지붕 {cur['roofM']:.1f} m")
for a in A_parts:
    q = ps[a['part']]; x, y = q.exterior.xy; ax.plot(x, y, 'w-', lw=1.2)
    c = q.representative_point(); ax.text(c.x, c.y, f"{a['part']}\n{a['chosenFlatRoofM']}", fontsize=6.5, ha='center', va='center', color='k', bbox=dict(fc='w', alpha=.7, lw=0, pad=1))
ax.plot([], [], 'w-', lw=1.2, label='새 부분 경계(흰 선)와 부분별 평지붕 높이'); ax.legend(loc='upper right', fontsize=8, facecolor='0.8')
ax.set_xlim(ext[0], ext[1]); ax.set_ylim(ext[2], ext[3]); ax.set_title('은주관: S-MAP 건물 모델 높이(1 m 격자)와 원천 외곽·새 부분 (EPSG:5186)', fontsize=10)
plt.tight_layout(); plt.savefig(plots / 'eunju-mesh-parts.png', dpi=80); plt.close()

fig, ax = plt.subplots(figsize=(11, 8)); ext = [cg.x0 - .5, cg.xs[-1] + .5, cg.y0 - .5, cg.ys[-1] + .5]
im = ax.imshow(cg.z, origin='lower', extent=ext, cmap='turbo', vmin=84, vmax=125); plt.colorbar(im, ax=ax, shrink=.7, label='S-MAP 화면 모델 표면 높이 (m)')
for sid, q in rpoly.items():
    if q.intersects(box(ext[0], ext[2], ext[1], ext[3])):
        x, y = q.exterior.xy; ax.plot(x, y, 'k-', lw=.7)
        if sid in ('30791', '32420', '21878', '42013'): c = q.representative_point(); ax.text(c.x, c.y, sid, fontsize=7)
for c in cand:
    x, y = zip(*c['hull5186']); ax.plot(x, y, 'w--', lw=1.5)
    ax.text(c['centre'][0], c['centre'][1], f"{c['label'][0]}\n{c['roof']['median']} m\n{c['cells']} ㎡", fontsize=8, ha='center', color='w', weight='bold')
ax.set_xlim(ext[0], ext[1]); ax.set_ylim(ext[2], ext[3]); ax.set_title('사용자 표시 묶음: S-MAP 건물 모델(흰 점선 A~D)과 대장 도형(검은 선) (EPSG:5186)', fontsize=10)
plt.tight_layout(); plt.savefig(plots / 'cluster-mesh-candidates.png', dpi=80); plt.close()
print('ok')
