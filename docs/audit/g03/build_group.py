"""G03: 대일관에서 내려오는 계단의 길을 다시 만든 구조물(z02-daeil-front 의 Z02-SIDE-STAIR)에 맞추는 변경 묶음. DB 는 읽기만(docker psql).
  python build_group.py 1   -> groups/g03-1.json  노드 둘 옮김(계단 위·발치. 이어진 길 끝이 함께 옮겨진다)
  python build_group.py 2   -> groups/g03-2.json  계단 길의 참 꼭짓점·이름·폭, 발치에서 평탄부로 가는 길에 꼭짓점 하나(1 을 적용한 뒤의 개정 번호로 만든다)
끝점과 높이는 z02/model.json(구조물과 같은 정의)에서 온다."""
import sys, json, subprocess, pathlib
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE.parent / 'g02')); from common import st_to_xy, way_z
M = json.loads((HERE.parent / 'z02' / 'model.json').read_text(encoding='utf-8')); P, L, S = M['points'], M['levels'], M['stairs']['side']
def q(sql): return subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()
rev = {l.split('|')[0][:8]: (l.split('|')[0], int(l.split('|')[1])) for l in q("select id, revision from mobility.road_segments where status='DRAFT'")}
EV = '사용자 표시 사진(사용자-SP카페·대일관계단·3생활관-20261012/03 "대일")·영상 05, S-MAP 메시(s 96~110 에서 145.8 → 150.5 m). 구조물 Z02-SIDE-STAIR 와 같은 자리·높이'
TOP, FOOT = '0c2a31b0-969e-4e3f-94d2-dc976c0f33fd', '2ca531d8-4c94-48bc-a5ce-6a534ecbcaad'
if sys.argv[1] == '1':
    ops = [{'ref': '계단 위 노드: 넓은 계단의 가운데로', 'op': 'move_node', 'args': {'nodeId': TOP, 'to': {'xy': P['sideStairTop'], 'z': L['entrance']}}, 'grade': '추정', 'evidence': EV},
           {'ref': f"계단 발치 노드: 평탄부 145.5 m 가 아니라 그 동쪽 길 경사면 위({L['sideStairFoot']} m), 카페 데크 끝과 돌 화단 너머", 'op': 'move_node', 'args': {'nodeId': FOOT, 'to': {'xy': P['sideStairFoot'], 'z': L['sideStairFoot']}}, 'grade': '추정', 'evidence': EV}]
else:
    mid = [round(float(c), 2) for c in st_to_xy(93.3, 13.4)]
    name = f"대일관에서 내려오는 계단 (SP 카페 데크 끝 옆, {S['risers']}단 추정, {L['entrance']} → {L['sideStairFoot']} m, 넓은 돌계단·가운데 난간·가운데 참)"
    ops = [{'ref': '계단 길: 참의 두 꼭짓점, 이름, 폭 4.3 m', 'op': 'update_road', 'args': {'id': rev['f50b9ad8'][0], 'expectedRevision': rev['f50b9ad8'][1], 'zMode': 'explicit', 'densify': False, 'attrs': {'name': name, 'widthM': 4.3},
              'vertexOps': [{'op': 'move', 'index': 1, 'point': {'xy': P['sideStairLandingE'], 'z': P['sideStairLandingZ']}}, {'op': 'move', 'index': 2, 'point': {'xy': P['sideStairLandingW'], 'z': P['sideStairLandingZ']}}]}, 'grade': '추정', 'evidence': EV},
           {'ref': '발치 → 평탄부: 길 경사면을 따라 내려와 평탄부 동쪽 끝(s 93.3, 145.5 m)을 지남', 'op': 'update_road', 'args': {'id': rev['706a4384'][0], 'expectedRevision': rev['706a4384'][1], 'zMode': 'explicit', 'densify': False,
              'attrs': {'name': '대일관에서 내려오는 계단 아래 → 대일관 서쪽 끝 앞 평탄부(SP 카페 앞, 145.5 m) → 문예관 쪽 계단 위'}, 'vertexOps': [{'op': 'insert', 'index': 0, 'point': {'xy': mid, 'z': round(float(way_z(93.3)), 2)}}]}, 'grade': '추정', 'evidence': EV}]
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / f'g03-{sys.argv[1]}.json').write_text(json.dumps({'id': f'G03-{sys.argv[1]}', 'comment': 'G03 대일관에서 내려오는 계단의 길을 넓은 돌계단 구조물에 맞춤(발치를 6.5 m 동쪽 길 경사면 위로)', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(len(ops))
