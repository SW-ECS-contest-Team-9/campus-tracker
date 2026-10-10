# E06: 실외 휴대폰 궤적이 지나간 5 m 칸 목록(S-MAP 조회용). 시각·세션·순서는 내보내지 않는다(칸 중심만, 섞어서).
# 사용: python -I track_cells.py <원본 폴더> <감사 자료 폴더> <출력 cells.json> [넓힘 칸 수=2]
import sys; sys.stdout.reconfigure(encoding="utf-8")
import sys, json, io, os, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Grids, tm
RAW, A, OUT = sys.argv[1:4]; DIL = int(sys.argv[4]) if len(sys.argv) > 4 else 2
C = 5.0
G = Grids(A)
ss = json.load(io.open(RAW + '/sessions.json', encoding='utf-8'))
core = set(); per = {}
for s in ss:
    if s['collectorId'] == 'SIM': continue
    sid = s['sessionId']
    fp = json.load(io.open(f'{RAW}/fused-positions-{sid}.json', encoding='utf-8'))
    n = 0
    for p in fp:
        if p.get('relativeAltitude') is None or p.get('buildingId') or (p.get('horizontalUncertainty') or 99) > 15: continue
        x, y = tm(p['latitude'], p['longitude'])
        if G.samp(G.old, x, y) is None: continue
        core.add((int(x // C), int(y // C))); n += 1
    per[sid[:8]] = n
cells = set()
for (i, j) in core:
    for di in range(-DIL, DIL + 1):
        for dj in range(-DIL, DIL + 1):
            if di * di + dj * dj <= DIL * DIL + 1: cells.add((i + di, j + dj))
out = [[(i + .5) * C, (j + .5) * C] for (i, j) in cells]
random.shuffle(out)
json.dump(out, io.open(OUT, 'w'))
print('실외 점 수(세션별)', {k: v for k, v in per.items() if v}); print('지나간 칸', len(core), '넓힌 뒤', len(out))
