"""은주관 입구 상자(2026-10-22 사양) 시험용 DB 변경 묶음. DB 는 읽기만(docker psql).   python -I build_group_eunju_box.py -> groups/x22-eunju-box.json
길 7e2741ec(지하 1층 계단 참 4eebbb98 → 운동장)의 운동장 끝 노드 92516307 을 상자 북쪽 끝 참(201145.9, 557298.9, 148.9)으로 옮기고,
선을 지하 1층 참 → 상자 남쪽 끝(146.72) → 상자 안 북쪽 참 앞(148.9) → 참 으로(구조물 u02 U02-VOID-FIELD-STAIR·-BOX 와 같은 선).
적용: C:\\campus-tracker-testdb\\backend 에서 npx tsx ../docs/audit/n02/n02.ts apply ../docs/audit/x22/groups/x22-eunju-box.json <결과> --commit (시험용 DB 만)."""
import json, pathlib, subprocess, sys
import numpy as np
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
r2 = lambda v: round(float(v), 2)
(rid, rev, fn, tn), = q("select id, revision, from_node_id, to_node_id from mobility.road_segments where status='DRAFT' and id::text like '7e2741ec%'")
(top,), = q("select id from mobility.network_nodes where id::text like '92516307%'")
assert tn == top, (fn, tn)
SW = np.array([201143.02, 557291.74]); A = np.array([201144.40, 557300.13]) - SW; A /= np.hypot(*A); B = np.array([201146.96, 557291.09]) - SW; B /= np.hypot(*B)
SBN, P0, P1, LAND = np.array([201148.60, 557282.01]), SW + B * 2.0, SW + A * 6.8 + B * 2.0, np.array([201145.9, 557298.9])
Z_B1, Z_F = 143.5, 148.9
d0, d1 = np.hypot(*(P0 - SBN)), np.hypot(*(P1 - P0)); z0 = Z_F - (Z_F - Z_B1) * d1 / (d0 + d1)
EV = '은주관 입구 상자 사양(2026-10-22: 데이터/보완자료/학교-전경-20261022/확인/은주관-박스-탑다운-사양.png, 사용자 항공사진). 상자 안 북쪽 끝 148.9 참 → 남쪽으로 내려가는 계단 → 지하 1층 계단 참'
G = '확정(상자 안에서 내려간다: 영상·사용자), 원천(상자 자리: 사용자 항공사진 ±1.5 m), 추정(계단 선·높이)'
ops = [
    {'ref': '운동장 끝 노드 92516307 → 상자 북쪽 끝 참', 'op': 'move_node', 'args': {'nodeId': top, 'to': {'xy': [r2(LAND[0]), r2(LAND[1])], 'z': Z_F}}, 'grade': G, 'evidence': EV},
    {'ref': '길 7e2741ec: 지하 1층 참 → 상자 남쪽 끝 → 상자 안 북쪽 참', 'op': 'update_road', 'grade': G, 'evidence': EV,
     'args': {'id': rid, 'expectedRevision': int(rev) + 1, 'zMode': 'explicit', 'densify': False,
              'attrs': {'name': f'운동장 지하 1층 ~ 은주관 입구 상자 (지하 1층 참 143.5 → 상자 남쪽 끝 {z0:.2f} → 상자 안 북쪽 참 148.9 m, 높이 차 5.4 m. 상자는 사양·항공사진, 계단 선 추정)'},
              'vertexOps': [{'op': 'insert', 'index': 0, 'point': {'xy': [r2(P0[0]), r2(P0[1])], 'z': r2(z0)}},
                            {'op': 'insert', 'index': 1, 'point': {'xy': [r2(P1[0]), r2(P1[1])], 'z': Z_F}}]}},
]
(HERE / 'groups' / 'x22-eunju-box.json').write_text(json.dumps({'id': 'X22-EUNJU-BOX', 'comment': '은주관 입구 상자(사양): 길 7e2741ec 의 운동장 끝을 상자 안 북쪽 참으로(시험용 DB 만)', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), 'ops', r2(z0), r2(d0 + d1))
