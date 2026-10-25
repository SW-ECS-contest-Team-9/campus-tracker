"""지형 surface 입력: 구조물 파일의 기단 -> backend/data/terrain/recipes/platforms-surface.geojson (지형 조리법의 surface 단계).

  python docs/audit/registry/terrain_surface.py write [--structures <폴더>] [--out <파일>]
  python docs/audit/registry/terrain_surface.py check [--structures <폴더>] [--out <파일>]

- write: frontend/public/structures/*.geojson 의 기단(kind: platform)에서 surface 파일을 다시 만든다. check: 다시 만든 글자와
  파일이 다르면 종료 코드 1(기단이 바뀌었으면 write, 이어서 deploy:manifest). surface 파일은 손으로 고치지 않는다.
- 어느 기단이 지형에 실리나: surfaceName 이 이름(영문·숫자·-)인 기단(형식 docs/audit/g02/STRUCTURES.md). surfaceName 이 없거나
  설명이면(`없음(…)`, `field (f05-plateaus.geojson)`, 건물 옥상에 얹은 Y01 마당처럼) 싣지 않는다. 땅 밑 기단(underground)도 싣지 않는다.
- 겹친 자리: 한 기단이 다른 기단 안에 들어 있으면(겹친 넓이가 제 넓이의 90 % 이상) 안에 든 기단이 그 자리를 갖는다
  (낮은 마당·계단 자리). 그 밖의 겹침(벽면에서 이웃 밑으로 0.5 m 넣은 띠 등)은 그 자리에서 윗면이 높은 기단이 갖는다.
  그래서 출력 다각형은 서로 겹치지 않고(같은 높이 겹침만 남음) 순서와 상관없다. 건물 칸은 조리법의 protectBuildings 가 지킨다.
- 높이: 기단 topM -> heightM, topProfile -> profile(같은 정의, backend/src/geo/terrain-surface.ts).
좌표 EPSG:5186 m.
"""
import argparse, glob, json, pathlib, re, sys
import shapely
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import unary_union

from ground import top_fn

ROOT = pathlib.Path(__file__).resolve().parents[3]
STRUCTURES = ROOT / 'frontend/public/structures'
OUT = ROOT / 'backend/data/terrain/recipes/platforms-surface.geojson'
SKIP_FILES = {'a2-ground-surfaces.geojson'}   # 지표면 판(기단에서 나온 표시용)
NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]*$')
NESTED = 0.9        # 겹친 넓이가 제 넓이의 이 몫 이상이면 "안에 든" 기단
HIGHER_M = 0.05     # 이만큼 넘게 높아야 높은 쪽
MIN_AREA = 0.5
ABOUT = ('Terrain surface patches generated from the platforms (kind: platform) of frontend/public/structures/*.geojson by '
         'docs/audit/registry/terrain_surface.py (write); do not edit by hand. Patches do not overlap except at equal heights.')


def load_platforms(folder):
    out = []
    for f in sorted(glob.glob(str(pathlib.Path(folder) / '*.geojson'))):
        fn = pathlib.Path(f).name
        if fn in SKIP_FILES: continue
        for ft in json.loads(pathlib.Path(f).read_text(encoding='utf-8')).get('features', []):
            p = ft.get('properties') or {}
            if p.get('kind') != 'platform' or p.get('underground'): continue
            if 'topM' not in p and 'topProfile' not in p: continue
            sn = p.get('surfaceName')
            if not NAME.match(str(sn or '')): continue   # 지형 칸이 없는 기단
            g = shape(ft['geometry']).buffer(0)
            if g.is_empty: continue
            out.append({'id': str(p['id']), 'name': str(sn), 'file': fn, 'geom': g, 'top': top_fn(p),
                        'height': {'profile': p['topProfile']} if p.get('topProfile') else {'heightM': float(p['topM'])}})
    return out


def owned(a, platforms):
    """a 의 외곽에서 다른 기단이 갖는 자리를 뺀 것."""
    g, cut = a['geom'], []
    for b in platforms:
        if b is a or not b['geom'].intersects(g): continue
        both = b['geom'].intersection(g)
        if both.area < 0.01: continue
        b_in_a, a_in_b = both.area >= NESTED * b['geom'].area, both.area >= NESTED * g.area
        if b_in_a and not a_in_b: cut.append(both); continue
        if a_in_b and not b_in_a: continue
        c = both.representative_point()
        if b['top'](c.x, c.y) > a['top'](c.x, c.y) + HIGHER_M: cut.append(both)
    return g.difference(unary_union(cut)) if cut else g


def pieces(g):
    g = shapely.set_precision(g.buffer(0), 0.001)
    return sorted((p for p in getattr(g, 'geoms', [g]) if isinstance(p, Polygon) and p.area >= MIN_AREA), key=lambda p: -p.area)


def document(platforms):
    feats = []
    for a in platforms:
        for k, p in enumerate(pieces(owned(a, platforms))):
            props = {'name': a['name'] + ('' if k == 0 else f'#{k + 1}'), 'srid': 5186, 'reason': f"기단 {a['id']} 윗면({a['file']})", 'platform': a['id'], **a['height']}
            feats.append({'type': 'Feature', 'properties': props, 'geometry': mapping(shapely.geometry.polygon.orient(p))})
    return {'type': 'FeatureCollection', 'name': 'platforms-surface', 'about': ABOUT,
            'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': feats}


def dumps(doc):
    return json.dumps(doc, ensure_ascii=False, indent=1) + '\n'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('mode', choices=('check', 'write'))
    ap.add_argument('--structures', default=str(STRUCTURES))
    ap.add_argument('--out', default=str(OUT))
    a = ap.parse_args(argv)
    out = pathlib.Path(a.out)
    plats = load_platforms(a.structures)
    doc = document(plats); text = dumps(doc)
    line = f"기단 {len(plats)}개 -> 조각 {len(doc['features'])}개, {sum(shape(f['geometry']).area for f in doc['features']):,.0f} ㎡"
    if a.mode == 'write':
        out.write_text(text, encoding='utf-8', newline='\n')
        print(f'썼다: {out} ({line})'); return 0
    same = out.exists() and out.read_text(encoding='utf-8') == text
    print(f'기단 기준: {line}')
    print('일치' if same else f'[불일치] {out.name} 이 기단에서 만든 결과와 다르다. write 로 다시 만들고 deploy:manifest 를 다시 돌린다.')
    return 0 if same else 1


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
