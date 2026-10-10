"""Z07: 건물에 붙는 덩어리 가운데 높이·외곽이 추정이라 건물 보정 파일에 못 넣는 것을 구조물 상자로 만든다. DB·네트워크 접근 없음.   python build_parts.py
  유담관: 둥근 돌 기단부(상자 Z03-YUDAM-DRUM)의 유리 로비 띠·창 띠 셋·옥상 정원, 굽은 회색 낮은 날개(분수 광장 서쪽 벽면)
  문예관: 초록 유리 저층부의 나머지(탑 남서면을 따라 북악관 쪽으로), 기단 테라스 서쪽 벽의 유리 면, 탑 아래 열린 기둥 층, 옥상 테두리 판
쓰는 파일: frontend/public/structures/z07-building-parts.geojson (형식 docs/audit/g02/STRUCTURES.md). 근거와 등급은 상자마다 적는다. 전부 estimated."""
import json, pathlib, sys
import numpy as np
from shapely.geometry import Polygon, LineString, shape
sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'z04'))
from common import building_polys
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
unit = lambda v: np.asarray(v, float) / np.hypot(*v)
def load(fn): return {f['properties']['id']: f for f in json.loads((STR / fn).read_text(encoding='utf-8'))['features']}
def geom(poly):
    poly = poly.buffer(0)
    if poly.geom_type != 'Polygon': poly = max(poly.geoms, key=lambda g: g.area)
    return {'type': 'Polygon', 'coordinates': [[[r2(x), r2(y)] for x, y in ring.coords] for ring in [poly.exterior, *poly.interiors]]}
FEATS = []
def box(id, typ, poly, fromM, toM, assumption, source, grade, basePlane, **extra):
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra}, 'geometry': geom(poly)})
def sq(c, h): return Polygon([(c[0] - h, c[1] - h), (c[0] + h, c[1] - h), (c[0] + h, c[1] + h), (c[0] - h, c[1] + h)])
def tree(tid, c, z, what, src, base):
    for part, mat, h, z0, z1 in (('TRUNK', 'trunk', 0.18, 0.0, 3.0), ('CROWN', 'foliage', 1.3, 2.8, 4.2), ('TOP', 'foliage', 0.75, 4.2, 5.2)):
        box(f'{tid}-{part}', 'tree', sq(c, h), z + z0, z + z1, f'{what}: 고르게 둔 단순한 나무(Z06 과 같은 모양, 전체 5.2 m). 실제 그루 수·자리가 아니다', src, '확정(여기에 나무가 있음: 사진), 추정(그루 수·자리·크기)', base, material=mat)

WIDE = '사용자-유담관분수-북악관앞-20261010/유담관-분수광장-넓게.jpg'; P30 = '사용자-SMAP높이-20261010/사진-30-문예관-원형고층부-사잇길.png'; PUP = '사용자-유담관분수-북악관앞-20261010/북악관앞-문예관-오르막.jpg'
Z03 = load('z03-fountain.geojson'); G02 = load('g02-way.geojson')

# ================= 유담관 둥근 돌 기단부(Z03-YUDAM-DRUM, 114.1~133.0 m 추정) =================
DRUM = shape(Z03['Z03-YUDAM-DRUM']['geometry']).buffer(0); ZP, ZD = 114.1, 133.0
DG = '확정(돌 원통·광장 높이의 유리 로비·창 줄 셋·소나무 옥상: 사용자 사진), 추정(창 띠 높이 = 층 표 7·8·9층, 옥상 133.0 m)'
DSRC = WIDE + ', 동 노트 유담관(층 표 6층 114.1 확정·7층 121.6·8층 125.4·9층 129.2 추정, 둥근 돌 기단부 133.0 추정), 구조물 Z03-YUDAM-DRUM'
RING = DRUM.buffer(0.15, join_style=2)
box('Z07-YUDAM-DRUM-LOBBY', 'wall', RING, ZP, 119.0, '둥근 돌 기단부의 광장 높이 유리 로비 띠(6층, 높이 4.9 m: 유리 차양 밑까지). 돌 덩어리 상자를 0.15 m 감싼 판이다(탑 쪽은 탑 안에 묻힌다)', DSRC, DG, 'Z03-YUDAM-DRUM', color='#4a86a6')
for name, z in (('7F', 121.6), ('8F', 125.4), ('9F', 129.2)):
    box(f'Z07-YUDAM-DRUM-WINDOWS-{name}', 'wall', RING, z + 0.9, z + 2.5, f'둥근 돌 기단부의 창 띠({name[0]}층, 층 표 바닥 {z} m 위 0.9~2.5 m). 사진의 창은 돌 기둥으로 네 토막씩 나뉘지만 한 띠로 그렸다', DSRC, DG, 'Z03-YUDAM-DRUM', color='#3f8fb5')
def pieces(g, least=4.0): return sorted([q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.area >= least], key=lambda q: -q.area)
for k, q in enumerate(pieces(DRUM.buffer(-1.0))): box(f'Z07-YUDAM-DRUM-GARDEN-{k + 1}', 'planter', q, ZD, ZD + 0.4, '둥근 돌 기단부의 옥상 정원(가장자리 1 m 안쪽 전체를 화단으로). 사진에 소나무가 고리 모양으로 서 있다', DSRC, DG, 'Z03-YUDAM-DRUM')
k = 0
for q in pieces(DRUM.buffer(-2.2), 2.0):
    for j in range(max(1, round(q.area / 14))): k += 1; c = q.buffer(-0.3).exterior if q.buffer(-0.3).geom_type == 'Polygon' and not q.buffer(-0.3).is_empty else q.exterior; tree(f'Z07-YUDAM-DRUM-TREE-{k}', c.interpolate((j + 0.5) / max(1, round(q.area / 14)), normalized=True).coords[0], ZD + 0.4, '둥근 돌 기단부 옥상의 소나무', WIDE, 'Z07-YUDAM-DRUM-GARDEN-1')

# ================= 유담관 굽은 회색 낮은 날개: 분수 광장 서쪽 가장자리의 벽면 =================
# 광장 기단(Z03-PLATFORM-PLAZA)의 서쪽 변 = S-MAP 이 114 → 93 m 로 떨어지는 벽의 윗선. 사진에서 날개의 옥상(나무)이 광장 높이로 이어지고 분수 서쪽에서 남서쪽으로 뻗는다 -> 그 벽면이 날개의 바깥벽이라고 보았다(추정)
EDGE = [(201045.5, 557220.3), (201051.5, 557217.3), (201055.0, 557214.3), (201059.5, 557211.2), (201061.5, 557208.2), (201063.5, 557205.2), (201065.5, 557202.1), (201067.5, 557199.1), (201069.5, 557196.0)]
assert all(any(abs(x - px) < 0.06 and abs(y - py) < 0.06 for px, py in Z03['Z03-PLATFORM-PLAZA']['geometry']['coordinates'][0]) for x, y in EDGE), '광장 기단의 서쪽 변이 바뀌었다'
WG = '확정(굽은 회색 낮은 날개가 있고 옥상에 나무, 창 줄 셋: 사용자 사진), 추정(자리 = 광장 서쪽 벽면, 옥상 = 광장 114.1 m + 난간 1.0 m, 창 줄 높이 = 층 표 5·3·2층, 창 크기·간격, 벽 아래 끝 93 m)'
WSRC = WIDE + ', 동 노트 유담관(굽은 회색 낮은 날개, 층 표 5층 109.0·3층 104.0·2층 99.0 추정), 구조물 Z03-PLATFORM-PLAZA(서쪽 변과 바닥 93.0)'
L = LineString(EDGE)
box('Z07-YUDAM-WING-WALL', 'wall', L.buffer(-0.5, single_sided=True, join_style=2), 93.0, ZP + 1.0, '굽은 회색 낮은 날개의 바깥벽: 광장 서쪽 변을 따라 0.5 m 두께, 아래는 광장 기단의 바닥(93.0 m), 위는 광장 + 1.0 m(난간). 날개의 안쪽은 광장 기단 덩어리 그대로다(따로 비우지 않음)', WSRC, WG, 'Z03-PLATFORM-PLAZA 의 서쪽 옆면', color='#5a5b5e')
n = 0
for (ax, ay), (bx, by) in zip(EDGE, EDGE[1:]):
    a, b = np.array([ax, ay]), np.array([bx, by]); u = unit(b - a); out = np.array([-u[1], u[0]]) * -1.0; ln = float(np.hypot(*(b - a)))   # 진행 방향(남동)의 오른쪽 = 남서 = 바깥
    cnt = max(1, int(ln // 3.2)); s0 = (ln - cnt * 3.2) / 2 + 0.7
    for c in range(cnt):
        n += 1; p = a + u * (s0 + c * 3.2)
        for name, z in (('5F', 109.0), ('3F', 104.0), ('2F', 99.0)):
            box(f'Z07-YUDAM-WING-WINDOW-{n:02d}-{name}', 'wall', Polygon([p + out * 0.45, p + u * 1.8 + out * 0.45, p + u * 1.8 + out * 0.62, p + out * 0.62]), z + 1.0, z + 2.6, f'낮은 날개의 흰 틀 창({name[0]}층 줄, 층 표 바닥 {z} m 위 1.0~2.6 m, 폭 1.8 m·간격 3.2 m)', WSRC, WG, 'Z07-YUDAM-WING-WALL', color='#e4e8e6')
GL = LineString(EDGE[:5])   # 옥상 화단: 분수 둘레 기둥 열에 닿기 전까지(북서쪽 26 m)
box('Z07-YUDAM-WING-GARDEN', 'planter', GL.buffer(3.2, single_sided=True, join_style=2).difference(GL.buffer(0.3, single_sided=True, join_style=2)), ZP, ZP + 0.45, '낮은 날개 옥상의 나무 심은 띠(광장 서쪽 가장자리 안쪽 0.3~3.2 m, 광장 + 0.45 m). 분수 둘레 기둥 열에 닿기 전까지만', WSRC, WG, 'Z03-PLATFORM-PLAZA 114.1')
for k in range(4):
    q = GL.interpolate((k + 0.5) / 4, normalized=True); t = GL.interpolate(min(GL.length, GL.project(q) + 0.5)); u = unit(np.array(t.coords[0]) - np.array(q.coords[0]))
    tree(f'Z07-YUDAM-WING-TREE-{k + 1}', np.array(q.coords[0]) + np.array([-u[1], u[0]]) * 1.75, ZP + 0.45, '낮은 날개 옥상의 소나무 줄', WIDE, 'Z07-YUDAM-WING-GARDEN')

# ================= 문예관 =================
MUNYE = building_polys()['문예관']
W = np.array([201082.3, 557348.2]); E = np.array([201109.9, 557335.7]); mu = unit(E - W); mn = np.array([mu[1], -mu[0]])   # 탑 남서면(30.3 m): W 에서 E 로 s, 길 쪽(남남서)으로 d
assert mn[1] < 0 and min(np.hypot(*(np.array(c) - W)) for c in MUNYE.exterior.coords) < 0.3
def mR(pts): return Polygon([W + mu * s + mn * d for s, d in pts])
MG = '확정(길 쪽으로 볼록한 초록 유리 저층부와 옥상의 나무, 그 뒤 탑 아래의 흰 기둥 층, 넓게 내민 옥상 테두리: 사용자 사진), S-MAP(저층부 옥상 148.8·옥상 테두리 +1.4 m), 추정(평면·범위·기둥 수·내민 길이)'
MSRC = P30 + ', ' + PUP + ', 동 노트 문예관(저층부의 나머지: 탑 남서면 폭, 앞으로 3~5 m, 윗면 148.8 추정. 층 표 5층 148.8·6층 152.5·7층 156.2 추정), 건물 원천 외곽'
LOW = shape({'type': 'Polygon', 'coordinates': [[[201097.29, 557337.76], [201098.75, 557340.41], [201109.8, 557335.39], [201110.25, 557335.68], [201108.75, 557330.75], [201097.25, 557335.75], [201097.29, 557337.76]]]})   # 이미 건물 추가로 들어간 옥상 정원 띠(추가-문예관저층부)
bulge = lambda s: 2.4 + 3.2 * np.sin(np.pi * (s + 2) / 40)   # 길 쪽으로 볼록: 서쪽 끝 2.9 m → 이미 있는 띠의 앞선(약 5.3 m)
POD = mR([(0.0, -0.1)] + [(s, float(bulge(s))) for s in np.arange(0.0, 18.51, 1.5)] + [(18.5, -0.1)]).difference(LOW.buffer(0.05)).difference(MUNYE)
box('Z07-MUNYE-PODIUM', 'wall', POD, 138.8, 148.8, '문예관 초록 유리 저층부의 나머지: 탑 남서면의 서쪽 모서리에서 18.5 m, 길 쪽으로 2.9~5.6 m 볼록(사진 30 의 굽은 유리 덩어리). 윗면 148.8 m = 이미 넣은 옥상 정원 띠와 같은 높이, 아래는 기단 테라스 138.8 m. S-MAP 은 이 자리를 138.8~140 m 지면으로 읽는다', MSRC, MG, 'G02-PLATFORM-PODIUM 138.8', color='#5f9a86', topColor='#7f9a6b')
for z in (144.8,): box('Z07-MUNYE-PODIUM-BAND-3F', 'wall', POD.buffer(0.12, join_style=1).difference(MUNYE), z - 0.3, z + 0.2, '저층부 유리의 층 띠(층 표 3층 바닥 144.8 m). 사진의 가로 띠는 더 촘촘하다', MSRC, MG, 'Z07-MUNYE-PODIUM', color='#cfe3da')
for k, s in enumerate((4.0, 10.0, 15.5)): tree(f'Z07-MUNYE-PODIUM-TREE-{k + 1}', W + mu * s + mn * 2.2, 148.8, '문예관 저층부 옥상 정원의 나무', P30, 'Z07-MUNYE-PODIUM')
# 기단 테라스(G02-PLATFORM-PODIUM 138.8)의 서쪽 벽면: 북악관 옆 낮은 마당(132.5) 위 6.3 m. 사진에서 북악관 끝 옆의 초록 유리가 마당 높이까지 내려온다
TER = shape(G02['G02-PLATFORM-PODIUM']['geometry']).buffer(0); minx = TER.bounds[0]
WEST = TER.intersection(Polygon([(minx - 1, 557300), (minx + 1.2, 557300), (minx + 1.2, 557400), (minx - 1, 557400)])).buffer(0.25, join_style=2).difference(TER.buffer(-0.05))
box('Z07-MUNYE-PODIUM-WESTFACE', 'wall', WEST, 132.5, 138.8, '기단 테라스 서쪽 벽면의 초록 유리 면(두께 0.25 m, 낮은 마당 132.5 m 에서 테라스 138.8 m 까지). 북악관 앞에서 보면 북악관 끝 옆의 초록 유리가 마당까지 내려온다. 폭은 테라스 서쪽 끝 그대로(추정)', MSRC, MG, 'G02-PLATFORM-LANE 132.5', color='#5f9a86')
# 탑 아래 열린 기둥 층: 저층부 옥상(148.8)에서 층 표 7층 바닥(156.2)까지, 남서면
box('Z07-MUNYE-OPEN-RECESS', 'wall', mR([(0.3, 0.0), (30.0, 0.0), (30.0, 0.14), (0.3, 0.14)]), 148.8, 156.2, '탑 아래 열린 기둥 층의 들임 면(어두운 판, 벽 앞 0.14 m): 저층부 옥상 148.8 m 에서 층 표 7층 바닥 156.2 m 까지 두 층 높이. 실제로 비어 있는 깊이는 모른다', MSRC, MG, '문예관 남서면', material='opening')
for k in range(6):
    s = 2.0 + k * 5.2
    box(f'Z07-MUNYE-OPEN-COLUMN-{k + 1}', 'wall', mR([(s, 0.14), (s + 0.9, 0.14), (s + 0.9, 1.04), (s, 1.04)]), 148.8, 156.2, '탑 아래 열린 층의 흰 기둥(0.9 m 각, 5.2 m 간격 6개: 수·간격 추정)', MSRC, MG, 'Z07-MUNYE-PODIUM / 추가-문예관저층부 옥상 148.8', material='white_stone')
box('Z07-MUNYE-ROOF-RIM', 'canopy', MUNYE.buffer(1.8, join_style=2), 189.0, 190.8, '문예관 옥상 테두리 판: 지붕 189.4 m 위 1.4 m(S-MAP 테두리 띠)까지, 벽 밖으로 1.8 m 내밂(내민 길이 추정). 밑의 받침살은 그리지 않음', MSRC, MG, '문예관 지붕 189.4', color='#c9cdca')

out = {'type': 'FeatureCollection', 'name': 'z07-building-parts', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/z07/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md',
                      'note': '건물에 붙는 덩어리 가운데 높이·외곽이 추정이라 건물 보정 파일에 넣지 못하는 것(건물 규칙서: 추정 높이는 건물 자료에 넣지 않는다). 사진에 있는 것만, 치수는 전부 추정.'}, 'features': FEATS}
(STR / 'z07-building-parts.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('features', len(FEATS))
