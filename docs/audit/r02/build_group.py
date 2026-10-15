"""R02: 오르막길 윗구간 길(8e71c240)을 꺾인 차로 가운데로 옮기는 변경 묶음. DB 는 읽기만(docker psql).  python -X utf8 build_group.py
가운데 꼭짓점(s 84.9)을 t 1.2 → 3.2 로, s 95 에 t 3.6 꼭짓점 하나 넣음(옛 선은 s 88~103 에서 새 옹벽 밖 화단 위로 나감). 양 끝 노드는 그대로."""
import sys, json, subprocess, pathlib
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE.parent / 'g02')); from common import st_to_xy, way_z
def q(sql): return subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()
rid, rev, z1 = q("select id, revision, st_z(st_pointn(geom, 2)) from mobility.road_segments where status='DRAFT' and id::text like '8e71c240%'")[0].split('|')
pt = lambda s, t, z: {'xy': [round(float(c), 2) for c in st_to_xy(s, t)], 'z': round(float(z), 2)}
EV = '사용자 지적 2026-10-15(오르막길 윗부분이 꺾이며 좁아짐), S-MAP 메시 0.5 m(r02/st_relief.py), 구조물 g02-way.geojson G03-PAINT-LANE-2'
ops = [{'ref': '오르막길 윗구간 선을 꺾인 차로 가운데로(양 끝 노드 그대로)', 'op': 'update_road', 'args': {'id': rid, 'expectedRevision': int(rev), 'zMode': 'explicit', 'densify': False,
        'vertexOps': [{'op': 'move', 'index': 1, 'point': pt(84.9, 3.2, float(z1))}, {'op': 'insert', 'index': 2, 'point': pt(95.0, 3.6, way_z(95.0))}]}, 'grade': '추정', 'evidence': EV}]
(HERE / 'groups' / 'r02-1.json').write_text(json.dumps({'id': 'R02-1', 'comment': 'R02 오르막길 윗구간 길을 꺾인 차로 가운데로', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(rid, rev, z1)
