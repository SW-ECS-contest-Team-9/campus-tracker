import sys, pathlib, json; sys.path.insert(0, str(pathlib.Path(__file__).parent))
from look import *
STR = pathlib.Path(__file__).parents[3] / 'frontend/public/structures'
pre = sys.argv[2] if len(sys.argv) > 2 else 'z04'
def extra(ax):
    for fn in sorted(STR.glob('*.geojson')):
        for f in json.loads(fn.read_text(encoding='utf-8'))['features']:
            p = f['properties']
            if p['kind'] != 'platform': continue
            c = np.array(f['geometry']['coordinates'][0]); k = p['id'].split('-')[-1][0] if fn.stem.startswith(pre) else 'D'
            col = {'S': 'red', 'R': 'darkorange', 'T': 'lime', 'D': 'gold'}.get(k if p['id'].split('-')[-1][1:].isdigit() or k == 'D' else 'H', 'cyan')
            ax.plot(c[:, 0], c[:, 1], color=col, lw=1.3 if col != 'gold' else .8)
            if col in ('red', 'darkorange', 'lime'): ax.text(c[:-1, 0].mean(), c[:-1, 1].mean(), p['id'].split('-')[-1], color=col, fontsize=6, ha='center', clip_on=True, bbox=dict(fc='w', ec='none', alpha=.6, pad=.3))
W = {'sw': (200984, 201110, 557086, 557260), 'w': (200984, 201070, 557240, 557417), 'n': (201040, 201180, 557290, 557417), 'ne': (201150, 201267, 557230, 557360), 'c': (201060, 201150, 557180, 557320), 'se': (201090, 201267, 557086, 557270)}
out = pathlib.Path(sys.argv[1])
for k, w in W.items():
    if len(sys.argv) > 3 and k not in sys.argv[3].split(','): continue
    draw(k, *w, out / f'{pre}-{k}.png', extra=extra, scale=8.0)
