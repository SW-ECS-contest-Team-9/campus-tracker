"""CT-M09 — comparison candidate: no open-slope transition where the photo-confirmed 은주2관 roof may border the field.

Photo fact (SM-11, CX-09/10): the green surface next to the field on the 은주2관 side is a roof (dormer rows), not a slope.
Our footprints have no '은주2관' polygon, so which edge run of the field polygon F it borders is NOT known from photos.
This script (1) tabulates every F edge run against the footprints, (2) marks the runs that could be the roof side as
'unknown' and BLOCKS their transition band (cells go back to the original DEM; no coordinates are invented),
(3) compares candidate A (c02_integrated.py) and this variant B over the same check scope.
The original DEM and candidate A files are only read.

  python roof_edge_variant.py <audit-dir> <campus.gpkg> <out.json> <out-variantB.f32>
"""
import json, sys, math, sqlite3, hashlib, pathlib
import numpy as np
from shapely import wkb
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

audit = pathlib.Path(sys.argv[1]); gpkg = pathlib.Path(sys.argv[2]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
meta = load(audit / 'terrain-grid-meta.json'); res = meta['resolution']; H, W = meta['height'], meta['width']
dem_path, a_path = audit / 'terrain-grid.f32', audit / 'claude-field-terrain-candidate.f32'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
sha_before = {p.name: sha(p) for p in (dem_path, a_path)}
dem = np.fromfile(dem_path, dtype='<f4').reshape(H, W).astype(float)
cand_a = np.fromfile(a_path, dtype='<f4').reshape(H, W).astype(float)
integ = load(audit / 'claude-c02-integrated-candidate.json')
F = Polygon(integ['field']['polygon5186']); FIELD_Z = integ['field']['zM']; BAND_M = 4.0
foot = {o['name']: unary_union([Polygon(p[0], p[1:]).buffer(0) for p in o['coordinates']]) for o in load(audit / 'building-outlines-5186.json')}
all_foot = unary_union(list(foot.values()))
runs = load(audit / 'claude-terrain-impact.json')['edgeRuns']


def bilinear(grid, x, y):  # backend/src/geo/dem.ts
    fx = (x - meta['originX']) / res - 0.5; fy = (y - meta['originY']) / res - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    return grid[iy, ix] * (1 - tx) * (1 - ty) + grid[iy, ix + 1] * tx * (1 - ty) + grid[iy + 1, ix] * (1 - tx) * ty + grid[iy + 1, ix + 1] * tx * ty


def outline_samples(geom):  # scene-heights.ts
    out = []
    for poly in getattr(geom, 'geoms', [geom]):
        ring = list(poly.exterior.coords)
        for (ax, ay), (bx, by) in zip(ring, ring[1:]):
            n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2))
            out += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    return out


def block(samples, h):
    s = sorted(samples); n = len(s); med = s[n >> 1] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    return round(s[0] - 1, 3), round(max(med + h, s[-1] + 3), 3)


# ---------------------------------------------------------- 1. edge runs vs footprints
eunju = foot['은주관']
table = []
for k, r in enumerate(runs):
    seg = [Point(*r['from']), Point(*r['to'])]
    near = sorted((round(min(g.distance(p) for p in seg), 1), n) for n, g in foot.items())[:3]
    roof_side = r['class'] == 'open' and near[0][1] in ('은주관', '수인관', '공연실습소')  # south gap toward 은주2관 only
    table.append({'run': k, 'class': r['class'], 'lengthM': r['lengthM'], 'from': r['from'], 'to': r['to'], 'nearestFootprints': near,
                  '은주2관Mapping': 'unknown (possible roof side) -> transition BLOCKED' if roof_side else
                                    ('wall run: footprint face, no transition in A either' if r['class'] == 'wall' else 'not the 은주2관 side (other open edge)')})
blocked = [t for t in table if t['은주2관Mapping'].startswith('unknown')]
eunju_parts = [{'areaM2': round(g.area, 1), 'bounds': [round(v, 1) for v in g.bounds]} for g in getattr(eunju, 'geoms', [eunju])]

# ---------------------------------------------------------- 2. variant B: revert band cells whose nearest F edge is a blocked run
edge_pts, edge_run = [], []
ring_pts = [F.exterior.interpolate(d) for d in np.arange(0, F.exterior.length, 1.0)]
starts = [Point(*r['from']) for r in runs]
cur = None
for p in ring_pts:
    hit = [k for k, s in enumerate(starts) if p.distance(s) < 0.75]
    if hit: cur = hit[0]
    edge_pts.append(p); edge_run.append(cur)
first = next(k for k in edge_run if k is not None)
edge_run = [first if k is None else k for k in edge_run]  # points before the first matched start belong to the wrapping run
blocked_runs = {t['run'] for t in blocked}
cand_b = cand_a.copy()
reverted = 0
band = (np.abs(cand_a - dem) > 1e-6)
for j, i in np.argwhere(band):
    x, y = meta['originX'] + (i + 0.5) * res, meta['originY'] + (j + 0.5) * res
    pt = Point(x, y)
    if F.contains(pt): continue
    k = edge_run[int(np.argmin([pt.distance(q) for q in edge_pts]))]
    if k in blocked_runs: cand_b[j, i] = dem[j, i]; reverted += 1
out_b = pathlib.Path(sys.argv[4]); cand_b.astype('<f4').tofile(out_b)


# ---------------------------------------------------------- 3. same-scope comparison
def scope_metrics(g):
    ch = np.abs(g - dem) > 1e-6
    ring = ch.copy()
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1): ring |= np.roll(np.roll(ch, dj, 0), di, 1)
    gy, gx = np.gradient(g, res); sl = np.hypot(gx, gy) * 100
    inside_fp = sum(all_foot.contains(Point(meta['originX'] + (i + 0.5) * res, meta['originY'] + (j + 0.5) * res)) for j, i in np.argwhere(ch))
    return ch, ring, sl, {'changedCells': int(ch.sum()), 'maxSlopePctNearChange': round(float(sl[ring].max()), 1),
                          'cellsOver100pct': int(((sl > 100) & ring).sum()), 'changedCellsInsideFootprints': int(inside_fp)}


ch_a, ring_scope, _, m_a = scope_metrics(cand_a)
ch_b, _, sl_b, m_b = scope_metrics(cand_b)
# same scope = A's change ring for both
gy, gx = np.gradient(cand_b, res); m_b['maxSlopePctInScopeA'] = round(float((np.hypot(gx, gy) * 100)[ring_scope].max()), 1)

con = sqlite3.connect(f'file:{gpkg}?mode=ro', uri=True)
gcol = con.execute("SELECT column_name FROM gpkg_geometry_columns WHERE table_name='buildings_3d'").fetchone()[0]
scene = {b['name']: b for b in load(live / 'scene-live.json')['buildings']}
mcp = {b['buildingId']: b for b in load(live / 'buildings.json')['buildings']}
bld = {}
for name, h, blob in con.execute(f'SELECT name, height_m, {gcol} FROM buildings_3d'):
    flags = blob[3]; env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    g = wkb.loads(bytes(blob[8 + env:])); p = mcp[scene[name]['buildingId']]
    pts = outline_samples(g) + [(p['x'], p['y'])]
    r0, ra, rb = (block([bilinear(gr, x, y) for x, y in pts], h) for gr in (dem, cand_a, cand_b))
    if ra != r0 or rb != r0:
        bld[name] = {'now': r0, 'A': ra, 'B': rb, 'B_minus_A': [round(rb[0] - ra[0], 3), round(rb[1] - ra[1], 3)]}

roads = {r['id']: r for r in load(live / 'roads-live.json')['items']}
unresolved = [b['id'] for b in integ['boundary'] if b['decision'].startswith('UNRESOLVED')]
road_cmp = []
for rid in unresolved:
    cs = roads[rid]['coordinates']
    d = lambda g: [round(min(c[2] - bilinear(g, c[0], c[1]) for c in cs), 2), round(max(c[2] - bilinear(g, c[0], c[1]) for c in cs), 2)]
    road_cmp.append({'id': rid, 'name': roads[rid]['name'], 'roadMinusTerrainA': d(cand_a), 'roadMinusTerrainB': d(cand_b)})

# ---------------------------------------------------------- 4. roof-as-ground check
viol = 0
for j, i in np.argwhere(np.abs(cand_b - dem) > 1e-6):
    lo, hi = min(FIELD_Z, dem[j, i]), max(FIELD_Z, dem[j, i])
    if not (lo - 1e-4 <= cand_b[j, i] <= hi + 1e-4): viol += 1
roof_check = {'changedCellsInsideAnyFootprint': m_b['changedCellsInsideFootprints'], 'cellsOutsideFieldToDemRange': viol,
              'blockedRunBandCellsLeft': int(sum(1 for j, i in np.argwhere(np.abs(cand_b - dem) > 1e-6) if not F.contains(Point(meta['originX'] + (i + 0.5) * res, meta['originY'] + (j + 0.5) * res))
                                                 and edge_run[int(np.argmin([Point(meta['originX'] + (i + 0.5) * res, meta['originY'] + (j + 0.5) * res).distance(q) for q in edge_pts]))] in blocked_runs)),
              'pass': None}
roof_check['pass'] = roof_check['changedCellsInsideAnyFootprint'] == 0 and viol == 0 and roof_check['blockedRunBandCellsLeft'] == 0

report = {'candidate': 'c02-integrated-v1 variant B (roof-side transition blocked)', 'operationallyApplicable': False,
          'inputsUnchanged': {n: sha(p) == s for (n, s), p in zip(sha_before.items(), (dem_path, a_path))},
          'variantB': {'file': out_b.name, 'sha256': sha(out_b), 'revertedBandCells': reverted},
          'edgeRunTable': table, '은주관FootprintParts': eunju_parts,
          'note': "no '은주2관' footprint exists in building-outlines-5186.json or the scene; the roof's footprint and which F edge it borders stay unknown",
          'compare': {'A': m_a, 'B': m_b}, 'buildingBaseRoof': bld, 'unresolvedRoadsVsTerrain': road_cmp, 'roofAsGroundCheck': roof_check}
pathlib.Path(sys.argv[3]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
print('blocked runs', sorted(blocked_runs), 'reverted', reverted, 'A', m_a, 'B', m_b, 'roofCheck', roof_check['pass'], 'inputsUnchanged', report['inputsUnchanged'])
