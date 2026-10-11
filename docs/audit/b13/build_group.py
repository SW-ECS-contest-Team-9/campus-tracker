"""B13 혜인관: 길 변경 묶음을 만든다(시험용 DB 의 지금 상태에서 개정 번호를 읽는다). DB·네트워크 접근 없음.   python build_group.py <n02 state 파일>
쓰는 파일: groups/b13.json (적용은 apply.sh: n02.ts apply ... --commit, 시험용 DB 만).
바뀌는 것: 지하 1층 문 노드와 그 문으로 드는 길을 출입부 가운데로(가림벽의 북동쪽 문을 지나), 문 정면 건물 안 계단의 머리(발치와 지하 쪽 길은 그대로), 양쪽 현관 계단 둘과 1층 참 길, 1층 로비 문 장소, 장소 둘의 자리."""
import json, pathlib, sys
from frame import *
HERE = pathlib.Path(__file__).parent
st = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
road = {r['id'][:8]: r for r in st['roads']}; place = {p['id'][:8]: p for p in st['places']}
xy = lambda s, f: [round(float(v), 2) for v in P(C + s, -f)]          # 출입부 가운데 기준 s, 벽에서 운동장 쪽 f (안쪽은 음수)
pt = lambda s, f, z: {'xy': xy(s, f), 'z': z}
DOOR, STAIR_FOOT = '07c38541-4d1c-4619-8ca5-2c8e93dfe5ac', '79988154-51eb-4e57-bff2-a78064906646'
GND, B1, F1 = 149.0, 149.3, 153.4
EV = '건물 노트 혜인관 B13 절: 사용자 2026-10-12(계단은 양쪽, 가림벽이 더해짐), 사용자-혜인관-20261012/01, 사용자-학교전경-20261012/02·08, S-MAP 1 m 메시(출입부 덩어리 35~55 m·화단 틈 36.7~56.3 m), 학교 지하도 지도의 초록 점(44.7 m)'
G1 = '확정(운동장 높이 문 = 지하 1층, 문 정면 건물 안 계단), S-MAP(문 자리: 벽을 따라 46.5 m ±1.5), 추정(가림벽 문·안쪽 선)'
G2 = '확정(계단이 양쪽에 있고 위가 1층: 사용자 2026-10-12), S-MAP(바깥 끝 = 화단 끝), 추정(단 수·1층 153.4 m = 149.3 + 4.11)'
ops = []
def op(ref, name, args, grade, evidence=EV): ops.append({'ref': ref, 'op': name, 'args': args, 'grade': grade, 'evidence': evidence})
r = road['5aea9b42']
op('문 정면 건물 안 계단: 머리를 새 문 정면으로(발치 그대로)', 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'zMode': 'explicit', 'densify': False,
   'attrs': {'name': '혜인관 지하통로 계단 (지하 1층 문 정면, 건물 안. 혜인관 지하 1층 149.3 → 운동장 지하 1층 141.4 m, 높이 차 7.9 m·참과 둘째 구간 추정)'},
   'path': [{'at': {'nodeId': DOOR}}, pt(0, -1.4, B1), pt(0, -9.4, 145.35), {'xy': r['coordinates'][3][:2], 'z': 145.35}, {'at': {'nodeId': STAIR_FOOT}}]}, G1 + ', 추정(참의 길이: 발치를 U02 자리에 두어 참이 7.3 m 가 됨)')
r = road['8a7b6361']
op('운동장 ~ 가림벽 북동쪽 문 ~ 지하 1층 문', 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'zMode': 'explicit', 'densify': False,
   'attrs': {'name': '혜인관 입구(1) 운동장 ~ 가림벽 문 ~ 지하 1층 문 (운동장 높이 문 = B1층, 문 149.3 m. 문 자리는 출입부 가운데, 가림벽 문 자리 추정)'},
   'path': [{'at': {'roadId': road['bf2acf00']['id'], 'nearest': xy(3.1, 5.6)}}, pt(3.1, 5.1, GND), pt(0, 4.4, GND + 0.2), {'at': {'nodeId': DOOR}}]}, G1)
op('지하 1층 문 노드를 출입부 가운데로', 'move_node', {'nodeId': DOOR, 'to': pt(0, 1.6, B1)}, G1)
stair = lambda name: {'roadClass': 'pedestrian', 'structure': 'stairs', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'widthM': 2.6, 'name': name, 'zMode': 'explicit', 'densify': False}
op('현관 오른쪽 계단(운동장에서 볼 때, 남서쪽)', 'create_road', {**stair('혜인관 현관 오른쪽 계단 (운동장에서 볼 때. 화단 끝 149.0 → 1층 153.4 m, 26단 추정)'),
   'path': [{'at': {'nodeId': road['bf2acf00']['fromNodeId']}}, pt(-11.1, 2.9, GND), pt(-9.7, 1.9, GND), pt(-3.6, 1.9, F1)]}, G2)
op('현관 왼쪽 계단(운동장에서 볼 때, 북동쪽)', 'create_road', {**stair('혜인관 현관 왼쪽 계단 (운동장에서 볼 때. 화단 끝 149.0 → 1층 153.4 m, 26단 추정)'),
   'path': [{'at': {'roadId': road['4ee99835']['id'], 'nearest': xy(11.3, 5.2)}}, pt(11.1, 2.9, GND), pt(9.7, 1.9, GND), pt(3.6, 1.9, F1)]}, G2)
op('현관 1층 참(두 계단 머리 사이, 로비 문 앞)', 'create_road', {'roadClass': 'pedestrian', 'structure': 'ordinary', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'widthM': 2.6, 'zMode': 'explicit', 'densify': False,
   'name': '혜인관 현관 1층 참 (양쪽 계단 머리 사이, 1층 로비 문 앞 153.4 m. 높이 추정)', 'path': [pt(-3.6, 1.9, F1), pt(3.6, 1.9, F1)]}, G2)
op('장소: 1층 로비 문', 'create_place', {'name': '혜인관 1층 로비 문 (현관 계단 위)', 'category': 'building_entrance', 'buildingId': '혜인관',
   'description': 'B13. 운동장 쪽 현관의 양쪽 계단을 오르면 닿는 1층 로비 문. 높이 153.4 m(지하 1층 149.3 + 층고 4.11, 추정). 문 안쪽 길은 없다(옛 실내 길은 다시 걸어 기록할 때 잇는다). 근거 등급: 확정(계단 위가 1층), 추정(높이·문 자리)', 'position': pt(0, 0.3, F1)}, G2)
p = place['97652b58']
op('장소 혜인관 입구(1)을 문 자리로', 'update_place', {'id': p['id'], 'expectedRevision': p['revision'], 'position': pt(0, 1.6, B1),
   'description': 'N03, B13 에서 자리 옮김. 1층 로비와 B1층으로 갈 수 있음. 높이 149.3 m. 학교 표지는 (201218.7, 557213.7)이고 문은 벽을 따라 9.1 m 북동쪽(출입부 가운데, S-MAP). 근거 등급: 원천(층), S-MAP(자리·높이)'}, G1)
p = place['0f68bdf8']
op('장소 지하통로 입구: 혜인관을 새 계단 머리로', 'update_place', {'id': p['id'], 'expectedRevision': p['revision'], 'position': pt(0, -1.4, B1),
   'description': 'U03, B13 에서 자리 옮김. 학교 지하도 지도의 초록 점. 혜인관 입구(1) 문 정면, 건물 안 계단 머리(길 5aea9b42). 지도의 점과 3.0 m'}, G1)
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'b13.json').write_text(json.dumps({'id': 'B13', 'comment': 'B13: 혜인관 운동장 쪽 출입부를 가운데 자리로, 현관 계단 양쪽과 1층 참, 지하 1층 문·건물 안 계단 머리', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('ops', len(ops))
