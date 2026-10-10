"""Z08: 단면선이 지나는 구조물과 그 높이를 숫자로 낸다(구조물 파일만 읽음. DB·네트워크 접근 없음).
  python section_numbers.py            -> 표준 출력과 section-numbers.json
보는 것: 본관 5층 문 – 데크 – 한림관 3층 문(데크 축), 지하 보행 구간을 따라(내리막길 밑 빈 곳 → 덮인 복도 → 데크).
데크·복도 바닥·덮개·내리막길 포장면이 서로 맞는지(단 차, 덮개 두께, 안 높이)를 적는다."""
import json, pathlib
from shapely.geometry import shape, LineString, Point
HERE = pathlib.Path(__file__).parent; S = HERE.parents[2] / 'frontend' / 'public' / 'structures'
VIEWS = json.loads((HERE / 'views.json').read_text(encoding='utf-8'))
feats = []
for f in sorted(S.glob('*.geojson')):
    for ft in json.loads(f.read_text(encoding='utf-8'))['features']:
        feats.append((f.name, ft['properties'], shape(ft['geometry'])))

def top_at(p, x, y):
    tp = p.get('topProfile')
    if not tp: return p.get('topM', p.get('toM'))
    ox, oy = tp['origin']; dx, dy = tp['direction']; n = (dx * dx + dy * dy) ** 0.5; d = ((x - ox) * dx + (y - oy) * dy) / n
    pts = sorted(tp['points'])
    if d <= pts[0][0]: return pts[0][1]
    for (a, za), (b, zb) in zip(pts, pts[1:]):
        if d <= b: return za + (zb - za) * (d - a) / ((b - a) or 1)
    return pts[-1][1]

def along(line_xy, step=0.5):
    line = LineString(line_xy); rows = []
    for name, p, g in feats:
        hit = g.intersection(line)
        if hit.is_empty or hit.length < 0.05: continue
        parts = list(hit.geoms) if hasattr(hit, 'geoms') else [hit]
        for part in parts:
            if part.length < 0.05: continue
            d0, d1 = sorted((line.project(Point(part.coords[0])), line.project(Point(part.coords[-1]))))
            m = line.interpolate((d0 + d1) / 2)
            rows.append({'id': p['id'], 'file': name, 'kind': p.get('kind'), 'type': p.get('type'), 'from': round(d0, 2), 'to': round(d1, 2),
                         'bottomM': p.get('bottomM', p.get('fromM')), 'topM': round(top_at(p, m.x, m.y), 2), 'topAtFrom': round(top_at(p, *line.interpolate(d0).coords[0]), 2), 'topAtTo': round(top_at(p, *line.interpolate(d1).coords[0]), 2)})
    return sorted(rows, key=lambda r: (r['from'], r['topM']))

out = {}
for key, v in VIEWS.items():
    if 'section' not in v: continue
    rows = along([v['section']['a'], v['section']['b']]); out[key] = rows
    print('==', key, v['section']['a'], '->', v['section']['b'])
    for r in rows: print(f"  {r['from']:6.2f}–{r['to']:6.2f} m  {r['topAtFrom']:7.2f}→{r['topAtTo']:7.2f}  아래 {r['bottomM']}  {r['kind']}/{r['type']}  {r['id']}")
(HERE / 'section-numbers.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
