# E06 2단계(탐색용): 한 세션의 시간순 요약. 구역(F=보정 5 m 이상, e=0.05~5 m, S=안 바뀜), 기압 상대높이 z, 옛/새 지형
# 사용: python -I profile.py <원본 폴더> <감사 자료 폴더> <세션 앞 8자> [구간 초=15]
import sys; sys.stdout.reconfigure(encoding="utf-8")
import sys, json, io, glob, os, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Grids, tm
import numpy as np
RAW, A, key = sys.argv[1], sys.argv[2], sys.argv[3]
step = int(sys.argv[4]) if len(sys.argv) > 4 else 15
G = Grids(A)
fn = glob.glob(f'{RAW}/fused-positions-{key}*.json')[0]
fp = json.load(io.open(fn, encoding='utf-8'))
t0 = np.datetime64(fp[0]['timestamp'][:23])
rows = []
for p in fp:
    if p.get('relativeAltitude') is None: continue
    x, y = tm(p['latitude'], p['longitude']); o = G.samp(G.old, x, y)
    if o is None: continue
    n = G.samp(G.new, x, y); d = n - o
    zone = 'F' if d >= 5 else ('S' if abs(d) < 0.05 else 'e')
    t = (np.datetime64(p['timestamp'][:23]) - t0) / np.timedelta64(1, 's')
    rows.append((t, zone, 'B' if p.get('buildingId') else '-', p['relativeAltitude'], o, n, p['horizontalUncertainty'], x, y, p['source'], p.get('heightAboveGround'), p.get('zDatumSource')))
print(os.path.basename(fn), 'n', len(rows), 'start', fp[0]['timestamp'])
print('  t(s)  n zone bld    z   old   new  old+1-z new+1-z  hu     x       y   hag  datum')
k = 0
while k < len(rows):
    j = k
    while j < len(rows) and rows[j][0] < rows[k][0] + step: j += 1
    seg = rows[k:j]; md = lambda i: st.median(r[i] for r in seg)
    zs = ''.join(sorted({r[1] for r in seg})); bs = ''.join(sorted({r[2] for r in seg}))
    hag = [r[10] for r in seg if r[10] is not None]
    print(f'{seg[0][0]:6.0f} {len(seg):2d} {zs:4s} {bs:3s} {md(3):6.2f} {md(4):6.1f} {md(5):6.1f} {md(4)+1-md(3):7.2f} {md(5)+1-md(3):7.2f} {md(6):5.1f} {md(7):8.0f} {md(8):8.0f}', f'{st.median(hag):5.1f}' if hag else '  -  ', seg[0][11])
    k = j
