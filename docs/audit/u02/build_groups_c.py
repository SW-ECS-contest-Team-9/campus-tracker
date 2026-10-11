"""U02c: U자 경사로를 학교 지도의 반원 표시 쪽으로 6 m 북쪽으로 옮긴다(U02·U02b 적용 뒤의 고침). DB 접근 없음.   python build_groups_c.py
읽는 파일: model.json(build_parts.py 의 마지막 값). 쓰는 파일: groups/u02c.json.
주의: groups/u02.json·u02b.json 은 섬 중심이 북좌표 557246 이던 때의 model.json 으로 만들어 적용한 것이다. build_groups.py 를 지금 다시 돌리면 그 두 파일이 마지막 값으로 바뀐다(적용한 원문은 볼트 u02 폴더의 a-05·b-05 파일)."""
import json, pathlib
HERE = pathlib.Path(__file__).parent
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8')); RP = M['ramp']; P = M['points']
node = lambda i: {'at': {'nodeId': i}}
N_J0, N_S0, N_RB = 'd80020b1-22ec-4f3a-bf04-de8fe795da44', 'fd002649-12f4-4346-8859-381f20c18af0', '89be4757-d080-42d9-a175-e1f39885b8f4'
LEAD, RAMP = '428a3aeb-2c54-4b78-9e3d-585548f75d74', 'e6373337-654a-4c35-81d2-48a2b456a0f4'   # 개정 번호: U02b 뒤 4, 1
EV = f"학교 캠퍼스맵 지하도 연결 지점(원천): 주차장 서쪽의 반원 표시. 학교 지도 위에 새 평면을 겹쳐 보니 U자의 굽은 구간이 표시보다 남쪽이었다. 섬 중심을 6 m 북으로(표시와 {RP['mapSymbolOffM']} m). 길이·경사는 그대로({RP['lengthM']} m, {RP['gradePct']} %)"
G = '확정(U자 경사로: 사용자 사진), 원천(자리: 지도의 반원 표시, 잔차 RMS 3.3 m), 추정(반지름·길이)'
ops = [
 {'ref': '지하 1층 차로(들머리 ~ 경사로 머리)', 'op': 'update_road', 'args': {'id': LEAD, 'expectedRevision': 4, 'zMode': 'explicit', 'densify': False, 'path': [node(N_J0), P['E1'], node(N_S0)]}, 'grade': G, 'evidence': EV},
 {'ref': 'U자 경사로', 'op': 'update_road', 'args': {'id': RAMP, 'expectedRevision': 1, 'zMode': 'explicit', 'densify': False, 'path': [node(N_S0)] + RP['arc'] + [RP['curveEnd'], node(N_RB)]}, 'grade': G, 'evidence': EV},
 {'ref': 'U자 경사로 머리 노드', 'op': 'move_node', 'args': {'nodeId': N_S0, 'to': RP['top']}, 'grade': G, 'evidence': EV},
 {'ref': 'U자 경사로 발치 노드', 'op': 'move_node', 'args': {'nodeId': N_RB, 'to': RP['bottom']}, 'grade': G, 'evidence': EV},
]
(HERE / 'groups' / 'u02c.json').write_text(json.dumps({'id': 'U02c', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U02c: U자 경사로를 지도의 반원 표시 쪽으로', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops))
