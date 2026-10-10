"""T06: 시험용 DB 편집 묶음을 만든다(적용은 n02.ts apply). 적용 직전의 길·노드 상태(psql 로 뽑은 JSON)를 읽어
V02 의 '바꾸기 전 상태'와 같은지 확인하고 expectedRevision 을 채운다. 다르면 멈춘다.
사용법: python build_groups.py <roads.json> <nodes.json> <묶음 이름 A|B|C|D> <out.json>
 A = 만나는 점 높이 4건, B = 차도 8개 꼭짓점 교체, C = 포장면 노드 8개를 포장면 높이로, D = 오르막 보행로 아래쪽 높이
"""
import json, math, sys
roads = {r['id']: r for r in json.load(open(sys.argv[1], encoding='utf8'))}
nodes = {n['id']: n['c'] for n in json.load(open(sys.argv[2], encoding='utf8'))}
which, out = sys.argv[3], sys.argv[4]
src = json.load(open('ops-source.json', encoding='utf8'))
full = lambda short, table: next(k for k in table if k.startswith(short))
near = lambda a, b, tol=0.011: all(abs(x - y) <= tol for x, y in zip(a, b))
ops = []
if which == 'A':
    for o in src['operations']:
        if o['op'] != 'move_node': continue
        live = nodes[o['args']['nodeId']]
        assert near(live, o['preState']['coordinate']), (o['id'], live, o['preState'])
        ops.append({'ref': o['id'], 'op': 'move_node', 'args': o['args']})
elif which == 'B':
    for o in src['operations']:
        if o['op'] != 'update_road': continue
        r = roads[o['args']['id']]; pre = o['preState']
        assert len(r['c']) == pre['vertexCount'] and near(r['c'][0][:2], pre['first'][:2]) and near(r['c'][-1][:2], pre['last'][:2]) and r['w'] == pre['widthM'], (o['id'], len(r['c']), r['c'][0], r['c'][-1], pre)
        # 끝점 높이는 A 를 적용한 뒤의 노드 높이와 같아야 한다
        a = dict(o['args']); a['expectedRevision'] = r['rev']
        assert abs(a['path'][0]['z'] - nodes[r['from']][2]) < 0.05 and abs(a['path'][-1]['z'] - nodes[r["to"]][2]) < 0.05, (o['id'], a['path'][0], nodes[r['from']], a['path'][-1], nodes[r['to']])
        ops.append({'ref': o['id'], 'op': 'update_road', 'args': a})
elif which == 'C':
    for short in src['plazaNodes']:
        nid = full(short, nodes); c = nodes[nid]
        if abs(c[2] - src['plazaZ']) < 0.001: continue
        ops.append({'ref': 'T06-plaza-node-%s (%.2f -> %.2f)' % (short, c[2], src['plazaZ']), 'op': 'move_node', 'args': {'nodeId': nid, 'to': {'xy': c[:2], 'z': src['plazaZ']}}})
elif which == 'D':
    u = src['uphill']; r = roads[u['id']]
    assert len(r['c']) == len(u['path']) and all(near(p[:2], q['xy']) for p, q in zip(r['c'], u['path'])), r['c']
    assert abs(r['c'][-1][2] - src['plazaZ']) < 0.001, r['c'][-1]
    ops.append({'ref': 'T06-uphill-c52095ad', 'op': 'update_road', 'args': {'id': u['id'], 'expectedRevision': r['rev'], 'path': u['path'], 'zMode': 'explicit', 'densify': False}})
comment = {'A': 'V02 만나는 점 높이 4건(a12b5e30 은 포장면 높이 130.6, 0a815157 은 그에 맞춘 종단)', 'B': 'V02 차도 8개: 매끄러운 가운데 선과 종단(V4a·V4b 끝은 포장면 130.6 m 에 맞춤)',
           'C': '포장면에 닿는 노드를 포장면 높이 130.6 m 로', 'D': '오르막 보행로 c52095ad 아래 세 꼭짓점을 포장면 높이에 맞춰 낮춤'}[which]
json.dump({'id': 'T06-' + which, 'comment': comment, 'ops': ops}, open(out, 'w', encoding='utf8', newline='\n'), ensure_ascii=False, indent=1)
print(which, len(ops), 'ops')
