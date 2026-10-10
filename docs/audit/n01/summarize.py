"""N01: before/after summary from the files n01.ts wrote.  python -I summarize.py <vault n01 dir> <out results.json>"""
import json, sys, os, collections
V, out = sys.argv[1], sys.argv[2]
load = lambda n: json.load(open(os.path.join(V, n), encoding='utf-8'))
b, a = load('01-state-before.json'), load('02-state-after.json')
old = {r['id']: r for r in b['roads']}; new = {r['id']: r for r in a['roads']}
split_names = collections.Counter(r['name'] for r in b['roads'] if r['id'] not in new)
created = [r for r in a['roads'] if r['id'] not in old and r['name'] not in split_names]
pieces = [r for r in a['roads'] if r['id'] not in old and r['name'] in split_names]
groups = []
for g in 'ABCDEF':
    d = load(f'applied-{g}.json')
    groups.append({'group': g, 'comment': d['comment'], 'batchId': d['batchId'], 'at': d['at'],
                   'changeSets': [{'ref': r['ref'], 'op': r['op'], 'changeSetId': r['changeSetId'],
                                   'roads': [{'id': x['id'], 'name': x['name'], 'lengthM': x['lengthM']} for x in r.get('roads', [])], **({'placeId': r['placeId']} if r.get('placeId') else {}),
                                   **({'replaced': r['replacedRoads']} if r.get('replacedRoads') else {}), **({'warnings': r['warnings']} if r.get('warnings') else {})} for r in d['results']]})
def comp(s): return {'all': [[c['roads'], c['lengthM']] for c in s['components']['all']], 'walkAllowedOnly': [[c['roads'], c['lengthM']] for c in s['components']['walkableOnly']]}
def short(x):
    if not x: return None
    if 'error' in x: return 'no node within 3 m' if 'NO_NETWORK_NEARBY' in x['error'] else x['error'][:80]
    return {'reachable': x['reachable'], **({'lengthM': x['lengthM'], 'viaArea': x['viaArea']} if x['reachable'] else {'closestReachedM': x['closestReachedM']})}
rb = {r['id'].replace('정문(공도 분기)', '정문'): r for r in b['reachability']}
routes = [{'id': r['id'], 'label': r['label'], 'before': {k: short(rb[r['id']].get(k)) for k in ('walk', 'walkAssumeUnknown', 'vehicle') if rb[r['id']].get(k)},
           'after': {k: short(r.get(k)) for k in ('walk', 'walkAssumeUnknown', 'vehicle') if r.get(k)}} for r in a['reachability']]
res = {'title': 'N01 시험용 DB 도로 적용 결과', 'database': 'campus-tracker-test-db 127.0.0.1:5544 (운영 아님)',
       'counts': {'before': b['counts'], 'after': a['counts']},
       'created': {'roads': len(created), 'lengthM': round(sum(r['lengthM'] for r in created), 1), 'vehicleLengthM': round(sum(r['lengthM'] for r in created if r['roadClass'] == 'vehicle'), 1),
                   'pedestrianLengthM': round(sum(r['lengthM'] for r in created if r['roadClass'] != 'vehicle'), 1), 'places': a['counts']['places'] - b['counts']['places'],
                   'existingRoadsSplit': dict(split_names), 'piecesOfSplitRoads': len(pieces)},
       'validation': {'before': b['validation'], 'after': a['validation']}, 'components': {'before': comp(b), 'after': comp(a)},
       'componentsNote': '검사의 묶음 수는 길만 센다. 운동장 면으로 이어지는 계단 4개는 길로는 외딴 묶음이지만 도달 검사에서는 면을 건너 이어진다',
       'routes': routes, 'roadMinusTerrain': load('03-road-minus-terrain.json'), 'groups': groups,
       'revert': {'how': '변경 묶음을 아래 순서(나중 것부터)로 하나씩 revert_changeset. backend 폴더에서: npx tsx ../docs/audit/n01/n01.ts call revert_changeset \'{"changeSetId":"<id>"}\'',
                  'order': [c['changeSetId'] for g in reversed(groups) for c in reversed(g['changeSets'])],
                  'wholeDatabase': '00-backup-mobility-before.sql (pg_dump --schema=mobility, 적용 전)'}}
json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps({k: res[k] for k in ('counts', 'created', 'components')}, ensure_ascii=False))
print(json.dumps(res['validation'], ensure_ascii=False))
for r in routes: print(r['label'], '| before', json.dumps(r['before'], ensure_ascii=False), '| after', json.dumps(r['after'], ensure_ascii=False))
print(len(res['revert']['order']), 'change sets')
