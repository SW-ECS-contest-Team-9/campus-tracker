"""S06 차도·S07 지상 문턱의 기존 자료 비교 표시. 운영 경로는 변경하지 않는다."""
import hashlib
import json
import struct
from pathlib import Path
import math

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/audit/m16/preview/data'
source = BASE / 'candidates-5186.geojson'
raw = source.read_bytes()
candidates = json.loads(raw)['features']
roads = json.loads((BASE / 'roads-live-2.json').read_text(encoding='utf-8'))['items']
meta = json.loads((BASE / 'terrain-grid-meta.json').read_text())
data = (BASE / 'terrain-grid.f32').read_bytes()
grid = struct.unpack('<%df' % (meta['width'] * meta['height']), data)

def dem(p):
    x = (p[0] - meta['originX']) / meta['resolution'] - .5
    y = (p[1] - meta['originY']) / meta['resolution'] - .5
    i, j = math.floor(x), math.floor(y)
    tx, ty, w = x-i, y-j, meta['width']
    return (grid[j*w+i]*(1-tx)*(1-ty) + grid[j*w+i+1]*tx*(1-ty)
            + grid[(j+1)*w+i]*(1-tx)*ty + grid[(j+1)*w+i+1]*tx*ty)

features = []
def line(id, coords, type, source, note):
    features.append({'type': 'Feature', 'properties': {
        'id': id, 'kind': 'line', 'type': type, 'source': source,
        'estimated': True, 'accuracyVerified': False,
        'assumption': note, 'status': '비교용·물리 접속 미검증',
    }, 'geometry': {'type': 'LineString', 'coordinates': coords}})

for id in ['S06-C1', 'S07-C1']:
    f = next(f for f in candidates if f['properties']['id'] == id)
    line('ACCESS-'+id, f['geometry']['coordinates'], 'path_unverified',
         str(source), f['properties']['note'])
s06 = next(f for f in candidates if f['properties']['id'] == 'S06-C1')
line('ACCESS-S06-DEM', [[p[0], p[1], dem(p)] for p in s06['geometry']['coordinates']],
     'surface_operational_only', str(BASE / 'terrain-grid.f32'),
     '동일 XY의 2015 DEM 표본 비교선. 표본 사이 직선은 지형 단면이나 보행로 확정이 아니다.')
for prefix in ['1d983e3a', '699d0cbc', 'ccdf841c']:
    road = next(r for r in roads if r['id'].startswith(prefix))
    line('ACCESS-S07-'+prefix, road['coordinates'], 'path_drawn_only',
         str(BASE / 'roads-live-2.json'),
         '입구 인근 기존 DRAFT '+road['structure']+' 비교. 같은 표면·입구 접속 근거 없음.')
result = {'type': 'FeatureCollection', 'provenance': {
    'source': str(source), 'sha256': hashlib.sha256(raw).hexdigest(),
    'inputs': {n: hashlib.sha256((BASE/n).read_bytes()).hexdigest() for n in
               ['roads-live-2.json', 'terrain-grid.f32', 'terrain-grid-meta.json']},
    'operationalChanges': False,
}, 'features': features}
out = ROOT / 'frontend/public/corrections/access-comparison-v1.geojson'
out.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(f'{len(features)} comparison lines: {out}')
