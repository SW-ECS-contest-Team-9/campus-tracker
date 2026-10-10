"""N03: 시험용 DB 에 넣을 편집 묶음(편집기 MCP apply_changes 입력)을 만든다. DB 접근 없음, 파일만 씀.
  python -I build_groups.py STATE.json AREAS.json [GROUP ...]   -> groups/<GROUP>.json (n02.ts apply 로 적용)
지금 상태 파일(n02.ts state)에서 길·노드의 id 와 개정 번호를 읽는다. 다른 작업(Z04)이 길을 나눴어도 이름·자리로 다시 찾는다.
높이는 동 노트 머리(출입구·층 바닥), 구조물 파일(frontend/public/structures), 사용자 S-MAP 핀(v02/user-readings.json), S-MAP 1 m 메시(볼트 z04, 있을 때만)에서만 온다.
묶음(안 = 건물 안과 G02·Z02·Z03 구역: Z04 와 겹치지 않음 / 밖 = Z04 가 끝난 뒤):
  A  안  대일관 1층 실내 길을 층 높이로, 로비 문과 잇기, 입구(2) 문
  F  안  운동장 가장자리의 문 다섯(은주1관·2관 5층, 청운관 1층, 혜인관 입구(1)·(2))
  W  안  본관 입구(3), 본관 5층–한림관 3층 데크(보행 구간에서 오르는 자리는 모름이라 잇지 않음)
  X  안  보행 출입: 걸은 기록에서 나온 길과 사용자가 확정한 보행 길을 '허용'으로
  R  밖  대일관 뒤 단(1층 높이)과 뒷문, 옆 계단 사슬, 뒤편 산책로 높이, 북악관 옆길과 잇기
  U  밖  한림관 1층 계단, 은주2관 1층 로비 앞(윗길 연장), 본관 입구(1) 앞 평탄부
  N  밖  북악관 입구(3) 계단
  P  -   출입구 장소 표지(학교 목록 가운데 아직 없는 것)"""
import sys, json, math, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import *

S = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
NET = Net(sys.argv[1], sys.argv[2])
ROADS = {r['id']: r for r in S['roads']}; NODES = {n['id']: n for n in S['nodes']}
STRUCT = {f['properties']['id']: f for n in ('g02-way', 'z02-daeil-front', 'z03-fountain')
          for f in json.loads((REPO / f'frontend/public/structures/{n}.geojson').read_text(encoding='utf-8'))['features'] if f['properties'].get('id')}
PINS = {p['id']: p for p in json.loads((HERE.parent / 'v02' / 'user-readings.json').read_text(encoding='utf-8'))['points'] if p.get('x')}
ENT = {e['name']: e for e in note_entrances()}

def ground(x, y, r=1):
    from smap import ground as g; v = g(x, y, r); assert v, ('S-MAP 메시에 땅 칸이 없음', x, y); return v[0]

def road_by(name_starts=None, near=None, radius=1.0, z=None):
    """이름 머리나 끝점 자리로 길을 찾는다(하나여야 함)."""
    c = [r for r in S['roads'] if (name_starts is None or (r['name'] or '').startswith(name_starts))]
    if near is not None:
        def d(r): return min(math.hypot(p[0] - near[0], p[1] - near[1]) + (0 if z is None else abs(p[2] - z)) for p in r['coordinates'])
        c = [r for r in c if d(r) <= radius]
    assert len(c) == 1, (name_starts, near, [r['id'][:8] for r in c]); return c[0]
def node_at(xy, z=None, radius=0.5):
    c = [(d, dz, n) for d, dz, n in NET.nearest(xy, z, radius) if z is None or abs(dz) <= 1.0]
    assert c, ('노드 없음', xy, z); return c[0][2]
def nz(n): return NODES[n]['coordinate'][2]
def nxy(n): return NODES[n]['coordinate'][:2]
def pt(x, y, z): return {'xy': [round(x, 2), round(y, 2)], 'z': round(z, 2)}
def at_node(n): return {'at': {'nodeId': n}}
def at_road(r, xy): return {'at': {'roadId': r['id'], 'nearest': [round(xy[0], 2), round(xy[1], 2)]}}
def op(ref, name, args, grade, evidence): return {'ref': ref, 'op': name, 'args': args, 'grade': grade, 'evidence': evidence}
def road(ref, cls, name, structure, path, grade, evidence, **attrs):
    return op(ref, 'create_road', {'roadClass': cls, 'name': name, 'structure': structure, **attrs, 'path': path, 'zMode': 'explicit', 'densify': False}, grade, evidence)
def move(ref, n, z, grade, evidence): return op(ref, 'move_node', {'nodeId': n, 'to': {'xy': nxy(n), 'z': round(z, 2)}}, grade, evidence)
def vz(ref, r, zs, grade, evidence, bump=0):
    c = r['coordinates']
    return op(ref, 'update_road', {'id': r['id'], 'expectedRevision': r['revision'] + bump, 'zMode': 'explicit', 'densify': False,
                                   'vertexOps': [{'op': 'move', 'index': i, 'point': pt(c[i][0], c[i][1], z)} for i, z in sorted(zs.items())]}, grade, evidence)
def place(name, building, xy, z, desc):
    return op(f'장소 {name}', 'create_place', {'name': name, 'category': 'building_entrance', 'buildingId': building, 'description': desc, 'position': pt(xy[0], xy[1], z)}, '원천(위치·층)', '학교 캠퍼스맵 출입구 목록, 동 노트')
def has_place(name): return any(p['name'].startswith(name) for p in S['places'])

FIELD = next(a for a in NET.areas if a['name'].startswith('운동장')); FRING = NET._rings(FIELD)[0]; FZ = FIELD['elevationM']
def into_field(door, depth=2.0):
    """문에서 가장 가까운 운동장 경계점에서 면 안쪽으로 depth m 들어간 점."""
    best = None
    for a, b in zip(FRING, FRING[1:] + FRING[:1]):
        dx, dy = b[0] - a[0], b[1] - a[1]; L = dx * dx + dy * dy
        if not L: continue
        t = max(0, min(1, ((door[0] - a[0]) * dx + (door[1] - a[1]) * dy) / L))
        q = (a[0] + t * dx, a[1] + t * dy); d = math.hypot(q[0] - door[0], q[1] - door[1])
        if best is None or d < best[0]: best = (d, q, (-dy, dx))
    d0, q, _ = best; cx = sum(p[0] for p in FRING) / len(FRING); cy = sum(p[1] for p in FRING) / len(FRING)
    want = (q[0] - door[0], q[1] - door[1]) if d0 > 0.3 and not NET._on([FRING], door) else (cx - q[0], cy - q[1]); wl = math.hypot(*want)
    cand = []
    for k in range(36):
        a = math.radians(k * 10); p = [q[0] + depth * math.cos(a), q[1] + depth * math.sin(a)]
        mid = [q[0] + depth / 2 * math.cos(a), q[1] + depth / 2 * math.sin(a)]
        if NET._on([FRING], p) and NET._on([FRING], mid): cand.append(((want[0] * math.cos(a) + want[1] * math.sin(a)) / wl, p))
    assert cand, ('면 안쪽 점을 못 찾음', door)
    return max(cand)[1]

# ------------------------------------------------------------------ A: 대일관 1층
def group_A():
    e1, e2 = ENT['대일관 입구(1)'], ENT['대일관 입구(2)']
    F1 = 151.8   # 대일관 노트 층_바닥_높이 1층 (S-MAP 기준)
    indoor = road_by('대일관 1층 내부 통로'); lobby_in = node_at([201162.8, 557316.6]); door = node_at([201157.64, 557311.69], e1['z'])
    deck = road_by('높은 가장자리 길 = 나무 데크', near=[201185.51, 557300.03], radius=3)
    ev = '대일관 노트: 층 사다리 1층 151.8 m(S-MAP 기준, 입구(2) 151.7·입구(3) 152.0). 옛 145.8 m 는 옛 운동장 141.73 + 계단 4 m 라 틀림(풀림)'
    ops = [
        vz('대일관 1층 내부 통로 안쪽 꼭짓점 145.8 → 151.8', indoor, {1: F1}, 'S-MAP', ev),
        move('대일관 1층 내부 통로 현관 쪽 끝 145.8 → 151.8', lobby_in, F1, 'S-MAP', ev),
        road('대일관 로비', 'pedestrian', '대일관 1층 로비 (현관 문 ~ 실내 통로. 현관 단 151.0 추정과 층 사다리 151.8 의 0.8 m 는 미정: 1층은 150.7~152.0 m)', 'indoor_corridor',
             [at_node(door), at_node(lobby_in)], '원천(입구(1) = 1층 로비), 선은 추정',
             '학교 출입구 목록 "대일관 1층 로비 입구". Z02 가 거둔 옛 연결선(19800cee) 자리. 문 151.0(현관 단, 추정 ±0.3), 실내 151.8(S-MAP)', buildingId='대일관'),
        road('대일관 입구(2) 문', 'pedestrian', '대일관 입구(2) 문 ~ 나무 데크 (문 앞 지면 151.7 m, 데크 151.3 m. 턱인지 계단 1~2칸인지 모름)', 'ordinary',
             [at_road(deck, [201185.51, 557300.03]), pt(*e2['xy'], e2['z'])], '원천(문·층), S-MAP(문 앞 지면), 데크 높이는 추정',
             '학교 출입구 목록 "1층 복도로 연결", 구역 노트 B9: 데크가 문 앞을 지남, 벽 앞 단면 151.7/151.5/151.0', widthM=2),
    ]
    return {'id': 'A', 'zone': '안', 'comment': '대일관 1층 실내 길을 층 높이로 올리고 로비 문·입구(2)와 잇기', 'ops': ops}

# ------------------------------------------------------------------ F: 운동장 가장자리 문
def group_F():
    ops = []
    def stub(key, building, label, grade, evidence, start=None):
        e = ENT[key]; a = start or pt(*into_field(e['xy']), FZ)
        ops.append(road(f'{key} 문', 'pedestrian', label, 'ordinary', [a, pt(*e['xy'], e['z'])], grade, evidence, widthM=2, buildingId=None))
    stub('은주1관 입구(2)', '은주관', '은주1관 입구(2) 5층 문 ~ 운동장 (148.9 m, 문 자리는 학교 표지)', '원천(문·층) + 확정(운동장 높이 문 = 5층) + 측정(148.9)',
         '사용자 확정 2026-10-10, 은주관 노트, F05 경계: 문 앞에서 화단이 끊김')
    stub('은주2관 입구(2)', '은주관', '은주2관 입구(2) 5층 문 ~ 운동장 남서 모서리 (148.9 m, 문 자리는 학교 표지. 사이 8 m 의 선은 추정)', '원천(문·층) + 측정(148.9), 선은 추정',
         '은주관 노트: 문 앞 S-MAP 지면 148.6~149.3 = 운동장 높이. E10 접근점은 표지에서 8.2 m(추정)')
    stub('청운관 입구', '청운관', '청운관 1층 입구(학교 표지) ~ 운동장 (148.9 m. 열린 돌출부 아래로 들어감, 문 자리는 모름)', '원천(표지·층) + 측정(148.9), 문 자리는 모름',
         '청운관 노트 연결 관계 5: 운동장 바닥 ~ 청운관 1층 입구. 문 위치는 현장 확인 요청 F5 ①')
    stub('혜인관 입구(2)', '건물5', '혜인관 입구(2) B1층 문 ~ 운동장 동쪽 모서리 (문 149.6 m, 문 자리는 학교 표지. 선은 추정)', '원천(문·층) + S-MAP(149.1~149.8), 선은 추정',
         '혜인관 노트. E10 접근점은 표지에서 7.5 m(추정)')
    e = ENT['혜인관 입구(1)']; n = node_at([201213.72, 557213.9], FZ, 1.0)
    ops.append(road('혜인관 입구(1) 문', 'pedestrian', '혜인관 입구(1) 문 앞 ~ 운동장 (운동장 높이 문 = B1층, 문 149.3 m. 문 자리는 학교 표지)', 'ordinary', [at_node(n), pt(*e['xy'], e['z'])],
                    '확정(운동장 높이 문 = B1) + 원천(위치) + S-MAP(148.9~149.4)', '사용자 확정 2026-10-10(사진 01), 혜인관 노트', widthM=2))
    return {'id': 'F', 'zone': '안', 'comment': '운동장(면) 가장자리의 문 다섯 곳을 접속점으로', 'ops': ops}

# ------------------------------------------------------------------ W: 오르막길 구역
def group_W():
    way = road_by('문예관 옆 오르막 보행로', near=[201100.9, 557323.4], radius=3)
    deck = STRUCT['G02-DECK-MAIN-HANLIM']; ZD = deck['properties']['toM']                      # 137.9 (구조물 윗면, 높이 추정)
    c = deck['geometry']['coordinates'][0]; mid = lambda p, q: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
    west, east = mid(c[3], c[0]), mid(c[1], c[2]); M = mid(west, east)                          # 본관 쪽 끝, 한림관 쪽 끝, 가운데
    ev_deck = '사용자 확정 2026-10-11(자리, 다시 묻지 않음), 학교 캠퍼스맵 "본관 5층과 한림관 3층을 연결", 구조물 G02-DECK-MAIN-HANLIM(윗면 137.9: 본관 5층 138.1·한림관 3층 137.8 계산값, S-MAP 으로는 못 읽음)'
    ops = [
        road('본관 입구(3) 문', 'pedestrian', '본관 입구(3) 문(5·6층 사이 계단참) ~ 오르막 보행로 본관 쪽 보도 (문 앞 지면 139.9 m, 문 자리는 학교 표지를 북쪽 벽으로 옮김)', 'ordinary',
             [at_road(way, [201098.3, 557318.1]), pt(201098.3, 557318.1, 139.9)], '원천(문) + S-MAP(문 앞 지면 139.4~140.5), 선은 추정',
             '본관 노트 B07: 위 보행로 쪽. 구역 노트 A30, G02: 남쪽 화단이 59~63 m 에서 끊김(문 앞)', widthM=2),
        road('데크 본관 쪽', 'pedestrian', '본관 5층–한림관 3층 연결통로 (실외 나무 데크, 본관 쪽 문 ~ 가운데. 137.9 m 추정)', 'ordinary', [pt(*west, ZD), pt(*M, ZD)], '확정(자리·이어짐), 높이·문 자리는 추정', ev_deck, widthM=3),
        road('데크 한림관 쪽', 'pedestrian', '본관 5층–한림관 3층 연결통로 (실외 나무 데크, 가운데 ~ 한림관 쪽 문. 137.9 m 추정)', 'ordinary', [pt(*M, ZD), pt(*east, ZD)], '확정(자리·이어짐), 높이·문 자리는 추정', ev_deck, widthM=3),
    ]
    return {'id': 'W', 'zone': '안', 'comment': '본관 입구(3), 본관 5층–한림관 3층 데크(문 두 곳). 지하 보행 구간에서 데크로 오르는 자리는 모름이라 잇지 않음', 'ops': ops}

# ------------------------------------------------------------------ X: 보행 출입
WALKED = ['C02 수집 경로', '대일관 측면 접근로 (기존 C02)', '두 C01 종합 야외 접근', '문예관 상부 진입 통로', '문예관 내부 하행계단', '문예관 계단 아래 공간 동선', '유담관 9층 입구 통로', '유담관 반층 하행계단']
CONFIRMED = ['문예관 입구 방향 하행계단 2', '문예관 하행계단 아래 평탄부', '문예관 입구 앞 평탄 접근로', '문예관 입구 평탄 연결', '대일관 1층 내부 통로', '대일관 1층 높이 접근 통로']
def group_X(done=()):
    ops = []
    for r in S['roads']:
        n = r['name'] or ''
        if r['roadClass'] != 'pedestrian' or r['pedestrianAccess'] != 'unknown': continue
        w = next((k for k in WALKED if n.startswith(k)), None); c = next((k for k in CONFIRMED if n.startswith(k)), None)
        if not (w or c): continue
        ops.append(op(f"보행 허용 {r['id'][:8]} {n[:30]}", 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'attrs': {'pedestrianAccess': 'allowed'}},
                      '측정(걸은 기록)' if w else '확정(사용자 그림·학교 출입구 목록의 길)', '수집 기록에서 나온 길은 사람이 걸은 길' if w else '사용자 그림 10(대일관 서쪽 끝 ~ 갈림 ~ 문예관 3층 로비), 학교 출입구 목록(대일관 1층 복도)'))
    return {'id': 'X', 'zone': '안', 'comment': "보행 출입 '모름' → '허용': 걸은 기록에서 나온 길과 사용자가 확정한 보행 길만", 'ops': ops}

# ------------------------------------------------------------------ R: 대일관 뒤, 산책로, 북악관 옆길
def group_R():
    """높이는 S-MAP 1 m 메시(볼트 z04, 3x3 칸 가운데값). 이미 0.3 m 안이면 건드리지 않는다(Z04 가 먼저 고쳤을 때)."""
    e3 = ENT['대일관 입구(3) = 뒷문']; F1 = 151.8
    indoor = road_by('대일관 1층 내부 통로'); terr = road_by('대일관 1층 높이 접근 통로'); walk = road_by('대일관 측면 접근로 (기존 C02)')
    side = road_by('북악관 서쪽 옆길 (GS25 문 앞'); ops = []
    ev = 'S-MAP 1 m 메시(2026-10-11 Z04 판독, 3x3 칸 가운데값). 옛 높이는 옛 지형(운동장 141.7 m 기준)에서 온 값이라 4~6 m 낮았다(E07·E08)'
    def lift(n, z, what, grade='S-MAP'):
        if abs(nz(n) - z) > SAME_Z: ops.append(move(f'{what} {nz(n):.2f} → {z:.2f}', n, z, grade, ev))
    # 산책로: 원래 꼭짓점 + 8 m 마다 꼭짓점, 높이 S-MAP (끝 노드를 옮기기 전에: 노드를 옮기면 길의 개정 번호가 바뀐다)
    c = walk['coordinates']; pts = []
    for a, b in zip(c, c[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1]); n = max(1, int(L // 8))
        pts += [(a[0] + k / n * (b[0] - a[0]), a[1] + k / n * (b[1] - a[1])) for k in range(n)]
    zs = [ground(x, y) for x, y in pts[1:]]
    worst = max(abs(a[2] - ground(a[0], a[1])) for a in c[1:-1])
    if worst > SAME_Z:
        ops.append(op(f'뒤편 산책로 높이를 S-MAP 으로 (가장 큰 차 {worst:.1f} m, 꼭짓점 {len(c)} → {len(pts) + 1})', 'update_road',
                      {'id': walk['id'], 'expectedRevision': walk['revision'], 'zMode': 'explicit', 'densify': False,
                       'path': [at_node(walk['fromNodeId'])] + [pt(x, y, z) for (x, y), z in zip(pts[1:], zs)] + [at_node(walk['toNodeId'])]}, 'S-MAP', ev))
    # 뒤 단(건물 뒤쪽 오목한 자리의 1층 높이 바닥)
    rear_in = node_at([201169.23, 557329.12]); terr_e = node_at([201192.29, 557323.23])
    tm = terr['coordinates'][1]; zt = ground(tm[0], tm[1])
    if abs(tm[2] - zt) > SAME_Z: ops.append(vz(f'대일관 뒤 단 가운데 꼭짓점 {tm[2]:.2f} → {zt:.2f}', terr, {1: zt}, 'S-MAP', ev))
    lift(rear_in, F1, '대일관 1층 내부 통로 뒤쪽 끝(실내 1층 151.8, 노트 층 사다리)', 'S-MAP(노트 층 바닥)')
    lift(terr_e, ground(*nxy(terr_e)), '대일관 뒤 단 동쪽 끝')
    # 옆 계단 사슬(실재 여부는 현장 확인 요청 F4 ④): 노드마다 S-MAP
    for xy, what in [([201192.79, 557326.28], '옆 계단 사슬: 짧은 계단 위'), ([201193.0, 557327.8], '옆 계단 사슬: 참 위쪽'), ([201194.1, 557334.2], '옆 계단 사슬: 참 아래쪽'),
                     ([201194.5, 557336.8], '옆 계단 사슬: 주 계단 아래'), ([201196.2, 557347.05], '뒤편 산책로 동쪽 끝')]:
        n = node_at(xy, None, 0.6); lift(n, ground(*nxy(n)), what)
    west = node_at([201018.47, 557413.32]); lift(west, ground(*nxy(west)), '뒤편 산책로 서쪽 끝(북악관 북서 모서리)')
    # 북악관 옆길 북쪽 끝과 잇기
    sn = node_at(side['coordinates'][-1][:2]); lift(sn, ground(*nxy(sn)), '북악관 서쪽 옆길 북쪽 끝')
    ops.append(road('옆길~산책로', 'pedestrian', '북악관 서쪽 옆길 ~ 뒤편 산책로 (북서 모서리, 132.4 → 132.6 m. 선은 추정)', 'ordinary', [at_node(sn), at_node(west)],
                    '확정(옆길과 산책로가 이어짐) + S-MAP(높이), 선은 추정', '사용자 2026-10-10(옆길과 뒤편 산책로는 이어진다), S-MAP 1 m 메시 132.4~132.6', widthM=3))
    # 뒷문
    ops.append(road('대일관 뒷문', 'pedestrian', '대일관 입구(3) 뒷문 ~ 뒤 단 (152.0 m. 산책로에서 1층 복도로 들어가는 문, 문 자리 ±3 m)', 'ordinary',
                    [at_road(terr, e3['xy']), pt(*e3['xy'], e3['z'])], '원천(문·층) + S-MAP(문 앞 152.0, 뒤 단 151.9~152.1), 문 자리는 추정',
                    '학교 출입구 목록 "산책로에서 대일관 1층 복도로", 사용자 그림 13(뒷문), 대일관 노트 출입구', widthM=2))
    return {'id': 'R', 'zone': '밖', 'comment': '대일관 뒤 단과 뒷문, 옆 계단 사슬·뒤편 산책로 높이(S-MAP), 북악관 옆길과 잇기', 'ops': ops}

# ------------------------------------------------------------------ U: 윗길
def group_U():
    u1 = road_by('본관·한림관 사이 지선 ~ 은주관 서쪽 윗길', near=[201107.0, 557270.0], radius=3)
    end = node_at(u1['coordinates'][-1][:2]) if math.hypot(u1['coordinates'][-1][0] - 201112.12, u1['coordinates'][-1][1] - 557211.18) < 1 else node_at([201112.12, 557211.18])
    h, e2 = ENT['한림관 입구'], ENT['은주2관 입구(1)']
    ops = [
        road('한림관 1층 계단', 'pedestrian', '한림관 1층 앞 계단 (앞 길 125.1 → 1층 로비 127.2 m, 12단 안팎 추정)', 'stairs',
             [at_road(u1, [201106.9, 557271.2]), pt(201107.0, 557277.3, h['z'])], '확정(앞 길에서 계단을 올라 1층) + S-MAP(125.1 / 127.0~127.5), 단 수는 추정',
             '사용자 2026-10-10(사진 05·13), 한림관 노트: x 201107 단면에서 y 557270~557272 길 125.0~125.2 → 6 m 오름 → y 557277~557280 평탄 127.0~127.5', widthM=3),
        road('한림관 1층 문', 'pedestrian', '한림관 입구 1층 로비 문 ~ 계단 위 (127.2 m, 문 자리는 학교 표지)', 'ordinary',
             [pt(201107.0, 557277.3, h['z']), pt(*h['xy'], h['z'])], '원천(문·층) + S-MAP(평탄면)', '한림관 노트 출입구', widthM=3),
        road('은주2관 1층 로비 앞', 'pedestrian', '은주관 서쪽 윗길 끝 ~ 은주2관 입구(1) 1층 로비 문 (사용자 S-MAP 핀 131.2 → 131.7 → 132.2 m, 풋살장 쪽으로 이어지는 포장)', 'ordinary',
             [at_node(end)] + [pt(PINS[k]['x'], PINS[k]['y'], PINS[k]['value_m']) for k in ('U034', 'U033')] + [pt(*e2['xy'], e2['z'])],
             '원천(문·층) + S-MAP(사용자 핀 U034·U033·U031, 문 앞 131.8~132.2), 선은 핀을 이은 추정',
             'V02: 윗길 끝 너머 풋살장 쪽 핀 4개(U1-EXT). U031(132.2)이 문 표지에서 0.8 m', widthM=4),
    ]
    b1 = ENT['본관 입구(1)']; p1 = node_at([201032.6, 557302.3], 127.8, 1.0); front = [201060.3, 557302.2]
    line = [front, [201053.8, 557303.6], [201046.7, 557303.2], [201039.6, 557302.7]]
    ops.append(road('본관 입구(1) 앞', 'pedestrian', '본관 입구(1) 문 앞 ~ 본관 남쪽 평탄부 ~ 남서 모서리 P1 분기 (S-MAP 127.4~127.8 m 로 평평. 문 바닥은 모름: 1층과 2층 사이)', 'ordinary',
                    [pt(*b1['xy'], b1['ground'])] + [pt(x, y, ground(x, y)) for x, y in line] + [at_node(p1)],
                    '원천(문) + S-MAP(문 앞 127.8, 평탄부 127.4~127.8), 선은 추정', '본관 노트 출입구(문 앞 지면 127.8). S-MAP 1 m 메시: 문 앞에서 남서 모서리 분기(127.8)까지 28 m 가 0.45 m 안에서 평평, 남쪽은 차도(125.3)로 떨어짐', widthM=3))
    return {'id': 'U', 'zone': '밖', 'comment': '한림관 1층 계단과 문, 은주2관 1층 로비 앞, 본관 입구(1) 앞 평탄부', 'ops': ops}

# ------------------------------------------------------------------ N: 북악관 입구(3)
def group_N():
    top = node_at([201007.65, 557385.84], 133.64, 1.0); side = road_by('북악관 서쪽 옆길 (회차 공간 ~ GS25 문 앞', near=[201004.7, 557386.2], radius=3)
    ops = [road('북악관 입구(3) 계단', 'pedestrian', '북악관 입구(3) 계단 (1층 복도 서쪽 끝 ~ 서쪽 옆길. 보행 기록의 높이차 2.6~2.9 m, 칸 수 모름, 자리 ±7 m)', 'stairs',
                [at_node(top), at_road(side, [201007.65, 557385.84])], '원천(입구(3) = 1층 복도) + 측정(보행 기록 두 번의 높이차) + S-MAP(옆길 지면 131.3~131.5), 자리는 추정',
                '북악관 노트 출입구 입구(3): 계단 있음. 1층 복도의 서쪽 끝(이름 없는 보행 기록 a648c084)이 표지에서 6.9 m', widthM=2)]
    return {'id': 'N', 'zone': '밖', 'comment': '북악관 입구(3): 1층 복도와 서쪽 옆길을 계단으로', 'ops': ops}

# ------------------------------------------------------------------ P: 출입구 장소 표지
BUILDING_ID = {'혜인관': '건물5', '은주1관': '은주관', '은주2관': '은주관#2관', '상승관': '추가-상승관'}
def group_P():
    """학교 캠퍼스맵 '교통 및 출입' 목록 가운데 장소 표지가 없는 것. 자리·높이는 동 노트 머리(없으면 표지 자리의 근거 높이). 장소는 길과 이어지지 않는 표지일 뿐이다."""
    ops = []
    for e in note_entrances():
        n = e['name']
        if '운영 노드' in n or '학교 표지, 자리가' in n or n in ('정문 앞', 'B1 통로와 계단 (본관 쪽에서)') or has_place(n.split(' = ')[0]): continue
        z = e['z'] if e['z'] is not None else e['ground']
        if z is None: continue
        b = e['building']; key = n.split(' ')[0]
        desc = f"N03. {e['floor']}. 높이 {z} m" + ('' if e['z'] is not None else ' = 문 앞 지면(문 바닥은 모름)') + f". 근거 등급: {e['grade']}"
        ops.append(op(f'장소 {n}', 'create_place', {'name': n, 'category': 'building_entrance', 'buildingId': BUILDING_ID.get(key, BUILDING_ID.get(b, b)), 'description': desc[:480],
                                                   'position': pt(*e['xy'], z)}, '원천(위치·층)', '학교 캠퍼스맵 출입구 목록, 동 노트 머리'))
    extra = [('서문(후문) = 서문 주차장 출입구 (옹벽의 터널 입구)', 'landmark', [200984.0, 557399.5], 117.0,
              'N03. 차가 드나드는 서문(사용자 확정). 터널 입구는 북악관 북서쪽 옹벽 면(S-MAP·사진, B08). 학교 표지 (200967.8, 557401.5)·(200969.0, 557402.8)는 옹벽에서 서쪽 16 m 공도 위. 안쪽 지하 차도의 선은 모름이라 길과 잇지 않았다'),
             ('본관–한림관 연결통로 (본관 5층 = 한림관 3층, 실외 나무 데크)', 'landmark', [201098.0, 557302.7], 137.9,
              'N03. 자리 = 사용자 확정 2026-10-11(학교 표지). 높이 137.9 m 는 구조물 파일의 추정(본관 5층 138.1, 한림관 3층 137.8 계산값)')]
    for name, cat, xy, z, desc in extra:
        if not has_place(name.split(' ')[0]): ops.append(op(f'장소 {name}', 'create_place', {'name': name, 'category': cat, 'description': desc, 'position': pt(*xy, z)}, '확정(있음), 자리·높이는 S-MAP 또는 추정', '학교 캠퍼스맵, 사용자 표시'))
    return {'id': 'P', 'zone': '안', 'comment': '출입구 장소 표지(길과 이어지지 않는 표지)', 'ops': ops}

if __name__ == '__main__':
    out = HERE / 'groups'; out.mkdir(exist_ok=True)
    for name in sys.argv[3:]:
        g = globals()[f'group_{name}'](); (out / f'{name}.json').write_text(json.dumps(g, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
        print(name, len(g['ops']), 'ops:', g['comment'])
