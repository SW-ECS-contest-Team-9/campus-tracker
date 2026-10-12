"""B15 청운관 현관: 길 변경 묶음(시험용 DB 의 지금 상태에서 개정 번호를 읽는다). DB·네트워크 접근 없음.   python build_group.py <n02 state 파일>  -> groups/b15.json
바뀌는 것: 오른쪽 계단 길을 새 계단 위로(머리·발치 노드), 왼쪽 계단 길 거둠(사진에 없음), 안쪽 마당 계단 머리 → 첫 단 판 → 1층 현관 문 길을 새로(사용자 확정: 틈 없이 이어짐)."""
import json, pathlib, sys
HERE = pathlib.Path(__file__).parent
st = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')); PT = json.loads((HERE / 'porch-points.json').read_text(encoding='utf-8'))
road = {r['id'][:8]: r for r in st['roads']}; node = {n['id'][:8]: n for n in st['nodes']}
pt = lambda xy, z: {'xy': [round(float(xy[0]), 2), round(float(xy[1]), 2)], 'z': z}
F1, FIELD = 153.1, 148.9
EV = '건물 노트 청운관 B15 절: 사용자 2026-10-12(현관 왼쪽 첫 단은 옆 계단참과 틈 없이 이어짐), 사용자-청운관현관·은주1관돌계단-20261012/11·01'
G = '확정(첫 단 판이 계단참과 이어짐, 계단 위가 1층 현관), S-MAP(153.1 m), 추정(계단 양 끝 ±1 m: 사진 11 에서 잼)'
top, foot, door, yard = node['b0f5e9a7'], node['586a5572'], node['49f3b51c'], node['4beee7dc']
ops = []
if abs(top['coordinate'][0] - PT['stairTop'][0]) > 0.05:
    ops.append({'ref': '계단 머리 노드를 첫 단 판 동쪽 끝(셋째 기둥)으로', 'op': 'move_node', 'grade': G, 'evidence': EV, 'args': {'nodeId': top['id'], 'to': pt(PT['stairTop'], F1)}})
    ops.append({'ref': '계단 발치 노드를 새 발치로', 'op': 'move_node', 'grade': G, 'evidence': EV, 'args': {'nodeId': foot['id'], 'to': pt(PT['stairFoot'], FIELD)}})
    r = road['302b1bf9']
    ops.append({'ref': '오른쪽 계단 길', 'op': 'update_road', 'grade': G, 'evidence': EV, 'args': {'id': r['id'], 'expectedRevision': r['revision'], 'zMode': 'explicit', 'densify': False,
                'attrs': {'name': '청운관 현관 틀의 계단 (운동장 148.9 → 1층 현관 153.1 m, 곧은 한 줄, 26단 추정)'}, 'path': [{'at': {'nodeId': foot['id']}}, {'at': {'nodeId': top['id']}}]}})
    r = road['cf1f8612']
    ops.append({'ref': '1층 현관 길', 'op': 'update_road', 'grade': G, 'evidence': EV, 'args': {'id': r['id'], 'expectedRevision': r['revision'], 'zMode': 'explicit', 'densify': False,
                'attrs': {'name': '청운관 1층 현관 (계단 머리 ~ 1층 로비 문, 첫 단 판 153.1 m. 문 자리는 학교 표지)'}, 'path': [{'at': {'nodeId': top['id']}}, {'at': {'nodeId': door['id']}}]}})
    r = road['7e21d684']
    ops.append({'ref': '왼쪽 계단 길 거둠(사진 11 에 없음)', 'op': 'retire_feature', 'grade': '추정(사진 11·02 에 왼쪽 계단이 없다)', 'evidence': EV, 'args': {'type': 'road', 'id': r['id'], 'expectedRevision': r['revision']}})
    ops.append({'ref': '안쪽 마당 계단 머리 → 첫 단 판 → 1층 현관 문', 'op': 'create_road', 'grade': G, 'evidence': EV, 'args': {'roadClass': 'pedestrian', 'structure': 'ordinary', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'widthM': 2.5, 'zMode': 'explicit', 'densify': False,
                'name': '청운관 현관 첫 단 판 (대일관·청운관 사이 계단 머리 ~ 1층 로비 문, 153.1 m. 틈 없이 이어짐: 사용자 확정)', 'path': [{'at': {'nodeId': yard['id']}}, pt(PT['deckWest'], F1), pt(PT['deckMid'], F1), {'at': {'nodeId': door['id']}}]}})
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'b15.json').write_text(json.dumps({'id': 'B15', 'zone': '청운관 앞', 'comment': 'B15: 청운관 현관 틀의 계단을 오른쪽 한 줄로, 첫 단 판을 안쪽 마당 계단 머리와 이음', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('ops', len(ops))
