"""U11: 층 사이 경사로를 사진에서 잰 치수로 다시(한 층 3.5 m), 지하 1층 북서쪽 세모 구역(주차관리센터·화장실·통로), 은주관 계단 어귀를 세모의 빗변으로. 시험용 DB 변경 묶음을 만든다. DB·네트워크 접근 없음.   python build.py
먼저: python ../u02/build_parts.py, python ../u04/build.py, 다시 둘(기둥은 주차 칸을 읽는다), python ../u04/pairs.py.
쓰는 파일: groups/u11.json (적용은 apply.sh, 시험용 DB 에만).
근거: 사용자 지적 2026-10-12(그림 28 "주차선 위치부터 다르잖아"), 사용자 확정 2026-10-12(그림 29: 세모 = 관리실·화장실·통로), 사진 13·20·21·22·23·24·26, 학교 지하도 지도. 볼트 구역 노트 "운동장 아래 지하층과 지하 차도"(U11 절)."""
import json, pathlib
HERE = pathlib.Path(__file__).parent
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); RP = M['ramp']; PT = M['points']; H = M['heights']
OLD = '5d998b18-ab5a-4497-9821-d60c937b5b86'   # U09 의 층 사이 경사로(개정 1)
N_DOOR, N_SBN = '8e608a71-5268-42d6-9fe9-b64eafda79e3', '4eebbb98-0e1a-4d7e-8458-86f5d5de0a97'
P_B2, P_DOOR = '551f3d72-de23-429a-9ed3-a655fd724933', '5f9c4ea7-95af-4142-968b-dc971bb98d6e'
pos = lambda k: {'xy': PT[k]['xy'], 'z': PT[k]['z']}
EV = (f"사용자 지적 2026-10-12(그림 28): 사진 23 에서 곧은 경사로 발치 바로 왼쪽이 주차 칸 줄인데 모델은 빈 통로. 사진 22·23·24·26 을 치수로 읽어 다시 놓음: 곧은 구간은 주차 줄과 나란히(한 줄 묶음 S04 의 북서 옆), 발치가 북동, "
      f"S04 남서 끝의 반원 섬을 왼쪽에 끼고 굽어 지하 1층에 오른다. 경사 {RP['gradePct']} %(사진 23 의 소실점·턱 선), 한 층 {RP['dropM']} m(기둥 2.9 m + 보 0.5 m), 길이 {RP['lengthM']} m. 지하 2층 바닥 {H['b2Floor']} m 는 사용자 붉은 선(133 m)에서 벗어난다(구역 노트 U11)")
EV2 = '사용자 확정 2026-10-12(그림 29): 지하 1층 북서쪽 세모는 주차관리센터·화장실·통로다. 간판 벽(사진 13·20·21)은 그 세모의 빗변(주차장 쪽 벽)이고, 은주관 간판 오른쪽의 계단 어귀 하나로 은주1관 3층(내려감)과 운동장(올라감)에 간다(사진 19·21)'
ops = [
 {'ref': '거둠: U09 층 사이 경사로', 'op': 'retire_feature', 'args': {'type': 'road', 'id': OLD, 'expectedRevision': 1}, 'grade': '확정(주차 칸과의 위치 관계가 틀림: 사용자 지적)', 'evidence': EV},
 {'ref': '층 사이 경사로(사진에서 잰 것)', 'op': 'create_road', 'grade': '확정(ㄴ자·발치 왼쪽이 주차 칸 줄), 원천(자리: 학교 지도의 S04 남서 끝·부채꼴, 잔차 RMS 3.3 m), 추정(치수: 사진에서 잼)', 'evidence': EV,
  'args': {'roadClass': 'vehicle', 'name': f"운동장 지하 1층–지하 2층 경사로 (곧은 {RP['straightM']} m + 섬을 끼고 굽은 {RP['arcM']} m. {RP['lengthM']} m 에 {RP['dropM']} m, {RP['gradePct']} %. 두 방향. 치수는 사진에서 잰 추정)",
           'structure': 'ramp', 'widthM': RP['clearWidthM'], 'vehicleAccess': 'allowed', 'pedestrianAccess': 'prohibited', 'vehicleDirection': 'both', 'pedestrianDirection': 'unknown', 'path': RP['path'], 'zMode': 'explicit', 'densify': False}},
 {'ref': '지하 2층 표지 높이', 'op': 'update_place', 'grade': '추정(사진에서 잰 한 층)', 'evidence': EV,
  'args': {'id': P_B2, 'expectedRevision': 2, 'position': pos('C2'), 'description': f"U11. 바닥 {H['b2Floor']} m = 지하 1층 바닥 - {RP['dropM']} m(사진 22·23·26 에서 잰 한 층, 범위 3.1~3.8 m). U02 의 133.0 m(사용자 붉은 선)에서 벗어남. 이름·표지 자리는 추정"}},
 {'ref': '은주관 문 노드를 계단 어귀로', 'op': 'move_node', 'grade': '확정(간판 벽 = 세모의 빗변), 추정(자리 ±1.5 m)', 'evidence': EV2, 'args': {'nodeId': N_DOOR, 'to': pos('DOOR')}},
 {'ref': '운동장 계단 발치를 어귀 안의 참으로', 'op': 'move_node', 'grade': '확정(어귀 하나: 사진 19·21), 추정(자리)', 'evidence': EV2, 'args': {'nodeId': N_SBN, 'to': pos('SBN')}},
 {'ref': '은주1관 지하통로 입구 표지', 'op': 'update_place', 'grade': '확정(간판 벽 = 세모의 빗변), 추정(자리 ±1.5 m)', 'evidence': EV2, 'args': {'id': P_DOOR, 'expectedRevision': 2, 'position': pos('DOOR')}},
]
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'u11.json').write_text(json.dumps({'id': 'U11', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U11: 층 사이 경사로를 사진에서 잰 치수로 다시(한 층 3.5 m), 은주관 계단 어귀를 세모 구역의 빗변으로', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), 'ops', len(RP['path']), 'points')
