"""Z04: 시험용 DB 편집 묶음 B(길을 새 지형에 다시 얹기)를 만든다. DB 는 읽기만(docker psql 로 지금 개정 번호).  python build_groups.py -> <볼트>/z04/group-B.json
묶음 A(노드 높이)는 build_inputs.py 가 기단 윗면에서 만든다. 대상 길 목록은 relevel.json."""
import sys, subprocess, json; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import Z04, HERE
q = subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', "select id, revision from mobility.road_segments where status='DRAFT'"], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()
rev = {l.split('|')[0][:8]: l.split('|') for l in q}
D = json.loads((HERE / 'relevel.json').read_text(encoding='utf-8'))['drape']
ops = [{'ref': f'Z04 지형에 다시 얹기 {k}: {why}', 'op': 'update_road', 'args': {'id': rev[k][0], 'expectedRevision': int(rev[k][1]), 'drapeToTerrain': True}} for k, why in D.items() if k in rev]
(Z04 / 'group-B.json').write_text(json.dumps({'id': 'Z04-B', 'comment': 'Z04 새 기단 위에 놓인 바깥 길의 가운데 꼭짓점을 새 지형 높이로(끝 노드는 묶음 A 의 값 유지)', 'ops': ops}, ensure_ascii=False, indent=1), encoding='utf-8'); print('ops', len(ops))
