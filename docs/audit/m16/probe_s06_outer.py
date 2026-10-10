"""공개 S-MAP 표고 횡단 대조. 인증 없이 읽기 전용, 응답 원문 보존."""
import datetime
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

source = Path(sys.argv[1])
sections = json.loads(source.read_text(encoding='utf-8'))['sections']
out = Path(sys.argv[2])
result = {'note':'±2/3m 횡단 대조점, 실제 차도 경계/폭 미확정. 같은 S-MAP 계열이며 독립 실측 아님.', 'points':[]}
for s in sections:
    for p in s['points']:
        if abs(p['offsetM']) not in (2,3):
            continue
        request = urllib.request.Request('https://smap.seoul.go.kr/measure/getMeasureElevation3d.do',
            data=urllib.parse.urlencode({'x':p['x'],'y':p['y']}).encode(),
            headers={'User-Agent':'Mozilla/5.0','Referer':'https://smap.seoul.go.kr/'})
        with urllib.request.urlopen(request,timeout=30) as response:
            raw = response.read().decode('utf-8')
            row = {'station':s['station'],'offsetM':p['offsetM'],'x':p['x'],'y':p['y'],
                   'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'status':response.status,'raw':raw,'demM':p['demM']}
        result['points'].append(row)
        out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        z = json.loads(raw)['result']['dem_z']
        print('R%d %+dm S-MAP %.4f DEM %.4f delta %.4f' %
              (s['station'],p['offsetM'],z,p['demM'],z-p['demM']),flush=True)
        time.sleep(1.2)
