"""Z07: 평면 보조 그림. S-MAP 1 m 메시 위에 장면 건물(부분별 지붕 높이), 구조물(기단 윗면·상자), 시험용 DB 길 높이를 겹친다. 읽기만 한다.
  python plan.py <이름> xa xb ya yb out.png [state.json]     (장면은 http://127.0.0.1:3210/api/v1/scene)"""
import sys, pathlib, json, urllib.request; sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'z05')); sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'z04'))
from look import *
def scene(): return json.loads(urllib.request.urlopen('http://127.0.0.1:3210/api/v1/scene').read().decode('utf-8'))
def rings(g):
    c = g['coordinates']
    return [p[0] for p in (c if g['type'] == 'MultiPolygon' else [c])]
def structures():
    out = []
    for f in sorted((REPO / 'frontend/public/structures').glob('*.geojson')): out += json.loads(f.read_text(encoding='utf-8'))['features']
    return out
if __name__ == '__main__':
    a = sys.argv; xa, xb, ya, yb = map(float, a[2:6]); state = json.loads(pathlib.Path(a[7]).read_text(encoding='utf-8')) if len(a) > 7 else None
    def extra(ax):
        for f in structures():
            p = f['properties']; r = np.array(f['geometry']['coordinates'][0]); cx, cy = r[:-1].mean(0)[:2]
            if not (xa <= cx <= xb and ya <= cy <= yb): continue
            if p['kind'] == 'platform': ax.plot(r[:, 0], r[:, 1], 'g-', lw=.8); ax.text(cx, cy, f"{p['id'].split('-', 1)[-1][:14]}\n{p.get('topM', 'prof')}", color='g', fontsize=5, ha='center', clip_on=True)
            elif p['kind'] == 'extrude' and p['type'] not in ('tree',): ax.plot(r[:, 0], r[:, 1], '-', color='orange', lw=.6)
        for b in scene()['buildings']:
            for r in rings(b['geometry']):
                r = np.array(r); ax.plot(r[:, 0], r[:, 1], 'r-', lw=1.0); ax.text(r[:-1, 0].mean(), r[:-1, 1].mean() - 2, f"{b['buildingId']}\n{b['baseM']:.1f}~{b['roofM']:.1f}", color='r', fontsize=6, ha='center', clip_on=True)
        for r in (state or {}).get('roads', []):
            c = np.array(r['coordinates'])
            if not ((c[:, 0] > xa) & (c[:, 0] < xb) & (c[:, 1] > ya) & (c[:, 1] < yb)).any(): continue
            ax.plot(c[:, 0], c[:, 1], '-', color='purple', lw=.9, marker='.', ms=3)
            for x, y, z in c[:: max(1, len(c) // 4)]: ax.text(x, y, f'{z:.1f}', color='purple', fontsize=5, clip_on=True)
    draw(a[1], xa, xb, ya, yb, a[6], extra=extra, scale=float(a[8]) if len(a) > 8 else 5.0)
