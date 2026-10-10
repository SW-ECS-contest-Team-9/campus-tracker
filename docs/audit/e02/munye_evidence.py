"""E02 — evidence level for the 문예관 high-rise and the effect of a roof override. Read-only, no database.

  python munye_evidence.py <audit-dir> <campus.gpkg> <out.json>

Inputs: <audit-dir>/claude-user-20261010/고층부식별/smap-grid-2m.txt (S-MAP mesh surface z + model id, 2 m grid, picked
2026-10-10), building-outlines-5186.json, terrain-grid.f32 (+meta), claude-live/{scene-live,buildings,roads-live-2}.json.
S-MAP is not an independent survey; "error" below means difference from the S-MAP mesh.
"""
import json, sys, math, sqlite3, hashlib, pathlib, statistics
import numpy as np
from shapely import wkb
from shapely.geometry import Point, Polygon

audit = pathlib.Path(sys.argv[1]); gpkg = pathlib.Path(sys.argv[2]); out = pathlib.Path(sys.argv[3])
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
r2 = lambda v: round(float(v), 2)
r3 = lambda v: round(v * 1000) / 1000
X0, Y0, R, NX = 201070, 557270, 2, 36
HIGH = 181.3  # same threshold as tower_identify.py / build_munye.py (model W p90 - 10)
ROOF = 189.4  # the override value under test

Z, M = {}, {}
for ln in (audit / 'claude-user-20261010/고층부식별/smap-grid-2m.txt').read_text(encoding='utf-8').splitlines():
    if ln.startswith('#') or not ln.strip(): continue
    j, sm, ids, vals = ln.strip().split(':'); vals = [int(v) for v in vals.split(',')]
    assert len(vals) == NX and sum(vals) == int(sm)
    for i, (v, c) in enumerate(zip(vals, ids)):
        if v > 0: Z[(i, int(j))] = v / 10; M[(i, int(j))] = c
XY = lambda k: (X0 + R * k[0], Y0 + R * k[1])
outlines = {b['name']: Polygon(b['coordinates'][0][0]) for b in load(audit / 'building-outlines-5186.json')}
munye = outlines['문예관']
scene = {b['name']: b for b in load(audit / 'claude-live/scene-live.json')['buildings']}
inside_munye = lambda x, y: munye.contains(Point(x, y))
signed = lambda x, y: (-1 if inside_munye(x, y) else 1) * munye.exterior.distance(Point(x, y))  # + outside


def stats(v):
    s = sorted(v)
    if not s: return {'n': 0}
    q = lambda p: s[min(len(s) - 1, int(len(s) * p))]
    return {'n': len(s), 'min': r2(s[0]), 'p10': r2(q(.1)), 'median': r2(statistics.median(s)), 'p90': r2(q(.9)), 'max': r2(s[-1])}


def jump(k):  # largest |dz| to a 4-neighbour of the same model (99 = no such neighbour)
    nb = [(k[0] + a, k[1] + b) for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))]
    d = [abs(Z[n] - Z[k]) for n in nb if n in Z and M[n] == M[k]]
    return max(d) if d else 99


# ---- (a) high roof: samples inside the source outline ----
inside = [k for k in Z if inside_munye(*XY(k))]
hi_in = [k for k in inside if Z[k] >= HIGH]
flat_hi = [k for k in hi_in if jump(k) <= 3]
med = statistics.median(Z[k] for k in flat_hi)
res_a = {
    'insideCells': len(inside), 'insideHigh': len(hi_in), 'highShareOfOutlineCells': r2(len(hi_in) / len(inside)),
    'insideNotHigh': [{'xy': XY(k), 'z': Z[k], 'model': M[k], 'distToOutlineEdgeM': r2(munye.exterior.distance(Point(XY(k))))} for k in inside if Z[k] < HIGH],
    'flatHigh': stats([Z[k] for k in flat_hi]),
    'slab(<=median+1)': stats([Z[k] for k in flat_hi if Z[k] <= med + 1]),
    'aboveMedian+1(parapet/penthouse)': stats([Z[k] for k in flat_hi if Z[k] > med + 1]),
    'allHighInside': stats([Z[k] for k in hi_in]),
}

# ---- (b) low part: flat cells of the same S-MAP model below the threshold ----
low = sorted(k for k in Z if M[k] == 'W' and Z[k] < HIGH and jump(k) <= 3)
res_b = {
    'cells': [{'xy': XY(k), 'z': Z[k], 'insideOutline': inside_munye(*XY(k)), 'distToOutlineM': r2(munye.distance(Point(XY(k))))} for k in low],
    'z': stats([Z[k] for k in low]), 'insideOutline': sum(inside_munye(*XY(k)) for k in low), 'areaM2': len(low) * R * R,
}

# ---- (c) plan edge of the high part: every 4-neighbour pair (high cell, not-high cell) brackets the roof edge within 2 m ----
hi_all = [k for k in Z if Z[k] >= HIGH and M[k] == 'W']
pairs = []
for k in hi_all:
    for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        n = (k[0] + a, k[1] + b)
        if n in Z and Z[n] < HIGH:
            (hx, hy), (lx, ly) = XY(k), XY(n)
            pairs.append({'mid': ((hx + lx) / 2, (hy + ly) / 2), 'sdHigh': signed(hx, hy), 'sdLow': signed(lx, ly), 'sdMid': signed((hx + lx) / 2, (hy + ly) / 2)})
mid = [p['sdMid'] for p in pairs]
ring = list(munye.exterior.coords); sides = []
for (ax, ay), (bx, by) in zip(ring, ring[1:]):  # brackets whose nearest outline side is this one
    L = math.hypot(bx - ax, by - ay)

    def seg_dist(p):
        t = max(0, min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / (L * L)))
        return math.hypot(p[0] - ax - t * (bx - ax), p[1] - ay - t * (by - ay))
    near = [p['sdMid'] for p in pairs if abs(seg_dist(p['mid']) - munye.exterior.distance(Point(p['mid']))) < 1e-6]
    sides.append({'from': (r2(ax), r2(ay)), 'to': (r2(bx), r2(by)), 'lengthM': r2(L), 'brackets': len(near),
                  'offsetMedianM': r2(statistics.median(near)) if near else None, 'offsetMinM': r2(min(near)) if near else None, 'offsetMaxM': r2(max(near)) if near else None})
res_c = {
    'convention': 'offset = signed distance of a roof-edge bracket midpoint from the source outline, + outside. A bracket is 2 m wide, so the edge is known to +-1 m at best.',
    'brackets': len(pairs), 'outlinePassesBetweenTheTwoCells': sum(p['sdHigh'] <= 0 <= p['sdLow'] for p in pairs),
    'offsetMid': stats(mid), 'absOffsetMedian': r2(statistics.median(abs(m) for m in mid)), 'absOffsetP90': r2(sorted(abs(m) for m in mid)[int(len(mid) * .9)]),
    'highCellsOutsideOutline': {'n': sum(not inside_munye(*XY(k)) for k in hi_all), 'of': len(hi_all),
                                'maxDistM': r2(max(munye.distance(Point(XY(k))) for k in hi_all))},
    'bySide': sides,
    'nearestHighCellToLowPatchM': r2(min(math.dist(XY(a), XY(b)) for a in hi_all for b in low)) if low else None,
    'outlineAreaM2': r2(munye.area),
}

# ---- cross-check of the S-MAP mesh roof against other buildings in the same grid ----
cross = {}
for sym, name in (('H', '한림관'), ('M', '본관'), ('B', '북악관')):
    cells = [k for k in Z if M[k] == sym and outlines[name].contains(Point(XY(k)))]
    zs = sorted(Z[k] for k in cells); top = zs[min(len(zs) - 1, int(len(zs) * .9))] - 10
    roof = [Z[k] for k in cells if Z[k] >= top and jump(k) <= 3]
    s = scene[name]
    cross[name] = {'gridCoversOutlineShare': r2(len(cells) * R * R / outlines[name].area), 'meshRoof': stats(roof), 'sceneRoofM': s['roofM'],
                   'heightSource': s['heightSource'], 'heightM': s['heightM'],
                   'sceneMinusMeshMedian': r2(s['roofM'] - statistics.median(roof)), 'sceneMinusMeshMax': r2(s['roofM'] - max(roof))}
smap = [{'name': e['name'], 'x': e['x'], 'y': e['y'], **json.loads(e['raw'])['result']} for e in load(audit / 'claude-user-20261010/고층부식별/smap-elevation-raw.json')]

# ---- current vs override on the server rule (scene-heights.ts), exact import inputs ----
assert hashlib.sha256(gpkg.read_bytes()).hexdigest() == '26c66faa36bd03c3f7106d68ac8a2f8e0a89a452f7899e5b0f20ab0673b45d13'
meta = load(audit / 'terrain-grid-meta.json'); res = meta['resolution']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])


def bilinear(x, y):  # dem.ts
    fx = (x - meta['originX']) / res - 0.5; fy = (y - meta['originY']) / res - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    g = lambda a, b: float(dem[b, a])
    return g(ix, iy) * (1 - tx) * (1 - ty) + g(ix + 1, iy) * tx * (1 - ty) + g(ix, iy + 1) * (1 - tx) * ty + g(ix + 1, iy + 1) * tx * ty


con = sqlite3.connect(f'file:{gpkg.as_posix()}?mode=ro', uri=True)
blob, h_src = con.execute("select geom, height_m from buildings_3d where name='문예관'").fetchone()
env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(blob[3] >> 1) & 7]
geom = wkb.loads(bytes(blob[8 + env:]))
pts = []
for poly in getattr(geom, 'geoms', [geom]):  # scene-heights.ts outlineSamples
    rg = list(poly.exterior.coords)
    for (ax, ay), (bx, by) in zip(rg, rg[1:]):
        n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2))
        pts += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
b = next(x for x in load(audit / 'claude-live/buildings.json')['buildings'] if x['name'] == '문예관')
pts.append((b['x'], b['y']))  # PostGIS ST_PointOnSurface of the same geometry (cm), as in scene_heights_repro.py
s = sorted(bilinear(x, y) for x, y in pts); tmed = statistics.median(s)
cur = {'baseM': r3(s[0] - 1), 'roofM': r3(max(tmed + h_src, s[-1] + 3)), 'heightM': h_src, 'terrainMedianM': r3(tmed), 'terrainMinM': r3(s[0]), 'terrainMaxM': r3(s[-1])}
live = scene['문예관']
assert abs(cur['roofM'] - live['roofM']) < 0.02 and abs(cur['baseM'] - live['baseM']) < 0.02, cur
new = {'baseM': cur['baseM'], 'roofM': ROOF, 'heightM': r3(ROOF - tmed)}
allhi = [Z[k] for k in hi_in]
err = lambda roof: {'vsSlabMedian': r2(roof - med), 'vsHighCellsMin': r2(roof - max(allhi)), 'vsHighCellsMax': r2(roof - min(allhi)),
                    'cellsWithin1m': sum(abs(roof - z) <= 1 for z in allhi), 'cellsWithin2m': sum(abs(roof - z) <= 2 for z in allhi), 'cells': len(allhi)}

# ---- roads inside / referencing 문예관 ----
rr = []
for r in load(audit / 'claude-live/roads-live-2.json')['items']:
    zin = [c[2] for c in r['coordinates'] if inside_munye(c[0], c[1])]
    if zin or r.get('buildingId') == '문예관':
        rr.append({'id': r['id'][:8], 'name': r.get('name'), 'structure': r.get('structure'), 'buildingId': r.get('buildingId'), 'levelId': r.get('levelId'),
                   'verticesInside': len(zin), 'zInside': [min(zin), max(zin)] if zin else None})
zin_all = [x['zInside'][1] for x in rr if x['zInside']]
result = {
    'a_highRoof': res_a, 'b_lowPart': res_b, 'c_planEdge': res_c, 'crossCheck': cross, 'smapElevationApi': smap,
    'serverRule': {'current': cur, 'withOverride': new, 'liveScene': {k: live[k] for k in ('baseM', 'roofM', 'heightM', 'heightSource')}},
    'roofError': {'current': err(cur['roofM']), 'withOverride': err(ROOF)},
    'roads': {'maxZInside': max(zin_all), 'aboveCurrentRoof': sum(z > cur['roofM'] for z in zin_all), 'aboveOverrideRoof': sum(z > ROOF for z in zin_all), 'list': rr},
}
out.write_text(json.dumps(result, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=1))
