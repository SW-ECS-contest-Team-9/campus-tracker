"""CT-M04 — impact review of the field terrain candidate (c02_integrated.py output). Read-only.

Per building: candidate-minus-original terrain under the footprint and on its outline samples, and the scene base/roof
that scene-heights.ts would recompute (base = min(outline samples) - 1, roof = max(median + height, max + 3)).
Steep cells: candidate slope above STEEP_PCT, grouped into clusters with their cause (which edge, what step).
Edges: field polygon boundary split into contiguous wall / open runs with the original-DEM step across each run.

  python terrain_candidate_impact.py <audit-dir> <out.json>
"""
import json, sys, math, pathlib
import numpy as np
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

audit = pathlib.Path(sys.argv[1]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
STEEP_PCT, WALL_M = 50.0, 1.6
meta = load(audit / 'terrain-grid-meta.json'); res = meta['resolution']; H, W = meta['height'], meta['width']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(H, W).astype(float)
cand = np.fromfile(audit / 'claude-field-terrain-candidate.f32', dtype='<f4').reshape(H, W).astype(float)
integ = load(audit / 'claude-c02-integrated-candidate.json')
F = Polygon(integ['field']['polygon5186']); FIELD_Z = integ['field']['zM']
foot = {o['name']: unary_union([Polygon(p[0], p[1:]).buffer(0) for p in o['coordinates']]) for o in load(audit / 'building-outlines-5186.json')}
scene = {b['buildingId']: b for b in load(live / 'scene-live.json')['buildings']}
by_name = {b['name']: b for b in scene.values()}
delta = cand - dem


def sample(grid, x, y):
    gx = (x - meta['originX']) / res - 0.5; gy = (y - meta['originY']) / res - 0.5
    i, j = int(np.floor(gx)), int(np.floor(gy)); fx, fy = gx - i, gy - j
    v = grid[j:j + 2, i:i + 2]
    return float(v[0, 0] * (1 - fx) * (1 - fy) + v[0, 1] * fx * (1 - fy) + v[1, 0] * (1 - fx) * fy + v[1, 1] * fx * fy)


def cell_xy(i, j): return meta['originX'] + (i + 0.5) * res, meta['originY'] + (j + 0.5) * res


def block(samples, h):  # scene-heights.ts blockHeights
    s = sorted(samples); n = len(s); med = s[n >> 1] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    roof = med + h; raised = roof < s[-1] + 3
    return round(s[0] - 1, 3), round(max(roof, s[-1] + 3), 3), raised


changed = np.abs(delta) > 1e-6
# ------------------------------------------------------------ buildings
buildings = []
for name, g in foot.items():
    polys = list(getattr(g, 'geoms', [g]))
    outline = []
    for q in polys:
        ring = list(q.exterior.coords)
        for (ax, ay), (bx, by) in zip(ring, ring[1:]):
            n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2))
            outline += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    d_out = [sample(cand, x, y) - sample(dem, x, y) for x, y in outline]
    minx, miny, maxx, maxy = g.bounds
    cells = [(i, j) for j in range(max(0, int((miny - meta['originY']) / res) - 1), min(H, int((maxy - meta['originY']) / res) + 2))
             for i in range(max(0, int((minx - meta['originX']) / res) - 1), min(W, int((maxx - meta['originX']) / res) + 2)) if g.contains(Point(*cell_xy(i, j)))]
    d_in = [delta[j, i] for i, j in cells]
    if max(map(abs, d_out + d_in), default=0) < 1e-6: continue
    sc = by_name.get(name) or scene.get(name)
    row = {'building': name, 'sceneId': sc and sc['buildingId'], 'footprintCells': len(cells), 'footprintCellsChanged': int(sum(abs(x) > 1e-6 for x in d_in)),
           'footprintDeltaM': [round(min(d_in), 2), round(float(np.median(d_in)), 2), round(max(d_in), 2)] if d_in else None,
           'outlineSamples': len(outline), 'outlineSamplesChanged': int(sum(abs(x) > 0.01 for x in d_out)),
           'outlineDeltaM': [round(min(d_out), 2), round(float(np.median(d_out)), 2), round(max(d_out), 2)]}
    if sc:
        b0 = block([sample(dem, x, y) for x, y in outline], sc['heightM']); b1 = block([sample(cand, x, y) for x, y in outline], sc['heightM'])
        g1 = [sample(cand, x, y) for x, y in outline]
        row.update({'sceneBaseM': sc['baseM'], 'sceneRoofM': sc['roofM'], 'recomputedNowBaseRoof': b0[:2], 'recomputedCandidateBaseRoof': b1[:2],
                    'baseShiftM': round(b1[0] - b0[0], 2), 'roofShiftM': round(b1[1] - b0[1], 2), 'roofRaisedRule': [b0[2], b1[2]],
                    'candidateGroundMinusSceneBaseM': [round(min(g1) - sc['baseM'], 2), round(max(g1) - sc['baseM'], 2)],
                    'recomputeMatchesSceneNow': abs(b0[0] - sc['baseM']) < 0.05 and abs(b0[1] - sc['roofM']) < 0.05})
    buildings.append(row)

# ------------------------------------------------------------ steep cells
gy, gx = np.gradient(cand, res); slope = np.hypot(gx, gy) * 100
gy0, gx0 = np.gradient(dem, res); slope0 = np.hypot(gx0, gy0) * 100
near_change = np.zeros_like(changed)
for dj in (-1, 0, 1):
    for di in (-1, 0, 1): near_change |= np.roll(np.roll(changed, dj, 0), di, 1)
steep = np.argwhere((slope > STEEP_PCT) & near_change & (slope > slope0 + 5))
all_foot = unary_union(list(foot.values()))
edge_runs = []
pts = [F.exterior.interpolate(d) for d in np.arange(0, F.exterior.length, 1.0)]
cls = ['wall' if p.distance(all_foot) <= WALL_M else 'open' for p in pts]
start = 0
for k in range(1, len(pts) + 1):
    if k == len(pts) or cls[k] != cls[start]:
        seg = pts[start:k]; mid = seg[len(seg) // 2]
        outside = [sample(dem, p.x + (p.x - F.centroid.x) / max(1, p.distance(F.centroid)) * 6, p.y + (p.y - F.centroid.y) / max(1, p.distance(F.centroid)) * 6) for p in seg]
        near_b = sorted((round(g.distance(mid), 1), n) for n, g in foot.items())[:2]
        edge_runs.append({'class': cls[start], 'lengthM': len(seg), 'from': [round(seg[0].x, 1), round(seg[0].y, 1)], 'to': [round(seg[-1].x, 1), round(seg[-1].y, 1)],
                          'nearestBuildings': near_b, 'dem2015InsideEdge': [round(min(sample(dem, p.x, p.y) for p in seg), 2), round(max(sample(dem, p.x, p.y) for p in seg), 2)],
                          'dem2015Outside6m': [round(min(outside), 2), round(max(outside), 2)], 'stepFieldToOutsideM': [round(FIELD_Z - max(outside), 2), round(FIELD_Z - min(outside), 2)]})
        start = k
runs = [r for r in edge_runs if r['lengthM'] >= 2]
clusters = []
seen = set()
for i0, j0 in map(tuple, steep[:, ::-1]):
    if (i0, j0) in seen: continue
    stack, members = [(i0, j0)], []
    while stack:
        i, j = stack.pop()
        if (i, j) in seen or not (0 <= i < W and 0 <= j < H) or not (slope[j, i] > STEEP_PCT and near_change[j, i] and slope[j, i] > slope0[j, i] + 5): continue
        seen.add((i, j)); members.append((i, j)); stack += [(i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)]
    xs = [cell_xy(i, j) for i, j in members]; cx = float(np.mean([x for x, _ in xs])); cy = float(np.mean([y for _, y in xs]))
    pc = Point(cx, cy)
    in_field = sum(F.contains(Point(*p)) for p in xs)
    run = min(runs, key=lambda r: min(math.hypot(r['from'][0] - cx, r['from'][1] - cy), math.hypot(r['to'][0] - cx, r['to'][1] - cy)))
    where = 'F 경계 안쪽 셀(벽 쪽 평탄면과 원 DEM 셀의 경사 계산)' if in_field else ('건물 외곽선 안' if all_foot.contains(pc) else '개방 경계 전이대')
    clusters.append({'cells': len(members), 'centroid': [round(cx, 1), round(cy, 1)], 'maxSlopePct': round(max(slope[j, i] for i, j in members), 1),
                     'maxSlopeBeforePct': round(max(slope0[j, i] for i, j in members), 1), 'maxAbsDeltaM': round(max(abs(delta[j, i]) for i, j in members), 2),
                     'nearestBuildings': sorted((round(g.distance(pc), 1), n) for n, g in foot.items())[:2], 'nearestEdgeRun': run['class'], 'location': where})
clusters.sort(key=lambda c: -c['maxSlopePct'])
max_cell = np.unravel_index(np.argmax(np.where(changed, slope, 0)), slope.shape)
report = {'candidateSha': integ['terrain']['sha256'], 'fieldZ': FIELD_Z, 'steepThresholdPct': STEEP_PCT,
          'buildings': buildings, 'edgeRuns': runs, 'steepClusters': clusters,
          'maxSlopeCell': {'xy': [round(v, 1) for v in cell_xy(max_cell[1], max_cell[0])], 'slopePct': round(float(slope[max_cell]), 1),
                           'origDem': round(float(dem[max_cell]), 2), 'candidate': round(float(cand[max_cell]), 2)}}
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
print('buildings', len(buildings), 'edgeRuns', len(runs), 'steepClusters', len(clusters), 'max', report['maxSlopeCell'])
