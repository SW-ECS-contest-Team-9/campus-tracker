"""T04: 차도 구역의 S-MAP 메시 지면 표본 고르기(2 m 칸). 읽기 전용, 외부 요청 없음.

  python collect.py <3d-map-audit-20261009 폴더> <저장소 루트> <out samples.json> [그림.png]

입력 격자: t04/smap-mesh-t04-*.txt (2026-10-10 이번에 읽음, e05/collect_grid.js 와 같은 함수), e05/smap-mesh-{yudam,nw,south}-2m.txt (E05).
이번에 읽은 격자(S-MAP 3D 뷰어 탭에서 e05/collect_grid.js 의 __grid, 같은 호출을 세 번 되풀이해 뒤 두 번이 전 칸 같음을 확인):
  __grid('t04-gate-s-2m', 201056, 557086, 43, 48, 2, 108, 1500), __grid('t04-gate-n-2m', 201056, 557182, 43, 48, 2, 120, 1500),
  __grid('t04-plaza-2m', 200996, 557290, 33, 56, 2, 130, 1500). 결과 저장은 e05/save_grid.py.
구역 네 개를 모두 고른다. 저장소 표본 파일에는 검증을 통과한 구역만 넣는다(make_samples.py 의 셋째 인자).
고르는 규칙(구역 공통):
  1) 지형 모델 칸만(모델 id 419430528). 건물 모델 칸과 맞닿은 칸(8방향) 제외. 화면 되읽기 XY 잔차 0.3 m 초과 제외.
  2) 같은 XY 를 두 화면에서 읽은 값이 0.5 m 넘게 다르면 제외.
  3) 씨앗(차도 중심선 2 m 안, 또는 E09 포장면 판독점)에서 옆 칸으로 번져 나간다. 옆 칸과 높이차가 턱 한도를 넘으면 건너가지 않는다
     (옹벽 위·차량·나무·덮개는 포장면과 턱으로 끊겨 있어 닿지 않는다). 구역마다 중심선에서의 거리 또는 테두리 상자로 범위를 막는다.
  4) 남은 칸 중 이웃(8방향) 중앙값과 1.5 m 넘게 다르거나 이웃이 없는 칸 제외(E01 과 같은 규칙).
  5) 저장소 표본 파일에 이미 있는 표본에서 1 m 안인 칸은 넣지 않는다(S06 과 겹치는 곳).
E09 판독점(picks.json)과 표고 조회(e09/smap-elevation-raw.json)는 표본에 넣지 않고 대조에만 쓴다.
"""
import json, math, pathlib, sys
import numpy as np
from common import TERRAIN_ID, Dem, dist_line, read_grid, segments

audit, repo, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
GRIDS = ['t04/smap-mesh-t04-gate-s-2m.txt', 't04/smap-mesh-t04-gate-n-2m.txt', 't04/smap-mesh-t04-plaza-2m.txt',
         'e05/smap-mesh-yudam-2m.txt', 'e05/smap-mesh-nw-2m.txt', 'e05/smap-mesh-south-2m.txt']
cells, reads = {}, {}
for f in GRIDS:
    g, step = read_grid(audit / f); assert step == 2
    for k, v in g.items():
        reads.setdefault(k, []).append(v[0])
        cells.setdefault(k, (*v, f))  # 먼저 나온 격자(이번에 읽은 것) 우선
N4 = [(2, 0), (-2, 0), (0, 2), (0, -2)]; N8 = [(dx, dy) for dx in (-2, 0, 2) for dy in (-2, 0, 2) if dx or dy]
terr = {k for k, v in cells.items() if v[1] == TERRAIN_ID}
drop = {}
def ok(k):
    v = cells.get(k)
    if v is None: return False
    why = None
    if v[1] != TERRAIN_ID: why = '건물·시설 모델 칸'
    elif any(n in cells and cells[n][1] != TERRAIN_ID for n in ((k[0] + dx, k[1] + dy) for dx, dy in N8)): why = '건물 칸 이웃'
    elif v[2] > 0.3: why = '되읽기 XY 잔차 0.3 m 초과'
    elif max(reads[k]) - min(reads[k]) > 0.5: why = '두 화면 값 0.5 m 초과 불일치'
    if why: drop.setdefault(k, why)
    return why is None

seg = segments(repo)
P = json.loads((repo / 'docs/audit/e09/picks.json').read_text(encoding='utf-8'))
existing = [p for g in json.loads((repo / 'backend/data/terrain/samples/smap_samples_5186.json').read_text(encoding='utf-8'))['groups'] for p in g['points']]
V2 = [p for p in seg['V2'] if p[1] <= 557262]  # 굽이 위쪽은 S06 구역

def grow(seeds, allowed, step):
    seen = {k for k in seeds if ok(k) and allowed(k)}; todo = list(seen)
    while todo:
        k = todo.pop()
        for dx, dy in N4:
            n = (k[0] + dx, k[1] + dy)
            if n in seen or not ok(n) or not allowed(n) or abs(cells[n][0] - cells[k][0]) > step: continue
            seen.add(n); todo.append(n)
    return seen
near = lambda lines, d: (lambda k: min(dist_line(k[0], k[1], l) for l in lines) <= d)
box = lambda x0, y0, x1, y1: (lambda k: x0 <= k[0] <= x1 and y0 <= k[1] <= y1)
seedp = lambda pts: {(2 * round(p[0] / 2) + dx, 2 * round(p[1] / 2) + dy) for p in pts for dx in (-2, 0, 2) for dy in (-2, 0, 2)}

AREAS = {
    'gate_road': dict(name='정문 차도', why='E09 V1·V2·P-LOW (정문 → 분수 광장 동쪽 → 굽이, 하단 주차장 차로)',
                      rule='중심선 4 m 안, 턱 0.8 m', lines=[seg['V1'], V2, seg['P-LOW']], d=4, step=0.8),
    'upper_branch': dict(name='은주관 서쪽 윗길', why='E09 U1 (굽이 → 본관·한림관 사이 → 은주관 서쪽 윗길)',
                         rule='중심선 4 m 안, 턱 0.8 m', lines=[seg['U1']], d=4, step=0.8),
    'turnaround': dict(name='본관 서쪽 회차 공간', why='E09 V4·P-UP, 버스정류장 2곳, 본관 입구(2)·유담관 9층 입구 앞 포장면',
                       rule='V4·P-UP 중심선과 E09 포장면 판독점에서 번짐, 상자 x 200998~201046 y 557296~557388, 턱 0.5 m, P1 입구 위 화단 상자(x 201008~201021 y 557306~557318)와 서쪽 나무 둔덕 가장자리 상자(x 200998~201006 y 557306~557346) 제외',
                       lines=[seg['V4'], seg['P-UP']], seeds=P['plazaSurface'], box=(200998, 557296, 201046, 557388), step=0.5,
                       # 뺀 곳: P1 입구 위 곡선 화단(포장면보다 0.4~0.9 m 높은 둔덕), 서쪽 나무 둔덕(133~135 m)의 가장자리 칸
                       exclude=[(201008, 557306, 201021, 557318), (200998, 557306, 201006, 557346)]),
    'fountain_plaza': dict(name='유담관 분수 광장', why='유담관 6층 로비 입구(1) 앞 평탄면(E08 기준 114.1 m). 차도 서쪽 옆',
                           rule='E09 광장 판독점 2개에서 번짐, 상자 x 201040~201092 y 557160~557240, 턱 0.3 m, 판독점 중앙값 ±0.6 m 안(평탄면만)',
                           seeds=P['other']['fountainPlaza'], box=(201040, 557160, 201092, 557240), step=0.3, zband=0.6),
}
result = {}
taken = set()
for key, a in AREAS.items():
    lines = a.get('lines', [])
    seeds = {k for k in terr if lines and near(lines, 2)(k)} | seedp(a.get('seeds', []))
    allowed = box(*a['box']) if 'box' in a else near(lines, a['d'])
    if 'exclude' in a:
        inb = allowed; ex = [box(*b) for b in a['exclude']]; allowed = lambda k, inb=inb, ex=ex: inb(k) and not any(e(k) for e in ex)
    if 'zband' in a:
        z0 = float(np.median([p[2] for p in a['seeds']])); inbox = allowed
        allowed = lambda k, inbox=inbox, z0=z0, b=a['zband']: inbox(k) and abs(cells[k][0] - z0) <= b
    got = grow(seeds, allowed, a['step']) - taken
    n0 = len(got)
    changed = True; med_drop = 0
    while changed:
        changed = False
        for k in sorted(got):
            nb = sorted(cells[n][0] for n in ((k[0] + dx, k[1] + dy) for dx, dy in N8) if n in got)
            if not nb or abs(cells[k][0] - float(np.median(nb))) > 1.5: got.discard(k); med_drop += 1; changed = True
    dup = {k for k in got if any(math.hypot(k[0] - p[0], k[1] - p[1]) <= 1 for p in existing)}
    got -= dup; taken |= got
    result[key] = dict(name=a['name'], why=a['why'], rule=a['rule'], grown=n0, droppedMedian=med_drop, droppedNearExisting=len(dup),
                       points=[[k[0], k[1], cells[k][0], cells[k][3]] for k in sorted(got, key=lambda k: (k[1], k[0]))])

# ---- 대조: 판독점·표고 조회 대 표본 칸(쌍선형, 네 귀 칸이 모두 표본일 때) ----
allz = {(p[0], p[1]): p[2] for a in result.values() for p in a['points']}
allz.update({(p[0], p[1]): p[2] for p in existing if p[0] % 2 == 0 and p[1] % 2 == 0})
def mesh_at(x, y):
    x0, y0 = 2 * math.floor(x / 2), 2 * math.floor(y / 2); tx, ty = (x - x0) / 2, (y - y0) / 2
    c = [allz.get((x0 + dx, y0 + dy)) for dx, dy in ((0, 0), (2, 0), (0, 2), (2, 2))]
    if any(v is None for v in c): return None
    return c[0] * (1 - tx) * (1 - ty) + c[1] * tx * (1 - ty) + c[2] * (1 - tx) * ty + c[3] * tx * ty
def stat(d):
    if not d: return dict(n=0)
    a = np.abs(d); return dict(n=len(d), median=round(float(np.median(d)), 2), p90Abs=round(float(np.percentile(a, 90)), 2), maxAbs=round(float(a.max()), 2))
pick_keys = dict(gate_road=['mainGate', 'mainFountain', 'mainBend', 'lowerPortalLane'], turnaround=['mainPlaza', 'p1Lane', 'p1ThresholdS07C1', 'plazaSurface'],
                 upper_branch=['upperBranch', 'upperBranchSouth'], fountain_plaza=[])
picks = {k: [p for kk in v for p in P[kk]] for k, v in pick_keys.items()}; picks['fountain_plaza'] = P['other']['fountainPlaza']
api = json.loads((audit / 'e09/smap-elevation-raw.json').read_text(encoding='utf-8'))
check = {}
for key in AREAS:
    dp = [(m - p[2]) for p in picks[key] if (m := mesh_at(p[0], p[1])) is not None]
    da = []
    for q in api:
        r = json.loads(q['raw'])['result'] if q['status'] == 200 else None
        if not r or r['buld_z'] is not None: continue
        if not any(abs(q['x'] - p[0]) < 0.01 and abs(q['y'] - p[1]) < 0.01 for p in picks[key]): continue
        m = mesh_at(q['x'], q['y'])
        if m is not None: da.append(m - r['dem_z'])
    check[key] = dict(meshMinusPick=dict(of=len(picks[key]), **stat(dp)), meshMinusApiDemZ=stat(da))
rep = [max(v) - min(v) for k, v in reads.items() if len(v) > 1 and k in taken]
dem = Dem(audit)
summary = {k: dict(samples=len(v['points']), grown=v['grown'], droppedMedian=v['droppedMedian'], droppedNearExisting=v['droppedNearExisting'],
                   z=[min(p[2] for p in v['points']), max(p[2] for p in v['points'])],
                   baseline=stat([p[2] - dem.at(p[0], p[1]) for p in v['points']]), check=check[k]) for k, v in result.items()}
doc = dict(created='2026-10-10', grids=GRIDS, areas=result, summary=summary,
           repeatReadsOnSamples=dict(n=len(rep), medianAbs=float(np.median(rep)), p90Abs=round(float(np.percentile(rep, 90)), 2), maxAbs=round(max(rep), 2)),
           droppedReasonsWithin6mOfRoads={})
allseg = list(seg.values())
for k, why in drop.items():
    if near(allseg, 6)(k): doc['droppedReasonsWithin6mOfRoads'][why] = doc['droppedReasonsWithin6mOfRoads'].get(why, 0) + 1
out.write_text(json.dumps(doc, ensure_ascii=False), encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps(dict(summary=summary, repeat=doc['repeatReadsOnSamples'], dropped=doc['droppedReasonsWithin6mOfRoads']), ensure_ascii=False, indent=1))

if len(sys.argv) > 4:
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(12, 16))
    ks = [k for k in cells if 200990 <= k[0] <= 201145 and 557085 <= k[1] <= 557405]
    t = [k for k in ks if cells[k][1] == TERRAIN_ID]
    ax.scatter([k[0] for k in t], [k[1] for k in t], c=[cells[k][0] for k in t], s=10, marker='s', cmap='terrain', vmin=95, vmax=135, alpha=.45)
    b = [k for k in ks if cells[k][1] != TERRAIN_ID]; ax.scatter([k[0] for k in b], [k[1] for k in b], c='0.6', s=10, marker='s')
    for (key, v), c in zip(result.items(), ['red', 'purple', 'blue', 'darkorange']):
        ax.scatter([p[0] for p in v['points']], [p[1] for p in v['points']], s=10, marker='s', facecolors='none', edgecolors=c, linewidths=.8, label=f"{key} {len(v['points'])}")
    ax.scatter([p[0] for p in existing], [p[1] for p in existing], s=3, c='k', label='existing samples')
    for l in seg.values(): ax.plot([p[0] for p in l], [p[1] for p in l], 'k-', lw=1)
    ax.set_xlim(200990, 201145); ax.set_ylim(557085, 557405); ax.set_aspect('equal'); ax.legend(loc='upper right'); ax.grid(alpha=.3)
    fig.savefig(sys.argv[4], dpi=75, bbox_inches='tight')
