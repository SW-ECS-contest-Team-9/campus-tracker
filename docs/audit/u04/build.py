"""U04: 운동장 지하 주차장 안을 "주차 칸을 뺀 나머지 = 길(면)"로 만든다(사용자 지시 2026-10-12). DB·네트워크 접근 없음.   python build.py
읽는 파일: stalls-px.json(digitise.py: 학교 지하도 지도에서 읽은 주차 칸 묶음), ../u02/georef.json(그림 → EPSG:5186), ../u02/model.json, frontend/public/structures/u01-field-basement.geojson(지하 1층 평면 U02-VOID-B1).
쓰는 파일:
  stalls.json                                     묶음·칸(좌표), 통로 면, 수치(build_parts.py 가 기둥 자리에 읽는다)
  areas/b1.json, areas/b2.json                    공간 영역(편집기 REST POST /areas 의 body). kind parking = 차와 사람이 함께 쓰는 면
  groups/u04.json                                 길 변경 묶음(주차장 안의 추정 선을 거두고 혜인관 통로만 새로)
  frontend/public/structures/u04-parking.geojson  주차 칸 바닥과 칸 선(지하 1층·2층). 형식 docs/audit/g02/STRUCTURES.md (U04 절)
등급: 묶음의 배치(자리·방향·줄 수·끊긴 곳)는 원천(학교 지도, 좌표 맞춤 잔차 RMS 3.3 m), 칸 치수(2.5 × 5.0 m)·칸 수·지하 2층 배치는 추정. 근거는 볼트 구역 노트 "운동장 아래 지하층과 지하 차도"(U04 절)."""
import json, pathlib
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape
from shapely.ops import unary_union
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
GEO = json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8')); MX = np.array(GEO['matrix']); RES = GEO['residualM']['rms']
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); H = M['heights']; RP = M['ramp']; AP = M['approach']; PT = M['points']; HY = M['hyein']
F = {f['properties']['id']: f for f in json.loads((STR / 'u01-field-basement.geojson').read_text(encoding='utf-8'))['features']}
INNER = shape(F['U02-VOID-B1']['geometry']).buffer(0)
Z1, Z2 = H['b1Floor'], H['b2Floor']
world = lambda p: np.r_[p, 1.0] @ MX
xy = lambda o: np.array(o['xy'])

# ---------- 방향: 주차 줄은 혜인관 벽과 나란하다(U02 와 같은 축) ----------
ha, hb = np.array([201200.7, 557180.9]), np.array([201246.0, 557255.8]); U = (hb - ha) / np.hypot(*(hb - ha)); V = np.array([U[1], -U[0]])   # U = 줄 방향(북동), V = 혜인관 쪽
STALL_W, STALL_D = 2.5, 5.0      # 추정: 칸 너비·깊이(지도의 칸은 선 굵기 때문에 깊이 5.6~6 m 로 그려져 있다)
LINE = 0.12

# ---------- 지도에서 읽은 묶음 → 좌표, 줄 수, 칸 수 ----------
PX = json.loads((HERE / 'stalls-px.json').read_text(encoding='utf-8'))['blocks']
blocks = []; az = []
for k, o in enumerate(PX):
    box = np.array([world(p) for p in o['box']]); c = box.mean(0)
    e0, e1 = box[1] - box[0], box[2] - box[1]
    along, across = (e0, e1) if abs(e0 @ U) / np.hypot(*e0) > abs(e1 @ U) / np.hypot(*e1) else (e1, e0)
    la, lc = float(np.hypot(*along)), float(np.hypot(*across))
    if la > 25: d = along / la; d = d if d[1] > 0 else -d; az.append((np.degrees(np.arctan2(d[0], d[1])), la))
    blocks.append({'id': f'S{k + 1:02d}', 'px': o['c'], 'mapCentre': [r2(c[0]), r2(c[1])], 'mapAlongM': r2(la), 'mapAcrossM': r2(lc), 'rows': 2 if lc > 8.0 else 1, 'stallsPerRow': max(1, round(la / STALL_W)), 'c': c, 'manual': o.get('manual')})
MAP_AZ = float(np.average([a for a, _ in az], weights=[w for _, w in az])); WALL_AZ = float(np.degrees(np.arctan2(U[0], U[1])))

# ---------- 가장자리 줄은 벽에 붙이고, 외곽 밖으로 나간 묶음은 안으로 민다(둘 다 잔차 안) ----------
def rect(c, lu, lv): return Polygon([c + U * a + V * b for a, b in ((-lu / 2, -lv / 2), (lu / 2, -lv / 2), (lu / 2, lv / 2), (-lu / 2, lv / 2))])
SAFE = INNER.buffer(-0.15, join_style=2)
for b in blocks:
    lu, lv = b['stallsPerRow'] * STALL_W, b['rows'] * STALL_D; c = b['c']; shift = np.zeros(2); why = None
    if b['rows'] == 1 and b['stallsPerRow'] >= 8:
        d = 99.0
        for t in np.linspace(-lu / 2, lu / 2, 2 * b['stallsPerRow'] + 1):   # 줄의 모든 칸이 벽 안에 들도록: 줄을 따라가며 벽까지 가장 짧은 거리
            hit = LineString([c + U * t, c + U * t + V * 30]).intersection(INNER.exterior)
            if not hit.is_empty: d = min(d, Point(c + U * t).distance(hit))
        if d < 6.0: shift = V * (d - lv / 2 - 0.15); why = '가장자리 줄: 혜인관 쪽 벽에 붙임'
    if not SAFE.contains(rect(c + shift, lu, lv)):
        q = INNER.exterior.interpolate(INNER.exterior.project(Point(c))); inward = c - np.array(q.coords[0]); inward /= np.hypot(*inward)   # 가장 가까운 벽에서 직각으로 안쪽
        for step in np.arange(0.25, 2.01, 0.25):   # 2 m 까지만 민다(잔차 안). 그래도 나가는 칸은 아래에서 뺀다
            if SAFE.contains(rect(c + shift + inward * step, lu, lv)): shift = shift + inward * step; why = (why + ', ' if why else '') + '외곽 밖으로 나가 안으로 밂'; break
    b['c'] = c + shift; b['shiftM'] = r2(np.hypot(*shift)); b['shiftWhy'] = why

# ---------- 칸 ----------
def stalls_of(b):
    n, rows = b['stallsPerRow'], b['rows']
    return [rect(b['c'] + U * ((i - (n - 1) / 2) * STALL_W) + V * ((r - (rows - 1) / 2) * STALL_D), STALL_W, STALL_D) for r in range(rows) for i in range(n)]

# ---------- 길이 꼭 지나야 하는 자리(칸을 두지 않는다) ----------
CC = np.array(RP['center']); R, LW = RP['laneRadiusM'], RP['laneWidthM']
WA, WB = np.array([201140.1, 557255.5]), np.array([201146.2, 557293.5]); w = (WB - WA) / np.hypot(*(WB - WA)); e = np.array([w[1], -w[0]])   # 운동장 서쪽 변(U02 와 같은 축)
arc = lambda r, th: CC + r * (np.cos(th) * e - np.sin(th) * w)
S0, W0, RB = xy(RP['top']), xy(RP['curveEnd']), xy(RP['bottom']); J0, WALLPT = xy(AP['junction']), xy(AP['wall']); DOOR, SBN, ST = xy(PT['DOOR']), xy(PT['SBN']), xy(PT['ST']); H_BOT, H_OUT = xy(HY['bottom']), xy(HY['out'])
half = Polygon([arc(R + LW / 2 + 0.2, t) for t in np.linspace(0, np.pi, 37)])                      # 섬 + 굽은 차로 + 바깥 낮은 벽
strip = lambda a, b: LineString([a, b]).buffer(LW / 2 + 0.2, cap_style=2)
HOLE_B1 = unary_union([half, strip(W0, W0 + w * RP['openingStraightM'])])                          # 지하 1층: 바닥이 트인 곳(경사로 구멍)과 섬
HOLE_B2 = unary_union([half, strip(W0, RB)])                                                       # 지하 2층: 경사로 판이 바닥에서 올라가는 자리 전부
lane = lambda a, b, wd: LineString([a, b]).buffer(wd / 2, cap_style=2)
KEEP_B1 = unary_union([HOLE_B1.buffer(0.5), lane(S0, S0 + w * 9.0, 6.0),                           # 경사로 머리로 들어서는 차로(머리에서 북쪽으로 9 m)
                       lane(WALLPT, J0 - (WALLPT - J0) / np.hypot(*(WALLPT - J0)) * 6.0, AP['widthM']),   # 북서 들머리(지하 차도가 들어오는 폭 7.2 m)를 6 m 더 안으로
                       lane(DOOR, SBN, 4.0), Point(SBN).buffer(2.5), lane(H_OUT, H_OUT - V * 5.0, 3.0), Point(H_OUT).buffer(2.0)])   # 은주관 문·운동장 계단 발치, 혜인관 통로 어귀
KEEP_B2 = unary_union([HOLE_B2.buffer(0.5), lane(RB, RB + w * 9.0, 6.0)])                           # 경사로 발치에서 나오는 차로

def level(keep, hole, z, tag):
    out = []; dropped = 0
    for b in blocks:
        cells = stalls_of(b); kept = [s for s in cells if SAFE.contains(s) and not keep.intersects(s)]; dropped += len(cells) - len(kept)
        if not kept: continue
        g = unary_union(kept).buffer(0.01, join_style=2).buffer(-0.01, join_style=2)
        for j, part in enumerate(g.geoms if hasattr(g, 'geoms') else [g]):
            mine = [s for s in kept if part.buffer(0.05).contains(s)]
            if len(mine) < 2: dropped += len(mine); continue   # 혼자 남은 칸은 두지 않는다
            out.append({'block': b['id'], 'id': f"{b['id']}{'abc'[j] if hasattr(g, 'geoms') else ''}", 'polygon': part, 'stalls': mine, 'rows': b['rows']})
    solid = unary_union([o['polygon'] for o in out])
    raw = INNER.difference(solid).difference(hole)
    aisle = raw.buffer(-0.6, join_style=2).buffer(0.6, join_style=2).intersection(raw).buffer(0)      # 폭 1.2 m 가 안 되는 틈(묶음과 벽 사이, 경사로 옆)은 길이 아니다
    aisle = max(aisle.geoms, key=lambda g: g.area) if hasattr(aisle, 'geoms') else aisle
    aisle = aisle.simplify(0.02)
    return {'tag': tag, 'z': z, 'blocks': out, 'aisle': aisle, 'dropped': dropped, 'stalls': sum(len(o['stalls']) for o in out), 'stallArea': solid.area}
B1 = level(KEEP_B1, HOLE_B1, Z1, 'B1'); B2 = level(KEEP_B2, HOLE_B2, Z2, 'B2')

# 접속점이 면 위(또는 경계 0.5 m 안)에 있어야 서버가 면을 건너는 길로 센다
for name, p, lv in (('북서 들머리', J0, B1), ('U자 경사로 머리', S0, B1), ('은주관 문', DOOR, B1), ('운동장 계단 발치', SBN, B1), ('혜인관 통로 어귀', H_OUT, B1), ('U자 경사로 발치', RB, B2)):
    d = lv['aisle'].distance(Point(p)); assert d < 0.3, (name, d)
assert not B1['aisle'].contains(Point(H_BOT))
for lv in (B1, B2): assert len(lv['aisle'].interiors) <= 100 and lv['aisle'].is_valid, len(lv['aisle'].interiors)

# 통로 폭: 이웃한 묶음 사이의 가장 좁은 틈
def gaps(lv):
    ps = [o['polygon'] for o in lv['blocks']]; g = sorted(r2(a.distance(b)) for i, a in enumerate(ps) for b in ps[i + 1:] if 1.2 <= a.distance(b) < 12)
    return g
long_rows = [b for b in blocks if b['rows'] == 2 and b['stallsPerRow'] >= 15]; long_rows.sort(key=lambda b: float(b['c'] @ V))
pitch = [r2((b['c'] - a['c']) @ V) for a, b in zip(long_rows, long_rows[1:])]

# ---------- 구조물: 칸 바닥(묶음마다 한 판)과 칸 선(묶음 외곽 + 칸 사이 + 두 줄 묶음의 가운데 선) ----------
SRC = '학교 캠퍼스맵 지하도 연결 지점(사용자 제공 2026-10-12, 원천): 운동장 지하 주차장의 주차 칸 배치. 사용자 지시 2026-10-12(주차 자리를 뺀 나머지를 길로). 구역 노트 운동장 아래 지하층과 지하 차도'
FEATS = []
def ring(poly): return [[[r2(x), r2(y)] for x, y in r.coords] for r in [poly.exterior] + list(poly.interiors)]
def feat(fid, poly, lo, hi, color, grade, assumption, name):
    geom = {'type': 'Polygon', 'coordinates': ring(poly)} if poly.geom_type == 'Polygon' else {'type': 'MultiPolygon', 'coordinates': [ring(p) for p in poly.geoms]}
    FEATS.append({'type': 'Feature', 'properties': {'id': fid, 'type': 'wall', 'kind': 'extrude', 'estimated': True, 'grade': grade, 'assumption': assumption, 'source': SRC, 'fromM': r2(lo), 'toM': r2(hi), 'material': 'concrete', 'inVoid': True,
                                                    'underground': True, 'color': color, 'name': name}, 'geometry': geom})
PAD, PAINT = '#8a8d92', '#ecead9'
for lv in (B2, B1):   # 지하 2층을 먼저: 위에서 비쳐 볼 때 지하 1층이 위에 그려진다
    for o in lv['blocks']:
        g_layout = f"원천(묶음의 자리·방향·줄 수: 학교 지도, 좌표 맞춤 잔차 RMS {RES} m), 추정(칸 치수 {STALL_W} × {STALL_D} m·칸 수" + (', 지하 2층도 같은 배치)' if lv is B2 else ')')
        feat(f"U04-STALLS-{lv['tag']}-{o['id']}", o['polygon'], lv['z'], lv['z'] + 0.02, PAD, g_layout, f"주차 칸 묶음 {o['id']}: {o['rows']}줄, {len(o['stalls'])}칸. 길이 아니다(통로 면에서 뺀 자리)", '주차 칸')
        inner = unary_union([s.buffer(-LINE / 2, join_style=2) for s in o['stalls']])
        paint = o['polygon'].buffer(LINE / 2, join_style=2).difference(inner).buffer(0)
        feat(f"U04-BAYLINE-{lv['tag']}-{o['id']}", paint, lv['z'], lv['z'] + 0.04, PAINT, '원천(칸 선이 있음·방향), 추정(칸 너비·선 굵기)', f"주차 칸 선(굵기 {LINE} m): 묶음 외곽과 칸 사이" + (', 두 줄 사이 가운데 선' if o['rows'] == 2 else ''), '주차 칸 선')
(STR / 'u04-parking.geojson').write_text(json.dumps({'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
    'provenance': {'script': 'docs/audit/u04/build.py', 'note': '운동장 지하 1층·2층 바닥의 주차 칸 묶음과 칸 선. underground: true 인 상자는 지하 길을 켜면 땅을 비쳐 보인다. 통로(길)는 구조물이 아니라 공간 영역(주차장 통로 면)이다'}, 'features': FEATS}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

# ---------- 공간 영역(통로 면) ----------
(HERE / 'areas').mkdir(exist_ok=True)
def area_body(lv, name, extra):
    a = lv['aisle']; open_ring = lambda r: [[r2(x), r2(y)] for x, y in list(r.coords)[:-1]]
    return {'name': name, 'kind': 'parking', 'elevationM': lv['z'], 'coordinates': open_ring(a.exterior), 'holes': [open_ring(r) for r in a.interiors],
            'note': f"U04. 사용자 지시 2026-10-12: 주차 자리를 뺀 나머지를 길로. 주차장 평면(U02, 학교 지도 외곽)에서 주차 칸 묶음 {len(lv['blocks'])}개와 U자 경사로 자리를 뺀 면. 차와 사람이 함께 쓴다(kind parking). 묶음 배치는 학교 지도(원천, 좌표 맞춤 잔차 RMS {RES} m), 칸 치수 {STALL_W} × {STALL_D} m 는 추정. {extra}"}
bodies = {'b1': area_body(B1, '운동장 지하 1층 주차장 통로 면', '접속: 북서 들머리(지하 차도), U자 경사로 머리, 은주관 문·운동장 계단 발치, 혜인관 통로 어귀.'),
          'b2': area_body(B2, '운동장 지하 2층 주차장 통로 면', '배치는 지하 1층과 같게 두고(추정) U자 경사로 판 자리의 칸을 뺐다. 접속: U자 경사로 발치 하나(걷는 길 없음).')}
for k, b in bodies.items(): (HERE / 'areas' / f'{k}.json').write_text(json.dumps(b, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

# ---------- 길 변경 묶음: 주차장 안의 추정 선을 거두고, 혜인관 계단 발치에서 벽을 지나 통로 면에 닿는 통로만 새로 ----------
node = lambda i: {'at': {'nodeId': i}}
N_HBOT = '79988154-51eb-4e57-bff2-a78064906646'
RETIRE = [('428a3aeb-2c54-4b78-9e3d-585548f75d74', 6, '지하 1층 차로(북서 들머리 ~ U자 경사로 머리)'), ('9880169d-71d8-4acd-8941-56933ce51b09', 5, '지하 1층 차로(U자 경사로 머리 ~ 주차 자리)'),
          ('e34f896c-ef52-4cf0-9451-8451adc20577', 4, '지하 2층 차로(U자 경사로 발치 ~ 주차 자리)'), ('a789c985-e419-4509-a709-76422a37ad0e', 8, '지하 1층 보행 동선(혜인관 계단 아래 ~ 북서 들머리, 대각선)'),
          ('6e7ce206-7954-4469-9f97-d2fb1b8fc118', 1, '지하 1층 보행 동선(북서 들머리 ~ 은주관 문 앞)')]
EV = '사용자 지시 2026-10-12: "주차장 내에 뭔가 애매한 길은 제외하고, 이전에 보내준 이미지 참고해서 주차 자리 빼고 나머지를 길로". 이 선은 U01·U02 가 근거 없이 그은 안쪽 선(추정)이다. 통로는 공간 영역 "운동장 지하 1층·2층 주차장 통로 면"이 대신한다'
ops = [{'ref': f'거둠: {ref}', 'op': 'retire_feature', 'args': {'type': 'road', 'id': rid, 'expectedRevision': rev}, 'grade': '확정(사용자 지시)', 'evidence': EV} for rid, rev, ref in RETIRE]
ops.append({'ref': '혜인관 통로(계단 발치 ~ 주차장)', 'op': 'create_road', 'args': {'roadClass': 'pedestrian', 'name': '혜인관 지하통로 계단 발치 ~ 운동장 지하 1층 주차장 (벽을 지나는 문 통로. 자리 추정)', 'structure': 'ordinary', 'widthM': 2,
            'vehicleAccess': 'prohibited', 'pedestrianAccess': 'allowed', 'vehicleDirection': 'both', 'pedestrianDirection': 'both', 'path': [node(N_HBOT), {'xy': [r2(H_OUT[0]), r2(H_OUT[1])], 'z': Z1}], 'zMode': 'explicit', 'densify': False},
            'grade': '확정(혜인관 안 계단으로 내려와 주차장으로 나온다: 사용자, 학교 안내 글), 추정(자리)', 'evidence': '거둔 보행 동선 a789c985 의 첫 구간(계단 발치 → 벽 → 주차장 안 6.5 m)만 남긴 것. 빈 곳 U02-VOID-HYEIN-PASSAGE 자리. 주차장 쪽 끝이 통로 면의 접속점이 된다'})
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'u04.json').write_text(json.dumps({'id': 'U04', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U04: 운동장 지하 주차장 안의 추정 선 5개를 거두고(통로는 공간 영역으로), 혜인관 계단 발치에서 주차장으로 나오는 통로', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

# ---------- 수치 ----------
pl = lambda p: [[r2(x), r2(y)] for x, y in p.exterior.coords]
def lv_out(lv): return {'floorM': lv['z'], 'blocks': [{'id': o['id'], 'rows': o['rows'], 'stalls': len(o['stalls']), 'polygon': pl(o['polygon'])} for o in lv['blocks']], 'stalls': lv['stalls'], 'stallsDropped': lv['dropped'],
                        'stallAreaM2': r2(lv['stallArea']), 'aisleAreaM2': r2(lv['aisle'].area), 'aisleHoles': len(lv['aisle'].interiors), 'aisleVertices': len(lv['aisle'].exterior.coords) + sum(len(r.coords) for r in lv['aisle'].interiors),
                        'aisle': ring(lv['aisle']), 'gapsBetweenBlocksM': {'min': gaps(lv)[0], 'median': r2(np.median(gaps(lv)))}}
out = {'georefRmsM': RES, 'stallM': [STALL_W, STALL_D], 'rowAzimuthDeg': {'map': r2(MAP_AZ), 'hyeinWall': r2(WALL_AZ), 'used': r2(WALL_AZ)}, 'parkingAreaM2': r2(INNER.area), 'longRowPitchM': pitch,
       'mapBlocks': [{k: b[k] for k in ('id', 'px', 'mapCentre', 'mapAlongM', 'mapAcrossM', 'rows', 'stallsPerRow', 'shiftM', 'shiftWhy', 'manual')} | {'centre': [r2(b['c'][0]), r2(b['c'][1])]} for b in blocks],
       'B1': lv_out(B1), 'B2': lv_out(B2), 'points': {'hyeinOut': [r2(H_OUT[0]), r2(H_OUT[1]), Z1], 'rampBottomNode': '89be4757-d080-42d9-a175-e1f39885b8f4'}}
(HERE / 'stalls.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({k: out[k] for k in ('rowAzimuthDeg', 'longRowPitchM', 'parkingAreaM2')}, ensure_ascii=False))
for b in out['mapBlocks']: print(b['id'], b['px'], 'map', b['mapAlongM'], 'x', b['mapAcrossM'], '->', b['rows'], '줄 x', b['stallsPerRow'], '칸', 'shift', b['shiftM'], b['shiftWhy'] or '')
for t in ('B1', 'B2'): print(t, {k: v for k, v in out[t].items() if k not in ('blocks', 'aisle')})
print(len(FEATS), 'features')
