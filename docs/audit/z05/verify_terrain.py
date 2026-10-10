"""Z05: 새 지형 격자를 Z04 뒤의 지형·기단 정의·S-MAP 1 m 메시와 견준다. DB 접근 없음(격자는 psql 로 떠 둔 파일).  python verify_terrain.py <새 지형 id>  -> verify-terrain.json"""
import sys; from base import *
from matplotlib.path import Path
NEW, OLD = Z05 / f'terrain-{sys.argv[1]}.f32', Z04 / 'terrain-recipe-a334b116df79c91e.f32'
W, H, X0, Y0, R = 450, 464, 200668, 556798, 2
load = lambda p: np.fromfile(p, dtype='<f4').reshape(H, W); new, old = load(NEW), load(OLD)
bmask = np.fromfile(str(AUDIT / 'z03' / 'terrain-z03-preview.buildings.u8'), dtype=np.uint8).reshape(H, W).astype(bool)
cy, cx = np.mgrid[0:H, 0:W]; ccx = X0 + (cx + 0.5) * R; ccy = Y0 + (cy + 0.5) * R
def height(p, x, y):
    if 'heightM' in p: return np.full(np.shape(x), p['heightM'], float)
    return prof_z(p['profile'], x, y)
def zone_of(fn):
    z = np.zeros((H, W), bool); exp = np.full((H, W), np.nan)
    for f in json.loads((REC / fn).read_text(encoding='utf-8'))['features']:
        g = f['geometry']['coordinates']; m = Path(np.array(g[0])).contains_points(np.c_[ccx.ravel(), ccy.ravel()]).reshape(H, W)
        for hole in g[1:]: m &= ~Path(np.array(hole)).contains_points(np.c_[ccx.ravel(), ccy.ravel()]).reshape(H, W)
        m &= ~bmask; exp[m] = height(f['properties'], ccx[m], ccy[m]); z |= m
    return z, exp
res = {'new': NEW.name, 'old': OLD.name}; d = new - old; ch = d != 0
z5, e5 = zone_of('z05-surface.geojson'); done = np.zeros((H, W), bool); res['finished_zones'] = {}
for fn in ('g02-surface.geojson', 'z02-surface.geojson', 'z03-surface.geojson'):
    z, e = zone_of(fn); z &= ~z5; done |= z   # 뒤 단계(Z05)의 기단이 덮는 칸은 Z04 때도 Z04 기단이 덮던 가장자리다
    res['finished_zones'][fn[:3]] = {'platform_cells': int(z.sum()), 'changed_vs_z04': int((ch & z).sum()), 'max_abs_off_plane_m': round(float(np.nanmax(np.abs(new - e)[z])), 4), 'cells_off_plane_0.3m_old': int((np.abs(old - e)[z] > 0.3).sum()), 'cells_off_plane_0.3m_new': int((np.abs(new - e)[z] > 0.3).sum())}
res['changed'] = {'cells': int(ch.sum()), 'building_cells': int((ch & bmask).sum()), 'in_z05_platforms': int((ch & z5).sum()), 'in_finished_zone_platforms': int((ch & done).sum()), 'elsewhere': int((ch & ~z5 & ~done & ~bmask).sum()), 'min': round(float(d.min()), 2), 'max': round(float(d.max()), 2)}
res['z05_platform_cells'] = int(z5.sum()); res['z05_max_abs_off_plane_m'] = round(float(np.nanmax(np.abs(new - e5)[z5])), 4)
xs, ys = XS, YS; ok = M.g & np.isfinite(Z); cell = lambda g, x, y: g[((np.asarray(y) - Y0) // R).astype(int), ((np.asarray(x) - X0) // R).astype(int)]
inc = contains_xy(CAMPUS, xs, ys); m = ok & inc & ~cell(bmask, xs, ys); res['vs_smap_1m_in_campus'] = {'points': int(m.sum())}
for tag, g in (('z04', old), ('z05', new)):
    e = cell(g, xs[m], ys[m]) - Z[m]; res['vs_smap_1m_in_campus'][tag] = {'median': round(float(np.median(e)), 2), 'p50_abs': round(float(np.median(np.abs(e))), 2), 'p90_abs': round(float(np.percentile(np.abs(e), 90)), 2)}
m = ok & ~inc & (ys < 557246) & (xs < 201182); res['vs_smap_1m_outside_sw'] = {'points': int(m.sum())}
for tag, g in (('z04', old), ('z05', new)):
    e = cell(g, xs[m], ys[m]) - Z[m]; res['vs_smap_1m_outside_sw'][tag] = {'median': round(float(np.median(e)), 2), 'p90_abs': round(float(np.percentile(np.abs(e), 90)), 2)}
pr = [{'id': q['id'], 'user_m': q['value_m'], 'z04': round(float(cell(old, q['x'], q['y'])), 2), 'z05': round(float(cell(new, q['x'], q['y'])), 2)} for q in pins() if cell(z5 | done, q['x'], q['y'])]
res['user_pins'] = {'n': len(pr), 'z04_p90_abs': round(float(np.percentile([abs(p['z04'] - p['user_m']) for p in pr], 90)), 2), 'z05_p90_abs': round(float(np.percentile([abs(p['z05'] - p['user_m']) for p in pr], 90)), 2), 'z05_over_1m': [p for p in pr if abs(p['z05'] - p['user_m']) > 1.0]}
dump(HERE5 / 'verify-terrain.json', res); print(json.dumps(res, ensure_ascii=False, indent=1))
