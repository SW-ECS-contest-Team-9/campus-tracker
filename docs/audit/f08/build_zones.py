"""F08 구획 구분: frontend/public/zones.geojson 을 만든다 (층 따로 보기에서 길을 누르면 뜨는 단위).

구획은 캠퍼스에 대한 사실이 아니라 Claude 의 작업 구분(추정)이다.
- 지상: 구조물 파일의 기단을 구역 노트별로 묶고(RULES), 캠퍼스 외곽 안의 남는 조각(건물 자리·빈 틈)은
  경계를 가장 길게 맞댄 구획에 붙인다. 겹침은 RULES 순서대로 앞의 것이 가진다 -> 틈·겹침 없음.
- 지하: 구조물 파일의 빈 곳(void)과 지하 길 선의 띠. 높이 범위(fromM~toM)로 지상과 구분한다.
읽는 것: 구조물 파일, 시험용 서버의 /api/v1/scene, /api/v1/mobility/roads (쓰기 없음).
실행: python docs/audit/f08/build_zones.py [http://127.0.0.1:3210]
"""
import glob, json, math, os, re, sys, urllib.request
from shapely.geometry import shape, LineString, Polygon, MultiPolygon
from shapely.ops import unary_union, transform

API = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3210'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..')
OUT = os.path.join(ROOT, 'frontend', 'public', 'zones.geojson')

# (id, 이름, 구역 노트 제목, 기단 id 정규식, 설명) - 앞의 것이 겹침을 가진다
RULES = [
    ('way', '오르막길(내리막길)과 주변', '오르막길과 주변', r'^G02-', '북악관·문예관과 본관·한림관 사이 114 m 경사 길, 계단식 보행 띠, 화단'),
    ('field', '운동장', '대일관 정면과 운동장 북쪽 가장자리', r'^Z02-PLATFORM-FIELD|EUNJU-FIELD-WEST', '운동장 평면 148.9 m 와 서쪽 가장자리'),
    ('daeil', '대일관 정면과 운동장 북쪽 가장자리', '대일관 정면과 운동장 북쪽 가장자리', r'^Z02-', '대일관 현관 계단, 데크 통로, 상승관 앞'),
    ('fountain', '분수 광장과 주변', '분수 광장과 주변', r'^Z03-|YUDAM9-PLAZA-NORTH', '광장 판 114.1 m, 분수대, 옆 차도'),
    ('turn', '북악관 앞 회차 공간과 본관 앞', '북악관 앞 회차 공간과 본관 앞', r'-TURN-', '회차 공간, 북악관 현관 앞, 본관 서쪽 내리막'),
    ('upper', '위쪽 갈래와 한림관 둘레', '위쪽 갈래와 한림관 둘레', r'-UPPER-', '본관·한림관 사이 차도, 한림관 1층 가는 길'),
    ('yudam9', '유담관 9층 쪽 앞마당과 본관 앞 차도', '유담관 9층 쪽 앞마당과 본관 앞 차도', r'-YUDAM9-', '유담관 9층 앞마당, 본관 앞 차도'),
    ('cheongun', '청운관 앞', '청운관 앞', r'-CHEONGUN-', '청운관 앞 바닥'),
    ('hyein', '혜인관 둘레', '혜인관 둘레', r'-HYEIN-', '혜인관 둘레 바닥'),
    ('eunju', '은주관 둘레와 풋살장', '은주관 둘레와 풋살장', r'-EUNJU-', '은주1관·2관 둘레, 수인관 위 풋살장'),
    ('gate', '정문(진입 차도 포함)', '정문', r'-GATE-', '정문, 진입 차도, 서경로 쪽 공도'),
    ('west', '서문과 서쪽 옹벽', '서문과 서쪽 옹벽', r'-WEST-', '서문, 서쪽 옹벽과 아래 공도'),
    ('back', '뒤편 산책로와 북악관 옆길', '뒤편 산책로와 북악관 옆길', r'-BACK-', '북악관 옆길, 건물 뒤 단, 숲 비탈'),
]


def get(path):
    with urllib.request.urlopen(API + path) as r:
        return json.load(r)


def clean(g):
    return g.buffer(0)


# EPSG:5186 forward (frontend/src/tm.ts 와 같은 식)
A, F = 6378137, 1 / 298.257222101


def arc(phi):
    e2 = F * (2 - F); e4 = e2 * e2; e6 = e4 * e2
    return A * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
                + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi) - (35 * e6 / 3072) * math.sin(6 * phi))


M0 = arc(math.radians(38))


def tm(lon, lat, *_):
    e2 = F * (2 - F); ep2 = e2 / (1 - e2); phi = math.radians(lat)
    s, c, t = math.sin(phi), math.cos(phi), math.tan(phi)
    N = A / math.sqrt(1 - e2 * s * s); T = t * t; C = ep2 * c * c; a = math.radians(lon - 127) * c
    x = N * (a + (1 - T + C) * a ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * a ** 5 / 120)
    y = arc(phi) - M0 + N * t * (a * a / 2 + (5 - T + 9 * C + 4 * C * C) * a ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * a ** 6 / 720)
    return 200000 + x, 600000 + y


solids = []
for f in sorted(glob.glob(os.path.join(ROOT, 'frontend', 'public', 'structures', '*.geojson'))):
    for ft in json.load(open(f, encoding='utf-8'))['features']:
        solids.append((ft['properties'], clean(shape(ft['geometry']))))
scene = get('/api/v1/scene')
campus = clean(unary_union([transform(tm, shape({'type': 'MultiPolygon', 'coordinates': m['coordinates']})) for m in scene['campus']]))
roads = get('/api/v1/mobility/roads')['roads']

# ---- 지상 ----
platforms = [(p, g) for p, g in solids if p.get('kind') == 'platform']
zones, taken = [], None
for zid, name, note, pattern, desc in RULES:
    own = [g for p, g in platforms if re.search(pattern, p['id']) and not any(re.search(r[3], p['id']) for r in RULES[:len(zones)])]
    g = clean(unary_union(own)) if own else Polygon()
    if taken is not None:
        g = clean(g.difference(taken))
    taken = g if taken is None else clean(taken.union(g))
    zones.append({'id': zid, 'name': name, 'note': note, 'description': desc, 'geom': g, 'platforms': len(own)})
left = [p['id'] for p, g in platforms if not any(re.search(r[3], p['id']) for r in RULES)]
assert not left, left

# 남는 조각(건물 자리, 빈 틈): 가장 길게 맞댄 구획으로. 큰 조각부터, 붙인 뒤의 모양으로 다시 잰다
rest = clean(campus.difference(taken))
pieces = sorted([g for g in getattr(rest, 'geoms', [rest]) if g.area > 0.01], key=lambda g: -g.area)
for piece in pieces:
    ring = piece.buffer(0.3)
    best = max(zones, key=lambda z: ring.intersection(z['geom']).area)
    if ring.intersection(best['geom']).area == 0:
        best = min(zones, key=lambda z: z['geom'].distance(piece))
    best['geom'] = clean(best['geom'].union(piece))
# 붙이며 생긴 실금 메움: 0.05 m 넓혔다 줄이고, 앞 구획과 겹친 것은 다시 뺌
taken = None
for z in zones:
    g = clean(z['geom'].buffer(0.05, join_style=2).buffer(-0.05, join_style=2))
    if taken is not None:
        g = clean(g.difference(taken))
    taken = g if taken is None else clean(taken.union(g))
    z['geom'] = g

total = sum(z['geom'].area for z in zones)
union = clean(unary_union([z['geom'] for z in zones]))
print('지상 구획 %d, 넓이 합 %.0f, 합친 넓이 %.0f (겹침 %.2f), 캠퍼스 안 못 덮은 넓이 %.2f' % (len(zones), total, union.area, total - union.area, campus.difference(union).area))

# ---- 지하 ----
def road_line(r):
    return LineString([c[:2] for c in r['geometry']['coordinates']])


def zs(rs):
    return [c[2] for r in rs for c in r['geometry']['coordinates']]


def named(pattern, cls=None):
    return [r for r in roads if not r['buildingId'] and re.search(pattern, r['name'] or '') and (cls is None or r['roadClass'] == cls)]


def voids(pattern):
    return [g for p, g in solids if p.get('kind') == 'void' and re.search(pattern, p.get('name') or '')]


def band(rs, half):
    return clean(unary_union([road_line(r).buffer(half, cap_style=2, join_style=2) for r in rs]))


under = []


def add(zid, name, desc, geoms, lo, hi, floor=None):
    geom = clean(unary_union(geoms)) if geoms else Polygon()
    if geom.is_empty:
        print('  (자료 없음, 만들지 않음)', name)
        return
    under.append({'id': zid, 'name': name, 'note': '운동장 아래 지하층과 지하 차도', 'description': desc, 'geom': geom, 'fromM': round(lo, 2), 'toM': round(hi, 2), 'floorM': floor})


add('b1', '운동장 지하 1층', '운동장 아래 주차장 지하 1층. 평면은 구조물 파일의 빈 곳', voids(r'^운동장 지하 1층$'), 141.4, 144.4, 141.4)
add('b2', '운동장 지하 2층', '운동장 아래 주차장 지하 2층. 평면은 구조물 파일의 빈 곳', voids(r'^운동장 지하 2층$'), 133.0, 140.4, 133.0)
rs = named(r'지하 차도', 'vehicle')
if rs:
    add('tunnel', '지하 차도(서문·제2주차장 → 내리막길 밑)', '지하 차도 선의 폭 7 m 띠와 구조물 파일의 지하 차도 빈 곳. 경사 구간이라 바닥 판 없음',
        [band(rs, 3.5)] + voids(r'^지하 차도$'), min(zs(rs)) - 0.3, max(zs(rs)) + 3.6)
rs = named(r'지하 차도 보행 구간|지하 횡단보도', 'pedestrian')
if rs:
    add('walk', '지하 보행 구간·지하 횡단보도', '지하 차도 옆 보행 구간과 횡단보도·통로 선의 폭 4 m 띠', [band(rs, 2.0)], min(zs(rs)) - 0.3, max(zs(rs)) + 3.0)
rs = named(r'본관 2층.*지하통로|유리문')
if rs:
    add('glass', '본관–유담관 지하 통로', '본관 2층 유리문 ~ 유담관 7층. 구조물 파일의 빈 곳과 길 선의 폭 4 m 띠', voids(r'지하통로|유리문 앞') + [band(rs, 2.0)], min(zs(rs)) - 0.3, max(zs(rs)) + 3.0)
rs = named(r'연결통로')
if rs:
    add('links', '연결통로 둘(은주1관–한림관, 한림관–본관 5층)', '두 연결통로 선의 폭 4 m 띠(137.8 m). 사이의 한림관 안 통로는 한림관 층에 나옴', [band(rs, 2.0)], min(zs(rs)) - 0.3, max(zs(rs)) + 3.2, min(zs(rs)))


def rings(g):
    polys = list(g.geoms) if isinstance(g, MultiPolygon) else [g]
    return [[[[round(x, 2), round(y, 2)] for x, y in ring.coords] for ring in [p.exterior, *p.interiors]] for p in polys if p.area > 0.01]


features = []
for z in zones:
    features.append({'type': 'Feature', 'properties': {'id': z['id'], 'name': z['name'], 'layer': 'ground', 'description': z['description'], 'note': z['note'], 'estimated': True},
                     'geometry': {'type': 'MultiPolygon', 'coordinates': rings(z['geom'])}})
    print('  %-9s %s | 기단 %d개 | %.0f ㎡' % (z['id'], z['name'], z['platforms'], z['geom'].area))
for z in under:
    props = {'id': z['id'], 'name': z['name'], 'layer': 'underground', 'description': z['description'], 'note': z['note'], 'estimated': True, 'fromM': z['fromM'], 'toM': z['toM']}
    if z['floorM'] is not None:
        props['floorM'] = z['floorM']
    features.append({'type': 'Feature', 'properties': props, 'geometry': {'type': 'MultiPolygon', 'coordinates': rings(z['geom'])}})
    print('  %-9s %s | %.1f~%.1f m | %.0f ㎡' % (z['id'], z['name'], z['fromM'], z['toM'], z['geom'].area))
json.dump({'type': 'FeatureCollection', 'name': 'zones', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
           'note': '구획 = Claude 의 작업 구분(추정). 캠퍼스에 대한 사실이 아니다. docs/audit/f08/build_zones.py 가 만든다.', 'features': features},
          open(OUT, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
print('wrote', os.path.normpath(OUT), os.path.getsize(OUT), 'bytes')
