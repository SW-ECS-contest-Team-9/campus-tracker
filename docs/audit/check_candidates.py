"""Checks on the audit outputs (no DB). Exit code 1 on any failure.

  python check_candidates.py <audit-dir>
"""
import json, sys, math, pathlib

audit = pathlib.Path(sys.argv[1])
load = lambda n: json.loads((audit / n).read_text(encoding='utf-8'))
fails = []


def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg)
    if not ok: fails.append(msg)


# live snapshot equals the archive used by earlier audits (no edits in between)
live = {r['id']: r for r in load('claude-live/roads-live.json')['items']}
arch = {r['id']: r for r in load('roads.json')}
check(live.keys() == arch.keys(), f'live road ids == archived road ids ({len(live)})')
check(all(len(live[i]['coordinates']) == len(arch[i]['coordinates']) and
          all(abs(a - b) <= 0.006 for p, q in zip(live[i]['coordinates'], arch[i]['coordinates']) for a, b in zip(p, q)) for i in live),
      'live coordinates == archived coordinates (<= 6 mm, cm rounding)')

# C02 candidate
c = load('claude-c02-candidate-v1.json')
roads = {r['id']: r for r in c['releveled']}
c02 = roads['3910b4a5-0b5f-4226-bdf5-8f2c8eca99fb']
smap = {p['vertexIndex']: p['smapDemM'] for p in load('smap-coordinate-checks.json')['points'] if p.get('roadId') == c02['id']}
inner = [abs(v[2] - smap[i]) for i, v in enumerate(c02['coordinatesNew']) if 0 < i < len(c02['coordinatesNew']) - 1]
check(max(inner) < 1e-3, f'C02 inner vertices == S-MAP (max {max(inner):.4f} m)')
check(c02['maxAbsGradeAfter'] < 2, f'C02 max grade after {c02["maxAbsGradeAfter"]} % (< 2 %)')
node_z = {n['id']: n['newZ'] for n in c['nodes']}
src = {r['id']: r for r in load('claude-live/roads-live.json')['items']}
gaps = [abs(r['coordinatesNew'][0][2] - node_z[src[r['id']]['fromNodeId']]) + abs(r['coordinatesNew'][-1][2] - node_z[src[r['id']]['toNodeId']]) for r in c['releveled']]
check(max(gaps) == 0, 'every re-levelled road end equals its node Z (no junction gap)')
check(all(src[r['id']]['revision'] == r['revision'] for r in c['releveled']), 'candidate revisions match the live snapshot')
xy = all(abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9 for r in c['releveled'] for a, b in zip(r['coordinatesOld'], r['coordinatesNew']))
check(xy, 'candidate changes Z only (XY unchanged)')
stairs = [r for r in c['releveled'] if r['structure'] == 'stairs']
check(all((r['zOld'][0] - r['zOld'][1]) * (r['zNew'][0] - r['zNew'][1]) > 0 for r in stairs), 're-levelled stairs keep their up/down direction')
check(c['offsetFromSurfaceFit']['rmsResidualM'] < 1.0, f'walk vs S-MAP shape RMS {c["offsetFromSurfaceFit"]["rmsResidualM"]} m (< 1 m)')

# Bukak / Munye
b = load('claude-bukak-munye-levels.json')
x = b['crossingCheck']
check(abs(x['crossingFloorZ_viaFieldAnchor'] - x['crossingFloorZ_bukakModelMinusPhone']) < 1.0,
      f'crossing Z from two walks agrees ({x["crossingFloorZ_viaFieldAnchor"]} vs {x["crossingFloorZ_bukakModelMinusPhone"]})')
m = b['candidates']['munyeHeight']
check(m['candidateRoofM'] >= m['crossingFloorZ'] + 3.0, 'candidate Munye roof is at least one storey above the crossing floor')
check(len(b['candidates']['floorLabels']['mapping']) == 8 and b['candidates']['floorLabels']['mapping'][-1]['modelZ'] == max(b['bukakCorridorLevels']),
      '8 Bukak levels; the top one is the crossing level')
sys.exit(1 if fails else 0)
