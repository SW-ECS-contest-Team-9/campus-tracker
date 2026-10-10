"""Z02: 적용 전후 지형 격자에서 기단별 평탄도와 골(기단 윗면보다 낮은 칸)을 센다. python verify_terrain.py BEFORE.f32 AFTER.f32"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from shapely.geometry import shape, Point, Polygon
from shapely.ops import unary_union
from shapely import contains_xy
tb, ta = load_terrain(OUT / sys.argv[1]), load_terrain(OUT / sys.argv[2])
gx = GRID['ox'] + (np.arange(GRID['w']) + .5) * GRID['res']; gy = GRID['oy'] + (np.arange(GRID['h']) + .5) * GRID['res']
X, Y = np.meshgrid(gx, gy)
bl = unary_union([Polygon(b['coordinates'][0] if isinstance(b['coordinates'][0][0][0], (int, float)) else b['coordinates'][0][0]).buffer(0) for b in buildings()])
inb = contains_xy(bl, X, Y)
d = json.loads((REPO / 'frontend/public/structures/z02-daeil-front.geojson').read_text(encoding='utf-8'))
plats = [(f['properties'], shape(f['geometry']).buffer(0)) for f in d['features'] if f['properties']['kind'] == 'platform' and not f['properties']['surfaceName'].startswith('없음')]  # 지형에 싣지 않는 좁은 기단은 뺀다
res = {'changedCells': int((tb != ta).sum()), 'changedBuildingCells': int(((tb != ta) & inb).sum()), 'platforms': {}}
top = np.full(ta.shape, np.nan)
for p, g in plats:   # 뒤의 기단이 이긴다
    m = contains_xy(g, X, Y) & ~inb; top[m] = p['topM']
for p, g in plats:
    m = (top == p['topM']) & contains_xy(g, X, Y) & ~inb
    if not m.any(): res['platforms'][p['id']] = {'cells': 0}; continue
    res['platforms'][p['id']] = {'topM': p['topM'], 'cells': int(m.sum()), 'before_min_med_max': [round(float(v), 2) for v in (tb[m].min(), np.median(tb[m]), tb[m].max())],
                                 'after_min_max': [round(float(ta[m].min()), 2), round(float(ta[m].max()), 2)], 'after_max_abs_dev': round(float(np.abs(ta[m] - p['topM']).max()), 3)}
front = [(p, g) for p, g in plats if not p['id'].endswith('FIELD')]
zone = contains_xy(unary_union([g for _, g in front]), X, Y) & ~inb
res['frontZone'] = {'cells': int(zone.sum()), 'belowTopBy0.3_before': int((tb[zone] < top[zone] - 0.3).sum()), 'belowTopBy0.3_after': int((ta[zone] < top[zone] - 0.3).sum()),
                    'deepestBefore_m': round(float((top[zone] - tb[zone]).max()), 2), 'deepestAfter_m': round(float((top[zone] - ta[zone]).max()), 2)}
# 벽 앞 1 m 선(쌍선형, 화면에 보이는 값): 건물 칸(옛 지형)과 섞여 벽 바로 앞이 꺼져 보이는지
us = np.arange(-9, 54, 1.0); out = {}
for off in (0.5, 1.5, 3.0):
    vv = np.array([(BAYV if -14.6 <= u < 0 else (1.67 if 40.1 <= u <= 54 else 0)) + off for u in us for BAYV in [1.9]])
    p = uv_to_xy(us, vv); p = np.array([uv_to_xy(u, v) for u, v in zip(us, vv)])
    zb, za = terrain_at(tb, p[:, 0], p[:, 1]), terrain_at(ta, p[:, 0], p[:, 1])
    out[f'wall+{off}m'] = {'before_min_med': [round(float(zb.min()), 2), round(float(np.median(zb)), 2)], 'after_min_med': [round(float(za.min()), 2), round(float(np.median(za)), 2)]}
res['bilinearNearFrontWall'] = out
M = Mesh()
for name, pts in {'entrance': [uv_to_xy(1.7, 5.2)], 'passage': [uv_to_xy(u, 1.2) for u in range(12, 40, 4)], 'plaza': [uv_to_xy(56, 0)], 'yard': [(201217, 557300)]}.items():
    p = np.array(pts); res.setdefault('smapAt', {})[name] = [round(float(v), 2) for v in M.at(p[:, 0], p[:, 1])]
(HERE / 'verify-terrain.json').write_text(json.dumps(res, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(json.dumps(res, ensure_ascii=False, indent=1))
