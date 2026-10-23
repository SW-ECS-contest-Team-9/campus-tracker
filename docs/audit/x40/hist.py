"""X40: 쐐기 화단 자리(사용자 파란 테두리)에 커밋마다 어떤 구조물이 있었는지(옛 커밋 60개). python hist.py"""
import json, subprocess
from shapely.geometry import shape, Polygon
R='C:/campus-tracker-claude'
b=json.load(open(R+'/docs/audit/x40/blue_marks.json',encoding='utf-8'))
ring=Polygon(b['ring_top']+b['ring_bottom'][::-1]).buffer(0)
print('ring area',round(ring.area,1), ring.bounds)
revs=subprocess.run(['git','-C',R,'log','--format=%h','-60','--','frontend/public/structures/'],capture_output=True,text=True).stdout.split()
prev=None
for rev in revs:
    files=subprocess.run(['git','-C',R,'ls-tree','--name-only',rev,'frontend/public/structures/'],capture_output=True,text=True).stdout.split()
    hits={}
    for fn in files:
        if not fn.endswith('.geojson'): continue
        d=json.loads(subprocess.run(['git','-C',R,'show',f'{rev}:{fn}'],capture_output=True).stdout.decode('utf-8'))
        for f in d['features']:
            if not f.get('geometry'): continue
            p=f['properties']
            g=shape(f['geometry']).buffer(0); a=g.intersection(ring).area
            if a>1 and p.get('kind')!='void' and not p.get('underground'): hits[p['id']]=(p.get('type'),round(a,1),p.get('toM') or p.get('topM'))
    key=json.dumps(hits,sort_keys=True,ensure_ascii=False)
    if key!=prev: print(rev, hits); prev=key
