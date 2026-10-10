# E06 1단계: 세션별로 무엇이 있는지 센다 (원본 위치·융합 위치·기압 상대높이, 운동장/안 바뀐 땅 위 점 수)
# 사용: python -I survey.py <원본 폴더> <감사 자료 폴더>
import sys; sys.stdout.reconfigure(encoding="utf-8")
import sys, json, io, glob, os, statistics as st
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Grids, tm
RAW, A = sys.argv[1], sys.argv[2]
G = Grids(A)
ss = {s['sessionId']: s for s in json.load(io.open(RAW + '/sessions.json', encoding='utf-8'))}
print('sid      col start             dur  nLoc nFus nZ  zRange rebases datum contacts  nField nSame  maxTerrDiff')
for sid, s in sorted(ss.items(), key=lambda kv: kv[1]['startedAt']):
    fp = json.load(io.open(f'{RAW}/fused-positions-{sid}.json', encoding='utf-8'))
    fu = json.load(io.open(f'{RAW}/fusion-{sid}.json', encoding='utf-8'))
    loc = json.load(io.open(f'{RAW}/loc-{sid}.json', encoding='utf-8'))
    run = next((r for r in fu.get('runs', []) if r['algorithmVersion'] == 'fusion-v4'), {})
    m = run.get('metrics', {}) or {}
    z = [p['relativeAltitude'] for p in fp if p.get('relativeAltitude') is not None]
    nf = ns = 0; md = 0.0
    for p in fp:
        if p.get('relativeAltitude') is None: continue
        x, y = tm(p['latitude'], p['longitude']); o = G.samp(G.old, x, y)
        if o is None: continue
        if p.get('terrainHeight') is not None: md = max(md, abs(p['terrainHeight'] - o))
        d = G.samp(G.diff, x, y)
        if d >= 5 and not p.get('buildingId'): nf += 1
        if abs(d) < 0.05 and not p.get('buildingId'): ns += 1
    t = m.get('terrain', {}) or {}
    dur = (np.datetime64(s['endedAt'][:19]) - np.datetime64(s['startedAt'][:19])).astype(int) if s.get('endedAt') else -1
    print(sid[:8], s['collectorId'], s['startedAt'][:16], f'{dur:5d}', f'{len(loc):4d} {len(fp):4d} {len(z):4d}', f'{(max(z)-min(z)) if z else 0:6.1f}',
          m.get('altimeterRebases', m.get('sensorTracking', {}) and None), t.get('datumSource'), t.get('contacts'), f'{nf:5d} {ns:5d}', f'{md:.3f}')
