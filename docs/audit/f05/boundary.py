"""F05 — 운동장 경계를 곧은 변으로 다시 잡기. 읽기 전용(DB·MCP 없음).

  python docs/audit/f05/boundary.py <3d-map-audit-20261009> <roads.json> docs/audit/f05
  출력: docs/audit/f05/results.json(수치 전부), docs/audit/e10/field-area-f05.geojson(새 경계. e10/field-area.geojson 은 E10 의 옛 경계 그대로)

근거: S-MAP 3D 뷰어 메시(1 m: e05 은주 a·b·c, b09 상승관 / 2 m: e05 남·북동)에서 지형 면이 148.9 m ± 0.5 m 인 칸의 가장자리,
건물 원천 외곽(building-outlines-5186.json). 변마다 가장자리 점을 곧은 선 하나에 맞추고(전체 최소제곱), 이웃한 선의 만나는 점을 꼭짓점으로 쓴다.
건물 벽이나 트인 모서리는 원천 외곽의 꼭짓점을 그대로 쓴다(fixed). S-MAP 은 독립 측량이 아니다.
<roads.json> = 시험용 DB 의 GET /api/v1/mobility/roads 응답(길 끝 노드가 새 경계 안에 있는지 확인용).
"""
import json, math, pathlib, sys
import numpy as np
from shapely.geometry import Polygon, Point
from common import smap, T
sys.stdout.reconfigure(encoding='utf-8')
audit, roads_path, out = sys.argv[1:4]
FLOOR, BAND = 148.9, 0.5
x0, y0, z, mid, src = smap(audit)
ny, nx = z.shape
flat = (mid == T) & (np.abs(z - FLOOR) <= BAND)
# 가장자리 점: 평지 칸과 평지가 아닌 이웃 칸 사이의 가운데
edge = []
for j in range(1, ny - 1):
    for i in range(1, nx - 1):
        if flat[j, i]:
            for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if not flat[j + dj, i + di]: edge.append((x0 + i + di / 2, y0 + j + dj / 2, src[j, i]))
edge = np.array(edge)

# 변(시계 방향, 남쪽 모서리부터): fit = 어림 선 둘레(수직 2.5 m 안, 양 끝 1 m 안쪽)의 가장자리 점에 맞춘 선 / fixed = 두 점을 지나는 선 그대로
SIDES = [
    ('남서 은주2관', 'fit', (201194, 557178), (201138, 557227), 'S-MAP: 평지가 끝나고 은주2관 벽 앞 꺼진 틈(-1~-6 m)이 시작되는 선. 사진: 낮은 담'),
    ('서 은주1관 남쪽 화단', 'fit', (201138.5, 557229.5), (201138.5, 557243), 'S-MAP: 은주1관 벽 앞 +0.5~1.0 m 띠(화단)의 발치'),
    ('서 은주1관 문 앞 남쪽 턱', 'fixed', (201139.5, 557243.5), (201134.5, 557243.5), '화단 끝에서 벽으로 꺾임(S-MAP 칸 경계)'),
    ('서 은주1관 벽(입구(2) 앞)', 'fixed', (201132.5, 557229.5), (201144.0, 557299.8), '건물 원천 외곽의 동쪽 변. 평지가 벽에 닿는 구간'),
    ('서 은주1관 문 앞 북쪽 턱', 'fixed', (201134.5, 557255.5), (201141.5, 557255.5), '벽에서 화단 발치로 꺾임(S-MAP 칸 경계)'),
    ('서 은주1관 북쪽 화단', 'fit', (201141.5, 557257), (201146.5, 557293), 'S-MAP: 은주1관 벽 앞 +0.5~1.0 m 띠(화단)의 발치'),
    ('북서 화단 끝', 'fixed', (201147.5, 557293.5), (201142.5, 557293.5), '화단 북쪽 끝에서 벽 쪽으로 꺾임(S-MAP 칸 경계)'),
    ('북서 한림관 쪽 계단 위', 'fixed', (201143.2, 557293.5), (201145.0, 557310.5), '은주1관 북동 모서리 옆에서 대일관 화단 벽 서쪽 끝까지. S-MAP 이 148.9 m 아래로 내려가기 시작하는 선(6칸 계단 위 끝, ±2 m)'),
    ('북 대일관 화단 벽 서쪽', 'fit', (201150, 557310), (201177, 557300.5), 'S-MAP: 지면이 0.5 m 넘게 오르기 시작하는 선(흰 화단 벽 발치, 현관 계단 아래 포함)'),
    ('북 화단 벽 꺾임', 'fit', (201177.5, 557300.5), (201180.5, 557294), 'S-MAP: 벽 선이 남쪽으로 물러나는 곳'),
    ('북 대일관 화단 벽 동쪽', 'fit', (201181, 557294.3), (201206, 557288.3), 'S-MAP: 지면이 0.5 m 넘게 오르기 시작하는 선'),
    ('북동 상승관 계단 쪽 벽', 'fit', (201206.5, 557288), (201211.5, 557281.8), 'S-MAP: 화단 벽 동쪽 끝에서 청운관 돌출부 모서리로 내려오는 선(두 계단 아래 끝이 이 선 위)'),
    ('북동 청운관 돌출부 앞', 'fixed', (201211.9, 557280.9), (201221.2, 557275.0), '건물 원천 외곽의 변'),
    ('북동 청운관 돌출부 앞 2', 'fixed', (201221.2, 557275.0), (201229.7, 557273.3), '건물 원천 외곽의 변'),
    ('동 청운관 남동 벽 앞', 'fixed', (201228.6, 557272.3), (201237.3, 557262.9), '건물 원천 외곽의 남서 변을 1.5 m 앞으로 옮긴 선. S-MAP: 벽 앞 +0.5~1.2 m 띠(폭 1~2 m)의 발치'),
    ('동 청운관–혜인관 사이', 'fixed', (201237.3, 557262.9), (201246.0, 557255.8), '트인 곳(동쪽 마당으로 이어짐). 청운관 앞 띠 끝에서 혜인관 원천 외곽 북서 모서리까지 닫는 선'),
    ('남동 혜인관 북쪽 화단', 'fit', (201240.5, 557252), (201229.5, 557232), 'S-MAP 2 m: 혜인관 벽 앞 화단 발치(±1 m)'),
    ('남동 혜인관 입구 북쪽 턱', 'fixed', (201226.5, 557231.0), (201230.0, 557229.0), '화단 끝에서 벽으로 꺾임(S-MAP 칸 경계, 벽에 수직)'),
    ('남동 혜인관 벽(입구(1) 앞)', 'fixed', (201246.0, 557255.8), (201200.7, 557180.9), '건물 원천 외곽의 북서 변. 평지가 벽에 닿는 구간'),
    ('남동 혜인관 입구 남쪽 턱', 'fixed', (201219.5, 557212.5), (201215.5, 557214.8), '벽에서 화단 발치로 꺾임(S-MAP 칸 경계, 벽에 수직)'),
    ('남동 혜인관 남쪽 화단', 'fit', (201216, 557211), (201201.5, 557186), 'S-MAP 1 m: 혜인관 벽 앞 +0.5~1.3 m 띠(화단)의 발치'),
    ('남 은주2관–혜인관 사이', 'fixed', (201200.0, 557181.5), (201197.3, 557174.7), '트인 곳(남쪽으로 이어짐). 혜인관 원천 외곽 서쪽 모서리 옆에서 은주2관 앞 선의 동쪽 끝(평지 끝)까지 닫는 선'),
]


def fit(p, q):
    p, q = np.array(p, float), np.array(q, float); L = np.linalg.norm(q - p); u = (q - p) / L; n = np.array([-u[1], u[0]])
    rel = edge[:, :2] - p; s = rel @ u; d = rel @ n
    sel = (s >= 1) & (s <= L - 1) & (np.abs(d) <= 2.5)
    for _ in range(2):
        pts = edge[sel, :2]; c = pts.mean(0); w, v = np.linalg.eigh(np.cov((pts - c).T)); dirv = v[:, 1]; nn = v[:, 0]
        sel = sel & (np.abs((edge[:, :2] - c) @ nn) <= 1.5)
    res = (edge[sel, :2] - c) @ nn
    return c, dirv, {'points': int(sel.sum()), 'rmsM': round(float(np.sqrt((res ** 2).mean())), 2), 'maxM': round(float(np.abs(res).max()), 2), 'from1mMesh_pct': round(100 * float((edge[sel, 2] == 1).mean()))}


lines = []
for name, kind, p, q, basis in SIDES:
    if kind == 'fit': c, dv, st = fit(p, q)
    else: c, dv, st = np.array(p, float), np.array(q, float) - np.array(p, float), None
    lines.append((name, kind, c, dv / np.linalg.norm(dv), st, basis))


def meet(a, b):
    (c1, d1), (c2, d2) = a, b
    t = np.linalg.solve(np.array([d1, -d2]).T, c2 - c1); return c1 + d1 * t[0]


ring = [meet((lines[i - 1][2], lines[i - 1][3]), (lines[i][2], lines[i][3])) for i in range(len(lines))]
ring = [(round(float(p[0]), 2), round(float(p[1]), 2)) for p in ring]   # ring[i] = 변 i 의 시작점
poly = Polygon(ring)
assert poly.is_valid and poly.exterior.is_simple, 'ring not simple'

here = pathlib.Path(__file__).resolve().parent
old = Polygon(json.load(open(here.parent / 'e10/field-area.geojson', encoding='utf8'))['features'][0]['geometry']['coordinates'][0])
B = {b['name']: [Polygon(pg[0], pg[1:]) for pg in b['coordinates']] for b in json.load(open(f'{audit}/building-outlines-5186.json', encoding='utf8'))}
q = lambda v, p: float(np.sort(v)[min(len(v) - 1, int(p * len(v)))])
sides = []
for i, (name, kind, c, dv, st, basis) in enumerate(lines):
    a, b = ring[i], ring[(i + 1) % len(ring)]; L = math.dist(a, b)
    samples = [Point(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) for t in np.linspace(0, 1, max(2, int(L) + 1))]
    dOld = np.array([s.distance(old.exterior) for s in samples])
    dFlat = np.array([np.min(np.hypot(edge[:, 0] - s.x, edge[:, 1] - s.y)) for s in samples])
    m = samples[len(samples) // 2]
    wall = min((m.distance(g.exterior), n) for n, gs in B.items() for g in gs if n != '공연실습소')
    sides.append({'side': name, 'kind': kind, 'from': a, 'to': b, 'lengthM': round(L, 1), 'basis': basis, 'fit': st,
                  'vsOldPolygon_medianM': round(q(dOld, .5), 1), 'vsOldPolygon_maxM': round(float(dOld.max()), 1),
                  'vsSmapFlatEdge_medianM': round(q(dFlat, .5), 1), 'vsSmapFlatEdge_maxM': round(float(dFlat.max()), 1),
                  'midpointToNearestSourceOutlineM': round(wall[0], 1), 'nearestBuilding': wall[1]})

# 면 안 S-MAP 칸
inside = [(x0 + i, y0 + j) for j in range(ny) for i in range(nx) if poly.contains(Point(x0 + i, y0 + j))]
zi = np.array([z[y - y0, x - x0] for x, y in inside]); ti = np.array([mid[y - y0, x - x0] == T for x, y in inside])
smapInside = {'cells': len(inside), 'terrainWithin0.5m_pct': round(100 * float((ti & (np.abs(zi - FLOOR) <= .5)).mean()), 1), 'terrainHigherThan0.5m_cells': int((ti & (zi - FLOOR > .5)).sum()),
              'terrainLowerThan0.5m_cells': int((ti & (zi - FLOOR < -.5)).sum()), 'buildingModel_cells': int((~ti).sum())}
overlap = {n: round(sum(poly.intersection(g).area for g in gs), 1) for n, gs in B.items() if sum(poly.intersection(g).area for g in gs) > 0.05}

# 노드: 새·옛 경계 0.5 m 안이거나 안쪽에 있는 길 끝 노드, 그리고 E10/B09 접근점 제안
nodes = {}
for r in json.load(open(roads_path, encoding='utf8'))['roads']:
    cs = r['geometry']['coordinates']
    for nid, c in ((r['fromNodeId'], cs[0]), (r['toNodeId'], cs[-1])): nodes.setdefault(nid, c)


def where(pt):
    p = Point(pt[0], pt[1]); d = p.distance(poly.exterior); ins = poly.contains(p)
    return {'xy': [round(pt[0], 2), round(pt[1], 2)], 'insideNew': bool(ins), 'toNewBoundaryM': round(d, 2), 'onOrInsideNew_0.5m': bool(ins or d <= .5),
            'insideOld': bool(old.contains(p)), 'toOldBoundaryM': round(p.distance(old.exterior), 2)}


nodeRows = []
for nid, c in nodes.items():
    w = where(c)
    if w['onOrInsideNew_0.5m'] or w['insideOld'] or w['toOldBoundaryM'] <= .5:
        fl = len(c) > 2 and abs(c[2] - FLOOR) <= .5
        nodeRows.append({'node': nid[:8], 'zM': round(c[2], 2) if len(c) > 2 else None, **w, 'accessOld': bool(fl and (w['insideOld'] or w['toOldBoundaryM'] <= .5)), 'accessNew': bool(fl and w['onOrInsideNew_0.5m'])})
aps = [{'id': f['properties']['id'], **where(f['geometry']['coordinates'])} for f in json.load(open(here.parent / 'e10/access-points.geojson', encoding='utf8'))['features'] if f['geometry']['type'] == 'Point']

res = {'about': 'F05 운동장 경계: S-MAP 평지 가장자리와 건물 원천 외곽에 맞춘 곧은 변', 'floorM': FLOOR, 'bandM': BAND,
       'vertices': len(ring), 'areaM2': round(poly.area, 1), 'oldVertices': len(old.exterior.coords) - 1, 'oldAreaM2': round(old.area, 1),
       'onlyInNewM2': round(poly.difference(old).area, 1), 'onlyInOldM2': round(old.difference(poly).area, 1),
       'ring': [list(p) for p in ring + [ring[0]]], 'sides': sides, 'smapInside': smapInside, 'sourceOutlineOverlapM2': overlap,
       'nodes': sorted(nodeRows, key=lambda r: r['node']), 'accessPointProposals': aps}
json.dump(res, open(f'{out}/results.json', 'w', encoding='utf8'), ensure_ascii=False, indent=1)
note = f'F05. 경계 = S-MAP 평지(148.9 ± 0.5 m) 가장자리와 건물 원천 외곽에 맞춘 곧은 변 {len(ring)}개(화단 발치·벽·트인 모서리). 바닥 148.9 m = E06 측정. 옛 경계(E10, 45점 8,012㎡)는 docs/audit/e10/field-area.geojson.'
json.dump({'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': [{'type': 'Feature',
    'properties': {'name': '운동장', 'kind': 'other', 'elevationM': FLOOR, 'buildingId': None, 'floor': None, 'note': note, 'areaM2': round(poly.area)},
    'geometry': {'type': 'Polygon', 'coordinates': [[list(p) for p in ring + [ring[0]]]]}}]}, open(here.parent / 'e10/field-area-f05.geojson', 'w', encoding='utf8', newline=chr(10)), ensure_ascii=False, indent=1)
print('vertices', len(ring), 'area', round(poly.area, 1), 'old', round(old.area, 1), '+', res['onlyInNewM2'], '-', res['onlyInOldM2'])
for s in sides: print(f"{s['side']:24s} {s['kind']:5s} L={s['lengthM']:5.1f} old {s['vsOldPolygon_medianM']}/{s['vsOldPolygon_maxM']} flat {s['vsSmapFlatEdge_medianM']}/{s['vsSmapFlatEdge_maxM']} wall {s['midpointToNearestSourceOutlineM']} {s['nearestBuilding']} {s['fit']}")
print(smapInside, overlap)
for r in res['nodes']: print(r)
for r in aps: print(r)
