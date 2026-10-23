"""D23 시험용 DB 변경 묶음: 대일관 앞 데크 길을 새 데크(파랑 1 ~ 파랑 2) 가운데 선으로 옮긴다. DB 는 읽기만(docker psql).
  python -I -B build_group.py -> groups/d23-deck-roads.json
적용: C:\\campus-tracker-testdb\\backend 에서 npx tsx ../docs/audit/n02/n02.ts apply ../docs/audit/d23/groups/d23-deck-roads.json <결과> --commit (시험용 DB 만).
근거: 볼트 건물 노트 대일관 "D23 데크·화단 구분선 다시 놓기" 절, 구조물 d23/build_parts.py."""
import json, pathlib, subprocess, importlib.util
HERE = pathlib.Path(__file__).parent
sp = importlib.util.spec_from_file_location('z02common', HERE.parent / 'z02' / 'common.py'); Z = importlib.util.module_from_spec(sp); sp.loader.exec_module(Z)
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
def road(prefix):
    (rid, rev, a, b), = q(f"select id, revision, from_node_id, to_node_id from mobility.road_segments where status='DRAFT' and id::text like '{prefix}%'"); return rid, int(rev), a, b
uv = lambda u, v: [round(float(c), 2) for c in Z.uv_to_xy(u, v)]
BL = json.loads((HERE / 'blue_lines.json').read_text(encoding='utf-8'))['lines']
def line(k):
    (u0, v0), (u1, v1) = BL[k]['uv']; return lambda u: v0 + (u - u0) * (v1 - v0) / (u1 - u0)
b1, b2 = line(0), line(1)
mid = lambda u: (b1(u) + b2(u)) / 2 if u <= 40.0 else (1.67 + b2(u)) / 2   # u 40.1 동쪽은 벽(v 1.67) ~ 파랑 2
ZD = 151.3
EV = '사용자 표시 사용자표시-대일관-데크-화단-구분선.webp(파란 선 셋, 2026-10-23), 구조물 z02-daeil-front(D23 고침, docs/audit/d23)'
GR = '확정(데크 = 파랑 1 ~ 파랑 2: 사용자 표시), 추정(가운데 선 ±1 m, 높이 151.3 그대로)'
w, wr, wa, wb = road('b94cdc87'); e, er, ea, eb = road('88537fed'); d, dr, da, db = road('53962aa5')
assert wb == ea == da, '입구(2) 갈림 노드가 셋에 같지 않음'
U_DOOR = 31.5
ops = [
    {'ref': '입구(2) 갈림 노드(데크 길 둘·문 길): 데크 가운데 선으로', 'op': 'move_node', 'args': {'nodeId': wb, 'to': {'xy': uv(U_DOOR, mid(U_DOOR)), 'z': ZD}}, 'grade': GR, 'evidence': EV},
    {'ref': '데크 동쪽 끝 노드 110c17e5: 데크 끝(u 49.4) 가운데로', 'op': 'move_node', 'args': {'nodeId': eb, 'to': {'xy': uv(49.4, mid(49.4)), 'z': ZD}}, 'grade': GR, 'evidence': EV},
    {'ref': '데크 길 서쪽: 현관 쪽 이음(v 1.25)에서 u 10.75 로 꺾어 데크 가운데 선으로', 'op': 'update_road', 'args': {'id': w, 'expectedRevision': wr + 1, 'zMode': 'explicit', 'densify': False,
        'vertexOps': [{'op': 'insert', 'index': 0, 'point': {'xy': uv(10.75, 1.25), 'z': ZD}}, {'op': 'insert', 'index': 1, 'point': {'xy': uv(10.75, mid(10.75)), 'z': ZD}}]}, 'grade': GR, 'evidence': EV},
    {'ref': '데크 길 동쪽: 가운데 꼭짓점 둘을 벽 꺾임(u 40.1) 가운데 하나로', 'op': 'update_road', 'args': {'id': e, 'expectedRevision': er + 2, 'zMode': 'explicit', 'densify': False,
        'vertexOps': [{'op': 'replaceRange', 'index': 1, 'toIndex': 2, 'path': [{'xy': uv(40.1, mid(40.1)), 'z': ZD}]}]}, 'grade': GR, 'evidence': EV},
]
out = {'id': 'D23-DECK-ROADS', 'comment': 'D23 대일관 앞 데크 길을 사용자 파란 구분선 사이 데크 가운데로(시험용 DB 만)', 'ops': ops}
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'd23-deck-roads.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), 'ops')
