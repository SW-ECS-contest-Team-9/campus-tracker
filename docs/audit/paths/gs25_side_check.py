"""GS25 옆길 후보 평면의 북악관 교차와 중간 꺾임 검사. 실물 위치 확정 아님."""
import hashlib
import json
import math
import sys
from pathlib import Path
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[3]
src, output = map(Path, sys.argv[1:3])
bp = ROOT / 'docs/audit/m16/preview/data/building-outlines-5186.json'
graph = json.loads(src.read_text(encoding='utf-8'))
road = next(o for o in graph['ops'] if o.get('id') == 'C2-R-SIDE')
building = next(b for b in json.loads(bp.read_text(encoding='utf-8')) if b['name'] == '북악관')
footprint = unary_union([Polygon(poly[0], poly[1:]) for poly in building['coordinates']])
xy = road['xy']
line = LineString(xy)
segments = []
for a, b in zip(xy, xy[1:]):
    segment = LineString([a, b])
    segments.append({'fromXY': a, 'toXY': b, 'lengthM': segment.length,
                     'bearingDegreesFromNorth': math.degrees(math.atan2(b[0]-a[0], b[1]-a[1])) % 360,
                     'footprintIntersectionLengthM': segment.intersection(footprint).length})
bearing_change = abs((segments[1]['bearingDegreesFromNorth'] - segments[0]['bearingDegreesFromNorth'] + 180) % 360 - 180)
result = {'inputs': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [src, bp]},
          'road': road, 'segments': segments, 'lengthM': line.length,
          'directEndpointDistanceM': math.dist(xy[0], xy[-1]),
          'middleTurnDegrees': bearing_change,
          'footprintIntersectionLengthM': line.intersection(footprint).length,
          'nodeFootprintDistancesM': [footprint.distance(Point(p)) for p in xy],
          'physicalConnectionVerified': False, 'operationalChanges': False,
          'note': '평면 외부 여부는 실제 보도/문 위치 증명 아님. z 미확정. 꺾임은 후보선 검토 항목이며 사진만으로 삭제하거나 직선화하지 않는다.'}
output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print('length/direct', line.length, result['directEndpointDistanceM'])
print('turn', bearing_change, 'footprint intersection', result['footprintIntersectionLengthM'])
print('node footprint distances', result['nodeFootprintDistancesM'])
