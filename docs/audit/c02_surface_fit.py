"""Which height surface explains the C02 walk's barometric profile? (read-only)

Walk: C02 session 2026-10-07 08:46Z, run 9a6dc2bb (fusion-v4 FINAL, h = phone height). Window seq 384-832: it passes the
Daeil front platform at seq ~502 and ~774 (loop closure). For every S-MAP check point (Codex, 19 points) with walk points
within 3 m, compare the walk's median h with: S-MAP DEM, the 2015 DEM (operating terrain) and the current road Z.
One constant offset per surface is fitted (median); residuals show which surface has the walk's shape.

  python c02_surface_fit.py <audit-dir> <out.json>
"""
import json, sys, pathlib
import numpy as np
from shapely.geometry import LineString, Point

audit = pathlib.Path(sys.argv[1]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
meta = load(audit / 'terrain-grid-meta.json')
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])
RUN, WINDOW, RADIUS = 'C02-9a6dc2bb', (384, 832), 3.0


def ground(x, y):
    gx = (x - meta['originX']) / meta['resolution'] - 0.5; gy = (y - meta['originY']) / meta['resolution'] - 0.5
    i, j = int(np.floor(gx)), int(np.floor(gy)); fx, fy = gx - i, gy - j
    v = dem[j:j + 2, i:i + 2].astype(float)
    return float(v[0, 0] * (1 - fx) * (1 - fy) + v[0, 1] * fx * (1 - fy) + v[1, 0] * (1 - fx) * fy + v[1, 1] * fx * fy)


pts = []
for s in 'ab': pts += load(live / 'tracks' / f'{RUN}-{s}.json')['points']
pts = sorted({p[0]: p for p in pts if p[3] is not None and WINDOW[0] <= p[0] <= WINDOW[1]}.values())
roads = load(live / 'roads-live.json')['items']


def model_z(x, y):
    """Z of the nearest outdoor (non-indoor) road at its closest vertex, within 3 m."""
    best = None
    for r in roads:
        if r['structure'] in ('indoor_corridor', 'elevator'): continue
        for c in r['coordinates']:
            d = ((c[0] - x) ** 2 + (c[1] - y) ** 2) ** 0.5
            if d <= 3 and (best is None or d < best[0]): best = (d, c[2])
    return None if best is None else best[1]


checks = load(audit / 'smap-coordinate-checks.json')
rows = []
for it in checks['points']:
    x, y, sm = it['x'], it['y'], it['smapDemM']
    near = [p for p in pts if ((p[1] - x) ** 2 + (p[2] - y) ** 2) ** 0.5 <= RADIUS]
    if not near or sm is None: continue
    rows.append({'label': it['id'], 'x': x, 'y': y, 'walkPoints': len(near),
                 'seq': [near[0][0], near[-1][0]], 'walkH': round(float(np.median([p[3] for p in near])), 2),
                 'smap': float(sm), 'dem2015': round(ground(x, y), 2), 'modelRoadZ': model_z(x, y)})
fit = {}
for k in ('smap', 'dem2015', 'modelRoadZ'):
    use = [r for r in rows if r[k] is not None]
    d = np.array([r['walkH'] - r[k] for r in use])
    off = float(np.median(d)); res = d - off
    fit[k] = {'n': len(use), 'offsetM': round(off, 2), 'rmsResidualM': round(float(np.sqrt(np.mean(res ** 2))), 2),
              'maxAbsResidualM': round(float(np.max(np.abs(res))), 2), 'residuals': {u['label']: round(float(e), 2) for u, e in zip(use, res)}}
loop = [p for p in pts if ((p[1] - 201160.0) ** 2 + (p[2] - 557312.5) ** 2) ** 0.5 <= 3.0]
report = {'run': RUN, 'window': WINDOW, 'radiusM': RADIUS, 'points': rows, 'fit': fit,
          'loopClosure_DaeilPlatform': [[p[0], p[3]] for p in loop]}
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
print(json.dumps({k: {kk: v[kk] for kk in ('n', 'offsetM', 'rmsResidualM', 'maxAbsResidualM')} for k, v in fit.items()}, ensure_ascii=False))
for r in rows: print(r)
print('loop', report['loopClosure_DaeilPlatform'])
