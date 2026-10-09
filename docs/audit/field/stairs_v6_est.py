"""v6 표면 후보 끝점에 맞춘 새 추정 계단(출구 옆·A14) + 해당 자리 사잇길 국소 대체 면 — 'S-MAP 경사면'과 경쟁하는 'v6 계단 후보'.

운영 DRAFT 계단 사슬은 비교 입력일 뿐 고정 기준이 아니다. v6 이동 경로(10.5/12 m)는 미검증 후보 경로이며 전체를 확정 절단하지 않고,
이 후보를 켤 때만 계단 평면 + 0.3 m 안의 사잇길 면을 대체한다. 모든 값은 estimated + assumption + source.
사용: python stairs_v6_est.py <운동장구조 폴더> <repo-root>
"""
import hashlib, json, sys
from pathlib import Path
import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

SRC, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
OUT = ROOT / 'frontend/public/corrections'
VAULT = 'Obsidian 데이터/보완자료/3d-map-audit-20261009/claude-user-20261010/운동장구조/'
raw_e, raw_m = (SRC / 'stair-endpoints-v6.json').read_bytes(), (SRC / 'stairs-moved-v6.geojson').read_bytes()
E, M = json.loads(raw_e), json.loads(raw_m)
v3 = json.loads((OUT / 'field-surfaces-v3.geojson').read_text(encoding='utf-8'))
S = {f['properties']['id']: f for f in v3['features']}
RISER, WIDTH, LANDING, MARGIN = 0.15, 2.0, 1.5, 0.3
SRC_E = f'{VAULT}stair-endpoints-v6.json / stairs-moved-v6.geojson'
feats, lines = [], []


def ep(stair, key):
    return [e for e in E['endpoints'] if e['stair'] == stair and key in e['role']][0]


def quad(p, q, w):
    dx, dy = q[0] - p[0], q[1] - p[1]
    L = float(np.hypot(dx, dy))
    nx, ny = -dy / L * w / 2, dx / L * w / 2
    return [[p[0] + nx, p[1] + ny], [p[0] - nx, p[1] - ny], [q[0] - nx, q[1] - ny], [q[0] + nx, q[1] + ny]]


def flight(fid, p_hi, p_lo, z_hi, z_lo, why, stair):
    """p_hi(높은 끝) → p_lo(낮은 끝). 단마다 슬래브(z_lo ~ 단 상면)."""
    n = max(1, round((z_hi - z_lo) / RISER))
    L = float(np.hypot(p_lo[0] - p_hi[0], p_lo[1] - p_hi[1]))
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n  # 낮은 끝에서부터
        a = [p_lo[0] + (p_hi[0] - p_lo[0]) * t0, p_lo[1] + (p_hi[1] - p_lo[1]) * t0]
        b = [p_lo[0] + (p_hi[0] - p_lo[0]) * t1, p_lo[1] + (p_hi[1] - p_lo[1]) * t1]
        c = quad(a, b, WIDTH)
        feats.append({'type': 'Feature', 'properties': {
            'id': f'{fid}-S{i + 1:02d}', 'type': 'stair_step', 'kind': 'extrude', 'stair': stair, 'estimated': True, 'status': '미검증',
            'fromM': round(z_lo - 0.3, 3), 'toM': round(z_lo + (z_hi - z_lo) * (i + 1) / n, 3),
            'assumption': f'v6 계단 후보: 단 {n}개 = round({z_hi - z_lo:.2f}/{RISER}), 디딤 {L / n:.2f} m, 폭 {WIDTH} m(가정). {why}',
            'source': SRC_E},
            'geometry': {'type': 'Polygon', 'coordinates': [[[round(x, 3), round(y, 3)] for x, y in c + [c[0]]]]}})
    return n, L / n


polys = {}
# 출구 옆: 상단 v6 범위 하한 149.08(범위 149.08~150.1 불확실), 계단참 위치·높이 미정 → 길이 중간 1.5 m 참, 높이 중간값(가정), 하단 145.7(표면 후보 대응)
top, bot = ep('ST-DAEIL-EXIT-SIDE', '상단'), ep('ST-DAEIL-EXIT-SIDE', '하단')
zt, zb = min(top['z']), bot['z']
P0, P1 = np.array(top['xy'], float), np.array(bot['xy'], float)
L = float(np.linalg.norm(P1 - P0))
u = (P1 - P0) / L
la, lb = P0 + u * (L / 2 - LANDING / 2), P0 + u * (L / 2 + LANDING / 2)
zm = round((zt + zb) / 2, 3)
n1, t1 = flight('V6-EXIT-F1', P0, la, zt, zm, f'상단 z {zt}(v6 범위 {top["z"]} 하한, 미검증), 계단참 z {zm}=중간값(가정)', 'ST-DAEIL-EXIT-SIDE')
c = quad(la, lb, WIDTH)
feats.append({'type': 'Feature', 'properties': {'id': 'V6-EXIT-LANDING', 'type': 'landing', 'kind': 'extrude', 'stair': 'ST-DAEIL-EXIT-SIDE', 'estimated': True, 'status': '미검증',
              'fromM': round(zm - 0.3, 3), 'toM': zm, 'assumption': f'계단참: v6에서 위치·z 미정 → 경로 중간 {LANDING} m, z {zm}(상·하단 중간값) 가정. 사진27은 참 존재만 확인', 'source': SRC_E},
              'geometry': {'type': 'Polygon', 'coordinates': [[[round(x, 3), round(y, 3)] for x, y in c + [c[0]]]]}})
n2, t2 = flight('V6-EXIT-F2', lb, P1, zm, zb, f'하단 z {zb}(v6 표면 후보 대응, 이동 10.5 m 미검증)', 'ST-DAEIL-EXIT-SIDE')
polys['ST-DAEIL-EXIT-SIDE'] = (Polygon(quad(P0, P1, WIDTH)), [('시작', P0, -u, zt), ('계단참', (la + lb) / 2, None, zm), ('하단', P1, u, zb)])
lines.append(f'V6 출구 옆: 길이 {L:.1f} m, {n1}단(디딤 {t1:.2f}) + 참 {LANDING} m + {n2}단(디딤 {t2:.2f}), 폭 {WIDTH} m, {zt}→{zm}→{zb}')
# A14: 상단 145.5(표면 후보 대응) → 하단 141.3(미검증, 이동 12 m), 참 없음(정보 없음)
top, bot = ep('ST-A14', '상단'), ep('ST-A14', '하단')
P0, P1 = np.array(top['xy'], float), np.array(bot['xy'], float)
u = (P1 - P0) / np.linalg.norm(P1 - P0)
n3, t3 = flight('V6-A14', P0, P1, top['z'], bot['z'], f'상단 {top["z"]}(표면 후보 대응), 하단 {bot["z"]}(미검증, 이동 12 m), 참 없음(정보 없음)', 'ST-A14')
polys['ST-A14'] = (Polygon(quad(P0, P1, WIDTH)), [('시작', P0, -u, top['z']), ('하단', P1, u, bot['z'])])
lines.append(f'V6 A14: 길이 {np.linalg.norm(P1 - P0):.1f} m, {n3}단(디딤 {t3:.2f}), 폭 {WIDTH} m, {top["z"]}→{bot["z"]}')

# 사잇길 국소 대체 면
COR = S['SF-CORRIDOR']
cpts = np.array(COR['geometry']['coordinates'][0])
CP = Polygon(cpts[:, :2]).buffer(0)


def zc(x, y):
    d = np.hypot(cpts[:, 0] - x, cpts[:, 1] - y)
    k = int(np.argmin(d))
    if d[k] < 1e-6:
        return float(cpts[k, 2])
    w = 1 / d ** 2
    return float((w * cpts[:, 2]).sum() / w.sum())


holes = unary_union([p.buffer(MARGIN, join_style=2) for p, _ in polys.values()]).intersection(CP)
cut = CP.difference(holes)
parts = [p for p in getattr(cut, 'geoms', [cut]) if p.area > 0.01]
ring3 = lambda r: [[round(x, 3), round(y, 3), round(zc(x, y), 3)] for x, y in r.coords]
feats.append({'type': 'Feature', 'properties': {'id': 'SF-CORRIDOR-V6CUT', 'type': 'corridor_cut', 'kind': 'surface', 'replaces': 'SF-CORRIDOR', 'estimated': True,
              'assumption': f'v6 계단 후보 평면 + {MARGIN} m 안만 사잇길 면 대체(구멍). 나머지 정점은 SF-CORRIDOR 원값', 'source': 'field-surfaces-v3 SF-CORRIDOR(S-MAP) + v6 계단 후보 평면'},
              'geometry': {'type': 'MultiPolygon', 'coordinates': [[ring3(p.exterior), *[ring3(h) for h in p.interiors]] for p in parts]}})
for k, g in enumerate(getattr(holes, 'geoms', [holes]), 1):
    if g.area < 0.01:
        continue
    r = g.exterior
    m = max(4, int(np.ceil(r.length)))
    pts = [r.interpolate(t * r.length / m) for t in range(m + 1)]
    sid = min(polys, key=lambda s: polys[s][0].distance(g))
    zlow = min(f['properties']['fromM'] for f in feats if f['properties'].get('stair') == sid)
    feats.append({'type': 'Feature', 'properties': {'id': f'V6CUT-EDGE-{k}', 'type': 'render_connection_face', 'kind': 'skirt', 'estimated': True, 'verifiedWall': False,
                  'otherZ': [zlow] * len(pts), 'assumption': f'렌더 연결면(벽 아님): 잘린 사잇길 가장자리 ↔ {sid} v6 계단 최저 {zlow}', 'source': 'SF-CORRIDOR z + v6 계단 후보'},
                  'geometry': {'type': 'LineString', 'coordinates': [[round(p.x, 3), round(p.y, 3), round(zc(p.x, p.y), 3)] for p in pts]}})
    lines.append(f'사잇길 절단 {sid}: {g.area:.1f} m²')

# 평가
def surf_z(x, y):
    """(x,y)를 포함하는 v3 보행 표면 z(IDW). 지붕 제외. 없으면 None."""
    for sid, f in S.items():
        if 'CANOPY' in sid:
            continue
        pp = np.array(f['geometry']['coordinates'][0])
        if Polygon(pp[:, :2]).buffer(0).contains(Point(x, y)):
            d = np.hypot(pp[:, 0] - x, pp[:, 1] - y) + 1e-6
            w = 1 / d ** 2
            return sid, float((w * pp[:, 2]).sum() / w.sum())
    return None


lines.append('끝점 높이차(바깥 0.6 m 지점 v3 보행 표면, 지붕 제외; 허용 0.15 m, 넓히지 않음) — 상태는 모두 미검증 유지')
for sid, (_, ends) in polys.items():
    for name, p, out, z in ends:
        q = p if out is None else p + out * 0.6
        s = surf_z(*q)
        if s is None:
            lines.append(f'  {sid} {name}: z {z} / 인접 보행 표면 없음 → 판정 불가 (미검증)')
        else:
            lines.append(f'  {sid} {name}: z {z} / {s[0]} {s[1]:.2f} / 차 {z - s[1]:+.2f} ' + ('OK' if abs(z - s[1]) <= 0.15 else 'FAIL') + ' (미검증)')
stair_union = unary_union([Polygon(f['geometry']['coordinates'][0]) for f in feats if f['properties']['type'] in ('stair_step', 'landing')])
lines.append(f'잘린 사잇길 면 × v6 계단 평면 겹침 {cut.intersection(stair_union).area:.3f} m²; 구멍 가장자리 ↔ 계단 수평 틈 = 여유 {MARGIN} m(렌더 연결면으로 메움)')
for sid in ('SF-DAEIL-ENTRY-PAVE', 'SF-HIGH-STRIP', 'SF-FIELD', 'SF-DAEIL-CANOPY'):
    A = Polygon(np.array(S[sid]['geometry']['coordinates'][0])[:, :2]).buffer(0).intersection(stair_union).area
    lines.append(f'v6 계단 평면 × {sid} 평면 겹침 {A:.2f} m²' + (' (지붕 아래 — 수직 중첩)' if 'CANOPY' in sid else ''))
old = json.loads((OUT / 'field-structures-est-v1.geojson').read_text(encoding='utf-8'))
for sid in ('ST-DAEIL-EXIT-SIDE', 'ST-A14'):
    o = unary_union([Polygon(f['geometry']['coordinates'][0]) for f in old['features'] if str(f['properties'].get('stair', '')).startswith(sid)])
    lines.append(f'DRAFT 사슬(비교 입력) {sid} 평면 {o.area:.1f} m² vs v6 후보 {polys[sid][0].area:.1f} m², 겹침 {o.intersection(polys[sid][0]).area:.1f} m²')

fc = {'type': 'FeatureCollection', 'name': 'stairs-v6-est', 'crs': v3['crs'],
      'provenance': {'source': SRC_E, 'sha256': hashlib.sha256(raw_e).hexdigest(), 'sha256_moved': hashlib.sha256(raw_m).hexdigest(), 'generator': 'docs/audit/field/stairs_v6_est.py',
                     'hides': ['ST-DAEIL-EXIT-SIDE', 'ST-A14'], 'status': '경쟁 후보(추정·미검증). 연결 안 된 계단은 완료로 세지 않음'},
      'features': feats}
(OUT / 'stairs-v6-est.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')
(ROOT / 'docs/audit/field/stairs-v6-est-checks.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('\n'.join(lines))
