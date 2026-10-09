"""운동장 추정 구조(1차 형태) 생성 + 기하 검사.

입력: field-surfaces-v3.geojson(볼트 원천), docs/audit/m16/preview/data(roads-live-2.json, terrain-grid).
출력: frontend/public/corrections/field-structures-est-v1.geojson, docs/audit/field/structures-est-checks.txt
모든 생성값은 estimated=true + assumption + source. 운영 DB·GPKG는 읽지도 쓰지도 않는다.
사용: python build_structures_est.py <field-surfaces-v3.geojson> <repo-root>
"""
import hashlib, json, statistics, sys
from pathlib import Path
import numpy as np
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.ops import unary_union

SRC, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
RISER = 0.15  # 가정 단높이(m)
STAIR_W = 2.0  # 선형 계단 가정 폭(m)
raw = SRC.read_bytes()
v3 = json.loads(raw)
F = {f['properties']['id']: f for f in v3['features']}
roads = {r['id'][:8]: r for r in json.loads((ROOT / 'docs/audit/m16/preview/data/roads-live-2.json').read_text(encoding='utf-8'))['items']}
strip_z = [p[2] for p in F['SF-HIGH-STRIP']['geometry']['coordinates'][0]]
STRIP_MED = round(statistics.median(strip_z), 2)
pave_z = [p[2] for p in F['SF-DAEIL-ENTRY-PAVE']['geometry']['coordinates'][0]]
FIELD_Z = F['SF-FIELD']['properties']['z']
SRC_TAG = 'field-surfaces-v3.geojson'
out = []


def feat(fid, typ, geom, props):
    out.append({'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'estimated': True, **props}, 'geometry': geom})


def ring(poly):
    return [list(map(lambda v: round(v, 3), c)) for c in poly.exterior.coords]


# 1) 사진15 경계: 선만, 운동장 평지 높이에 둠
feat('REF-PHOTO15-EDGE', 'outline', {'type': 'LineString', 'coordinates': [[x, y, FIELD_Z] for x, y in F['REF-PHOTO15']['geometry']['coordinates'][0]]},
     {'kind': 'line', 'z': FIELD_Z, 'assumption': f'선 높이 = 운동장 평지 z {FIELD_Z}(지면 평면 가정, 사진15 호모그래피 북·동쪽 외삽)',
      'source': f'{SRC_TAG} REF-PHOTO15(사진15 호모그래피 경계) + SF-FIELD z'})

# 2) 옹벽: 운동장 148.9 ~ 높은 띠 정점 중앙값
wall = shape(F['SF-WALL']['geometry']).difference(unary_union([shape(F[k]['geometry']) for k in ('ST-DAEIL-ENTRY', 'ST-A2', 'ST-CHEONGUN-DOWN', 'SF-DAEIL-ENTRY-PAVE')]))
for n, part in enumerate(getattr(wall, 'geoms', [wall]), 1):
    if part.area < 0.5:
        continue
    feat(f'EST-WALL-{n}', 'retaining_wall', {'type': 'Polygon', 'coordinates': [ring(part)]},
         {'kind': 'extrude', 'fromM': FIELD_Z, 'toM': STRIP_MED,
          'assumption': f'하단 = 운동장 z {FIELD_Z}, 상단 = SF-HIGH-STRIP 정점 z 중앙값 {STRIP_MED}; 평면은 2 m 전이 셀 띠(두께 실측 아님)에서 계단·대일관 앞 포장 평면을 뺀 부분',
          'source': f'{SRC_TAG} SF-WALL 평면, SF-FIELD z, SF-HIGH-STRIP 정점 z(S-MAP 메시)'})

# 3) 화단: 띠 높이 위 0.5 m(가정)
pl = shape(F['SF-PLANTER']['geometry'])
feat('EST-PLANTER', 'planter', {'type': 'Polygon', 'coordinates': [ring(pl)]},
     {'kind': 'extrude', 'fromM': STRIP_MED, 'toM': round(STRIP_MED + 0.5, 2),
      'assumption': f'바닥 = 높은 띠 z 중앙값 {STRIP_MED}, 상면 = +0.5 m(가정, 수목에 가려 미확정)', 'source': f'{SRC_TAG} SF-PLANTER 평면(띠 북쪽 4 m 완충)'})


def stair_quad(fid, corners, bottom_edge, zb, zt, why_b, why_t, src):
    """corners: 4점(닫힘 제외). bottom_edge = i → 변(i,i+1)이 하단, 맞은 변이 상단. 단마다 슬래브(zb ~ 단 상면)."""
    a, b = corners[bottom_edge], corners[(bottom_edge + 1) % 4]
    c, d = corners[(bottom_edge + 2) % 4], corners[(bottom_edge + 3) % 4]  # 상단 변 c-d (b→c, a→d)
    n = max(1, round(abs(zt - zb) / RISER))
    lerp = lambda p, q, t: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        q = [lerp(a, d, t0), lerp(b, c, t0), lerp(b, c, t1), lerp(a, d, t1)]
        q.append(q[0])
        feat(f'{fid}-S{i + 1:02d}', 'stair_step', {'type': 'Polygon', 'coordinates': [[[round(x, 3), round(y, 3)] for x, y in q]]},
             {'kind': 'extrude', 'stair': fid, 'step': i + 1, 'steps_est': n, 'fromM': round(min(zb, zt), 3), 'toM': round(zb + (zt - zb) * (i + 1) / n, 3) if zt > zb else round(zb - (zb - zt) * i / n, 3),
              'z_bottom': zb, 'z_top': zt,
              'assumption': f'단높이 {RISER} m 가정 → 단수 {n} = round(|{zt}-{zb}|/{RISER}); 하단 {why_b}; 상단 {why_t}; 폭·위치는 주석 평면(±8 m)',
              'source': src})
    return n


def stair_line(fid, pts, w, src, why):
    """선형 계단: 선 양옆 w/2, 구간마다 z 시작→끝(같으면 참)."""
    for k in range(len(pts) - 1):
        p, q = pts[k], pts[k + 1]
        dx, dy = q[0] - p[0], q[1] - p[1]
        L = (dx * dx + dy * dy) ** 0.5
        if L < 1e-6:
            continue
        nx, ny = -dy / L * w / 2, dx / L * w / 2
        corners = [[p[0] + nx, p[1] + ny], [p[0] - nx, p[1] - ny], [q[0] - nx, q[1] - ny], [q[0] + nx, q[1] + ny]]
        zb, zt = p[2], q[2]
        if abs(zt - zb) < 1e-6:
            feat(f'{fid}-L{k + 1}', 'landing', {'type': 'Polygon', 'coordinates': [[[round(x, 3), round(y, 3)] for x, y in corners + [corners[0]]]]},
                 {'kind': 'extrude', 'stair': fid, 'fromM': round(zb - 0.3, 3), 'toM': zb, 'z_bottom': zb, 'z_top': zb,
                  'assumption': f'계단참, 폭 {w} m 가정, 두께 0.3 m 가정; {why}', 'source': src})
        else:
            # 선의 시작=상단(높은 쪽)일 수 있으므로 하단 변을 낮은 끝에 맞춤
            if zb < zt:
                stair_quad(f'{fid}-F{k + 1}', corners, 0, zb, zt, why, why, src)
            else:
                stair_quad(f'{fid}-F{k + 1}', corners, 2, zt, zb, why, why, src)


def quad(fid):
    return [c[:2] for c in F[fid]['geometry']['coordinates'][0][:4]]


meta = {}
# 대일관 진입 계단: 하단 변2(포장 쪽), 상단 변0(건물 쪽)
_q = quad('ST-DAEIL-ENTRY'); _m = ((_q[2][0] + _q[3][0]) / 2, (_q[2][1] + _q[3][1]) / 2)
_pp = np.array(F['SF-DAEIL-ENTRY-PAVE']['geometry']['coordinates'][0]); _w = 1 / (np.hypot(_pp[:, 0] - _m[0], _pp[:, 1] - _m[1]) + 1e-6) ** 2
PAVE_AT = round(float((_w * _pp[:, 2]).sum() / _w.sum()), 2)
meta['ST-DAEIL-ENTRY'] = stair_quad('ST-DAEIL-ENTRY', _q, 2, PAVE_AT, STRIP_MED,
                                    f'하단 변 중점의 SF-DAEIL-ENTRY-PAVE 정점 IDW z {PAVE_AT}', f'대일관 출입 높이 = 높은 띠 z 중앙값 {STRIP_MED}(가정)',
                                    f'{SRC_TAG} ST-DAEIL-ENTRY(주석 A7) 평면, SF-DAEIL-ENTRY-PAVE·SF-HIGH-STRIP z')
# A2 높은 길→운동장: 하단 변2(운동장), 상단 변0
meta['ST-A2'] = stair_quad('ST-A2', quad('ST-A2'), 2, FIELD_Z, STRIP_MED, f'운동장 z {FIELD_Z}', f'높은 길 = 높은 띠 z 중앙값 {STRIP_MED}(같은 구조 가정)',
                           f'{SRC_TAG} ST-A2(주석 A2) 평면, SF-FIELD·SF-HIGH-STRIP z')
# 청운관 하행: 하단 변2(운동장 쪽), 상단 변0, 상단 = 인접 도로 4ee99835 z
r4 = roads['4ee99835']['coordinates']
top_cd = round(min(r4, key=lambda q: Point(q[:2]).distance(Point(201233.2, 557273.1)))[2], 2)
meta['ST-CHEONGUN-DOWN'] = stair_quad('ST-CHEONGUN-DOWN', quad('ST-CHEONGUN-DOWN'), 2, FIELD_Z, top_cd, f'운동장 z {FIELD_Z}',
                                      f'인접 운영 도로 4ee99835 최근접 정점 z {top_cd}(DRAFT, S-MAP 근거 아님)',
                                      f'{SRC_TAG} ST-CHEONGUN-DOWN(주석 A5) 평면, SF-FIELD z, roads 4ee99835')
# 대일관 출구 옆 하행: 운영 도로 선과 z
pts = [roads[k]['coordinates'][0] for k in ('b14ac1da', '00cd9c0f', '2f206e6c')] + [roads['2f206e6c']['coordinates'][-1]]
stair_line('ST-DAEIL-EXIT-SIDE', pts, STAIR_W, f'{SRC_TAG} ST-DAEIL-EXIT-SIDE(사진27) + roads b14ac1da·00cd9c0f·2f206e6c 선과 z',
           f'z = 운영 도로 정점 z(DRAFT, S-MAP 근거 아님), 폭 {STAIR_W} m 가정')
# A14: 패치 후보 선, z = 패치 후보 운영 z 143.8 → 141.73
a14 = F['ST-A14']['geometry']['coordinates']
stair_line('ST-A14', [[*a14[0][:2], 143.8], [*a14[1][:2], 141.73]], STAIR_W, f'{SRC_TAG} ST-A14(field-structure-patch NEW-A14) 선',
           f'z = 패치 후보의 기존 운영 z 143.8→141.73(S-MAP 근거 아님), 폭 {STAIR_W} m 가정')
# A3: 양 끝 높이 근거 없음(인접 면은 청운관 지붕뿐) → 평면 외곽선만
feat('ST-A3-OUTLINE', 'stair_outline', {'type': 'LineString', 'coordinates': [[x, y, FIELD_Z] for x, y in F['ST-A3']['geometry']['coordinates'][0]]},
     {'kind': 'line', 'z': FIELD_Z, 'assumption': '양 끝 높이 근거 없음(인접 면은 지붕 SF-CHEONGUN-CANOPY뿐) → 계단 형상 미생성, 평면 외곽선만 운동장 z에 표시',
      'source': f'{SRC_TAG} ST-A3(주석 A3) 평면'})

# 청운관 전면 열린 다층 돌출부(사진23, 영상 SKU 02:03 / DAKNAT 04:00): 벽 없이 기둥 + 중간 슬래브. 지붕(163.8)은 v3 SF-CHEONGUN-CANOPY 그대로.
CH = shape(F['SF-CHEONGUN-CANOPY']['geometry'])
CH_TOP = F['SF-CHEONGUN-CANOPY']['properties']['z']
N_LV = 4  # 가정 층수
for k in range(1, N_LV):
    z = round(FIELD_Z + (CH_TOP - FIELD_Z) * k / N_LV, 2)
    feat(f'EST-CHEONGUN-SLAB-{k}', 'open_slab', {'type': 'Polygon', 'coordinates': [ring(CH)]},
         {'kind': 'extrude', 'fromM': round(z - 0.3, 2), 'toM': z,
          'assumption': f'열린 다층 구조 {N_LV}층 균등 분할 가정(층수·층고 미측정): 운동장 {FIELD_Z}~지붕 {CH_TOP} 사이 {k}/{N_LV}, 슬래브 두께 0.3 m, 평면 = 지붕 평면과 같음, 벽 없음',
          'source': f'{SRC_TAG} SF-CHEONGUN-CANOPY 평면·z(S-MAP), SF-FIELD z; 구조 종류 = 사진16·23, 영상 SKU 02:03·DAKNAT 04:00'})
for k, (x, y) in enumerate(list(CH.minimum_rotated_rectangle.exterior.coords)[:4], 1):
    c = CH.centroid
    x, y = x + (c.x - x) * 0.08, y + (c.y - y) * 0.08  # 모서리에서 조금 안쪽
    if box(x - 0.3, y - 0.3, x + 0.3, y + 0.3).intersects(unary_union([shape(F[q]['geometry']) for q in ('ST-CHEONGUN-DOWN', 'ST-A3')])):
        continue  # 계단 위에 기둥을 세우지 않음
    feat(f'EST-CHEONGUN-COL-{k}', 'column', {'type': 'Polygon', 'coordinates': [[[round(x - 0.3, 3), round(y - 0.3, 3)], [round(x + 0.3, 3), round(y - 0.3, 3)], [round(x + 0.3, 3), round(y + 0.3, 3)], [round(x - 0.3, 3), round(y + 0.3, 3)], [round(x - 0.3, 3), round(y - 0.3, 3)]]]},
         {'kind': 'extrude', 'fromM': FIELD_Z, 'toM': CH_TOP,
          'assumption': '기둥 0.6 m 정사각형, 지붕 평면 최소 회전 사각형 모서리 근처 4개 — 실제 기둥 수·위치 미측정(사진의 기둥 모양만 근거)',
          'source': f'{SRC_TAG} SF-CHEONGUN-CANOPY 평면·z, SF-FIELD z; 사진23'})

fc = {'type': 'FeatureCollection', 'name': 'field-structures-est-v1', 'crs': v3['crs'],
      'provenance': {'source': 'Obsidian 데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/운동장구조/field-surfaces-v3.geojson', 'sha256': hashlib.sha256(raw).hexdigest(),
                     'roads': 'docs/audit/m16/preview/data/roads-live-2.json(운영 스냅샷, DRAFT z)', 'generator': 'docs/audit/field/build_structures_est.py',
                     'status': '전부 추정(estimated=true). 원천 DB 확정값 아님. 운영·GPKG 미반영', 'riser_m': RISER, 'stair_width_m': STAIR_W},
      'features': out}
for f in out:
    f['properties']['source'] = f['properties']['source']
(ROOT / 'frontend/public/corrections/field-structures-est-v1.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')

# ---------------- 검사 ----------------
lines = []
surf = json.loads((ROOT / 'frontend/public/corrections/field-surfaces-v3.geojson').read_text(encoding='utf-8'))['features']


def zfun(f):
    """표면 z(x,y): 평면 z 하나면 상수, 아니면 정점 IDW."""
    pts = np.array(f['geometry']['coordinates'][0])
    if np.ptp(pts[:, 2]) < 1e-9:
        return lambda x, y: float(pts[0, 2])
    def g(x, y):
        d = np.hypot(pts[:, 0] - x, pts[:, 1] - y) + 1e-6
        w = 1 / d ** 2
        return float((w * pts[:, 2]).sum() / w.sum())
    return g


objs = []  # (id, polygon, zlo(x,y), zhi(x,y), type)
for f in surf:
    P = Polygon([p[:2] for p in f['geometry']['coordinates'][0]]).buffer(0)
    z = zfun(f)
    objs.append((f['properties']['id'], P, z, z, 'surface'))
for f in out:
    p = f['properties']
    if p['kind'] != 'extrude':
        continue
    P = Polygon(f['geometry']['coordinates'][0]).buffer(0)
    lo, hi = p['fromM'], p['toM']
    objs.append((p['id'], P, (lambda v: lambda x, y: v)(lo), (lambda v: lambda x, y: v)(hi), p['type']))

TOL = 0.05
over, inter = [], []
for i in range(len(objs)):
    for j in range(i + 1, len(objs)):
        a, b = objs[i], objs[j]
        if a[0].split('-S')[0] == b[0].split('-S')[0] and '-S' in a[0]:
            continue  # 같은 계단의 단끼리는 맞닿음만
        I = a[1].intersection(b[1])
        if I.area < 0.05:
            continue
        # 겹침 영역 0.5 m 격자 표본: 3D 교차 + 수직 간격(위 객체 하단 − 아래 객체 상단) 최소값
        x0, y0, x1, y1 = I.bounds
        bad = 0
        gap = None
        for x in np.arange(x0 + 0.25, x1, 0.5):
            for y in np.arange(y0 + 0.25, y1, 0.5):
                if not I.contains(Point(x, y)):
                    continue
                alo, ahi, blo, bhi = a[2](x, y), a[3](x, y), b[2](x, y), b[3](x, y)
                sa, sb = ahi - alo < 1e-9, bhi - blo < 1e-9
                if sa and sb:
                    hit = abs(alo - blo) < TOL  # 두 면이 같은 높이로 겹침
                elif sa:
                    hit = blo + TOL < alo < bhi - TOL  # 면이 덩어리 안을 지남
                elif sb:
                    hit = alo + TOL < blo < ahi - TOL
                else:
                    hit = min(ahi, bhi) - max(alo, blo) > TOL
                bad += hit
                upper_is_a = alo >= bhi - TOL or (alo + ahi) / 2 > (blo + bhi) / 2
                g = (alo - bhi) if upper_is_a else (blo - ahi)
                up = a[0] if upper_is_a else b[0]
                if gap is None or g < gap[0]:
                    gap = (g, up)
        if gap is None:
            continue
        over.append((a[0], b[0], round(I.area, 2), round(gap[0], 2), gap[1]))
        if bad:
            inter.append((a[0], b[0], bad))
ROOFS = ('SF-DAEIL-CANOPY', 'SF-CHEONGUN-CANOPY', 'EST-CHEONGUN-SLAB')
CLEAR = 2.0
stack = [o for o in over if (o[4].startswith(ROOFS) and o[3] >= CLEAR) or (o[4].startswith(('EST-CHEONGUN-COL', 'EST-WALL', 'EST-PLANTER')) and abs(o[3]) <= TOL)]
improper = [o for o in over if o not in stack]
lines.append(f'평면 겹침 쌍(면적≥0.05 m², 같은 계단 단끼리 제외): {len(over)}')
lines.append(f'(a) 의도된 수직 중첩(위가 지붕·슬래브이고 최소 간격 ≥ {CLEAR} m, 또는 기둥·옹벽·화단 하단이 아래 면에 놓임 |간격| ≤ {TOL} m): {len(stack)}')
for o in stack:
    lines.append(f'  {o[0]} × {o[1]}: {o[2]} m², 최소 간격 {o[3]} m (위 {o[4]})')
lines.append(f'(b) 부적절(보행면끼리 상하 중첩·관통 또는 지붕 아래 간격 < {CLEAR} m): {len(improper)}')
for o in improper:
    note = '계단이 사잇길 경사면 아래에 묻힘(공통 XY에서 사잇길 z > 계단 상단)' if 'SF-CORRIDOR' in (o[0], o[1]) and o[4] == 'SF-CORRIDOR' else ''
    lines.append(f'  {o[0]} × {o[1]}: {o[2]} m², 최소 간격 {o[3]} m (위 {o[4]}) {note}')
lines.append(f'3D 교차(겹침 영역 0.5 m 표본에서 z 구간 겹침 > {TOL} m): {len(inter)}')
for o in inter:
    lines.append(f'  {o[0]} × {o[1]}: 표본 {o[2]}')

# 지형 관통: 지형이 면(상면) 보다 0.3 m 넘게 높은 2 m 셀
m = json.loads((ROOT / 'docs/audit/m16/preview/data/terrain-grid-meta.json').read_text())
G = np.fromfile(ROOT / 'docs/audit/m16/preview/data/terrain-grid.f32', dtype='<f4').reshape(m['height'], m['width'])
dem = lambda x, y: float(G[int(round((y - m['originY']) / m['resolution'])), int(round((x - m['originX']) / m['resolution']))])
lines.append('지형 관통(DEM 2 m 셀 중심, 지형 > 면 상면 + 0.3 m): 객체 / 셀 / 관통 셀 / 최대 초과 m')
groups = {}
for oid, P, lo, hi, typ in objs:
    key = oid.split('-S')[0].split('-F')[0].split('-L')[0] if typ in ('stair_step', 'landing') else oid
    n = k = 0
    worst = 0.0
    x0, y0, x1, y1 = P.bounds
    for x in np.arange(m['originX'] + 2 * np.ceil((x0 - m['originX']) / 2), x1, 2):
        for y in np.arange(m['originY'] + 2 * np.ceil((y0 - m['originY']) / 2), y1, 2):
            if not P.contains(Point(x, y)):
                continue
            n += 1
            e = dem(x, y) - hi(x, y)
            if e > 0.3:
                k += 1
                worst = max(worst, e)
    g = groups.setdefault(key, [0, 0, 0.0])
    g[0] += n; g[1] += k; g[2] = max(g[2], worst)
for key, (n, k, w) in groups.items():
    lines.append(f'  {key}: {n} / {k} / {w:.2f}' + ('  (셀 중심이 안에 없음 — 2 m 격자보다 작음)' if n == 0 else ''))

# 계단 끝점: 하단·상단 변 중점 바깥 0.6 m 지점의 인접 면 z와 비교
lines.append('계단 끝 접촉(허용 0.15 m): 계단 / 끝 / 계단 z / 인접 면(id z) / 차')
surf_z = [(f['properties']['id'], Polygon([p[:2] for p in f['geometry']['coordinates'][0]]).buffer(0), zfun(f)) for f in surf]


def near_surface(x, y):
    best = None
    for sid, P, z in surf_z:
        if sid in ('SF-DAEIL-CANOPY', 'SF-CHEONGUN-CANOPY'):
            continue  # 지붕은 보행면 아님
        d = P.distance(Point(x, y))
        if d <= 1.5 and (best is None or d < best[0]):
            best = (d, sid, z(x, y))
    return best


def check_end(name, mid, out_dir, z):
    x, y = mid[0] + out_dir[0] * 0.6, mid[1] + out_dir[1] * 0.6
    ns = near_surface(x, y)
    if ns is None:
        lines.append(f'  {name}: z {z} / 1.5 m 안 보행 표면 없음 → 판정 불가')
    else:
        dz = z - ns[2]
        lines.append(f'  {name}: z {z} / {ns[1]} {ns[2]:.2f} / {dz:+.2f} ' + ('OK' if abs(dz) <= 0.15 else 'FAIL'))


for fid, be, in (('ST-DAEIL-ENTRY', 2), ('ST-A2', 2), ('ST-CHEONGUN-DOWN', 2)):
    c = quad(fid)
    a, b = c[be], c[(be + 1) % 4]
    cc, d = c[(be + 2) % 4], c[(be + 3) % 4]
    mb = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    mt = ((cc[0] + d[0]) / 2, (cc[1] + d[1]) / 2)
    v = (mb[0] - mt[0], mb[1] - mt[1]); L = (v[0] ** 2 + v[1] ** 2) ** 0.5; v = (v[0] / L, v[1] / L)
    first = [f for f in out if f['properties'].get('stair') == fid][0]['properties']
    check_end(f'{fid} 하단', mb, v, first['z_bottom'])
    check_end(f'{fid} 상단', mt, (-v[0], -v[1]), first['z_top'])
for fid, pp in (('ST-DAEIL-EXIT-SIDE', pts), ('ST-A14', [[*a14[0][:2], 143.8], [*a14[1][:2], 141.73]])):
    for name, p, q in (('시작', pp[0], pp[1]), ('끝', pp[-1], pp[-2])):
        v = (p[0] - q[0], p[1] - q[1]); L = (v[0] ** 2 + v[1] ** 2) ** 0.5
        check_end(f'{fid} {name}', p[:2], (v[0] / L, v[1] / L), p[2])
        lines.append(f'    (DEM 그 지점 {dem(p[0], p[1]):.2f})')

(ROOT / 'docs/audit/field/structures-est-checks.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('\n'.join(lines))
print('features', len(out))
