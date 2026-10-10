"""G02: 시험용 DB 편집 묶음(편집기 MCP apply_changes 입력)을 만든다. 지금 DB 상태(01-before-*.json, dump_state.sh)를 읽기만 한다.
  python build_groups.py A|B|C <상태 접두사, 예: 03-afterRelevel>   -> g02/group-<A|B|C>.json
A: 노드 2개를 기본 경사면 높이로. B: 길 3개의 높이를 기본 경사면에 맞춤(A 뒤의 상태로 만든다). D/E: 길 세 개의 가운데 선을 세 줄(보도·경사로·계단식 띠)의 가운데 t = 1.2 m 로 옮김(D 노드, E 길). 옛 선은 북쪽 가장자리에 치우쳐 있었다. C: 운동장을 가로지르는 옛 보행 기록선 79fbc430 을 보관 처리(사용자 결정 2026-10-11, E10-3)."""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
which, prefix = sys.argv[1], sys.argv[2]
roads = {r['id']: r for r in json.loads((G02 / f'{prefix}-roads.json').read_text(encoding='utf-8'))}
nodes = {n['id']: n['c'] for n in json.loads((G02 / f'{prefix}-nodes.json').read_text(encoding='utf-8'))}
full = lambda short, table: next(k for k in table if k.startswith(short))
zp = lambda x, y: round(float(way_z(xy_to_st(x, y)[0])), 2)
ops = []
if which == 'A':
    for short in ('4f294196', 'ef5a3c9c'):
        nid = full(short, nodes); c = nodes[nid]
        ops.append({'ref': f'G02-node-{short} ({c[2]:.2f} -> {zp(c[0], c[1]):.2f})', 'op': 'move_node', 'args': {'nodeId': nid, 'to': {'xy': c[:2], 'z': zp(c[0], c[1])}}})
    comment = 'G02 내리막길 노드 높이를 기본 경사면에 맞춤: 갈림 아래 노드, 대일관 서쪽 끝 노드'
elif which == 'B':
    for short, width in (('c52095ad', None), ('8e71c240', 7.5), ('45682ee7', 7.5)):
        rid = full(short, roads); r = roads[rid]
        path = [{'xy': p[:2], 'z': zp(p[0], p[1])} for p in r['c']]
        for end, nk in ((0, 'from'), (-1, 'to')):  # 경사면 밖(광장·운동장)의 끝 노드는 그 높이 그대로
            if not nodes[r[nk]][:2] == r['c'][end][:2] or r[nk][:8] not in ('4f294196', 'ef5a3c9c'): path[end]['z'] = nodes[r[nk]][2]
        a = {'id': rid, 'expectedRevision': r['rev'], 'path': path, 'zMode': 'explicit', 'densify': False}
        if width: a['widthM'] = width
        ops.append({'ref': f'G02-road-{short}', 'op': 'update_road', 'args': a})
    comment = 'G02 내리막길 길 높이를 기본 경사면(130.6 → 148.9 m)에 맞춤: 윗구간 둘에 폭 7.5 m(본관을 지난 뒤의 세 줄 폭, 추정)'
elif which in ('D', 'E'):
    TC = 1.2
    def mv(c):
        s_, t_ = xy_to_st(c[0], c[1]); x, y = st_to_xy(float(s_), TC); return [round(float(x), 2), round(float(y), 2)], round(float(way_z(s_)), 2)
    if which == 'D':
        for short in ('4f294196', 'ef5a3c9c'):
            nid = full(short, nodes); xy, z = mv(nodes[nid])
            ops.append({'ref': f'G02-node-xy-{short} ({nodes[nid][:2]} -> {xy})', 'op': 'move_node', 'args': {'nodeId': nid, 'to': {'xy': xy, 'z': z}}})
        comment = 'G02 내리막길 노드 둘을 세 줄의 가운데(t = 1.2 m)로 옮김(2.4~4.4 m)'
    else:
        for short in ('c52095ad', '8e71c240', '45682ee7'):
            rid = full(short, roads); r = roads[rid]; path = []
            for k, p in enumerate(r['c']):
                end = r['from'] if k == 0 else r['to'] if k == len(r['c']) - 1 else None
                if end: path.append({'xy': nodes[end][:2], 'z': nodes[end][2]})
                else: xy, z = mv(p); path.append({'xy': xy, 'z': z})
            ops.append({'ref': f'G02-road-xy-{short}', 'op': 'update_road', 'args': {'id': rid, 'expectedRevision': r['rev'], 'path': path, 'zMode': 'explicit', 'densify': False}})
        comment = 'G02 내리막길 길 셋의 가운데 선을 세 줄의 가운데(t = 1.2 m)로 옮김. 높이는 기본 경사면 그대로'
else:
    rid = full('79fbc430', roads); r = roads[rid]
    ops.append({'ref': 'G02-retire-field-walk-record', 'op': 'retire_feature', 'args': {'type': 'road', 'id': rid, 'expectedRevision': r['rev']}})
    comment = '운동장을 가로지르는 옛 보행 기록선(C02 수집 경로의 운동장 구간) 보관 처리. 사용자 결정 2026-10-11 "보행기록선은 은퇴시켜"(E10-3). 지우지 않음'
out = G02 / f'group-{which}.json'
out.write_text(json.dumps({'id': f'G02-{which}', 'comment': comment, 'ops': ops}, ensure_ascii=False, indent=1), encoding='utf-8')
print(out.name, len(ops)); [print(' ', o['ref'], [q['z'] for q in o['args'].get('path', [])]) for o in ops]
