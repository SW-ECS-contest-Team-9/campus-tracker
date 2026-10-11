"""U01: 시험용 DB 변경 묶음(운동장 지하 1·2층 차로, 지하 차도 연장, 서문·제2주차장에서 들어오는 선). DB 접근 없음.   python build_groups.py
읽는 파일: model.json(build_parts.py). 쓰는 파일: groups/u01.json (적용은 n02/n02.ts apply, 시험용 DB 에만).
선은 전부 추정이다(확정은 '이어진다'는 사실뿐). 이름에 '지하'가 들어가야 화면이 지하 길로 그린다."""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8')); P = M['points']; H = M['heights']
BLD = unary_union([Polygon(b['ring']).buffer(0) for b in json.loads((REPO / 'docs/audit/z04/scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']])
r2 = lambda v: round(float(v), 2)
at = lambda node: {'at': {'nodeId': node}}
N_TOP, N_LOW, N_P1 = '55a87aa0-3b19-42fb-8efb-77416a22dc3e', '81ff89df-6ba0-4847-b19e-2ddd5e6e8b31', '334dbc48-b34f-4d2b-bc1a-b91f4cb8748b'   # 지하 차도 위 끝·아래 끝, 표지판 P1 입구
N_OLD_N, N_OLD_S = '70261794-123d-4f91-88f1-ad91717acdcd', '79988154-51eb-4e57-bff2-a78064906646'   # 옛 지하주차장 통로의 북쪽 끝, 혜인관 계단 아래
Z1, Z2 = H['b1Floor'], H['b2Floor']
USER = '사용자 확정 2026-10-12: 지하 차도 경사로의 종착지는 운동장 바로 아래에 있는 지하 1층과 지하 2층이다'
ops = []
def op(ref, name, args, grade, evidence): ops.append({'ref': ref, 'op': name, 'args': args, 'grade': grade, 'evidence': evidence})
def road(ref, name, path, width, grade, evidence, structure='ordinary', cls='vehicle', ped='prohibited'):
    op(ref, 'create_road', {'roadClass': cls, 'name': name, 'structure': structure, 'widthM': width, 'vehicleAccess': 'allowed', 'pedestrianAccess': ped, 'vehicleDirection': 'both', 'pedestrianDirection': 'unknown',
                            'path': path, 'zMode': 'explicit', 'densify': False}, grade, evidence)
def ramp_path(xy, z0, z1):
    """꺾은선 xy 에 길이 비례로 z0 → z1 을 준다(한 경사)."""
    xy = np.array(xy, float); s = np.r_[0, np.cumsum(np.hypot(*np.diff(xy, axis=0).T))]
    return [{'xy': [r2(x), r2(y)], 'z': r2(z0 + (z1 - z0) * t / s[-1])} for (x, y), t in zip(xy, s)], float(s[-1])

# ---------- 옛 기록 정리 ----------
op('옛 이음 조각 b17424ba 거둠', 'retire_feature', {'type': 'road', 'id': 'b17424ba-23eb-427f-b651-ba390b405e7f', 'expectedRevision': 11}, '규칙(길 규칙서 10: 지하 길은 지상 길과 평면에서 겹쳐도 잇지 않는다)',
   '운동장 가장자리 지상 길(148.9~150.7 m)과 지하주차장 통로 북쪽 끝(146.3 m)을 4.6 m 짜리 선으로 이어 둔 조각. 계단이 있다는 근거가 없다(이름은 C02 수집 경로이나 지상 길을 자른 나머지)')
op('옛 지하주차장 통로 a789c985 → 지하 1층 높이', 'update_road', {'id': 'a789c985-e419-4509-a709-76422a37ad0e', 'expectedRevision': 1, 'zMode': 'explicit', 'densify': False,
   'attrs': {'name': '운동장 지하 1층 차로 (옛 이름 지하주차장 통로. 혜인관 계단 아래 ~ 북쪽. 선·높이 추정)', 'widthM': 6},
   'vertexOps': [{'op': 'move', 'index': i, 'point': {'xy': xy, 'z': Z1}} for i, xy in ((1, [201220.4, 557235.4]), (2, [201222.1, 557240.2]), (3, [201230.5, 557260.5]))]},
   '추정(높이)', f'{USER}. 옛 값 146.3~146.9 m 는 운동장(148.9)과 2 m 차라 한 층이 들어갈 수 없다. 혜인관 지하 1층(148.9~149.3)에서 계단으로 3.8 m 내려간 기록으로 읽어 {Z1} m')
op('혜인관 계단 5aea9b42 아래쪽', 'update_road', {'id': '5aea9b42-15e8-4fa1-be44-50e22922d65a', 'expectedRevision': 3, 'zMode': 'explicit', 'densify': False,
   'vertexOps': [{'op': 'move', 'index': 2, 'point': {'xy': [201222.75, 557231.03], 'z': r2(Z1 + 0.3)}}]}, '추정', '계단 아래 끝을 지하 1층 바닥으로. 위 끝(혜인관 지하 1층 실내 길, 150.7 m)은 그대로: 혜인관 실내 길 전체가 동 노트 값(149.3)보다 1.1~1.4 m 높게 저장돼 있어 이 계단의 높이 차도 그만큼 크다')
for ref, node, xy in (('옛 통로 북쪽 끝', N_OLD_N, [201210.58, 557271.18]), ('혜인관 계단 아래', N_OLD_S, [201220.61, 557232.88])):
    op(f'{ref} 노드 → {Z1}', 'move_node', {'nodeId': node, 'to': {'xy': xy, 'z': Z1}}, '추정(높이)', f'운동장 지하 1층 바닥 {Z1} m(추정 145.0~145.6)')

# ---------- 운동장 아래 ----------
ap = M['approach']; ir = M['innerRamp']
road('지하 차도 연장', f"지하 차도 연장 (문예관 지하 통로 갈림 ~ 내리막길 밑 ~ 운동장 지하 2층. 이어짐은 확정, 선·높이 추정. 경사 {ap['gradePct']:.1f} %)",
     [at(N_TOP), ap['entry'], P['A2']], ap['widthM'], '확정(운동장 아래 지하층까지 이어짐), 추정(선·높이)', f"{USER}. 선: 내리막길 축을 그대로 이어 운동장 서쪽 벽까지 {ap['lengthM']} m. 높이 136.39 → {Z2} m", structure='ramp')
road('안쪽 경사로', f"운동장 지하 2층–지하 1층 경사로 (자리·길이 추정. 경사 {ir['gradePct']:.1f} %)", [P['A2'], ir['bottom'], ir['top'], P['B']], ir['widthM'],
     '확정(두 층 모두 종착지), 추정(경사로 자리)', f"{USER}. 두 층을 잇는 차 경사로가 있어야 한다. 자리는 지하 차도 축의 연장(추정), {ir['lengthM']} m 에 {r2(Z1 - Z2)} m", structure='ramp')
road('지하 1층 차로(북쪽)', '운동장 지하 1층 차로 (안쪽 경사로 위 ~ 옛 지하주차장 통로. 선 추정)', [P['B'], at(N_OLD_N)], 6, '추정', f'{USER}. 옛 지하주차장 통로의 북쪽 끝이 지하 차도 축에서 {M["oldPassageOffAxisM"]} m 옆이다')
road('지하 2층 차로', '운동장 지하 2층 차로 (들머리 ~ 주차 자리. 선 추정)', [P['A2'], P['C2']], 6, '추정', f'{USER}. 종착 표지까지 곧은 선(안쪽 배치 모름)', ped='unknown')
road('지하 1층 차로(가운데)', '운동장 지하 1층 차로 (경사로 위 ~ 주차 자리. 선 추정)', [P['B'], P['C1']], 6, '추정', f'{USER}. 종착 표지까지 곧은 선(안쪽 배치 모름)', ped='unknown')
for name, key, z in (('운동장 지하 1층 주차장', 'C1', Z1), ('운동장 지하 2층 주차장', 'C2', Z2)):
    op(f'장소 {name}', 'create_place', {'name': f'{name} (이름·자리 추정)', 'category': 'parking', 'description': f'U01. 사용자 확정 2026-10-12: 운동장 바로 아래 지하 1층·지하 2층이 지하 차도의 종착지. 사용자는 "지하 1층·지하 2층"이라고만 했다(주차장이라는 이름과 표지 자리는 추정). 바닥 {z} m 추정',
                                        'position': P[key]}, '확정(층이 있음), 추정(이름·자리·높이)', USER)

# ---------- 서문·제2주차장에서 지하 차도 아래 끝까지 (선 전부 추정) ----------
J = [201034.5, 557351.2]; X = [201046.6, 557352.45]; ZJ = 128.75
v1, l1 = ramp_path([[201021.95, 557307.07], [201020.6, 557313.0], [201021.5, 557326.0], [201026.5, 557340.0], J], 129.42, ZJ)
w, lw = ramp_path([[200984.0, 557399.5], [200997.0, 557394.5], [201003.5, 557380.5], [201006.0, 557362.0], [201012.0, 557350.5], [201022.0, 557347.5], J], 117.0, ZJ)
for name, line in (('제2주차장 쪽', v1), ('서문 쪽', w)): assert not LineString([q['xy'] for q in line]).intersects(BLD), name
WEST = '사용자 확정 2026-10-10: 차는 제2주차장 입구와 서문 두 곳에서 지하 차도로 들어간다. 두 입구 자리는 사용자 표시(S-MAP 그림 01). 사이의 선은 모른다'
road('제2주차장 → 합류', f'지하 차도 (제2주차장 입구 ~ 서문 쪽 합류. 들어간다는 것만 확정, 선·높이 추정)', [at(N_P1)] + v1[1:], 7.2, '확정(이 입구로 지하 차도에 들어감), 추정(선·높이)',
     f'{WEST}. 선: 입구에서 본관 서쪽 벽 바깥을 따라 북쪽으로 {l1:.0f} m. 높이 129.42 → {ZJ} m(위 포장면과 1.5~2.4 m 차뿐: 맞지 않는 것으로 구역 노트에 적음)', structure='ramp')
road('합류 → 지하 차도 아래 끝', '지하 차도 (합류 ~ 지하 횡단보도 자리 ~ 본관 옆 구간 아래 끝. 선 추정)', [{'xy': J, 'z': ZJ}, {'xy': X, 'z': ZJ}, at(N_LOW)], 7.2, '확정(지하 횡단보도가 이 차도를 건넌다), 추정(선)',
     f'{WEST}. 지하 횡단보도 8fde6a04(128.6~128.9 m)의 가운데를 지나게 그었다')
road('서문 → 합류', f'지하 차도 (서문 터널 ~ 제2주차장 쪽 합류. 들어간다는 것만 확정, 선·높이 추정. 경사 {(ZJ - 117.0) / lw * 100:.1f} %)', w[:-1] + [{'xy': J, 'z': ZJ}], 7.2, '확정(서문으로 지하 차도에 들어감), 추정(선·높이)',
     f'{WEST}. 서문 앞 공도 117.0 m(S-MAP)에서 {ZJ} m 까지 {ZJ - 117.0:.1f} m 를 올라야 한다. 곧은 선(73 m)이면 15.8 % 라 옹벽 안쪽을 따라 돌아가는 선 {lw:.0f} m 로 그었다', structure='ramp')
out = {'id': 'U01', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U01: 운동장 지하 1층·2층 차로와 종착 표지, 지하 차도 연장과 안쪽 경사로, 서문·제2주차장에서 들어오는 선(추정), 옛 지하주차장 통로를 지하 1층 높이로', 'ops': ops,
       'numbers': {'p1ToJoinM': r2(l1), 'westGateToJoinM': r2(lw), 'westGateGradePct': r2((ZJ - 117.0) / lw * 100), 'p1GradePct': r2((129.42 - ZJ) / l1 * 100)}}
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'u01.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), out['numbers'])
