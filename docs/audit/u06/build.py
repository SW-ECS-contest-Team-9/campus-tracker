"""U06: 층 사이 경사로를 은주관 문 남쪽 어귀로 옮기고(시험용 DB 변경 묶음), 북악관 지하 입구(사진 08)의 구조물을 만든다. DB·네트워크 접근 없음.   python build.py
먼저: python ../u02/build_parts.py (경사로·섬·낮은 벽·갈림·차도 벽 → model.json), python ../u04/build.py (주차 칸·차 막이·통로 면), python ../u04/pairs.py.
쓰는 파일: groups/u06.json (적용은 apply.sh, 시험용 DB 에만), frontend/public/structures/u06-bukak-underpass.geojson.
근거: 사용자 표시 2(그림 11·12: 섬 사진과 평면의 X 둘), 사용자 표시 3(사진 13·14·15: 은주관 문 벽을 등지고 본 오른쪽 낮은 벽 = 섬 사진의 네모), 사진 08. 볼트 구역 노트 "운동장 아래 지하층과 지하 차도"(U06 절)."""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); RP = M['ramp']
r2 = lambda v: round(float(v), 2)
RETIRE = [('94d52777-0603-44c1-9556-b7c4903c292e', 1, 'U자 경사로(머리 ~ 갈림)'), ('a586bf67-bb6a-437b-80a9-bc151003f150', 1, 'U자 경사로(갈림 ~ 발치)'), ('bd49a4db-d09e-4644-8ab2-99dc5c55868c', 1, 'U자 경사로 바깥 차로(U05)')]
EV = ('사용자 2026-10-12 표시 3: 은주관 간판 문이 있는 벽을 등지고 주차장을 보면 오른쪽에 낮은 벽이 있고, 그 벽이 경사로 섬 사진에서 청록 벽과 반원 섬 사이의 낮은 벽(내려가는 어귀 위)이다. '
      '표시 2: 섬 사진과 평면에 같은 X 둘. 그러므로 내려가는 어귀는 은주관 문(노드 8e608a71) 남쪽 서쪽 벽 옆이고, U02·U05 의 자리(섬이 경사로 띠의 남쪽 끝, 발치가 문 옆)는 위아래가 뒤집혀 있었다')
ops = [{'ref': f'거둠: {ref}', 'op': 'retire_feature', 'args': {'type': 'road', 'id': rid, 'expectedRevision': rev}, 'grade': '확정(사용자 표시 2·3)', 'evidence': EV} for rid, rev, ref in RETIRE]
ops.append({'ref': '층 사이 경사로', 'op': 'create_road', 'grade': '확정(어귀 자리: 사용자 표시 3, 사진 11·14·15), 추정(경사·되도는 자리·발치)',
            'evidence': EV + f". 어귀에서 서쪽 벽을 따라 북으로 {RP['westLegM']} m(경사 {RP['gradeWestLegPct']} %: 낮은 벽 밑에서 지하 1층 바닥보다 {RP['belowFloorAtBandM']} m 아래가 되게), 북서 모서리 밑에서 반지름 {RP['turnRadiusM']} m 로 되돌아(그림 12 의 X 둘 자리) 남으로 {RP['returnM']} m. 높이 차 {RP['dropM']} m 는 줄이지 않았다",
            'args': {'roadClass': 'vehicle', 'name': f"운동장 지하 1층–지하 2층 경사로 (은주관 문 남쪽 어귀 ~ 서쪽 벽 옆 ~ 북서 모서리 밑에서 되돌아 ~ 지하 2층. {RP['lengthM']} m 에 {RP['dropM']} m, 경사 {RP['gradeWestLegPct']} % 뒤 {RP['gradeRestPct']} %. 어귀 자리는 사용자 표시, 나머지 추정)",
                     'structure': 'ramp', 'widthM': RP['laneWidthM'], 'vehicleAccess': 'allowed', 'pedestrianAccess': 'prohibited', 'vehicleDirection': 'both', 'pedestrianDirection': 'unknown', 'path': RP['path'], 'zMode': 'explicit', 'densify': False}})
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'u06.json').write_text(json.dumps({'id': 'U06', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U06: U자 경사로 셋(바깥 차로 포함)을 거두고 은주관 문 남쪽 어귀에서 내려가는 층 사이 경사로 하나로', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

# ---------- 북악관 지하 입구(사진 08): 지하 차도 북쪽 벽의 문, 조명 간판, 차도 바닥의 노란 횡단 표시 ----------
# 자리 = 있는 지하 횡단보도·통로(33371f63·0fce276d: 사용자 그림 14 로 확정)가 차도 북쪽 벽을 지나는 곳. 이 구간에는 빈 곳이 없어(위 포장면과의 차가 모자람) 상자는 땅속에 있고 지하 길을 켜면 비쳐 보인다
C0 = np.array([201046.6, 557352.4]); Z = 128.8; ax = np.array([12.1, 1.2]); ax /= np.hypot(*ax); n = np.array([-ax[1], ax[0]]); HALF = 3.6
q = lambda a_, b_: C0 + ax * a_ + n * b_
rect = lambda a0, a1, b0, b1: Polygon([q(a0, b0), q(a1, b0), q(a1, b1), q(a0, b1)])
SRC = '사용자 사진 2026-10-12(08-지하차도-북악관-입구-횡단): 지하 차도 벽의 문과 "북악관" 조명 간판, 문 앞 차도 바닥의 노란 횡단 표시. 자리는 사용자 그림 14 의 지하 횡단보도'
FEATS = []
def box(fid, poly, lo, hi, color, what, material='concrete', grade='확정(있음·모양·색: 사진 08), 추정(치수·높이)'):
    FEATS.append({'type': 'Feature', 'properties': {'id': fid, 'type': 'wall', 'kind': 'extrude', 'estimated': True, 'grade': grade, 'assumption': what, 'source': SRC, 'fromM': r2(lo), 'toM': r2(hi), 'material': material, 'underground': True, 'color': color, 'name': '북악관 지하 입구'},
                  'geometry': {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in poly.exterior.coords]]}})
DOOR0, DOOR1 = -0.6, 2.4    # 문 너비 3 m(횡단보도 선이 벽을 지나는 자리)
k = 0
for a0 in np.arange(-9.0, 11.0, 1.2):
    a1 = a0 + 1.2
    if a1 > DOOR0 and a0 < DOOR1: continue
    box(f'U06-BUKAK-WALL-{k:02d}', rect(a0, a1, HALF, HALF + 0.12), Z, Z + 2.9, '#2f7f86' if k % 2 == 0 else '#39424a', '지하 차도 북쪽 벽의 청록·짙은 회색 세로 줄무늬'); k += 1
box('U06-BUKAK-KERB-W', rect(-9.0, DOOR0, HALF - 0.25, HALF), Z, Z + 0.2, '#d8b000', '벽 밑 노랑·검정 턱(문 서쪽)')
box('U06-BUKAK-KERB-E', rect(DOOR1, 11.0, HALF - 0.25, HALF), Z, Z + 0.2, '#d8b000', '벽 밑 노랑·검정 턱(문 동쪽)')
box('U06-BUKAK-DOOR', rect(DOOR0, DOOR1, HALF, HALF + 0.12), Z, Z + 2.5, '#101214', '북악관 지하 1층으로 들어가는 문(어두운 통로 어귀). 통로와 계단은 길 0fce276d·f99540e3', material='opening')
box('U06-BUKAK-LINTEL', rect(DOOR0, DOOR1, HALF, HALF + 0.12), Z + 2.5, Z + 2.9, '#39424a', '문 위 벽')
for i, (lo, hi, col, what) in enumerate(((1.95, 2.45, '#f4f4ee', '"북악관" 조명 간판(흰 판. 글자는 없음)'), (1.4, 1.9, '#f4f4ee', '가운데 흰 조명 판'), (0.85, 1.35, '#2aa3d8', '아래 파란 조명 판'))):
    box(f'U06-BUKAK-SIGN-{i}', rect(DOOR1 + 0.1, DOOR1 + 1.7, HALF - 0.1, HALF), Z + lo, Z + hi, col, what)
for i in range(5):   # 차도 바닥의 노란 가로 줄(차도와 나란한 줄 다섯): 문 앞에서 본관 쪽 보행 구간까지
    b0 = -HALF + 0.5 + i * 1.4
    box(f'U06-BUKAK-CROSSING-{i}', rect(DOOR0 - 0.3, DOOR1 + 0.3, b0, b0 + 0.6), Z, Z + 0.03, '#d9a400', '지하 횡단보도의 노란 줄(사진 08)', grade='확정(노란 횡단 표시: 사진 08, 자리: 사용자 그림 14), 추정(줄 수·치수)')
(REPO / 'frontend/public/structures/u06-bukak-underpass.geojson').write_text(json.dumps({'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
    'provenance': {'script': 'docs/audit/u06/build.py', 'note': '북악관 지하 입구(지하 차도 북쪽 벽의 문·간판·횡단 표시). underground: true 인 상자라 지하 길을 켜면 비쳐 보인다'}, 'features': FEATS}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
DOT = np.array([201060.0, 557357.0]); door = q((DOOR0 + DOOR1) / 2, HALF)
print(len(ops), 'ops,', len(FEATS), 'features. 북악관 초록 점 ~ 문:', r2(np.hypot(*(DOT - door))), 'm, 문', [r2(v) for v in door])
