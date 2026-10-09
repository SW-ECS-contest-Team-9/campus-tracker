"""Read-only audit: Bukak (북악관) / Munye (문예관) floor heights vs the user's "Bukak 8F -> Munye interior" memory.

Inputs (vault snapshot, 2026-10-09): live roads/nodes/scene via the editor MCP / public API, archived DEM (sha-identical
to the live terrain grid), building outlines in EPSG:5186, fusion-v4 FINAL tracks (h = phone height, orthometric).
Writes one JSON report. Never touches the DB.

  python bukak_munye_levels.py <audit-dir> <out.json>
"""
import json, sys, math, pathlib
import numpy as np
from shapely.geometry import shape, Point, Polygon, MultiPolygon

audit = pathlib.Path(sys.argv[1]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))

meta = load(audit / 'terrain-grid-meta.json')
dem = np.fromfile(audit / 'terrain-grid.f32', dtype='<f4').reshape(meta['height'], meta['width'])  # row 0 = south


def ground(x, y):
    """Bilinear DEM height at cell centres (same convention as the server)."""
    gx = (x - meta['originX']) / meta['resolution'] - 0.5
    gy = (y - meta['originY']) / meta['resolution'] - 0.5
    i, j = int(np.floor(gx)), int(np.floor(gy)); fx, fy = gx - i, gy - j
    v = dem[j:j + 2, i:i + 2].astype(float)
    return float(v[0, 0] * (1 - fx) * (1 - fy) + v[0, 1] * fx * (1 - fy) + v[1, 0] * (1 - fx) * fy + v[1, 1] * fx * fy)


outlines = {o['name']: MultiPolygon([Polygon(p[0], p[1:]) for p in o['coordinates']]) for o in load(audit / 'building-outlines-5186.json')}
BUKAK, MUNYE = outlines['북악관'], outlines['문예관']
scene = {b['name']: b for b in load(live / 'scene-live.json')['buildings']}
roads = load(live / 'roads-live.json')['items']


def dem_stats(poly):
    minx, miny, maxx, maxy = poly.bounds
    vals = [ground(x, y) for x in np.arange(minx, maxx, 1.0) for y in np.arange(miny, maxy, 1.0) if poly.contains(Point(x, y))]
    return {'min': round(min(vals), 2), 'median': round(float(np.median(vals)), 2), 'max': round(max(vals), 2), 'samples': len(vals)}


def floor_estimate(z, g, fh=3.0):  # frontend floorFromHeight
    k = round((z - g) / fh)
    return f'{k + 1}F' if k >= 0 else f'B{-k}'


def inside(poly, c, buf=0.0):
    return poly.buffer(buf).contains(Point(c[0], c[1]))


# 1. building geometry relation
gap = BUKAK.distance(MUNYE)
shared = BUKAK.buffer(1.0).intersection(MUNYE.buffer(1.0))
report = {
    'buildings': {n: {k: scene[n][k] for k in ('heightM', 'heightSource', 'groundFloors', 'baseM', 'roofM', 'terrainMinM', 'terrainMaxM', 'note')}
                  | {'demUnderFootprint': dem_stats(outlines[n])} for n in ('북악관', '문예관')},
    'footprintGapM': round(gap, 2),
    'contactZoneAreaM2_buffer1m': round(shared.area, 1),
}
if not shared.is_empty:
    c = shared.centroid
    report['contactZone'] = {'centroid': [round(c.x, 2), round(c.y, 2)], 'demAtCentroid': round(ground(c.x, c.y), 2)}

# 2. roads in/at each building, grouped by Z
def road_rows(poly, buf):
    out = []
    for r in roads:
        cs = r['coordinates']
        if not any(inside(poly, c, buf) for c in cs): continue
        zs = [c[2] for c in cs]
        mid = sorted(cs, key=lambda c: c[2])[len(cs) >> 1] if r['structure'] not in ('stairs', 'elevator', 'ramp') else min(cs, key=lambda c: c[2])
        g = ground(mid[0], mid[1])
        out.append({'id': r['id'], 'name': r['name'], 'structure': r['structure'], 'levelId': r['levelId'], 'zMin': min(zs), 'zMax': max(zs),
                    'demAtRef': round(g, 2), 'frontendFloorEstimate(3m)': floor_estimate(mid[2], g)})
    return sorted(out, key=lambda x: (x['zMin'], x['zMax']))


report['bukakRoads'] = road_rows(BUKAK, 0.5)
report['munyeRoads'] = road_rows(MUNYE, 0.5)
lv = sorted({round(r['zMin'], 2) for r in report['bukakRoads'] if r['structure'] == 'indoor_corridor'})
report['bukakCorridorLevels'] = lv
report['bukakLevelSteps'] = [round(b - a, 2) for a, b in zip(lv, lv[1:])]

# 3. tracks: phone height inside each footprint and Bukak<->Munye transitions
tracks = {}
for f in sorted((live / 'tracks').glob('*.json')):
    d = load(f)
    if not d.get('points'): continue
    key = f.stem[:-2]
    tracks.setdefault(key, []).extend(d['points'])
transitions, per_track = [], {}
for key, pts in tracks.items():
    pts = sorted({p[0]: p for p in pts}.values())
    tag = lambda p: 'B' if inside(BUKAK, p[1:3]) else ('M' if inside(MUNYE, p[1:3]) else '-')  # p = [seq, x, y, h]
    tags = [tag(p) for p in pts]
    hb = [p[3] for p, t in zip(pts, tags) if t == 'B' and p[3] is not None]
    hm = [p[3] for p, t in zip(pts, tags) if t == 'M' and p[3] is not None]
    per_track[key] = {'pointsInBukak': len(hb), 'pointsInMunye': len(hm),
                      'bukakH': [round(min(hb), 2), round(max(hb), 2)] if hb else None,
                      'munyeH': [round(min(hm), 2), round(max(hm), 2)] if hm else None}
    last = None  # last point that was inside one of the two buildings
    for i, (p, t) in enumerate(zip(pts, tags)):
        if t == '-': continue
        if last is not None and t != tags[last] and p[0] - pts[last][0] <= 60:
            a = pts[last]
            transitions.append({'track': key, 'from': tags[last], 'to': t, 'seqFrom': a[0], 'seqTo': p[0], 'hFrom': a[3], 'hTo': p[3],
                                'xyFrom': a[1:3], 'xyTo': p[1:3], 'demFrom': round(ground(*a[1:3]), 2), 'demTo': round(ground(*p[1:3]), 2),
                                'between': [[q[0], q[3], round(ground(q[1], q[2]), 2)] for q in pts[last + 1:i]]})
        last = i
report['tracks'] = per_track
report['bukakMunyeTransitions'] = transitions

munye_top_corridor = max((r['zMax'] for r in report['munyeRoads'] if r['structure'] != 'stairs'), default=None)
report['munyeRoofM'] = scene['문예관']['roofM']
report['munyeTopCorridorZ'] = munye_top_corridor

# 4. crossing height from two independent walks (relative barometer only) vs the Bukak model level
PHONE_M, FIELD_SMAP = 1.0, float(np.mean([p['smapDemM'] for p in load(audit / 'smap-coordinate-checks.json')['points'] if p['id'].startswith('c02_vertex')]))
w0846 = sorted(tracks['C02-9a6dc2bb'], key=lambda p: p[0]); w1218 = sorted(tracks['C02-8754e88c'], key=lambda p: p[0])
field = float(np.median([p[3] for p in w0846 if 512 <= p[0] <= 650]))  # on C02, inside the -0.45 m loop closure
entrance = float(np.median([p[3] for p in w0846 if 836 <= p[0] <= 855 and inside(MUNYE, p[1:3])]))  # Munye upper entrance level
munye_hi = [p[3] for p in w1218 if 672 <= p[0] <= 730 and inside(MUNYE, p[1:3])]
munye_lo = [p[3] for p in w1218 if 738 <= p[0] <= 762 and inside(MUNYE, p[1:3])]  # after the fixed-XY descent, before the exit
cross_from_field = FIELD_SMAP - (field - entrance) + (float(np.median(munye_hi)) - float(np.median(munye_lo)))
report['crossingCheck'] = {
    'fieldSmapMeanM': round(FIELD_SMAP, 2), 'walk0846_fieldMinusMunyeEntranceM': round(field - entrance, 2),
    'walk1218_munyeCrossingMinusLowerM': round(float(np.median(munye_hi)) - float(np.median(munye_lo)), 2),
    'crossingFloorZ_viaFieldAnchor': round(cross_from_field, 2), 'crossingFloorZ_bukakModelMinusPhone': round(lv[-1] - PHONE_M, 2),
    'assumption': 'the 12:18 walk leaves Munye on the same level the 08:46 walk entered (same door area, unverified)'}

# 5. candidates (not applied)
crossing = (cross_from_field + lv[-1] - PHONE_M) / 2
ladder = [132.8, 136.7, 140.6] + [z for z in lv if z > 140.6]  # named B1/1F/2F, then the Z-level ids in use
median_outline = scene['문예관']['roofM'] - scene['문예관']['heightM']  # scene-heights.ts: roof = outline median + height
report['candidates'] = {
    'floorLabels': {'status': 'CANDIDATE - labels only; levelId/connection changes are an integration decision',
                    'basis': 'continuous 8-level ladder in one walk on two phones (12:18Z) + user memory "8F -> Munye"',
                    'mapping': [{'modelZ': z, 'currentName': cur, 'candidateFloor': f'{i + 1}F'}
                                for i, (z, cur) in enumerate(zip(ladder, ['B1', '1F', '2F'] + [f'levelId 북악관_Z{z}_추정' for z in ladder[3:]]))]},
    'munyeHeight': {'status': 'CANDIDATE - scene GeoPackage value, ESTIMATE', 'currentHeightM': scene['문예관']['heightM'],
                    'currentRoofM': scene['문예관']['roofM'], 'crossingFloorZ': round(crossing, 2), 'storeyAssumedM': 3.4,
                    'candidateHeightM': math.ceil(crossing + 3.4 - median_outline),
                    'candidateRoofM': round(median_outline + math.ceil(crossing + 3.4 - median_outline), 3)},
    'munyeL8Connection': {'status': 'FIELD CHECK - new connection, XY from the C02 phone only (C01 XY differs by up to ~20 m)',
                          'bukakSideEnd': 'b6003357 (154.51 m east corridor) ends 9.8 m short of Munye',
                          'track': [[p[0], p[1], p[2], p[3]] for p in w1218 if 640 <= p[0] <= 740 and p[0] % 3 == 0]},
}
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
print(json.dumps({k: report[k] for k in ('footprintGapM', 'contactZoneAreaM2_buffer1m', 'bukakCorridorLevels', 'bukakLevelSteps', 'munyeRoofM', 'munyeTopCorridorZ', 'crossingCheck')}, ensure_ascii=False))
print(json.dumps({k: v for k, v in report['candidates'].items() if k != 'munyeL8Connection'}, ensure_ascii=False))
