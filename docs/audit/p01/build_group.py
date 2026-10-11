"""P01 길 변경 묶음: 유담관 입구를 아치 건물 맨 남쪽 문으로, 본관 모서리 앞 계단의 머리를 본관 서쪽 끝 흰 돌 아치(입구(2))로.   python build_group.py STATE.json  -> groups/p01.json
STATE.json = n02.ts state 가 쓴 파일(전체 id 와 개정 번호를 거기서 읽는다). 시험용 DB 에만 적용한다(apply.sh)."""
import json, pathlib, sys
import build_parts as B
HERE = pathlib.Path(__file__).parent
st = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
road = lambda p: next(r for r in st['roads'] if r['id'].startswith(p)); node = lambda p: next(n for n in st['nodes'] if n['id'].startswith(p)); place = lambda p: next(n for n in st['places'] if n['id'].startswith(p))
pt = lambda xy, z: {'xy': [round(float(xy[0]), 2), round(float(xy[1]), 2)], 'z': z}
A12 = '데이터/보완자료/3d-map-audit-20261009/사용자-회차공간서쪽-유담관아케이드-20261012/12-거리뷰화면-사용자표시-유담관입구.webp'
S23 = '데이터/보완자료/3d-map-audit-20261009/사용자-네이버거리뷰-20261012/23-사용자표시-지하통로입구-흰아치-빨간전화부스옆.webp'
SILL = B.SILL; walk_n, walk_s, foot = B.AP(7 * B.BAY, 1.1), B.AP(0.5 * B.BAY, 1.1), B.AP(7 * B.BAY, 3.3)
ops = []
def op(ref, name, args, grade, evidence): ops.append({'ref': ref, 'op': name, 'args': args, 'grade': grade, 'evidence': evidence})
GA = '확정(맨 남쪽 아치 문 = 유담관 입구: 사용자 표시), S-MAP(벽 선), 추정(문 자리 ±2 m, 문턱 131.2 m)'
op('유담관 입구 문 노드를 아치 건물 맨 남쪽 문으로', 'move_node', {'nodeId': node('6404f1ee')['id'], 'to': pt(B.ENTRANCE, SILL)}, GA, f'{A12}: 사용자가 맨 남쪽 아치 문에 동그라미를 치고 "유담관 입구". 전 자리 (201019.59, 557301.53)에서 13.2 m. 두 C01 기록의 들어간 높이 131.27 m 와 문턱 131.2 m 가 맞는다')
op('가운데 문 앞 단 위(걷는 단의 북쪽 머리)', 'move_node', {'nodeId': node('6aef72a9')['id'], 'to': pt(walk_n, SILL)}, '추정(자리), 원천(벽 발치의 돌 단과 문 앞 두세 단: 사진 09·그림 12)', '야외 접근 길의 끝을 가운데 아치 문 앞 단 위로: 여기서 벽 발치의 돌 단(131.2 m)을 따라 남쪽으로 맨 남쪽 문까지 간다(입구 앞 흰 돌 화단을 돌아 들어감)')
r = road('fc50ca50'); op('야외 접근 길을 가운데 문 앞 단 발치로', 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'zMode': 'explicit', 'densify': False, 'vertexOps': [{'op': 'move', 'index': 1, 'point': pt(foot, 130.6)}]}, '추정(선)', '회차 공간 포장면(130.6 m)에서 문 앞 두 단을 올라 돌 단(131.2 m)으로')
r = road('1d983e3a'); op('유담관 입구 앞 걷는 단', 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'zMode': 'explicit', 'densify': False, 'attrs': {'name': '유담관 입구 앞 걷는 단 (아치 건물 벽 발치의 돌 단 131.2 m, 가운데 문 앞 ~ 맨 남쪽 아치 문. 선 추정)', 'structure': 'ordinary'}, 'vertexOps': [{'op': 'insert', 'index': 0, 'point': pt(walk_s, SILL)}]}, GA, f'{A12}: 입구 앞의 굽은 흰 돌 화단을 돌아 벽을 따라 맨 남쪽 문으로 들어간다. 전에는 실내 복도로 적혀 있었다(문 자리를 몰랐음)')
r = road('699d0cbc'); op('유담관 입구 안 계단·복도 이름', 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'attrs': {'name': '유담관 입구(아치 문) 안 ~ 9층 승강기 홀 (문 안 8단쯤 내려감, 단차 1.8 m. 안쪽 선은 모름: 한 선으로 줄임)'}}, '원천(문 안 8단쯤 아래가 9층 홀: 학교 지하도 안내 글 사진 19), 추정(안쪽 선)', '문 노드가 옮겨져 이 길은 문에서 9층 홀까지의 한 선이 된다(길이 24 m 쯤). 계단의 실제 자리는 문 바로 안이다')
p = place('4ad25e9e'); op('지하통로 입구(버스 정류장 옆) 표지: 자리는 학교 지도의 점 그대로, 설명만', 'update_place', {'id': p['id'], 'expectedRevision': p['revision'], 'description': 'U03·P01. 학교 지하도 지도의 초록 점(지도를 좌표로 옮기면 (201020.7, 557296.7), 잔차 RMS 3.3 m. 이 표지와 4.9 m). 사용자가 표시한 유담관 입구(아치 건물 맨 남쪽 아치 문, (201009.3, 557309.8))와는 17.3 m 떨어져 있다: 같은 문인지 모른다(점은 아치 건물 남쪽의 높은 돌 덩어리 옆). 길은 유담관 입구 문에 잇는다'}, '원천(학교 지도의 점), 추정(자리)', '학교 지하도 지도(docs/audit/u02/georef.py)')
op('유담관 입구 표지(아치 문)', 'create_place', {'name': '유담관 입구 (회차 공간 서쪽 아치 건물의 맨 남쪽 아치 문, 9층 쪽)', 'category': 'building_entrance', 'buildingId': '유담관', 'description': 'P01. 사용자 표시 2026-10-12(거리뷰 화면에 동그라미와 "유담관 입구"). 문턱 131.2 m(추정), 안으로 8단쯤 내려가면 9층 승강기 홀(학교 지하도 안내 글). 자리 ±2 m', 'position': pt(B.ENTRANCE, SILL)}, GA, A12)
GB = '확정(본관 서쪽 끝 발치의 흰 돌 아치 = 본관 쪽 지하통로 입구: 사용자 2026-10-12 "맞음"), 원천(자리 = 학교 표지 본관 입구(2): 지하주차장과 2층으로 연결), 추정(문 자리 ±2 m, 안쪽 계단 선)'
op('본관 모서리 앞 계단의 머리를 흰 돌 아치 문으로', 'move_node', {'nodeId': node('e13a5ce2')['id'], 'to': pt(B.PORCH_DOOR, 130.7)}, GB, f'{S23}: 본관 서쪽 끝 발치의 흰 돌 아치(번호판 2115, 빨간 전화 부스 옆). 학교 표지 본관 입구(2) (201041.5, 557338.5)에서 1.7 m. 전 자리 (201040.8, 557342.0)에서 3.9 m')
op('본관 입구(2) 문 앞 노드를 아치 앞 포장면으로', 'move_node', {'nodeId': node('438353e0')['id'], 'to': pt(B.PORCH_FRONT, 130.75)}, GB, '아치 문 앞 2 m(회차 공간 포장면)')
r = road('e996a8f7'); op('본관 모서리 앞 계단 이름', 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'attrs': {'name': '본관 입구(2) 흰 돌 아치 ~ 본관 2층 유리문 앞 계단 (지상 130.7 → 128.5 m. 아치 안으로 내려감, 안쪽 선·단 수 추정)'}}, GB, '확정(사용자 2026-10-12): 2층 유리문 옆 "셔틀 정류장" 계단 = 지하 횡단보도로 내려가는 계단. 그 계단이 지상으로 나오는 곳이 이 아치다(사용자 2026-10-12 확정)')
p = place('877883d0'); op('지하통로 입구(본관) 표지를 흰 돌 아치로', 'update_place', {'id': p['id'], 'expectedRevision': p['revision'], 'position': pt(B.PORCH_DOOR, 130.7), 'description': 'P01. 본관 쪽 지하통로 입구 = 본관 서쪽 끝 발치의 흰 돌 아치(검은 차양, 번호판 2115, 빨간 전화 부스 옆): 사용자 확정 2026-10-12. 아치 안 계단을 내려가면 본관 2층 유리문 앞(128.5 m): 본관 2층 복도, 유담관 7층 가는 지하통로, 북악관 지하 1층 가는 지하 횡단보도가 갈린다. 학교 지하도 지도의 초록 점(좌표로 옮기면 (201045.1, 557340.2), 잔차 RMS 3.3 m)과 5.6 m. 전 자리(유리문 앞 (201041.1, 557347.7))에서 9.6 m'}, GB, S23)
ops.sort(key=lambda o: {'update_road': 0, 'move_node': 1}.get(o['op'], 2))   # 길 고치기 먼저(노드를 옮기면 그 길의 개정 번호가 오른다)
out = {'id': 'P01', 'zone': '북악관 앞 회차 공간과 본관 앞', 'comment': 'P01: 유담관 입구를 아치 건물 맨 남쪽 문으로, 본관 모서리 앞 계단 머리를 본관 서쪽 끝 흰 돌 아치로', 'ops': ops}
(HERE / 'groups').mkdir(exist_ok=True); (HERE / 'groups' / 'p01.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(len(ops), 'ops')
