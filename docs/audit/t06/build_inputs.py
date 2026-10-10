"""T06: 지형 조리법(recipe) 입력과 시험용 DB 편집 목록의 재료를 만든다. DB·서버 접근 없음.
사용법(이 폴더에서): python build_inputs.py <roads.json: 시험용 DB 길(적용 직전 상태)>
 입력: ../v02/profile.json(매끄러운 종단, 1 m), ../v02/editor-ops.json, ../e10/field-area.geojson, ../n02/area-plaza.json
 출력: ../../../backend/data/terrain/recipes/t06-road-corridors.json, t06-plateaus.geojson, ./ops-source.json, ./inputs-summary.json
"""
import json, math, sys
PLAZA_Z = 130.6   # 근거: 사용자 핀(포장면 12개 중앙 130.7, 차도 끝 130.4·130.6), V02 종단 끝 130.53
FIELD_Z = 148.9   # 사용자 확정(E06 측정)
RAMP_M = 15.0     # 차도 종단을 포장면 높이에 맞추는 구간 길이(포장면 경계 앞)
OUT = '../../../backend/data/terrain/recipes/'
J = lambda f: json.load(open(f, encoding='utf8'))
prof = J('../v02/profile.json'); v02 = J('../v02/editor-ops.json')
field = J('../e10/field-area.geojson')['features'][0]['geometry']['coordinates'][0]
plaza = J('../n02/area-plaza.json')['coordinates']; plaza = plaza + [plaza[0]]
roads = {r['id']: r for r in J(sys.argv[1])}

def inside(poly, x, y):
    c = False
    for i in range(len(poly) - 1):
        (ax, ay), (bx, by) = poly[i], poly[i + 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax: c = not c
    return c
def chain(xy):
    s = [0.0]
    for a, b in zip(xy, xy[1:]): s.append(s[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return s
def enter(xy, s, poly):
    # 다각형 안으로 들어가는 자리의 거리(이분법)
    for k in range(len(xy) - 1):
        if not inside(poly, *xy[k]) and inside(poly, *xy[k + 1]):
            lo, hi = 0.0, 1.0
            for _ in range(30):
                mid = (lo + hi) / 2; x = xy[k][0] + mid * (xy[k + 1][0] - xy[k][0]); y = xy[k][1] + mid * (xy[k + 1][1] - xy[k][1])
                lo, hi = (lo, mid) if inside(poly, x, y) else (mid, hi)
            return s[k] + hi * (s[k + 1] - s[k])
    raise SystemExit('no crossing')
def interp(s, z, q):
    for k in range(len(s) - 1):
        if s[k] <= q <= s[k + 1]: return z[k] + (z[k + 1] - z[k]) * (q - s[k]) / max(s[k + 1] - s[k], 1e-9)
    return z[-1] if q > s[-1] else z[0]

# 1) 본선: 포장면 경계에서 PLAZA_Z 가 되게 종단 끝을 다듬는다(경계 앞 RAMP_M 에서 0, 경계에서 d, 부드럽게)
m = prof['main']; ms = chain(m['xy']); mz = list(m['z'])
sc = enter(m['xy'], ms, plaza); d = PLAZA_Z - interp(ms, mz, sc)
def adj(s, z):
    if s >= sc: return PLAZA_Z
    t = max(0.0, 1 - (sc - s) / RAMP_M); return z + d * t * t * (3 - 2 * t)
mz2 = [round(adj(s, z), 3) for s, z in zip(ms, mz)]
grade = lambda z: max(abs(z[k + 1] - z[k]) / (ms[k + 1] - ms[k]) * 100 for k in range(len(ms) - 1) if ms[k + 1] - ms[k] > 0.5 and ms[k] > ms[-1] - 40)
summary = {'plazaZ': PLAZA_Z, 'fieldZ': FIELD_Z, 'mainEntersPlazaAtS': round(sc, 2), 'mainLengthM': round(ms[-1], 2), 'v02ProfileAtCrossing': round(interp(ms, mz, sc), 3),
           'raiseAtCrossingM': round(d, 3), 'rampM': RAMP_M, 'last40mMaxGradePct': {'v02': round(grade(mz), 1), 't06': round(grade(mz2), 1)}}

# 2) 차도 띠: 구간별 선(반폭이 다르다). 구간 경계는 V02 의 본선 시작 거리.
SEG = [('V1', 0.0, 3.5), ('V2', 27.5, 3.5), ('V3', 179.1, 3.5), ('V4a', 239.8, 7.0), ('V4b', 275.8, 7.0)]
lines = []
for k, (name, s0, half) in enumerate(SEG):
    s1 = SEG[k + 1][1] if k + 1 < len(SEG) else 1e9
    pts = [[x, y, z] for (x, y), s, z in zip(m['xy'], ms, mz2) if s0 - 1.01 <= s <= s1 + 1.01]
    lines.append({'name': name, 'halfWidthM': half, 'points': pts})
for name in ['P-LOW', 'P-UP', 'U1']:
    p = prof[name]; lines.append({'name': name, 'halfWidthM': 3.0, 'points': [[x, y, z] for (x, y), z in zip(p['xy'], p['z'])]})

# 3) 오르막 보행로 c52095ad: 아래 끝을 포장면 높이로. 아래 세 꼭짓점만 낮춘다(위쪽은 N02 의 S-MAP 값 그대로)
up = next(r for r in roads.values() if r['id'].startswith('c52095ad'))
uc = [list(p) for p in up['c']]
assert inside(plaza, uc[-1][0], uc[-1][1]) and len(uc) == 9, uc[-1]
us = chain([p[:2] for p in uc]); newz = {6: 132.55, 7: 131.5, 8: PLAZA_Z}
uc2 = [[p[0], p[1], newz.get(i, p[2])] for i, p in enumerate(uc)]
usc = enter([p[:2] for p in uc2], us, plaza)
lines.append({'name': 'UPHILL', 'halfWidthM': 4.5, 'points': [[round(v, 3) for v in p] for p in uc2]})
summary['uphill'] = {'roadId': up['id'], 'before': [p[2] for p in uc], 'after': [p[2] for p in uc2],
                     'gradesPctBefore': [round((uc[k + 1][2] - uc[k][2]) / (us[k + 1] - us[k]) * 100, 1) for k in range(8)],
                     'gradesPctAfter': [round((uc2[k + 1][2] - uc2[k][2]) / (us[k + 1] - us[k]) * 100, 1) for k in range(8)], 'entersPlazaAtS': round(usc, 2), 'lengthM': round(us[-1], 2)}
json.dump({'crs': 'EPSG:5186', 'reason': 'T06 차도 띠: V02 의 매끄러운 종단(사용자 S-MAP 높이 핀)을 지형 칸에 새긴다. 본선 끝은 포장면 높이 %.1f m 에 맞춤. UPHILL 은 문예관 옆 오르막 보행로(N02 의 S-MAP 높이, 아래 끝만 포장면 높이). U1 은 조리법에서 고르지 않는다(한림관·은주관 바닥이 5~12 m 내려감).' % PLAZA_Z,
           'source': 'docs/audit/v02/profile.json, docs/audit/t06/build_inputs.py', 'lines': lines}, open(OUT + 't06-road-corridors.json', 'w', encoding='utf8', newline='\n'), ensure_ascii=False)

# 4) 평탄면
feat = lambda name, ring, z, reason: {'type': 'Feature', 'properties': {'name': name, 'srid': 5186, 'heightM': z, 'reason': reason}, 'geometry': {'type': 'Polygon', 'coordinates': [ring]}}
json.dump({'type': 'FeatureCollection', 'features': [
    feat('plaza', plaza, PLAZA_Z, '회차 공간·북악관 현관 앞 포장면의 평탄부(N02 영역). 높이는 사용자 S-MAP 핀(중앙 130.7 m)과 차도 종단 끝(130.53 m)에 맞춘 130.6 m.'),
    feat('field', field, FIELD_Z, '운동장(E10 영역). 바닥 148.9 m 는 사용자 확정(E06 측정).')]}, open(OUT + 't06-plateaus.geojson', 'w', encoding='utf8', newline='\n'), ensure_ascii=False)

# 4b) 번지게 하지 않을 곳(실제 턱·벽으로 확인된 변): 평탄면 경계의 일부 구간을 바깥으로 9 m 넓힌 띠
def band(ring, i0, i1, out=9.0):
    pts = ring[:-1]; n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    sgn = 1 if area > 0 else -1
    off = []
    for i in range(i0, i1 + 1):
        a, b, c = pts[(i - 1) % n], pts[i], pts[(i + 1) % n]
        nx = ny = 0.0
        for (p, q) in ((a, b), (b, c)):
            if (i == i0 and (p, q) == (a, b)) or (i == i1 and (p, q) == (b, c)): continue
            L = math.hypot(q[0] - p[0], q[1] - p[1]); nx += sgn * (q[1] - p[1]) / L; ny += -sgn * (q[0] - p[0]) / L
        L = math.hypot(nx, ny); off.append([round(b[0] + out * nx / L, 2), round(b[1] + out * ny / L, 2)])
    chain_ = [list(pts[i]) for i in range(i0, i1 + 1)]
    return chain_ + off[::-1] + [chain_[0]]
mask = lambda name, ring, reason: {'type': 'Feature', 'properties': {'name': name, 'srid': 5186, 'reason': reason}, 'geometry': {'type': 'Polygon', 'coordinates': [ring]}}
json.dump({'type': 'FeatureCollection', 'features': [
    mask('field-north-wall', band(field, 12, 19), '운동장 북쪽 변: 대일관 앞 흰 돌 화단 벽(사용자 사진으로 확정, E10). 바깥 지면이 1.5~3 m 높다.'),
    mask('plaza-northeast-ledge', band(plaza, 3, 10), '포장면 북동쪽 변: 북악관 현관 계단·화단 쪽 턱(N02 가 S-MAP 메시의 턱으로 경계를 잡은 변). 바깥 지면이 1~2 m 높다.'),
    mask('plaza-west-drop', band(plaza, 12, 13), '포장면 서쪽 변 북쪽 구간: 유담관 쪽으로 3~6 m 떨어지는 단(S-MAP 메시의 턱).')]},
    open(OUT + 't06-no-blend.geojson', 'w', encoding='utf8', newline=chr(10)), ensure_ascii=False)

# 5) 편집 목록 재료: V02 의 것에서 V4a·V4b 와 노드 둘의 높이만 바꾼다
def zat(xy):
    best = (1e9, None)
    for a in range(len(ms) - 1):
        (ax, ay), (bx, by) = m['xy'][a], m['xy'][a + 1]; L2 = (bx - ax) ** 2 + (by - ay) ** 2
        tt = max(0, min(1, ((xy[0] - ax) * (bx - ax) + (xy[1] - ay) * (by - ay)) / L2)); dd = math.hypot(xy[0] - ax - tt * (bx - ax), xy[1] - ay - tt * (by - ay))
        if dd < best[0]: best = (dd, mz2[a] + tt * (mz2[a + 1] - mz2[a]))
    return round(best[1], 2)
ops = []
for o in v02['operations']:
    o = json.loads(json.dumps(o)); a = o['args']
    if o['op'] == 'move_node' and a['nodeId'].startswith(('0a815157', 'a12b5e30')): a['to']['z'] = zat(a['to']['xy'])
    if o['op'] == 'update_road' and a['id'].startswith(('07615440', '67e234b5')):
        for p in a['path']: p['z'] = zat(p['xy'])
    ops.append({'id': 'T06-' + o['id'], 'op': o['op'], 'preState': o.get('preState'), 'args': a})
summary['v4'] = {o['id']: ([p['z'] for p in o['args']['path']] if o['op'] == 'update_road' else o['args']['to']['z']) for o in ops if any(k in o['id'] for k in ('V4', '0a815157', 'a12b5e30'))}
PLAZA_NODES = ['a12b5e30', 'e13a5ce2', '438353e0', 'bd52b7a9', '1c589868', 'be0dbc5c', 'cac552f8', '4c8924d4', 'fa8ea5b3']
json.dump({'plazaNodes': PLAZA_NODES, 'plazaZ': PLAZA_Z, 'operations': ops, 'uphill': {'id': up['id'], 'path': [{'xy': p[:2], 'z': p[2]} for p in uc2]}},
          open('ops-source.json', 'w', encoding='utf8', newline='\n'), ensure_ascii=False, indent=1)
json.dump(summary, open('inputs-summary.json', 'w', encoding='utf8', newline='\n'), ensure_ascii=False, indent=1)
print(json.dumps(summary, ensure_ascii=False, indent=1))
