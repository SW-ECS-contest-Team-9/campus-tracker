"""V02 4단계 점검과 그림: 차도 띠 지형이 주변에 번지는 범위, 새 급경사, 건물 외곽 아래 지형 변화. 그림 3장.
   python impact.py <볼트 audit 폴더> <저장소 루트>
   입력: evaluate.ts 가 쓴 격자(<audit>/v02/dem-*.f32), profile.json, road-profile.geojson, user-readings.json.
   출력: results.json (user-readings 요약 + road-summary + results-terrain + 이 점검), <audit>/v02/v02-*.png"""
import sys, json, math, pathlib, warnings
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from surface import Surface
warnings.filterwarnings('ignore')
audit = pathlib.Path(sys.argv[1]); repo = pathlib.Path(sys.argv[2]); here = pathlib.Path(__file__).parent
meta = json.loads((audit / 'terrain-grid-meta.json').read_text(encoding='utf-8-sig')); W, H, RS, OX, OY = meta['width'], meta['height'], meta['resolution'], meta['originX'], meta['originY']
def grid(f): return np.fromfile(f, dtype='<f4').reshape(H, W)
G = {'old': grid(audit / 'terrain-grid.f32'), 'active': grid(audit / 'v02/dem-active-f5f1dbc4.f32'), 'samples': grid(audit / 'v02/dem-replace.f32'),
     'ribbon': grid(audit / 'v02/dem-replace-ribbon.f32'), 'ribbon_u1': grid(audit / 'v02/dem-replace-u1-ribbon.f32')}
def dem(h, x, y):
    fx = (np.asarray(x) - OX) / RS - 0.5; fy = (np.asarray(y) - OY) / RS - 0.5; ix = np.floor(fx).astype(int); iy = np.floor(fy).astype(int); tx, ty = fx - ix, fy - iy
    return h[iy, ix] * (1 - tx) * (1 - ty) + h[iy, ix + 1] * tx * (1 - ty) + h[iy + 1, ix] * (1 - tx) * ty + h[iy + 1, ix + 1] * tx * ty
prof = json.loads((here / 'profile.json').read_text(encoding='utf-8'))
summ = json.loads((here / 'road-summary.json').read_text(encoding='utf-8'))
UR = json.loads((here / 'user-readings.json').read_text(encoding='utf-8'))
RT = json.loads((here / 'results-terrain.json').read_text(encoding='utf-8'))
RP = json.loads((here / 'road-profile.geojson').read_text(encoding='utf-8'))
CK = json.loads((here / 'check-points.json').read_text(encoding='utf-8'))
outl = json.loads((audit / 'building-outlines-5186.json').read_text(encoding='utf-8'))
S = Surface(audit)
HALF = CK['half']
CX = OX + (np.arange(W) + 0.5) * RS; CY = OY + (np.arange(H) + 0.5) * RS; XX, YY = np.meshgrid(CX, CY)
# 칸마다 가장 가까운 차도 가운데 선까지의 거리와 그 구간
js = summ['lines']['main']['junctionStationsM']; names = ['V1', 'V2', 'V3', 'V4a', 'V4b']
lines = []
m = prof['main']
for k, n in enumerate(names):
    sel = [i for i, s in enumerate(m['s']) if js[k] - 1e-6 <= s <= js[k + 1] + 1e-6]; lines.append((n, np.array(m['xy'])[sel]))
for n in ('P-LOW', 'P-UP', 'U1'): lines.append((n, np.array(prof[n]['xy'])))


def dist_field(use):
    d = np.full((H, W), 1e9); seg = np.full((H, W), -1)
    for k, (n, xy) in enumerate(lines):
        if n not in use: continue
        for p in xy:
            dd = np.hypot(XX - p[0], YY - p[1]) - HALF[n]
            upd = dd < d; d[upd] = dd[upd]; seg[upd] = k
    return d, seg


def steep(h):
    gx = (np.c_[h[:, 1:], h[:, -1:]] - np.c_[h[:, :1], h[:, :-1]]) / (2 * RS); gy = (np.r_[h[1:], h[-1:]] - np.r_[h[:1], h[:-1]]) / (2 * RS)
    return np.hypot(gx, gy) > 1


def mesh_step(x, y):
    """그 자리 3 m 안에서 S-MAP 메시(건물 포함) 높이 폭. 2 m 넘으면 실제 턱·옹벽·건물로 본다."""
    from surface import X0, Y0
    i, j = int(round(x - X0)), int(round(y - Y0))
    if not (3 <= i < S.any.shape[1] - 3 and 3 <= j < S.any.shape[0] - 3): return None
    w = S.any[j - 3:j + 4, i - 3:i + 4]
    return None if np.all(np.isnan(w)) else float(np.nanmax(w) - np.nanmin(w))


def impact(new, base, use):
    d, seg = dist_field(use); h, b = G[new], G[base]; delta = h - b; ch = delta != 0
    band = ch & (d > 2) & (d <= 30)
    st_new = steep(h) & ~steep(b); st_gone = steep(b) & ~steep(h)
    cells = np.argwhere(st_new)
    real, art, unk, by = 0, 0, 0, {}
    for iy, ix in cells:
        ms = mesh_step(CX[ix], CY[iy]); n = lines[seg[iy, ix]][0] if seg[iy, ix] >= 0 else '?'
        e = by.setdefault(n, {'real': 0, 'gentleInSmap': 0, 'outsideMesh': 0, 'xs': [], 'ys': []}); e['xs'].append(float(CX[ix])); e['ys'].append(float(CY[iy]))
        if ms is None: unk += 1; e['outsideMesh'] += 1
        elif ms >= 2.0: real += 1; e['real'] += 1
        else: art += 1; e['gentleInSmap'] += 1
    for e in by.values(): e.pop('xs'); e.pop('ys')
    where = {}
    for iy, ix in cells:
        n = lines[seg[iy, ix]][0] if seg[iy, ix] >= 0 else '?'; w = where.setdefault(n, [1e9, 1e9, -1e9, -1e9]); w[0] = min(w[0], float(CX[ix])); w[1] = min(w[1], float(CY[iy])); w[2] = max(w[2], float(CX[ix])); w[3] = max(w[3], float(CY[iy]))
    bl = []
    for o in outl:
        ring = np.array(o['coordinates'][0][0]); pts = []
        for a, c in zip(ring[:-1], ring[1:]):
            L = math.hypot(*(c - a)[:2]); k = max(1, int(L)); pts += [a[:2] + (c - a)[:2] * t / k for t in range(k)]
        pts = np.array(pts); dv = dem(h, pts[:, 0], pts[:, 1]) - dem(b, pts[:, 0], pts[:, 1])
        if np.abs(dv).max() > 0.05:
            bl.append({'name': o['name'], 'outlinePoints': len(pts), 'changedPoints': int((np.abs(dv) > 0.05).sum()), 'over0_3': int((np.abs(dv) > 0.3).sum()), 'min': round(float(dv.min()), 2), 'median': round(float(np.median(dv)), 2), 'max': round(float(dv.max()), 2),
                       'lowestPointChange': round(float(dem(h, pts[:, 0], pts[:, 1]).min() - dem(b, pts[:, 0], pts[:, 1]).min()), 2)})
    return {'new': new, 'comparedWith': base, 'changedCells': int(ch.sum()), 'maxDistOfChangeFromCarriagewayM': round(float(d[ch].max()), 1) if ch.any() else 0, 'changeBeyond12m': int((ch & (d > 12)).sum()), 'changeBeyond30m': int((ch & (d > 30)).sum()),
            'band2to30m': {'cellsChanged': int(band.sum()), 'areaOver0_5m2': int((band & (np.abs(delta) > 0.5)).sum() * RS * RS), 'areaOver2m2': int((band & (np.abs(delta) > 2)).sum() * RS * RS), 'maxAbs': round(float(np.abs(delta[band]).max()), 1) if band.any() else 0},
            'insideCarriageway': {'cells': int((d <= 0).sum()), 'medianAbsChange': round(float(np.median(np.abs(delta[d <= 0]))), 2), 'maxAbsChange': round(float(np.abs(delta[d <= 0]).max()), 2)},
            'steep45': {'new': int(st_new.sum()), 'gone': int(st_gone.sum()), 'newWhereSmapAlsoStepped': real, 'newWhereSmapGentle': art, 'newOutsideMesh': unk, 'bySegment': by, 'bboxBySegment': {k: [round(v, 0) for v in w] for k, w in where.items()}},
            'buildings': bl}


MAINSEG = ['V1', 'V2', 'V3', 'V4a', 'V4b', 'P-LOW', 'P-UP']
imp = {'ribbon_vs_active': impact('ribbon', 'active', MAINSEG), 'ribbon_vs_old': impact('ribbon', 'old', MAINSEG), 'samplesOnly_vs_active': impact('samples', 'active', MAINSEG),
       'u1_added_vs_ribbon': impact('ribbon_u1', 'ribbon', ['U1'])}

# ---------------- 그림 ----------------
plt.rcParams['font.family'] = ['Malgun Gothic', 'DejaVu Sans']; plt.rcParams['axes.unicode_minus'] = False
pts = UR['points']
fig, ax = plt.subplots(figsize=(11, 13))
for o in outl:
    r = np.array(o['coordinates'][0][0]); ax.fill(r[:, 0], r[:, 1], color='#ddd', ec='#999', lw=0.6); ax.text(r[:, 0].mean(), r[:, 1].mean(), o['name'], fontsize=7, ha='center', color='#555')
state = json.loads((audit / 'n02/06-state-after.json').read_text(encoding='utf-8'))
for f in RP['features']:
    if f['geometry']['type'] != 'LineString': continue
    c = np.array(f['geometry']['coordinates']); p = f['properties']
    if p.get('roadId'):
        old = np.array(next(r for r in state['roads'] if r['id'] == p['roadId'])['coordinates']); ax.plot(old[:, 0], old[:, 1], '-', color='#888', lw=1, marker='.', ms=3)
    ax.plot(c[:, 0], c[:, 1], '-' if p.get('roadId') else '--', color='k', lw=2.2)
    ax.annotate(p['id'], c[len(c) // 2, :2], xytext=(6, 6), textcoords='offset points', fontsize=9, weight='bold')
for r in pts:
    road = r['segment'] is not None
    ax.plot(r['x'], r['y'], 'o' if road else 's', color='#d62728' if road else '#1f77b4', ms=5 if road else 3.5, mec='k' if road else 'none', mew=0.4)
    if road or r['surface'].startswith(('본관', '한림관', '하단')): ax.annotate('%.1f' % r['value_m'], (r['x'], r['y']), xytext=(4, -3), textcoords='offset points', fontsize=6.5, color='#900' if road else '#246')
ax.plot([], [], 'o', color='#d62728', mec='k', label='사용자 핀: 차도·포장면 위 (%d)' % sum(1 for r in pts if r['segment'])); ax.plot([], [], 's', color='#1f77b4', label='사용자 핀: 그 밖의 표면 (%d)' % sum(1 for r in pts if not r['segment']))
ax.plot([], [], '-', color='#888', marker='.', label='지금 시험용 DB 의 길(E09 판독 꼭짓점)'); ax.plot([], [], '-', color='k', lw=2.2, label='V02 다듬은 가운데 선'); ax.plot([], [], '--', color='k', label='선택 제안 U1-EXT(사용자 핀 4개)')
ax.set_xlim(200995, 201150); ax.set_ylim(557085, 557385); ax.set_aspect('equal'); ax.legend(loc='lower left', fontsize=8); ax.set_title('V02 평면: 사용자 S-MAP 높이 핀과 차도 가운데 선 (EPSG:5186)'); ax.grid(alpha=.3)
fig.savefig(audit / 'v02/v02-plan.png', dpi=130, bbox_inches='tight'); plt.close(fig)

picks = json.loads((repo / 'docs/audit/e09/picks.json').read_text(encoding='utf-8'))
fig, axes = plt.subplots(3, 1, figsize=(13, 13), gridspec_kw={'height_ratios': [3, 2, 1.6]})
def panel(ax, key, title):
    p = prof[key]; s = np.array(p['s']); xy = np.array(p['xy']); z = np.array(p['z'])
    ax.plot(s, dem(G['old'], xy[:, 0], xy[:, 1]), '-', color='#b8860b', lw=1, label='옛 지형(2015)')
    ax.plot(s, dem(G['active'], xy[:, 0], xy[:, 1]), '-', color='#2ca02c', lw=1, label='시험용 DB 지금 지형(f5f1dbc4)')
    ax.plot(s, dem(G['samples'] if key != 'U1' else grid(audit / 'v02/dem-replace-u1.f32'), xy[:, 0], xy[:, 1]), '-', color='#9467bd', lw=1, label='차도 띠 표본만 넣은 지형')
    ax.plot(s, dem(G['ribbon_u1'] if key == 'U1' else G['ribbon'], xy[:, 0], xy[:, 1]), '-', color='#17becf', lw=3, alpha=.6, label='표본 + 띠 새김 지형')
    mz = S.at(xy[:, 0], xy[:, 1]); ax.plot(s, mz, '.', color='#aaa', ms=3, label='S-MAP 메시(가운데 선)')
    ax.plot(s, z, '-', color='k', lw=1.6, label='V02 매끄러운 종단')
    u = summ['lines'][key]['userPoints']
    ax.plot([a['s'] for a in u if a['use']], [a['value_m'] for a in u if a['use']], 'o', color='#d62728', mec='k', ms=6, label='사용자 핀(6 m 안)')
    ax.plot([a['s'] for a in u if not a['use']], [a['value_m'] for a in u if not a['use']], 'o', color='none', mec='#d62728', ms=6, label='사용자 핀(포장면, 선에서 6 m 넘음)')
    for a in u:
        if a['use']: ax.annotate('%.1f' % a['value_m'], (a['s'], a['value_m']), xytext=(3, -11), textcoords='offset points', fontsize=7, color='#900')
    ax.set_ylim(z.min() - 3, z.max() + 4); ax.set_xlim(0, s[-1]); ax.set_ylabel('높이 (m)'); ax.set_title(title, fontsize=10); ax.grid(alpha=.3)
panel(axes[0], 'main', '본선 종단: 정문(V1) → 분수 광장 옆(V2) → S06(V3) → 회차 공간 내리막(V4)')
for v, n in zip(js, ['V1', 'V2', 'V3', 'V4a', 'V4b', '']): axes[0].axvline(v, color='#666', ls=':', lw=.8); axes[0].text(v + 1, axes[0].get_ylim()[0] + .5, n, fontsize=8)
axes[0].legend(fontsize=7.5, ncol=2, loc='upper left')
panel(axes[1], 'U1', '윗길 U1 종단: 굽이 → 본관·한림관 사이 → 은주관 서쪽')
for key, col in (('main', 'k'), ('U1', '#d62728'), ('P-LOW', '#1f77b4')):
    p = prof[key]; s = np.array(p['s']); z = np.array(p['z']); axes[2].plot((s[1:] + s[:-1]) / 2, np.diff(z) / np.diff(s) * 100, '-', color=col, label=key if key != 'main' else '본선')
old = []
for n, rid in (('V1', '729bd2ad'), ('V2', 'e934fcd3'), ('V3', '499ab1ab'), ('V4a', '07615440'), ('V4b', '67e234b5')):
    c = np.array(next(r for r in state['roads'] if r['id'].startswith(rid))['coordinates']); old += c[(1 if old else 0):].tolist()
old = np.array(old); so = np.r_[0, np.cumsum(np.hypot(*np.diff(old[:, :2], axis=0).T))]
axes[2].step(so[:-1], np.diff(old[:, 2]) / np.diff(so) * 100, where='post', color='#999', lw=.9, label='본선: 지금 DB 꼭짓점 사이 경사')
axes[2].axhline(15, color='r', ls='--', lw=.8); axes[2].set_ylim(-20, 30); axes[2].set_xlim(0, js[-1]); axes[2].set_ylabel('경사 (%)'); axes[2].set_xlabel('길 따라 거리 (m)'); axes[2].legend(fontsize=8, ncol=4); axes[2].grid(alpha=.3); axes[2].set_title('경사(1 m 간격). 빨간 점선 15 %', fontsize=10)
fig.tight_layout(); fig.savefig(audit / 'v02/v02-profile.png', dpi=130); plt.close(fig)

fig, ax = plt.subplots(figsize=(11, 13))
dd = G['ribbon_u1'] - G['active']; ext = [OX, OX + W * RS, OY, OY + H * RS]
im = ax.imshow(np.where(dd == 0, np.nan, dd), origin='lower', extent=ext, cmap='RdBu_r', vmin=-6, vmax=6)
for o in outl: r = np.array(o['coordinates'][0][0]); ax.plot(r[:, 0], r[:, 1], '-', color='#555', lw=.7)
for n, xy in lines: ax.plot(xy[:, 0], xy[:, 1], '-', color='k', lw=1)
st = steep(G['ribbon_u1']) & ~steep(G['active']); iy, ix = np.nonzero(st); ax.plot(CX[ix], CY[iy], 'x', color='#0a0', ms=4, label='새로 45° 넘는 칸')
ax.set_xlim(200985, 201150); ax.set_ylim(557080, 557385); ax.set_aspect('equal'); plt.colorbar(im, ax=ax, shrink=.6, label='새 지형 − 지금 지형 (m)'); ax.legend(fontsize=8)
ax.set_title('V02 차도 띠(표본 + 띠 새김, U1 포함)를 넣었을 때 지형 변화: 시험용 DB 지금 지형 대비'); fig.savefig(audit / 'v02/v02-terrain-change.png', dpi=130, bbox_inches='tight'); plt.close(fig)

json.dump({'title': 'V02 사용자 고도점으로 차도 매끄럽게', 'created': '2026-10-11', 'applied': False,
           'userReadings': UR['summary'], 'cameras': UR['cameras'], 'road': summ,
           'terrain': {'tool': RT['settings'], 'checkPoints': RT['checkPoints'], 'oldTerrainMinusRoad': RT['oldTerrain'], 'combos': RT['combos'],
                       'passesScan': json.loads((here / 'passes-scan.json').read_text(encoding='utf-8')) if (here / 'passes-scan.json').exists() else None, 'impact': imp}},
          open(here / 'results.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for k, v in imp.items():
    print(k, {a: v[a] for a in ('changedCells', 'maxDistOfChangeFromCarriagewayM', 'changeBeyond12m', 'changeBeyond30m', 'band2to30m', 'insideCarriageway')})
    print('   steep', {a: v['steep45'][a] for a in ('new', 'gone', 'newWhereSmapAlsoStepped', 'newWhereSmapGentle', 'newOutsideMesh')}, v['steep45']['bySegment'], v['steep45']['bboxBySegment'])
    print('   buildings', v['buildings'])
