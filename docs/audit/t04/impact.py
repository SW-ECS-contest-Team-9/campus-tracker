"""T04 영향 점검: 새 구역(gate_road, turnaround) 표본 보정이 바깥·급경사·건물·기준 높이·E09 차도에 주는 영향. 읽기 전용.

  python impact.py <3d-map-audit-20261009 폴더> <저장소 루트> <out.json>

격자: evaluate.ts 가 <감사 폴더>/t04 에 쓴 dem-new-areas.f32(새 구역만), dem-field-s06.f32, dem-field-s06-new.f32(권고 조합), dem-all.f32.
- 손상: 새 구역 표본 칸에서의 거리 띠별 변화(E01·T01 과 같은 정의. 30 m 밖 최대, 2~30 m 띠에서 0.5 m 넘게 바뀐 면적).
- 급경사: 띠의 45° 넘는 칸 전→후, 새로 생긴 칸이 어느 구역 옆인지, 그 자리 S-MAP 메시도 급한지(옹벽·건물 벽이 실제로 있는 자리인지).
- 건물: scene-heights.ts 규칙(외곽선 2 m 간격 표본 + 내부점, 바닥 = 최저 - 1, 지붕 = max(중앙 + 높이, 최고 + 3)). 지붕 보정이 있는 동은 지붕이 고정이다.
- 기준 높이: E08 출입구 지면(S-MAP 메시에서 읽은 값이라 독립 근거는 아님)과 보정 지형.
- E09 차도: 지형 - 차도 높이(양수 = 묻힘), 옛 지형 / T01(기존 세 구역) / 권고 조합.
"""
import json, math, pathlib, sys
import numpy as np
from common import TERRAIN_ID, Dem, read_grid, segments

audit, repo, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
load = lambda p: json.loads(pathlib.Path(p).read_text(encoding='utf-8-sig'))
dem = Dem(audit); m = dem.meta; res = m['resolution']; H, W = m['height'], m['width']
G = lambda name: np.fromfile(audit / 't04' / f'dem-{name}.f32', dtype='<f4').reshape(H, W)
old, new, fs, rec, allg = dem.h, G('new-areas'), G('field-s06'), G('field-s06-new'), G('all')
t01 = np.fromfile(audit / 't01/dem-T01.f32', dtype='<f4').reshape(H, W)
r2 = lambda v: round(float(v), 2)
report = {'created': '2026-10-10'}

# ---- 표본 칸까지 거리 ----
S = load(repo / 'backend/data/terrain/samples/smap_samples_roads_5186.json')
pts = [(p[0], p[1], g['area']) for g in S['groups'] for p in g['points']]
cx = m['originX'] + (np.arange(W) + 0.5) * res; cy = m['originY'] + (np.arange(H) + 0.5) * res
X, Y = np.meshgrid(cx, cy)
dist = np.full((H, W), np.inf); owner = np.zeros((H, W), dtype=int); areas = sorted({p[2] for p in pts})
for x, y, a in pts:
    iy0, ix0 = int((y - m['originY']) / res), int((x - m['originX']) / res)
    sl = (slice(max(0, iy0 - 20), iy0 + 21), slice(max(0, ix0 - 20), ix0 + 21))
    d = np.hypot(X[sl] - x, Y[sl] - y); upd = d < dist[sl]
    dist[sl] = np.where(upd, d, dist[sl]); owner[sl] = np.where(upd, areas.index(a), owner[sl])
def slope(h):
    hx = np.pad(h, ((0, 0), (1, 1)), mode='edge'); hy = np.pad(h, ((1, 1), (0, 0)), mode='edge')
    return np.hypot((hx[:, 2:] - hx[:, :-2]) / (2 * res), (hy[2:, :] - hy[:-2, :]) / (2 * res))
d = np.abs(new - old); s0, s1 = slope(old), slope(new)
inside, band, far = dist <= 2, (dist > 2) & (dist <= 30), dist > 30
report['damage'] = {'note': '새 구역만 넣은 격자 대 옛 지형. 거리는 가장 가까운 새 표본까지',
    'changedCells': int((d > 0).sum()), 'beyond30mMaxAbsM': r2(d[far].max()), 'beyond12mMaxAbsM': r2(d[dist > 12].max()),
    'band2to30m': {'maxAbsM': r2(d[band].max()), 'areaOver05M2': int((d[band] > 0.5).sum() * res ** 2), 'areaOver01M2': int((d[band] > 0.1).sum() * res ** 2)},
    'byArea': {a: {'changedCells': int(((d > 0) & (owner == i)).sum()), 'band2to30mAreaOver05M2': int((band & (owner == i) & (d > 0.5)).sum() * res ** 2),
                   'within2mDeltaM': [r2((new - old)[inside & (owner == i)].min()), r2((new - old)[inside & (owner == i)].max())]} for i, a in enumerate(areas)}}

# ---- 급경사: S-MAP 메시의 같은 자리도 급한가 ----
mesh = {}
for f in ['t04/smap-mesh-t04-gate-s-2m.txt', 't04/smap-mesh-t04-gate-n-2m.txt', 't04/smap-mesh-t04-plaza-2m.txt', 'e05/smap-mesh-yudam-2m.txt', 'e05/smap-mesh-nw-2m.txt', 'e05/smap-mesh-south-2m.txt']:
    for k, v in read_grid(audit / f)[0].items(): mesh.setdefault(k, v)
def mesh_here(x, y):  # 칸 중심(홀수 좌표) 둘레 네 메시 점: 최대 높이차와 건물 모델 여부
    c = [mesh.get((x + dx, y + dy)) for dx in (-1, 1) for dy in (-1, 1)]
    if any(v is None for v in c): return None
    z = [v[0] for v in c]; return max(z) - min(z), any(v[1] != TERRAIN_ID for v in c)
newsteep = band & (s1 > 1) & (s0 <= 1); gone = band & (s1 <= 1) & (s0 > 1)
rows = {}
for iy, ix in zip(*np.nonzero(newsteep)):
    a = areas[owner[iy, ix]]; mh = mesh_here(cx[ix], cy[iy]); r = rows.setdefault(a, {'cells': 0, 'meshAlsoSteepOrBuilding': 0, 'meshGentle': 0, 'noMesh': 0, 'maxAbsDeltaM': 0, 'dist': [], 'xy': []})
    r['cells'] += 1; r['maxAbsDeltaM'] = max(r['maxAbsDeltaM'], r2(d[iy, ix])); r['dist'].append(float(dist[iy, ix])); r['xy'].append([float(cx[ix]), float(cy[iy]), r2(new[iy, ix] - old[iy, ix]), None if mh is None else r2(mh[0])])
    # 2 m 칸 네 귀의 메시 높이차가 2 m 를 넘으면 45° 이상, 또는 건물 모델에 닿아 있으면 실제 벽 자리로 센다
    if mh is None: r['noMesh'] += 1
    elif mh[0] > 2 or mh[1]: r['meshAlsoSteepOrBuilding'] += 1
    else: r['meshGentle'] += 1
for r in rows.values():
    r['distToSampleMedianM'] = r2(np.median(r.pop('dist'))); xs = [p[0] for p in r['xy']]; ys = [p[1] for p in r['xy']]; r['bbox'] = [min(xs), min(ys), max(xs), max(ys)]
report['steep'] = {'note': '45° 넘는 칸. 메시 판정: 그 칸 네 귀의 S-MAP 메시 높이차 > 2 m 이거나 건물 모델에 닿으면 "실제로도 급한 자리"',
    'within2m': [int((inside & (s0 > 1)).sum()), int((inside & (s1 > 1)).sum())], 'band2to30m': [int((band & (s0 > 1)).sum()), int((band & (s1 > 1)).sum())],
    'bandNew': int(newsteep.sum()), 'bandGone': int(gone.sum()), 'bandMaxSlope': [r2(s0[band].max()), r2(s1[band].max())], 'newByArea': rows}

# ---- 건물 ----
def block(samples, h):
    s = sorted(samples); n = len(s); med = s[n >> 1] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    return round(s[0] - 1, 3), round(max(med + h, s[-1] + 3), 3)
live = audit / 'claude-live'
scene = {b['name']: b for b in load(live / 'scene-live.json')['buildings']}; inner = {b['buildingId']: b for b in load(live / 'buildings.json')['buildings']}
ov = load(repo / 'backend/data/scene/overrides/building-roofs.json')
fixed = {o['name']: 'roof' for o in ov.get('buildings', [])}; fixed.update({o.get('name') or o.get('building'): 'parts' for o in ov.get('parts', [])})
report['buildings'] = []
for o in load(audit / 'building-outlines-5186.json'):
    sc = scene.get(o['name'])
    if not sc: continue
    p = []
    for poly in o['coordinates']:
        ring = poly[0]
        for (ax, ay), (bx, by) in zip(ring, ring[1:]):
            n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 2)); p += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
    q = inner[sc['buildingId']]; p.append((q['x'], q['y']))
    row = {'building': o['name'], 'roofOverride': fixed.get(o['name'])}
    for label, a, b in (('newAreasVsOld', old, new), ('recommendedVsFieldS06', fs, rec), ('recommendedVsOld', old, rec)):
        b0 = block([dem.at(x, y, a) for x, y in p], sc['heightM']); b1 = block([dem.at(x, y, b) for x, y in p], sc['heightM'])
        dd = [dem.at(x, y, b) - dem.at(x, y, a) for x, y in p]
        row[label] = {'baseShiftM': r2(b1[0] - b0[0]), 'roofShiftM': r2(b1[1] - b0[1]), 'outlineSamplesChanged': sum(abs(v) > 0.01 for v in dd), 'outlineDeltaM': [r2(min(dd)), r2(max(dd))]}
    report['buildings'].append(row)

# ---- E08 출입구 지면(같은 S-MAP 메시에서 읽은 값: 독립 근거가 아니라 일관성 확인) ----
anchors = load(repo / 'docs/audit/b03/anchors.json')['entrances']
def walk(o):
    if isinstance(o, dict):
        if 'x' in o and 'groundM' in o: yield o
        else:
            for v in o.values(): yield from walk(v)
    elif isinstance(o, list):
        for v in o: yield from walk(v)
report['anchors'] = []
for a in walk(anchors):
    if abs(dem.at(a['x'], a['y'], rec) - dem.at(a['x'], a['y'], fs)) < 0.005 and dist[int((a['y'] - m['originY']) / res), int((a['x'] - m['originX']) / res)] > 12: continue
    report['anchors'].append({'name': a['name'], 'xy': [a['x'], a['y']], 'e08GroundM': a['groundM'], 'groundFrom': a['groundFrom'], 'oldM': r2(dem.at(a['x'], a['y'])), 'fieldS06M': r2(dem.at(a['x'], a['y'], fs)),
                              'recommendedM': r2(dem.at(a['x'], a['y'], rec)), 'recommendedMinusE08M': r2(dem.at(a['x'], a['y'], rec) - a['groundM']), 'distToNewSampleM': r2(dist[int((a['y'] - m['originY']) / res), int((a['x'] - m['originX']) / res)])})
# 사용자 확정 기준 두 곳: 분수 광장 평탄면(유담관 6층 114.1 m), 유담관 9층 앞마당(129.2 m). 광장은 이번 표본에 넣지 않았다.
plaza = [(x, y) for x in range(201060, 201074, 2) for y in range(557222, 557236, 2)]
report['fountainPlazaFlat'] = {'e08M': 114.1, 'cells': len(plaza), **{k: [r2(min(dem.at(x, y, g) for x, y in plaza)), r2(max(dem.at(x, y, g) for x, y in plaza))] for k, g in (('oldM', old), ('recommendedM', rec))}}

# ---- E09 차도: 지형 - 차도 높이 ----
seg = segments(repo); report['e09Roads'] = {}
for k, line in seg.items():
    row = {'vertices': len(line)}
    for label, g in (('old', old), ('t01', t01), ('recommended', rec), ('all', allg)):
        v = [dem.at(p[0], p[1], g) - p[2] for p in line]
        row[label] = {'medianM': r2(np.median(v)), 'minM': r2(min(v)), 'maxM': r2(max(v)), 'buriedOver1m': sum(x > 1 for x in v), 'buriedOver05m': sum(x > 0.5 for x in v), 'floatingOver05m': sum(x < -0.5 for x in v)}
    report['e09Roads'][k] = row

# ---- 메시 표본 대 표고 조회(다른 서비스) ----
keep = {(p[0], p[1]) for p in pts}; api = {}
for o in load(audit / 't04/smap-api-check-raw.json'):
    if o['status'] != 200 or (o['x'], o['y']) not in keep: continue
    r = json.loads(o['raw'])['result']; api.setdefault(o['area'], []).append(o['meshZ'] - r['dem_z'])
report['meshMinusApiOnRandomSamples'] = {k: {'n': len(v), 'median': r2(np.median(v)), 'p90Abs': r2(np.percentile(np.abs(v), 90)), 'maxAbs': r2(np.abs(v).max())} for k, v in api.items()}

out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
for r in report['steep']['newByArea'].values(): r['xy'] = len(r['xy'])
print(json.dumps({k: v for k, v in report.items() if k != 'buildings'}, ensure_ascii=False, indent=1))
for b in report['buildings']: print(json.dumps(b, ensure_ascii=False))
