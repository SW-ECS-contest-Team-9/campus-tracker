"""Z03: 새 지형 격자(미리보기 또는 저장본)를 직전 지형·기단 정의·S-MAP 0.5 m 메시·사용자 핀과 견준다. DB 접근 없음.
  python -I verify_terrain.py [새 격자.f32] [직전 격자.f32]
기본: z03/terrain-z03-preview.f32, z02/terrain-after-recipe-17f07ed60e1e84cd.f32   숫자: docs/audit/z03/verify-terrain.json   그림: z03/미리보기-지형.png"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from matplotlib.path import Path
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
NEW = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else Z03 / 'terrain-z03-preview.f32'
OLD = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else AUDIT / 'z02' / 'terrain-after-recipe-17f07ed60e1e84cd.f32'
W, H, X0, Y0, R = 450, 464, 200668, 556798, 2
load = lambda p: np.fromfile(p, dtype='<f4').reshape(H, W)
new, old, base = load(NEW), load(OLD), load(AUDIT / 'g02' / 'terrain-seoul5000-2015-ba7fcb19.f32')
bmask = np.fromfile(str(Z03 / 'terrain-z03-preview.buildings.u8'), dtype=np.uint8).reshape(H, W).astype(bool)
cy, cx = np.mgrid[0:H, 0:W]; ccx = X0 + (cx + 0.5) * R; ccy = Y0 + (cy + 0.5) * R
surf = json.loads((REPO / 'backend/data/terrain/recipes/z03-surface.geojson').read_text(encoding='utf-8'))['features']
struct = json.loads((REPO / 'frontend/public/structures/z03-fountain.geojson').read_text(encoding='utf-8'))['features']
plats = [f for f in struct if f['properties']['kind'] == 'platform']
assert [(f['properties']['surfaceName'], f['geometry'], f['properties'].get('topM'), f['properties'].get('topProfile')) for f in plats] == [(f['properties']['name'], f['geometry'], f['properties'].get('heightM'), f['properties'].get('profile')) for f in surf], '기단과 surface 입력이 다르다'
def height(p, x, y):
    if 'heightM' in p: return np.full(np.shape(x), p['heightM'], float)
    o, d, pts = p['profile']['origin'], p['profile']['direction'], np.array(p['profile']['points'])
    s = ((x - o[0]) * d[0] + (y - o[1]) * d[1]) / np.hypot(*d); return np.interp(s, pts[:, 0], pts[:, 1])
res = {'new': NEW.name, 'old': OLD.name}; zone = np.zeros((H, W), bool); exp = np.full((H, W), np.nan); per = {}
for f in surf:
    m = Path(np.array(f['geometry']['coordinates'][0])).contains_points(np.c_[ccx.ravel(), ccy.ravel()]).reshape(H, W) & ~bmask
    exp[m] = height(f['properties'], ccx[m], ccy[m]); zone |= m
    per[f['properties']['name']] = {'cells': int(m.sum()), 'old_minus_plane_m': [round(float(v), 2) for v in np.percentile((old - exp)[m], [0, 50, 100])] if m.any() else None}
res['platforms'] = per
d = new - old; ch = d != 0
res['changed'] = {'cells': int(ch.sum()), 'in_platforms': int((ch & zone).sum()), 'outside_platforms': int((ch & ~zone).sum()), 'building_cells': int((ch & bmask).sum()), 'min': round(float(d.min()), 2), 'max': round(float(d.max()), 2)}
res['plane_fit_max_abs_m'] = round(float(np.nanmax(np.abs(new - exp)[zone])), 4)
res['old_cells_off_plane_by_0.3m'] = int((np.abs(old - exp)[zone] > 0.3).sum()); res['new_cells_off_plane_by_0.3m'] = int((np.abs(new - exp)[zone] > 0.3).sum())
# 광장: S-MAP 0.5 m 메시와 견줌(광장 기단 안, 가장자리 1 m 안쪽)
from shapely.geometry import Polygon
from shapely import contains_xy
M = Mesh()
def cell(g, x, y): return g[((np.asarray(y) - Y0) // R).astype(int), ((np.asarray(x) - X0) // R).astype(int)]
for nm in ('Z03-PLAZA', 'Z03-ROAD-A', 'Z03-ROAD-B', 'Z03-TERRACE-S'):
    poly = Polygon(next(f for f in surf if f['properties']['name'] == nm)['geometry']['coordinates'][0]).buffer(-1.0)
    xs, ys = np.meshgrid(np.arange(201026, 201104, 0.5), np.arange(557160, 557269, 0.5)); m = contains_xy(poly, xs, ys); mz = M.at(xs[m], ys[m], ground=True); ok = np.isfinite(mz)
    out = {}
    for k, g in (('old', old), ('new', new)):
        e = cell(g, xs[m][ok], ys[m][ok]) - mz[ok]; out[k] = {'median': round(float(np.median(e)), 2), 'p90_abs': round(float(np.percentile(np.abs(e), 90)), 2), 'max_abs': round(float(np.abs(e).max()), 2)}
    res[f'vs_smap_{nm}'] = {'points': int(ok.sum()), **out}
pr = []
for q in pins():
    for f in surf:
        if Path(np.array(f['geometry']['coordinates'][0])).contains_point((q['x'], q['y'])) and not cell(bmask, q['x'], q['y']):
            pr.append({'id': q['id'], 'user_m': q['value_m'], 'platform': f['properties']['name'], 'old': round(float(cell(old, q['x'], q['y'])), 2), 'new': round(float(cell(new, q['x'], q['y'])), 2)})
res['user_pins'] = pr; res['user_pins_max_abs_new'] = round(max(abs(p['new'] - p['user_m']) for p in pr), 2); res['user_pins_max_abs_old'] = round(max(abs(p['old'] - p['user_m']) for p in pr), 2)
(HERE / 'verify-terrain.json').write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8', newline='\n')
print(json.dumps({k: v for k, v in res.items() if k != 'user_pins'}, ensure_ascii=False, indent=1)); print('pins', len(pr), [(p['id'], p['user_m'], p['old'], p['new']) for p in pr])
i0, i1, j0, j1 = (201024 - X0) // R, (201110 - X0) // R, (557150 - Y0) // R, (557266 - Y0) // R; ext = [201024, 201110, 557150, 557266]
fig, ax = plt.subplots(1, 3, figsize=(27, 12))
for a, g, t in ((ax[0], old, '직전 지형'), (ax[1], new, '새 지형(Z03 기단)')):
    im = a.imshow(np.clip(g[j0:j1, i0:i1], 92, 125), origin='lower', extent=ext, cmap='terrain'); a.set_title(t); plt.colorbar(im, ax=a, shrink=.6)
im = ax[2].imshow(np.clip(d[j0:j1, i0:i1], -8, 8), origin='lower', extent=ext, cmap='RdBu_r'); ax[2].set_title('새 − 직전 (m)'); plt.colorbar(im, ax=ax[2], shrink=.6)
for a in ax:
    for f in surf: c = np.array(f['geometry']['coordinates'][0]); a.plot(c[:, 0], c[:, 1], 'k-', lw=.8)
plt.tight_layout(); plt.savefig(Z03 / '미리보기-지형.png', dpi=60)
