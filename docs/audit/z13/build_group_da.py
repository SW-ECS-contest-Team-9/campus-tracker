"""Z13 다: 시험용 DB 변경 묶음. apply_da.py 와 같은 옮김(dx)을 유담관 옆 차도·인도·횡단·계단식 인도 길에. DB 는 읽기만(docker psql).
  python -I build_group_da.py -> groups/z13-da-N.json
- 노드: 북좌표 557195.5~557260, 동좌표 201082 동쪽이면 dx 만큼(높이 그대로). 계단식 인도(965081ed·8d3e341a)의 노드·꼭짓점은 띠 안 상대 자리를 지켜 새 띠로(턱 + 폭 비율).
- 길 가운데 꼭짓점도 같은 규칙. 광장 쪽(동좌표 201082 서쪽)은 그대로."""
import json, pathlib, subprocess, sys
import numpy as np
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent
src = (HERE / 'apply_da.py').read_text(encoding='utf-8'); src = src[:src.index('BASEF = HERE')]
ns = {'__file__': str(HERE / 'apply_da.py')}; exec(compile(src, 'apply_da', 'exec'), ns)
dx, kerb_now, kerb_mesh, out_now, w_meas, X, Y, X_FIX = (ns[k] for k in ('dx', 'kerb_now', 'kerb_mesh', 'out_now', 'w_meas', 'X', 'Y', 'X_FIX'))
Y0, Y1 = ns['Y0'], ns['Y1']
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
r2 = lambda v: round(float(v), 2)
BAND = ('965081ed', '8d3e341a')
def new_xy(x, y, band):
    xl, yl = x - X, y - Y
    if xl < X_FIX or not (Y0 - 8 <= yl <= Y1 + 8): return None
    if band and Y0 <= yl <= Y1:
        f = (xl - kerb_now(yl)) / max(0.5, out_now(yl) - kerb_now(yl)); return [r2(X + kerb_mesh(yl) + min(max(f, 0), 1) * w_meas(yl)), r2(y)]
    d = dx(yl)
    return None if abs(d) < 0.01 else [r2(x + d), r2(y)]
rows = q("select id, revision, from_node_id, to_node_id, st_asgeojson(geom) from mobility.road_segments where status='DRAFT' and ST_Intersects(geom, ST_MakeEnvelope(201078,557194,201106,557262,5186))")
nodes = {}
for rid, rev, fn, tn, gj in rows:
    c = json.loads(gj)['coordinates']; band = rid.startswith(BAND)
    for nid, p in ((fn, c[0]), (tn, c[-1])):
        nx = new_xy(p[0], p[1], band)
        if nx and (nid not in nodes or band): nodes[nid] = (nx, p[2])
EV = 'Claude 결정 2026-10-23(Z13 후보 다): S-MAP 0.5 m 메시의 동쪽 턱 선(z13/candidates.py, 잔차 0.6 m)과 전방위 사진에서 잰 계단 띠 폭. 구조물 z03·z12·z13-da 와 같은 옮김'
G = 'S-MAP(턱 선), 추정(잰 폭 ±0.8 m, 차도·인도를 같은 만큼 옮김)'
ops = [{'ref': f'노드 {n[:8]} 옮김', 'op': 'move_node', 'args': {'nodeId': n, 'to': {'xy': xy, 'z': r2(z)}}, 'grade': G, 'evidence': EV} for n, (xy, z) in sorted(nodes.items())]
for rid, rev, fn, tn, gj in rows:
    c = json.loads(gj)['coordinates']; band = rid.startswith(BAND); vops = []
    for i in range(1, len(c) - 1):
        nx = new_xy(c[i][0], c[i][1], band)
        if nx: vops.append({'op': 'move', 'index': i, 'point': {'xy': nx, 'z': r2(c[i][2])}})
    if vops: ops.append({'ref': f'길 {rid[:8]} 꼭짓점 {len(vops)}', 'op': 'update_road', 'args': {'id': rid, 'expectedRevision': int(rev) + (fn in nodes) + (tn in nodes), 'zMode': 'explicit', 'densify': False, 'vertexOps': vops}, 'grade': G, 'evidence': EV})
(HERE / 'groups').mkdir(exist_ok=True)
for old in (HERE / 'groups').glob('z13-da-*.json'): old.unlink()
chunks = [ops[i:i + 8] for i in range(0, len(ops), 8)]
for k, part in enumerate(chunks):
    (HERE / 'groups' / f'z13-da-{k + 1}.json').write_text(json.dumps({'id': f'Z13-DA-{k + 1}', 'comment': 'Z13 다: 유담관 옆 차도·인도·계단식 인도 길을 메시 턱 선대로(시험용 DB 만)', 'ops': part}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('노드', len(nodes), '길', sum(o['op'] == 'update_road' for o in ops), '묶음', len(chunks))
