"""X40 항목 7 시험용 DB 변경 묶음: 유리 연결 통로 → 남쪽 문 → 중간 옥상 마당. DB 는 읽기만.   python -I -B build_group_yard.py -> groups/x40-roads-c.json
(build_group.py 의 묶음 a·b 를 적용한 뒤에 만듦. 근거: 건물 노트 본관 X40 절)"""
import json, pathlib, subprocess
HERE = pathlib.Path(__file__).parent
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
(nid,), = q("select id from mobility.network_nodes where id::text like 'ebb31930%'")
base = {'roadClass': 'pedestrian', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'zMode': 'explicit', 'densify': False}
ops = [{'ref': '유리 연결 통로 가운데 → 남쪽 문 → 옥상 마당', 'op': 'create_road', 'args': {**base, 'name': '본관–한림관 유리 연결 통로 남쪽 문 → 중간 옥상 마당 (137.8 m 평지, 문턱만: 사진 15)', 'structure': 'ordinary', 'widthM': 1.2,
    'path': [{'at': {'nodeId': nid}}, {'xy': [201098.05, 557300.95], 'z': 137.8}, {'xy': [201097.4, 557298.4], 'z': 137.8}]},
    'grade': '확정(마당이 남쪽 문 밖: 사용자·사진 15), 추정(선)', 'evidence': '사진 15, 사용자 항공 항공-카카오-한림관-중간옥상.webp, 구조물 X22-ROOF-YARD·X22-LINK-DOOR-S'}]
(HERE / 'groups' / 'x40-roads-c.json').write_text(json.dumps({'id': 'X40-ROADS-C', 'comment': 'X40 항목 7 중간 옥상 마당 길(시험용 DB 만)', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops))
