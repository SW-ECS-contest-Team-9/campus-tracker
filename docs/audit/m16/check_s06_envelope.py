"""21개 횡단 표본 외곽면의 정확한 평면 교차 검사. 실물 경계는 미확정."""
import hashlib
import json
import sys
from pathlib import Path
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[3]
paths = [Path(p) for p in sys.argv[1:3]]
samples = sum([json.loads(p.read_text(encoding='utf-8'))['points'] for p in paths],[])
points = {(p['station'],p['offsetM']):p for p in samples}
assert len(points)==21
ring = [[points[s,o]['x'],points[s,o]['y']] for s,o in
        [(2,-3),(3,-3),(4,-3),(4,3),(3,3),(2,3)]]
envelope = Polygon(ring)
assert envelope.is_valid
outline = ROOT/'docs/audit/m16/preview/data/building-outlines-5186.json'
buildings = json.loads(outline.read_text(encoding='utf-8'))
building_union = unary_union([Polygon(poly[0],poly[1:]) for b in buildings for poly in b['coordinates']])
checks = {'buildingOverlapM2':envelope.intersection(building_union).area,
          'nearestBuildingDistanceM':envelope.distance(building_union)}
correction_paths = [ROOT/'frontend/public/corrections'/n for n in
                    ('field-surfaces-v3.geojson','corridor-surface-v5.1.geojson')]
for p in correction_paths:
    fc=json.loads(p.read_text(encoding='utf-8'))
    surfaces=unary_union([shape(f['geometry']) for f in fc['features'] if f['properties']['kind']=='surface'])
    checks[p.name]=envelope.intersection(surfaces).area
out={'type':'FeatureCollection','provenance':{'source':'S06 횡단 공개 표고 표본 외곽',
     'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths+[outline]+correction_paths},
     'operationalChanges':False},'checks':checks,'areaM2':envelope.area,
     'features':[{'type':'Feature','properties':{'id':'S06-OUTER-SAMPLE-ENVELOPE',
     'estimated':True,'accuracyVerified':False,'assumption':'±3m 표본 외곽이며 실제 차도 경계/폭 아님. 앱 미등록.'},
     'geometry':{'type':'Polygon','coordinates':[ring+[ring[0]]]}}]}
Path(sys.argv[3]).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'areaM2':envelope.area,**checks},indent=2))
