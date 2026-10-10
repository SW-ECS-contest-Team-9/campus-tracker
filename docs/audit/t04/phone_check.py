# T04: E06 이 내려받아 둔 휴대폰 원본(융합 결과의 기압 상대높이)이 새 구역(gate_road, turnaround)을 실외로 지나는지 보고,
# 지나면 E06 과 같은 상대 높이 검사를 한다(연속 구간마다 상수 하나만 빼고 z 대 옛 지형 / 보정 지형 RMS, 궤적을 8방향 10 m 옮긴 범위).
# 새로 내려받지 않는다. 원본은 저장소·볼트에 두지 않는다. 출력은 집계 수치만.
#   python -I phone_check.py <원본 폴더> <3d-map-audit-20261009 폴더> <저장소 루트> <out.json>
import sys, json, io, os, math, pathlib
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'e06'))
from common import tm
import numpy as np
RAW, A, REPO, OUT = sys.argv[1:5]
meta = json.load(io.open(A + '/terrain-grid-meta.json', encoding='utf-8-sig')); res = meta['resolution']; shape = (meta['height'], meta['width'])
old = np.fromfile(A + '/terrain-grid.f32', dtype='<f4').reshape(shape); new = np.fromfile(A + '/t04/dem-field-s06-new.f32', dtype='<f4').reshape(shape)
def samp(g, x, y):
    fx, fy = (x - meta['originX']) / res - .5, (y - meta['originY']) / res - .5; i, j = math.floor(fx), math.floor(fy); tx, ty = fx - i, fy - j
    if i < 0 or j < 0 or i + 1 >= shape[1] or j + 1 >= shape[0]: return None
    return float(g[j, i] * (1 - tx) * (1 - ty) + g[j, i + 1] * tx * (1 - ty) + g[j + 1, i] * (1 - tx) * ty + g[j + 1, i + 1] * tx * ty)
S = json.load(io.open(REPO + '/backend/data/terrain/samples/smap_samples_roads_5186.json', encoding='utf-8'))
cells = {}
for g in S['groups']:
    for x, y, z in g['points']: cells[(int(x // 2), int(y // 2))] = g['area']
def area(x, y):  # 표본 칸에서 4 m 안
    i, j = int(x // 2), int(y // 2)
    for di in range(-2, 3):
        for dj in range(-2, 3):
            a = cells.get((i + di, j + dj))
            if a and math.hypot((i + di) * 2 - x, (j + dj) * 2 - y) <= 4: return a
    return None
SHIFT = 10.0; DIRS = [(0, 0)] + [(SHIFT * math.cos(k * math.pi / 4), SHIFT * math.sin(k * math.pi / 4)) for k in range(8)]
rms = lambda v: round(float(np.sqrt(np.mean(np.square(v)))), 2)
ss = {s['sessionId']: s for s in json.load(io.open(RAW + '/sessions.json', encoding='utf-8'))}
rows = []; sessions = 0
for sid, s in sorted(ss.items(), key=lambda kv: kv[1]['startedAt']):
    if s['collectorId'] == 'SIM' or not os.path.exists(f'{RAW}/fused-positions-{sid}.json'): continue
    fp = json.load(io.open(f'{RAW}/fused-positions-{sid}.json', encoding='utf-8'))
    if not fp: continue
    sessions += 1
    t0 = np.datetime64(fp[0]['timestamp'][:23]); runs = []; cur = None; indoorIn = {}
    for p in fp:
        if p.get('relativeAltitude') is None or p.get('latitude') is None: continue
        x, y = tm(p['latitude'], p['longitude']); a = area(x, y)
        t = float((np.datetime64(p['timestamp'][:23]) - t0) / np.timedelta64(1, 's'))
        outdoor = not p.get('buildingId') and (p.get('horizontalUncertainty') or 99) <= 15
        if a and not outdoor: indoorIn[a] = indoorIn.get(a, 0) + 1
        if not a or not outdoor: cur = None; continue
        if cur is None or cur['area'] != a or t - cur['pts'][-1][0] > 20: cur = {'area': a, 'pts': []}; runs.append(cur)
        cur['pts'].append((t, x, y, p['relativeAltitude']))
    for r in runs:
        pts = [r['pts'][0]]
        for q in r['pts'][1:]:
            if math.hypot(q[1] - pts[-1][1], q[2] - pts[-1][2]) >= 1: pts.append(q)   # 서 있는 점은 한 번만
        length = sum(math.hypot(b[1] - a[1], b[2] - a[2]) for a, b in zip(pts, pts[1:]))
        row = {'session': sid[:8], 'collector': s['collectorId'], 'date': s['startedAt'][:10], 'area': r['area'], 'points': len(pts), 'seconds': round(r['pts'][-1][0] - r['pts'][0][0]), 'lengthM': round(length)}
        if len(pts) >= 8 and length >= 15:
            z = np.array([q[3] for q in pts]); res_ = {}
            for name, g in (('old', old), ('corrected', new)):
                sh = []
                for dx, dy in DIRS:
                    T = np.array([samp(g, q[1] + dx, q[2] + dy) for q in pts], dtype=float); d = z - T; sh.append(rms(d - np.median(d)))
                res_[name] = {'rms': sh[0], 'shifted10m': [min(sh), max(sh)]}
            dz = np.array([samp(new, q[1], q[2]) - samp(old, q[1], q[2]) for q in pts])
            row.update(zRangeM=round(float(z.max() - z.min()), 2), oldRangeM=round(float(np.ptp([samp(old, q[1], q[2]) for q in pts])), 2), correctedRangeM=round(float(np.ptp([samp(new, q[1], q[2]) for q in pts])), 2),
                       correctedMinusOldM=[round(float(dz.min()), 2), round(float(dz.max()), 2)], **res_)
        rows.append(row)
    for a, n in indoorIn.items(): rows.append({'session': sid[:8], 'collector': s['collectorId'], 'area': a, 'notOutdoorPoints': n})
usable = [r for r in rows if 'old' in r]
doc = {'created': '2026-10-10', 'sessionsRead': sessions, 'note': '실외 = 건물 소속 없음, 위치 불확실도 15 m 이하. 구역 = 새 표본 칸에서 4 m 안. 검사 대상 = 한 구역 안 연속 8점·15 m 이상',
       'outdoorPointsByArea': {a: sum(r.get('points', 0) for r in rows if r['area'] == a) for a in sorted(set(cells.values()))}, 'runsTested': len(usable), 'rows': rows}
pathlib.Path(OUT).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps({k: v for k, v in doc.items() if k != 'rows'}, ensure_ascii=False))
for r in rows:
    if r.get('points', 0) >= 3 or 'notOutdoorPoints' in r: print(json.dumps(r, ensure_ascii=False))
