"""S06 R1/R5 ±1m 횡단 원응답 확보. 표본 간격은 실제 차도 폭이 아니다."""
import datetime
import hashlib
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
src = ROOT / 'docs/audit/m16/preview/data/candidates-5186.geojson'
points = next(f for f in json.loads(src.read_text(encoding='utf-8'))['features']
              if f['properties']['id'] == 'S06-C1')['geometry']['coordinates']
out = Path(sys.argv[1])
assert not out.exists(), '원응답을 덮어쓰지 않는다'
result = {'inputs': {str(src): hashlib.sha256(src.read_bytes()).hexdigest()},
          'note': 'R1/R5 ±1m 표본. 같은 S-MAP 계열, 독립 실측·실제 도로 폭·끝단 접속 미검증.', 'points': []}
for station, index, a, b in ((1, 0, points[0], points[1]), (5, 4, points[3], points[4])):
    dx, dy = b[0]-a[0], b[1]-a[1]
    length = math.hypot(dx, dy)
    nx, ny = -dy/length, dx/length
    for offset in (-1, 0, 1):
        x, y = points[index][0]+offset*nx, points[index][1]+offset*ny
        req = urllib.request.Request('https://smap.seoul.go.kr/measure/getMeasureElevation3d.do',
              data=urllib.parse.urlencode({'x': x, 'y': y}).encode(),
              headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://smap.seoul.go.kr/'})
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode('utf-8')
            row = {'station': station, 'offsetM': offset, 'x': x, 'y': y,
                   'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'status': response.status, 'raw': raw}
        result['points'].append(row)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        print(station, offset, json.loads(raw)['result']['dem_z'], flush=True)
        time.sleep(1.2)
