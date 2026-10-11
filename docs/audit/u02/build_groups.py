"""U02: 시험용 DB 변경 묶음. 운동장 지하 1층(141.4 m)·지하 2층(133.0 m) 차로와 U자 경사로, 지하 차도가 지하 1층으로 바로 들어오게, 사람 길 셋(혜인관 안 계단, 은주1관 3층 문, 그 오른쪽 운동장 계단). DB 접근 없음.   python build_groups.py
읽는 파일: model.json(build_parts.py). 쓰는 파일: groups/u02.json (적용은 n02/n02.ts apply, 시험용 DB 에만).
순서: 길 모양 고치기(예상 개정 번호는 U01 뒤의 값) → 거두기 → 노드 옮기기 → 새 길 → 장소. 이름에 '지하'가 들어가야 화면이 지하 길로 그린다."""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8')); P = M['points']; H = M['heights']; AP = M['approach']; RP = M['ramp']; HY = M['hyein']
BLD = unary_union([Polygon(b['ring']).buffer(0) for b in json.loads((REPO / 'docs/audit/z04/scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']])
r2 = lambda v: round(float(v), 2)
node = lambda i: {'at': {'nodeId': i}}
N_TOP, N_P1, N_J = '55a87aa0-3b19-42fb-8efb-77416a22dc3e', '334dbc48-b34f-4d2b-bc1a-b91f4cb8748b', '260709b5-6f2b-4415-9cd7-17410f5207de'
N_J0, N_S0 = 'd80020b1-22ec-4f3a-bf04-de8fe795da44', 'fd002649-12f4-4346-8859-381f20c18af0'      # U01 의 지하 2층 들머리 → 지하 1층 들머리, U01 경사로 위 → U자 경사로 머리
N_C1, N_C2 = '69707760-7092-45ac-a7a9-d5afbc620526', '58dbed52-ac58-402e-a9ee-81277f34ed25'      # 종착 표지 자리(차량 도달 쌍의 도착 노드)
N_HDOOR, N_HBOT = '07c38541-4d1c-4619-8ca5-2c8e93dfe5ac', '79988154-51eb-4e57-bff2-a78064906646'  # 혜인관 입구(1) 문, 혜인관 계단 아래
R = {'ext': 'df83f454-f120-4dab-86d9-137e8da84dd0', 'lead': '428a3aeb-2c54-4b78-9e3d-585548f75d74', 'aisle': '9880169d-71d8-4acd-8941-56933ce51b09', 'old': 'd3431c28-784c-4624-b872-7707ebf75c24',
     'b2': 'e34f896c-ef52-4cf0-9451-8451adc20577', 'stair': '5aea9b42-15e8-4fa1-be44-50e22922d65a', 'pass': 'a789c985-e419-4509-a709-76422a37ad0e'}
REV_PASS = 7   # U02 적용 뒤 a789c985 의 개정 번호
Z1, Z2, ZF = H['b1Floor'], H['b2Floor'], H['field']
LINES = '사용자 2026-10-12: U01 단면 그림에 붉은 선으로 지하 1층(약 140~144.5 m)·지하 2층(약 133~140 m)을 표시, 지하 차도는 그림대로 지하 1층으로 들어온다'
MAP = f"학교 캠퍼스맵 지하도 연결 지점(사용자 제공 2026-10-12, 원천. 좌표 맞춤 잔차 RMS {M['georefRmsM']} m)"
BLOG = '학교 지하도 안내 글(SKU CAST, 사용자 제공 2026-10-12, 원천)'
ops = []
def op(ref, name, args, grade, evidence): ops.append({'ref': ref, 'op': name, 'args': args, 'grade': grade, 'evidence': evidence})
def upd(ref, rid, rev, grade, evidence, attrs=None, **geom):
    op(ref, 'update_road', {'id': rid, 'expectedRevision': rev, 'zMode': 'explicit', 'densify': False, **({'attrs': attrs} if attrs else {}), **geom}, grade, evidence)
def road(ref, name, path, width, grade, evidence, structure='ordinary', cls='vehicle', ped='prohibited', veh='allowed'):
    op(ref, 'create_road', {'roadClass': cls, 'name': name, 'structure': structure, 'widthM': width, 'vehicleAccess': veh, 'pedestrianAccess': ped, 'vehicleDirection': 'both', 'pedestrianDirection': 'both' if ped == 'allowed' else 'unknown',
                            'path': path, 'zMode': 'explicit', 'densify': False}, grade, evidence)

# ---------- 길 모양 고치기 ----------
upd('지하 2층 차로', R['b2'], 1, '추정', f"{LINES}. U자 경사로 발치에서 종착 표지까지(안쪽 배치 모름). 지하 2층 바닥 {Z2} m", attrs={'name': '운동장 지하 2층 차로 (U자 경사로 발치 ~ 주차 자리. 선 추정)'}, path=[RP['bottom'], P['K2'], node(N_C2)])
upd('지하 차도 연장 → 지하 1층으로', R['ext'], 1, '확정(지하 1층으로 들어온다), 원천(주차장 북서 모서리), 추정(선)', f"{LINES}. {MAP}: 지하 차도는 주차장 북서 모서리로 들어간다(지도 끝점과 {AP['mapEndOffM']} m). 내리막길 밑 {AP['lengthM']} m 는 U01 선 그대로({AP['gradePct']} %), 운동장 서쪽 벽에서 {AP['bendDeg']:.0f}도 꺾어 북쪽 벽으로 {AP['linkM']} m 평지",
    attrs={'name': f"지하 차도 연장 (문예관 지하 통로 갈림 ~ 내리막길 밑 ~ 운동장 지하 1층 북서 모서리. 지하 1층 진입은 확정, 선 추정. 경사 {AP['gradePct']:.1f} %)"},
    vertexOps=[{'op': 'move', 'index': 1, 'point': AP['entry']}, {'op': 'insert', 'index': 1, 'point': AP['wall']}])
upd('지하 1층 차로(들머리 ~ 경사로 머리)', R['lead'], 1, '원천(경사로는 주차장 서쪽: 지도의 반원 표시), 추정(선)', f"{MAP}. U01 의 곧은 안쪽 경사로 자리를 지하 1층 차로로 바꾼다(들머리에서 섬 동쪽으로 내려가 U자 경사로 머리까지)",
    attrs={'name': '운동장 지하 1층 차로 (북서 들머리 ~ U자 경사로 머리. 선 추정)', 'structure': 'ordinary', 'widthM': 6, 'pedestrianAccess': 'unknown'}, path=[node(N_J0), P['E1'], node(N_S0)])
upd('지하 1층 차로(경사로 머리 ~ 주차 자리)', R['aisle'], 1, '추정', '종착 표지까지 곧은 선(안쪽 차로 배치 모름). 높이는 노드 이동으로', attrs={'name': '운동장 지하 1층 차로 (U자 경사로 머리 ~ 주차 자리. 선 추정)'})
upd('혜인관 계단 → 건물 안, 문 정면', R['stair'], 5, '확정(혜인관 지하(운동장 높이) 문으로 들어가 정면, 건물 안에 계단), 추정(꺾이는 모양·발치 자리·높이)',
    f"사용자 2026-10-12, {BLOG} 사진 04(검은 난간 사이로 내려가는 곧은 계단, 아래에 문). 위 끝 = 혜인관 입구(1) 문 노드(지하 1층 {HY['door']['z']} m, 지도의 초록 점과 {HY['mapDotOffM']} m), 아래 끝 = 운동장 지하 1층 {Z1} m. 높이 차 {HY['dropM']} m(두 층쯤)는 줄이지 않았다. 사진에는 첫 곧은 구간만 보이고 나머지(되돌아 내려오는 둘째 구간)는 추정",
    attrs={'name': f"혜인관 지하통로 계단 (지하 1층 문 정면, 건물 안. 혜인관 지하 1층 {HY['door']['z']} → 운동장 지하 1층 {Z1} m, 높이 차 {HY['dropM']} m·둘째 구간 추정)"},
    path=[node(N_HDOOR), HY['l0'], HY['f1'], HY['l1'], node(N_HBOT)])
upd('옛 지하주차장 통로 → 보행 동선', R['pass'], 4, '원천(혜인관 계단에서 주차장을 가로질러 은주관 문으로: 안내 글의 붉은 선), 추정(선)', f"{BLOG}: 혜인관 지하통로 입구 → 지하 주차장을 대각선으로 건너 → 은주관 간판 옆 문. 옛 선(운동장 동쪽 가장자리 밑 52 m)은 출처를 모르는 추정이었다",
    attrs={'roadClass': 'pedestrian', 'name': '운동장 지하 1층 보행 동선 (혜인관 계단 아래 ~ 주차장 가로질러 ~ 북서 들머리. 옛 이름 지하주차장 통로. 선 추정)', 'widthM': 2, 'vehicleAccess': 'prohibited', 'pedestrianAccess': 'allowed'},
    path=[node(N_HBOT), HY['out'], node(N_J0)])
v = np.array([[201021.95, 557307.07], [201023.5, 557313.0], [201025.2, 557323.1], [201034.0, 557342.5], [201034.5, 557351.2]]); s = np.r_[0, np.cumsum(np.hypot(*np.diff(v, axis=0).T))]
assert not LineString(v).buffer(3.6).intersects(BLD)
upd('제2주차장 쪽 선을 본관 서쪽 벽 가까이', 'b85c41a9-f482-49d3-9f86-f31f8eea6034', 1, '원천(지도: 버스 정류장 옆에서 북으로 가다 본관 북서 모서리에서 동으로), 추정(선·높이)',
    f"{MAP}. 지도의 점선은 본관 서쪽 벽에 붙어 간다. U01 선은 벽에서 13~15 m 였고 9 m 로 당겼다(벽 앞 0~5 m 는 본관 모서리 앞 계단 자리). 길이 {s[-1]:.1f} m, 높이 129.42 → 128.75 m 그대로",
    path=[node(N_P1)] + [{'xy': [r2(x), r2(y)], 'z': r2(129.42 + (128.75 - 129.42) * t / s[-1])} for (x, y), t in zip(v[1:-1], s[1:-1])] + [node(N_J)])

# ---------- 거두기, 노드 옮기기 ----------
op('U01 지하 1층 북쪽 차로 거둠', 'retire_feature', {'type': 'road', 'id': R['old'], 'expectedRevision': 1}, '규칙(근거 없는 선)', 'U01 이 옛 지하주차장 통로의 북쪽 끝에 맞춰 그은 선. 그 통로를 보행 동선으로 바꿔 필요 없다')
for ref, nid, p in (('지하 1층 들머리', N_J0, AP['junction']), ('U자 경사로 머리', N_S0, RP['top']), ('지하 1층 주차 자리', N_C1, P['C1']), ('지하 2층 주차 자리', N_C2, P['C2']), ('혜인관 계단 아래', N_HBOT, HY['bottom'])):
    op(f'{ref} 노드', 'move_node', {'nodeId': nid, 'to': p}, '추정(자리), 확정(높이 띠)', f"{LINES}. 지하 1층 바닥 {Z1} m(범위 140.1~141.7), 지하 2층 바닥 {Z2} m(±1)")

# ---------- 새 길 ----------
road('U자 경사로', f"운동장 지하 1층–지하 2층 U자 경사로 (섬을 끼고 180도 + 곧은 구간. {RP['lengthM']} m 에 {RP['dropM']} m, 경사 {RP['gradePct']:.1f} %. 모양은 확정, 자리·치수 추정)",
     [node(N_S0)] + RP['arc'] + [RP['curveEnd'], {'at': {'roadId': R['b2'], 'vertexIndex': 0}}], RP['laneWidthM'], '확정(U자 경사로: 사용자 사진 03·04), 원천(서쪽: 지도의 반원 표시), 추정(자리·반지름·길이)',
     f"사용자 사진 2026-10-12(지하 1층에서 지하 2층으로 내려가는 길: 청록 벽 반원 섬, 곧은 한 차로 경사로). {MAP}의 주차장 서쪽 반원 표시와 {RP['mapSymbolOffM']} m. 층 차 {RP['dropM']} m 는 사용자 선 그대로", structure='ramp')
road('보행 동선(들머리 ~ 계단 발치)', '운동장 지하 1층 보행 동선 (북서 들머리 ~ 은주관 문 앞. 선 추정)', [node(N_J0), P['SBN']], 2, '원천(안내 글), 추정(선)', f'{BLOG}: 주차장을 건너 은주관 간판 옆 문으로', cls='pedestrian', ped='allowed', veh='prohibited')
road('은주1관 3층 문', "운동장 지하 1층 ~ 은주1관 3층 문 ('은주관' 간판·주차관리센터 옆. 문 자리는 학교 지도의 초록 점, 문 안쪽 높이 미정)", [P['SBN'], P['DOOR']], 2, '원천(문이 있고 은주1관 3층으로 이어진다), 추정(자리 ±3 m)',
     f"{BLOG} 사진 06: 주차장 벽의 '주차관리센터'·'은주관' 간판 오른쪽 문으로 들어가면 은주1관 3층. {MAP}의 은주1관 북서 초록 점(연결 층 3층)과 {M['eunju']['doorMapDotOffM']} m. 문 안에 난간 달린 계단이 보인다(오르내림 판독 불확실): 문 안쪽은 U03", cls='pedestrian', ped='allowed', veh='prohibited')
road('운동장 계단', f"운동장 지하 1층 ~ 운동장 계단 (은주관 문 오른쪽. {Z1} → {ZF} m, 높이 차 {M['eunju']['stairRiseM']} m. 있음은 원천, 자리·모양 추정)", [P['SBN'], P['ST']], 2, '원천(문 오른쪽 계단으로 운동장에 바로 간다), 추정(자리·위 끝)',
     f"{BLOG}: \"화살표 오른쪽에 보이는 계단을 이용하면 운동장으로 바로 갈 수 있습니다\". 위 끝은 은주1관 북쪽 끝 옆 운동장 면(추정). 높이 차는 줄이지 않았다", structure='stairs', cls='pedestrian', ped='allowed', veh='prohibited')

# ---------- 장소 ----------
for pid, name, key, z in (('3f9a0e6c-be18-4e53-bb4f-7a52e0ad99ea', '운동장 지하 1층 주차장', 'C1', Z1), ('551f3d72-de23-429a-9ed3-a655fd724933', '운동장 지하 2층 주차장', 'C2', Z2)):
    op(f'장소 {name}', 'update_place', {'id': pid, 'expectedRevision': 1, 'description': f'U02. 사용자 2026-10-12 단면 표시로 높이를 고침: 바닥 {z} m. 학교 지도에 주차 줄이 그려진 사다리꼴(운동장보다 북쪽이 좁다). 이름·표지 자리는 추정', 'position': P[key]},
       '확정(층·높이 띠), 추정(이름·자리)', LINES)
op('장소 은주1관 3층 문', 'create_place', {'name': '은주1관 지하통로 입구 (3층, 운동장 지하 1층 주차장 쪽 문. 자리 ±3 m)', 'category': 'building_entrance', 'buildingId': '은주관',
   'description': f"U02. {BLOG}: 주차장 벽 '은주관' 간판 옆 문 → 은주1관 3층. {MAP}의 초록 점. 문 안쪽 길은 아직 없음(U03)", 'position': P['DOOR']}, '원천(있음·층), 추정(자리)', BLOG)
out = {'id': 'U02', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U02: 운동장 지하 1층 141.4 m·지하 2층 133.0 m, 지하 차도가 지하 1층 북서 모서리로, U자 경사로, 혜인관 안 계단·은주1관 3층 문·운동장 계단, 제2주차장 쪽 선', 'ops': ops, 'numbers': {'p1ToJoinM': r2(s[-1])}}
# ---------- U02b: 적용 뒤 고침. 보행 동선이 지하 1층 차로 둘과 같은 높이에서 노드 없이 엇갈려 길 검사 오류 2건이 났다 → 차로를 건너지 않게 돌린다 ----------
ops_b = [{'ref': '보행 동선을 차로 밖으로', 'op': 'update_road', 'args': {'id': R['pass'], 'expectedRevision': REV_PASS, 'zMode': 'explicit', 'densify': False, 'path': [node(N_HBOT), HY['out']] + HY['via'] + [node(N_J0)]},
          'grade': '원천(주차장을 가로질러 은주관 문으로), 추정(선)', 'evidence': f'{BLOG}. 주차 자리 동쪽과 들머리 차로 북동쪽으로 돌아 차로와 엇갈리지 않게 함(실제 걷는 선은 모름)'}]
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'u02b.json').write_text(json.dumps({'id': 'U02b', 'zone': out['zone'], 'comment': 'U02b: 지하 1층 보행 동선이 차로를 건너지 않게', 'ops': ops_b}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
(HERE / 'groups' / 'u02.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), out['numbers'])
