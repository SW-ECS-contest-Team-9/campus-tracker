"""R6 시험용 DB 변경 묶음(편집기 MCP apply_changes 형식)을 groups/ 에 쓴다. 높이는 구조물 윗면(길 규칙서 규칙 1): 공도 기단(+0.15 보도), 새 기단(r6-back), 서문 위 화단 비탈.
  python -X utf8 build_groups.py [--trail <a03d33c3 의 지금 id>]   ->  groups/r6-1-west.json … r6-6-place.json (적용 기록(applied)이 붙은 파일은 덮지 않는다)
근거: 판독 R6 F1~F6·F13(보완자료/학교-전경-20261022/전수판독/R6/판독.md), 구역 노트 서문과 서쪽 옹벽·뒤편 산책로와 북악관 옆길·정문, 동 노트의 2026-10-25 R6 절.
지운 길 6f2a4bcd·7408c108 은 건드리지 않는다."""
import json, math, pathlib, sys
import numpy as np
from shapely.geometry import LineString, Point, shape
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
EV = '판독 보완자료/학교-전경-20261022/전수판독/R6/판독.md'
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8'))
PL = {}
for fp in STR.glob('*.geojson'):
    if fp.name.startswith('a2-'): continue
    for f in json.loads(fp.read_text(encoding='utf-8'))['features']:
        p = f['properties']
        if p.get('kind') == 'platform': PL[p['id']] = (shape(f['geometry']).buffer(0), p)
def top(p, x, y):
    tp = p.get('topProfile')
    if not tp: return float(p['topM'])
    (ox, oy), (dx, dy) = tp['origin'], tp['direction']; d = ((x - ox) * dx + (y - oy) * dy) / math.hypot(dx, dy); pts = sorted(tp['points'])
    return float(np.interp(d, [a for a, _ in pts], [h for _, h in pts]))
STREETS = ['Z05-PLATFORM-WEST-STREET', 'Z05-PLATFORM-GATE-ROUNDABOUT', 'Z05-PLATFORM-GATE-STREET-SW']
def street(x, y):
    hit = [top(PL[i][1], x, y) for i in STREETS if PL[i][0].contains(Point(x, y))]
    return min(hit) if hit else top(PL[min(STREETS, key=lambda i: PL[i][0].distance(Point(x, y)))][1], x, y)
def walk(x, y): return {'xy': [r2(x), r2(y)], 'z': r2(street(x, y) + 0.15)}   # 보도 윗면
def road(x, y): return {'xy': [r2(x), r2(y)], 'z': r2(street(x, y))}          # 차도 면
def pt(x, y, z): return {'xy': [r2(x), r2(y)], 'z': r2(z)}
def node(i): return {'at': {'nodeId': i}}
PED = lambda structure, w, name: {'roadClass': 'pedestrian', 'structure': structure, 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'widthM': w, 'name': name, 'zMode': 'explicit', 'densify': False}

N_YUDAM3_FOOT = '52db453d-cf5e-4924-a5dd-bdd5c1834519'   # 9e3c9fbd(유담관 3층 입구 돌계단) 아래 끝 (200996.8, 557307.1, 103.2)
R_DORMWALK = '15fa4bfd'                                  # 서경로 남서쪽 보도(공연실습소 앞 ~ 생활관 문), 꼭짓점 1 = (201006.0, 557233.6, 92.3)
N_XWALK_NE, N_XWALK_SW = '90324f04', 'b623bdce'          # 횡단 b06802b5 의 두 끝(196335d9 끝 / e0059cce 시작)
N_BUKAK_NW = '7895ac0d'                                  # 북악관 북서 모서리, 뒤 산책로 a03d33c3 시작 (201018.5, 557413.3, 132.8)
N_HYEIN_NE = 'f86049dd'                                  # 혜인관 입구(2) 길 위 R5 갈림 (201245.3, 557256.8, 149.3)
IDS = json.loads((HERE / 'ids.json').read_text(encoding='utf-8'))   # 8자리 → 전체 uuid, 길 revision(시험 DB 에서 읽음)
U = lambda k: IDS['ids'][k]

# ---- F1: 서쪽 공도 캠퍼스 쪽 보도(N1 남쪽, N4 북쪽)와 회전교차로 얼룩말 횡단(N2) ----
FOOT = LineString([(201064.0, 557199.0), (201052.0, 557212.5), (201040.0, 557220.5), (201028.0, 557228.5), (201016.0, 557236.5), (201008.0, 557244.5)])
J = (201012.8, 557238.3)      # 유담관 남서 모서리 보도: 회전교차로 얼룩말 축(201005.5, 557231 → 201011.5, 557237)과 벽 발치 선 1.0 m 남서 선이 만나는 곳
JP = walk(*J)
G1 = '확정(캠퍼스 쪽 보도: 거리뷰 27~34·사용자 사진 04·S-MAP 정사, 모델 W01 보도), 추정(선 ±1.5 m)'
N1 = [node(U(N_YUDAM3_FOOT))] + [walk(x, y) for x, y in [(200999.0, 557290.0), (201000.9, 557275.0), (201002.8, 557260.0), (201004.4, 557248.2), (201007.6, 557244.9)]] + [JP]
N4 = [node(U(N_YUDAM3_FOOT))] + [walk(x, y) for x, y in [(200995.2, 557320.0), (200993.2, 557335.0), (200991.3, 557350.0), (200989.4, 557364.4), (200987.3, 557379.3), (200983.6, 557393.9)]]
g1 = {'id': 'R6-1-WEST', 'comment': 'R6 F1: 유담관 3층 입구 계단 끝 → 서쪽 공도 캠퍼스 쪽 보도 → 회전교차로 얼룩말 → 서경로 남서쪽 보도(생활관 문), 3층 입구 → 서문 앞. 시험용 DB 만', 'ops': [
    {'ref': 'F1 N1 3층 입구 계단 끝 → 유담관 남서 모서리 보도', 'op': 'create_road',
     'args': {**PED('sidewalk', 2.5, '서쪽 공도 캠퍼스 쪽 보도: 유담관 3층 입구(서경스포렉스) 앞 ~ 유담관 남서 모서리 (붉은 벽돌 무늬 블록·노란 점자 띠, 높이 공도 + 0.15. 선 ±1.5 m 추정, 현장 확인 전)'), 'path': N1},
     'grade': G1, 'evidence': EV + ' ⑦·F1'},
    {'ref': 'F1 N4 3층 입구 계단 끝 → 서문 앞 보도 끝', 'op': 'create_road',
     'args': {**PED('sidewalk', 2.5, '서쪽 공도 캠퍼스 쪽 보도: 유담관 3층 입구(서경스포렉스) 앞 ~ 서문 앞 (붉은 벽돌 무늬 블록·노란 점자 띠, 높이 공도 + 0.15. 선 ±1.5 m 추정, 현장 확인 전)'), 'path': N4},
     'grade': G1, 'evidence': EV + ' ⑦·F1'},
    {'ref': 'F1 N2 유담관 남서 모서리 보도 → 회전교차로 동쪽 얼룩말 → 15fa4bfd 꼭짓점 1(생활관 문 앞 보도)', 'op': 'create_road',
     'args': {**PED('crossing', 3.5, '회전교차로 동쪽 횡단보도 (유담관 남서 모서리 ~ 외국인 생활관 앞. 얼룩말 자리: S-MAP 정사 확정, 선 ±1 m)'),
              'path': [JP, {'at': {'roadId': U(R_DORMWALK), 'vertexIndex': 1}}]},
     'grade': '확정(얼룩말: S-MAP 정사 두 번 맞춤, 사용자 사진 04·외국인생활관), 추정(선 ±1 m)', 'evidence': EV + ' ⑧·F1·F7'}]}

# ---- F4·F5: 서경로 횡단을 얼룩말 자리로, 유담관 벽 아래 보도(N3) ----
NE = FOOT.offset_curve(1.0, join_style=2)   # 벽 발치 1.0 m 남서 = 보도 가운데
ne0 = NE.coords[0]
N3 = [node(U(N_XWALK_NE))] + [walk(x, y) for x, y in list(NE.coords)[1:-1]] + [JP]
g2 = {'id': 'R6-2-SEOGYEONG', 'comment': 'R6 F4·F5: 서경로 횡단 b06802b5 를 실제 얼룩말 자리로(약 7 m 남동), 유담관 벽 아래 캠퍼스 쪽 보도를 회전교차로까지, e0059cce 이름. 시험용 DB 만', 'ops': [
    {'ref': 'F4 b06802b5 이름', 'op': 'update_road', 'args': {'id': U('b06802b5'), 'expectedRevision': IDS['rev']['b06802b5'],
     'attrs': {'name': '서경로 횡단보도 (공연실습소 동쪽 끝 앞 얼룩말: S-MAP 정사·거리뷰 37 확정, 선 ±1 m)'}}, 'grade': '확정(얼룩말 자리)', 'evidence': EV + ' ⑥·F4'},
    {'ref': 'F5 e0059cce 이름', 'op': 'update_road', 'args': {'id': U('e0059cce'), 'expectedRevision': IDS['rev']['e0059cce'],
     'attrs': {'name': '서경로 남서쪽 길가: 횡단보도 ~ 공연실습소 북서 모서리 문 앞 (차도 가, 턱 있는 보도 없음, 추정. 거리뷰 36~40·항공 사진, 현장 확인 전)'}}, 'grade': '추정(턱 있는 보도가 사진에 안 보임)', 'evidence': EV + ' F5'},
    {'ref': 'F4 횡단 북동 끝(196335d9 끝) → 얼룩말 북동 끝(캠퍼스 쪽 보도)', 'op': 'move_node', 'args': {'nodeId': U(N_XWALK_NE), 'to': walk(*ne0)}, 'grade': '확정', 'evidence': EV + ' ⑥·F4'},
    {'ref': 'F4 횡단 남서 끝(e0059cce 시작) → 얼룩말 남서 끝(차도 가)', 'op': 'move_node', 'args': {'nodeId': U(N_XWALK_SW), 'to': road(201055.8, 557195.0)}, 'grade': '확정', 'evidence': EV + ' ⑥·F4'},
    {'ref': 'F5 N3 얼룩말 북동 끝 → 유담관 벽 아래 보도 → 유담관 남서 모서리 보도(N1·N2 와 만남)', 'op': 'create_road',
     'args': {**PED('sidewalk', 2.0, '서경로 캠퍼스 쪽 보도: 공연실습소 앞 얼룩말 ~ 유담관 벽 아래 ~ 회전교차로 (블록 보도 + 화강석 경계석, 벽 발치 1 m 남서, 높이 공도 + 0.15. 선 ±1 m 추정)'), 'path': N3},
     'grade': '확정(보도: 사진 04·거리뷰 36·37·S-MAP 정사·벽 발치), 추정(선 ±1 m)', 'evidence': EV + ' ③④⑤·F5'}]}

# ---- F3: 서문 앞 → 얼룩말 → 왼쪽 철 계단 → 문 위 단 → 서문 위 화단 비탈 → 북악관 북서 모서리 ----
H = M['heights']; W = M['westgate']
s0 = N4[-1]
A = [s0, pt(*H['N5street'][0])]
B = [pt(*H['N5street'][0]), pt(*H['N5street'][1])]
C = [pt(*H['N5street'][1]), pt(*H['N5street'][2]), pt(*H['N5stair'][0])]
D = [pt(*H['N5stair'][0]), pt(*H['N5stair'][1])]
E = [pt(*H['N5stair'][1])] + [pt(*p) for p in H['N5top']] + [node(U(N_BUKAK_NW))]
G3 = '있음 확정(거리뷰 색인 34·W01 노트·네이버 길 선·S-MAP 산책로 점선), 추정(철 계단 자리·단 수, 산책로 선 ±3 m)'
g3 = {'id': 'R6-3-WESTGATE', 'comment': 'R6 F3: 서문 앞 길가 → 얼룩말 → 왼쪽 날개벽 뒤 철 계단(추정) → 문 위 단 → 서문 위 화단 비탈 → 북악관 북서 모서리. 시험용 DB 만', 'ops': [
    {'ref': 'F3 서쪽 보도 끝 → 서문 앞 얼룩말 동쪽 끝(차도 가)', 'op': 'create_road',
     'args': {**PED('ordinary', 2.0, '서문 앞 길가: 서쪽 공도 캠퍼스 쪽 보도 끝 ~ 서문 앞 횡단보도 (차도 가, 선 추정, 현장 확인 전)'), 'path': A}, 'grade': '추정(선)', 'evidence': EV + ' ⑪·F3'},
    {'ref': 'F3 서문 앞 얼룩말', 'op': 'create_road',
     'args': {**PED('crossing', 3.0, '서문 앞 횡단보도 (얼룩말 칠: S-MAP 정사·거리뷰 34 확정, 건너는 선 추정)'), 'path': B}, 'grade': '확정(칠), 추정(선)', 'evidence': EV + ' ⑪·F3'},
    {'ref': 'F3 얼룩말 서쪽 끝 → 철 계단 발치', 'op': 'create_road',
     'args': {**PED('ordinary', 1.5, '서문 왼쪽 날개벽 앞 ~ 철 계단 발치 (차도 가, 선 추정, 현장 확인 전)'), 'path': C}, 'grade': '추정', 'evidence': EV + ' ⑩·F3'},
    {'ref': f'F3 철 계단 {W["zfoot"]} → {W["ztop"]} ({W["steps"]} 단)', 'op': 'create_road',
     'args': {**PED('stairs', 1.0, f'서문 왼쪽 날개벽 뒤 철 계단 (문 앞 {W["zfoot"]} → 문 위 단 {W["ztop"]} m, {W["steps"]}단. 있음: 거리뷰 색인 34·네이버 길 선·S-MAP 산책로 점선. 철 계단 자리·단 수 추정, 현장 확인 전)'), 'path': D},
     'grade': G3, 'evidence': EV + ' ⑩·F3, 구역 노트 서문과 서쪽 옹벽 2026-10-25 R6 절'},
    {'ref': 'F3 문 위 단 → 서문 위 화단 비탈 → 북악관 북서 모서리(7895ac0d)', 'op': 'create_road',
     'args': {**PED('ordinary', 2.0, '뒤 산책로 서쪽 끝("삼양로15길"): 서문 위 단 ~ 서문 위 화단 비탈 ~ 북악관 북서 모서리 (126.8 → 132.8 m. 있음: 네이버 지도 길 선·S-MAP 산책로 점선, 선 ±3 m 추정, 현장 확인 전)'), 'path': E},
     'grade': G3, 'evidence': EV + ' ⑨·F3'}]}

# ---- F6: 북악관 뒤 a03d33c3 꼭짓점 1~11 을 벽 + 3 m 로(평면, 높이 S-MAP) ----
F6 = [(201028.0, 557410.1, 133.3), (201031.7, 557408.4, 133.5), (201039.0, 557405.0, 133.8), (201046.3, 557401.7, 133.9), (201053.6, 557398.3, 134.2), (201060.9, 557394.9, 134.4),
      (201068.2, 557391.5, 134.8), (201075.4, 557388.2, 135.2), (201082.7, 557384.8, 135.8), (201090.0, 557381.4, 136.5), (201097.0, 557374.0, 138.8)]
g4 = {'id': 'R6-4-BUKAK', 'comment': 'R6 F6: 뒤 산책로 a03d33c3 북악관 뒤 구간(외곽 안 22.9 m)을 벽에서 3.0 m 로. 시험용 DB 만', 'ops': [
    {'ref': 'F6 a03d33c3 꼭짓점 1~11', 'op': 'update_road', 'args': {'id': U('a03d33c3'), 'expectedRevision': IDS['rev']['a03d33c3'], 'zMode': 'explicit', 'densify': False,
     'attrs': {'name': '뒤 산책로 (대일관 측면 접근로, 기존 C02. 북악관 뒤는 벽에서 3 m: R6 판독, 3 m 는 추정)'},
     'vertexOps': [{'op': 'move', 'index': k + 1, 'point': pt(*p)} for k, p in enumerate(F6)]},
     'grade': '확정(벽에 붙음·외곽 안), 추정(3 m)', 'evidence': EV + ' ⑮·F6'}]}

# ---- F2: 뒤 산책로 동쪽 이어짐(N6) ----
def g5(trail_id):
    path = [{'at': {'roadId': trail_id, 'nearest': [201188.0, 557347.9]}}] + [pt(*p) for p in H['N6'][:-1]] + [node(U(N_HYEIN_NE))]
    return {'id': 'R6-5-EAST', 'comment': 'R6 F2: 뒤 산책로를 대일관 동쪽 끝 비탈에서 상승관·청운관 뒤 단 → 청운관 동쪽 흙길 → 혜인관 북동 어귀(R5)까지. 시험용 DB 만', 'ops': [
        {'ref': 'F2 N6 a03d33c3 (201188.0, 557347.9) → 혜인관 북동 어귀 f86049dd', 'op': 'create_road',
         'args': {**PED('ordinary', 3.0, '뒤 산책로 동쪽: 대일관 동쪽 끝 비탈 ~ 상승관·청운관 뒤 단 ~ 청운관 동쪽 흙길(폭 약 3 m) ~ 혜인관 북동 어귀 (있음: 네이버 지도 길 선·S-MAP 산책로 점선 조각·S-MAP 정사 흙길, 높이 S-MAP·기단. 상승관 뒤 선 ±3 m 추정, 현장 확인 전)'), 'path': path},
         'grade': '확정(있음: 근거 셋), 추정(상승관 뒤 선 ±3 m)', 'evidence': EV + ' ⑯⑰·F2, 구역 노트 뒤편 산책로와 북악관 옆길 2026-10-25 R6 절'}]}

# ---- F2 뒤: 새 길이 대일관 측면 하부 접근부 d8ae25f8(보행 unknown) 위를 0.75 m 높이 차로 겹쳐 지나감(validate OVERLAPPING_ROADS·UNCONNECTED_CROSSING)
#      → 새 길의 둘째 꼭짓점을 그 위 끝 노드 b4b71955(측면 계단 1d10b963 발치, 148.3)로 옮겨 만나게 한다(측면 계단 사슬은 보행 unknown 그대로) ----
N_SIDESTAIR_FOOT = 'b4b71955'
def g5b(n6_id, rev):
    return {'id': 'R6-5B-EAST-JOIN', 'comment': 'R6 F2 뒤: 새 뒤 산책로 동쪽 길을 대일관 측면 계단 발치 노드에서 만나게(겹침 풀기). 시험용 DB 만', 'ops': [
        {'ref': 'F2 N6 꼭짓점 1 (201200.0, 557338.0) → 노드 b4b71955 (201194.5, 557336.8, 148.3)', 'op': 'update_road',
         'args': {'id': n6_id, 'expectedRevision': rev, 'zMode': 'explicit', 'densify': False, 'vertexOps': [{'op': 'move', 'index': 1, 'point': node(U(N_SIDESTAIR_FOOT))}]},
         'grade': '추정(측면 계단이 실제로 있는지는 모름: 현장 요청 F4 그대로, 보행 unknown 그대로)', 'evidence': EV + ' 1-4 끝 줄·F2'}]}

# ---- F13: 장소 ----
g6 = {'id': 'R6-6-PLACE', 'comment': 'R6 F13: 학교 장소 목록 "산책로" 표지. 시험용 DB 만', 'ops': [
    {'ref': 'F13 장소 산책로', 'op': 'create_place', 'args': {'name': '산책로 (학교 장소 목록)', 'category': 'other', 'position': pt(201143.0, 557352.4, 142.8),
     'description': '학교 장소 목록(skuniv_places.json)의 "산책로" 표지. 뒤 산책로 a03d33c3 와 0.2 m. R6 판독 ⑬·F13(2026-10-25)'}, 'grade': '원천', 'evidence': EV + ' ⑬·F13'}]}

if __name__ == '__main__':
    (HERE / 'groups').mkdir(exist_ok=True)
    def w(n, g):
        f = HERE / 'groups' / n
        if f.exists() and 'applied' in json.loads(f.read_text(encoding='utf-8')): print('그대로(적용됨):', n); return
        f.write_text(json.dumps(g, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print('씀', n)
    w('r6-1-west.json', g1); w('r6-2-seogyeong.json', g2); w('r6-3-westgate.json', g3); w('r6-4-bukak.json', g4); w('r6-6-place.json', g6)
    if '--trail' in sys.argv: w('r6-5-east.json', g5(sys.argv[sys.argv.index('--trail') + 1]))
    if '--n6' in sys.argv: k = sys.argv.index('--n6'); w('r6-5b-east-join.json', g5b(sys.argv[k + 1], int(sys.argv[k + 2])))
    print('J', JP, 'N3 start', walk(*ne0))
