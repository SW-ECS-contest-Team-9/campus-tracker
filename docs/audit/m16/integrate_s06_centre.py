"""S-MAP 횡단 표본 사이만 삼각화하는 검토용 중심부 면. 운영 DEM 불변."""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
source = Path(sys.argv[1])
raw = source.read_bytes()
samples = json.loads(raw)['points']
points = {}
for p in samples:
    assert p['status'] == 200
    z = json.loads(p['raw'])['result']['dem_z']
    points[p['station'], p['offsetM']] = [p['x'], p['y'], z]
assert set(points) == {(s, o) for s in (2, 3, 4) for o in (-1, 0, 1)}
note = '±1m는 표본 간격이며 실제 차도 폭/경계가 아니다. 표본 사이 선형 보간, 실측·물리 접속 미검증. 옆 보도·계단으로 확장하지 않음.'
features = []
def feature(id, kind, ring):
    features.append({'type': 'Feature', 'properties': {
        'id': id, 'kind': kind, 'type': 'corridor_tin',
        'source': 'https://smap.seoul.go.kr/measure/getMeasureElevation3d.do',
        'estimated': True, 'accuracyVerified': False, 'assumption': note,
    }, 'geometry': {'type': 'Polygon', 'coordinates': [ring + [ring[0]]]}})
for s in (2, 3):
    for o in (-1, 0):
        a, b, c, d = [points[k] for k in ((s,o), (s+1,o), (s+1,o+1), (s,o+1))]
        feature(f'S06-CENTRE-{s}-{o}-A', 'surface', [a,b,c])
        feature(f'S06-CENTRE-{s}-{o}-B', 'surface', [a,c,d])
boundary = [points[s,-1][:2] for s in (2,3,4)] + [points[s,1][:2] for s in (4,3,2)]
feature('S06-CENTRE-CLIP', 'clip', boundary)
out = ROOT / 'frontend/public/corrections/s06-centre-surface-v1.geojson'
out.write_text(json.dumps({'type': 'FeatureCollection', 'provenance': {
    'source': str(source), 'sha256': hashlib.sha256(raw).hexdigest(),
    'operationalChanges': False, 'assumption': note,
}, 'features': features}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(out)
