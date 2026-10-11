"""U01: 운동장 아래 지하 1층·지하 2층과 지하 차도 종착 구간. DB·네트워크 접근 없음.   python build_parts.py
쓰는 파일:
  frontend/public/structures/u01-field-basement.geojson   빈 곳(void)·기둥·경사로 판. 형식 docs/audit/g02/STRUCTURES.md (U01 절)
  docs/audit/u01/model.json                               높이·경사·길 선(시험용 DB 변경 묶음 build_groups.py 의 입력)
근거와 추정은 볼트 구역 노트 "운동장 아래 지하층과 지하 차도". 여기 숫자는 그 노트의 값이다. 전부 estimated.
z02/build_inputs.py 를 먼저 돌린다(운동장 슬래브 기단의 아랫면을 지하 2층 아래로 내린다).
"""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape
from shapely.ops import unary_union
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'; HERE = pathlib.Path(__file__).parent
r2 = lambda v: round(float(v), 2)
load = lambda fn: json.loads((STR / fn).read_text(encoding='utf-8'))['features']
SCENE = {b['id']: Polygon(b['ring']).buffer(0) for b in json.loads((REPO / 'docs/audit/z04/scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']}
BLD = unary_union(list(SCENE.values()))
FIELD = next(shape(f['geometry']) for f in load('z02-daeil-front.geojson') if f['properties']['id'] == 'Z02-PLATFORM-FIELD')
WAYF = next(f for f in load('g02-way.geojson') if f['properties']['id'] == 'G02-PLATFORM-WAY'); WAY = shape(WAYF['geometry']); WP = WAYF['properties']['topProfile']
def way_top(x, y):
    o, d, pts = np.array(WP['origin']), np.array(WP['direction']), np.array(WP['points']); return float(np.interp((x - o[0]) * d[0] + (y - o[1]) * d[1], pts[:, 0], pts[:, 1]))

# ---------- 높이 (구역 노트의 값) ----------
Z_FIELD = 148.9            # 측정(E06). 바꾸지 않는다
Z_B1 = 145.3               # 추정(145.0~145.6): 혜인관 지하 1층(운동장 높이 문, 148.9~149.3)에서 계단으로 3.8 m 내려간 옛 '지하주차장 통로' 기록
STOREY = Z_FIELD - Z_B1    # 3.6
Z_B2 = r2(Z_B1 - STOREY)   # 141.7 추정(140.8~142.3): 같은 층고로 한 층 더
SLAB_FIELD, SLAB_B1, BASE = 0.7, 0.6, 1.0   # 추정: 운동장 슬래브·지하 1층 바닥 판 두께, 지하 2층 아래 기초 판
C_B1, C_B2 = r2(Z_FIELD - SLAB_FIELD), r2(Z_B1 - SLAB_B1)   # 천장 148.2 / 144.7
WALL = 1.0                 # 추정: 둘레 벽 두께(운동장 외곽에서 들인 거리)
ROAD_W, CLEAR = 7.2, 3.5   # 지하 차도 폭(그림 14 의 횡단보도 길이, 추정 ±2) · 빈 곳 높이(G02 의 기존 구간과 같게)
ROOF = 0.6               # 추정: 내리막길 밑 덮개 판 두께
RAMP_W, RAMP_L = 6.0, 30.0 # 안쪽 경사로 폭·길이(추정). 경사 = 3.6 / 30 = 12.0 %

# ---------- 평면 ----------
INNER = FIELD.buffer(-WALL, join_style=2).difference(BLD.buffer(0.5)).buffer(0)
assert INNER.geom_type == 'Polygon', INNER.geom_type
P0 = np.array([201100.3, 557327.58]); Z_P0 = 136.39     # 시험용 DB 지하 차도 951c157d 의 위 끝(노드 55a87aa0)
D = np.array(WP['direction']); D = D / np.hypot(*D)     # 내리막길 축 = 지하 차도가 나란히 가는 방향(확정: 한 층 아래 나란한 길)
END = np.array([201210.58, 557271.18])                  # 옛 '지하주차장 통로' a789c985 의 북쪽 끝(노드 70261794)
far = P0 + D * 200
t_in = LineString([P0, far]).intersection(INNER).bounds   # 축이 지하층 안쪽 면과 만나는 곳
hit = LineString([P0, far]).intersection(INNER); hit = hit if hit.geom_type == 'LineString' else max(hit.geoms, key=lambda g: g.length)
ENTRY = np.array(hit.coords[0]); L_APP = float(np.hypot(*(ENTRY - P0)))
T = lambda t: ENTRY + D * t
A2 = T(10.0)                         # 지하 2층 갈림(차로가 갈라지는 곳)
R0, R1 = T(14.0), T(14.0 + RAMP_L)   # 안쪽 경사로 아래·위
B = T(14.0 + RAMP_L + 6.0)           # 지하 1층 갈림
C2, C1 = np.array([201185.0, 557250.0]), np.array([201200.0, 557245.0])   # 두 층의 종착 표지 자리(운동장 가운데쯤, 추정)
GRADE_APP = (Z_B2 - Z_P0) / L_APP; GRADE_RAMP = STOREY / RAMP_L
for name, p in (('A2', A2), ('R1', R1), ('B', B), ('C2', C2), ('C1', C1), ('END', END)): assert INNER.buffer(-3.0).contains(Point(p)), (name, p)
corridor = LineString([P0, ENTRY]).buffer(ROAD_W / 2, cap_style=2)
assert not corridor.intersects(BLD), '지하 차도 연장이 건물 평면과 겹친다'
off_end = LineString([ENTRY, T(120)]).distance(Point(END))

FEATS = []
SRC = '사용자 확정 2026-10-12(지하 차도 경사로의 종착지는 운동장 바로 아래의 지하 1층과 지하 2층), 시험용 DB 길 951c157d·a789c985·5aea9b42, 구역 노트 운동장 아래 지하층과 지하 차도'
def ring(poly): return [[[r2(x), r2(y)] for x, y in r.coords] for r in [poly.exterior] + list(poly.interiors)]
def feat(id, typ, kind, poly, grade, assumption, **props):
    poly = poly.buffer(0); assert poly.geom_type == 'Polygon' and not poly.is_empty, id
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': kind, 'estimated': True, 'grade': grade, 'assumption': assumption, 'source': SRC, **props}, 'geometry': {'type': 'Polygon', 'coordinates': ring(poly)}})

G_LEVEL = '확정(운동장 바로 아래에 지하 1층과 지하 2층이 있다), 추정(바닥 높이·층고·평면 범위·벽 두께)'
feat('U01-VOID-B1', 'void', 'void', INNER, G_LEVEL, f'운동장 지하 1층: 바닥 {Z_B1} m(혜인관 지하 1층에서 3.8 m 내려간 기록, 145.0~145.6), 천장 {C_B1} m = 운동장 슬래브({SLAB_FIELD} m) 밑. 평면은 운동장 외곽에서 벽 {WALL} m 를 들인 것(실제 범위 모름)', fromM=Z_B1, toM=C_B1, name='운동장 지하 1층')
feat('U01-VOID-B2', 'void', 'void', INNER, G_LEVEL, f'운동장 지하 2층: 바닥 {Z_B2} m(지하 1층과 같은 층고 {STOREY:.1f} m 로 한 층 아래, 140.8~142.3), 천장 {C_B2} m = 지하 1층 바닥 판({SLAB_B1} m) 밑', fromM=Z_B2, toM=C_B2, name='운동장 지하 2층')
ramp = LineString([R0, R1]).buffer(RAMP_W / 2, cap_style=2)
feat('U01-VOID-RAMP-OPENING', 'void', 'void', ramp, '추정', '안쪽 경사로 위로 지하 1층 바닥 판을 뚫은 곳(경사로가 지나가는 구멍)', fromM=C_B2, toM=Z_B1, name='경사로 구멍')
feat('U01-RAMP-B2-B1', 'ramp', 'extrude', ramp, '확정(두 층 모두 차도의 종착지), 추정(안쪽 경사로의 자리·길이·폭)', f'지하 2층({Z_B2}) → 지하 1층({Z_B1}) 안쪽 경사로: 길이 {RAMP_L:.0f} m, 경사 {GRADE_RAMP * 100:.1f} %, 폭 {RAMP_W} m. 지하 차도 축을 그대로 이은 자리', basePlane='U01-VOID-B2 바닥', material='concrete',
     topProfile={'origin': [r2(R0[0]), r2(R0[1])], 'direction': [float(D[0]), float(D[1])], 'points': [[0.0, Z_B2 + 0.02], [RAMP_L, Z_B1]]}, bottomM=Z_B2)
# 지하 차도 연장: 내리막길 기단 밑을 지나 운동장 서쪽 벽을 뚫고 지하 2층으로. 4 m 마디마다 평평한 바닥(G02 의 기존 구간과 같은 방식)
n = int(np.ceil((L_APP + WALL + 0.5) / 4.0)); step = (L_APP + WALL + 0.5) / n; covers = []
for k in range(n):
    a, b = k * step, (k + 1) * step; za, zb = (min(Z_B2, Z_P0 + GRADE_APP * s) for s in (a, b)); mid = P0 + D * (a + b) / 2
    seg = LineString([P0 + D * a, P0 + D * b]).buffer(ROAD_W / 2, cap_style=2)
    under_way = WAY.contains(Point(mid))   # 내리막길 기단 밑: 천장은 길 윗면에서 덮개 판 0.6 m 아래를 넘지 않는다(기존 구간의 위 끝은 길 윗면 - 바닥 = 3.5 m)
    top = r2(min(zb + CLEAR, min(way_top(*(P0 + D * a)), way_top(*(P0 + D * b))) - ROOF)) if under_way else min(r2(zb + CLEAR), C_B2)
    top = min(top, C_B2)
    if under_way: covers.append(r2(way_top(*mid) - (za + zb) / 2))
    feat(f'U01-VOID-ROAD-{k:02d}', 'void', 'void', seg, '확정(지하 차도가 운동장 아래 지하층까지 이어진다), 추정(선·폭·높이·경사)', f'지하 차도 연장 {a:.0f}~{b:.0f} m: 바닥 {za:.2f} → {zb:.2f} m (경사 {GRADE_APP * 100:.1f} %), 폭 {ROAD_W} m, 빈 높이 {CLEAR} m', fromM=r2(za), toM=top, name='지하 차도')
# 기둥: 8 m 격자(추정), 차로·경사로 자리는 비운다
U, V = D, np.array([-D[1], D[0]]); c = np.array(INNER.centroid.coords[0]); GRID = 8.0; cols = 0
lanes = unary_union([LineString([ENTRY, END]).buffer(RAMP_W / 2 + 1.0), LineString([A2, C2]).buffer(4.0), LineString([B, C1]).buffer(4.0), LineString([END, [201230.5, 557260.5], [201222.1, 557240.2], [201220.61, 557232.88]]).buffer(4.0)])
for i in range(-12, 13):
    for j in range(-12, 13):
        p = c + U * (i * GRID + 4.0) + V * (j * GRID)
        sq = Point(p).buffer(0.3, cap_style=3)
        if not INNER.buffer(-1.5).contains(sq) or lanes.intersects(sq): continue
        cols += 1; feat(f'U01-COLUMN-{cols:03d}', 'wall', 'extrude', sq, '추정', f'기둥 0.6 × 0.6 m, {GRID:.0f} m 격자(추정: 실제 기둥 자리·간격 모름). 지하 2층 바닥에서 운동장 슬래브 밑까지', fromM=Z_B2, toM=C_B1, basePlane='U01-VOID-B2 바닥', material='concrete')

out = {'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'provenance': {'script': 'docs/audit/u01/build_parts.py', 'note': '운동장 슬래브 기단(Z02-PLATFORM-FIELD 등) 안의 빈 곳. inside 가 없는 빈 곳은 겹치는 모든 기단에서 비운다'}, 'features': FEATS}
(STR / 'u01-field-basement.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
pt = lambda p, z: {'xy': [r2(p[0]), r2(p[1])], 'z': r2(z)}
model = {'heights': {'field': Z_FIELD, 'b1Floor': Z_B1, 'b1Ceiling': C_B1, 'b2Floor': Z_B2, 'b2Ceiling': C_B2, 'storeyM': r2(STOREY), 'fieldSlabM': SLAB_FIELD, 'b1SlabM': SLAB_B1, 'platformBottom': r2(Z_B2 - BASE)},
         'areaM2': r2(INNER.area), 'columns': cols,
         'approach': {'from': pt(P0, Z_P0), 'entry': pt(ENTRY, Z_B2), 'lengthM': r2(L_APP), 'gradePct': r2(GRADE_APP * 100), 'surfaceAboveFloorUnderWayM': [min(covers), max(covers)], 'widthM': ROAD_W},
         'innerRamp': {'bottom': pt(R0, Z_B2), 'top': pt(R1, Z_B1), 'lengthM': RAMP_L, 'gradePct': r2(GRADE_RAMP * 100), 'widthM': RAMP_W},
         'points': {'A2': pt(A2, Z_B2), 'B': pt(B, Z_B1), 'C2': pt(C2, Z_B2), 'C1': pt(C1, Z_B1), 'END': pt(END, Z_B1)}, 'oldPassageOffAxisM': r2(off_end)}
(HERE / 'model.json').write_text(json.dumps(model, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps(model, ensure_ascii=False))
