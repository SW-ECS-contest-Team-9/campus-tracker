"""Z05: 캠퍼스 안에서 기단도 건물도 없는 곳(중립 바닥으로 그려지는 곳)을 덩어리별로 찍는다.  python gaps.py"""
from base import *
feats = [f for fn in sorted(STR.glob('*.geojson')) for f in json.loads(fn.read_text(encoding='utf-8'))['features'] if f['properties']['kind'] == 'platform']
cov = unary_union([Polygon(f['geometry']['coordinates'][0], f['geometry']['coordinates'][1:]).buffer(0) for f in feats] + [FIELD])
gap = CAMPUS.difference(cov).difference(DRAWN).buffer(-0.5).buffer(0.5)
for p in sorted(parts(gap, 15), key=lambda q: -q.area):
    zz, _, _ = M.inside(p); b = p.bounds
    print(f'{p.area:6.0f} m2  x {b[0]:.0f}~{b[2]:.0f}  y {b[1]:.0f}~{b[3]:.0f}  mesh {np.percentile(zz, 10):.1f}~{np.percentile(zz, 90):.1f}' if len(zz) else f'{p.area:6.0f} m2 {b}')
print('gap total', round(gap.area))
