"""후보 노드의 표면 출처와 청운관 추정 슬래브 대응 검사. 운영값 변경 없음."""
import hashlib
import json
import sys
from pathlib import Path
from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parents[3]
src, output = map(Path, sys.argv[1:3])
files = [ROOT / 'frontend/public/corrections' / name for name in
         ('field-surfaces-v3.geojson', 'cheongun-split-v1.geojson')]
features = [f for p in files for f in json.loads(p.read_text(encoding='utf-8'))['features']]
field = next(f for f in features if f['properties']['id'] == 'SF-FIELD')
field_shape = shape(field['geometry'])
slabs = [f for f in features if f['properties'].get('type') == 'open_slab']
body = next(f for f in features if f['properties']['id'] == 'CHEONGUN-BODY')
rows = []
for node in json.loads(src.read_text(encoding='utf-8'))['candidate_nodes_z']:
    point = Point(node['xy'])
    row = {**node, 'fieldContainsXY': field_shape.covers(point),
           'fieldDistanceM': field_shape.distance(point),
           'physicalConnectionVerified': False}
    if node['node'].startswith(('C1-N-A2', 'C1-N-A3', 'C1-N-A5')):
        row['insideEstimatedBodyXY'] = shape(body['geometry']).covers(point)
        row['estimatedSlabs'] = [
            {'id': f['properties']['id'], 'containsXY': shape(f['geometry']).covers(point),
             'distanceM': shape(f['geometry']).distance(point),
             'topM': f['properties']['toM'],
             'topMinusCandidateM': None if node['z_cand'] is None else f['properties']['toM'] - node['z_cand'],
             'heightBasis': f['properties']['assumption']}
            for f in slabs]
    rows.append(row)
result = {'inputs': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [src, *files]},
          'note': 'XY 포함은 바닥 접속 증명이 아님. 추정 슬래브는 실측 층고가 아니며 문턱 높이로 사용하지 않는다.',
          'nodes': rows}
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
for row in rows:
    if 'SF-FIELD' in row['z_src'] or 'estimatedSlabs' in row:
        print(row['node'], 'field', row['fieldContainsXY'], round(row['fieldDistanceM'], 4),
              'slabXY', [(s['id'], s['containsXY'], round(s['distanceM'], 4)) for s in row.get('estimatedSlabs', [])])
