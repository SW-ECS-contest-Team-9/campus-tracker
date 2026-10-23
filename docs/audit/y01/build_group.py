"""Y01 시험용 DB 변경 묶음: 은주2관 입구(1) 문 → 은주2관–수인관 통로 → 풋살장 앞 마당 길 + 윗길 끝 노드의 솟은 높이 고치기. DB 는 읽기만(docker psql).
  python -I build_group.py -> groups/y01-futsal-yard.json
적용: C:\\campus-tracker-testdb\\backend 에서 npx tsx ../docs/audit/n02/n02.ts apply ../docs/audit/y01/groups/y01-futsal-yard.json <결과> --commit (시험용 DB 만).
근거: 볼트 건물 노트 수인관·구역 노트 은주관 둘레와 풋살장 2026-10-23 절."""
import json, pathlib, subprocess, sys
import numpy as np
from shapely.geometry import Point, Polygon, LineString, shape
from shapely.ops import unary_union
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; STR = REPO / 'frontend' / 'public' / 'structures'
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
r2 = lambda v: round(float(v), 2)
Z = 132.2
SUIN = [[201102.94, 557190.11], [201125.57, 557204.29], [201192.29, 557144.08], [201174.74, 557125.62], [201148.21, 557110.27]]
(door, dx, dy, dz), = q("select id, st_x(geom), st_y(geom), st_z(geom) from mobility.network_nodes where id::text like 'e5ea7a83%'")
(top, tz), = q("select id, st_z(geom) from mobility.network_nodes where id::text like '98909b6c%'")
assert abs(float(dz) - Z) < 0.01 and min(abs(float(tz) - 133.93), abs(float(tz) - 130.92)) < 0.01, (dz, tz)   # 적용 뒤에는 130.92
# 건물 발자국(수인관 빼고): 시험 서버 장면(읽기만)
import urllib.request
from pyproj import Transformer
tr = Transformer.from_crs(4326, 5186, always_xy=True); blds = []
for b in json.load(urllib.request.urlopen('http://127.0.0.1:3210/api/v1/scene'))['buildings']:
    if b['buildingId'] == '수인관': continue
    g = b['geometry']
    for poly in (g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]):
        xs, ys = tr.transform([c[0] for c in poly[0]], [c[1] for c in poly[0]]); blds.append(Polygon(list(zip(xs, ys))).buffer(0))
B = unary_union(blds) if blds else Polygon()
roof = Polygon(SUIN)
e = np.array(SUIN[2]) - np.array(SUIN[1]); L = float(np.hypot(*e)); e /= L
ne = np.array([-e[1], e[0]]); ne = ne if ne @ np.array([1, 1]) > 0 else -ne
P = lambda s, d: np.array(SUIN[1]) + e * s + ne * d
# 통로 선: 옥상 북동 변에서 1.2 m 밖(통로 띠 가운데쯤), 건물에서 0.3 m 넘게 떨어진 첫 자리부터
s1 = next(s for s in np.arange(1.0, 15.0, 0.25) if B.distance(Point(P(s, 1.2))) > 0.3)
N1 = P(s1, 1.2)
# 마당 가운데: 바닥 글자 SKU Futsal PARK 의 가운데(사진의 B·A 구역 사이), 코트 칠 판에서 0.5 m 밖이어야 함
courts, text = [], []
for f in json.loads((STR / 'p01-parts.geojson').read_text(encoding='utf-8'))['features']:
    i = f['properties']['id']
    if i.startswith('P01-SUIN-COURT-') and i.count('-') == 3: courts.append(shape(f['geometry']))
    if i.startswith('P01-SUIN-TEXT-') and 'MARK' not in i: text.append(shape(f['geometry']))
N3 = np.array(unary_union(text).centroid.coords[0])
assert unary_union(courts).distance(Point(N3)) > 0.5 and roof.contains(Point(N3))
s3 = float((N3 - np.array(SUIN[1])) @ e); N2 = P(s3, 1.2)
# 문 → 통로: 접합부 남서 날개 발자국을 돌아 옥상 북동 변 안쪽(0.8 m)으로 들어갔다가 통로로
V = next(P(s, -0.8) for s in np.arange(0.0, 15.0, 0.25) if B.distance(Point(P(s, -0.8))) > 0.3 and LineString([(float(dx), float(dy)), tuple(P(s, -0.8))]).intersection(B).length < 0.01)
line = LineString([(float(dx), float(dy)), tuple(V), tuple(N1), tuple(N2), tuple(N3)])
hit = line.intersection(B).length
print('V', V.round(2), 'N1', N1.round(2), 'N2', N2.round(2), 'N3', N3.round(2), '건물 안 길이', round(hit, 2), '선 길이', round(line.length, 1))
EV = '볼트 건물 노트 수인관·구역 노트 은주관 둘레와 풋살장 2026-10-23 절. 사용자 드론·항공 사진(보완자료/학교-전경-20261022/항공/드론-풋살파크-정문-혜인관.webp, 항공-은주2관-풋살파크-정문.webp)'
G = '확정(통로·마당이 트인 같은 높이 바닥: 사용자 사진), S-MAP(높이 132.0~132.2), 추정(선 ±1.5 m)'
ops = [
    {'ref': '윗길 끝 노드 98909b6c 높이 133.93 → 130.92 (솟은 한 점, 사용자 핀 U034·기단 U1X-01)', 'op': 'move_node',
     'args': {'nodeId': top, 'to': {'xy': [201112.12, 557211.18], 'z': 130.92}},
     'grade': 'S-MAP(사용자 핀 U034 130.9, 실험 V02), 원천(같은 자리 기단 U1X-01 시작 높이 130.92)',
     'evidence': '구역 노트 은주관 둘레와 풋살장 2026-10-23 절: 저장 133.93 m 는 앞뒤 꼭짓점 130.81·131.19 m 보다 3 m 솟은 한 점'},
    {'ref': '은주2관 입구(1) 문 → 통로 → 풋살장 앞 마당', 'op': 'create_road', 'grade': G, 'evidence': EV,
     'args': {'roadClass': 'pedestrian', 'structure': 'ordinary', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'widthM': 2.5,
              'name': '은주2관 입구(1) ~ 은주2관–수인관 통로 ~ 풋살장 앞 마당 (132.2 m 평평. 사진 판독, 선 추정)', 'zMode': 'explicit', 'densify': False,
              'path': [{'at': {'nodeId': door}}] + [{'xy': [r2(p[0]), r2(p[1])], 'z': Z} for p in (V, N1, N2, N3)]}},
]
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'y01-futsal-yard.json').write_text(json.dumps({'id': 'Y01-FUTSAL-YARD', 'comment': '은주2관–수인관 통로와 풋살장 앞 마당 길, 윗길 끝 솟은 높이 고치기(시험용 DB 만)', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), 'ops')

# ---- 묶음 2(첫 묶음 적용 뒤): 통로 길(60ef7429)의 N2 에서 남동 끝(C 구역 쪽)까지 가지. 마당·통로 띠가 남동 끝에서 꺾여 면 위 직선으로는 N2 에서 안 보인다 ----
C1 = HERE / 'y01-commit.json'
if C1.exists():
    road = next(r for x in json.loads(C1.read_text(encoding='utf-8'))['results'] if x['op'] == 'create_road' for r in x['roads'])
    s4 = next(s for s in np.arange(L - 4.0, s3, -0.5) if B.distance(Point(P(s, -1.0))) > 0.3)
    N4 = P(s4, -1.0)
    M = P(s3 + 2.0, -1.0)   # 먼저 옥상 북동 변 안쪽(1 m)으로 들어가 변을 따라 감(남동 끝 날개 발자국이 변에 닿음)
    assert LineString([tuple(N2), tuple(M), tuple(N4)]).intersection(B).length < 0.01, LineString([tuple(N2), tuple(M), tuple(N4)]).intersection(B).length
    ops2 = [{'ref': '통로 길 N2 → 마당 남동 끝(C 구역 쪽)', 'op': 'create_road', 'grade': G, 'evidence': EV,
             'args': {'roadClass': 'pedestrian', 'structure': 'ordinary', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'widthM': 2.5,
                      'name': '은주2관–수인관 통로 ~ 풋살장 앞 마당 남동 끝 (132.2 m 평평. 사진 판독, 선 추정)', 'zMode': 'explicit', 'densify': False,
                      'path': [{'at': {'roadId': road['id'], 'nearest': [r2(N2[0]), r2(N2[1])]}}, {'xy': [r2(M[0]), r2(M[1])], 'z': Z}, {'xy': [r2(N4[0]), r2(N4[1])], 'z': Z}]}}]
    (HERE / 'groups' / 'y01-futsal-yard-2.json').write_text(json.dumps({'id': 'Y01-FUTSAL-YARD-2', 'comment': '통로 길에서 풋살장 앞 마당 남동 끝으로 가지(시험용 DB 만)', 'ops': ops2}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print('N4', N4.round(2), '가지 길이', round(float(np.hypot(*(N4 - N2))), 1))
