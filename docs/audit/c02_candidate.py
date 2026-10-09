"""C02 field re-level CANDIDATE (not applied; no DB access). Read-only inputs from the vault snapshot.

Evidence used, nothing else:
  - S-MAP DEM at the 13 C02 vertices (Codex, smap-coordinate-checks.json) -> C02 vertex Z directly.
  - C02 walk 2026-10-07 08:46Z (run 9a6dc2bb), seq 384-832, loop closure -0.45 m at the Daeil front platform.
    Its absolute height is anchored to the 2015 DEM, so it is shifted by ONE offset fitted to S-MAP
    (c02_surface_fit.py: offset -4.91 m, RMS 0.57 m). Only the walk's shape is used.
  - Roads are re-levelled only where the walk covers them: outdoor structures (ordinary/sidewalk/crossing/stairs/ramp),
    <= 2 shared-node hops from C02 over such roads, less than half inside a building footprint, >= 80 % of the length
    within 3 m of the walk. Indoor corridors and elevators are never re-levelled here.
  - A road that is flat now (max grade < 1 %) stays flat (median of its walk heights): the walk does not resolve slopes
    that small, and it keeps landings and platforms level.
Every road that shares a moved node but is not re-levelled is reported as a boundary road with the grade it would get.

  python c02_candidate.py <audit-dir> <out.json> [max-hops=2]
"""
import json, sys, math, pathlib
import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

audit = pathlib.Path(sys.argv[1]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
C02 = '3910b4a5-0b5f-4226-bdf5-8f2c8eca99fb'
RUN, WINDOW, COVER_M, COVER_SHARE, VERTEX_R = 'C02-9a6dc2bb', (384, 832), 3.0, 0.8, 4.0
OUTDOOR = {'ordinary', 'sidewalk', 'crossing', 'stairs', 'ramp'}
fit = load(audit / 'claude-c02-surface-fit.json')['fit']['smap']
OFFSET = fit['offsetM']  # walk h - S-MAP ground (includes phone height and barometric datum)

roads = {r['id']: r for r in load(live / 'roads-live.json')['items']}
outlines = unary_union([Polygon(p[0], p[1:]).buffer(0) for o in load(audit / 'building-outlines-5186.json') for p in o['coordinates']])  # footprints overlap
MAX_HOPS = int(sys.argv[3]) if len(sys.argv) > 3 else 2
nodes = {n['id']: n for n in load(live / 'nodes-live.json')['items']}
smap = {p['vertexIndex']: p['smapDemM'] for p in load(audit / 'smap-coordinate-checks.json')['points'] if p.get('roadId') == C02}
pts = []
for s in 'ab': pts += load(live / 'tracks' / f'{RUN}-{s}.json')['points']
pts = sorted({p[0]: p for p in pts if p[3] is not None and WINDOW[0] <= p[0] <= WINDOW[1]}.values())
track = LineString([p[1:3] for p in pts])


def coverage(r):
    line = LineString([c[:2] for c in r['coordinates']])
    n = max(2, int(line.length / 0.5))
    return sum(track.distance(line.interpolate(i / (n - 1), normalized=True)) <= COVER_M for i in range(n)) / n


def walk_ground(x, y):
    near = [p[3] for p in pts if math.hypot(p[1] - x, p[2] - y) <= VERTEX_R]
    return None if not near else float(np.median(near)) - OFFSET


def interpolate_missing(cs, zs):
    """Fill vertices without walk points by length-interpolation between known ones (ends: nearest known)."""
    d = [0.0]
    for a, b in zip(cs, cs[1:]): d.append(d[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    known = [i for i, z in enumerate(zs) if z is not None]
    if not known: return None
    return [round(float(np.interp(d[i], [d[k] for k in known], [zs[k] for k in known])), 3) for i in range(len(cs))]


def grades(cs):
    out = []
    for a, b in zip(cs, cs[1:]):
        h = math.hypot(b[0] - a[0], b[1] - a[1])
        if h >= 0.05: out.append((b[2] - a[2]) / h * 100)
    return out


def inside_share(r):
    line = LineString([c[:2] for c in r['coordinates']])
    return line.intersection(outlines).length / line.length if line.length else 0.0


# outdoor roads within MAX_HOPS shared-node hops of C02
by_node = {}
for r in roads.values():
    for n in (r['fromNodeId'], r['toNodeId']): by_node.setdefault(n, set()).add(r['id'])
hops = {C02: 0}; frontier = {C02}
for h in range(1, MAX_HOPS + 1):
    nxt = set()
    for rid in frontier:
        for n in (roads[rid]['fromNodeId'], roads[rid]['toNodeId']):
            for o in by_node[n]:
                if o not in hops and roads[o]['structure'] in OUTDOOR and inside_share(roads[o]) < 0.5: hops[o] = h; nxt.add(o)
    frontier = nxt

# 1. re-levelled roads
moved = {}
for rid, r in roads.items():
    if rid not in hops: continue
    cs = r['coordinates']
    if rid == C02:
        zs = [smap.get(i) for i in range(len(cs))]; basis = 'S-MAP per vertex'
    else:
        if r['structure'] not in OUTDOOR or coverage(r) < COVER_SHARE: continue
        zs = [walk_ground(c[0], c[1]) for c in cs]; basis = f'walk {RUN} seq {WINDOW[0]}-{WINDOW[1]} shifted to S-MAP ({OFFSET:+.2f} m)'
    z = interpolate_missing(cs, zs)
    if z is None: continue
    if rid != C02 and max(map(abs, grades(cs)), default=0) < 1.0: z = [round(float(np.median(z)), 3)] * len(z)
    moved[rid] = {'basis': basis, 'coverage': round(coverage(r), 2) if rid != C02 else 1.0, 'new': [[c[0], c[1], zz] for c, zz in zip(cs, z)]}

# 2. node heights: every moved road end on a node must agree; take the median of the proposals and snap all ends to it
node_z = {}
for rid, m in moved.items():
    r = roads[rid]
    node_z.setdefault(r['fromNodeId'], []).append(m['new'][0][2]); node_z.setdefault(r['toNodeId'], []).append(m['new'][-1][2])
node_final = {n: round(float(np.median(v)), 3) for n, v in node_z.items()}
for rid, m in moved.items():
    r = roads[rid]; m['new'][0][2] = node_final[r['fromNodeId']]; m['new'][-1][2] = node_final[r['toNodeId']]
    m['nodeSpreadM'] = {e: round(max(node_z[n]) - min(node_z[n]), 2) for e, n in (('from', r['fromNodeId']), ('to', r['toNodeId']))}

# 3. boundary roads: share a moved node, not re-levelled -> only their shared end vertex would follow the node
boundary = []
for rid, r in roads.items():
    if rid in moved: continue
    ends = [(e, n) for e, n in (('from', r['fromNodeId']), ('to', r['toNodeId'])) if n in node_final]
    if not ends: continue
    cs = [list(c) for c in r['coordinates']]
    for e, n in ends: cs[0 if e == 'from' else -1][2] = node_final[n]
    g0, g1 = grades(r['coordinates']), grades(cs)
    boundary.append({'id': rid, 'name': r['name'], 'structure': r['structure'], 'levelId': r['levelId'], 'revision': r['revision'],
                     'movedEnds': {e: {'nodeId': n, 'oldZ': r['coordinates'][0 if e == 'from' else -1][2], 'newZ': node_final[n]} for e, n in ends},
                     'maxAbsGradeBefore': round(max(map(abs, g0)), 1) if g0 else None, 'maxAbsGradeAfter': round(max(map(abs, g1)), 1) if g1 else None})

report = {'candidate': 'c02-field-relevel-v1', 'status': 'CANDIDATE - not applied', 'offsetFromSurfaceFit': fit,
          'inputsLiveSnapshot': (live / 'snapshot-time.txt').read_text().split(), 'parameters': {'run': RUN, 'window': WINDOW, 'coverM': COVER_M,
          'coverShare': COVER_SHARE, 'vertexRadiusM': VERTEX_R, 'maxHops': MAX_HOPS}, 'releveled': [], 'nodes': [], 'boundary': sorted(boundary, key=lambda b: -(b['maxAbsGradeAfter'] or 0))}
for rid, m in moved.items():
    r = roads[rid]; old = r['coordinates']
    report['releveled'].append({'id': rid, 'hop': hops[rid], 'name': r['name'], 'structure': r['structure'], 'revision': r['revision'], 'basis': m['basis'], 'coverage': m['coverage'],
                                'nodeSpreadM': m['nodeSpreadM'], 'zOld': [old[0][2], old[-1][2], min(c[2] for c in old), max(c[2] for c in old)],
                                'zNew': [m['new'][0][2], m['new'][-1][2], min(c[2] for c in m['new']), max(c[2] for c in m['new'])],
                                'maxAbsGradeBefore': round(max(map(abs, grades(old))), 1), 'maxAbsGradeAfter': round(max(map(abs, grades(m['new']))), 1),
                                'coordinatesOld': old, 'coordinatesNew': m['new']})
for n, z in node_final.items():
    report['nodes'].append({'id': n, 'oldXYZ': nodes[n]['coordinate'] if n in nodes else None, 'newZ': z, 'proposals': node_z[n]})
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
for x in report['releveled']:
    print('R', x['id'][:8], x['structure'], x['coverage'], x['zOld'], '->', x['zNew'], 'grade', x['maxAbsGradeBefore'], '->', x['maxAbsGradeAfter'], x['nodeSpreadM'], x['name'])
for b in report['boundary']:
    print('B', b['id'][:8], b['structure'], {e: (v['oldZ'], v['newZ']) for e, v in b['movedEnds'].items()}, 'grade', b['maxAbsGradeBefore'], '->', b['maxAbsGradeAfter'], b['name'])
