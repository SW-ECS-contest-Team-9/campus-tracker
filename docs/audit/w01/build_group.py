"""W01 길 변경 묶음(시험용 DB 의 지금 상태에서 개정 번호를 읽는다). DB·네트워크 접근 없음.   python -X utf8 build_group.py <n02 state 파일>  -> groups/w01.json
바뀌는 것: (1) 서문 터널 길의 시작 노드와 서문 표지를 새 문틀(사용자 표시 자리) 앞으로. (2) 유담관 3층 입구 앞 돌계단 길의 두 끝과 입구 표지를 건물 면에 다시 앉힌 계단에 맞춤(자리는 그대로: 0.5 m·2.0 m).
model.json(build_parts.py 가 씀)의 점을 읽는다. 바깥 공도에는 길 자료가 없다(보도 길을 새로 만들지 않는다)."""
import json, pathlib, sys
HERE = pathlib.Path(__file__).parent
st = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')); M = json.loads((HERE / 'model.json').read_text(encoding='utf-8'))
road = {r['id'][:8]: r for r in st['roads']}; node = {n['id'][:8]: n for n in st['nodes']}; place = {p['id'][:8]: p for p in st['places']}
pt = lambda p: {'xy': [round(float(p[0]), 2), round(float(p[1]), 2)], 'z': round(float(p[2]), 2)}
far = lambda a, b: abs(a[0] - b[0]) + abs(a[1] - b[1]) > 0.05
SV = '데이터/보완자료/3d-map-audit-20261009/사용자-네이버거리뷰-20261012/'
ops = []
# --- 서문
g = M['westGate']; n = node['2c931081']; p = place['13ef4728']
GG = '확정(서문 자리 = 사용자 표시 (200976.8, 557408.2) ±6 m, 차가 서문으로 지하 차도에 들어간다), 추정(문이 보는 방향, 터널 안의 선)'
GE = f'구역 노트 서문과 서쪽 옹벽 W01 절: {SV}33~35, 사용자-서문·제2주차장·수인관-20261010/01-SMAP-서문·제2주차장-사용자표시.webp'
if far(p['coordinate'], g['roadStart']):
    ops.append({'ref': '서문 표지를 새 문틀 앞으로', 'op': 'update_place', 'grade': GG, 'evidence': GE, 'args': {'id': p['id'], 'expectedRevision': p['revision'], 'position': pt(g['roadStart']),
                'description': 'N03·W01. 차가 드나드는 서문(사용자 확정). 문틀은 사용자 표시 (200976.8, 557408.2) ±6 m 자리, 남남서를 본다(거리뷰 33~35, 방향 추정). 옛 자리 (200984, 557399.5)는 S-MAP 벽 면에서 읽은 것. 학교 표지 (200967.8, 557401.5)·(200969.0, 557402.8), 거리뷰 두 시선의 교차 (200972, 557401)(거리뷰 지점의 길 방향 오차 ±8 m). 터널 안의 선은 추정'}})
if far(n['coordinate'], g['roadStart']):
    ops.append({'ref': '서문 터널 길의 시작 노드를 새 문틀 앞으로', 'op': 'move_node', 'grade': GG, 'evidence': GE, 'args': {'nodeId': n['id'], 'to': pt(g['roadStart'])}})
# --- 유담관 3층 입구
e = M['entrance3']; door, foot, pl, r = node['dbc8c7c7'], node['52db453d'], place['d5ea71e7'], road['9e3c9fbd']
EG = '확정(서경스포렉스 간판의 입구 = 유담관 3층 입구, 우편취급국 옆: 사용자 2026-10-10·10-12. 자리는 사용자가 표시한 학교 지도 표지 그대로), 원천(둥근 기둥 둘, 계단 8~9단: 거리뷰 29), 추정(문 앞 바닥 104.0 m, 계단 끝 ±1 m)'
EE = f'건물 노트 유담관 W01 절: {SV}29-근접-스포렉스입구-우체국.jpg, 사용자-SP카페·대일관계단·3생활관-20261012/06'
if far(pl['coordinate'], e['door']):
    ops.append({'ref': '유담관 입구(3) 표지를 다시 앉힌 문 앞으로', 'op': 'update_place', 'grade': EG, 'evidence': EE, 'args': {'id': pl['id'], 'expectedRevision': pl['revision'], 'position': pt(e['door']),
                'description': 'N03·P02·W01. 유담관 3층 입구 = 바깥 길 쪽 "서경스포렉스" 간판 아래 유리문(우편취급국 옆): 사용자 확정 2026-10-10·10-12, 거리뷰 29. 문 앞 바닥 104.0 m(추정), 둥근 기둥 둘 사이 돌계단 8단쯤과 경사로. 자리는 사용자가 학교 지도에서 표시한 표지 (200994.6, 557307.6)를 건물 면에 내린 곳. 문 안은 모름(사용자가 나중에 기록)'}})
if far(door['coordinate'], e['door']): ops.append({'ref': '3층 입구 문 앞 노드', 'op': 'move_node', 'grade': EG, 'evidence': EE, 'args': {'nodeId': door['id'], 'to': pt(e['door'])}})
if far(foot['coordinate'], e['foot']): ops.append({'ref': '3층 입구 계단 발치 노드(보도 위)', 'op': 'move_node', 'grade': EG, 'evidence': EE, 'args': {'nodeId': foot['id'], 'to': pt(e['foot'])}})
ops.sort(key=lambda o: o['op'] == 'move_node')   # 노드 옮기기는 맨 뒤
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'w01.json').write_text(json.dumps({'id': 'W01', 'zone': '서문과 서쪽 옹벽', 'comment': 'W01: 서문 터널 길 시작과 표지를 사용자 표시 자리의 새 문틀 앞으로, 유담관 3층 입구 계단 길을 건물 면에 맞춤', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('ops', len(ops), [o['ref'] for o in ops])
