"""Z04: S-MAP 1 m 메시에서 평평한 면(기단 후보)과 한 방향으로 기운 면(경사면 후보)을 찾아 번호를 붙인다. 사람이 고르는 데 쓰는 보조 그림이다(자동 결과를 그대로 기단으로 쓰지 않는다).
  python -I segment.py   -> <볼트>/z04/후보-면-<구역>.png, docs/audit/z04/regions.json"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from scipy import ndimage as ndi
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
M = Mesh(); z = M.z
from shapely.geometry import Polygon
from shapely import contains_xy
CAMPUS = Polygon(json.loads((HERE / 'campus-outline-5186.json').read_text(encoding='utf-8'))['ring'])
_xs, _ys = np.meshgrid(MX0 + np.arange(MNX), MY0 + np.arange(MNY))
g = M.g & np.isfinite(M.z) & contains_xy(CAMPUS.buffer(6), _xs, _ys)
DONE = [(f['properties']['id'], np.array(f['geometry']['coordinates'][0])) for fn in ('g02-way', 'z02-daeil-front', 'z03-fountain') for f in json.loads((REPO / 'frontend/public/structures' / (fn + '.geojson')).read_text(encoding='utf-8'))['features'] if f['properties']['kind'] == 'platform']
def grow(mask, tol):
    """이웃 칸과 높이차가 tol 이하면 같은 면."""
    lab = np.zeros(z.shape, int); n = 0
    H, W = z.shape
    for sy, sx in zip(*np.nonzero(mask)):
        if lab[sy, sx]: continue
        n += 1; lab[sy, sx] = n; st = [(sy, sx)]
        while st:
            y, x = st.pop()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                v, u = y + dy, x + dx
                if 0 <= v < H and 0 <= u < W and mask[v, u] and not lab[v, u] and abs(z[v, u] - z[y, x]) <= tol: lab[v, u] = n; st.append((v, u))
    return lab, n
gy, gx = np.gradient(np.where(g, z, np.nan)); slope = np.hypot(gx, gy)
flat = g & (np.nan_to_num(slope, nan=9) <= 0.10)
lab1, n1 = grow(flat, 0.10)
regs = []; out = np.zeros(z.shape, int)
def add(lab, n, kind, min_cells):
    for k in range(1, n + 1):
        m = lab == k
        if m.sum() < min_cells: continue
        ys, xs = np.nonzero(m); zz = z[m]; A = np.c_[xs, ys, np.ones(len(xs))]; coef, *_ = np.linalg.lstsq(A, zz, rcond=None); res = zz - A @ coef
        r = {'id': len(regs) + 1, 'kind': kind, 'cells': int(m.sum()), 'z50': round(float(np.median(zz)), 2), 'zmin': round(float(zz.min()), 2), 'zmax': round(float(zz.max()), 2),
             'cx': round(float(MX0 + xs.mean()), 1), 'cy': round(float(MY0 + ys.mean()), 1), 'bbox': [float(MX0 + xs.min()), float(MY0 + ys.min()), float(MX0 + xs.max()), float(MY0 + ys.max())],
             'slopePct': round(float(np.hypot(coef[0], coef[1]) * 100), 1), 'dir': [round(float(coef[0]), 4), round(float(coef[1]), 4)], 'planeResP90': round(float(np.percentile(np.abs(res), 90)), 2)}
        regs.append(r); out[m] = r['id']
add(lab1, n1, 'flat', 20)
rest = g & (out == 0) & (np.nan_to_num(slope, nan=9) <= 0.30)
lab2, n2 = grow(rest, 0.30); add(lab2, n2, 'incline', 30)
np.save(Z04 / 'regions-label.npy', out)
(HERE / 'regions.json').write_text(json.dumps(regs, ensure_ascii=False, indent=0), encoding='utf-8', newline='\n')
print('flat', sum(r['kind'] == 'flat' for r in regs), 'incline', sum(r['kind'] == 'incline' for r in regs), 'covered', int((out > 0).sum()), 'of ground', int(g.sum()))
B = building_polys(); P = pins(); R = roads_before()
WIN = {'북서': (200984, 201130, 557280, 557417), '북동': (201100, 201267, 557250, 557417), '남서': (200984, 201130, 557086, 557300), '남동': (201090, 201267, 557086, 557270)}
rng = np.random.default_rng(3); cols = rng.uniform(0.25, 1, (len(regs) + 1, 3)); cols[0] = (1, 1, 1)
for nm, (xa, xb, ya, yb) in WIN.items():
    fig, ax = plt.subplots(figsize=((xb - xa) / 6.5, (yb - ya) / 6.5))
    img = cols[out]; img[~g] = (0.82, 0.82, 0.82); img[g & (out == 0)] = (0.2, 0.2, 0.2)
    ax.imshow(img, origin='lower', extent=[MX0 - .5, MX0 + MNX - .5, MY0 - .5, MY0 + MNY - .5], interpolation='nearest')
    for _id, c in DONE: ax.plot(c[:, 0], c[:, 1], color='gold', lw=1.6)
    ax.plot(*CAMPUS.exterior.xy, 'k--', lw=1)
    for name, poly in B.items(): ax.plot(*poly.exterior.xy, 'b-', lw=1.2); ax.text(poly.centroid.x, poly.centroid.y, name, color='b', fontsize=11, ha='center')
    for r in R:
        c = np.array(r.get('coordinates') or r.get('vertices'))[:, :2]; ax.plot(c[:, 0], c[:, 1], 'm-', lw=0.6)
    for p in P: ax.plot(p['x'], p['y'], 'r+', ms=6); ax.text(p['x'] + .5, p['y'] + .5, f"{p['value_m']}", color='r', fontsize=6)
    for r in regs:
        if xa <= r['cx'] <= xb and ya <= r['cy'] <= yb and r['cells'] >= 30:
            t = f"{r['id']}\n{r['z50']}" if r['kind'] == 'flat' else f"{r['id']}\n{r['zmin']:.0f}~{r['zmax']:.0f}\n{r['slopePct']}%"
            ax.text(r['cx'], r['cy'], t, fontsize=6.5, ha='center', va='center', color='k', bbox=dict(fc='w', ec='none', alpha=.55, pad=.5))
    ax.set_xlim(xa, xb); ax.set_ylim(ya, yb); ax.set_xticks(np.arange(xa, xb, 10)); ax.set_yticks(np.arange(ya, yb, 10)); ax.grid(lw=.3, color='k', alpha=.3); ax.tick_params(labelsize=6)
    ax.set_title(f'Z04 후보 면 {nm}: 색 = 면, 검정 = 가파른 칸(벽·계단이 뭉개진 곳), 회색 = 건물 모델, 파랑 = 건물 원천 외곽, 자홍 = 시험용 DB 길, 빨강 = 사용자 핀')
    plt.tight_layout(); plt.savefig(Z04 / f'후보-면-{nm}.png', dpi=75); plt.close()
