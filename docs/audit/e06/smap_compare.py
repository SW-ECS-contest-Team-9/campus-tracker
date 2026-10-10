# E06 4단계: 휴대폰 기압 상대높이(z)의 모양을 옛 지형·S-MAP 지면과 직접 견준다(캠퍼스 전체, 실외 점).
#  - S-MAP 값은 smap_cells_query.py가 받은 5 m 칸 중심값(dem_z)을 쌍선형으로 읽는다.
#  - 점 분류: 맞는 곳 = |옛 − S-MAP| <= 1 m, 갈리는 곳 = > 2 m.
#  - 상수 하나만 뺀다. 기본은 "맞는 곳"의 점으로 정한 상수(두 지형에 같은 기준). 맞는 곳 점이 20개 미만이면 지형마다 자기 중앙값.
#  - 수평 오차: 궤적을 8방향으로 SHIFT m 옮겨 다시 읽고(RMS 범위), 점마다 반경 SHIFT m 안의 지형 최소~최대 구간 밖으로 벗어난 양(봉투 잔차)도 낸다.
# 사용: python -I smap_compare.py <원본 폴더> <감사 자료 폴더> <smap-cells.jsonl> <field-surfaces-v3.geojson> <출력 json>
import sys; sys.stdout.reconfigure(encoding="utf-8")
import sys, json, io, os, math, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Grids, tm
import numpy as np
RAW, A, CELLS, GEO, OUT = sys.argv[1:6]
C = 5.0; SHIFT = 10.0
G = Grids(A)
sm = {}
for l in io.open(CELLS, encoding='utf-8'):
    r = json.loads(l)
    if r['status'] != 200: continue
    try: v = json.loads(r['raw'])['result']['dem_z']
    except Exception: continue
    if v is not None: sm[(int(r['x'] // C), int(r['y'] // C))] = float(v)
def smap(x, y):
    fx, fy = x / C - .5, y / C - .5; i, j = math.floor(fx), math.floor(fy); tx, ty = fx - i, fy - j
    q = [sm.get((i, j)), sm.get((i + 1, j)), sm.get((i, j + 1)), sm.get((i + 1, j + 1))]
    if None not in q: return q[0] * (1 - tx) * (1 - ty) + q[1] * tx * (1 - ty) + q[2] * (1 - tx) * ty + q[3] * tx * ty
    return sm.get((int(x // C), int(y // C)))
old = lambda x, y: G.samp(G.old, x, y)
poly = [f for f in json.load(io.open(GEO, encoding='utf-8'))['features'] if f['properties']['id'] == 'SF-FIELD'][0]['geometry']['coordinates'][0]
def in_field(x, y):
    c = False
    for i in range(len(poly)):
        x1, y1 = poly[i][:2]; x2, y2 = poly[i - 1][:2]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
def place(x, y):
    if in_field(x, y): return '운동장'
    if 201100 <= x <= 201150 and 557300 <= y <= 557336: return '사잇길'
    if 201035 <= x <= 201100 and 557235 <= y <= 557300: return 'S06'
    return '기타'
DIRS = [(0, 0)] + [(SHIFT * math.cos(k * math.pi / 4), SHIFT * math.sin(k * math.pi / 4)) for k in range(8)]
rms = lambda v: float(np.sqrt(np.mean(np.square(v)))) if len(v) else None
r2 = lambda v: None if v is None else round(float(v), 2)

ss = {s['sessionId']: s for s in json.load(io.open(RAW + '/sessions.json', encoding='utf-8'))}
out = []; allrows = []
for sid, s in sorted(ss.items(), key=lambda kv: kv[1]['startedAt']):
    if s['collectorId'] == 'SIM': continue
    fp = json.load(io.open(f'{RAW}/fused-positions-{sid}.json', encoding='utf-8'))
    fu = json.load(io.open(f'{RAW}/fusion-{sid}.json', encoding='utf-8'))
    run = next((r for r in fu.get('runs', []) if r['algorithmVersion'] == 'fusion-v4'), {})
    rebases = ((run.get('metrics') or {}).get('altimeterRebases')) or 0
    if not fp: continue
    t0 = np.datetime64(fp[0]['timestamp'][:23]); pts = []; last = None; stretch = 0; lastT = None
    for p in fp:
        if p.get('relativeAltitude') is None: continue
        t = float((np.datetime64(p['timestamp'][:23]) - t0) / np.timedelta64(1, 's'))
        ok = not p.get('buildingId') and (p.get('horizontalUncertainty') or 99) <= 15
        if not ok: continue
        x, y = tm(p['latitude'], p['longitude'])
        o = old(x, y); m = smap(x, y)
        if o is None or m is None: continue
        if lastT is not None and (t - lastT > 20 or p.get('reanchored')): stretch += 1; last = None
        lastT = t
        step = 0.0 if last is None else math.hypot(x - last[0], y - last[1])
        if last is not None and step < 1.0: continue          # 서 있는 점은 한 번만
        last = (x, y)
        so = [old(x + dx, y + dy) for dx, dy in DIRS]; sM = [smap(x + dx, y + dy) for dx, dy in DIRS]
        if None in so or None in sM: continue
        pts.append(dict(t=t, x=x, y=y, z=p['relativeAltitude'], o=so, m=sM, step=step, stretch=stretch,
                        cls='a' if abs(o - m) <= 1 else ('b' if abs(o - m) > 2 else 'c'), place=place(x, y)))
    if len(pts) < 30: continue
    z = np.array([p['z'] for p in pts]); O = np.array([p['o'] for p in pts]); M = np.array([p['m'] for p in pts])
    cls = np.array([p['cls'] for p in pts]); step = np.array([p['step'] for p in pts])
    a, b = cls == 'a', cls == 'b'
    common = int(a.sum()) >= 20
    def offs(S, k=0): return float(np.median((z - S[:, k])[a])) if common else float(np.median(z - S[:, k]))
    def stats(mask):
        if mask.sum() < 5: return None
        d = {}
        for name, S in (('old', O), ('smap', M)):
            res0 = (z - S[:, 0] - offs(S))[mask]
            sh = [rms((z - S[:, k] - offs(S, k))[mask]) for k in range(len(DIRS))]
            lo, hi = S.min(axis=1), S.max(axis=1); h = z - offs(S)
            env = np.where(h < lo, lo - h, np.where(h > hi, h - hi, 0.0))[mask]
            d[name] = dict(rms=r2(rms(res0)), max=r2(np.max(np.abs(res0))), median=r2(np.median(res0)), rmsShiftMin=r2(min(sh)), rmsShiftMax=r2(max(sh)), rmsEnvelope=r2(rms(env)))
        d['n'] = int(mask.sum()); d['metres'] = int(round(float(step[mask].sum())))
        return d
    r = dict(session=sid[:8], collector=s['collectorId'], date=s['startedAt'][:16], n=len(pts), metres=int(round(float(step.sum()))), minutes=round((pts[-1]['t'] - pts[0]['t']) / 60, 1),
             altimeterRebases=rebases, offsetFrom='맞는 곳' if common else '전체 중앙값(지형별)', all=stats(np.ones(len(pts), bool)), agree=stats(a), differ=stats(b))
    # 갈리는 곳을 장소별로
    r['differByPlace'] = {}
    for pl in ('운동장', '사잇길', 'S06', '기타'):
        mk = b & np.array([p['place'] == pl for p in pts])
        stt = stats(mk)
        if stt:
            stt['smapMinusOldMedian'] = r2(np.median((M[:, 0] - O[:, 0])[mk]))
            if pl == '기타': stt['centre'] = [round(float(np.median([p['x'] for p, k in zip(pts, mk) if k]))), round(float(np.median([p['y'] for p, k in zip(pts, mk) if k])))]
            r['differByPlace'][pl] = stt
    # 연속 실외 구간마다 상수를 따로 뺀 경우(구간 안 모양만)
    ro, rm = [], []
    for k in sorted({p['stretch'] for p in pts}):
        mk = np.array([p['stretch'] == k for p in pts])
        if mk.sum() < 15: continue
        ro += list((z - O[:, 0])[mk] - np.median((z - O[:, 0])[mk])); rm += list((z - M[:, 0])[mk] - np.median((z - M[:, 0])[mk]))
    r['perStretch'] = dict(n=len(ro), rmsOld=r2(rms(ro)), rmsSmap=r2(rms(rm)))
    out.append(r)
    for p, cl in zip(pts, cls): allrows.append((sid[:8], cl, p['place']))
json.dump(dict(smapCells=len(sm), shiftM=SHIFT, sessions=out), io.open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
def line(tag, d):
    if not d: return f'   {tag:10s} -'
    return (f"   {tag:10s} n={d['n']:4d} {d['metres']:5d} m | 옛 RMS {d['old']['rms']:5.2f} 최대 {d['old']['max']:5.2f} (옮김 {d['old']['rmsShiftMin']}~{d['old']['rmsShiftMax']}, 봉투 {d['old']['rmsEnvelope']})"
            f" | S-MAP RMS {d['smap']['rms']:5.2f} 최대 {d['smap']['max']:5.2f} (옮김 {d['smap']['rmsShiftMin']}~{d['smap']['rmsShiftMax']}, 봉투 {d['smap']['rmsEnvelope']})")
for r in out:
    print(r['session'], r['collector'], r['date'], f"n={r['n']} {r['metres']} m {r['minutes']}분 기압재시작={r['altimeterRebases']} 상수={r['offsetFrom']} 구간별 RMS 옛 {r['perStretch']['rmsOld']} / S-MAP {r['perStretch']['rmsSmap']}")
    print(line('전체', r['all'])); print(line('맞는 곳', r['agree'])); print(line('갈리는 곳', r['differ']))
    for pl, d in r['differByPlace'].items(): print(line(' └' + pl, d), 'S-MAP−옛', d['smapMinusOldMedian'], d.get('centre', ''))
