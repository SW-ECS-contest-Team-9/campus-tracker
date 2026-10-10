"""S06 표본 외곽의 DEM 대조. 자료 차이를 물리 단차로 해석하지 않는다."""
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT/'docs/audit/m16/preview/data'
source = Path(sys.argv[1])
samples = json.loads(source.read_text(encoding='utf-8'))['points']
meta = json.loads((BASE/'terrain-grid-meta.json').read_text())
raw = (BASE/'terrain-grid.f32').read_bytes()
grid = struct.unpack('<%df' % (meta['width']*meta['height']),raw)
def dem(x,y):
    x = (x-meta['originX'])/meta['resolution']-.5
    y = (y-meta['originY'])/meta['resolution']-.5
    i,j = math.floor(x),math.floor(y)
    assert 0 <= i < meta['width']-1 and 0 <= j < meta['height']-1
    tx,ty,w = x-i,y-j,meta['width']
    return (grid[j*w+i]*(1-tx)*(1-ty)+grid[j*w+i+1]*tx*(1-ty)
            +grid[(j+1)*w+i]*(1-tx)*ty+grid[(j+1)*w+i+1]*tx*ty)
sections = []
for station in (2,3,4):
    row = sorted((p for p in samples if p['station']==station),key=lambda p:p['offsetM'])
    a,c,b = row
    nx,ny = (b['x']-a['x'])/2,(b['y']-a['y'])/2
    points = []
    for offset in (-3,-2,-1,0,1,2,3):
        x,y = c['x']+nx*offset,c['y']+ny*offset
        p = next((p for p in row if p['offsetM']==offset),None)
        z = json.loads(p['raw'])['result']['dem_z'] if p else None
        dz = dem(x,y)
        points.append({'offsetM':offset,'x':x,'y':y,'demM':dz,
                       'smapM':z,'smapMinusDemM':None if z is None else z-dz})
    sections.append({'station':station,'points':points})
result = {'note':'外곽±1m는 표본 간격. ±2/3m는 DEM 대조점만이며 차도 경계/실물 단차/보도 높이 아님. 바깥 S-MAP 높이를 외삽하지 않음.',
          'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in
                    (source,BASE/'terrain-grid.f32',BASE/'terrain-grid-meta.json')},
          'sections':sections,'operationalChanges':False}
Path(sys.argv[2]).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for s in sections:
    print('R%d:' % s['station'], ', '.join('%+dm %.3fm' % (p['offsetM'],p['smapMinusDemM'])
          for p in s['points'] if p['smapM'] is not None))
