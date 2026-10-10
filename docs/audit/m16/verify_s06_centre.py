"""저장된 S06 면의 원표본 재현·빈틈·중첩을 독립 도형 연산으로 검사."""
import json
import sys
from pathlib import Path
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[3]
base = ROOT / 'frontend/public/corrections'
surface_path = Path(sys.argv[2]) if len(sys.argv) > 2 else base/'s06-centre-surface-v2.geojson'
fc = json.loads(surface_path.read_text(encoding='utf-8'))
surfaces = [f for f in fc['features'] if f['properties']['kind'] == 'surface']
triangles = [shape(f['geometry']) for f in surfaces]
union = unary_union(triangles)
clip = shape(next(f['geometry'] for f in fc['features'] if f['properties']['kind'] == 'clip'))
assert all(t.is_valid for t in triangles) and clip.is_valid
assert union.symmetric_difference(clip).area < 1e-7
assert sum(t.area for t in triangles)-union.area < 1e-7
vertices = {tuple(p) for f in surfaces for p in f['geometry']['coordinates'][0]}
samples = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))['points']
assert all((p['x'],p['y'],json.loads(p['raw'])['result']['dem_z']) in vertices for p in samples)
buildings = json.loads((ROOT/'docs/audit/m16/preview/data/building-outlines-5186.json').read_text(encoding='utf-8'))
building_overlap = sum(union.intersection(Polygon(poly[0], poly[1:])).area
                       for b in buildings for poly in b['coordinates'])
overlaps = {}
for name in ('field-surfaces-v3.geojson', 'corridor-surface-v5.1.geojson'):
    other = json.loads((base/name).read_text(encoding='utf-8'))
    overlaps[name] = sum(union.intersection(shape(f['geometry'])).area for f in other['features']
                         if f['properties']['kind'] == 'surface')
assert building_overlap < 1e-7 and all(a < 1e-7 for a in overlaps.values())
print(json.dumps({'triangles':len(triangles), 'sourceSamplesReproduced':len(samples),
                  'areaM2':union.area, 'buildingOverlapM2':building_overlap,
                  'surfaceOverlapM2':overlaps, 'physicalAccuracyVerified':False}, indent=2))
