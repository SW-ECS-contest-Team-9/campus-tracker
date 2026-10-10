"""B03 공용: S-MAP 격자(E05, 2026-10-10 화면 판독) 합치기, 학교 출입구 목록, 원천 외곽."""
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'e05'))
from grids import Grid, gpkg_buildings
from tm5186 import to5186

TERRAIN = 419430528
FIELD_M = 148.9  # E06: 운동장 바닥(측정)


def load_cells(e05):
    """{(x, y): (z, modelId, stepM)}; 1 m 격자가 2 m 격자를 덮어쓴다."""
    e05 = pathlib.Path(e05); cells = {}
    for f in ('south-2m', 'ne-2m', 'nw-2m', 'yudam-2m', 'cluster-1m', 'eunju-1m-a', 'eunju-1m-b', 'eunju-1m-c'):
        g = Grid(e05 / f'smap-mesh-{f}.txt')
        for x, y, z, i in g.cells(): cells[(x, y)] = (z, i, g.step)
    return cells


def entrances(backend):
    out = []
    for p in json.loads((pathlib.Path(backend) / 'data/terrain/source/skuniv_places.json').read_text(encoding='utf-8')):
        n = p['장소명']
        if '입구' in n and '주차장' not in n or '연결통로' in n or '버스정류장' in n and '본관' in n:
            x, y = to5186(float(p['경도']), float(p['위도']))
            out.append({'name': n, 'x': round(x, 1), 'y': round(y, 1), 'text': p.get('설명') or ''})
    return out


def outlines(backend):
    return {b['name']: b['geom'] for b in gpkg_buildings(pathlib.Path(backend) / 'data/scene/source/campus.gpkg')}
