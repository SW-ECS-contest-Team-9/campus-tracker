"""G02: 내리막길(오르막길)의 기본 평면과 그 위에 얹는 구조물 상자를 만든다. DB·네트워크 접근 없음.
  python -I build_inputs.py
쓰는 파일:
  backend/data/terrain/recipes/g02-surface.geojson       기본 평면(지형 조리법의 surface 단계 입력)
  backend/data/terrain/recipes/g02-smooth-ground.json    조리법 = F05 조리법에서 UPHILL 띠 새김을 빼고 surface 단계를 더한 것
  docs/audit/g02/structures-g02.geojson                  구조물 상자(프런트 보정 레이어 형식: kind=extrude, fromM→toM)
  docs/audit/g02/model.json                              띠·가운데 선·평면·벽 선과 근거·등급
좌표는 길 축 (s, t) 로 적고 EPSG:5186 으로 옮긴다(common.py). 등급: 확정 / S-MAP / 추정.
"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
REPO = HERE.parents[2]; REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'
r2 = lambda v: round(float(v), 2)
def ring_xy(pts):
    p = [[r2(x), r2(y)] for x, y in pts]; return p + [p[0]]
def ring(st): return ring_xy([st_to_xy(s, t) for s, t in st])
def rect(s0, s1, t0, t1): return [(s0, t0), (s1, t0), (s1, t1), (s0, t1)]
PROFILE = {'origin': [float(O[0]), float(O[1])], 'direction': [float(U[0]), float(U[1])], 'points': [[s, z] for s, z in WAY_PROFILE]}
SRC_MESH = 'S-MAP 3D 뷰어 메시 0.5 m 판독(g02/smap-mesh-g02-way-05m-a~d.txt, 2026-10-11)'
dump = lambda path, obj: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}

# ---------- 1. 기본 평면 (지형이 싣는 것) ----------
T_S, T_N = -5.5, 17.5   # 본관 북벽(t=-4.9)과 북쪽 건물 벽 안쪽까지 덮는다(건물 칸은 조리법이 그대로 둔다)
planes = [
  dict(name='WAY', st=[(3, T_S), (69.3, T_S), (69.3, -2.5), (101, -2.5), (101, -3), (113.2, -3), (112.6, -1), (108.3, 10), (107.5, T_N), (0, T_N), (0, 8.5), (-2, 8.5), (-2, 7), (0, 3), (3, -3)],
       profile=True, grade='S-MAP',
       reason='G02 내리막길 기본 경사면: 가운데 경사로의 S-MAP 높이에 맞춘 평면 조각 4개(폭 방향 평평). 본관 북벽에서 북쪽 건물 벽까지 한 평면. 아래 끝은 회차 공간 포장면 130.6 m(T06), 위 끝은 운동장 148.9 m(F05 경계)에 벽 없이 닿는다.'),
  dict(name='LANE', st=rect(0, 31.5, 8.5, T_N), heightM=132.5, grade='S-MAP',
       reason='G02 북악관 동쪽 낮은 마당: S-MAP 132.4~132.9 m, 사용자 핀 U100 132.3·U102 132.5. 길 경사면과는 화단 상자와 벽면으로 만난다.'),
  dict(name='PODIUM', st=rect(31.5, 50, 6.5, T_N), heightM=138.8, grade='S-MAP',
       reason='G02 문예관 기단 테라스: S-MAP 138.7~138.8 m, 사용자 핀 U094·U096 138.8. 서쪽 끝은 낮은 마당 위 6.3 m 벽면.'),
  dict(name='FORK', st=rect(67, 76, 9, T_N), heightM=144.2, grade='S-MAP',
       reason='G02 갈림 지점 평탄면: S-MAP 143.6~144.2 m, 사용자 사진 8 의 144.2, 핀 U089 143.7.'),
  dict(name='TOP', st=rect(76, 93.3, 9.5, T_N), heightM=145.5, grade='S-MAP',
       reason='G02 대일관 서쪽 끝 앞 평탄부: S-MAP 145.3~145.8 m, 사용자 사진 8 의 145.4, 핀 U081·U085 145.6·U088 145.4. 동쪽 끝(s 93.3)에서 길 경사면과 같은 높이.'),
]
feats = []
for p in planes:
    props = {'name': p['name'], 'srid': 5186, 'reason': p['reason'], 'grade': p['grade'], 'source': SRC_MESH}
    if p.get('profile'): props['profile'] = PROFILE
    else: props['heightM'] = p['heightM']
    feats.append({'type': 'Feature', 'properties': props, 'geometry': {'type': 'Polygon', 'coordinates': [ring(p['st'])]}})
dump(REC / 'g02-surface.geojson', {'type': 'FeatureCollection', 'name': 'g02-surface', 'crs': CRS, 'features': feats})

f05 = json.loads((REC / 'f05-smooth-ground.json').read_text(encoding='utf-8'))
steps = json.loads(json.dumps(f05['steps']))
for s in steps:
    if s['type'] == 'corridor': s['lines'] = [l for l in s['lines'] if l != 'UPHILL']
steps.append({'type': 'surface', 'file': 'g02-surface.geojson'})
dump(REC / 'g02-smooth-ground.json', {'crs': 'EPSG:5186', 'protectBuildings': True,
  'reason': 'G02: F05 조리법에서 오르막 보행로 띠 새김(UPHILL, 아래 67 m·폭 9 m)을 빼고, 내리막길 전체(110 m)를 기본 평면으로 넣음: 경사면 하나(평면 조각 4개)와 평탄면 넷(북악관 동쪽 마당 132.5, 문예관 기단 138.8, 갈림 지점 144.2, 대일관 서쪽 끝 앞 145.5 m). 평면끼리는 번짐 없이 벽면으로 만난다. 계단·화단·옹벽은 지형이 아니라 구조물 파일(docs/audit/g02/structures-g02.geojson)이 싣는다.',
  'steps': steps})

# ---------- 2. 구조물 상자 (지형 위에 얹는 것) ----------
S_PLANTER, S_PAVE, RAMP_N, STRIP_N = -3.5, -1.9, 3.3, 5.5   # 띠 경계 t (사진 눈대중, 추정 ±0.5 m)
boxes = []
def box(id, typ, rng, fromM, toM, assumption, source, grade='추정', **extra):
    boxes.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra},
                  'geometry': {'type': 'Polygon', 'coordinates': [rng]}})
PH = '사용자 사진 20·21·26·31, 거리뷰 09, SKU 영상 0:52~1:00, DAKNAT 영상 3:12~3:24·5:21~5:35'
ZS = [p[1] for p in WAY_PROFILE]; SS = [p[0] for p in WAY_PROFILE]
# 계단식 보행 띠: 한 단 0.155 m, 디딤 깊이 = 한 단 / 길 경사. 디딤판 윗면 = 그 칸 위쪽 끝의 경사면 높이(경사면 아래로 내려가지 않음)
RISER = 0.155; s = 5.0; n = 0; treads = []
while s < 67 - 1e-6:
    s1 = min(float(np.interp(way_z(s) + RISER, ZS, SS)), 67.0)
    n += 1; treads.append((s, s1, float(way_z(s1))))
    box(f'G02-STRIP-T{n:02d}', 'stair_step', ring(rect(s, s1, RAMP_N, STRIP_N)), way_z(s) - 0.02, way_z(s1),
        f'계단식 보행 띠 디딤판 {n}: 한 단 {RISER} m(가정), 깊이 {s1 - s:.2f} m = 한 단 ÷ 길 경사, 폭 {STRIP_N - RAMP_N:.1f} m(사진 눈대중). 단 수는 세지 않고 높이차에서 계산', PH, stair='G02-STEPPED-STRIP')
    s = s1
# 남쪽 화단 옹벽(본관 쪽): 2 m 마디, 윗면 = 경사면 + 1.0 m, 본관으로 통하는 문 앞은 비움
for a in np.arange(3.3, 69.3, 2.0):
    b = min(a + 2.0, 69.3)
    if a >= 59.2 and b <= 63.4: continue
    box(f'G02-SWALL-{int(round(a)):02d}', 'planter', ring(rect(a, b, -4.9, S_PLANTER)), way_z(a), way_z((a + b) / 2) + 1.0,
        '남쪽 화단(흰 거친 돌 옹벽 + 소나무): 윗면 = 길 경사면 + 1.0 m(허리 높이, 추정 0.9~1.2), 폭 1.4 m(추정). s 59.3~63.3 은 본관으로 통하는 문 앞이라 비움(자리 추정 ±3 m)', PH + ', SKU 0:58 "오른쪽엔 본관으로 통하는 통로"')
# 북쪽 화단 섬(s 5~30.5, 낮은 마당과 길 사이): 층층이 오르는 어두운 화강석 벽, 5.1 m 마디
for a in np.arange(5.0, 30.4, 5.1):
    b = min(a + 5.1, 30.5)
    box(f'G02-NPLANT-A{int(round(a)):02d}', 'planter', ring(rect(a, b, STRIP_N, 8.5)), min(132.5, way_z(a)), way_z(b) + 0.45,
        '북쪽 화단 섬(북악관 동쪽 마당과 길 사이): 화강석 벽이 약 5 m 마디로 층층이 오름, 윗면 = 마디 위쪽 끝의 경사면 + 0.45 m(추정). 평면은 S-MAP 정사 그림의 나무 자리(±1 m)', PH + ', g02/smap-ortho-rectified-01m.png')
box('G02-NPLANT-DRUM', 'planter', ring([(0.2, 6.2), (2.8, 6.2), (3.4, 7.6), (2.8, 9.0), (0.2, 9.0), (-0.4, 7.6)]), 130.6, 131.5, '입구 왼쪽 둥근 화강석 화단: 높이 0.9 m, 지름 약 3 m(거리뷰 09 눈대중)', '거리뷰 09')
# 문예관 기단으로 오르는 옆 계단(s 31.5~34): 띠(t 5.5)에서 기단(138.8)까지
z0 = float(way_z(32.5)); nr = int(round((138.8 - z0) / 0.157)); run = 0.30
for k in range(nr):
    box(f'G02-PODIUM-STAIR-S{k + 1:02d}', 'stair_step', ring(rect(31.5, 34.0, STRIP_N + k * run, STRIP_N + (k + 1) * run)), z0 - 0.5, z0 + (k + 1) * (138.8 - z0) / nr,
        f'문예관 기단(138.8 m)으로 오르는 옆 계단: {nr}단 = (138.8 − {z0:.2f}) ÷ 0.157, 디딤 0.30 m, 폭 2.5 m(모두 가정). 자리는 정사 그림에서 화단이 끊기는 곳과 사진 21 의 가로등 옆 계단', '사용자 사진 21, SKU 0:54, g02/smap-ortho-rectified-01m.png', stair='G02-PODIUM-STAIR')
box('G02-NPLANT-B', 'planter', ring(rect(34.0, 50, STRIP_N, 6.5)), way_z(34.0), 138.8 + 0.45, '문예관 기단 앞 화단 벽: 윗면 = 기단 138.8 + 0.45 m(추정)', PH)
for a in np.arange(50.0, 65.9, 5.34):
    b = min(a + 5.34, 66.0)
    box(f'G02-NPLANT-C{int(round(a)):02d}', 'planter', ring(rect(a, b, STRIP_N, 9.5)), way_z(a), way_z(b) + 1.2,
        '문예관 낮은 날개(카페) 앞 화단: 큰 화강석 상자에 관목, 윗면 = 마디 위쪽 끝 경사면 + 1.2 m(S-MAP 이 +1~+2 m 로 읽힘, 사진 26 눈대중)', '사용자 사진 25·26, ' + SRC_MESH)
# 갈림 계단(길 141.0 → 갈림 지점 144.2): 시험용 DB 길 040d4571 의 선을 따라 2 m 폭
fork = np.array([(201106.2, 557324.7), (201108.9, 557326.2), (201110.8, 557328.5), (201111.6, 557330.8), (201111.8, 557333.1)])
d = np.r_[0, np.cumsum(np.hypot(*np.diff(fork, axis=0).T))]
zb = float(way_z(xy_to_st(*fork[0])[0])); nr = int(round((144.2 - zb) / 0.16))
at = lambda q: np.array([np.interp(q, d, fork[:, 0]), np.interp(q, d, fork[:, 1])])
for k in range(nr):
    pa, pb = at(d[-1] * k / nr), at(d[-1] * (k + 1) / nr); v = (pb - pa) / np.hypot(*(pb - pa)); w = np.array([-v[1], v[0]])
    box(f'G02-FORK-STAIR-S{k + 1:02d}', 'stair_step', ring_xy([pa + w, pb + w, pb - w, pa - w]), zb - 0.3, zb + (k + 1) * (144.2 - zb) / nr,
        f'갈림 계단(문예관 3층 로비로 가는 옆 계단): {nr}단 = (144.2 − {zb:.2f}) ÷ 0.16, 폭 2 m(가정). 선은 사용자 그림 10 을 옮긴 시험용 DB 길 040d4571(±3 m)', '사용자 확정(오르막길 중간에 옆으로 빠지는 계단), 그림 10, 시험용 DB 길 040d4571', stair='G02-FORK-STAIR')
for a in np.arange(76.0, 91.9, 5.34):
    b = min(a + 5.34, 92.0)
    box(f'G02-NPLANT-D{int(round(a)):02d}', 'planter', ring(rect(a, b, STRIP_N, 9.5)), way_z(a), 145.5 + 0.45, '대일관 서쪽 끝 앞 평탄부(145.5 m)와 길 사이 화단: 윗면 = 145.5 + 0.45 m(추정). 평면은 정사 그림의 나무 자리', '사용자 사진 8, 그림 11, g02/smap-ortho-rectified-01m.png')
for a in np.arange(69.3, 100.9, 2.0):
    b = min(a + 2.0, 101)
    box(f'G02-HWALL-{int(round(a)):03d}', 'planter', ring(rect(a, b, -2.5, -1.3)), way_z(a), way_z((a + b) / 2) + 0.9, '한림관 쪽 가장자리 화단·난간: 윗면 = 경사면 + 0.9 m, 폭 1.2 m, 선 자리 t = −2.5 는 S-MAP 이 꺼지기 시작하는 곳(±1.5 m). 모두 추정', '사용자 사진 30, 그림 11, ' + SRC_MESH)
box('G02-BARRIER-POST', 'barrier', ring(rect(4.3, 4.8, RAMP_N - 0.5, RAMP_N)), way_z(4.3), way_z(4.5) + 1.1, '차단기 기둥(노란 상자), 자리 s 4.5 ±2 m', '거리뷰 09, SKU 0:52')
box('G02-BARRIER-ARM', 'barrier', ring(rect(4.45, 4.6, S_PAVE + 0.6, RAMP_N - 0.5)), way_z(4.5) + 0.9, way_z(4.5) + 1.0, '차단기 막대: 경사로 폭을 가로막음', '거리뷰 09, SKU 0:52')
dump(HERE / 'structures-g02.geojson', {'type': 'FeatureCollection', 'name': 'structures-g02', 'crs': CRS,
  'provenance': {'builder': 'docs/audit/g02/build_inputs.py', 'basePlanes': 'backend/data/terrain/recipes/g02-surface.geojson', 'note': '모든 상자는 기본 평면 위에 얹힌다. 치수는 사진 눈대중이라 전부 estimated.'},
  'features': boxes})

# ---------- 3. 모델 요약(띠·가운데 선·벽 선) ----------
def line(st, zf): return [[*[r2(c) for c in st_to_xy(s_, t_)], r2(zf(s_))] for s_, t_ in st]
ss = [0, 5, 10, 20, 30, 40, 55, 67, 76, 85, 93.3, 100, 110]
strips = [
  dict(id='south_planter', t=[-4.9, S_PLANTER], s=[3.3, 69.3], top='경사면 + 1.0 m', grade='추정', carried_by='구조물'),
  dict(id='south_pavement', t=[S_PLANTER, S_PAVE], s=[3.3, 69.3], top='경사면(경계석 선만, 단차 없음으로 봄)', grade='추정(폭)', carried_by='지형(경사면)'),
  dict(id='ramp', t=[S_PAVE, RAMP_N], s=[0, 110], top='경사면', grade='S-MAP(높이), 추정(폭 5.2 m)', carried_by='지형(경사면)'),
  dict(id='stepped_strip', t=[RAMP_N, STRIP_N], s=[5, 67], top=f'디딤판 {n}칸, 한 단 {RISER} m', grade='추정', carried_by='구조물(디딤판 상자). 지형에서는 경사면'),
  dict(id='north_planters', t=[STRIP_N, '6.5~9.5'], s=[5, 92], top='마디마다 다름(구조물 파일)', grade='추정', carried_by='구조물'),
]
for st_ in strips:
    if st_['id'] in ('south_pavement', 'ramp', 'stepped_strip'):
        tm = (st_['t'][0] + st_['t'][1]) / 2; st_['centreline'] = line([(s_, tm) for s_ in ss if st_['s'][0] <= s_ <= st_['s'][1]], way_z)
walls = [
  dict(id='podium_west_wall', line=line([(31.5, 6.5), (31.5, T_N)], lambda s_: 138.8), topM=138.8, bottomM=132.5, grade='S-MAP', source=SRC_MESH + ' (기울기 그림에서 가장 가파른 줄)'),
  dict(id='podium_south_wall', line=line([(31.5, 6.5), (50, 6.5)], lambda s_: 138.8), topM=138.8, bottomM='경사면 135.5~138.2', grade='S-MAP(높이), 추정(선 ±1 m)', source=SRC_MESH),
  dict(id='lane_south_wall', line=line([(12.3, 8.5), (31.5, 8.5)], way_z), topM='경사면 132.5~135.5', bottomM=132.5, grade='S-MAP(높이), 추정(선)', source=SRC_MESH),
  dict(id='fork_south_wall', line=line([(67, 9), (76, 9)], lambda s_: 144.2), topM=144.2, bottomM='경사면 141.0~142.6', grade='S-MAP(높이), 추정(선)', source=SRC_MESH),
  dict(id='fork_top_step', line=line([(76, 9.5), (76, T_N)], lambda s_: 145.5), topM=145.5, bottomM=144.2, grade='S-MAP', source='사진 8(144.2/145.4), 시험용 DB 계단 a7a51d3c'),
  dict(id='top_south_wall', line=line([(76, 9.5), (93.3, 9.5)], lambda s_: 145.5), topM=145.5, bottomM='경사면 142.6~145.5', grade='S-MAP(높이), 추정(선)', source=SRC_MESH),
  dict(id='hanlim_side_wall', line=line([(69.3, -2.5), (101, -2.5)], way_z), topM='경사면 141.4~146.9', bottomM='모름(S-MAP 133~137, 본관·한림관 사이 꺼진 자리)', grade='추정', source=SRC_MESH + ', 사진 30'),
  dict(id='main_building_wall', line=line([(3.3, -4.9), (69.3, -4.9)], way_z), topM='건물', bottomM='경사면', grade='원천(건물 외곽)', source='building-outlines-5186.json'),
]
dump(HERE / 'model.json', {'crs': 'EPSG:5186', 'axis': {'origin': [float(O[0]), float(O[1])], 'unit': [float(U[0]), float(U[1])], 'north_unit': [float(N[0]), float(N[1])], 'note': 's = 아래 끝에서 위로, t = 북쪽(문예관 쪽) +'},
  'way_profile': [{'s': s_, 'z': z_} for s_, z_ in WAY_PROFILE], 'base_planes': [{'name': p['name'], 'heightM': p.get('heightM', 'profile'), 'grade': p['grade'], 'st': p['st']} for p in planes],
  'strips': strips, 'stepped_strip': {'riserM': RISER, 'treads': len(treads), 'riseM': r2(way_z(67) - way_z(5)), 'grade': '추정(사진에서 세지 않음)'},
  'walls': walls, 'underground': {'road': '951c157d 지하 차도', 'note': '경사면 아래의 따로 떨어진 상자(빈 곳). 지형에 새기지 않는다. 덮개 두께는 preview.py'}})
print('planes', len(feats), 'boxes', len(boxes), 'treads', n)
