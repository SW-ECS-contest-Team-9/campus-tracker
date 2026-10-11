"""Z11: 남은 흠을 구조물 상자로 고친다. DB·네트워크 접근 없음.   python build_parts.py [--plan 그림.png]
쓰는 파일: frontend/public/structures/z11-parts.geojson (형식 docs/audit/g02/STRUCTURES.md). 전부 estimated.
z05/build_inputs.py 를 다시 돌린 뒤에 돌린다(기단 윗면 높이를 읽는다).
 - 유담관 공도 쪽 기단 벽: 건물 자료의 외곽이 톱니(들쭉날쭉한 옛 지적 외곽)라 공도에서 본 밑동 선이 톱니였다. 공도를 따라 굽은 벽 한 면(곧은 두 구간과 그 사이의 둥근 모서리)을
   톱니 바깥에 세우고, 벽과 건물 사이의 들어간 자리는 기단 윗면 높이까지 채운다. 창 줄 셋은 얇은 띠 상자."""
import sys, json, pathlib
import numpy as np
from shapely.geometry import Polygon, Point, LineString, shape
from shapely.ops import unary_union
REPO = pathlib.Path(__file__).parents[3]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
ALL = [f for fn in sorted(STR.glob('*.geojson')) if fn.name != 'z11-parts.geojson' for f in json.loads(fn.read_text(encoding='utf-8'))['features']]
PLATS = [(shape(f['geometry']).buffer(0), f['properties']) for f in ALL if f['properties']['kind'] == 'platform']
SCENE = {b['id']: Polygon(b['ring']).buffer(0) for b in json.loads((REPO / 'docs/audit/z04/scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']}
def top_at(p, x, y):
    if 'topProfile' in p: o, d, pts = np.array(p['topProfile']['origin']), np.array(p['topProfile']['direction']), np.array(p['topProfile']['points']); return float(np.interp((x - o[0]) * d[0] + (y - o[1]) * d[1], pts[:, 0], pts[:, 1]))
    return float(p['topM'])
def ground(x, y, lowest=False):
    """그 자리 기단 윗면 높이(겹치면 높은 쪽, lowest 면 낮은 쪽)."""
    v = [top_at(p, x, y) for poly, p in PLATS if poly.contains(Point(x, y))]; assert v, (x, y); return min(v) if lowest else max(v)
FEATS = []
def box(id, typ, poly, fromM, toM, assumption, source, grade, basePlane, **extra):
    poly = poly if isinstance(poly, Polygon) else Polygon(poly); assert toM > fromM, id; assert poly.geom_type == 'Polygon' and not poly.is_empty, id
    rings = [[[r2(x), r2(y)] for x, y in r.coords] for r in [poly.exterior] + list(poly.interiors)]
    FEATS.append({'type': 'Feature', 'properties': {'id': id, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': basePlane, 'fromM': r2(fromM), 'toM': r2(toM), 'assumption': assumption, 'source': source, **extra}, 'geometry': {'type': 'Polygon', 'coordinates': rings}})
def big(g): g = g.buffer(0); ps = [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.geom_type == 'Polygon']; return max(ps, key=lambda q: q.area)
def fillet(P, R, step=1.0):
    """꺾은선 P 의 안쪽 꼭짓점을 반지름 R 의 호로 둥글린 점 열(호는 step m 마디)."""
    P = [np.array(p, float) for p in P]; out = [P[0]]
    for a, b, c in zip(P, P[1:], P[2:]):
        u, v = (a - b) / np.hypot(*(a - b)), (c - b) / np.hypot(*(c - b)); half = np.arccos(np.clip(u @ v, -1, 1)) / 2; t = R / np.tan(half)
        bis = (u + v) / np.hypot(*(u + v)); cen = b + bis * (R / np.sin(half)); a0, a1 = b + u * t, b + v * t
        t0, t1 = np.arctan2(*(a0 - cen)[::-1]), np.arctan2(*(a1 - cen)[::-1]); d = (t1 - t0 + np.pi) % (2 * np.pi) - np.pi
        n = max(2, int(abs(d) * R / step)); out += [cen + R * np.array([np.cos(t0 + d * k / n), np.sin(t0 + d * k / n)]) for k in range(n + 1)]
    return out + [P[-1]]

# ---------- 유담관 공도 쪽 기단 벽 ----------
YS = '사용자-서문-공연실습소-생활관-20261010/공연실습소.webp(왼쪽 끝: 공도를 따라 굽은 짙은 회색 벽, 창 줄 셋, 위에 나무), smap-yudam-low-road-detail.png(위에서: 탑 기단의 길 쪽 가장자리가 길을 따라 한 줄로 굽는다), 건물 노트 유담관'
YG = '확정(공도 쪽은 길을 따라 굽은 짙은 회색 벽 한 면, 창 줄 셋: 사진), 추정(벽 선: 건물 자료 외곽·남서 테라스 기단의 바깥을 싼 선 ±1.5 m, 창 줄 높이 = 층 표)'
DECK = SCENE['유담관#기단데크']; DECK_TOP = 129.3; WALL = '#5a5b5e'
TERR = [poly for poly, p in PLATS if p['id'].startswith('Z05-PLATFORM-YUDAM9-TERRACE-SW')]
# 벽 선(바깥 면): 북쪽 끝(서쪽 옹벽 선과 만나는 곳) → 서쪽 면 → 남서 모서리(둥글게) → 남서쪽 면 → 분수 광장 북쪽 가장자리 앞. 꼭짓점은 건물·테라스의 볼록 껍질에서 0.4 m 바깥
CTRL = [(201000.45, 557304.6), (201003.2, 557254.2), (201010.6, 557246.3), (201039.0, 557226.2), (201043.3, 557225.4)]
CURVE = fillet(CTRL[:4], 14.0) + [np.array(CTRL[4])]
line = LineString(CURVE)
inner = [(201043.3, 557230.9), (201030, 557260), (201013, 557285), (201009.2, 557304.6)]   # 건물 안쪽으로 닫는 선(건물 안이라 어디든 된다)
SHELL = Polygon([tuple(p) for p in CURVE] + inner).buffer(0)
core = DECK.buffer(-0.3)   # 건물 안 0.3 m 까지는 덮는다(벽 면이 겹쳐 깜박이지 않게 벽은 건물 벽보다 바깥이다)
hull_pts = [p for g in [DECK] + TERR for p in g.exterior.coords if Point(p).distance(line) < 9 and 0.5 < line.project(Point(p)) < line.length - 0.5]
out_m = [Point(p).distance(line) * (1 if SHELL.contains(Point(p)) else -1) for p in hull_pts]
assert min(out_m) > 0.15, ('벽 선이 건물·테라스 꼭짓점을 자른다', sorted(zip(out_m, hull_pts))[:4])
_g = SHELL.difference(core).buffer(0); fill = min((q for q in (_g.geoms if hasattr(_g, 'geoms') else [_g])), key=lambda q: q.distance(line.interpolate(line.length / 2)))   # 벽 선에 붙은 덩어리(탑 쪽 조각은 버린다)
zb = min(ground(x, y, lowest=True) for x, y in [line.interpolate(s).coords[0] for s in np.arange(1, line.length, 4)] ) - 1.0
box('Z11-YUDAM-STREET-PLINTH', 'wall', fill, zb, DECK_TOP + 0.05, f'유담관 공도 쪽 기단 벽: 길을 따라 굽은 벽 한 면(곧은 구간 셋, 모서리는 반지름 14 m 호)과 건물 벽 사이를 기단 데크 윗면(129.3 m)까지 채운 덩어리. 건물 자료의 톱니 외곽(깊이 최대 {max(out_m):.1f} m)과 남서 테라스 기단의 옆면을 가린다. 아래는 공도 기단 밑까지', YS, YG, 'Z05-PLATFORM-WEST-STREET, Z05-PLATFORM-GATE-STREET-SW', color=WALL, topColor='#b5b3ac')
skin = big(line.buffer(0.1, cap_style=2).difference(SHELL))   # 벽 바깥 면에서 0.1 m 내민 띠(창 줄)
street = lambda s: ground(*line.interpolate(s).coords[0], lowest=True)
for name, z in (('5F', 110.0), ('6F', 115.1), ('7F', 122.6)):
    # 길이 창 줄 밑까지 올라온 구간(북쪽 끝)은 뺀다: 창 줄 아래 1.5 m 가 길보다 높은 구간만
    ss = [s for s in np.arange(2.0, line.length - 3.0, 0.5) if street(s) < z - 1.5]; a, b = min(ss), max(ss); n = max(1, int((b - a) // 6.0)); w = (b - a) / n
    for k in range(n):
        s0, s1 = a + k * w + 0.5, a + (k + 1) * w - 0.5
        seg = LineString([line.interpolate(s).coords[0] for s in np.arange(s0, s1 + 0.01, 0.5)])
        box(f'Z11-YUDAM-STREET-WINDOW-{name}-{k + 1:02d}', 'wall', big(seg.buffer(0.1, cap_style=2).difference(SHELL)), z + 1.0, z + 2.4, f'공도 쪽 기단 벽의 창 줄({name} 바닥 {z} m 위 1.0~2.4 m, 길이 {w - 1:.1f} m 띠창). 줄 수 셋은 사진, 높이는 층 표(추정)', YS, YG, 'Z11-YUDAM-STREET-PLINTH', color='#6f8794')
par = big(line.buffer(0.45, cap_style=2).intersection(SHELL))
box('Z11-YUDAM-STREET-PARAPET', 'wall', par, DECK_TOP, DECK_TOP + 0.9, '기단 벽 머리의 난간벽(높이 0.9 m, 두께 0.45 m: 사진에서 벽 위로 나무만 보인다)', YS, YG, 'Z11-YUDAM-STREET-PLINTH', color=WALL)

ids = [f['properties']['id'] for f in FEATS]; assert len(ids) == len(set(ids))
out = {'type': 'FeatureCollection', 'name': 'z11-parts', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
       'provenance': {'builder': 'docs/audit/z11/build_parts.py', 'schema': 'docs/audit/g02/STRUCTURES.md', 'note': 'Z11: 유담관 공도 쪽 기단 벽(굽은 벽 한 면). 치수는 눈대중(추정).'}, 'features': FEATS}
(STR / 'z11-parts.geojson').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print('features', len(FEATS), 'notch max', round(max(out_m), 2), 'min', round(min(out_m), 2), 'bottom', round(zb, 1))
if '--plan' in sys.argv:
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(9, 13)); ax.plot(*DECK.exterior.xy, color='red')
    for t in TERR: ax.plot(*t.exterior.xy, color='c')
    for f in FEATS: g = shape(f['geometry']); ax.fill(*g.exterior.xy, alpha=.4)
    ax.set_xlim(200995, 201050); ax.set_ylim(557222, 557308); ax.set_aspect('equal'); ax.grid(lw=.3); plt.savefig(sys.argv[sys.argv.index('--plan') + 1], dpi=80, bbox_inches='tight')
