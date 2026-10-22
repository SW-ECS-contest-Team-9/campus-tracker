"""B2140(2026-10-22): 사용자 결정 두 가지를 시험용 DB 변경 묶음으로. DB 는 읽기만(docker psql, 컨테이너 campus-tracker-test-db).
  python -I build_group.py   -> groups/b2140.json
적용: C:\\campus-tracker-testdb\\backend 에서 npx tsx ../docs/audit/n02/n02.ts apply <묶음> <결과> --commit, 이어 python ../docs/audit/b2140/areas_rename.py (시험용 DB 127.0.0.1:5544 만. 운영 서버 금지).
1) 지하 1층 → 지하 2층 높이 차 3.5 m(약 20단): 지하 2층 바닥 137.9 → 140.0 m(지하 1층 143.5 그대로). 지하 2층 노드·장소는 +2.1, 두 층 사이 계단·경사로의 가운데 꼭짓점은 비율대로 다시 나눔(평면 그대로).
2) 운동장 지하 주차장 = "1주차장"(사용자 확인): 길·장소 이름의 "운동장 지하 1층/2층(주차장)" → "1주차장 지하 1층/2층". "제2주차장"(학교 표지)은 P1 터널 입구 이름으로만 남김: 길 이름의 "제2주차장" → "P1 입구".
근거: 볼트 구역 노트 "운동장 아래 지하층과 지하 차도" 2026-10-22 절, 건물 노트 청운관 같은 날 절."""
import json, pathlib, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent
OLD, NEW, B1 = 137.9, 140.0, 143.5
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
r2 = lambda v: round(float(v), 2)
EV = '사용자 결정 2026-10-22: 지하 1층 → 지하 2층 3.5 m(약 20단), 지하 2층 140.0 m. 사진의 기둥 높이 약 2.9 m·층 사이 차량 경사로 약 17.5 % 와 맞음. 볼트 구역 노트 운동장 아래 지하층과 지하 차도'
EVN = '사용자 확인 2026-10-22: 운동장 지하 주차장 = 1주차장(혜인관 쪽). "제2주차장"(학교 표지)은 P1 터널 입구 이름으로만'
G = '확정(사용자 결정), 추정(선·나머지 높이)'
nodes = q(f"select n.id, st_x(n.geom), st_y(n.geom) from mobility.network_nodes n where abs(st_z(n.geom) - {OLD}) < 0.005 and st_x(n.geom) between 201130 and 201250 and st_y(n.geom) between 557170 and 557310 "
          "and exists (select 1 from mobility.road_segments r where r.status='DRAFT' and (r.from_node_id=n.id or r.to_node_id=n.id)) order by n.id")
moved = {n[0] for n in nodes}
ops = [{'ref': f'노드 {n[0][:8]} 지하 2층 137.9 → 140.0', 'op': 'move_node', 'args': {'nodeId': n[0], 'to': {'xy': [r2(n[1]), r2(n[2])], 'z': NEW}}, 'grade': G, 'evidence': EV} for n in nodes]
lin = lambda z: r2(NEW + (z - OLD) * (B1 - NEW) / (B1 - OLD)) if OLD - 0.005 <= z <= B1 + 0.005 else z
def rename(n):
    for a, b in (('운동장 지하 1층 주차장', '1주차장 지하 1층'), ('운동장 지하 2층 주차장', '1주차장 지하 2층'), ('운동장 지하 1층', '1주차장 지하 1층'), ('운동장 지하 2층', '1주차장 지하 2층'), ('제2주차장 입구', 'P1 입구'), ('제2주차장', 'P1 입구')):
        n = n.replace(a, b)
    return n
NAMES = {'f3501fc8': '1주차장 지하 1층–지하 2층 경사로 (곧은 12.0 m + 섬을 끼고 굽은 8.0 m. 20.0 m 에 3.5 m, 17.5 %: 사진과 맞음. 두 방향. 평면은 사진에서 잰 추정, 층 차는 사용자 결정 2026-10-22)',
         '1eccfdaf': '청운관 계단실: 지하 1층 앞방 → 지하 2층 (143.5 → 140.0 m, 3.5 m 약 20단, 되돌림 한 번. 사용자 결정 2026-10-22, 평면 추정)',
         'b34a475c': '청운관 계단실 지하 2층 발치 → 1주차장 지하 2층 (140.0 m)'}
rows = q("select id, revision, from_node_id, to_node_id, name, st_asgeojson(geom) from mobility.road_segments where status='DRAFT'")
n_road = 0
for rid, rev, fn, tn, name, gj in rows:
    c = json.loads(gj)['coordinates']
    vops = [{'op': 'move', 'index': i, 'point': {'xy': [r2(c[i][0]), r2(c[i][1])], 'z': lin(c[i][2])}} for i in range(1, len(c) - 1) if abs(lin(c[i][2]) - c[i][2]) > 0.004
            and 201130 <= c[i][0] <= 201250 and 557170 <= c[i][1] <= 557310 and (fn in moved or tn in moved or abs(c[i][2] - OLD) < 0.005)]
    new = NAMES.get(rid[:8]) or rename(name)
    if not vops and new == name: continue
    for end, nid, p in (('start', fn, c[0]), ('end', tn, c[-1])):
        assert not (abs(p[2] - OLD) < 0.005 and nid not in moved), (rid, end)
    args = {'id': rid, 'expectedRevision': int(rev) + (fn in moved) + (tn in moved), 'zMode': 'explicit', 'densify': False}
    if new != name: args['attrs'] = {'name': new}
    if vops: args['vertexOps'] = vops
    ops.append({'ref': f'길 {rid[:8]}: ' + ('높이 다시 나눔 ' if vops else '') + ('이름' if new != name else ''), 'op': 'update_road', 'args': args, 'grade': G if vops else '확정(이름: 사용자)', 'evidence': EV if vops else EVN}); n_road += 1
PL = {'551f3d72': ('1주차장 지하 2층 (자리 추정)', NEW, 'U11. 바닥 140.0 m = 지하 1층 143.5 - 3.5 m(약 20단, 사용자 결정 2026-10-22). 이름 1주차장(사용자 확인 2026-10-22). 표지 자리 추정'),
      '3f9a0e6c': ('1주차장 지하 1층 (자리 추정)', None, 'U02. 바닥 143.5 m(사용자 결정 2026-10-22). 이름 1주차장(사용자 확인 2026-10-22, 혜인관 쪽). 학교 지도에 주차 줄이 그려진 사다리꼴. 표지 자리 추정'),
      'ab3303af': ('P1 입구 (학교 표지: 제2주차장. 1주차장 터널 진입)', None, '본관 남서 화단 아래 터널 입구. 풋살파크 안내문 "1주차장 터널진입". 학교 표지 이름 제2주차장은 이 입구 이름으로만 남김(사용자 2026-10-22)')}
for pre, (name, z, desc) in PL.items():
    (pid, rev, x, y), = q(f"select id, revision, st_x(geom), st_y(geom) from mobility.places where id::text like '{pre}%'")
    a = {'id': pid, 'expectedRevision': int(rev), 'name': name, 'description': desc}
    if z is not None: a['position'] = {'xy': [r2(x), r2(y)], 'z': z}
    ops.append({'ref': f'장소 {pre}: {name}', 'op': 'update_place', 'args': a, 'grade': '확정(사용자)', 'evidence': EV + '; ' + EVN})
(HERE / 'groups').mkdir(exist_ok=True)
chunks = [ops[i:i + 8] for i in range(0, len(ops), 8)]
for k, part in enumerate(chunks):
    (HERE / 'groups' / f'b2140-{k + 1}.json').write_text(json.dumps({'id': f'B2140-{k + 1}', 'comment': '지하 2층 140.0 m(지하 1층 - 3.5 m)·이름 1주차장(시험용 DB 만)', 'ops': part}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('노드', len(nodes), '길', n_road, '장소', len(PL), '묶음', len(chunks))
