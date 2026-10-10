"""Z04: 새 지형 격자를 직전 지형·기단 정의·S-MAP 1 m 메시·사용자 핀과 견준다. DB 접근 없음(격자는 psql 로 떠 둔 파일).
  python verify_terrain.py   -> docs/audit/z04/verify-terrain.json"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from matplotlib.path import Path
NEW, OLD = Z04 / 'terrain-recipe-a334b116df79c91e.f32', Z04 / 'terrain-recipe-795e6fbc2c056089.f32'
W, H, X0, Y0, R = 450, 464, 200668, 556798, 2
load = lambda p: np.fromfile(p, dtype='<f4').reshape(H, W)
new, old = load(NEW), load(OLD); bmask = np.fromfile(str(AUDIT / 'z03' / 'terrain-z03-preview.buildings.u8'), dtype=np.uint8).reshape(H, W).astype(bool)
cy, cx = np.mgrid[0:H, 0:W]; ccx = X0 + (cx + 0.5) * R; ccy = Y0 + (cy + 0.5) * R
surf = json.loads((REPO / 'backend/data/terrain/recipes/z04-surface.geojson').read_text(encoding='utf-8'))['features']
def height(p, x, y):
    if 'heightM' in p: return np.full(np.shape(x), p['heightM'], float)
    o, d, pts = p['profile']['origin'], p['profile']['direction'], np.array(p['profile']['points']); return np.interp((x - o[0]) * d[0] + (y - o[1]) * d[1], pts[:, 0], pts[:, 1])
zone = np.zeros((H, W), bool); exp = np.full((H, W), np.nan); owner = np.full((H, W), '', dtype=object)
for f in surf:   # 낮은 것부터 적혀 있다: 뒤의 것이 이긴다
    m = Path(np.array(f['geometry']['coordinates'][0])).contains_points(np.c_[ccx.ravel(), ccy.ravel()]).reshape(H, W) & ~bmask
    exp[m] = height(f['properties'], ccx[m], ccy[m]); zone |= m; owner[m] = f['properties']['name'].split('-')[1]
d = new - old; ch = d != 0; res = {'new': NEW.name, 'old': OLD.name}
res['changed'] = {'cells': int(ch.sum()), 'in_z04_platforms': int((ch & zone).sum()), 'outside': int((ch & ~zone).sum()), 'building_cells': int((ch & bmask).sum()), 'min': round(float(d.min()), 2), 'max': round(float(d.max()), 2)}
res['plane_fit_max_abs_m'] = round(float(np.nanmax(np.abs(new - exp)[zone])), 4); res['platform_cells'] = int(zone.sum())
res['old_cells_off_plane_by_0.3m'] = int((np.abs(old - exp)[zone] > 0.3).sum()); res['new_cells_off_plane_by_0.3m'] = int((np.abs(new - exp)[zone] > 0.3).sum())
M = Mesh(); xs, ys = np.meshgrid(MX0 + np.arange(MNX), MY0 + np.arange(MNY)); ok = M.g & np.isfinite(M.z)
cell = lambda g, x, y: g[((np.asarray(y) - Y0) // R).astype(int), ((np.asarray(x) - X0) // R).astype(int)]
inz = cell(zone, xs, ys) & ok; per = {}
for k in sorted(set(owner[zone])):
    m = inz & (cell(owner, xs, ys) == k); row = {'mesh_points': int(m.sum())}
    for tag, g in (('old', old), ('new', new)):
        e = cell(g, xs[m], ys[m]) - M.z[m]; row[tag] = {'median': round(float(np.median(e)), 2), 'p90_abs': round(float(np.percentile(np.abs(e), 90)), 2)}
    per[k] = row
res['vs_smap_1m_by_zone'] = per
e_old, e_new = (cell(g, xs[inz], ys[inz]) - M.z[inz] for g in (old, new))
res['vs_smap_1m_all'] = {'points': int(inz.sum()), 'old_p50_abs': round(float(np.median(np.abs(e_old))), 2), 'old_p90_abs': round(float(np.percentile(np.abs(e_old), 90)), 2), 'new_p50_abs': round(float(np.median(np.abs(e_new))), 2), 'new_p90_abs': round(float(np.percentile(np.abs(e_new), 90)), 2)}
# G02 오르막길 아래 끝 0~10 m: 길 가운데 띠(t -1.5~3)에서 S-MAP 과의 차
import importlib.util
sp = importlib.util.spec_from_file_location('g2', HERE.parent / 'g02' / 'common.py'); g2 = importlib.util.module_from_spec(sp); sp.loader.exec_module(g2)
ss, tt = np.meshgrid(np.arange(0.5, 10, 1.0), np.arange(-1.5, 3.1, 1.5)); P = g2.st_to_xy(ss.ravel(), tt.ravel()); mz = M.at(P[:, 0], P[:, 1]); k = np.isfinite(mz)
res['g02_foot_0_10m'] = {t: {'min': round(float((cell(g, P[k, 0], P[k, 1]) - mz[k]).min()), 2), 'median': round(float(np.median(cell(g, P[k, 0], P[k, 1]) - mz[k])), 2), 'max': round(float((cell(g, P[k, 0], P[k, 1]) - mz[k]).max()), 2)} for t, g in (('old', old), ('new', new))}
pr = [{'id': q['id'], 'user_m': q['value_m'], 'old': round(float(cell(old, q['x'], q['y'])), 2), 'new': round(float(cell(new, q['x'], q['y'])), 2)} for q in pins() if cell(zone, q['x'], q['y'])]
res['user_pins'] = {'n': len(pr), 'old_max_abs': round(max(abs(p['old'] - p['user_m']) for p in pr), 2), 'new_max_abs': round(max(abs(p['new'] - p['user_m']) for p in pr), 2), 'old_p90_abs': round(float(np.percentile([abs(p['old'] - p['user_m']) for p in pr], 90)), 2), 'new_p90_abs': round(float(np.percentile([abs(p['new'] - p['user_m']) for p in pr], 90)), 2),
                    'new_over_1m': [p for p in pr if abs(p['new'] - p['user_m']) > 1.0]}
(HERE / 'verify-terrain.json').write_text(json.dumps(res, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(json.dumps(res, ensure_ascii=False))
