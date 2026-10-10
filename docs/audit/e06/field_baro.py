# E06 3단계: 운동장 안에서 휴대폰 기압 상대높이(z)가 옛 지형을 따르는가, 평평한가.
# 기준점 = 1:5000 원 표고점 148.91 m (201212.01, 557220.80, 운동장 평지 다각형 안).
#  - "표고점 쪽" = 표고점에서 NEAR m 안의 실외 점,  "안쪽" = 운동장 다각형 안(가장자리에서 EDGE m 이상)이고 옛 지형 < 143 m인 점
#  - 같은 통과(끊김 10초 이하, 두 구역 사이 5분 이하)에서 z(안쪽) − z(표고점 쪽) 을 옛 지형 예측·보정 지형 예측과 견준다.
# 사용: python -I field_baro.py <원본 폴더> <감사 자료 폴더> <field-surfaces-v3.geojson> <출력 json>
import sys; sys.stdout.reconfigure(encoding="utf-8")
import sys, json, io, os, math, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Grids, tm
import numpy as np
RAW, A, GEO, OUT = sys.argv[1:5]
SPOT = (201212.01, 557220.80, 148.91); NEAR = 15.0; EDGE = 5.0
G = Grids(A)
poly = [f for f in json.load(io.open(GEO, encoding='utf-8'))['features'] if f['properties']['id'] == 'SF-FIELD'][0]['geometry']['coordinates'][0]
def inside(x, y):
    c = False
    for i in range(len(poly)):
        x1, y1 = poly[i][:2]; x2, y2 = poly[i - 1][:2]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
def dist_edge(x, y):
    m = 1e9
    for i in range(len(poly)):
        x1, y1 = poly[i][:2]; x2, y2 = poly[i - 1][:2]; dx, dy = x2 - x1, y2 - y1
        t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy or 1)))
        m = min(m, math.hypot(x - x1 - t * dx, y - y1 - t * dy))
    return m
med = lambda v: float(st.median(v))
def mad(v): m = med(v); return 1.4826 * med([abs(a - m) for a in v])
ss = {s['sessionId']: s for s in json.load(io.open(RAW + '/sessions.json', encoding='utf-8'))}
res = []
for sid, s in sorted(ss.items(), key=lambda kv: kv[1]['startedAt']):
    if s['collectorId'] == 'SIM': continue
    fp = json.load(io.open(f'{RAW}/fused-positions-{sid}.json', encoding='utf-8'))
    if not fp: continue
    t0 = np.datetime64(fp[0]['timestamp'][:23]); pts = []
    for p in fp:
        if p.get('relativeAltitude') is None: continue
        x, y = tm(p['latitude'], p['longitude']); o = G.samp(G.old, x, y)
        if o is None: continue
        t = float((np.datetime64(p['timestamp'][:23]) - t0) / np.timedelta64(1, 's'))
        infield = inside(x, y) and dist_edge(x, y) >= EDGE and not p.get('buildingId')
        near = math.hypot(x - SPOT[0], y - SPOT[1]) <= NEAR and not p.get('buildingId')
        pts.append(dict(t=t, x=x, y=y, z=p['relativeAltitude'], old=o, new=G.samp(G.new, x, y), hu=p.get('horizontalUncertainty') or 99, f=infield, near=near, low=infield and o < 143))
    fld = [p for p in pts if p['f'] and p['hu'] <= 15]
    if len(fld) < 10: continue
    # 연속 통과로 자른다
    passes = []; cur = [fld[0]]
    for p in fld[1:]:
        if p['t'] - cur[-1]['t'] > 60: passes.append(cur); cur = []
        cur.append(p)
    passes.append(cur)
    for k, ps in enumerate(passes):
        if len(ps) < 10: continue
        z = np.array([p['z'] for p in ps]); o = np.array([p['old'] for p in ps]); n = np.array([p['new'] for p in ps]); t = np.array([p['t'] for p in ps])
        # z의 초당 변화(센서가 살아 있는지), 걸은 거리
        dist = float(sum(math.hypot(ps[i]['x'] - ps[i - 1]['x'], ps[i]['y'] - ps[i - 1]['y']) for i in range(1, len(ps))))
        distinct = len({round(v, 3) for v in z.tolist()})
        r = dict(session=sid[:8], collector=s['collectorId'], date=s['startedAt'][:16], passNo=k, n=len(ps), seconds=round(float(t[-1] - t[0])), metres=round(dist),
                 huMedian=round(med([p['hu'] for p in ps]), 1), zDistinct=distinct,
                 zRange=[round(float(np.percentile(z, 5)), 2), round(float(np.percentile(z, 95)), 2)],
                 oldRange=[round(float(np.percentile(o, 5)), 2), round(float(np.percentile(o, 95)), 2)],
                 newRange=[round(float(np.percentile(n, 5)), 2), round(float(np.percentile(n, 95)), 2)])
        # 한 상수만 빼고 모양 비교 (z − 지형의 흩어짐)
        r['rmsVsOld'] = round(float(np.std(z - o)), 2); r['rmsVsNew'] = round(float(np.std(z - n)), 2)
        if np.ptp(o) > 3:
            A2 = np.vstack([o - o.mean(), np.ones(len(o))]).T; r['slopeOnOld'] = round(float(np.linalg.lstsq(A2, z, rcond=None)[0][0]), 2)  # 1 = 옛 지형을 따름, 0 = 평평
        # 표고점 쪽 ↔ 안쪽(옛 지형 낮은 곳)
        lo = [p for p in ps if p['low']]
        nr = [p for p in pts if p['near'] and p['hu'] <= 15 and ps[0]['t'] - 300 <= p['t'] <= ps[-1]['t'] + 300]
        if len(lo) >= 5 and len(nr) >= 5:
            zl, zn = [p['z'] for p in lo], [p['z'] for p in nr]
            gap = min(abs(a['t'] - b['t']) for a in lo for b in nr)
            # 표고점 쪽 구간에서 오르내림(계단·건물 출입)이 섞였는지: 흩어짐으로 판단
            unc = math.sqrt(mad(zl) ** 2 + mad(zn) ** 2 + 0.3 ** 2 + (2.0 * gap / 3600) ** 2)
            r['spotTest'] = dict(nLow=len(lo), nNear=len(nr), gapSeconds=round(gap), measured=round(med(zl) - med(zn), 2), unc=round(unc, 2), nearSpread=round(mad(zn), 2),
                                 nearZminmax=[round(min(zn), 2), round(max(zn), 2)],
                                 predOld=round(med([p['old'] for p in lo]) - med([p['old'] for p in nr]), 2), predNew=round(med([p['new'] for p in lo]) - med([p['new'] for p in nr]), 2),
                                 fieldLevelFromSpot=round(SPOT[2] + med(zl) - med(zn), 2))
        res.append(r)
json.dump(dict(spot=SPOT, nearRadius=NEAR, edgeMargin=EDGE, passes=res), io.open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for r in res: print(json.dumps(r, ensure_ascii=False))
