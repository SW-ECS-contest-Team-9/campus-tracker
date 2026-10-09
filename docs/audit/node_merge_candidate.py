"""CT-M13 — read-only merge candidate for 북악관 stair ends that sit on a corridor node's coordinates but are separate nodes.

Only the four stairs from CT-M12 are examined. For each stair end, nodes within the editor's coincident tolerance
(XY 0.02 m, Z 0.05 m; get_editor_context) are listed with their incident roads. A merge candidate replaces the stair's
end node id by the corridor node id; road geometry and heights are untouched. Coordinate agreement and real-connection
evidence are judged separately. Checks: Z change, self loop, duplicate edge, cross-level link, editor levelId rule
("roads connect only when levelId matches exactly").

  python node_merge_candidate.py <audit-dir> <out.json>
"""
import json, sys, math, pathlib

audit = pathlib.Path(sys.argv[1]); live = audit / 'claude-live'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
TOL_XY, TOL_Z = 0.02, 0.05
STAIRS = ['bd2df230', 'ec66a05b', '391630e3', 'f1d0ee7b']
roads = {r['id']: r for r in load(live / 'roads-live-2.json')['items']}
nodes = {n['id']: n for n in load(live / 'nodes-live-2.json')['items']}
deleted = ['6f2a4bcd', '7408c108']  # user deletions 2026-10-09 09:51Z — not restored, not used
s05 = (audit / 'claude-m12' / 'S05-북악관-근거대조.md').read_text(encoding='utf-8')
by_node = {}
for r in roads.values():
    for n in (r['fromNodeId'], r['toNodeId']): by_node.setdefault(n, []).append(r['id'])

out = []
for short in STAIRS:
    rid = next(k for k in roads if k.startswith(short)); r = roads[rid]
    for end, nid in (('from', r['fromNodeId']), ('to', r['toNodeId'])):
        c = r['coordinates'][0] if end == 'from' else r['coordinates'][-1]
        deg = len(by_node.get(nid, []))
        near = [n for n in nodes.values() if n['id'] != nid and math.hypot(n['coordinate'][0] - c[0], n['coordinate'][1] - c[1]) <= TOL_XY
                and abs(n['coordinate'][2] - c[2]) <= TOL_Z]
        row = {'stair': rid, 'stairName': r['name'], 'stairLevelId': r['levelId'], 'end': end, 'nodeId': nid, 'xyz': c, 'nodeDegree': deg, 'candidates': []}
        for n in near:
            inc = [roads[x] for x in by_node.get(n['id'], [])]
            new_from = n['id'] if end == 'from' else r['fromNodeId']; new_to = n['id'] if end == 'to' else r['toNodeId']
            dup = [x['id'] for x in roads.values() if x['id'] != rid and {x['fromNodeId'], x['toNodeId']} == {new_from, new_to}]
            ends_z = [ (x['coordinates'][0] if x['fromNodeId'] == n['id'] else x['coordinates'][-1])[2] for x in inc]
            levels = sorted({str(x['levelId']) for x in inc})
            row['candidates'].append({
                'nodeId': n['id'], 'nodeLevelId': n.get('levelId'), 'dxyM': round(math.hypot(n['coordinate'][0] - c[0], n['coordinate'][1] - c[1]), 3),
                'dzM': round(n['coordinate'][2] - c[2], 3), 'incidentRoads': [{'id': x['id'], 'name': x['name'], 'structure': x['structure'], 'levelId': x['levelId']} for x in inc],
                'checks': {'zChange': 0.0, 'incidentEndZSpreadM': round(max(ends_z) - min(ends_z), 3) if ends_z else None,
                           'selfLoop': new_from == new_to, 'duplicateEdge': dup, 'crossLevel': any(abs(z - c[2]) > TOL_Z for z in ends_z),
                           'sameLevelId': all(x['levelId'] == r['levelId'] for x in inc), 'corridorLevelIds': levels,
                           'validatorCase': 'LEVEL_NODES_NOT_JOINED (connector end vs other level) -> merge_nodes suggested' if r['structure'] in ('stairs', 'elevator', 'ramp') and not all(x['levelId'] == r['levelId'] for x in inc) else 'DUPLICATE_NODES or none'}})
        out.append(row)

pairs = [x for x in out if x['nodeDegree'] == 1 and x['candidates']]
for p in pairs:
    for cnd in p['candidates']:
        ck = cnd['checks']
        coord_match = cnd['dxyM'] <= TOL_XY and abs(cnd['dzM']) <= TOL_Z
        evidence = '부분 (CT-M12: 12:18Z 상승 seq와 계단 끝 3 m 이내, 중간은 8–15 m 벗어남)'
        blockers = [k for k, bad in (('selfLoop', ck['selfLoop']), ('duplicateEdge', bool(ck['duplicateEdge'])), ('crossLevel', ck['crossLevel'])) if bad]
        cnd['judgement'] = {'coordinateMatch': coord_match, 'connectionEvidence': evidence,
                            'decision': '병합 후보 (검토용, 연결 증거 부분)' if coord_match and not blockers else f'보류: {", ".join(blockers) or "근거 부족"}'}
report = {'snapshot': (live / 'snapshot2-time.txt').read_text().strip(), 'roads': len(roads), 'deletedExcluded': deleted, 'tolerance': {'xyM': TOL_XY, 'zM': TOL_Z},
          'stairEnds': out, 'danglingEndsWithCoincidentNode': len(pairs),
          'operationallyApplicable': False, 'note': 'geometry and Z unchanged; only node ids would change; not applied'}
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
for p in out:
    print(p['stair'][:8], p['end'], 'deg', p['nodeDegree'], p['stairLevelId'], [(c['nodeId'][:8], c['checks']['corridorLevelIds'], c['checks']['sameLevelId'], c['checks']['duplicateEdge'] != [], c['checks']['crossLevel'], c.get('judgement', {}).get('decision')) for c in p['candidates']])
