"""G02: 새 지형(미리보기 격자)을 옛 지형·S-MAP 메시·사용자 핀과 견준다. DB 접근 없음(격자 파일만 읽음).
  python -I preview.py [새 격자.f32]     (기본: g02/terrain-g02-preview.f32, preview.ts 가 쓴 것)
그림: g02/미리보기-차이.png, 미리보기-단면.png, 미리보기-종단.png   숫자: docs/audit/g02/preview-results.json
"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
NEW = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else G02 / 'terrain-g02-preview.f32'
W, H, X0, Y0, R = 450, 464, 200668, 556798, 2
load = lambda p: np.fromfile(p, dtype='<f4').reshape(H, W)
old, new, base = load(G02 / 'terrain-recipe-ab443660e96d2cbe.f32'), load(NEW), load(G02 / 'terrain-seoul5000-2015-ba7fcb19.f32')
bmask = np.fromfile(G02 / 'terrain-g02-preview.buildings.u8', dtype=np.uint8).reshape(H, W).astype(bool)
def bil(g, x, y):
    fx = (np.asarray(x, float) - X0) / R - 0.5; fy = (np.asarray(y, float) - Y0) / R - 0.5
    ix = np.clip(np.floor(fx).astype(int), 0, W - 2); iy = np.clip(np.floor(fy).astype(int), 0, H - 2); a = fx - ix; b = fy - iy
    return g[iy, ix] * (1 - a) * (1 - b) + g[iy, ix + 1] * a * (1 - b) + g[iy + 1, ix] * (1 - a) * b + g[iy + 1, ix + 1] * a * b
def cell(g, x, y): return g[((np.asarray(y) - Y0) // R).astype(int), ((np.asarray(x) - X0) // R).astype(int)]
mesh = Mesh(); res = {}
surf = json.loads((HERE.parents[2] / 'backend/data/terrain/recipes/g02-surface.geojson').read_text(encoding='utf-8'))
boxes = json.loads((HERE.parents[2] / 'frontend/public/structures/g02-way.geojson').read_text(encoding='utf-8'))['features']
pins = [p for p in json.loads((HERE.parent / 'v02' / 'user-readings.json').read_text(encoding='utf-8'))['points'] if p.get('x')]
from matplotlib.path import Path
cy, cx = np.mgrid[0:H, 0:W]; ccx = X0 + (cx + 0.5) * R; ccy = Y0 + (cy + 0.5) * R; cs, ct = xy_to_st(ccx, ccy)
inside = {f['properties']['name']: Path(np.array(f['geometry']['coordinates'][0])).contains_points(np.c_[ccx.ravel(), ccy.ravel()]).reshape(H, W) for f in surf['features']}
zone = np.zeros((H, W), bool)
for m_ in inside.values(): zone |= m_
zone &= ~bmask

# 1. 바뀐 칸
d = new - old; ch = d != 0
res['changed'] = {'cells': int(ch.sum()), 'in_zone': int((ch & zone).sum()), 'outside_zone': int((ch & ~zone).sum()), 'min': float(d.min()), 'max': float(d.max()),
                  'building_cells_changed': int((ch & bmask).sum())}
# 조리법에서 UPHILL 띠를 뺐으므로 구역 밖에서 바뀐 칸 = 옛 띠의 번짐이 사라진 칸
# 2. 골 검사: 구역 안에서 기본 경사면보다 낮은 칸은 낮은 마당(LANE)뿐이어야 한다
lower = zone & (new < way_z(cs) - 0.01)
res['below_way_plane'] = {'cells': int(lower.sum()), 'all_in_LANE': bool((lower & ~inside['LANE']).sum() == 0), 'old_cells_below_plane_by_0.3': int((zone & (old < way_z(cs) - 0.3) & ~inside['LANE']).sum()),
                          'old_max_below_m': float((way_z(cs) - old)[zone & ~inside['LANE']].max())}
# 평면에 정확히 놓였나
exp = np.where(inside['WAY'], way_z(cs), np.nan)
for f in surf['features'][1:]: exp = np.where(inside[f['properties']['name']], f['properties']['heightM'], exp)
res['plane_fit_max_abs_m'] = float(np.nanmax(np.abs(new - exp)[zone]))
# 3. S-MAP 메시와의 차(경사로 가운데 띠 t 0~3, 0.5 m 간격) — 옛 지형과 새 지형
S = np.arange(1, 110, 0.5); T = np.arange(0, 3.01, 0.5); ss, tt = np.meshgrid(S, T); p = st_to_xy(ss, tt); mz = mesh.at(p[..., 0], p[..., 1])
for nm, g in (('old', old), ('new', new)):
    e = bil(g, p[..., 0], p[..., 1]) - mz; e = e[np.isfinite(e)]
    res[f'ramp_vs_smap_{nm}'] = {'n': int(e.size), 'median': round(float(np.median(e)), 2), 'p90_abs': round(float(np.percentile(np.abs(e), 90)), 2), 'max_abs': round(float(np.abs(e).max()), 2)}
plat = {}
for nm, (s0, s1, t0, t1) in {'LANE': (4, 30, 10, 16), 'PODIUM': (33, 49, 8, 15), 'FORK': (68, 75, 10.5, 16), 'TOP': (77, 92, 11, 16)}.items():
    a, b = np.meshgrid(np.arange(s0, s1, 0.5), np.arange(t0, t1, 0.5)); q = st_to_xy(a, b); m2 = mesh.at(q[..., 0], q[..., 1]); ok = np.isfinite(m2)
    plat[nm] = {'smap_median': round(float(np.median(m2[ok])), 2), 'smap_p5_p95': [round(float(v), 2) for v in np.percentile(m2[ok], [5, 95])], 'old_median': round(float(np.median(bil(old, q[..., 0], q[..., 1])[ok])), 2), 'new_median': round(float(np.median(cell(new, q[..., 0], q[..., 1])[ok])), 2)}
res['platforms'] = plat
# 4. 사용자 핀
pr = []
for q in pins:
    s_, t_ = xy_to_st(q['x'], q['y'])
    if 0 < s_ < 112 and -6 < t_ < 17.5 and cell(zone, q['x'], q['y']):
        pr.append({'id': q['id'], 's': round(float(s_), 1), 't': round(float(t_), 1), 'user': q['value_m'], 'old': round(float(bil(old, q['x'], q['y'])), 2), 'new': round(float(cell(new, q['x'], q['y'])), 2), 'xy_err_m': q['xy_err_m']})
res['user_pins'] = pr
# 5. 지하 차도(951c157d)가 경사면 아래에 있는가
ug = np.array([(201100.3, 557327.6, 136.4), (201081.2, 557336.5, 132.2), (201056.2, 557348.2, 128.6), (201053.9, 557349.2, 128.5)])
cov = []
for k in range(len(ug) - 1):
    for f_ in np.linspace(0, 1, 11):
        q = ug[k] + (ug[k + 1] - ug[k]) * f_; cov.append(float(bil(new, q[0], q[1]) - q[2]))
res['underground_cover_m'] = {'min': round(min(cov), 2), 'max': round(max(cov), 2), 'note': '지하 차도 바닥(시험용 DB 길 951c157d 높이, 추정)에서 새 지표까지'}
# 6. 건물 외곽 둘레의 지형 최저(외곽선 1 m 간격 표본, 쌍선형)
bl = {}
for b in buildings():
    if b['name'] not in ('북악관', '문예관', '본관', '한림관', '대일관'): continue
    lo, ln = [], []
    for poly in b['coordinates']:
        r = np.array(poly[0])
        for k in range(len(r) - 1):
            m_ = max(2, int(np.hypot(*(r[k + 1] - r[k]))) + 1); q = r[k] + np.outer(np.linspace(0, 1, m_), r[k + 1] - r[k])
            lo += list(bil(old, q[:, 0], q[:, 1])); ln += list(bil(new, q[:, 0], q[:, 1]))
    lo, ln = np.array(lo), np.array(ln)
    bl[b['name']] = {'old_min': round(float(lo.min()), 2), 'new_min': round(float(ln.min()), 2), 'old_max': round(float(lo.max()), 2), 'new_max': round(float(ln.max()), 2), 'max_drop': round(float((lo - ln).max()), 2), 'max_rise': round(float((ln - lo).max()), 2)}
res['building_outline_terrain'] = bl
(HERE / 'preview-results.json').write_text(json.dumps(res, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({k: v for k, v in res.items() if k != 'user_pins'}, ensure_ascii=False, indent=1)); print('pins', [(q['id'], q['user'], q['old'], q['new']) for q in pr])

# ---- 그림 ----
S2 = np.arange(-12, 125, 0.5); T2 = np.arange(-14, 22, 0.5); a, b = np.meshgrid(S2, T2); q = st_to_xy(a, b); ext = [S2[0], S2[-1], T2[0], T2[-1]]
fig, ax = plt.subplots(3, 1, figsize=(22, 19))
for k, (g, ti) in enumerate(((old, '옛 지형(F05 recipe-ab443660) − 기본 경사면'), (new, '새 지형(G02) − 기본 경사면'))):
    im = ax[k].imshow(np.clip(cell(g, q[..., 0], q[..., 1]) - way_z(a), -6, 6), origin='lower', extent=ext, cmap='RdBu_r', vmin=-6, vmax=6); ax[k].set_title(ti); plt.colorbar(im, ax=ax[k], shrink=.7)
im = ax[2].imshow(np.clip(cell(new, q[..., 0], q[..., 1]) - cell(old, q[..., 0], q[..., 1]), -5, 5), origin='lower', extent=ext, cmap='PuOr_r', vmin=-5, vmax=5); ax[2].set_title('새 − 옛 (m)'); plt.colorbar(im, ax=ax[2], shrink=.7)
for a_ in ax:
    for bb in buildings():
        for poly in bb['coordinates']:
            r = np.array(poly[0]); s_, t_ = xy_to_st(r[:, 0], r[:, 1]); a_.plot(s_, t_, 'k-', lw=1)
    for f in surf['features']:
        r = np.array(f['geometry']['coordinates'][0]); s_, t_ = xy_to_st(r[:, 0], r[:, 1]); a_.plot(s_, t_, 'g-', lw=1)
    a_.set_xlim(ext[0], ext[1]); a_.set_ylim(ext[2], ext[3]); a_.set_xticks(np.arange(-10, 125, 5)); a_.grid(alpha=.3); a_.set_xlabel('s: 아래 끝에서 위로 (m)'); a_.set_ylabel('t: 북쪽 + (m)')
plt.tight_layout(); plt.savefig(G02 / '미리보기-차이.png', dpi=70); plt.close()

stations = [5, 15, 25, 35, 45, 60, 70, 80, 88, 97, 106]
fig, ax = plt.subplots(4, 3, figsize=(24, 20)); ax = ax.ravel(); tt = np.arange(-8, 18.01, 0.25)
for k, s0 in enumerate(stations):
    A = ax[k]; q = st_to_xy(np.full(len(tt), float(s0)), tt)
    A.plot(tt, bil(old, q[:, 0], q[:, 1]), color='#999', lw=1.5, label='옛 지형(쌍선형)')
    A.step(tt, cell(new, q[:, 0], q[:, 1]), color='tab:blue', lw=2, where='mid', label='새 지형(칸 값)')
    A.plot(tt, mesh.at(q[:, 0], q[:, 1]), 'r.', ms=3, label='S-MAP 메시 0.5 m(땅)')
    bm = cell(bmask, q[:, 0], q[:, 1]); A.fill_between(tt, 0, 1, where=bm, transform=A.get_xaxis_transform(), color='k', alpha=.12, label='건물 칸')
    for f in boxes:  # 이 단면이 지나는 구조물 상자
        r = np.array(f['geometry']['coordinates'][0]); bs, bt = xy_to_st(r[:, 0], r[:, 1])
        if bs.min() <= s0 <= bs.max():
            A.add_patch(plt.Rectangle((bt.min(), f['properties']['fromM']), bt.max() - bt.min(), f['properties']['toM'] - f['properties']['fromM'], fc={'planter': '#7a5', 'stair_step': '#fa3', 'barrier': '#e22', 'wall': '#bbb'}.get(f['properties']['type'], '#888'), ec='k', lw=.5, alpha=.8))
    for u in pins:
        us, ut = xy_to_st(u['x'], u['y'])
        if abs(us - s0) <= 4 and -8 <= ut <= 18: A.plot(ut, u['value_m'], 'k*', ms=11); A.annotate(u['id'], (ut, u['value_m']), fontsize=7)
    A.set_title(f's = {s0} m  (경사면 {way_z(s0):.2f} m)'); A.grid(alpha=.3); z0 = way_z(s0); A.set_ylim(z0 - 5, z0 + 6.5); A.set_xlabel('t (m): 남쪽 본관·한림관 ← → 북쪽 북악관·문예관·대일관')
ax[0].legend(fontsize=8, loc='upper left'); ax[-1].axis('off')
ax[-1].text(0, .5, '초록·주황 상자 = 구조물 파일(화단·디딤판, 추정)\n별 = 사용자 S-MAP 핀(±4 m 안, 자리 오차 1.5~3 m)\n옛 지형은 쌍선형, 새 지형은 2 m 칸 값 그대로', fontsize=12)
plt.tight_layout(); plt.savefig(G02 / '미리보기-단면.png', dpi=60); plt.close()

fig, A = plt.subplots(figsize=(20, 7)); sl = np.arange(-8, 122, 0.5); q = st_to_xy(sl, np.full(len(sl), 1.0))
A.plot(sl, mesh.at(q[:, 0], q[:, 1]), 'r.', ms=4, label='S-MAP 메시(경사로 가운데 t = 1)')
A.plot(sl, bil(base, q[:, 0], q[:, 1]), ':', color='#555', label='원래 지형(2015 등고선)')
A.plot(sl, bil(old, q[:, 0], q[:, 1]), color='#999', lw=2, label='옛 지형(F05)')
A.plot(sl, bil(new, q[:, 0], q[:, 1]), color='tab:blue', lw=2, label='새 지형(G02)')
ugs = xy_to_st(ug[:, 0], ug[:, 1])[0]; A.plot(ugs, ug[:, 2], 'k--', label='지하 차도 바닥(951c157d, 추정)')
for u in pins:
    us, ut = xy_to_st(u['x'], u['y'])
    if -8 < us < 122 and -3 < ut < 5: A.plot(us, u['value_m'], 'k*', ms=12); A.annotate(u['id'], (us, u['value_m']), fontsize=8)
A.legend(); A.grid(alpha=.3); A.set_xlabel('s (m)'); A.set_ylabel('m'); A.set_title('종단: 회차 공간(130.6) → 운동장(148.9)')
plt.tight_layout(); plt.savefig(G02 / '미리보기-종단.png', dpi=70)
