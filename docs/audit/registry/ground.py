"""아2 지표면: 노트 머리의 `지표면` -> frontend/public/structures/a2-ground-surfaces.geojson (재질 면과 경계석).

  python docs/audit/registry/ground.py write [--note <지표면 노트>] [--out <파일>]
  python docs/audit/registry/ground.py check [--note <지표면 노트>] [--out <파일>]

- write: 노트와 구조물 파일의 기단에서 면 파일을 다시 만든다. check: 다시 만든 글자와 파일이 다르면 종료 코드 1
  (노트가 바뀌었거나 기단·그 위 상자가 바뀌었으면 write 를 다시 돌린다). 면 파일은 손으로 고치지 않는다.
노트 양식(볼트 데이터/모델링 개선/지표면.md):
  지표면:
    기본값: {띄움_m, 경계석_폭_m, 경계석_높이_m, 경계석_높이차_한도_m}
    면:
      - {id, 이름, 재질: 타일|보도블록|무늬블록|아스팔트|데크|화단|흙, 기단: 기단 id, 외곽: [[x, y], ...](없어도 됨), 등급: 확정|원천|S-MAP|추정, 근거}
면 = 기단 외곽(∩ 외곽) − 그 기단 위에 선 상자(밑이 기단 윗면 + 1 m 아래이고 위가 기단 밑보다 높은 것: 화단·계단 단·벽·칠 띠·나무 줄기)
     − 겹친 자리에서 윗면이 더 높은 다른 기단 − 같은 기단에서 외곽을 가진 다른 면. 높이 = 기단 윗면 + 띄움(기운 기단이면 같은 기울기의 얇은 판).
경계석: 아스팔트 면의 테두리 가운데, 0.3 m 바깥이 같은 높이(± 한도)의 다른 걷는 면·기단인 곳에 아스팔트 쪽 안으로 폭 경계석_폭_m 의 판.
좌표 EPSG:5186 m. 표시 전용(등급 추정도 싣는다).
"""
import argparse, glob, json, math, pathlib, sys
import yaml
from shapely.geometry import LineString, Point, Polygon, mapping, shape
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = pathlib.Path(__file__).resolve().parents[3]
STRUCTURES = ROOT / 'frontend/public/structures'
OUT_NAME = 'a2-ground-surfaces.geojson'
DEFAULT_NOTE = r'C:\campus-tracker-backend\데이터\모델링 개선\지표면.md'
GENERATED = 'Generated from the ground note (지표면) by docs/audit/registry/ground.py (write); do not edit by hand.'
ABOUT = ('A2 ground surfaces: thin slabs of a surface material (tile, block, asphalt, ...) on top of a platform, and granite curbs '
         'where an asphalt face meets another walking surface at the same height. Display only; heights follow the platform top.')
MATERIALS = {'타일': ('tile', 'slab'), '보도블록': ('block', 'block'), '무늬블록': ('ring_block', 'rings'), '아스팔트': ('asphalt', None),
             '데크': ('timber', 'planks'), '화단': ('planting', None), '흙': ('soil', None)}
GRADES = ('확정', '원천', 'S-MAP', '추정')
DEFAULTS = {'띄움_m': 0.02, '경계석_폭_m': 0.2, '경계석_높이_m': 0.04, '경계석_높이차_한도_m': 0.15}
WALKABLE = {'tile', 'block', 'ring_block', 'paving', 'concrete', 'timber'}  # what a curb separates the asphalt from
STANDS_M = 1.0      # a box whose bottom is below platform top + this stands on it, is sunk into it or covers it closely (a step that starts above a sloping way)
PROBE_M = 0.3       # the neighbour of a boundary segment is read this far outside it
STEP_M = 1.0        # boundary segments are at most this long
MIN_AREA = 0.5
r3 = lambda v: round(float(v), 3)


def read_head(text):
    if not text.startswith('---'): return {}
    end = text.find('\n---', 3)
    return yaml.safe_load(text[3:end]) or {} if end > 0 else {}


def top_fn(p):
    """Height of a feature's top at a point: topM, or topProfile {origin, direction, points: [[distance, height], ...]}."""
    prof = p.get('topProfile')
    if not prof: return lambda x, y: float(p['topM'])
    (ox, oy), (dx, dy) = prof['origin'], prof['direction']
    n = math.hypot(dx, dy) or 1.0
    pts = sorted(prof['points'])
    def f(x, y):
        d = ((x - ox) * dx + (y - oy) * dy) / n
        if d <= pts[0][0]: return float(pts[0][1])
        for (d0, h0), (d1, h1) in zip(pts, pts[1:]):
            if d <= d1: return h0 + (h1 - h0) * (d - d0) / (d1 - d0) if d1 > d0 else float(h1)
        return float(pts[-1][1])
    return f


def load_structures(folder):
    """Platforms {id: {props, geom, top}} and the boxes [{geom, from, to}] of every structures file but our own."""
    platforms, boxes = {}, []
    for f in sorted(glob.glob(str(pathlib.Path(folder) / '*.geojson'))):
        if pathlib.Path(f).name == OUT_NAME: continue
        for ft in json.loads(pathlib.Path(f).read_text(encoding='utf-8')).get('features', []):
            p = ft.get('properties') or {}
            try: g = shape(ft['geometry']).buffer(0)
            except Exception: continue
            if g.is_empty: continue
            if p.get('kind') == 'platform':
                if 'topM' not in p and 'topProfile' not in p: continue
                platforms[str(p.get('id'))] = {'props': p, 'geom': g, 'prep': prep(g), 'top': top_fn(p), 'file': pathlib.Path(f).name}
            elif p.get('kind') != 'void' and p.get('type') != 'void' and not p.get('underground'):
                if p.get('topProfile') and p.get('thicknessM'):
                    t = top_fn(p); c = g.representative_point(); hi = t(c.x, c.y); lo = hi - float(p['thicknessM'])
                elif isinstance(p.get('fromM'), (int, float)) and isinstance(p.get('toM'), (int, float)):
                    lo, hi = float(p['fromM']), float(p['toM'])
                else: continue
                boxes.append({'geom': g, 'from': lo, 'to': hi})
    return platforms, boxes


def standing(platform, boxes, platforms=()):
    """The footprints (inside the platform) of the boxes that stand on it or are sunk into it, and of the other platforms
    that overlap it with a higher top there (the face would lie inside their mass)."""
    g, top, bottom = platform['geom'], platform['top'], float(platform['props'].get('bottomM', -1e9))
    out = []
    for o in platforms:
        if o is platform or not o['geom'].intersects(g): continue
        both = o['geom'].intersection(g)
        if both.area < 0.01: continue
        c = both.representative_point()
        if o['top'](c.x, c.y) > top(c.x, c.y) + 0.05: out.append(both)
    for b in boxes:
        if not b['geom'].intersects(g): continue
        c = b['geom'].representative_point()
        z = top(c.x, c.y)
        if b['from'] <= z + STANDS_M and b['to'] > bottom: out.append(b['geom'])
    return unary_union(out) if out else None


def clean(geom):
    geom = geom.buffer(0)
    parts = [p for p in getattr(geom, 'geoms', [geom]) if isinstance(p, Polygon) and p.area >= MIN_AREA]
    return unary_union(parts).simplify(0.01, preserve_topology=True) if parts else None


def heights(platform, lift, thickness):
    """fromM / toM of a flat platform, or a topProfile lifted by `lift` and a thicknessM."""
    p = platform['props']
    if p.get('topProfile'):
        prof = p['topProfile']
        return {'topProfile': {'origin': [r3(v) for v in prof['origin']], 'direction': [r3(v) for v in prof['direction']],
                               'points': [[r3(d), r3(h + lift)] for d, h in sorted(prof['points'])]}, 'thicknessM': r3(thickness)}
    t = float(p['topM'])
    return {'fromM': r3(t + lift - thickness), 'toM': r3(t + lift)}


def from_note(head, platforms, boxes):
    """(faces, curbs, problems): faces = [{id, name, material, pattern, grade, source, platform, geom}], curbs likewise."""
    spec = head.get('지표면') if isinstance(head.get('지표면'), dict) else {}
    d = {**DEFAULTS, **(spec.get('기본값') or {})}
    faces, problems, seen = [], [], set()
    for k, e in enumerate(spec.get('면') or []):
        fid = str(e.get('id') or f'#{k}')
        if fid in seen: problems.append(f'{fid}: id 가 겹친다'); continue
        seen.add(fid)
        if e.get('재질') not in MATERIALS: problems.append(f'{fid}: 재질 {e.get("재질")!r} 모름'); continue
        if e.get('등급') not in GRADES: problems.append(f'{fid}: 등급 {e.get("등급")!r} 은 {"/".join(GRADES)} 가운데 하나'); continue
        pl = platforms.get(str(e.get('기단')))
        if not pl: problems.append(f'{fid}: 기단 {e.get("기단")!r} 이 구조물 파일에 없다'); continue
        g = pl['geom']
        if e.get('외곽'):
            try: g = g.intersection(Polygon(e['외곽']).buffer(0))
            except Exception: problems.append(f'{fid}: 외곽이 다각형이 아니다'); continue
        faces.append({'id': fid, 'name': str(e.get('이름') or fid), 'ko': e['재질'], 'material': MATERIALS[e['재질']][0], 'pattern': MATERIALS[e['재질']][1],
                      'grade': e['등급'], 'source': str(e.get('근거') or ''), 'platform': str(e['기단']), 'own': bool(e.get('외곽')), 'geom': g})
    # boxes standing on the platform, and explicit outlines over whole-platform faces of the same platform
    held = {}
    for f in faces:
        if f['platform'] not in held: held[f['platform']] = standing(platforms[f['platform']], boxes, list(platforms.values()))
        cut = [held[f['platform']]] if held[f['platform']] is not None else []
        if not f['own']: cut += [o['geom'] for o in faces if o['own'] and o['platform'] == f['platform']]
        g = f['geom'].difference(unary_union(cut)) if cut else f['geom']
        f['geom'] = clean(g)
        if f['geom'] is None: problems.append(f"{f['id']}: 상자를 빼고 나니 남는 면이 없다")
    faces = [f for f in faces if f['geom'] is not None]
    for f in faces: f['prep'] = prep(f['geom'])
    curbs = []
    for f in faces:
        if f['material'] != 'asphalt': continue
        c = curb(f, faces, platforms, held, d)
        if c is not None:
            curbs.append({**f, 'id': f['id'] + '-CURB', 'name': f['name'] + ' 경계석', 'ko': '경계석', 'material': 'curb', 'pattern': None, 'geom': c})
            f['geom'] = clean(f['geom'].difference(c))
    return faces, curbs, problems, d


def neighbour(x, y, me, faces, platforms, held):
    """(material, height) of the walking surface at a point outside face `me`, or None."""
    pt = Point(x, y)
    for o in faces:
        if o is not me and o['prep'].contains(pt):
            return o['material'], platforms[o['platform']]['top'](x, y)
    for pid, pl in platforms.items():
        if not pl['prep'].contains(pt): continue
        if pid == me['platform'] or (held.get(pid) is not None and held[pid].contains(pt)): return None
        if any(o['platform'] == pid and not o['own'] for o in faces): return None  # its own face would have answered
        return pl['props'].get('material'), pl['top'](x, y)
    return None


def curb(face, faces, platforms, held, d):
    """Granite strip inside an asphalt face along the stretches of its outline that meet another walking surface at its height."""
    g, top, w = face['geom'], platforms[face['platform']]['top'], float(d['경계석_폭_m'])
    inside = prep(g)
    strips = []
    for poly in getattr(g, 'geoms', [g]):
        for ring in [poly.exterior, *poly.interiors]:
            pts = list(ring.coords)
            for a, b in zip(pts, pts[1:]):
                L = math.hypot(b[0] - a[0], b[1] - a[1])
                if L < 1e-6: continue
                n = max(1, math.ceil(L / STEP_M))
                ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
                for i in range(n):
                    p0 = (a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)
                    p1 = (a[0] + (b[0] - a[0]) * (i + 1) / n, a[1] + (b[1] - a[1]) * (i + 1) / n)
                    mx, my = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
                    # the normal that points out of the face (rings of holes run either way)
                    nx, ny = (uy, -ux) if not inside.contains(Point(mx + uy * 0.05, my - ux * 0.05)) else (-uy, ux)
                    nb = neighbour(mx + nx * PROBE_M, my + ny * PROBE_M, face, faces, platforms, held)
                    if not nb or nb[0] not in WALKABLE or abs(nb[1] - top(mx, my)) > float(d['경계석_높이차_한도_m']): continue
                    strips.append(Polygon([p0, p1, (p1[0] - nx * w, p1[1] - ny * w), (p0[0] - nx * w, p0[1] - ny * w)]))
    if not strips: return None
    return clean(unary_union(strips).intersection(g))


def rings(geom):
    out = []
    for poly in getattr(geom, 'geoms', [geom]):
        rs = [[[r3(x), r3(y)] for x, y in poly.exterior.coords]] + [[[r3(x), r3(y)] for x, y in i.coords] for i in poly.interiors]
        out.append(rs)
    return {'type': 'Polygon', 'coordinates': out[0]} if len(out) == 1 else {'type': 'MultiPolygon', 'coordinates': out}


def document(faces, curbs, platforms, d):
    feats = []
    for f in sorted(faces, key=lambda f: f['id']) + sorted(curbs, key=lambda f: f['id']):
        is_curb = f['material'] == 'curb'
        lift = float(d['띄움_m']) + (float(d['경계석_높이_m']) if is_curb else 0.0)
        h = heights(platforms[f['platform']], lift, lift)
        props = {'id': f['id'], 'kind': 'extrude', 'type': 'curb' if is_curb else 'surface', 'material': f['material'], 'name': f['name'],
                 'surface': f['ko'], 'basePlane': f['platform'], **h, 'grade': f['grade'], 'estimated': f['grade'] == '추정', 'source': f['source'],
                 'areaM2': round(f['geom'].area, 1)}
        if f.get('pattern'): props['pattern'] = f['pattern']
        feats.append({'type': 'Feature', 'properties': props, 'geometry': rings(f['geom'])})
    return {'type': 'FeatureCollection', 'name': 'a2-ground-surfaces', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
            'about': ABOUT, 'generated': GENERATED, 'features': feats}


def dumps(doc):
    return json.dumps(doc, ensure_ascii=False, indent=1) + '\n'


def summary(faces, curbs):
    by = {}
    for f in faces: by[f['ko']] = by.get(f['ko'], [0, 0.0]); by[f['ko']][0] += 1; by[f['ko']][1] += f['geom'].area
    line = ', '.join(f'{k} {n}개 {a:,.0f} ㎡' for k, (n, a) in sorted(by.items()))
    return f"{line}; 경계석 {len(curbs)}개 {sum(c['geom'].length / 2 for c in curbs):,.0f} m(둘레/2)"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('mode', choices=('check', 'write'))
    ap.add_argument('--note', default=DEFAULT_NOTE)
    ap.add_argument('--structures', default=str(STRUCTURES))
    ap.add_argument('--out', default=None)
    a = ap.parse_args(argv)
    note = pathlib.Path(a.note)
    if not note.is_file(): print(f'지표면 노트가 없다: {note}'); return 2
    out = pathlib.Path(a.out) if a.out else pathlib.Path(a.structures) / OUT_NAME
    platforms, boxes = load_structures(a.structures)
    faces, curbs, problems, d = from_note(read_head(note.read_text(encoding='utf-8')), platforms, boxes)
    for p in problems: print(f'[노트 문제] {p}')
    text = dumps(document(faces, curbs, platforms, d))
    if a.mode == 'write':
        if problems: print('노트에 문제가 있어 쓰지 않았다.'); return 1
        out.write_text(text, encoding='utf-8', newline='\n')
        print(f'썼다: {out} ({summary(faces, curbs)})'); return 0
    same = out.exists() and out.read_text(encoding='utf-8') == text
    print(f'노트 기준: {summary(faces, curbs)}')
    if not same: print(f'[불일치] {out.name} 이 노트·기단에서 만든 결과와 다르다. write 로 다시 만든다.')
    ok = same and not problems
    print('일치' if ok else '불일치: 노트가 맞다. 노트를 고친 뒤 write, 다시 check.')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
