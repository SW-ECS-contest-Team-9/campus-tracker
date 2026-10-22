"""B1435(2026-10-22): 운동장 지하 1층 바닥 141.4 → 143.5 m(사용자 결정 "143.5로 진행해"). 시험용 DB 변경 묶음을 만든다. DB 는 읽기만(docker psql, 컨테이너 campus-tracker-test-db).
  python -I build_group.py   -> groups/b1435.json, pairs.json
적용: C:\\campus-tracker-testdb\\backend 에서 sh ../docs/audit/b1435/apply.sh (시험용 DB 127.0.0.1:5544 만. 운영 서버 금지).
- 지하 1층 높이(141.4)의 노드·꼭짓점은 143.5 로(+2.1). 지하 2층(137.9)은 그대로(사용자 "약 138").
- 두 층 사이·지상과 잇는 계단·경사로는 양 끝 사이를 비율대로 다시 나눈다(평면·꼭짓점 수 그대로).
- 지하 차도 연장 윗구간 087cb024: 137.8(노드 496ea877, 그대로) → 들머리 143.5, 목 14 m 평지(u02/build_parts.py 와 같음).
근거: 볼트 구역 노트 "운동장 아래 지하층과 지하 차도" 2026-10-22 절, 건물 노트 은주관·혜인관·청운관 같은 날 절."""
import json, pathlib, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent
OLD, NEW, B2 = 141.4, 143.5, 137.9


def q(sql):
    out = subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout
    return [l.split('|') for l in out.strip().splitlines()]


def full(prefix, table='road_segments', status="status='DRAFT'"):
    rows = q(f"select id from mobility.{table} where {status} and id::text like '{prefix}%'")
    assert len(rows) == 1, (prefix, rows)
    return rows[0][0]


def road(prefix):
    rid = full(prefix)
    (rev, fn, tn, gj), = q(f"select revision, from_node_id, to_node_id, st_asgeojson(geom) from mobility.road_segments where id='{rid}'")
    return rid, int(rev), fn, tn, json.loads(gj)['coordinates']


r2 = lambda v: round(float(v), 2)
EV = ('사용자 결정 2026-10-22 "143.5로 진행해": 운동장 지하 1층 바닥 141.4 → 143.5 m(±0.5). 근거: C02 10-15 기압(지하 1층 → 본관 5층 137.8 에 5.7 m), '
      '영상 2(운동장 → 지하 1층 계단 가파름), 지하 2층 ↔ 지하 1층 30~40 단. 볼트 구역 노트 운동장 아래 지하층과 지하 차도 같은 날 절')
G = '확정(사용자 결정 ±0.5 m), 추정(선·나머지 높이)'

# 지하 1층 높이의 노드(길이 붙은 것만. move_node 는 붙은 길의 끝 꼭짓점도 같이 옮긴다)
nodes = q(f"select n.id, st_x(n.geom), st_y(n.geom) from mobility.network_nodes n where abs(st_z(n.geom) - {OLD}) < 0.005 "
          "and st_x(n.geom) between 201090 and 201270 and st_y(n.geom) between 557140 and 557340 "
          "and exists (select 1 from mobility.road_segments r where r.status='DRAFT' and (r.from_node_id=n.id or r.to_node_id=n.id)) order by n.id")
moved = {n[0] for n in nodes}
ops = [{'ref': f'노드 {n[0][:8]} 지하 1층 141.4 → 143.5', 'op': 'move_node', 'args': {'nodeId': n[0], 'to': {'xy': [r2(n[1]), r2(n[2])], 'z': NEW}}, 'grade': G, 'evidence': EV} for n in nodes]


def lin(z0, z1, n0, n1):   # 높이 z0 -> n0, z1 -> n1 의 비율 사상
    return lambda z: r2(n0 + (z - z0) * (n1 - n0) / (z1 - z0))


flat = lambda z: NEW if abs(z - OLD) < 0.005 else z
ROADS = {   # 길 앞자리: (가운데 꼭짓점 높이 사상, 새 이름 또는 None)
    '087cb024': (flat, '지하 차도 연장 윗구간 (운동장 지하 1층 북서 목 143.5 ~ 본관 5층 높이 137.8 m. 들머리까지 36.9 m 에 15.5 %, 목 14 m 평지. 보차 혼용: 사람이 걸어 내려감은 사용자 확정, 선 추정. 높이는 사용자 결정 2026-10-22)'),
    '1f87133e': (lin(137.8, OLD, 137.8, NEW), '은주1관 지하통로 문 안 계단 (주차장 쪽 문 143.5 → 3층 137.8 m, 한 층 5.7 m 내려감. 있음은 사진, 단 수·모양 추정. 문 높이는 사용자 결정 2026-10-22)'),
    '5aea9b42': (lin(149.3, OLD, 149.3, NEW), '혜인관 지하통로 계단 (지하 1층 문 정면, 건물 안. 혜인관 지하 1층 149.3 → 운동장 지하 1층 143.5 m, 높이 차 5.8 m·참과 둘째 구간 추정)'),
    '7e2741ec': (flat, '운동장 지하 1층 ~ 운동장 계단 (은주관 문 오른쪽. 143.5 → 148.9 m, 높이 차 5.4 m. 있음은 원천, 자리·모양 추정)'),
    'c9319f92': (lin(149.2, OLD, 149.2, NEW), '청운관 계단실: 붉은 벽 칸 → 청록 앞방 (149.2 → 143.5 m, 두 줄 x 13단 = 단 높이 0.22 m 가파름. 꺾임 없음(영상 2·사용자), 평면 추정)'),
    '1eccfdaf': (lin(B2, OLD, B2, NEW), '청운관 계단실: 지하 1층 앞방 → 지하 2층 (143.5 → 137.9 m, 5.6 m 되돌림 한 번. 사용자 30~40 단과 맞음(32 단이면 0.175 m), 평면 추정)'),
    'f3501fc8': (lin(B2, OLD, B2, NEW), '운동장 지하 1층–지하 2층 경사로 (곧은 12.0 m + 섬을 끼고 굽은 8.0 m. 20.0 m 에 5.6 m, 28 %. 두 방향. 평면은 사진에서 잰 추정, 층 차는 사용자 결정 2026-10-22: 사진의 17.5 % 와 어긋남)'),
    'b0d07a1b': (flat, '청운관 계단실 청록 앞방 → 왼쪽 문 → 운동장 지하 1층 주차장 (143.5 m)'),
    '08df26b4': (flat, None),
    '6da93316': (flat, None),
}
for pre, (fz, name) in ROADS.items():
    rid, rev, fn, tn, c = road(pre)
    for end, nid, p in (('start', fn, c[0]), ('end', tn, c[-1])):   # 끝이 141.4 인데 노드가 안 옮겨지는 길이 없게
        assert not (abs(p[2] - OLD) < 0.005 and nid not in moved), (pre, end)
    rev_now = rev + (fn in moved) + (tn in moved)
    vops = []
    for i in range(1, len(c) - 1):
        z, nz = c[i][2], fz(c[i][2])
        if abs(nz - z) > 0.004: vops.append({'op': 'move', 'index': i, 'point': {'xy': [r2(c[i][0]), r2(c[i][1])], 'z': nz}})
    args = {'id': rid, 'expectedRevision': rev_now, 'zMode': 'explicit', 'densify': False}
    if name: args['attrs'] = {'name': name}
    if vops: args['vertexOps'] = vops
    if name or vops: ops.append({'ref': f'길 {pre}: 가운데 꼭짓점 {len(vops)}개 다시 나눔' + (', 이름' if name else ''), 'op': 'update_road', 'args': args, 'grade': G, 'evidence': EV})
left = q(f"select distinct substr(r.id::text,1,8) from mobility.road_segments r, st_dumppoints(r.geom) g where r.status='DRAFT' and abs(st_z(g.geom)-{OLD})<0.005")
assert {l[0] for l in left} <= set(ROADS), left

PL = {'3f9a0e6c': (NEW, None, 'U02. 2026-10-22 사용자 결정으로 바닥 143.5 m(전 141.4: 사용자 2026-10-12 단면 표시). 학교 지도에 주차 줄이 그려진 사다리꼴(운동장보다 북쪽이 좁다). 이름·표지 자리는 추정'),
      '5f9c4ea7': (NEW, '지하통로 입구: 은주1관 (연결 층 3층. 주차장 쪽 문 143.5 m, 문 안 계단 아래가 3층 137.8 m. 자리 ±3 m)', None),
      '551f3d72': (None, None, 'U11. 바닥 137.9 m. 2026-10-22: 지하 1층 바닥 143.5 m 에서 5.6 m 아래(사용자 "약 138", 청운관 계단실 30~40 단). U11 의 사진에서 잰 한 층 3.5 m 보다 크다. 이름·표지 자리는 추정')}
for pre, (z, name, desc) in PL.items():
    pid = full(pre, 'places', "status<>'RETIRED'")
    (rev, gj), = q(f"select revision, st_asgeojson(geom) from mobility.places where id='{pid}'")
    c = json.loads(gj)['coordinates']
    a = {'id': pid, 'expectedRevision': int(rev)}
    if z is not None: a['position'] = {'xy': [r2(c[0]), r2(c[1])], 'z': z}
    if name: a['name'] = name
    if desc: a['description'] = desc
    ops.append({'ref': f'장소 {pre}', 'op': 'update_place', 'args': a, 'grade': G, 'evidence': EV})

assert len(ops) <= 25, len(ops)
out = {'id': 'B1435', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': '운동장 지하 1층 바닥 141.4 → 143.5 m(사용자 결정 2026-10-22): 지하 1층 노드·길·장소, 계단·경사로 다시 나눔(시험용 DB 만)', 'ops': ops}
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'b1435.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('nodes', len(nodes), 'ops', len(ops))

# 도달 쌍: U04 의 73쌍(141.4 점은 143.5 로) + 이번 확인 쌍
P = json.loads((HERE.parent / 'u04' / 'pairs.json').read_text(encoding='utf-8'))
for p in P['pairs']:
    for k in ('from', 'to'):
        pt = p[k].get('point')
        if pt and abs(pt[2] - OLD) < 0.005: pt[2] = NEW
N = lambda pre: {'nodeId': full(pre, 'network_nodes', 'true')}
P['pairs'] += [
    {'id': 'B1435 지하2층>북악관6층', 'label': '지하 2층(청운관 계단실 문) → 지하 1층 → 지하 차도 → 본관 5층 → 북악관 6층', 'from': N('5e940a31'), 'to': N('ce5e26d2'), 'vehicle': False},
    {'id': 'B1435 지하2층>본관5층', 'label': '지하 2층(청운관 계단실 문) → 본관 5층 복도', 'from': N('5e940a31'), 'to': N('61c94947'), 'vehicle': False},
    {'id': 'B1435 운동장>지하1층(청운관)', 'label': '운동장(청운관 틀 밑 통로) → 청운관 계단실 → 지하 1층 문', 'from': N('223c46db'), 'to': N('931d63da'), 'vehicle': False},
    {'id': 'B1435 혜인관>지하1층', 'label': '혜인관 입구(1) 지하 1층 문 → 계단 → 운동장 지하 1층 주차장', 'from': N('07c38541'), 'to': N('8409ade4'), 'vehicle': False},
    {'id': 'B1435 은주1관3층>지하1층 문', 'label': '은주1관 3층 복도 → 문 안 계단 → 주차장 쪽 문', 'from': N('ee68ae38'), 'to': N('8e608a71'), 'vehicle': False},
    {'id': 'B1435 지하2층 경사로>지하1층 목(차)', 'label': '층 사이 경사로 발치(지하 2층) → 지하 1층 북서 목(차량)', 'from': N('a918c7ee'), 'to': N('d80020b1'), 'vehicle': True},
]
(HERE / 'pairs.json').write_text(json.dumps(P, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print('pairs', len(P['pairs']))
