"""N02: 적용 전후 요약. n02.ts 가 볼트 n02 폴더에 쓴 파일만 읽는다(DB 접속 없음).
  python summarize.py <vault n02 dir> points   -> 07-terrain-points.json (sample_terrain 에 줄 점 목록)
  python summarize.py <vault n02 dir> <out results.json>
읽는 것: 01-state-before.json, 06-state-after.json, 06-areas.json, 07-terrain-samples.json, applied-*.json, 저장소 groups/*.json, georef.json"""
import json, sys, os, collections, pathlib
V, out = sys.argv[1], sys.argv[2]
HERE = pathlib.Path(__file__).parent
load = lambda n: json.load(open(os.path.join(V, n), encoding='utf-8'))
b, a = load('01-state-before.json'), load('06-state-after.json')
old = {r['id']: r for r in b['roads']}; new = {r['id']: r for r in a['roads']}
ORDER = ['P', 'P2', 'Z1', 'Z2', 'Z3', 'V1', 'U1', 'U2', 'G', 'L1', 'L2', 'Y']

def watch_roads():
    """vehicle/shared roads, roads made or changed by N01/N02 (updatedBy T05)."""
    return [r for r in a['roads'] if r['roadClass'] in ('vehicle', 'shared') or r['updatedBy'] == 'T05']
if out == 'points':
    pts = [[round(p[0], 2), round(p[1], 2)] for r in watch_roads() for p in r['coordinates']]
    json.dump({'points': pts[:500]}, open(os.path.join(V, '07-terrain-points-1.json'), 'w')); json.dump({'points': pts[500:1000] or pts[:1]}, open(os.path.join(V, '07-terrain-points-2.json'), 'w'))
    print(len(pts)); sys.exit()

# ---- components: roads only, and with open areas as walkable links ----
def inside(p, ring):
    x, y = p; c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) / (y2 - y1) * (x2 - x1): c = not c
    return c
def near_edge(p, ring, tol=0.5):
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        dx, dy = x2 - x1, y2 - y1; t = max(0, min(1, ((p[0] - x1) * dx + (p[1] - y1) * dy) / (dx * dx + dy * dy or 1)))
        if ((p[0] - x1 - t * dx) ** 2 + (p[1] - y1 - t * dy) ** 2) ** 0.5 <= tol: return True
    return False
def components(state, areas, only=None):
    roads = [r for r in state['roads'] if only is None or only(r)]
    parent = {}
    def find(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for r in roads:
        for n in (r['fromNodeId'], r['toNodeId']): parent.setdefault(n, n)
    for r in roads: parent[find(r['fromNodeId'])] = find(r['toNodeId'])
    access = {}
    for ar in areas:
        ring = [tuple(p[:2]) for p in ar['geometry']['coordinates'][0][:-1]]
        on = [n['id'] for n in state['nodes'] if n['id'] in parent and abs(n['coordinate'][2] - ar['elevationM']) <= 0.5 and (inside(n['coordinate'][:2], ring) or near_edge(n['coordinate'][:2], ring))]
        access[ar['name']] = len(on)
        for n in on[1:]: parent[find(n)] = find(on[0])
    groups = collections.defaultdict(list)
    for r in roads: groups[find(r['fromNodeId'])].append(r)
    comps = sorted(([len(g), round(sum(r['lengthM'] for r in g), 1), sorted(g, key=lambda r: -r['lengthM'])[0]['name'] or sorted(g, key=lambda r: -r['lengthM'])[0]['id'][:8]] for g in groups.values()), key=lambda c: -c[1])
    return comps, access
areas_after = load('06-areas.json'); areas_before = [x for x in areas_after if x['name'] == '운동장']
walk = lambda r: r['pedestrianAccess'] != 'prohibited'
comp = {}
for key, st, ar in (('before', b, areas_before), ('after', a, areas_after)):
    c1, _ = components(st, []); c2, acc = components(st, ar); c3, _ = components(st, ar, walk)
    comp[key] = {'roadsOnly': c1, 'withAreas': c2, 'withAreasWalkNotProhibited': c3, 'areaAccessNodes': acc}

# ---- routes ----
def short(x):
    if not x: return None
    if 'error' in x: return '노드 없음' if 'NO_NETWORK_NEARBY' in x['error'] else x['error'][:80]
    return {'reachable': x['reachable'], **({'lengthM': x['lengthM'], 'viaArea': x['viaArea']} if x['reachable'] else {'closestReachedM': x['closestReachedM']})}
rb = {r['id']: r for r in b['reachability']}
routes = [{'id': r['id'], 'label': r['label'], 'before': ({k: short(rb[r['id']].get(k)) for k in ('walk', 'walkAssumeUnknown', 'vehicle') if rb[r['id']].get(k)} if r['id'] in rb else 'N01 때 재지 않은 쌍'),
           'after': {k: short(r.get(k)) for k in ('walk', 'walkAssumeUnknown', 'vehicle') if r.get(k)}} for r in a['reachability']]

# ---- road height minus active terrain ----
samples = {}
for n in ('07-terrain-samples-1.json', '07-terrain-samples-2.json'):
    d = load(n); tv = d['terrainVersion']
    for s in d['samples']: samples[(s['x'], s['y'])] = s
rows = []
for r in watch_roads():
    d = [round(p[2] - samples[(round(p[0], 2), round(p[1], 2))]['z'], 2) for p in r['coordinates'] if samples.get((round(p[0], 2), round(p[1], 2)), {}).get('z') is not None]
    if not d: continue
    ds = sorted(d); under = ('지하' in (r['name'] or '')) or r['structure'] in ('indoor_corridor', 'elevator') or bool(r['buildingId'])
    rows.append({'id': r['id'][:8], 'name': r['name'], 'class': r['roadClass'], 'structure': r['structure'], 'lengthM': r['lengthM'], 'minM': ds[0], 'medianM': ds[len(ds) // 2], 'maxM': ds[-1],
                 'undergroundOrIndoor': under, 'over0_5': (not under) and (ds[0] < -0.5 or ds[-1] > 0.5)})
rows.sort(key=lambda x: x['minM'])

# ---- steep non-stair segments = height steps left on roads ----
steps = []
for r in a['roads']:
    if r['structure'] in ('stairs', 'elevator'): continue
    c = r['coordinates']
    for p, q in zip(c, c[1:]):
        L = ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2) ** 0.5; dz = q[2] - p[2]
        if abs(dz) >= 0.5 and L > 0 and abs(dz) / L >= 0.2:
            steps.append({'road': r['id'][:8], 'name': r['name'], 'structure': r['structure'], 'from': [round(v, 2) for v in p], 'to': [round(v, 2) for v in q], 'dzM': round(dz, 2), 'runM': round(L, 2)})
def was(s):
    o = old.get(next((i for i in old if i.startswith(s['road'])), None))
    if not o: return False
    return any(abs(p[2] - s['from'][2]) < 0.01 and abs(q[2] - s['to'][2]) < 0.01 and abs(p[0] - s['from'][0]) < 0.02 for p, q in zip(o['coordinates'], o['coordinates'][1:]))
for s in steps: s['alreadyBeforeN02'] = was(s)

# ---- applied change sets ----
groups = []
for g in ORDER:
    d = load(f'applied-{g}.json'); t = json.load(open(HERE / 'groups' / f'{g}.json', encoding='utf-8'))
    groups.append({'group': g, 'title': t['title'], 'batchId': d['batchId'], 'at': d['at'],
                   'changeSets': [{'ref': r['ref'], 'op': r['op'], 'changeSetId': r.get('changeSetId'), 'roads': [{'id': x['id'], 'name': x['name'], 'lengthM': x['lengthM']} for x in r.get('roads', [])],
                                   **({'placeId': r['placeId']} if r.get('placeId') else {}), **({'warnings': r['warnings']} if r.get('warnings') else {})} for r in d['results']]})
created = [r for r in a['roads'] if r['id'] not in old]; gone = [r for r in b['roads'] if r['id'] not in new]
geo = json.load(open(HERE / 'georef.json', encoding='utf-8'))
plaza = next(x for x in areas_after if x['name'].startswith('회차 공간'))
res = {'title': 'N02 포장면·북악관 B1·N01 뒷정리 (시험용 DB)', 'database': 'campus-tracker-test-db 127.0.0.1:5544 (운영 아님)',
       'terrain': {'active': tv, 'was': 'local-samples-7e415b29668b2f62', 'scene': 'campus3d-83d5f401 (전 campus3d-1b0d4590)', 'relevelRoads': '옮길 길 0 (자체 높이 길 19, 실내 19)'},
       'georef': {k: geo[k] for k in ('image', 'scaleMPerPx', 'rotationDeg', 'gcp', 'rmsM', 'maxResidualM', 'markers')},
       'area': {'id': plaza['id'], 'name': plaza['name'], 'kind': plaza['kind'], 'elevationM': plaza['elevationM'], 'areaM2': round(plaza['areaM2'], 1), 'revision': plaza['revision']},
       'counts': {'before': b['counts'], 'after': a['counts']},
       'roads': {'new': [{'id': r['id'][:8], 'name': r['name'], 'class': r['roadClass'], 'structure': r['structure'], 'lengthM': r['lengthM'], 'widthM': r['widthM']} for r in created],
                 'goneOrReplaced': [{'id': r['id'][:8], 'name': r['name'], 'lengthM': r['lengthM']} for r in gone]},
       'validation': {'before': b['validation'], 'after': a['validation']}, 'components': comp,
       'componentsNote': 'roadsOnly = 길만(편집기 검사와 같은 셈). withAreas = 공간 영역 위 같은 높이(±0.5 m) 노드를 한데 묶음(도달 검사와 같은 셈)',
       'routes': routes, 'roadMinusTerrain': {'terrainVersion': tv, 'rows': rows}, 'steepSegmentsLeft': steps, 'groups': groups,
       'revert': {'roads': '변경 묶음을 아래 순서(나중 것부터)로 하나씩 revert_changeset. backend 폴더에서: npx tsx ../docs/audit/n02/n02.ts call revert_changeset {"changeSetId":"<id>"}',
                  'order': [c['changeSetId'] for g in reversed(groups) for c in reversed(g['changeSets'])],
                  'area': f"공간 영역은 변경 묶음에 안 들어간다: npx tsx ../docs/audit/n02/n02.ts rest DELETE areas/{plaza['id']}?expectedRevision=<지금 revision>",
                  'terrain': 'npm run terrain:activate -- local-samples-7e415b29668b2f62 뒤 scene:import 다시 (도로 이동 없음)',
                  'wholeDatabase': '00-backup-mobility-before.sql (pg_dump --schema=mobility, N02 적용 전)'}}
json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps(res['counts'], ensure_ascii=False)); print(json.dumps(res['validation'], ensure_ascii=False))
for k in ('before', 'after'): print(k, json.dumps({x: (v if x == 'areaAccessNodes' else [c[:2] for c in v]) for x, v in comp[k].items()}, ensure_ascii=False))
for r in routes: print(r['id'], '| before', json.dumps(r['before'], ensure_ascii=False), '| after', json.dumps(r['after'], ensure_ascii=False))
print('road - terrain, outdoor over 0.5 m:')
for x in rows:
    if x['over0_5']: print(' ', x['id'], x['class'], x['minM'], x['medianM'], x['maxM'], (x['name'] or '')[:40])
print('steep segments left:')
for s in steps: print(' ', s['road'], s['dzM'], s['runM'], s['alreadyBeforeN02'], (s['name'] or '')[:40])
