"""R1–R2 내부 원표본과 양끝 선형 보간 비교. 같은 원천의 형상 대조."""
import hashlib
import json
import math
import sys
from pathlib import Path

folder = Path(sys.argv[1])
paths = [folder / name for name in ('s06-end-cross-sections-raw-20261010.json',
         's06-cross-sections-raw-20261010.json', 's06-lower-interior-raw-20261010.json')]
samples = [p for path in paths for p in json.loads(path.read_text(encoding='utf-8'))['points']]
points = {(p['station'], p['offsetM']): p for p in samples}
stations = (1, 1.25, 1.5, 1.75, 2)
assert all((s, o) in points for s in stations for o in (-1, 0, 1))
def z(s, o=0):
    p = points[s, o]
    assert p['status'] == 200
    return json.loads(p['raw'])['result']['dem_z']
rows = [{'station': s, 'centreM': z(s), 'linearFromEndsM': z(1)+(s-1)*(z(2)-z(1)),
         'centreMinusLinearM': z(s)-(z(1)+(s-1)*(z(2)-z(1))),
         'transverseRangeM': max(z(s,o) for o in (-1,0,1))-min(z(s,o) for o in (-1,0,1))} for s in stations]
segments = []
for a, b in zip(stations, stations[1:]):
    p, q = points[a,0], points[b,0]
    length = math.hypot(q['x']-p['x'], q['y']-p['y'])
    segments.append({'fromStation': a, 'toStation': b, 'distanceM': length,
                     'riseM': z(b)-z(a), 'gradePercent': 100*(z(b)-z(a))/length})
result = {'inputs': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
          'stations': rows, 'segments': segments, 'physicalAccuracyVerified': False,
          'note': '표본별 차이는 저장 원천 형상 비교이며 실측 오차가 아니다. 실물 보도/계단/끝단 접속 검증과 구분한다.'}
(folder/'s06-lower-profile-check-codex.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'stations':rows,'segments':segments}))
