"""CT-M02 — field (운동장) surface + C02 boundary INTEGRATED CANDIDATE. Read-only; nothing is applied.

Field polygon F: the open courtyard enclosed by 은주관, 대일관, 청운관, 혜인관, 공연실습소 (convex hull of the five
footprints minus every footprint buffered 1 m), the component that contains C02. 한림관 is left out on purpose: with it the
hull reaches the 125.8 m S-MAP point west of 은주관 (the excluded broad plateau). Edges of F are classified as
  wall  — within WALL_M of a footprint (the building face is the edge; no terrain transition),
  open  — passages between buildings (NW toward 본관/문예관, NE toward 상승관, S toward 은주2관/코트): exact edge unknown.
Terrain: cells inside F -> FIELD_Z (mean S-MAP at the 13 C02 vertices). Cells outside F within BAND_M of an OPEN edge
-> linear blend to the original 2015 DEM (two breaklines: F edge and band edge = a minimal TIN). Everything else unchanged.
Roads: c02_candidate.py v1 values, then
  - outdoor ground roads (ordinary/sidewalk/crossing) inside F -> FIELD_Z (C02 keeps its per-vertex S-MAP values),
  - nodes with an S-MAP sample at the node XY (Codex 19-point check) -> that value,
  - stairs/ramps between moved nodes -> linear by length between their end nodes.
Roads sharing a moved node that are not set are reported with their grade before/after and a decision class.

  python c02_integrated.py <audit-dir> <out.json> <out-terrain.f32> [out.png]
"""
import json, sys, math, hashlib, pathlib
import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

audit = pathlib.Path(sys.argv[1]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
WALL_M, BAND_M, DAEIL_STRIP_M = 1.6, 4.0, 6.0
OUTDOOR_GROUND = {'ordinary', 'sidewalk', 'crossing'}
C02 = '3910b4a5-0b5f-4226-bdf5-8f2c8eca99fb'

meta = load(audit / 'terrain-grid-meta.json'); res = meta['resolution']
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])
checks = load(audit / 'smap-coordinate-checks.json')['points']
FIELD_Z = round(float(np.mean([p['smapDemM'] for p in checks if p['id'].startswith('c02_vertex')])), 3)


def sample(grid, x, y):
    gx = (x - meta['originX']) / res - 0.5; gy = (y - meta['originY']) / res - 0.5
    i, j = int(np.floor(gx)), int(np.floor(gy)); fx, fy = gx - i, gy - j
    v = grid[j:j + 2, i:i + 2].astype(float)
    return float(v[0, 0] * (1 - fx) * (1 - fy) + v[0, 1] * fx * (1 - fy) + v[1, 0] * (1 - fx) * fy + v[1, 1] * fx * fy)


# ---------------------------------------------------------------- field polygon and edges
foot = {o['name']: unary_union([Polygon(p[0], p[1:]).buffer(0) for p in o['coordinates']]) for o in load(audit / 'building-outlines-5186.json')}
RING = ['은주관', '대일관', '청운관', '혜인관', '공연실습소']
all_foot = unary_union(list(foot.values()))
court = unary_union([foot[n] for n in RING]).convex_hull.difference(all_foot.buffer(1.0))
c02_probe = Point(next((p['x'], p['y']) for p in checks if p['id'] == 'c02_vertex_03'))
F = next(g for g in getattr(court, 'geoms', [court]) if g.contains(c02_probe))
F = F.difference(foot['대일관'].buffer(DAEIL_STRIP_M + 2))  # 대일관 전면 계단·돌출부 구역은 보행으로 구분 불가 -> 제외
F = max(getattr(F, 'geoms', [F]), key=lambda g: g.area)
excluded_point = Point(201105.0, 557261.0)  # S-MAP 125.825 m — must stay outside


def edge_class(pt):
    if pt.distance(all_foot) <= WALL_M: return 'daeil_strip' if pt.distance(foot['대일관']) <= WALL_M else 'wall'
    return 'open'


edge_pts = [F.exterior.interpolate(d) for d in np.arange(0, F.exterior.length, 1.0)]
edge_cls = [edge_class(p) for p in edge_pts]
open_edge = unary_union([p.buffer(0.6) for p, c in zip(edge_pts, edge_cls) if c == 'open'])

# ---------------------------------------------------------------- terrain candidate
cand = dem.copy()
H, W = dem.shape
changed = np.zeros_like(dem, dtype=bool); band_cells = 0
for j in range(H):
    y = meta['originY'] + (j + 0.5) * res
    if not (F.bounds[1] - BAND_M - res <= y <= F.bounds[3] + BAND_M + res): continue
    for i in range(W):
        x = meta['originX'] + (i + 0.5) * res
        if not (F.bounds[0] - BAND_M - res <= x <= F.bounds[2] + BAND_M + res): continue
        pt = Point(x, y)
        if F.contains(pt):
            cand[j, i] = FIELD_Z; changed[j, i] = True
        elif not all_foot.contains(pt):
            d = F.exterior.distance(pt)
            if d < BAND_M and open_edge.distance(pt) <= d + 0.6:  # nearest F edge is an open edge
                cand[j, i] = FIELD_Z + (dem[j, i] - FIELD_Z) * (d / BAND_M); changed[j, i] = True; band_cells += 1
delta = cand - dem


def slope_pct(grid, mask):
    gy, gx = np.gradient(grid.astype(float), res)
    s = np.hypot(gx, gy) * 100
    return float(np.max(s[mask])) if mask.any() else 0.0


# building outline samples (scene-heights.ts recomputes base/roof from these) touched by the change
outline_hits = {}
for n, g in foot.items():
    ring = g.exterior if g.geom_type == 'Polygon' else max(g.geoms, key=lambda q: q.area).exterior
    pts = [ring.interpolate(d) for d in np.arange(0, ring.length, 2.0)]
    moved = [abs(sample(cand, p.x, p.y) - sample(dem, p.x, p.y)) for p in pts]
    if max(moved) > 0.01: outline_hits[n] = {'samples': len(pts), 'moved': int(sum(m > 0.01 for m in moved)), 'maxMoveM': round(max(moved), 2)}

# ---------------------------------------------------------------- roads
roads = {r['id']: r for r in load(live / 'roads-live.json')['items']}
v1 = {r['id']: r for r in load(audit / 'claude-c02-candidate-v1.json')['releveled']}
by_node = {}
for r in roads.values():
    for n in (r['fromNodeId'], r['toNodeId']): by_node.setdefault(n, set()).add(r['id'])
smap_at_node = {}
for nid in by_node:
    r = roads[next(iter(by_node[nid]))]
    c = r['coordinates'][0] if r['fromNodeId'] == nid else r['coordinates'][-1]
    hit = [p for p in checks if math.hypot(p['x'] - c[0], p['y'] - c[1]) <= 0.05 and p['smapBuildingHeightM'] is None]
    if hit: smap_at_node[nid] = (round(hit[0]['smapDemM'], 3), hit[0]['id'])

DECISION = {  # decision class for roads that touch a moved node but are not set (evidence in the report notes)
    '89ce1806-d956-4d8e-93b0-9a52f517187d': 'UNRESOLVED 혜인관 B1: B1 바닥=운동장(묶음 −1.33m) 또는 입구 단차 — 현장 6',
    'fa7d28d0-2aee-4d69-b872-eed9c1221284': 'UNRESOLVED 혜인관 B1: 위와 같은 묶음',
    '19800cee-5ba4-4471-bbc9-4f903d383a0c': 'UNRESOLVED 대일관 전면: 돌출 평탄부·실내 1층 묶음 — 현장 5',
    'b14ac1da-f26e-4fa7-a953-ed55397bbfa9': 'UNRESOLVED 대일관 전면→문예관 입구 계단 묶음 — 보행으로 계단 구분 불가, 현장 5',
    'a789c985-e419-4509-a709-76422a37ad0e': 'UNRESOLVED 지하주차장 통로: 지상/지하 여부 미확인',
}
new = {rid: [list(c) for c in m['coordinatesNew']] for rid, m in v1.items()}
basis = {rid: m['basis'] for rid, m in v1.items()}
for rid, r in roads.items():  # outdoor ground roads inside the field
    if r['structure'] in OUTDOOR_GROUND and rid != C02 and rid not in DECISION and '주차장' not in (r['name'] or '') and all(F.buffer(0.5).contains(Point(c[0], c[1])) for c in r['coordinates']):
        new[rid] = [[c[0], c[1], FIELD_Z] for c in r['coordinates']]; basis[rid] = 'field surface (inside F)'
node_z = {}
for rid, cs in new.items():
    r = roads[rid]
    node_z.setdefault(r['fromNodeId'], []).append(cs[0][2]); node_z.setdefault(r['toNodeId'], []).append(cs[-1][2])
node_final = {n: round(float(np.median(v)), 3) for n, v in node_z.items()}
node_basis = {n: 'median of re-levelled road ends' for n in node_final}
for n, (z, pid) in smap_at_node.items():  # an S-MAP sample exactly at the node wins
    if n in node_final or any(rid in new for rid in by_node[n]) or any(o in node_final for rid in by_node[n] for o in (roads[rid]['fromNodeId'], roads[rid]['toNodeId'])):
        node_final[n] = z; node_basis[n] = f'S-MAP {pid}'


def length_interp(cs, z0, z1):
    d = [0.0]
    for a, b in zip(cs, cs[1:]): d.append(d[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return [[c[0], c[1], round(z0 + (z1 - z0) * (t / d[-1] if d[-1] else 0), 3)] for c, t in zip(cs, d)]


# outdoor stairs/ramps/ground roads whose BOTH end nodes are now fixed -> linear between them
for rid, r in roads.items():
    if rid in new or r['structure'] not in OUTDOOR_GROUND | {'stairs', 'ramp'}: continue
    if r['fromNodeId'] in node_final and r['toNodeId'] in node_final and any(n in smap_at_node for n in (r['fromNodeId'], r['toNodeId'])):
        new[rid] = length_interp(r['coordinates'], node_final[r['fromNodeId']], node_final[r['toNodeId']]); basis[rid] = 'linear between fixed end nodes (S-MAP at node)'
# second pass: roads ending on S-MAP nodes now reachable
changed_any = True
while changed_any:
    changed_any = False
    for rid, cs in new.items():
        r = roads[rid]
        for n in (r['fromNodeId'], r['toNodeId']):
            if n not in node_final: node_final[n] = cs[0][2] if r['fromNodeId'] == n else cs[-1][2]; node_basis[n] = 'road end'; changed_any = True
    for rid, r in roads.items():
        if rid in new or r['structure'] not in OUTDOOR_GROUND | {'stairs', 'ramp'}: continue
        if r['fromNodeId'] in node_final and r['toNodeId'] in node_final and any(n in smap_at_node for n in (r['fromNodeId'], r['toNodeId'])):
            new[rid] = length_interp(r['coordinates'], node_final[r['fromNodeId']], node_final[r['toNodeId']]); basis[rid] = 'linear between fixed end nodes (S-MAP at node)'; changed_any = True
for rid, cs in new.items():
    r = roads[rid]; cs[0][2] = node_final[r['fromNodeId']]; cs[-1][2] = node_final[r['toNodeId']]


def grades(cs):
    return [(b[2] - a[2]) / math.hypot(b[0] - a[0], b[1] - a[1]) * 100 for a, b in zip(cs, cs[1:]) if math.hypot(b[0] - a[0], b[1] - a[1]) >= 0.05]


def gmax(cs):
    g = grades(cs); return round(max(map(abs, g)), 1) if g else None


boundary = []
for rid, r in roads.items():
    if rid in new: continue
    ends = [(e, n) for e, n in (('from', r['fromNodeId']), ('to', r['toNodeId'])) if n in node_final]
    if not ends: continue
    cs = [list(c) for c in r['coordinates']]
    for e, n in ends: cs[0 if e == 'from' else -1][2] = node_final[n]
    moved = {e: (r['coordinates'][0 if e == 'from' else -1][2], node_final[n]) for e, n in ends}
    if all(abs(a - b) < 0.005 for a, b in moved.values()): continue
    dec = DECISION.get(rid) or ('RESOLVED small end change' if all(abs(a - b) <= 1.0 for a, b in moved.values()) and (gmax(cs) or 0) <= 25 else 'UNRESOLVED')
    boundary.append({'id': rid, 'name': r['name'], 'structure': r['structure'], 'revision': r['revision'], 'movedEnds': moved,
                     'maxAbsGradeBefore': gmax(r['coordinates']), 'maxAbsGradeAfter': gmax(cs), 'decision': dec})

# ---------------------------------------------------------------- road vs terrain (outdoor ground roads near the field)
near = F.buffer(BAND_M + 10)
road_terrain = []
for rid, r in roads.items():
    if r['structure'] not in OUTDOOR_GROUND | {'stairs', 'ramp'}: continue
    cs_old = r['coordinates']; cs_new = new.get(rid, cs_old)
    if not any(near.contains(Point(c[0], c[1])) for c in cs_old): continue
    pts = [(o, n) for o, n in zip(cs_old, cs_new) if near.contains(Point(o[0], o[1])) and not all_foot.contains(Point(o[0], o[1]))]
    if not pts: continue
    before = [o[2] - sample(dem, o[0], o[1]) for o, _ in pts]; after = [n[2] - sample(cand, n[0], n[1]) for _, n in pts]
    road_terrain.append({'id': rid, 'name': r['name'], 'structure': r['structure'], 'set': rid in new,
                         'roadMinusTerrainBefore': [round(min(before), 2), round(max(before), 2)], 'roadMinusTerrainAfter': [round(min(after), 2), round(max(after), 2)]})

# ---------------------------------------------------------------- photo/observation evidence per node of the 7 v1 boundary roads
V1_BOUNDARY = ['b14ac1da-f26e-4fa7-a953-ed55397bbfa9', '89ce1806-d956-4d8e-93b0-9a52f517187d', '19800cee-5ba4-4471-bbc9-4f903d383a0c',
               'fa7d28d0-2aee-4d69-b872-eed9c1221284', '02d30f2b-98f7-4832-94d6-57dbdd781498', '45682ee7-491c-46b6-a339-2583adc191f2',
               'a789c985-e419-4509-a709-76422a37ad0e']
STRUCTURE_CLASS = {'b14ac1da-f26e-4fa7-a953-ed55397bbfa9': '계단 (실외)', '89ce1806-d956-4d8e-93b0-9a52f517187d': '실내 (혜인관 B1)',
                   '19800cee-5ba4-4471-bbc9-4f903d383a0c': '실외 지면 (대일관 돌출 평탄부, 외곽선 안)', 'fa7d28d0-2aee-4d69-b872-eed9c1221284': '실내 (혜인관 B1)',
                   '02d30f2b-98f7-4832-94d6-57dbdd781498': '실외 지면 (청운관 앞 운동장)', '45682ee7-491c-46b6-a339-2583adc191f2': '실외 지면 (운동장 북서 통로)',
                   'a789c985-e419-4509-a709-76422a37ad0e': '주차장 (지상/지하 미확인)'}
walk = []
for s in 'ab': walk += load(live / 'tracks' / f'C02-9a6dc2bb-{s}.json')['points']
walk = [p for p in walk if p[3] is not None and 384 <= p[0] <= 832]
OFFSET = load(audit / 'claude-c02-surface-fit.json')['fit']['smap']['offsetM']
node_table = []
for rid in V1_BOUNDARY:
    r = roads[rid]
    for e, n, c in (('from', r['fromNodeId'], r['coordinates'][0]), ('to', r['toNodeId'], r['coordinates'][-1])):
        w = [p[3] for p in walk if math.hypot(p[1] - c[0], p[2] - c[1]) <= 4.0]
        node_table.append({'road': rid, 'end': e, 'nodeId': n, 'xy': [round(c[0], 2), round(c[1], 2)], 'zNow': c[2],
                           'inField': F.contains(Point(c[0], c[1])), 'smap': smap_at_node.get(n, [None])[0],
                           'walkSmapFrame': round(float(np.median(w)) - OFFSET, 2) if w else None, 'walkPoints': len(w),
                           'dem2015': round(sample(dem, c[0], c[1]), 2), 'terrainCandidate': round(sample(cand, c[0], c[1]), 2),
                           'zCandidate': node_final.get(n), 'structureClass': STRUCTURE_CLASS[rid]})

# ---------------------------------------------------------------- checks
xy_same = all(abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9 for rid, cs in new.items() for a, b in zip(roads[rid]['coordinates'], cs))
node_gap = max(abs(cs[0][2] - node_final[roads[rid]['fromNodeId']]) + abs(cs[-1][2] - node_final[roads[rid]['toNodeId']]) for rid, cs in new.items())
stairs_dir = {rid: (roads[rid]['coordinates'][0][2] - roads[rid]['coordinates'][-1][2], cs[0][2] - cs[-1][2]) for rid, cs in new.items() if roads[rid]['structure'] == 'stairs'}
outside = ~changed
unresolved = [b for b in boundary if b['decision'].startswith('UNRESOLVED')]
edge_summary = {c: round(sum(1 for x in edge_cls if x == c) * 1.0, 0) for c in ('wall', 'daeil_strip', 'open')}

out_terrain = pathlib.Path(sys.argv[3]); cand.astype('<f4').tofile(out_terrain)
report = {
    'candidate': 'c02-integrated-v1', 'status': 'CANDIDATE - not applied; NOT applicable to operations while unresolved roads remain',
    'inputs': {'liveSnapshot': (live / 'snapshot-time.txt').read_text().split(), 'demSha256': hashlib.sha256((audit / 'terrain-grid.f32').read_bytes()).hexdigest(),
               'v1': 'claude-c02-candidate-v1.json'},
    'field': {'zM': FIELD_Z, 'zBasis': 'mean S-MAP DEM at the 13 C02 vertices (range 148.88-148.98); photos SM-01/03/04/10 show 148.9-149.0 inside, 148.3 at the 은주2관 edge',
              'polygon5186': [[round(x, 2), round(y, 2)] for x, y in F.exterior.coords], 'areaM2': round(F.area, 1),
              'excludesPoint201105_557261': not F.contains(excluded_point), 'edgeLengthM': edge_summary,
              'unresolvedEdges': ['open edges (NW toward 본관/문예관, NE toward 상승관, S toward 은주2관 slope): exact edge line not surveyed; 4 m linear band only',
                                  'daeil_strip: S-MAP 150.0-151.5 m band along 대일관 without coordinates; field level kept up to the wall']},
    'terrain': {'file': out_terrain.name, 'sha256': hashlib.sha256(out_terrain.read_bytes()).hexdigest(), 'changedCells': int(changed.sum()), 'bandCells': band_cells,
                'changedAreaM2': int(changed.sum()) * res * res, 'deltaM': [round(float(delta[changed].min()), 2), round(float(delta[changed].max()), 2)],
                'outsideUnchanged': bool(np.array_equal(cand[outside], dem[outside])), 'maxSlopePctInBandAfter': round(slope_pct(cand, changed & ~np.isclose(cand, FIELD_Z)), 1),
                'buildingOutlineSamplesMoved': outline_hits},
    'roads': [{'id': rid, 'name': roads[rid]['name'], 'structure': roads[rid]['structure'], 'revision': roads[rid]['revision'], 'basis': basis[rid],
               'zOld': [roads[rid]['coordinates'][0][2], roads[rid]['coordinates'][-1][2]], 'zNew': [cs[0][2], cs[-1][2]],
               'maxAbsGradeBefore': gmax(roads[rid]['coordinates']), 'maxAbsGradeAfter': gmax(cs), 'coordinatesNew': cs} for rid, cs in new.items()],
    'nodes': [{'id': n, 'z': z, 'basis': node_basis[n]} for n, z in node_final.items()],
    'boundary': sorted(boundary, key=lambda b: (not b['decision'].startswith('UNRESOLVED'), -(b['maxAbsGradeAfter'] or 0))),
    'v1BoundaryNodeEvidence': node_table, 'roadMinusTerrain': road_terrain,
    'checks': {'xyUnchanged': xy_same, 'maxNodeGapM': node_gap, 'stairsKeepDirection': all(a * b > 0 for a, b in stairs_dir.values()),
               'stairs': {k: [round(a, 2), round(b, 2)] for k, (a, b) in stairs_dir.items()}, 'unresolvedRoads': len(unresolved),
               'fieldBoundaryVerified': False,
               'operationallyApplicable': False,
               'applicationBlockers': ['field boundary and open-edge transition are not surveyed',
                                       'building foundation/roof effects need review']
                                      + ([f'{len(unresolved)} unresolved boundary roads'] if unresolved else [])},
}
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')

if len(sys.argv) > 4:
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    plt.rcParams['font.family'] = ['Malgun Gothic', 'DejaVu Sans']
    fig, axs = plt.subplots(1, 2, figsize=(16, 8))
    ext = [meta['originX'], meta['originX'] + W * res, meta['originY'], meta['originY'] + H * res]
    for ax, grid, title in ((axs[0], dem, '현재 지형 (2015 DEM)'), (axs[1], cand, '후보 지형 + 도로 후보')):
        im = ax.imshow(grid, origin='lower', extent=ext, cmap='terrain', vmin=126, vmax=154)
        ax.plot(*F.exterior.xy, 'k-', lw=1.5)
        for p, c in zip(edge_pts, edge_cls): ax.plot(p.x, p.y, '.', ms=3, color={'wall': 'k', 'open': 'm', 'daeil_strip': 'orange'}[c])
        for g in foot.values():
            for q in getattr(g, 'geoms', [g]): ax.plot(*q.exterior.xy, 'r-', lw=.8)
        for rid, r in roads.items():
            cs = np.array(new[rid] if (rid in new and grid is cand) else r['coordinates'])
            ax.plot(cs[:, 0], cs[:, 1], '-', lw=2.2 if rid in new else .7, color='b' if rid in new else 'gray')
        for b in boundary:
            cs = np.array(roads[b['id']]['coordinates']); ax.plot(cs[:, 0], cs[:, 1], '-', lw=2, color='crimson' if b['decision'].startswith('UNRESOLVED') else 'green')
        ax.plot(excluded_point.x, excluded_point.y, 'x', color='k', ms=8)
        ax.set_xlim(201090, 201270); ax.set_ylim(557180, 557350); ax.set_aspect('equal'); ax.set_title(title)
    fig.colorbar(im, ax=axs, shrink=.7, label='m (KVD)')
    axs[1].text(201092, 557183, '검정 점: 벽 경계 · 자홍: 열린 경계(4m 전이) · 주황: 대일관 전면 띠(미해결)\n파랑: 후보 도로 · 빨강: 미해결 경계 도로 · ×: 125.8m 제외점', fontsize=8)
    plt.savefig(sys.argv[4], dpi=90, bbox_inches='tight')

print('roads', len(report['roads']), 'unresolved', report['checks']['unresolvedRoads'], 'checks', {k: v for k, v in report['checks'].items() if k != 'stairs'}, 'terrainCells', report['terrain']['changedCells'])
