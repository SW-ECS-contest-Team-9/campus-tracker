"""R5 시험용 DB 변경 묶음(편집기 MCP apply_changes 형식)을 groups/ 에 쓴다. 좌표는 build_parts.py 와 같은 틀(어귀 옆벽 u·v).
  python -X utf8 build_groups.py      ->  groups/r5-1-ground.json, groups/r5-2-stair.json(위 끝 노드 id 를 인자로: --top <nodeId>), groups/r5-3-misc.json
근거: 판독 R5 E1·E3, 동 노트 혜인관·본관 2026-10-25 R5 절."""
import json, pathlib, sys
import numpy as np
HERE = pathlib.Path(__file__).parent
O = np.array([201238.29, 557262.27]); U = np.array([201239.84, 557264.84]) - O; U = U / np.hypot(*U); V = np.array([U[1], -U[0]])
def P(u, v): q = O + U * u + V * v; return [round(float(q[0]), 2), round(float(q[1]), 2)]
ZT, ZB = 149.6, 143.5; R = (ZT - ZB) / 34; ZL = ZT - 17 * R
TOP = P(3.4, 0.65)
def pt(xy, z): return {'xy': xy, 'z': round(z, 2)}
EV = '판독 보완자료/학교-전경-20261022/전수판독/R5/판독.md ①·E1, 그림 03·20, 동 노트 혜인관 2026-10-25 R5 절'
G_E1 = '있음: 확정에 가까운 추정(사진 02·학교 지하도 지도 "청운관 동" 7 m), 평면·단 수·선 추정'
ground = {'id': 'R5-1-GROUND', 'comment': 'R5 E1: 혜인관 입구(2) 길 → 청운관 동 어귀 입 앞(지상, 149.6). 시험용 DB 만', 'ops': [{
    'ref': 'E1 7bd626dd 위 점 → 남동 옆벽·둥근 화분 사이 → 어귀 입 앞(계단 위 끝)', 'op': 'create_road',
    'args': {'roadClass': 'pedestrian', 'structure': 'ordinary', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'widthM': 1.5,
             'zMode': 'explicit', 'densify': False,
             'name': '혜인관 입구(2) 길 ~ 청운관 동 지하통로 입구(혜인관 북동 어귀) 앞 (149.6 m, 선 추정)',
             'path': [{'at': {'roadId': '7bd626dd-eed9-4673-950c-bb18d0cff17f', 'nearest': [201245.3, 557256.8]}}, pt(P(3.5, 5.8), ZT), pt(TOP, ZT)]},
    'grade': G_E1, 'evidence': EV}]}
door = [201238.85, 557261.36]
stair_path = lambda top: [{'at': {'nodeId': top}}, pt(P(2.28, 0.65), ZT), pt(P(2.28, 0.95), ZT), pt(P(2.28, 4.95), ZL), pt(P(1.55, 5.6), ZL),
                          pt(P(0.83, 4.95), ZL), pt(P(0.83, 0.95), ZB), pt(P(0.6, 0.75), ZB), pt(door, ZB), pt(P(-1.6, 0.95), ZB)]
def stair(top): return {'id': 'R5-2-STAIR', 'comment': 'R5 E1: 청운관 동 어귀 → 1주차장 B1 계단. 시험용 DB 만', 'ops': [{
    'ref': 'E1 어귀 입 앞 149.6 → 윗줄 17단 → 참 146.55 → 아랫줄 17단 → B1 북동 벽 문 → 1주차장 B1 통로 면(영역 4) 143.5', 'op': 'create_road',
    'args': {'roadClass': 'pedestrian', 'structure': 'stairs', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'widthM': 1.3,
             'zMode': 'explicit', 'densify': False,
             'name': '청운관 동 지하통로 입구 계단: 혜인관 북동 어귀 → 1주차장 지하 1층 (149.6 → 143.5 m, 34단 되돌림 한 번. 있음: 사진 02·학교 지하도 지도, 평면·단 수 추정)',
             'path': stair_path(top)},
    'grade': G_E1, 'evidence': EV}]}
misc = {'id': 'R5-3-MISC', 'comment': 'R5 E1 장소, E3 ce84903b 꺾기. 시험용 DB 만', 'ops': [
    {'ref': 'E1 장소 7c009646 "청운관 동" → 어귀 입 앞', 'op': 'update_place',
     'args': {'id': '7c009646-ca7c-43ec-8473-cce6fe508ed4', 'expectedRevision': 1, 'name': '지하통로 입구: 청운관 동 (혜인관 북동 어귀, 1주차장 B1)',
              'position': pt(TOP, ZT),
              'description': 'U03. 학교 지하도 지도의 초록 점(좌표로 옮기면 (201248.6, 557262.8) ±3.3 m). R5 판독(2026-10-25): 혜인관 북동 옆면 오른쪽 콘크리트 어귀(사진 02: 아래로 내려감)와 7 m → 같은 입구로 보고 어귀 입 앞으로 옮김(추정). 계단 149.6 → 143.5(34단, 되돌림 한 번, 평면 추정)으로 1주차장 지하 1층. 전 자리 (201248.6, 557262.8, 148.9)'},
     'grade': G_E1, 'evidence': EV},
    {'ref': 'E3 ce84903b: 데크 흰 난간 RAIL-1 을 가로지르던 선 → 난간 틈(RAIL-1·RAIL-2 사이) → 데크 안 → 옆문', 'op': 'update_road',
     'args': {'id': 'ce84903b-be50-405a-b84d-e4e288e93dee', 'expectedRevision': 1, 'zMode': 'explicit', 'densify': False,
              'name': '지하 차도 보행 구간 ~ 본관 5층 옆문 유리 연결 통로 (137.8 m 평지. 이어짐·평지는 사용자 확정·사진. 데크 흰 난간 틈으로 들어옴: R5 판독 추정)',
              'vertexOps': [{'op': 'insert', 'index': 0, 'point': pt([201105.0, 557310.6], 137.8)},
                            {'op': 'insert', 'index': 1, 'point': pt([201104.85, 557309.0], 137.8)}]},
     'grade': '추정(사진 16: 기둥 동쪽 트임, 빨간 문틀이 일부 가림)', 'evidence': '판독 R5 ④-2·E3, 그림 02, 동 노트 본관 2026-10-25 R5 절'}]}
if __name__ == '__main__':
    (HERE / 'groups').mkdir(exist_ok=True)
    w = lambda n, g: (HERE / 'groups' / n).write_text(json.dumps(g, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    w('r5-1-ground.json', ground); w('r5-3-misc.json', misc)
    if '--top' in sys.argv: w('r5-2-stair.json', stair(sys.argv[sys.argv.index('--top') + 1]))
    print('TOP', TOP, 'stair', [p.get('xy') for p in stair_path('X')[1:]], 'R', round(R, 4), 'ZL', round(ZL, 2))
