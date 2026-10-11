"""Z09: 구조물 파일의 기단(윗면 높이)과 장면 건물 외곽을 평면으로 그린다(작업용). DB 접근 없음: 건물은 저장해 둔 /api/v1/scene 응답 파일.
  python plan.py <scene.json> <x0> <y0> <x1> <y1> <out.png>"""
import sys, json, pathlib, math
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from matplotlib import font_manager
plt.rcParams['font.family'] = font_manager.FontProperties(fname=r'C:\Windows\Fonts\malgun.ttf').get_name()
STR = pathlib.Path(__file__).parents[3] / 'frontend' / 'public' / 'structures'
scene, x0, y0, x1, y1, out = sys.argv[1], *map(float, sys.argv[2:6]), sys.argv[6]
K0, LAT0, LON0, FE, FN, A, F = 1.0, math.radians(38), math.radians(127), 200000.0, 600000.0, 6378137.0, 1 / 298.257222101
def tm(lon, lat):
    e2 = F * (2 - F); ep2 = e2 / (1 - e2); lat, lon = math.radians(lat), math.radians(lon)
    def M(p): return A * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * p - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * math.sin(2 * p) + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * math.sin(4 * p) - (35 * e2**3 / 3072) * math.sin(6 * p))
    N = A / math.sqrt(1 - e2 * math.sin(lat)**2); T = math.tan(lat)**2; C = ep2 * math.cos(lat)**2; AA = (lon - LON0) * math.cos(lat)
    x = FE + K0 * N * (AA + (1 - T + C) * AA**3 / 6 + (5 - 18 * T + T**2 + 72 * C - 58 * ep2) * AA**5 / 120)
    y = FN + K0 * (M(lat) - M(LAT0) + N * math.tan(lat) * (AA**2 / 2 + (5 - T + 9 * C + 4 * C**2) * AA**4 / 24 + (61 - 58 * T + T**2 + 600 * C - 330 * ep2) * AA**6 / 720))
    return x, y
fig, ax = plt.subplots(figsize=(14, 14 * (y1 - y0) / (x1 - x0)))
for f in sorted(STR.glob('*.geojson')):
    for ft in json.loads(f.read_text(encoding='utf-8'))['features']:
        p = ft['properties']
        if p.get('kind') != 'platform': continue
        ring = ft['geometry']['coordinates'][0]; xs = [c[0] for c in ring]; ys = [c[1] for c in ring]
        if max(xs) < x0 or min(xs) > x1 or max(ys) < y0 or min(ys) > y1: continue
        t = p.get('topM'); lab = f"{t}" if t is not None else f"{p['topProfile']['points'][0][1]}→{p['topProfile']['points'][-1][1]}"
        ax.fill(xs, ys, alpha=0.25, ec='k', lw=0.6, fc={'asphalt': '#333', 'planting': '#5a5', 'paving': '#aa8', 'concrete': '#99a'}.get(p.get('material'), '#ccc'))
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
        if x0 < cx < x1 and y0 < cy < y1: ax.text(cx, cy, p['id'].replace('PLATFORM-', '')[4:] + '\n' + lab + f" b{p['bottomM']}", fontsize=6, ha='center')
for b in json.load(open(scene, encoding='utf-8'))['buildings']:
    for poly in b['geometry']['coordinates']:
        r = [tm(*c[:2]) for c in poly[0]]; ax.plot([c[0] for c in r], [c[1] for c in r], 'r-', lw=1.2)
        cx, cy = sum(c[0] for c in r) / len(r), sum(c[1] for c in r) / len(r)
        if x0 < cx < x1 and y0 < cy < y1: ax.text(cx, cy, f"{b['buildingId']}\n{b['baseM']:.0f}~{b['roofM']:.0f}", color='r', fontsize=7, ha='center')
ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect('equal'); ax.grid(lw=0.3); fig.savefig(out, dpi=80, bbox_inches='tight')
