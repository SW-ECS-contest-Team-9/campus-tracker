"""N01: builds the change groups (groups/*.json) for n01.ts from the proposal files and the current test-DB state.

  python -I docs/audit/n01/build_groups.py <state-before.json> <out-dir>

Reads docs/audit/e03/apply-plan.json, e09/editor-ops.json, b03/network.json, e10/editor-ops.json (read only).
Checks each item's expected pre-state against the state dump and writes plan.json (applied / skipped with reasons).
Nothing here talks to a database.
"""
import json, math, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIT = os.path.dirname(HERE)
state_path, out_dir = sys.argv[1], sys.argv[2]
load = lambda p: json.load(open(p, encoding='utf-8'))
state = load(state_path)
roads = {r['id']: r for r in state['roads']}
nodes = {n['id']: n for n in state['nodes']}
short = lambda table, s: next(k for k in table if k.startswith(s))
e03, e09, b03, e10 = (load(os.path.join(AUDIT, p)) for p in ('e03/apply-plan.json', 'e09/editor-ops.json', 'b03/network.json', 'e10/editor-ops.json'))
groups, skipped, notes = [], [], []

def skip(ref, source, reason): skipped.append({'ref': ref, 'source': source, 'reason': reason})
def close(a, b, tol=0.011): return all(abs(x - y) <= tol for x, y in zip(a, b))

# ---- A: E03 grade-A merges (북악관 upper-floor stair ends; independent of the B1 question) ----
ops = []
for o in e03['operations']:
    ok = True
    for key, idkey in (('keepNode', 'keepNodeId'), ('removeNode', 'removeNodeId')):
        n = nodes.get(o['args'][idkey]); exp = o['expect'][key]
        if not n or n.get('levelId') != exp['levelId'] or not close(n['coordinate'], exp['coordinate']): ok = False
    for rid, rev in e03['expectRoadRevisions'].items():
        if roads[rid]['revision'] != rev['before'] and o is e03['operations'][0]: notes.append(f"E03: road {rid[:8]} revision {roads[rid]['revision']} != expected {rev['before']}")
    if ok: ops.append({'ref': o['id'], 'op': 'merge_nodes', 'args': o['args'], 'grade': 'A(검사 규칙 LEVEL_NODES_NOT_JOINED, 좌표 차 0)'})
    else: skip(o['id'], 'e03/apply-plan.json', '기대한 노드 상태와 시험용 DB가 다름')
groups.append({'id': 'A', 'title': '북악관 위층 계단 끝 노드 병합', 'comment': 'N01-A 북악관 위층 계단 끝 병합 5건 (근거: 실험 E03 길 사슬 도로망 변경 목록, apply-plan)', 'evidence': 'E03', 'ops': ops})

# ---- B: attribute corrections of existing roads that later items attach to ----
ops = []
by_id = {o['id']: o for o in e09['operations']}
for ref in ('E09-FIX-c52095ad', 'E09-FIX-8e71c240', 'E09-B08-6'):
    o = by_id[ref]; r = roads.get(o['args']['id'])
    if not r or r['revision'] != o['args']['expectedRevision']:
        skip(ref, 'e09/editor-ops.json', f"개정 번호가 다름(기대 {o['args']['expectedRevision']}, 지금 {r and r['revision']})"); continue
    ops.append({'ref': ref, 'op': 'update_road', 'args': o['args'], 'grade': o['grade']})
groups.append({'id': 'B', 'title': '기존 길 속성 정정(오르막 보행로 2개, 지하 차도 이름·폭)', 'comment': 'N01-B 문예관 옆 오르막을 보행로로, 지하 차도 951c157d 이름·폭 (근거: 실험 E09 차량 도로와 주차장 입구, B08 갱신)', 'evidence': 'E09·B08', 'ops': ops})

# ---- C: vehicle surface roads + places ----
ops = []
for o in e09['operations']:
    if o['op'] == 'create_road': ops.append({'ref': o['id'], 'op': 'create_road', 'args': o['args'], 'grade': o['grade']})
for o in e09['operations']:  # dry run: roads drawn from the same coordinate already share one node, and connect_roads then fails the whole batch
    if o['op'] == 'connect_roads': skip(o['id'], 'e09/editor-ops.json', '필요 없음: 같은 좌표에서 시작한 새 길들이 저장될 때 이미 한 노드를 함께 쓴다(connect_roads는 "이미 이어짐"으로 거부되어 묶음 전체가 실패)')
for o in e09['operations']:
    if o['op'] != 'create_place': continue
    if o['id'] == 'E09-PLACE-G-WEST': skip(o['id'], 'e09/editor-ops.json', '위치 추정: 사용자 표시와 11.2 m 차(B08), 5 m 넘음'); continue
    ops.append({'ref': o['id'], 'op': 'create_place', 'args': o['args'], 'grade': o['grade']})
groups.append({'id': 'C', 'title': '차량 도로 7구간과 장소 6곳', 'comment': 'N01-C 정문~분수 광장 옆~S06~회차 공간 차도, 주차장 차로 2, 은주관 서쪽 윗길, 장소 6 (근거: 실험 E09 차량 도로와 주차장 입구)', 'evidence': 'E09', 'ops': ops})
skip('E09-B08-1', 'e09/editor-ops.json', '8fde6a04 없애기: 북악관 B1 관련이라 이번에 하지 않음(B10 뒤)')

# ---- D: underground road known pieces + surface crossing (b03 B08-2..5) ----
b08 = {p['b08Id']: p for p in b03['proposals'] if p.get('b08Id')}
def path(coords): return [c if isinstance(c, dict) else {'xy': [c[0], c[1]], 'z': c[2]} for c in coords]
def ped(ref, structure, name, coords, grade, extra=None):
    args = {'roadClass': 'pedestrian', 'name': name, 'structure': structure, 'path': path(coords), 'zMode': 'explicit', 'densify': False}
    args.update(extra or {})
    return {'ref': ref, 'op': 'create_road', 'args': args, 'grade': grade}
n18 = nodes[short(nodes, '18b2d87e')]; n04 = nodes[short(nodes, '04044da5')]
ops = []
if close(n18['coordinate'], b08['B08-2']['expectedPreState']['node18b2d87e']):
    p = b08['B08-2']; ops.append(ped('B08-2', 'ordinary', p['name'], p['coordinates'], p['grade']))
else: skip('B08-2', 'b03/network.json', '노드 18b2d87e 좌표가 기대와 다름')
if close(n04['coordinate'], b08['B08-3']['expectedPreState']['node04044da5']):
    p = b08['B08-3']; ops.append(ped('B08-3', 'ordinary', p['name'], [p['coordinates'][0], {'at': {'nodeId': n04['id']}}], p['grade']))
else: skip('B08-3', 'b03/network.json', '노드 04044da5 좌표가 기대와 다름')
p = b08['B08-4']; ops.append(ped('B08-4', 'stairs', p['name'], p['coordinates'], p['grade']))
p = b08['B08-5']; ops.append(ped('B08-5', 'ordinary', p['name'], p['coordinates'], p['grade']))
groups.append({'id': 'D', 'title': '본관·북악관 사이: 지상 횡단 길, 오르막 보행로 아래 끝 연결, 본관 쪽 계단, 지하 차도 보행 구간', 'comment': 'N01-D 횡단보도 길·본관 쪽 계단·지하 차도 보행 구간 (근거: 실험 E08 B08 갱신, 사용자 그림 14)', 'evidence': 'B08(b03/network.json)', 'ops': ops})
for ref in ('B08-7', 'B08-8', 'B08-9', 'B08-10', 'B08-11', 'B08-12'): skip(ref, 'b03/network.json', '북악관 B1·GS25·옆길: 이번에 하지 않음(B10 뒤). B08-10~12는 제안에서도 막힘')

# ---- E: A14 / chain 1a fork stair (user drawing) ----
a14 = next(p for p in b03['proposals'] if p.get('chain') == '1a' and p['op'] == 'create_road')
fork_road = short(roads, 'fdb059c4'); bottom = nodes[short(nodes, '4f294196')]
c = a14['coordinates']
fr = roads[fork_road]['coordinates']
# top joins the existing fork road by reference (its stored height), bottom joins node 4f294196; heights between run evenly
z_top = fr[0][2]; z_bot = bottom['coordinate'][2]
plan = [c[1], c[2], c[3], c[4]]
pts = [fr[0][:2]] + [q[:2] for q in plan] + [bottom['coordinate'][:2]]
cum = [0.0]
for i in range(1, len(pts)): cum.append(cum[-1] + math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
mid = [{'xy': [q[0], q[1]], 'z': round(z_top + (z_bot - z_top) * cum[i + 1] / cum[-1], 2)} for i, q in enumerate(plan)]
ops = [{'ref': 'B06-A14', 'op': 'create_road', 'grade': a14['grade'],
        'args': {'roadClass': 'pedestrian', 'structure': 'stairs', 'name': '갈림 지점 ~ 문예관 옆 오르막 위 끝 내려가는 길 (사용자 그림, 위치·높이 추정)',
                 'path': [{'at': {'roadId': fork_road, 'nearest': c[0][:2]}}] + mid + [{'at': {'nodeId': bottom['id']}}], 'zMode': 'explicit', 'densify': False},
        'deviation': f"제안 높이(S-MAP {c[0][2]}→{c[-1][2]} m) 대신 양 끝이 붙는 기존 길의 저장 높이({z_top}→{z_bot} m)를 썼다. 위 끝은 제안 점에서 가장 가까운 fdb059c4 위의 점"}]
groups.append({'id': 'E', 'title': '갈림 지점에서 오르막 위 끝으로 내려가는 길(사슬 1a)', 'comment': 'N01-E 갈림 지점~오르막 위 끝 (근거: 실험 E03 B06 갱신, 사용자 그림 사진 10)', 'evidence': 'B06(b03/network.json chain 1a)', 'ops': ops})

# ---- F: field access (split at 혜인관 door front, four stairs) ----
ops = []
e10ops = {o['id']: o for o in e10['operations']}
sp = e10ops['E10-2']; r = roads[sp['args']['roadId']]
ops.append({'ref': 'E10-2', 'op': 'split_road', 'grade': '원천(학교 표지) + 확정(운동장 높이 문 = B1)',
            'args': {'roadId': r['id'], 'expectedRevision': r['revision'], 'nearest': sp['args']['nearest']},
            'deviation': f"제안의 expectedRevision 1 대신 지금 값 {r['revision']} (T05에서 확인된 문제)"})
names = {'AP-DAEIL-FRONT': '대일관 현관 앞 계단 (13단쯤, 위치·높이 추정)', 'AP-SANGSEUNG-STAIR-L': '상승관 왼쪽 계단 (사용자 그림, 위치·높이 추정)',
         'AP-SANGSEUNG-STAIR-R': '상승관 오른쪽 계단 (사용자 그림, 위치·높이 추정)', 'AP-HANLIM-6F': '한림관 6층 ~ 운동장 높이 계단 (6칸쯤, 위치 추정)'}
for s in e10ops['E10-5']['stairs']:
    up = s['upperM']; dev = None
    if isinstance(up, list): up, dev = up[0], f"위 끝 높이가 범위({up[0]}~{up[1]} m)로만 있어 그 자리 S-MAP 지면 {up[0]} m를 썼다"
    lo, hi = s['lowerXY'] + [s['lowerM']], s['upperXY'] + [up]
    op = ped('E10-5 ' + s['accessPoint'], 'stairs', names[s['accessPoint']], [lo, hi], s['grade'])
    if dev: op['deviation'] = dev
    ops.append(op)
groups.append({'id': 'F', 'title': '운동장 면 접근: 혜인관 문 앞에서 길 자르기, 계단 4개', 'comment': 'N01-F 운동장 면 접근점과 계단 (근거: 실험 E10 운동장을 면으로, B09 갱신)', 'evidence': 'E10·B09', 'ops': ops})
skip('E10-1', 'e10/editor-ops.json', '운동장 면은 T05에서 이미 만들어져 있음')
skip('E10-3', 'e10/editor-ops.json', '운동장 구간 보관 처리는 사용자 결정 필요(C02 수집 경로). 길찾기에는 필요 없음')
skip('E10-4', 'e10/editor-ops.json', '문 좌표가 학교 표지뿐이고 붙일 길이 없어 노드를 만들 수 없음')

# ---- not applied from b03 ----
for p in b03['proposals']:
    if p['building'] == '북악관' and not p.get('b08Id'): skip(f"b03 {p['op']} 북악관 {p.get('toLabel') or p.get('chain') or ''}".strip(), 'b03/network.json', '북악관 층·B1: 이번에 하지 않음(B10 진행 중)')
skip('b03 relabel_level 유담관 9층 / 13층·15층, 대일관 1층, 문예관 3층 / 1층(추정)', 'b03/network.json', '제안에 층 이름만 있고 levelId 값·형식이 없다. levelId를 바꾸면 이웃 길과 노드를 함께 못 써 끊길 수 있다. 층 체계는 B10에서 다시 정하는 중')
skip('b03 shift_z 대일관 9a3cce3f +6.0', 'b03/network.json', '이 길만 올리면 양 끝의 이웃 길 1f32cde9·19800cee(145.80 m, 높이 미정)에 6 m 단이나 가짜 경사가 생긴다. 붙는 새 길도 없다')
skip('b03 shift_z 대일관 앞 실외 계단 5개 / 사슬 1a·2b 5개', 'b03/network.json', '제안에 옮길 값이 없음(끝점별로 다시 정해야 함)')
skip('b03 shift_z 혜인관 -1.1', 'b03/network.json', '제안이 옮기지 않는 쪽을 권함(추정)')
skip('b03 rename_building_id 혜인관', 'b03/network.json', '시험용 DB 건물 id가 아직 건물5(이름만 혜인관). 건물 id 정리가 먼저')

os.makedirs(os.path.join(out_dir, 'groups'), exist_ok=True)
for g in groups: json.dump(g, open(os.path.join(out_dir, 'groups', f"{g['id']}.json"), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
plan = {'title': 'N01 시험용 DB 도로 적용 계획', 'database': 'campus-tracker-test-db (127.0.0.1:5544) only', 'stateBefore': os.path.basename(state_path),
        'order': [{'group': g['id'], 'title': g['title'], 'evidence': g['evidence'], 'comment': g['comment'],
                   'items': [{k: o[k] for k in ('ref', 'op', 'grade', 'deviation') if k in o} for o in g['ops']]} for g in groups],
        'skipped': skipped, 'notes': notes,
        'changeSets': 'apply_changes는 묶음 하나를 한 트랜잭션으로 저장하지만 변경 묶음(changeSet)은 작업마다 하나씩 생기고 설명 칸이 없다. 묶음별 설명과 id는 applied-*.json에 적는다'}
json.dump(plan, open(os.path.join(out_dir, 'plan.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('groups', [(g['id'], len(g['ops'])) for g in groups], 'skipped', len(skipped), 'notes', notes)
