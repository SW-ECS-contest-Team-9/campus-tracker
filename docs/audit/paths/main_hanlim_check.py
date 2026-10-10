"""영상 본관5F↔한림3F 제약과 보존 스냅샷의 지정/공간 대응 대조."""
import hashlib
import json
import sys
from pathlib import Path
from shapely.geometry import shape,LineString
import subprocess

ROOT=Path(__file__).resolve().parents[3]
base=ROOT/'docs/audit/m16/preview/data'
sp,rp=base/'scene-live.json',base/'roads-live-2.json'
scene=json.loads(sp.read_text(encoding='utf-8'))
roads=json.loads(rp.read_text(encoding='utf-8'))['items']
buildings={b['buildingId']:b for b in scene['buildings'] if b['buildingId'] in ('본관','한림관')}
code="import fs from 'node:fs'; import {tmForward} from "+json.dumps((ROOT/'backend/src/geo/tm.ts').as_uri())+"; const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(JSON.stringify(s.buildings.filter(b=>['본관','한림관'].includes(b.buildingId)).map(b=>({id:b.buildingId,geometry:{...b.geometry,coordinates:b.geometry.coordinates.map(poly=>poly.map(ring=>ring.map(([lon,lat])=>{const p=tmForward(lat,lon);return [p.x,p.y]})))}}))));"
projected=json.loads(subprocess.run(['node','--experimental-strip-types','--input-type=module','-e',code,str(sp)],
                                  check=True,capture_output=True,text=True,encoding='utf-8').stdout)
footprints={b['id']:shape(b['geometry']) for b in projected}
rows=[]
for r in roads:
    line=LineString([p[:2] for p in r['coordinates']])
    lengths={k:line.intersection(poly).length for k,poly in footprints.items()}
    if any(v>0 for v in lengths.values()) or r.get('buildingId') in buildings:
        rows.append({'road':r['id'],'buildingId':r.get('buildingId'),'levelId':r.get('levelId'),
                     'structure':r['structure'],'footprintIntersectionLengthM':lengths,
                     'fromNode':r['fromNodeId'],'toNode':r['toNodeId'],
                     'zRangeM':[min(p[2] for p in r['coordinates']),max(p[2] for p in r['coordinates'])]})
result={'sourceConstraint':'SKUCAST 00:28–00:33 본관5층↔한림관3층 연결 안내',
        'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in (sp,rp)},
        'snapshotScene':{'importedAt':scene['importedAt'],'terrainVersionId':scene['terrainVersionId']},
        'buildings':{k:{'baseM':b['baseM'],'note':b['note']} for k,b in buildings.items()},
        'matchingRoads':rows,'physicalConnectionVerified':False,'operationalChanges':False,
        'note':'평면 교차는 해당 건물/층 소속이나 실내 연결 증명이 아니다. 스냅샷 범위이며 현재 운영 전체 부재 단정 금지. 층번호를 고도 환산하지 않음.'}
Path(sys.argv[1]).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('matching roads',len(rows))
print('roads intersecting both footprints',sum(all(v>0 for v in r['footprintIntersectionLengthM'].values()) for r in rows))
print('assigned main/hanlim roads',sum(r['buildingId'] in buildings for r in rows))
