"""R01: 만든 입력을 직전 커밋(HEAD)과 견준다(읽기만).   python docs/audit/r01/diff_inputs.py
구조물 파일의 피처(id 별)와 지형 조리법 surface 피처(name 별)에서 달라진 것만 적는다. 표본 파일은 같아야 한다."""
import json, subprocess, sys, pathlib
from shapely.geometry import shape
REPO = pathlib.Path(__file__).parents[3]
def head(p): return json.loads(subprocess.run(['git', 'show', 'HEAD:' + p], cwd=REPO, capture_output=True).stdout.decode('utf-8'))
def cur(p): return json.loads((REPO / p).read_text(encoding='utf-8'))
files = sys.argv[1:] or sorted(p.relative_to(REPO).as_posix() for p in (REPO / 'frontend/public/structures').glob('*.geojson')) + ['backend/data/terrain/recipes/z05-surface.geojson']
for p in files:
    try: a = head(p)
    except Exception: print(p, '새 파일'); continue
    b = cur(p); key = lambda f: f['properties'].get('id') or f['properties'].get('name')
    A = {key(f): f for f in a['features']}; B = {key(f): f for f in b['features']}; out = []
    for k in sorted(set(A) | set(B)):
        if k not in A: out.append(f'  + {k} {[round(v, 1) for v in shape(B[k]["geometry"]).bounds]}'); continue
        if k not in B: out.append(f'  - {k} {[round(v, 1) for v in shape(A[k]["geometry"]).bounds]}'); continue
        ga, gb = shape(A[k]['geometry']).buffer(0), shape(B[k]['geometry']).buffer(0); d = ga.symmetric_difference(gb)
        pa = {q: v for q, v in A[k]['properties'].items() if q not in ('assumption', 'source', 'grade', 'reason')}; pb = {q: v for q, v in B[k]['properties'].items() if q not in ('assumption', 'source', 'grade', 'reason')}
        if d.area > 0.01 or pa != pb: out.append(f'  ~ {k} 도형 차 {d.area:.2f} m2 {[round(v, 1) for v in d.bounds] if d.area > 0.01 else ""} 속성 {[q for q in set(pa) | set(pb) if pa.get(q) != pb.get(q)]}')
    order = [key(f) for f in a['features'] if key(f) in B] != [key(f) for f in b['features'] if key(f) in A]
    if out or order: print(p, len(A), '->', len(B), '(순서 바뀜)' if order else ''); print('\n'.join(out))
for p in ('backend/data/terrain/samples/smap_samples_z05_edge_5186.json', 'backend/data/terrain/samples/z09_edge_blend_5186.json', 'backend/data/terrain/recipes/z05-smooth-ground.json'):
    print(p, '같음' if head(p) == cur(p) else '다름')
