"""X36: 시험용 DB 변경 묶음(2026-10-23). DB 는 읽기만(docker psql).   python -I build_group.py -> groups/x36-roads.json
- 북악관·문예관 사이 계단 길(후보 가: 인도 → 아랫단 → 참 → 윗단 서 → 테라스 138.8). 발치는 오르막 보행로 aba83944 에 잇는다.
- 은주관 입구 상자 동면 옆 출입구 → 운동장(짧은 길): 상자 안 북쪽 참 노드 92516307 → 옆 출입구 → 문 밖 1.2 m(148.9)."""
import json, pathlib, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
def one(sql): r = q(sql); assert len(r) == 1, (sql, r); return r[0]
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8'))['x05']
base = {'roadClass': 'pedestrian', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'zMode': 'explicit', 'densify': False}
ops = []
rid, = one("select id from mobility.road_segments where status='DRAFT' and id::text like 'aba83944%'")
G5 = 'Claude 결정 2026-10-23(후보 가), 사진 06(꺾인 두 줄), 추정(선·단 수)'
EV5 = '사진 북악관-문예관-사이-오르막-계단.webp(사진 06), 구조물 x36-remaining X36-PODIUM-STAIR-*'
ops.append({'ref': '북악관·문예관 사이 계단', 'op': 'create_road', 'args': {**base, 'name': f"북악관·문예관 사이 계단 (오르막 인도 {M['footZ']} → 참 {M['landingZ']} → 서쪽으로 꺾어 문예관 기단 테라스 138.8 m, 아랫단 {M['risers'][0]}·윗단 {M['risers'][1]}단 추정)", 'structure': 'stairs', 'widthM': 2.4,
    'path': [{'at': {'roadId': rid, 'nearest': M['foot']}}, {'xy': M['foot'], 'z': M['footZ']}, {'xy': M['landing'], 'z': M['landingZ']}, {'xy': M['top'], 'z': 138.8}]}, 'grade': G5, 'evidence': EV5})
nid, = one("select id from mobility.network_nodes where id::text like '92516307%'")
GB = '확정(옆 출입구 있음: 영상 1 158 초·사양 그림), 추정(선, 밤에는 줄로 막힘)'
EVB = '은주관 입구 상자 사양(확인/은주관-박스-탑다운-사양.png), x22-photo-fixes X22-EUNJU-BOX-SIDEDOOR'
ops.append({'ref': '은주관 입구 상자 동면 옆 출입구 → 운동장', 'op': 'create_road', 'args': {**base, 'name': '은주관 입구 상자 안 북쪽 참 → 동면 옆 출입구 → 운동장 (148.9 m, 짧은 길. 밤에는 줄로 막힘)', 'structure': 'ordinary', 'widthM': 1.2,
    'path': [{'at': {'nodeId': nid}}, {'xy': [201147.5, 557298.55], 'z': 148.9}, {'xy': [201148.15, 557298.44], 'z': 148.9}, {'xy': [201149.4, 557298.24], 'z': 148.9}]}, 'grade': GB, 'evidence': EVB})
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'x36-roads.json').write_text(json.dumps({'id': 'X36-ROADS', 'comment': '북악관·문예관 사이 계단, 은주관 입구 상자 옆 출입구(시험용 DB 만)', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops))
