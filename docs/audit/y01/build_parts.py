"""Y01 (Claude 결정 2026-10-23): 수인관 옥상(풋살장) 앞 마당을 기단으로. DB·네트워크 접근 없음.   python -I build_parts.py
근거: 볼트 건물 노트 수인관·구역 노트 은주관 둘레와 풋살장의 2026-10-23 절(사용자 드론·항공 사진: 코트 밖은 트인 포장 마당, 은주2관 1층 앞 통로와 같은 높이).
쓰는 파일:
  frontend/public/structures/y01-futsal-yard.geojson  옥상 기단(132.2) + 떨어지는 가장자리의 난간벽
  frontend/public/structures/z05-eunju.geojson         (id 로 고침) 은주2관 쪽 변의 울타리 Z05-FUTSAL-FENCE-03~09 없앰(드론 사진: 마당이 통로로 트여 있음, 울타리는 코트 둘레뿐)
  frontend/public/structures/p01-parts.geojson         (id 로 고침) P01-SUIN-ROOF-PAVING 없앰(기단이 대신), P01-SUIN-GLASSROOF 를 은주2관 낮은 단 지붕(146.8) 위로
돌리는 차례: z05 → p01 → … → 이 스크립트(z05·p01 을 다시 만들면 이 스크립트를 다시 돌린다).
겹침 확인: 이 파일의 상자와 다른 구조물 상자(평면 0.05 ㎡, 높이 0.05 m 넘게 겹침)를 세어 찍는다(0 이어야 한다)."""
import json, pathlib, sys
import numpy as np
from shapely.geometry import Polygon, LineString, shape
from shapely.ops import unary_union
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def dump(p, o): p.write_text(json.dumps(o, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
def ring(q): return [[r2(x), r2(y)] for x, y in q.exterior.coords]

SUIN = [[201102.94, 557190.11], [201125.57, 557204.29], [201192.29, 557144.08], [201174.74, 557125.62], [201148.21, 557110.27]]   # p01 의 옥상 외곽
Z_YARD = 132.2   # 옥상 포장 윗면 = 은주2관 1층 앞 통로 기단 = 입구(1) (S-MAP 0.1 m 안)
SRC = '데이터/보완자료/학교-전경-20261022/항공/드론-풋살파크-정문-혜인관.webp, 항공-은주2관-풋살파크-정문.webp, 사용자-학교전경-20261012/07'
roof = Polygon(SUIN)
feats = [{'type': 'Feature', 'properties': {
    'id': 'Y01-PLATFORM-SUIN-YARD', 'type': 'platform', 'kind': 'platform', 'estimated': True,
    'grade': '확정(옥상이 트인 포장 마당, 통로와 같은 높이: 사용자 드론·항공 사진), S-MAP(옥상 132.1, 통로 132.0~132.9), 추정(포장 윗면 132.2)',
    'topM': Z_YARD, 'bottomM': 132.0, 'bottomNote': '수인관 옥상 슬래브(132.1) 바로 아래. 건물이 아래를 채운다', 'material': 'concrete',
    'assumption': '수인관 옥상 전체를 한 기단으로(코트 칠·울타리·글자는 그 위). P01 옥상 바닥 칠 판을 대신함', 'source': SRC},
    'geometry': {'type': 'Polygon', 'coordinates': [ring(roof)]}}]

# 난간벽: 떨어지는 가장자리만(서경로 쪽 변 SUIN[4]→[0], 남동 끝 서경로 쪽 변 [3]→[4], 북서 변 [0]→[1] 의 은주관 쪽 5 m 는 비움)
T, H, T0 = 0.3, 1.1, 0.15   # 가장자리 울타리(Z05-FUTSAL-FENCE, 두께 약 0.12 m) 안쪽에 붙임
def edge_band(a, b, cut_end=0.0):
    a, b = np.array(a), np.array(b); L = float(np.hypot(*(b - a))); u = (b - a) / L
    b2 = a + u * (L - cut_end)
    band = LineString([a, b2]).buffer(T0 + T, cap_style=2).intersection(roof.buffer(-T0)).difference(roof.buffer(-T0 - T))
    return band.buffer(0)
EDGES = (('SW', SUIN[4], SUIN[0], 0.0), ('SE', SUIN[3], SUIN[4], 0.0), ('NW', SUIN[0], SUIN[1], 5.0))
for name, a, b, cut in EDGES:
    g = edge_band(a, b, cut)
    gs = [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.geom_type == 'Polygon' and q.area > 0.05]
    for k, q in enumerate(gs):
        feats.append({'type': 'Feature', 'properties': {
            'id': f'Y01-SUIN-PARAPET-{name}' + (f'-{k + 1}' if len(gs) > 1 else ''), 'type': 'wall', 'kind': 'extrude', 'estimated': True,
            'grade': '확정(서경로 쪽·북서 변의 회색 테두리: 드론 사진), 추정(높이 1.1 m·두께 0.3 m)', 'basePlane': 'Y01-PLATFORM-SUIN-YARD',
            'fromM': Z_YARD, 'toM': r2(Z_YARD + H), 'material': 'concrete',
            'assumption': '옥상의 떨어지는 가장자리 난간벽(은주2관 쪽 변과 같은 높이 띠와 맞닿은 변은 열어 둠)', 'source': SRC}, 'geometry': {'type': 'Polygon', 'coordinates': [ring(q)]}})
dump(STR / 'y01-futsal-yard.geojson', {'type': 'FeatureCollection', 'name': 'y01-futsal-yard', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
     'provenance': {'builder': 'docs/audit/y01/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md'}, 'features': feats})

# p01: 옥상 바닥 칠 판 없앰, 유리 지붕 줄은 낮은 단 지붕 위로(북동으로 4.6 m)
P01 = load(STR / 'p01-parts.geojson'); NOTE = ' [Y01 2026-10-23: 드론 사진에서 은주2관 낮은 단(146.8) 지붕 위 유리 헛간 줄. 옥상 마당 높이에서 옮김]'
o = np.array(SUIN[4]); a = np.array(SUIN[0]) - o; a /= np.hypot(*a); n = np.array([-a[1], a[0]]); n = n if n @ np.array([1, 1]) > 0 else -n
e = np.array(SUIN[2]) - np.array(SUIN[1]); e /= np.hypot(*e); ne = np.array([-e[1], e[0]]); ne = ne if ne @ np.array([1, 1]) > 0 else -ne   # 은주관 쪽 변의 바깥(북동)
out = []
for f in P01['features']:
    p = f['properties']
    if p['id'] == 'P01-SUIN-ROOF-PAVING': continue
    if p['id'] == 'P01-SUIN-GLASSROOF' and p['fromM'] < 140:
        g = shape(f['geometry']); sh = ne * 4.6
        f['geometry'] = {'type': 'Polygon', 'coordinates': [[[r2(x + sh[0]), r2(y + sh[1])] for x, y in g.exterior.coords]]}
        p.update({'fromM': 146.8, 'toM': 148.4, 'basePlane': '은주관#2관-낮은단 지붕 146.8', 'assumption': p['assumption'].split(' [Y01')[0] + NOTE})
    out.append(f)
P01['features'] = out; dump(STR / 'p01-parts.geojson', P01)

# z05: 은주2관 쪽 변 울타리 없앰
Z05 = load(STR / 'z05-eunju.geojson'); NE_FENCE = {f'Z05-FUTSAL-FENCE-{k:02d}' for k in range(3, 10)}
Z05['features'] = [f for f in Z05['features'] if f['properties']['id'] not in NE_FENCE]; dump(STR / 'z05-eunju.geojson', Z05)

# 겹침: 이 파일·옮긴 유리 줄 상자 대 다른 상자
mine = [f for f in feats if f['properties']['kind'] == 'extrude'] + [f for f in out if f['properties']['id'] == 'P01-SUIN-GLASSROOF']
ids = {f['properties']['id'] for f in mine}; n_ov = 0
for fn in sorted(STR.glob('*.geojson')):
    for f in load(fn)['features']:
        p = f['properties']
        if p.get('kind') != 'extrude' or p['id'] in ids or not f.get('geometry') or 'topProfile' in p: continue
        g = shape(f['geometry']).buffer(0)
        for m in mine:
            q = m['properties']; mg = shape(m['geometry']).buffer(0)
            if not g.intersects(mg): continue
            ar = g.intersection(mg).area; ov = min(q['toM'], p['toM']) - max(q['fromM'], p['fromM'])
            if ar > 0.05 and ov > 0.05 and not (p.get('toM', 0) - p.get('fromM', 0) <= 0.06):
                n_ov += 1; print('겹침', q['id'], 'x', p['id'], f'{ar:.2f} ㎡ {ov:.2f} m')
print('기단 1, 난간벽', len(feats) - 1, '겹침', n_ov, '옥상 넓이', round(roof.area))
