"""Q01: 층 사이 경사로의 굽은 구간을 섬(반지름 3.0 → 2.8 m, 중심 0.2 m 북서)에 맞춘다. 시험용 DB 변경 묶음을 만든다(적용은 n02.ts, 시험용 DB 에만). DB·네트워크 접근 없음.   python ramp.py <길 개정 번호>
먼저: python ../u02/build_parts.py, python ../u04/build.py, 다시 둘, python ../u04/pairs.py."""
import json, pathlib, sys
HERE = pathlib.Path(__file__).parent
RP = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8'))['ramp']
ROAD, CREST, TOE = '10fb4419-ROADID', '1ecd8d65-69d7-43bd-bf16-714e4cd30961', 'a918c7ee-df75-46d3-ab60-5d49490eedce'
ROAD = sys.argv[2]
EV = '사진 22: 섬과 긴 줄 사이 통로 5.5~6 m, 모델 4.1 m. 섬 반지름을 2.8 m 로 줄이고 중심을 0.2 m 북서로(경사로 쪽 벽 선·발치·낮은 벽은 제자리). 굽은 구간의 가운데 선과 마루만 따라 옮김. 20.0 m 에 3.5 m, 17.5 % 그대로'
path = RP['path']   # 마루 → 발치
ops = [
 {'ref': '경사로 마루 노드', 'op': 'move_node', 'grade': '추정(사진에서 잰 치수)', 'evidence': EV, 'args': {'nodeId': CREST, 'to': path[0]}},
 {'ref': '층 사이 경사로 선', 'op': 'update_road', 'grade': '추정(사진에서 잰 치수)', 'evidence': EV,
  'args': {'id': ROAD, 'expectedRevision': int(sys.argv[1]), 'zMode': 'explicit', 'densify': False, 'path': [{'at': {'nodeId': CREST}}, *path[1:-1], {'at': {'nodeId': TOE}}]}},
]
(HERE / 'groups' / 'q01-ramp.json').write_text(json.dumps({'id': 'Q01-RAMP', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'Q01: 층 사이 경사로의 굽은 구간을 줄인 섬(반지름 2.8 m)에 맞춤', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), 'ops')
