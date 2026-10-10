"""F05: 운동장 둘레 S-MAP 지면(148.9 m 와의 차: 연두 ±0.2, 노랑 +0.2~0.5, 주황 +0.5~1.5, 붉은색 +1.5 초과, 하늘 −0.2~−0.5, 파랑 −0.5 미만, 회색 건물 모델), 건물 원천 외곽(검정), 옛 경계(초록), 새 경계(빨강, 꼭짓점 번호), 길(파랑).
  python plot.py <3d-map-audit-20261009> roads-before.json OUT.png results.json [x0,x1,y0,y1]
"""
import json, sys, pathlib
import numpy as np, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from common import smap, T
audit, roads_path, out = sys.argv[1:4]
x0, y0, z, mid, src = smap(audit)
ny, nx = z.shape
d = z - 148.9
img = np.zeros((ny, nx, 3))
img[:] = (1, 1, 1)
terr = mid == T
img[terr & (np.abs(d) <= 0.2)] = (0.75, 0.9, 0.75)
img[terr & (d > 0.2) & (d <= 0.5)] = (1, 0.95, 0.5)
img[terr & (d > 0.5) & (d <= 1.5)] = (1, 0.7, 0.3)
img[terr & (d > 1.5)] = (0.85, 0.35, 0.2)
img[terr & (d < -0.2) & (d >= -0.5)] = (0.7, 0.85, 1)
img[terr & (d < -0.5)] = (0.3, 0.5, 0.9)
img[~terr & ~np.isnan(z)] = (0.75, 0.75, 0.75)
img[~terr & ~np.isnan(z) & (np.abs(d) <= 0.5)] = (0.6, 0.8, 0.6)
fig, ax = plt.subplots(figsize=(15, 16))
ax.imshow(img, origin='lower', extent=(x0 - .5, x0 + nx - .5, y0 - .5, y0 + ny - .5), interpolation='nearest')
for b in json.load(open(f'{audit}/building-outlines-5186.json', encoding='utf8')):
    for pg in b['coordinates']:
        r = np.array(pg[0]); ax.plot(r[:, 0], r[:, 1], 'k-', lw=1.5)
old = np.array(json.load(open('../e10/field-area.geojson', encoding='utf8'))['features'][0]['geometry']['coordinates'][0])
ax.plot(old[:, 0], old[:, 1], 'g-', lw=2)
for r in json.load(open(roads_path, encoding='utf8'))['roads']:
    c = np.array([p[:2] for p in r['geometry']['coordinates']])
    if c is None: continue
    ax.plot(c[:, 0], c[:, 1], 'b-', lw=0.8)
    for e in (c[0], c[-1]): ax.plot(e[0], e[1], 'bo', ms=4)
    ax.text(c[len(c)//2, 0], c[len(c)//2, 1], r['id'][:8], color='b', fontsize=6, clip_on=True)
if len(sys.argv) > 4:
    new = np.array(json.load(open(sys.argv[4], encoding='utf8'))['ring']); ax.plot(new[:, 0], new[:, 1], 'r-', lw=2.5)
    for i, p in enumerate(new[:-1]): ax.text(p[0], p[1], str(i), color='r', fontsize=11, clip_on=True)
win = [float(v) for v in sys.argv[5].split(',')] if len(sys.argv) > 5 else [201118, 201262, 557160, 557322]
ax.set_xlim(win[0], win[1]); ax.set_ylim(win[2], win[3]); ax.set_aspect('equal')
st = 10 if win[1] - win[0] > 80 else 5
ax.set_xticks(np.arange(win[0], win[1], st)); ax.set_yticks(np.arange(win[2], win[3], st)); ax.grid(True, lw=0.3)
if win[1] - win[0] <= 80:
    for j in range(ny):
        for i in range(nx):
            X, Y = x0 + i, y0 + j
            if win[0] <= X <= win[1] and win[2] <= Y <= win[3] and not np.isnan(z[j, i]) and terr[j, i] and abs(d[j, i]) > 0.2 and abs(d[j,i]) < 9.9 and (src[j, i] == 1 or (X % 2 == 0 and Y % 2 == 0)):
                ax.text(X, Y, f'{d[j, i]*10:.0f}', fontsize=5.5, ha='center', va='center', clip_on=True)
fig.savefig(out, dpi=70, bbox_inches='tight')
