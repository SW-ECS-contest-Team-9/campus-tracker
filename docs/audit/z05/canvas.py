"""Z05: S-MAP 1 m 메시 높이 위에 끝난 구역(노랑)·손으로 정한 길 띠(하늘색)·새 기단(빨강)을 그린다. 벽 선·평면을 고르고 확인하는 밑그림.
  python canvas.py <폴더> [창 이름,...]        (기단 없이)       build_inputs.py --plan <폴더> 가 기단과 함께 부른다"""
import sys; from hand import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
W = {'sw': (200984, 201115, 557086, 557262), 'w': (200984, 201062, 557240, 557417), 'n': (201040, 201180, 557330, 557417), 'ne': (201150, 201267, 557230, 557360), 'c': (201040, 201150, 557180, 557330), 'se': (201100, 201267, 557086, 557270)}
def draw(nm, xa, xb, ya, yb, out, plats=None, scale=7.0):
    fig, ax = plt.subplots(figsize=((xb - xa) / scale, (yb - ya) / scale)); ext = [MX0 - .5, MX0 + MNX - .5, MY0 - .5, MY0 + MNY - .5]
    Zg = np.where(M.g & np.isfinite(Z), Z, np.nan); sub = Zg[int(ya - MY0):int(yb - MY0), int(xa - MX0):int(xb - MX0)]; lo, hi = np.nanpercentile(sub, [1, 99])
    ax.imshow(Zg, origin='lower', extent=ext, cmap='terrain', vmin=lo - 3, vmax=hi + 3, interpolation='nearest', alpha=.7)
    ax.imshow(np.where(~M.g & np.isfinite(Z), 1.0, np.nan), origin='lower', extent=ext, cmap='gray', vmin=0, vmax=1.6, alpha=.5)
    xs = MX0 + np.arange(MNX); ys = MY0 + np.arange(MNY)
    ax.contour(xs, ys, Zg, levels=np.arange(np.floor(lo), hi + 1, 1), colors='k', linewidths=.3)
    cs5 = ax.contour(xs, ys, Zg, levels=np.arange(np.floor(lo / 5) * 5, hi + 5, 5), colors='k', linewidths=.9); ax.clabel(cs5, fmt='%d', fontsize=7)
    def fill(g, **kw):
        for p in parts(g): ax.fill(*p.exterior.xy, **kw)
    fill(DONE, color='gold', alpha=.45, ec='goldenrod'); fill(FIELD, color='gold', alpha=.25)
    for h in HAND: fill(h['poly'], color='cyan', alpha=.35, ec='teal', lw=.6)
    for b in SCENE: r = np.array(b['ring']); ax.plot(r[:, 0], r[:, 1], 'b-', lw=1.1)
    for name, poly in BLD.items(): ax.text(poly.centroid.x, poly.centroid.y, name, color='b', fontsize=9, ha='center', clip_on=True)
    ax.plot(*CAMPUS.exterior.xy, 'm--', lw=1.4)
    for p in pins():
        if xa <= p['x'] <= xb and ya <= p['y'] <= yb: ax.plot(p['x'], p['y'], 'r+', ms=6); ax.text(p['x'] + .5, p['y'] + .5, f"{p['value_m']}", color='r', fontsize=6, clip_on=True)
    for y in np.arange(np.ceil(ya / 4) * 4, yb, 4):
        for x in np.arange(np.ceil(xa / 4) * 4, xb, 4):
            v = Zg[int(y - MY0), int(x - MX0)] if 0 <= int(y - MY0) < MNY and 0 <= int(x - MX0) < MNX else np.nan
            if np.isfinite(v): ax.text(x, y, f'{v:.1f}', fontsize=4.6, color='k', ha='center', va='center', clip_on=True)
    for q in plats or []:
        for p in parts(q['poly']):
            ax.plot(*p.exterior.xy, color='red', lw=1.4)
            t = q['top']; c = p.representative_point(); ax.text(c.x, c.y, q['name'] + '\n' + (f'{t}' if not isinstance(t, dict) else '→'.join(f'{v[1]:.1f}' for v in (t['points'][0], t['points'][-1]))), color='red', fontsize=6.5, ha='center', clip_on=True, bbox=dict(fc='w', ec='none', alpha=.7, pad=.4))
    ax.set_xlim(xa, xb); ax.set_ylim(ya, yb); ax.set_aspect('equal'); ax.set_xticks(np.arange(np.ceil(xa / 10) * 10, xb, 10)); ax.set_yticks(np.arange(np.ceil(ya / 10) * 10, yb, 10)); ax.grid(lw=.3, color='k', alpha=.35); ax.tick_params(labelsize=6)
    ax.set_title(nm, fontsize=8); plt.savefig(out, dpi=100, bbox_inches='tight'); plt.close()
if __name__ == '__main__':
    out = pathlib.Path(sys.argv[1]); only = sys.argv[2].split(',') if len(sys.argv) > 2 else list(W)
    print('road pieces', N_ROAD_PIECES, 'hand', len(HAND))
    for k in only: draw(k, *W[k], out / f'canvas-{k}.png')
