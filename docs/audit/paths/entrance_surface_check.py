"""출입부 후보의 같은 XY 보정면과 근접 DRAFT 길 대조. 물리 연결 확정 아님."""
import hashlib
import json
import math
import sys
from pathlib import Path
from shapely.geometry import Point, shape
import numpy as np

ROOT=Path(__file__).resolve().parents[3]
src=Path(sys.argv[1]); graph=json.loads(src.read_text(encoding='utf-8'))
rp=ROOT/'docs/audit/m16/preview/data/roads-live-2.json'
roads=json.loads(rp.read_text(encoding='utf-8'))['items']
files=[ROOT/'frontend/public/corrections'/n for n in
       ('field-surfaces-v3.geojson','corridor-surface-v5.1.geojson','s06-centre-surface-v1.geojson')]
surfaces=[]
for p in files:
    for f in json.loads(p.read_text(encoding='utf-8'))['features']:
        if f['properties']['kind']!='surface':
            continue
        polygons=[f['geometry']['coordinates']] if f['geometry']['type']=='Polygon' else f['geometry']['coordinates']
        for poly in polygons:
            surfaces.append((p.name,{**f,'geometry':{'type':'Polygon','coordinates':poly}}))
def surface_at(xy):
    hits=[]
    for name,f in surfaces:
        if not shape(f['geometry']).covers(Point(xy)):
            continue
        ring=f['geometry']['coordinates'][0][:-1]
        # 이번 검사에서 높이평면을 정할 수 있는 삼각형 또는 수평면만 사용.
        if len(ring)==3:
            a=np.array([[p[0]-xy[0],p[1]-xy[1],1] for p in ring])
            z=float(np.linalg.solve(a,np.array([p[2] for p in ring]))[2])
        elif max(p[2] for p in ring)-min(p[2] for p in ring)<1e-9:
            z=ring[0][2]
        else:
            hits.append({'file':name,'id':f['properties']['id'],'zM':None,'note':'비평면 다각형: 단일평면 높이 미계산'})
            continue
        hits.append({'file':name,'id':f['properties']['id'],'zM':z,
                     'walkable':f['properties'].get('walkable'),
                     'label':f['properties'].get('label'),
                     'usableAsGround':False if f['properties'].get('walkable') is False else None})
    return hits
result=[]
for label,e in graph['entrances'].items():
    xy=e['xy']; nearest=[]
    for r in roads:
        best=None
        for a,b in zip(r['coordinates'],r['coordinates'][1:]):
            dx,dy=b[0]-a[0],b[1]-a[1]; l2=dx*dx+dy*dy
            t=max(0,min(1,((xy[0]-a[0])*dx+(xy[1]-a[1])*dy)/l2)) if l2 else 0
            q=[a[i]+t*(b[i]-a[i]) for i in range(3)]
            d=math.dist(xy,q[:2])
            if best is None or d<best['distanceM']:
                best={'road':r['id'],'structure':r['structure'],'distanceM':d,'projectedXYZ':q,
                      'surfaceAtProjectedXY':surface_at(q[:2])}
        if best and best['distanceM']<=10:
            nearest.append(best)
    result.append({'label':label,'xy':xy,'doorStatus':e['door'],'surfaceAtEntranceXY':surface_at(xy),
                   'nearbyDraftRoads':sorted(nearest,key=lambda p:p['distanceM']),
                   'physicalConnectionVerified':False})
out={'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [src,rp]+files},
     'note':'同XY 높이 대응만. XY근접과그래프공유노드는 실제문/바닥접속증명이 아니다. 운영변경없음.',
     'entrances':result}
Path(sys.argv[2]).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for e in result:
    print(e['label'], 'surface',e['surfaceAtEntranceXY'],'nearby roads',len(e['nearbyDraftRoads']))
