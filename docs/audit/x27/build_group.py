"""X27: 시험용 DB 변경 묶음(정문 계단·문, 로비 안 계단, 은주1관 곡선 돌계단 길). DB 는 읽기만(docker psql, 컨테이너 campus-tracker-test-db).
  python -I build_group.py   -> groups/x27-roads.json
적용: C:\\campus-tracker-testdb\\backend 에서 npx tsx ../docs/audit/n02/n02.ts apply <묶음> <결과.json> [--commit] (시험용 DB 127.0.0.1:5544 만)."""
import json, pathlib, subprocess, sys
import numpy as np
HERE = pathlib.Path(__file__).parent
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
def rev(prefix):
    rows = q(f"select id, revision from mobility.road_segments where status='DRAFT' and id::text like '{prefix}%'"); assert len(rows) == 1, (prefix, rows); return rows[0][0], int(rows[0][1])
def node(prefix):
    rows = q(f"select id from mobility.network_nodes where id::text like '{prefix}%'"); assert len(rows) == 1, prefix; return rows[0][0]
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8'))
C, A, N = (np.array(M['frame'][k]) for k in ('C', 'A', 'N'))
r2 = lambda v: round(float(v), 2)
def P(u, v): p = C + A * u + N * v; return [r2(p[0]), r2(p[1])]
AER = '사용자 항공사진 항공-한림관정문-은주1관.webp(땅 위 표시 셋으로 맞춤 ±1.5 m, docs/audit/x27/aerial-georef.json), 구조물 x27-hanlim-front'
base = {'roadClass': 'pedestrian', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'zMode': 'explicit', 'densify': False}
ops = []
# ---- 정문 계단(X27)·문 ----
(nx, ny), = [tuple(map(float, r)) for r in q("select ST_X(geom), ST_Y(geom) from mobility.network_nodes where id::text like 'd57d0927%'")]
un = float((np.array([nx, ny]) - C) @ A)                   # 굽이 노드의 u: 계단 길은 그 u 에서 곧게 오른다
FOOT, TOP, DOOR = P(un, -8.0), P(un, -1.756), P(1.8, 1.5)  # 문 = 동쪽 회전문
G = '확정(정문 계단·회전문: 사용자·사진), 항공사진(자리·방향 ±1.5 m), 추정(단 수·높이 나눔)'
ops.append({'ref': '계단 머리 노드 c42974a5 → 새 계단 머리(127.2)', 'op': 'move_node', 'args': {'nodeId': node('c42974a5'), 'to': {'xy': TOP, 'z': 127.2}}, 'grade': G, 'evidence': AER})
ops.append({'ref': '문 노드 b2fd2d5e → 동쪽 회전문(유리 면)', 'op': 'move_node', 'args': {'nodeId': node('b2fd2d5e'), 'to': {'xy': DOOR, 'z': 127.2}}, 'grade': G, 'evidence': AER + ', 사진 20(회전문 둘)'})
rid, r = rev('33523839')
ops.append({'ref': '정문 계단 길: 굽이 노드 → 계단 발치 → 머리, 이름', 'op': 'update_road', 'grade': G, 'evidence': AER,
            'args': {'id': rid, 'expectedRevision': r + 1, 'zMode': 'explicit', 'densify': False,
                     'attrs': {'name': '한림관 정문 계단 (15단, 125.1 → 127.2 m, 짙은 화강석 폭 10.5 m. 방위 32.7도로 오름: 사용자 항공사진)', 'widthM': 10.0},
                     'vertexOps': [{'op': 'insert', 'index': 0, 'point': {'xy': FOOT, 'z': 125.1}}]}})
rid2, r2_ = rev('c51fa3bc')
ops.append({'ref': '참 → 문 길 이름', 'op': 'update_road', 'grade': G, 'evidence': AER,
            'args': {'id': rid2, 'expectedRevision': r2_ + 2, 'zMode': 'explicit', 'densify': False, 'attrs': {'name': '한림관 정문 계단 위 참 → 동쪽 회전문 (127.2 m, 참 깊이 3.2 m)'}}})
(pid, prev), = [(a, int(b)) for a, b in q("select id, revision from mobility.places where id::text like 'ca81f03f%'")]
ops.append({'ref': '장소 한림관 입구 → 동쪽 회전문', 'op': 'update_place', 'args': {'id': pid, 'expectedRevision': prev, 'position': {'xy': DOOR, 'z': 127.2},
            'description': '한림관 정문(회전문 둘). 자리는 사용자 항공사진(2026-10-22). 학교 표지 자리(201105.7, 557280.5)는 참 서쪽 끝'}, 'grade': G, 'evidence': AER})
# ---- 로비 안 부채꼴 계단(X34): 1층 안 127.2 → 128.1 ----
GL = '사진 22(회전문 안 부채꼴 계단 5~6단), 추정(6단·높이 128.1·선). 1층은 한 층(사용자 2026-10-22)'
L0, L1, L2 = P(0.6, 2.65), P(0.6, 4.5), P(0.6, 5.3)
bi = {'buildingId': '한림관'}
ops.append({'ref': '로비: 동쪽 회전문 → 부채꼴 계단 발치', 'op': 'create_road', 'args': {**base, **bi, 'name': '한림관 1층 로비: 정문 회전문 → 부채꼴 계단 발치 (127.2 m)', 'structure': 'indoor_corridor', 'widthM': 2.0,
            'path': [{'at': {'nodeId': node('b2fd2d5e')}}, {'xy': L0, 'z': 127.2}]}, 'grade': GL, 'evidence': '사진 22'})
ops.append({'ref': '로비 부채꼴 계단 6단', 'op': 'create_road', 'args': {**base, **bi, 'name': '한림관 1층 로비 부채꼴 계단 (6단 추정, 127.2 → 128.1 m, 1층 안)', 'structure': 'stairs', 'widthM': 4.0,
            'path': [{'xy': L0, 'z': 127.2}, {'xy': L1, 'z': 128.1}]}, 'grade': GL, 'evidence': '사진 22'})
ops.append({'ref': '안쪽 로비', 'op': 'create_road', 'args': {**base, **bi, 'name': '한림관 1층 안쪽 로비 (128.1 m 추정)', 'structure': 'indoor_corridor', 'widthM': 3.0,
            'path': [{'xy': L1, 'z': 128.1}, {'xy': L2, 'z': 128.1}]}, 'grade': GL, 'evidence': '사진 22'})
# ---- 은주1관 곡선 돌계단(X29): 사용자 지정 길 ✓ ----
GC = '확정(굽이 → 곡선 계단 → 은주1관 입구(1): 사용자 화살표 ✓), 항공사진·사진(자리 ±1.5 m), 추정(단 수·높이 나눔)'
EV = '사진 은주관-곡선계단-차단기·은주관-횡단보도에서-화살표(사용자 화살표), ' + AER
E = M['eunjuStair']; line = np.array(E['line']); segs = E['segs']
cum = np.r_[0, np.cumsum(np.hypot(*np.diff(line, axis=0).T))]
sz = [0.0] + [s[1] for s in segs]; zz = [125.2] + [s[2] for s in segs]
pts = [{'xy': [r2(x), r2(y)], 'z': r2(np.interp(c, sz, zz))} for (x, y), c in zip(line, cum)]
ri, _ = rev('6c877e98')
ops.append({'ref': '굽이(위쪽 갈래) → 곡선 계단 발치', 'op': 'create_road', 'args': {**base, 'name': '위쪽 갈래 굽이 → 은주1관 곡선 돌계단 발치 (125.2 m, 사용자 지정 길)', 'structure': 'ordinary', 'widthM': 2.4,
            'path': [{'at': {'roadId': ri, 'nearest': [201107.7, 557268.0]}}, pts[0]]}, 'grade': GC, 'evidence': EV})
ops.append({'ref': '은주1관 곡선 돌계단', 'op': 'create_road', 'args': {**base, 'name': f'은주1관 곡선 돌계단 (41단 추정, 125.2 → 131.3 m: 아래 3단·작은 참·긴 한 줄·위 참, 사용자 지정 길)', 'structure': 'stairs', 'widthM': 2.4,
            'path': pts}, 'grade': GC, 'evidence': EV})
ops.append({'ref': '테라스 → 은주1관 입구(1)', 'op': 'create_road', 'args': {**base, 'name': '은주1관 반원 테라스 → 입구(1) 아치 문 (131.3 m, 사용자 지정 길)', 'structure': 'ordinary', 'widthM': 3.0,
            'path': [pts[-1], {'xy': [201118.6, 557253.6], 'z': 131.3}, {'xy': [201120.8, 557252.7], 'z': 131.3}]}, 'grade': GC, 'evidence': EV})
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'x27-roads.json').write_text(json.dumps({'id': 'X27-ROADS', 'comment': 'X27·X29·X34 한림관 정문 계단·문, 로비 안 계단, 은주1관 곡선 돌계단 길(시험용 DB 만)', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), 'ops', 'u_node', round(un, 2), FOOT, TOP, DOOR)
