"""Read-only audit of the 2026-10-07 12:18Z walk (C01 run fbf7a703 + C02 run 8754e88c carried together) through
북악관 upper floors -> 문예관 -> outdoor descent -> 북악관.

Per phone: barometric bias from outdoor points (h - 1 m phone height - DEM), then height plateaus inside each building,
bias-corrected to floor Z. Compared with the live model corridor levels. Writes one JSON report; never touches the DB.

  python walk_1218_levels.py <audit-dir> <out.json>
"""
import json, sys, pathlib
import numpy as np
from shapely.geometry import Point, Polygon, MultiPolygon

audit = pathlib.Path(sys.argv[1]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
meta = load(audit / 'terrain-grid-meta.json')
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])
PHONE_HEIGHT_M = 1.0  # same constant as backend/scripts/buildings-calibrate.ts


def ground(x, y):
    gx = (x - meta['originX']) / meta['resolution'] - 0.5; gy = (y - meta['originY']) / meta['resolution'] - 0.5
    i, j = int(np.floor(gx)), int(np.floor(gy)); fx, fy = gx - i, gy - j
    v = dem[j:j + 2, i:i + 2].astype(float)
    return float(v[0, 0] * (1 - fx) * (1 - fy) + v[0, 1] * fx * (1 - fy) + v[1, 0] * (1 - fx) * fy + v[1, 1] * fx * fy)


outlines = {o['name']: MultiPolygon([Polygon(p[0], p[1:]) for p in o['coordinates']]) for o in load(audit / 'building-outlines-5186.json')}


def where(x, y):
    for n, pl in outlines.items():
        if pl.contains(Point(x, y)): return n
    return None


def clear_outdoor(x, y):  # >= 4 m from every footprint: avoids building-edge DEM and entrance steps
    return all(pl.distance(Point(x, y)) >= 4.0 for pl in outlines.values())


def track(key):
    pts = []
    for s in 'ab': pts += load(live / 'tracks' / f'{key}-{s}.json')['points']
    return sorted({p[0]: p for p in pts if p[3] is not None}.values())


def plateaus(values, min_n=6, bin_m=0.5, sep_m=2.0):
    """Histogram peaks of heights (same idea as buildings-calibrate.ts), refined to the median of points within 0.75 m."""
    v = np.asarray(values); counts = {}
    for b in np.floor(v / bin_m).astype(int): counts[b] = counts.get(b, 0) + 1
    peaks = sorted(((b, n) for b, n in counts.items() if n >= min_n and n >= counts.get(b - 1, 0) and n >= counts.get(b + 1, 0)), key=lambda t: -t[1])
    chosen = []
    for b, n in peaks:
        c = (b + 0.5) * bin_m
        if all(abs(c - x) >= sep_m for x in chosen): chosen.append(c)
    out = []
    for c in sorted(chosen):
        near = v[np.abs(v - c) <= 0.75]
        out.append({'h': round(float(np.median(near)), 2), 'n': int(len(near))})
    return out


WALK = {'C02': 'C02-8754e88c', 'C01': 'C01-fbf7a703'}
SEQ = (440, 900)  # upper-floor walk, crossing, descent, outdoor return (both phones share seq numbering only roughly)
report = {'walk': '2026-10-07T12:18Z, C01 + C02 carried together', 'phoneHeightM': PHONE_HEIGHT_M, 'phones': {}}
for phone, key in WALK.items():
    pts = [p for p in track(key) if SEQ[0] <= p[0] <= SEQ[1]]
    outdoor = [(p[0], p[3] - PHONE_HEIGHT_M - ground(p[1], p[2])) for p in pts if clear_outdoor(p[1], p[2])]
    res = np.array([r for _, r in outdoor])
    bias = float(np.median(res))
    by_b = {}
    for p in pts:
        b = where(p[1], p[2])
        if b: by_b.setdefault(b, []).append(p[3])
    cross = None
    for a, b in zip(pts, pts[1:]):
        if where(a[1], a[2]) == '북악관' and where(b[1], b[2]) in ('문예관', None) and b[0] - a[0] <= 3 and outlines['문예관'].distance(Point(b[1], b[2])) < 2:
            cross = {'seq': [a[0], b[0]], 'hRaw': [a[3], b[3]], 'xy': b[1:3]}
            break
    report['phones'][phone] = {
        'run': key, 'outdoorPoints': len(outdoor),
        'outdoorResidualM': {'median': round(bias, 2), 'p10': round(float(np.percentile(res, 10)), 2), 'p90': round(float(np.percentile(res, 90)), 2),
                             'seqRange': [outdoor[0][0], outdoor[-1][0]] if outdoor else None},
        'plateausRaw': {b: plateaus(v) for b, v in by_b.items()},
        'plateausFloorZ': {b: [{'z': round(x['h'] - PHONE_HEIGHT_M - bias, 2), 'n': x['n']} for x in plateaus(v)] for b, v in by_b.items()},
        'crossing': cross and {**cross, 'floorZ': round(cross['hRaw'][0] - PHONE_HEIGHT_M - bias, 2)},
    }

# model levels for comparison
roads = load(live / 'roads-live.json')['items']
lv = sorted({r['coordinates'][0][2] for r in roads if r['structure'] == 'indoor_corridor' and any(outlines['북악관'].contains(Point(c[0], c[1])) for c in r['coordinates'])})
report['modelBukakCorridorZ'] = lv
mz = sorted({c[2] for r in roads for c in r['coordinates'] if any(outlines['문예관'].contains(Point(q[0], q[1])) for q in r['coordinates'])})
report['modelMunyeZ'] = mz
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=1))
