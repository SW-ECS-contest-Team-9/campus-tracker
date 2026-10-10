"""확보된 S06 24표본으로 좁은 연장 검토면 생성. 앱 등록은 별도 검증 후."""
import hashlib
import json
import sys
from pathlib import Path

folder = Path(sys.argv[1])
paths = [folder / n for n in ('s06-cross-sections-raw-20261010.json',
         's06-end-cross-sections-raw-20261010.json', 's06-lower-interior-raw-20261010.json')]
samples = [p for path in paths for p in json.loads(path.read_text(encoding='utf-8'))['points']]
stations = (1, 1.25, 1.5, 1.75, 2, 3, 4, 5)
points = {(p['station'],p['offsetM']): [p['x'],p['y'],json.loads(p['raw'])['result']['dem_z']] for p in samples}
assert len(samples) == len(points) == 24
assert all(p['status'] == 200 for p in samples)
assert set(points) == {(s,o) for s in stations for o in (-1,0,1)}
note = '±1m 표본 사이 선형 보간. 실제 차도 폭/보도/계단/끝단 접속 미검증. 실측 정확도 확인 아님.'
features = []
def feature(id,kind,ring):
    features.append({'type':'Feature','properties':{'id':id,'kind':kind,'type':'corridor_tin',
        'source':'https://smap.seoul.go.kr/measure/getMeasureElevation3d.do',
        'estimated':True,'accuracyVerified':False,'assumption':note},
        'geometry':{'type':'Polygon','coordinates':[ring+[ring[0]]]}})
for s,t in zip(stations,stations[1:]):
    for o in (-1,0):
        a,b,c,d = [points[k] for k in ((s,o),(t,o),(t,o+1),(s,o+1))]
        feature(f'S06-CENTRE-{s}-{o}-A','surface',[a,b,c])
        feature(f'S06-CENTRE-{s}-{o}-B','surface',[a,c,d])
ring = [points[s,-1][:2] for s in stations]+[points[s,1][:2] for s in reversed(stations)]
feature('S06-CENTRE-CLIP','clip',ring)
inputs = {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
(folder/'s06-extended-samples.json').write_text(json.dumps({'inputs':inputs,'points':samples},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
output = Path(sys.argv[2]) if len(sys.argv) > 2 else folder/'s06-centre-surface-v2-candidate.geojson'
combined = folder/'s06-extended-samples.json'
output.write_text(json.dumps({'type':'FeatureCollection','provenance':{
    'source':str(combined),'sha256':hashlib.sha256(combined.read_bytes()).hexdigest(),
    'inputs':inputs,'operationalChanges':False,'assumption':note,'status':'연장 검토 후보, 실측 정확도·실물 접속 미검증'},
    'features':features},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(output, 'triangles',len(features)-1)
