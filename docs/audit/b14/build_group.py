"""B14 상승관: 길 변경 묶음(시험용 DB 의 지금 상태에서 개정 번호를 읽는다). DB·네트워크 접근 없음.   python build_group.py <n02 state 파일>  -> groups/b14.json
바뀌는 것: 상승관 입구 노드와 장소를 새 벽(안쪽 마당에 면한 동쪽 끝 덩어리의 벽) 가운데로, 안쪽 마당 길의 끝을 그 문으로. 문 자리는 여전히 추정이다."""
import json, pathlib, sys
from shapely.geometry import LineString, shape
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
st = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')); P = json.loads((HERE / 'parts.json').read_text(encoding='utf-8'))
road = {r['id'][:8]: r for r in st['roads']}; place = {p['id'][:8]: p for p in st['places']}; node = {n['id'][:8]: n for n in st['nodes']}
DOOR = P['door']; Z = 153.1
pt = lambda xy: {'xy': [round(float(xy[0]), 2), round(float(xy[1]), 2)], 'z': Z}
MID = [[201214.35, 557291.77], [201216.6, 557298.6], [201219.4, 557304.2]]   # 안쪽 마당 가운데를 따라(대일관 동쪽 끝 벽과 청운관 서쪽 모서리 사이)
yard = shape(next(f for f in json.loads((REPO / 'frontend/public/structures/z02-daeil-front.geojson').read_text(encoding='utf-8'))['features'] if f['properties']['id'] == 'Z02-PLATFORM-YARD')['geometry'])
r = road['fd1fee86']; n = node['f953d0bb']; p = place['a96fdae7']
line = LineString([r['coordinates'][0][:2], *MID, DOOR]); assert line.difference(yard.buffer(0.05)).length < 0.2, line.difference(yard.buffer(0.05)).length   # 길이 마당 기단 밖(건물 안)으로 나가지 않는다(계단 머리 노드가 기단 가장자리에 있어 0.1 m 쯤은 걸친다)
EV = '건물 노트 상승관 B14 절: S-MAP 건물 모델 0.5 m 격자(2026-10-12), 사용자 2026-10-12(상승관은 이웃과 거의 틈이 없다), 사용자 그림 07·13(상승 표시가 안쪽 마당 북쪽 끝)'
G = '확정(안쪽 마당을 지나 상승관으로: 사용자 그림), S-MAP(벽 선·마당 높이 153.1 m), 추정(문이 이 벽에 있는지, 문 자리)'
ops = []
if abs(n['coordinate'][0] - DOOR[0]) > 0.05 or abs(n['coordinate'][1] - DOOR[1]) > 0.05:
    ops.append({'ref': '안쪽 마당 길의 끝을 새 문 자리로', 'op': 'update_road', 'grade': G, 'evidence': EV, 'args': {'id': r['id'], 'expectedRevision': r['revision'], 'zMode': 'explicit', 'densify': False,
                'attrs': {'name': '안쪽 마당 (153.1 m) → 상승관 입구(추정 위치: 마당에 면한 동쪽 끝 덩어리의 벽 가운데)'}, 'path': [{'at': {'nodeId': r['fromNodeId']}}, *[pt(q) for q in MID], {'at': {'nodeId': n['id']}}]}})
    ops.append({'ref': '상승관 입구 노드를 새 벽 위로', 'op': 'move_node', 'grade': G, 'evidence': EV, 'args': {'nodeId': n['id'], 'to': pt(DOOR)}})
    ops.append({'ref': '장소 상승관 입구를 새 벽 위로', 'op': 'update_place', 'grade': G, 'evidence': EV, 'args': {'id': p['id'], 'expectedRevision': p['revision'], 'position': pt(DOOR),
                'description': 'N03, B14 에서 자리 옮김(3.0 m). 1층 로비. 높이 153.1 m. 안쪽 마당에 면한 벽은 동쪽 끝 덩어리의 대일관 쪽 벽 5.9 m 뿐이라 그 가운데에 둠(S-MAP 0.5 m 격자). 근거 등급: 추정(위치: 문이 이 벽에 있는지 확인 못 함), S-MAP(높이·벽 선)'}})
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'b14.json').write_text(json.dumps({'id': 'B14', 'zone': '대일관 정면과 운동장 북쪽 가장자리', 'comment': 'B14: 상승관 입구(추정)를 새 외곽의 마당 쪽 벽 가운데로, 안쪽 마당 길의 끝을 그 문으로', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('ops', len(ops), 'path length', round(line.length, 2))
