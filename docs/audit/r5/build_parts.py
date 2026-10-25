"""R5(2026-10-25): 혜인관 북동 어귀 → 1주차장 B1 계단(E1), 과속방지턱(E6), 혜인관 북동 장애인 칸(E7)을 전수 판독 R5 대로 넣는다. DB·네트워크 접근 없음.
  python -X utf8 build_parts.py          # 고쳐 씀
  python -X utf8 build_parts.py --dry    # 쓰지 않고 수치만
근거: 볼트 데이터/보완자료/학교-전경-20261022/전수판독/R5/판독.md(보완 목록 E1~E8, 그림 03·05·20·21, S-MAP 정사 10),
  동 노트 혜인관·청운관·본관·수인관, 구역 노트 운동장 아래 지하층과 지하 차도·혜인관 둘레·분수 광장과 주변의 "2026-10-25 R5 전수 판독 반영" 절.
r1~r4 처럼 id 로 고친다. 처음 실행 때 지우는 지물의 원본을 base.json 에 남기고, 다음 실행은 원본에서 다시 시작한다(몇 번 돌려도 같다. r4/build_parts.py 다음에 돌린다).

E1 혜인관 북동 콘크리트 어귀(B13-HYEIN-NE-PORTAL) = 1주차장 B1 사람 출입구(학교 지하도 지도 "청운관 동", 사진 02: 있음 확정에 가까운 추정).
   어귀 틀(옆벽 둘·윗판)은 그대로. 틀 안 쪽을 계단으로: 어귀 앞 땅 149.6(청운관 둘레 기단 Z05-PLATFORM-CHEONGUN-CHEONGUN-GROUND 윗면)
   → B1 143.5, 6.1 m 를 34 단(단 0.179 m, 디딤 0.25 m), 두 줄 17 단씩 되돌림 한 번(평면·단 수 추정).
   줄은 어귀 옆벽과 나란히: 윗줄은 입 쪽(u 1.6~2.95) 북서 → 남동, 참(146.55)은 남동 끝 옆벽 밖 땅 밑까지(v 4.95~6.2),
   아랫줄(u 0.15~1.5)은 남동 → 북서, 아래 끝 북서에서 B1 북동 벽(학교 지도 외곽)의 문을 지나 B1(통로 면 4).
   어귀 입의 "어두운 판"(B13-HYEIN-NE-PORTAL-OPENING, 뚫린 곳 표시)은 이제 빈 곳을 실제로 만들므로 걷음.
E6 과속방지턱: 유담관 옆 차도 (201086.2~201092.3, 557225.6~557229.2), 노랑·흰 줄 8 마디(X36-BUMP 와 같은 꼴), 길 기단 윗면 + 0.08.
E7 혜인관 북동 장애인 칸 둘: S-MAP 정사 10 에서 다시 읽음 (201260.7~201265.8, 557253.2~557260.3), 칸마다 3.55 x 5.1 m 파랑 칠,
   서쪽 옆 빗금 통로 (201259.5~201260.7) 회색·흰. 판독 표의 (201255~201260, 557256~557261) 은 빗금과 칸 사이 경계를 잘못 읽은 것(정사 격자로 다시 잼).
고치는 파일(frontend/public/structures): b13-hyein(어두운 판 걷음), r5-underground(새)."""
import json, pathlib, copy, sys, math
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape, box
from shapely.ops import unary_union

DRY = '--dry' in sys.argv
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
STR = REPO / 'frontend' / 'public' / 'structures'
BASEF = HERE / 'base.json'
r2 = lambda v: round(float(v), 2)
OUT = 'r5-underground.geojson'
SRC = '판독 보완자료/학교-전경-20261022/전수판독/R5/판독.md(사진 02·학교 지하도 지도·S-MAP 정사 10·R3 정사)'

FILES = ['b13-hyein.geojson']
DROP = ['B13-HYEIN-NE-PORTAL-OPENING']
MOD = ['B13-HYEIN-NE-PLANTER-EDGE', 'B13-HYEIN-NE-PLANTER-HEDGE']
D = {fn: json.loads((STR / fn).read_text(encoding='utf-8')) for fn in FILES}
def dump(path, obj):
    if not DRY: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
BASE = json.loads(BASEF.read_text(encoding='utf-8')) if BASEF.exists() else None
if BASE:   # 다시 돌릴 때: 원본으로 되돌림(걷은 것을 되살린 뒤 다시 걷는다)
    for fn in FILES:
        orig = BASE['features'].get(fn, {}); have = {f['properties']['id'] for f in D[fn]['features']}
        D[fn]['features'] = [copy.deepcopy(orig[f['properties']['id']]) if f['properties']['id'] in orig else f for f in D[fn]['features']]
        D[fn]['features'] += [copy.deepcopy(f) for i, f in orig.items() if i not in have]
IDX = {f['properties']['id']: (fn, f) for fn in FILES for f in D[fn]['features']}
if not BASE and not DRY:
    BASE = {'features': {}}
    for i in DROP + MOD: fn, f = IDX[i]; BASE['features'].setdefault(fn, {})[i] = copy.deepcopy(f)
    dump(BASEF, BASE)

OTHERS = {}
for fp in sorted(STR.glob('*.geojson')):
    if fp.name == OUT or fp.name.startswith('a2-'): continue
    for ft in json.loads(fp.read_text(encoding='utf-8'))['features']:
        if ft['properties'].get('id') not in DROP + MOD: OTHERS[ft['properties'].get('id')] = ft

def ring1(coords, ccw):
    p = []
    for x, y in list(coords)[:-1]:
        q = [r2(x), r2(y)]
        if not p or q != p[-1]: p.append(q)
    if p[0] == p[-1]: p.pop()
    if Polygon(p).exterior.is_ccw is not ccw: p = p[::-1]
    return p + [p[0]]
def geom(g):
    g = g.buffer(0)
    assert g.geom_type == 'Polygon' and g.area > 0.0005, g
    return {'type': 'Polygon', 'coordinates': [ring1(g.exterior.coords, True)]}
REPORT = []
NEW = []
def feat(fid, typ, g, z0, z1, what, grade, base, kind='extrude', **extra):
    assert z1 > z0, fid
    NEW.append({'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': kind, 'estimated': True, 'grade': grade, 'basePlane': base,
                'fromM': r2(z0), 'toM': r2(z1), 'assumption': 'R5: ' + what, 'source': SRC, **extra}, 'geometry': geom(g)})

def top_fn(p):
    if p.get('topProfile') is None: return lambda x, y: float(p['topM'])
    tp = p['topProfile']; (ox, oy), (dx, dy) = tp['origin'], tp['direction']; n = math.hypot(dx, dy); pts = sorted(tp['points'])
    def f(x, y):
        d = ((x - ox) * dx + (y - oy) * dy) / n
        if d <= pts[0][0]: return float(pts[0][1])
        for (a, h), (b, k) in zip(pts, pts[1:]):
            if d <= b: return h + (k - h) * (d - a) / (b - a)
        return float(pts[-1][1])
    return f
PLATS = [(i, shape(ft['geometry']).buffer(0), top_fn(ft['properties'])) for i, ft in OTHERS.items()
         if ft['properties'].get('kind') == 'platform' and ('topM' in ft['properties'] or 'topProfile' in ft['properties'])]
def ground(x, y):
    hit = [(i, t(x, y)) for i, g, t in PLATS if g.contains(Point(x, y))]
    assert hit, (x, y)
    return max(hit, key=lambda h: h[1])

# ===================== E1 어귀 → 1주차장 B1 계단 =====================
G_E1 = '있음: 확정에 가까운 추정(사진 02 아래로 내려가는 어귀 + 학교 지하도 지도 초록 점 "청운관 동" 7 m), 평면·단 수·참·문 자리 추정'
def pier(i): return np.array(shape(OTHERS[i]['geometry']).exterior.coords[:-1])
P1 = pier('B13-HYEIN-NE-PORTAL-PIER-1')
O = np.array([201238.29, 557262.27])                          # 북서 옆벽(PIER-1)의 남서 바깥 모서리
U = np.array([201239.84, 557264.84]) - O; U = U / np.hypot(*U) # 옆벽 따라 어귀 입 쪽(북동)
V = np.array([U[1], -U[0]])                                     # 옆벽에서 옆벽으로(남동)
def P(u, v): q = O + U * u + V * v; return (float(q[0]), float(q[1]))
def Q(u0, u1, v0, v1): return Polygon([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)])
def uv(x, y): d = np.array([x, y]) - O; return float(d @ U), float(d @ V)
ZB1 = 143.5
gid, ZTOP = ground(*P(3.4, 0.6))
NR = 34; RISE = (ZTOP - ZB1) / NR; RUN = 0.25; HALF = NR // 2
ZL = ZTOP - HALF * RISE                                             # 참
V0 = 0.95                                                           # 윗줄 첫 단(그 앞 v 0.35~0.95 는 입 쪽 선 자리)
VL = V0 + (HALF - 1) * RUN                                          # 참 시작(= 4.95, 남동 옆벽 안쪽 면)
VE = 6.2                                                            # 참 끝(옆벽 밖 땅 밑 1.25 m)
UA = (1.6, 2.95); UB = (0.15, 1.5)                                  # 윗줄 · 아랫줄
B1W = (np.array([201242.8, 557253.1]), np.array([201237.2, 557264.8]))   # 학교 지도 B1 외곽 북동 변(U02-VOID-B1)
wall = LineString([tuple(B1W[0] + (B1W[0] - B1W[1]) * 0.5), tuple(B1W[1] + (B1W[1] - B1W[0]) * 0.5)])
REPORT.append(f'E1 어귀 앞 땅 {gid} {ZTOP:.2f}, 높이 차 {ZTOP - ZB1:.2f} m, {NR} 단 x {RISE:.3f} m, 디딤 {RUN} m, 참 {ZL:.2f}')
UG = dict(underground=True, inVoid=True)
feat('R5-HYEIN-NE-STAIRWELL', 'void', Q(-0.0, 3.0, 0.35, VE), ZB1, ZTOP, '혜인관 북동 어귀 계단실(1주차장 B1 사람 출입구, 학교 지도 "청운관 동"): 어귀 틀 안과 남동 옆벽 밖 땅 밑 1.25 m',
     G_E1, gid, kind='void', name='청운관 동 지하통로 계단(1주차장 B1)')
feat('R5-HYEIN-NE-DOORWAY', 'void', Q(-1.2, 0.15, 0.35, 1.55), ZB1, ZB1 + 2.5, '계단 아래 끝에서 B1 북동 벽을 지나는 문 통로', G_E1, 'U02-VOID-B1', kind='void',
     name='청운관 동 지하통로 문(1주차장 B1)')
feat('R5-HYEIN-NE-STAIR-TOP', 'landing', Q(UA[0], 3.0, 0.35, V0), ZB1, ZTOP, f'어귀 입 안 선 자리({ZTOP:.1f} = 어귀 앞 땅)', G_E1, gid, color='#8e8f8c')
for k in range(1, HALF):
    z = ZTOP - k * RISE; vu = V0 + (k - 1) * RUN
    feat(f'R5-HYEIN-NE-STAIR-A{k:02d}', 'stair_step', Q(UA[0], UA[1], vu, vu + RUN), ZB1, z, f'윗줄 {k}/{HALF} 단(북서 → 남동)', G_E1, gid,
         color='#9a9b98', stair='R5-HYEIN-NE-STAIR-A', riseM=round(RISE, 3), runM=RUN, widthM=r2(UA[1] - UA[0]), **(UG if vu + RUN > 4.95 else {}))
feat('R5-HYEIN-NE-STAIR-LANDING', 'landing', Q(UB[0], UA[1], VL, VE), ZB1, ZL, f'참({ZL:.2f}, 되돌림. 남동 옆벽 밖 땅 밑까지)', G_E1, gid, color='#8e8f8c', **UG)
for k in range(1, HALF):
    z = ZL - k * RISE; vt = VL - (k - 1) * RUN
    feat(f'R5-HYEIN-NE-STAIR-B{k:02d}', 'stair_step', Q(UB[0], UB[1], vt - RUN, vt), ZB1, z, f'아랫줄 {k}/{HALF} 단(남동 → 북서, 마지막 단 다음이 B1 바닥 {ZB1})', G_E1, gid,
         color='#9a9b98', stair='R5-HYEIN-NE-STAIR-B', riseM=round(RISE, 3), runM=RUN, widthM=r2(UB[1] - UB[0]), **UG)
feat('R5-HYEIN-NE-STAIR-SPLIT', 'wall', Q(UB[1], UA[0], 0.35, VL), ZB1, ZTOP + 0.9, '두 줄 사이 벽(위 끝 손잡이 높이, 추정)', G_E1, gid, color='#b9b8b2', material='concrete')
feat('R5-HYEIN-NE-STAIR-PARAPET', 'wall', Q(2.95, 3.1, V0, 4.95), ZTOP, ZTOP + 1.0, '어귀 입의 윗줄 옆 낮은 벽(떨어짐 막이, 추정)', G_E1, gid, color='#b9b8b2', material='concrete')
for fid, g, what in (('R5-HYEIN-NE-STAIR-WALL-SW', Q(-0.2, 0.0, 1.55, VE + 0.2), '계단실 남서 벽(B1 쪽)'),
                     ('R5-HYEIN-NE-STAIR-WALL-SE', Q(-0.2, 3.15, VE, VE + 0.2), '계단실 남동 끝 벽(땅 밑)'),
                     ('R5-HYEIN-NE-STAIR-WALL-NE', Q(2.95, 3.15, 4.95, VE), '계단실 북동 벽(옆벽 밖 땅 밑)')):
    feat(fid, 'wall', g, ZB1, ZTOP - 0.3, what, G_E1, gid, color='#b9b8b2', material='concrete', **UG)
# 문: 문 통로가 B1 북동 벽(학교 지도 외곽)을 지나는 자리
door = Q(-1.2, 0.15, 0.45, 1.45).intersection(wall.buffer(0.06, cap_style=2))
feat('R5-HYEIN-NE-B1-DOOR', 'wall', door, ZB1, ZB1 + 2.2, '1주차장 B1 북동 벽의 문(갈색 철문으로 둠: 청운관 쪽 문과 같은 색, 추정)', G_E1, 'U02-VOID-B1', color='#6b4a2f', **UG)
TOP = P(3.4, 0.65); MID = P(2.25, 0.65); LAND = P((UB[0] + UA[1]) / 2, (VL + VE) / 2); FOOT = P(0.8, 0.65); IN = P(-1.6, 0.95)
REPORT.append('E1 길 꼭짓점: 입 앞 %s %.2f / 선 자리 %s / 윗줄 끝 %s %.2f / 참 %s %.2f / 아랫줄 끝 %s %.2f / 문 지나 B1 %s %.2f' % (
    [r2(c) for c in TOP], ZTOP, [r2(c) for c in MID], [r2(c) for c in P(2.25, VL)], ZL, [r2(c) for c in LAND], ZL,
    [r2(c) for c in P(0.8, V0)], ZB1, [r2(c) for c in IN], ZB1))
REPORT.append('E1 꼭짓점(u,v): 북서 옆벽 남서 %s, 남동 옆벽 남서 %s, 계단실 네 모서리 %s' % (
    [r2(c) for c in O], [r2(c) for c in P(0, 5.3)], [[r2(c) for c in P(a, b)] for a, b in ((0, 0.35), (3, 0.35), (3, VE), (0, VE))]))
REPORT.append(f'E1 문 가운데 {[r2(c) for c in door.centroid.coords[0]]}, 폭 {door.length / 2:.2f} m(둘레/2)')
REPORT.append(f'E1 B1 벽까지 거리: 문 통로 끝 IN {wall.distance(Point(IN)):.2f} m, 안쪽 여부 {shape(OTHERS["U02-VOID-B1"]["geometry"]).contains(Point(IN))}')

# ===================== E6 과속방지턱 =====================
G_E6 = '확정(있음·자리: R3 정사 0.025 m/px, 구역 노트 분수 광장과 주변 557219~557229 표), 추정(높이·마디 수)'
XA, XB, YA, YB = 201086.2, 201092.3, 557225.6, 557229.2
KERB = unary_union([shape(ft['geometry']).buffer(0) for i, ft in OTHERS.items() if str(i).startswith(('Z12-KERB-', 'Z13-KERB-'))])
XB0 = XB; XB = min(XB, round(KERB.intersection(box(XA, YA, XB, YB)).bounds[0] - 0.02, 2))   # 정사 띠 동쪽 끝은 턱(Z12-KERB-E) 위: 턱 앞에서 끝냄
REPORT.append(f'E6 동쪽 끝 {XB0} → {XB} (턱 앞)')
NB = 8; W = (XB - XA) / NB
for k in range(NB):
    x0 = XA + k * W; gb, z = ground(x0 + W / 2, (YA + YB) / 2)
    feat(f'R5-YUDAM-BUMP-{k + 1}', 'wall', box(x0, YA, x0 + W, YB), z - 0.05, z + 0.08, f'유담관 옆 차도 과속방지턱(노랑·흰 빗금 띠, 폭 3.6 m, 높이 0.08 추정) {k + 1}/{NB}',
         G_E6, gb, color='#f2c230' if k % 2 == 0 else '#f2f2ee')
REPORT.append(f'E6 과속방지턱 기단 {gb}, 바닥 {ground(XA + W / 2, (YA + YB) / 2)[1]:.2f}~{ground(XB - W / 2, (YA + YB) / 2)[1]:.2f}')

# ===================== E7 혜인관 북동 장애인 칸 =====================
G_E7 = '확정(있음: S-MAP 정사 10·사진 02), 추정(칸 크기 ±0.3 m, 휠체어 그림은 흰 네모로 줄임)'
def pieces(g):   # 기단마다 나눈 조각과 그 윗면(청운관 둘레 149.6 / 혜인관 둘레 149.0 경계가 칸을 지나감: 기단 외곽 ±1.5 m 추정)
    out = []
    for i, h, t in PLATS:
        q = g.intersection(h)
        if q.area < 0.05: continue
        for part in (q.geoms if q.geom_type in ('MultiPolygon', 'GeometryCollection') else [q]):
            if part.geom_type == 'Polygon' and part.area >= 0.05: c = part.representative_point(); out.append((part, i, t(c.x, c.y)))
    keep = []
    for part, i, z in sorted(out, key=lambda o: -o[2]):   # 겹친 기단은 높은 쪽
        rest = part.difference(unary_union([k[0] for k in keep])) if keep else part
        if rest.area >= 0.05: keep.append((rest, i, z))
    return keep
def paint_on(fid, g, dz0, dz1, what, color):
    ps = pieces(g)
    for n, (part, gb, z) in enumerate(ps):
        sub = part if part.geom_type == 'Polygon' else max(part.geoms, key=lambda q: q.area)
        feat(fid if len(ps) == 1 else f'{fid}-{n + 1}', 'wall', sub, z + dz0, z + dz1, f'{what}, 바닥 {z:.2f}', G_E7, gb, color=color, surfaceMark=True)
        REPORT.append(f'E7 {fid} 조각 {n + 1}: {gb} {z:.2f} {sub.area:.1f} ㎡')
for k, (y0, y1) in enumerate(((557256.8, 557260.3), (557253.2, 557256.8))):
    c = ((201260.7 + 201265.8) / 2, (y0 + y1) / 2)
    paint_on(f'R5-HYEIN-NE-ACCESSIBLE-{k + 1}', box(201260.7, y0, 201265.8, y1), 0.02, 0.04, f'장애인 주차 칸 {k + 1}(파랑, 3.55 x 5.1 m)', '#2f6db5')
    paint_on(f'R5-HYEIN-NE-ACCESSIBLE-{k + 1}-SIGN', box(c[0] - 0.6, c[1] - 0.6, c[0] + 0.6, c[1] + 0.6), 0.04, 0.05, f'장애인 칸 {k + 1} 흰 그림(네모로 줄임)', '#f2f2ee')
paint_on('R5-HYEIN-NE-ACCESSIBLE-AISLE', box(201259.5, 557253.2, 201260.7, 557260.3), 0.02, 0.035, '장애인 칸 옆 빗금 통로(회색·흰, 빗금은 민 회색으로 줄임)', '#c9cbc7')
STALLS = box(201259.5, 557253.2, 201265.8, 557260.3)
for i in MOD:   # B13 북동 돌 턱 화단·생울타리(자리 추정)가 정사의 장애인 칸 자리와 겹침 → 칸 자리를 뺌
    fn, f = IDX[i]; g0 = shape(f['geometry']).buffer(0); g1 = g0.difference(STALLS.buffer(0.05))
    f['geometry'] = geom(g1); p = f['properties']
    p['assumption'] = p.get('assumption', '').split(' [R5')[0] + ' [R5 2026-10-25: S-MAP 정사의 장애인 칸 둘·빗금 통로 (201259.5~201265.8, 557253.2~557260.3) 자리를 뺌]'
    REPORT.append(f'E7 {i}: {g0.area:.1f} → {g1.area:.1f} ㎡')
    OTHERS[i] = f
shelter = unary_union([shape(OTHERS[i]['geometry']) for i in OTHERS if str(i).startswith('B13-HYEIN-NE-SHELTER-POST')])
REPORT.append(f'E7 쉼터 기둥(B13, 자리 추정)과 칸 겹침 {shelter.intersection(box(201259.5, 557253.2, 201265.8, 557260.3)).area:.3f} ㎡')

# ===================== 겹침 검사(새 것 대 모든 상자) =====================
def solid(ft):
    p = ft['properties']
    if p.get('kind') in ('platform',) or p.get('type') in ('tree', 'surface', 'curb') or not ft.get('geometry') or p.get('fromM') is None: return None
    try: return shape(ft['geometry']).buffer(0), p['fromM'], p['toM'], p.get('kind') == 'void'
    except Exception: return None
SOL = {i: s for i, ft in OTHERS.items() if (s := solid(ft))}
for ft in NEW:
    i = ft['properties']['id']; g, lo, hi, vi = solid(ft)
    for j, (h, lo2, hi2, vj) in SOL.items():
        if vi != vj or hi2 <= lo + 0.005 or lo2 >= hi - 0.005: continue
        a = g.intersection(h).area
        if a > 0.05: REPORT.append(f'겹침 {i} × {j} {a:.2f} ㎡ ({lo}~{hi} / {lo2}~{hi2})')

for fn in FILES:
    D[fn]['features'] = [f for f in D[fn]['features'] if f['properties']['id'] not in DROP]
    dump(STR / fn, D[fn])
dump(STR / OUT, {'type': 'FeatureCollection', 'name': 'r5-underground', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': NEW})
print('\n'.join(REPORT)); print(f'{OUT}: {len(NEW)}', '(dry)' if DRY else '')
