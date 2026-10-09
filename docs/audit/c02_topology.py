"""Read-only audit: C02 road (3910b4a5) and its 1/2/3-hop neighbourhood on the live network (shared node ids),
compared with S-MAP DEM samples, the archived 2015 DEM and recorded fusion-v4 tracks along it.

  python c02_topology.py <audit-dir> <out.json>
"""
import json, sys, math, pathlib
import numpy as np
from shapely.geometry import LineString, Point

audit = pathlib.Path(sys.argv[1]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
meta = load(audit / 'terrain-grid-meta.json')
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])
C02 = '3910b4a5-0b5f-4226-bdf5-8f2c8eca99fb'


def ground(x, y):
    gx = (x - meta['originX']) / meta['resolution'] - 0.5; gy = (y - meta['originY']) / meta['resolution'] - 0.5
    i, j = int(np.floor(gx)), int(np.floor(gy)); fx, fy = gx - i, gy - j
    v = dem[j:j + 2, i:i + 2].astype(float)
    return float(v[0, 0] * (1 - fx) * (1 - fy) + v[0, 1] * fx * (1 - fy) + v[1, 0] * (1 - fx) * fy + v[1, 1] * fx * fy)


roads = {r['id']: r for r in load(live / 'roads-live.json')['items']}
nodes = {n['id']: n for n in load(live / 'nodes-live.json')['items']}
by_node = {}
for r in roads.values():
    for n in (r['fromNodeId'], r['toNodeId']): by_node.setdefault(n, set()).add(r['id'])


def grades(cs):
    out = []
    for a, b in zip(cs, cs[1:]):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        out.append(None if d < 0.05 else (b[2] - a[2]) / d * 100)
    return out


def summary(r, hop):
    cs = r['coordinates']; g = [x for x in grades(cs) if x is not None]
    return {'hop': hop, 'id': r['id'], 'name': r['name'], 'structure': r['structure'], 'levelId': r['levelId'], 'revision': r['revision'],
            'fromNodeId': r['fromNodeId'], 'toNodeId': r['toNodeId'], 'start': cs[0], 'end': cs[-1], 'vertexCount': len(cs),
            'lengthM': round(LineString([c[:2] for c in cs]).length, 2), 'maxAbsGradePercent': round(max(map(abs, g)), 1) if g else None,
            'demStart': round(ground(*cs[0][:2]), 2), 'demEnd': round(ground(*cs[-1][:2]), 2)}


# breadth-first over shared nodes
hop_of = {C02: 0}; frontier = {C02}
for hop in (1, 2, 3):
    nxt = set()
    for rid in frontier:
        r = roads[rid]
        for n in (r['fromNodeId'], r['toNodeId']):
            for other in by_node.get(n, ()):
                if other not in hop_of: hop_of[other] = hop; nxt.add(other)
    frontier = nxt
report = {'targetId': C02, 'neighbourhood': sorted((summary(roads[i], h) for i, h in hop_of.items()), key=lambda s: (s['hop'], s['name'] or ''))}
report['nodesTouched'] = {n: {'kind': nodes[n]['kind'], 'levelId': nodes[n]['levelId'], 'coordinate': nodes[n]['coordinate'], 'degree': len(by_node[n])}
                          for s in report['neighbourhood'] for n in (s['fromNodeId'], s['toNodeId']) if n in nodes}

# S-MAP check points (Codex, smap-coordinate-checks.json) for C02 vertices
sm = load(audit / 'smap-coordinate-checks.json')
report['smapSource'] = 'smap-coordinate-checks.json (Codex 2026-10-09)'

# tracks along C02: points within 3 m of the C02 line, with their DEM and nearest C02 vertex index
line = LineString([c[:2] for c in roads[C02]['coordinates']])
along = {}
for f in sorted((live / 'tracks').glob('*.json')):
    d = load(f); key = f.stem[:-2]
    for p in d.get('points', []):
        if p[3] is None: continue
        pt = Point(p[1], p[2])
        if line.distance(pt) <= 3.0:
            along.setdefault(key, {})[p[0]] = [p[0], round(line.project(pt), 1), p[3], round(ground(p[1], p[2]), 2)]
report['tracksAlongC02'] = {k: sorted(v.values()) for k, v in along.items()}
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
for s in report['neighbourhood']:
    print(s['hop'], s['id'][:8], s['structure'], s['levelId'], s['start'][2], s['end'][2], s['maxAbsGradePercent'], s['demStart'], s['demEnd'], s['name'])
for k, v in report['tracksAlongC02'].items():
    print(k, len(v), 'along[m]', v[0][1], '->', v[-1][1], 'h', min(x[2] for x in v), max(x[2] for x in v))
