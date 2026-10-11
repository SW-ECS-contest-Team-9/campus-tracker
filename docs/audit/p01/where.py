"""P01: 한 네모(EPSG:5186) 안의 기단·상자를 적어 본다(작업 중 확인용).   python where.py X0 Y0 X1 Y1 [platform|extrude|all]"""
import json, pathlib, sys
STR = pathlib.Path(__file__).parents[3] / 'frontend' / 'public' / 'structures'
x0, y0, x1, y1 = map(float, sys.argv[1:5]); kind = sys.argv[5] if len(sys.argv) > 5 else 'platform'
for fn in sorted(STR.glob('*.geojson')):
    if fn.name.startswith(('p01', 'u01', 'u04')): continue
    for f in json.loads(fn.read_text(encoding='utf-8'))['features']:
        p = f['properties']; c = f['geometry']['coordinates'][0]; xs = [q[0] for q in c]; ys = [q[1] for q in c]
        if not (max(xs) > x0 and min(xs) < x1 and max(ys) > y0 and min(ys) < y1) or (kind != 'all' and p['kind'] != kind): continue
        t = p.get('topM') if p.get('topM') is not None else ([q[1] for q in p['topProfile']['points']] if p.get('topProfile') else p.get('toM'))
        print(fn.name[:12], p['id'], p.get('type'), 'x %.1f~%.1f y %.1f~%.1f' % (min(xs) - 201000, max(xs) - 201000, min(ys) - 557000, max(ys) - 557000), 'top', t, 'from', p.get('fromM', p.get('bottomM')), p.get('material', ''))
