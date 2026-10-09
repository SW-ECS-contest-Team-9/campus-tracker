"""CT-M07 — reproduce the server scene base/roof with the exact import inputs, then compare boundary/strip options.

Inputs (read-only):
  - GeoPackage backend/data/scene/source/campus.gpkg, layer buildings_3d (geometry + height_m), SHA-256 checked.
  - Interior reference point: the import uses ST_PointOnSurface(geometry) from PostGIS. The same PostGIS value for the same
    geometry comes from the editor MCP list_buildings (scene_buildings.geom = the imported geometry), rounded to cm
    (claude-live/buildings.json). It is NOT replaced by shapely.
  - DEM: the active terrain grid (sha-identical archive). Sampling = backend/src/geo/dem.ts bilinear.
  - Rules: scene-heights.ts outlineSamples (outer ring of each polygon, every <=2 m, ring end excluded) + blockHeights.
Then: field-edge classification with photo observations CX-01..03 vs baseline, and three wall-strip options.

  python scene_heights_repro.py <audit-dir> <campus.gpkg> <out.json>
"""
import json, sys, math, struct, sqlite3, hashlib, pathlib
import numpy as np
from shapely import wkb
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

audit = pathlib.Path(sys.argv[1]); gpkg = pathlib.Path(sys.argv[2]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
GPKG_SHA = '26c66faa36bd03c3f7106d68ac8a2f8e0a89a452f7899e5b0f20ab0673b45d13'
meta = load(audit / 'terrain-grid-meta.json'); res = meta['resolution']; H, W = meta['height'], meta['width']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(H, W)
cand = np.fromfile(audit / 'claude-field-terrain-candidate.f32', dtype='<f4').reshape(H, W)


def bilinear(grid, x, y):  # dem.ts
    fx = (x - meta['originX']) / res - 0.5; fy = (y - meta['originY']) / res - 0.5
    ix, iy = math.floor(fx), math.floor(fy); tx, ty = fx - ix, fy - iy
    v00, v10, v01, v11 = (float(grid[iy, ix]), float(grid[iy, ix + 1]), float(grid[iy + 1, ix]), float(grid[iy + 1, ix + 1]))
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty


def outline_samples(geom):  # scene-heights.ts outlineSamples (outer rings only)
    out = []
    for poly in getattr(geom, 'geoms', [geom]):
        ring = list(poly.exterior.coords)
        for (ax, ay), (bx, by) in zip(ring, ring[1:]):
            n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2))
            out += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    return out


def block(samples, h):  # scene-heights.ts blockHeights
    s = sorted(samples); n = len(s); med = s[n >> 1] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    roof = med + h
    return round(s[0] - 1, 3), round(roof if roof >= s[-1] + 3 else s[-1] + 3, 3), roof < s[-1] + 3


def gpkg_geom(blob):  # GeoPackage binary header + WKB
    flags = blob[3]; env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    return wkb.loads(bytes(blob[8 + env:]))


sha = hashlib.sha256(gpkg.read_bytes()).hexdigest()
con = sqlite3.connect(f'file:{gpkg}?mode=ro', uri=True)
gcol = con.execute("SELECT column_name FROM gpkg_geometry_columns WHERE table_name='buildings_3d'").fetchone()[0]
rows = con.execute(f'SELECT name, height_m, base_m, roof_m, {gcol} FROM buildings_3d').fetchall()
scene = load(live / 'scene-live.json'); mcp = {b['buildingId']: b for b in load(live / 'buildings.json')['buildings']}
by_name = {b['name']: b for b in scene['buildings']}

buildings, geoms = [], {}
for name, h, gb, gr, blob in rows:
    g = gpkg_geom(blob); sc = by_name.get(name)
    if not sc: buildings.append({'name': name, 'error': 'no scene building with this name'}); continue
    p = mcp[sc['buildingId']]; geoms[name] = g
    pts = outline_samples(g) + [(p['x'], p['y'])]
    b_now = block([bilinear(dem, x, y) for x, y in pts], h)
    b_wo = block([bilinear(dem, x, y) for x, y in pts[:-1]], h)
    buildings.append({'name': name, 'buildingId': sc['buildingId'], 'heightM': h, 'samples': len(pts), 'interiorPoint': [p['x'], p['y']],
                      'sceneBaseRoof': [sc['baseM'], sc['roofM']], 'reproducedBaseRoof': b_now[:2],
                      'diffM': [round(b_now[0] - sc['baseM'], 3), round(b_now[1] - sc['roofM'], 3)],
                      'matches': abs(b_now[0] - sc['baseM']) < 0.01 and abs(b_now[1] - sc['roofM']) < 0.01,
                      'withoutInteriorPointBaseRoof': b_wo[:2], 'roofRaisedRule': b_now[2]})

# ---------------------------------------------- edge classification: baseline vs photo observations CX-01..03
integ = load(audit / 'claude-c02-integrated-candidate.json'); F = Polygon(integ['field']['polygon5186']); FIELD_Z = integ['field']['zM']
runs = load(audit / 'claude-terrain-impact.json')['edgeRuns']
PHOTO = {  # photo observations (CT-M06), not coordinates; the run they would touch is chosen by nearest building + side
    'CX-01': ('은주관 남단–혜인관 사이 개방 27m', 'open -> wall 후보 (녹지 띠가 은주2관 옥상일 가능성, SM-01 추론)'),
    'CX-03': ('청운관 동쪽 끝 개방 38m', 'open -> 대부분 wall 후보, 청운관–대일관 모서리만 open (SM-10 추론)'),
    'CX-02': ('대일관 앞 개방 113m', '분류 유지(open). 150~151.5m 점은 화단 띠 위라 보행 평탄부 높이로 쓰지 않음 (SM-03 관측)'),
}
edge_compare = []
for r in runs:
    label = None
    if r['class'] == 'open':
        nb = r['nearestBuildings'][0][1]
        label = 'CX-01' if r['lengthM'] < 30 and nb == '은주관' else 'CX-03' if nb == '청운관' else 'CX-02' if nb == '대일관' else None
    after = r['class'] if label in (None, 'CX-02') else 'wall?'
    edge_compare.append({'from': r['from'], 'to': r['to'], 'lengthM': r['lengthM'], 'baseline': r['class'], 'withPhotos': after,
                         'photo': label and PHOTO[label][1], 'coordinateBasis': 'building-outline-derived edge of F; not surveyed'})
open_before = sum(e['lengthM'] for e in edge_compare if e['baseline'] == 'open')
open_after = sum(e['lengthM'] for e in edge_compare if e['withPhotos'] == 'open')

# ---------------------------------------------- wall-strip options (same check scope for all three)
all_foot = unary_union([g.buffer(0) for g in geoms.values()])
outlines_v = {o['name']: unary_union([Polygon(p[0], p[1:]).buffer(0) for p in o['coordinates']]) for o in load(audit / 'building-outlines-5186.json')}
foot_any = unary_union([all_foot] + list(outlines_v.values()))
strip_cells = []
for j in range(H):
    y = meta['originY'] + (j + 0.5) * res
    if not F.bounds[1] - 3 <= y <= F.bounds[3] + 3: continue
    for i in range(W):
        x = meta['originX'] + (i + 0.5) * res
        if not F.bounds[0] - 3 <= x <= F.bounds[2] + 3: continue
        pt = Point(x, y)
        if not F.contains(pt) and F.distance(pt) <= 1.6 and abs(float(cand[j, i]) - float(dem[j, i])) < 1e-6:
            strip_cells.append((i, j, foot_any.contains(pt)))
options = {}
for key, desc in (('A_keep', '벽 앞 띠 원 DEM 유지 (현재 후보)'), ('B_flatten_strip', '외곽선 밖 띠 셀만 평탄'), ('C_extend_to_wall', '띠 + 외곽선에 걸친 셀까지 평탄 (F를 벽까지 확장)')):
    g = cand.astype(float).copy()
    for i, j, inside in strip_cells:
        if key == 'B_flatten_strip' and not inside: g[j, i] = FIELD_Z
        if key == 'C_extend_to_wall': g[j, i] = FIELD_Z
    ch = np.abs(g - dem) > 1e-6
    gy, gx = np.gradient(g, res); sl = np.hypot(gx, gy) * 100
    ring = ch.copy()
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1): ring |= np.roll(np.roll(ch, dj, 0), di, 1)
    per_b = {}
    for b in buildings:
        if b.get('error'): continue
        pts = outline_samples(geoms[b['name']]) + [tuple(b['interiorPoint'])]
        nb = block([bilinear(g, x, y) for x, y in pts], b['heightM'])
        d = (round(nb[0] - b['reproducedBaseRoof'][0], 2), round(nb[1] - b['reproducedBaseRoof'][1], 2))
        if d != (0.0, 0.0): per_b[b['name']] = {'baseShiftM': d[0], 'roofShiftM': d[1], 'samplesMoved': sum(abs(bilinear(g, x, y) - bilinear(dem, x, y)) > 0.01 for x, y in pts)}
    options[key] = {'desc': desc, 'changedCells': int(ch.sum()), 'maxSlopePctNearChange': round(float(sl[ring].max()), 1),
                    'cellsOver100pct': int(((sl > 100) & ring).sum()), 'recomputedSceneShift': per_b}

report = {'gpkgSha256': sha, 'gpkgShaMatchesSources': sha == GPKG_SHA, 'mode': scene.get('heightMode'), 'terrainVersion': scene.get('terrainVersionId'),
          'interiorPointSource': 'MCP list_buildings ST_PointOnSurface(scene geometry), cm rounded', 'buildings': buildings,
          'edgeComparison': edge_compare, 'openEdgeLengthM': {'baseline': open_before, 'withPhotoObservations': open_after},
          'stripCells': {'total': len(strip_cells), 'touchingFootprint': sum(1 for *_, f in strip_cells if f)}, 'stripOptions': options,
          'note': 'roof shifts are the automatic scene-heights.ts recompute (median of terrain samples + height); they are NOT measured building heights'}
pathlib.Path(sys.argv[3]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
print('gpkg sha ok', report['gpkgShaMatchesSources'], 'mode', report['mode'], 'match', sum(b.get('matches', False) for b in buildings), '/', len(buildings),
      'open m', report['openEdgeLengthM'], 'strip', report['stripCells'])
