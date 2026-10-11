"""U05: 지하 차도를 꺾지 않고 운동장 지하 1층으로(시험용 DB 변경 묶음). DB·네트워크 접근 없음.   python build.py
먼저: python ../u02/build_parts.py (평면·목·바깥 차로 → model.json), python ../u04/build.py (주차 칸·통로 면 → areas/b1.json, b2.json).
읽는 파일: ../u02/model.json. 쓰는 파일: groups/u05.json (적용은 apply.sh: n02.ts apply + u04/areas_put.py, 시험용 DB 에만).
근거: 사용자 2026-10-12 "원래대로면 여기에 지하차도에서 일직선으로 빠지는 곳이 있는데"(그림 05), 띄운 지하 2층 화면 위의 붉은 선(그림 07: 선 1 = 곧은 차로, 선 2 = 서쪽 벽 옆 고리), 학교 지하도 지도(점선이 주차장 북서 모서리로). 볼트 구역 노트 "운동장 아래 지하층과 지하 차도"(U05 절)."""
import json, pathlib
HERE = pathlib.Path(__file__).parent
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); AP = M['approach']; RP = M['ramp']; OUT = RP['outer']; ST = json.loads((HERE / 'strokes.json').read_text(encoding='utf-8'))
node = lambda i: {'at': {'nodeId': i}}
N_TOP, N_J0 = '55a87aa0-3b19-42fb-8efb-77416a22dc3e', 'd80020b1-22ec-4f3a-bf04-de8fe795da44'
EXT, RAMP = 'df83f454-f120-4dab-86d9-137e8da84dd0', 'e6373337-654a-4c35-81d2-48a2b456a0f4'   # 개정 번호(U04 뒤): 3, 4
EV = (f"사용자 2026-10-12: 주차장 북서 모서리에는 지하 차도에서 일직선으로 빠져 들어오는 곳이 있다(그림 05). 띄운 지하 2층 화면에 그린 붉은 선 1(그림 07)을 판 외곽으로 좌표에 맞춰 읽으면 "
      f"본관 옆 구간 위 끝을 지나는 한 직선과 {ST['line1']['rmsOffAxisM']} m(RMS)로 겹친다. 학교 지하도 지도의 점선 끝과는 축에서 {abs(AP['mapEndOffAxisM'])} m(좌표 맞춤 잔차 RMS {M['georefRmsM']} m 안). "
      f"U02 의 '운동장 서쪽 벽에서 28도 꺾어 17.9 m 평지'를 대신한다")
G = '확정(지하 1층으로 곧게 들어온다), 사용자 그림(위치: 붉은 선 1), 원천(주차장 북서 모서리), 추정(높이·경사)'
ops = [
 {'ref': '지하 차도 연장을 한 직선으로', 'op': 'update_road', 'grade': G, 'evidence': EV, 'args': {'id': EXT, 'expectedRevision': 3, 'zMode': 'explicit', 'densify': False,
   'attrs': {'name': f"지하 차도 연장 (문예관 지하 통로 갈림 ~ 내리막길 밑 ~ 운동장 지하 1층 북서 모서리의 목. 꺾임 없이 한 직선, 들머리까지 {AP['lengthM']} m 에 경사 {AP['gradePct']:.1f} %, 그 뒤 평지. 지하 1층 진입은 확정, 선은 사용자 그림)"},
   'path': [node(N_TOP), AP['entry'], node(N_J0)]}},
 {'ref': '지하 1층 들머리 노드를 축 위로', 'op': 'move_node', 'grade': G, 'evidence': EV + f". 들머리(운동장 서쪽 벽)에서 14 m 안, 통로 면 위", 'args': {'nodeId': N_J0, 'to': AP['junction']}},
 {'ref': 'U자 경사로 바깥 차로', 'op': 'create_road', 'grade': '사용자 그림(위치: 붉은 선 2 의 바깥 가닥), 추정(폭·갈리는 자리·오르내리는 방향)',
  'evidence': (f"사용자 2026-10-12 붉은 선 2(그림 07): 곧은 경사로 띠의 서쪽, 판 외곽 밖으로 나란한 가닥이 하나 더 있고 반원 섬 북쪽에서 한 가닥으로 만난다. 좌표에 맞춰 읽으면 바깥 가닥은 서쪽 벽 밖 "
               f"{ST['loop']['outerOffWallM']['min']}~{ST['loop']['outerOffWallM']['max']} m(가운데값 {ST['loop']['outerOffWallM']['median']} m). 은주1관 외곽이 벽 밖 3.2 m 라 가운데를 벽 밖 {abs(OUT['centreOffWallM'])} m 에 두었다. 높이는 안쪽 차로와 같다(경사 {RP['gradePct']} %)"),
  'args': {'roadClass': 'vehicle', 'name': f"운동장 지하 1층–지하 2층 U자 경사로 바깥 차로 (서쪽 벽 옆, 안쪽 차로와 나란히. {OUT['top']['z']} → {OUT['bottom']['z']} m. 있음·자리는 사용자 그림, 폭·갈리는 자리 추정)", 'structure': 'ramp', 'widthM': OUT['widthM'],
           'vehicleAccess': 'allowed', 'pedestrianAccess': 'prohibited', 'vehicleDirection': 'both', 'pedestrianDirection': 'unknown', 'path': [OUT['top'], OUT['mid'], OUT['bottom']], 'zMode': 'explicit', 'densify': False}},
]
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'u05.json').write_text(json.dumps({'id': 'U05', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U05: 지하 차도 연장을 꺾임 없는 한 직선으로 지하 1층 북서 모서리의 목까지, 들머리 노드를 축 위로, U자 경사로의 바깥 차로', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), AP['entry'], AP['junction'])
