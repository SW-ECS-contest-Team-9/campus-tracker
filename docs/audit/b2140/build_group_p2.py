"""B2140-P2(2026-10-23 사용자 정정): 정문 옆 아래 주차장 = "2주차장"(현장 표지판 P2). 1주차장 = 운동장 지하(P1 터널로 들어감).
시험용 DB 의 "하단 주차장 …" 길·장소 이름을 2주차장으로. DB 는 읽기만.   python -I build_group_p2.py -> groups/b2140-p2.json"""
import json, pathlib, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
EV = '사용자 정정 2026-10-23: 정문 옆 아래 주차장 = 2주차장(현장 표지판 P2), 1주차장 = 운동장 지하(P1 터널). 볼트 구역 노트 운동장 아래 지하층과 지하 차도'
def ren(n):
    n = n.replace('표지판 "P2"', '현장 표지판 P2')
    for a, b in (('하단 주차장 차로', '2주차장 차로'), ('하단 주차장', '2주차장'), ('제1주차장', '2주차장'), ('제2주차장', 'P1 입구')):
        n = n.replace(a, b)
    return n
ops = []
for rid, rev, name in q("select id, revision, name from mobility.road_segments where status='DRAFT' and (name like '%하단 주차장%' or name like '%제1주차장%' or name like '%제2주차장%')"):
    ops.append({'ref': f'길 {rid[:8]} 이름', 'op': 'update_road', 'args': {'id': rid, 'expectedRevision': int(rev), 'zMode': 'explicit', 'densify': False, 'attrs': {'name': ren(name)}}, 'grade': '확정(이름: 사용자)', 'evidence': EV})
(pid, rev), = q("select id, revision from mobility.places where id::text like 'c57c4918%'")
ops.append({'ref': '장소 c57c4918 → 2주차장 입구', 'op': 'update_place', 'args': {'id': pid, 'expectedRevision': int(rev), 'name': '2주차장 입구 (현장 표지판 P2)',
            'description': '정문 안쪽 서편 아래 주차장 입구. 사용자 정정 2026-10-23: 2주차장(현장 표지판 P2). 옛 이름(학교 표지 "제1주차장 출입구")은 쓰지 않음'}, 'grade': '확정(사용자)', 'evidence': EV})
(HERE / 'groups' / 'b2140-p2.json').write_text(json.dumps({'id': 'B2140-P2', 'comment': '정문 옆 아래 주차장 = 2주차장(시험용 DB 만)', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
for o in ops: print(o['ref'], o['args'].get('attrs', {}).get('name', o['args'].get('name')))
