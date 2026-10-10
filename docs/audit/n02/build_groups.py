"""N02: 시험용 DB에 넣을 편집 묶음을 만든다(읽기 전용, 파일만 씀). 지금 상태(n02.ts state 결과)의 개정 번호를 읽어 쓴다.
  python build_groups.py STATE.json GROUP [GROUP...]      -> groups/<GROUP>.json  (n02.ts apply 로 적용)
묶음: P 포장면 둘레(지상 횡단 길 거둠, 오르막 보행로·갈림 계단 높이, 본관 입구(2), 버스 표지·횡단보도, 회차 공간 차도 끝), P2 남쪽 버스 표지 앞 노드,
      Z1.. 북악관 실내 길 높이 옮기기(노드), V1.. 같은 것(길 안쪽 꼭짓점), U 지하 횡단보도·통로·계단, G 서쪽 옆길·GS25 문·정문 계단·장소,
      L1.. 북악관 층 표기, Y 유담관 6층 로비 문 앞.
높이 근거: S-MAP 1 m·2 m 메시와 표고 조회(볼트 n02/smap-elevation-raw.json), B10 층 표(docs/audit/b10/results.json)."""
import sys, json, pathlib
HERE = pathlib.Path(__file__).parent
S = json.load(open(sys.argv[1], encoding='utf-8'))
ROADS = {r['id']: r for r in S['roads']}; NODES = {n['id']: n for n in S['nodes']}
def rid(p):
    m = [i for i in ROADS if i.startswith(p)]; assert len(m) == 1, (p, m); return m[0]
def nid(p):
    m = [i for i in NODES if i.startswith(p)]; assert len(m) == 1, (p, m); return m[0]
def rev(p): return ROADS[rid(p)]['revision']
def nxy(p): return NODES[nid(p)]['coordinate'][:2]
def by_name(prefix):
    m = [r for r in S['roads'] if (r['name'] or '').startswith(prefix)]; assert len(m) == 1, (prefix, len(m)); return m[0]
def retire(p, ref): return {'ref': ref, 'op': 'retire_feature', 'args': {'type': 'road', 'id': rid(p), 'expectedRevision': rev(p)}}
def move(p, z, ref, xy=None): return {'ref': ref, 'op': 'move_node', 'args': {'nodeId': nid(p), 'to': {'xy': xy or nxy(p), 'z': z}}}
def pt(x, y, z): return {'xy': [x, y], 'z': z}
def at_node(p): return {'at': {'nodeId': nid(p)}}
def road(ref, cls, name, path, **attrs): return {'ref': ref, 'op': 'create_road', 'args': {'roadClass': cls, 'name': name, **attrs, 'path': path, 'zMode': 'explicit', 'densify': False}}
def vmoves(p, zs):
    """zs: {vertexIndex: z}"""
    c = ROADS[rid(p)]['coordinates']
    return [{'op': 'move', 'index': i, 'point': pt(c[i][0], c[i][1], z)} for i, z in sorted(zs.items())]

# ---- 북악관 층 표 (B10): 저장된 높이 -> 층 표 높이 ----
KNOTS = [(132.8, 130.5), (136.7, 134.1), (140.6, 138.0), (143.47, 140.9), (146.18, 143.6), (148.92, 146.3), (151.79, 149.2), (154.51, 152.5)]
def fz(z):
    if z <= KNOTS[0][0]: return round(z - 2.3, 2)
    if z >= KNOTS[-1][0]: return round(z - 2.01, 2)
    for (a, ta), (b, tb) in zip(KNOTS, KNOTS[1:]):
        if a <= z <= b: return round(ta + (z - a) / (b - a) * (tb - ta), 2)
B10_ROADS = json.load(open(HERE.parent / 'b10' / 'results.json', encoding='utf-8'))['proposals']['new'][0]['roadIds']
SPECIAL = {'18b2d87e': 129.7, '3c4d5560': 130.5}   # B1 계단(f99540e3): 아래 129.7(129.5~129.9), 위 130.5 (4~6칸)

def group_P():
    ops = [
        retire('6b695a7c', 'N01 지상 횡단 길(본관 모서리 앞~횡단보도) 거둠'), retire('dc9e833a', 'N01 지상 횡단 길(횡단보도~통로~계단 아래) 거둠'),
        retire('c738cda0', 'N01 지상 횡단보도~오르막 아래 끝 거둠'), retire('d5d8cd64', '회차 공간 차도 끝 5.7 m 거둠(보행 기록 옆 겹침)'),
        move('4f294196', 141.0, '오르막 위 끝 141.73 -> S-MAP 141.0'),
        {'ref': '오르막 보행로 c52095ad: S-MAP 높이, 포장면까지 늘임, 폭 9 m', 'op': 'update_road', 'args': {'id': rid('c52095ad'), 'expectedRevision': rev('c52095ad') + 1,
          'attrs': {'name': '문예관 옆 오르막 보행로 (보행. 공사 차량만 제한 통행, 입구 차단기. 높이 S-MAP)', 'widthM': 9},
          'path': [at_node('4f294196'), pt(201103.5, 557326.0, 140.4), pt(201094.0, 557330.4, 138.8), pt(201085.8, 557334.2, 137.5), pt(201076.3, 557338.7, 135.8),
                   pt(201066.3, 557343.3, 134.2), pt(201056.8, 557347.8, 132.8), pt(201050.5, 557348.9, 132.1), pt(201044.2, 557350.0, 131.4)], 'zMode': 'explicit', 'densify': False}},
        move('3df2b596', 144.3, '갈림 지점 142.44 -> S-MAP 144.3'), move('85a0ed07', 144.1, '갈림 동쪽 평탄부 끝 -> S-MAP 144.1'),
        move('b5e0b6b5', 144.3, '갈림 북쪽 평탄부 끝 -> S-MAP 144.2~144.3'), move('59f9ab35', 145.6, '문예관 입구 방향 계단 위 143.80 -> S-MAP 145.6'),
        {'ref': '갈림 계단 040d4571 안쪽 꼭짓점 S-MAP', 'op': 'update_road', 'args': {'id': rid('040d4571'), 'expectedRevision': rev('040d4571') + 2,
          'vertexOps': vmoves('040d4571', {1: 144.2, 2: 143.3, 3: 142.5, 4: 141.7}), 'zMode': 'explicit', 'densify': False}},
        road('본관 입구(2) 문 앞', 'pedestrian', '본관 입구(2) 문 앞 ~ 본관 모서리 앞 계단 위 (포장면 가장자리, 문 자리는 학교 표지)', [at_node('e13a5ce2'), pt(201041.6, 557338.6, 130.8)]),
        road('북쪽 버스 표지~횡단보도', 'pedestrian', '회차 공간 서쪽 가장자리 ~ 횡단보도 (북쪽 버스 정류장 표지에서, 사용자 그림 11 의 흰 띠, 위치 ±3 m)',
             [pt(201006.2, 557363.7, 130.6), pt(201005.8, 557348.3, 130.6), pt(201026.9, 557354.2, 131.0)]),
        {'ref': '회차 공간 차도 b30c65f1 폭', 'op': 'update_road', 'args': {'id': rid('b30c65f1'), 'expectedRevision': rev('b30c65f1'),
          'attrs': {'widthM': 14, 'name': '본관 서쪽 회차 공간 내리막 (P1 분기 ~ 회차 공간 평탄부 남쪽 끝) (S-MAP 판독. 포장 폭 13~28 m 가운데 좁은 곳 값)'}}},
    ]
    return {'id': 'P', 'title': '포장면 둘레: 지상 횡단 길 거둠, 오르막 보행로·갈림 계단 높이, 본관 입구(2), 버스 표지·횡단보도, 회차 공간 차도 끝', 'ops': ops}

def group_P2():
    r = by_name('본관 서쪽 회차 공간 내리막')
    return {'id': 'P2', 'title': '남쪽 버스 정류장 표지 앞에서 회차 공간 차도를 나눔(표지에서 2.3 m)', 'ops': [
        {'ref': '남쪽 버스 표지 앞 노드', 'op': 'split_road', 'args': {'roadId': r['id'], 'expectedRevision': r['revision'], 'nearest': [201018.0, 557335.2]}}]}

def bukak_nodes():
    ids = {}
    for r in B10_ROADS:
        x = ROADS[r]
        for n in (x['fromNodeId'], x['toNodeId']): ids[n] = NODES[n]['coordinate']
    out = []
    for n, c in sorted(ids.items(), key=lambda kv: kv[1][2]):
        z = SPECIAL.get(n[:8], fz(c[2]))
        out.append({'ref': f'{n[:8]} {c[2]} -> {z}', 'op': 'move_node', 'args': {'nodeId': n, 'to': {'xy': c[:2], 'z': z}}})
    return out
def group_Z(k):
    ops = bukak_nodes(); return {'id': f'Z{k}', 'title': f'북악관 실내 길 높이 옮기기: 노드 (B10-1), {k}번째 묶음 (전체 {len(ops)})', 'ops': ops[(k - 1) * 24:k * 24]}
def bukak_vertices():
    """argv[1] = current state (revisions); heights come from the state before N02 (same folder, 01-state-before.json)."""
    orig = {r['id']: r for r in json.load(open(pathlib.Path(sys.argv[1]).parent / '01-state-before.json', encoding='utf-8'))['roads']}
    moved = {n for r in B10_ROADS for n in (orig[r]['fromNodeId'], orig[r]['toNodeId'])}
    todo = [r for r, x in orig.items() if r in ROADS and (r in B10_ROADS or (x['fromNodeId'] in moved and x['toNodeId'] in moved))]
    out = []
    for r in todo:
        x = ROADS[r]; c0 = orig[r]['coordinates']; c = x['coordinates']
        if r[:8] in ('f99540e3', '05378724', '8fde6a04'): continue
        assert len(c) == len(c0), r
        zs = {i: fz(c0[i][2]) for i in range(1, len(c) - 1) if abs(fz(c0[i][2]) - c[i][2]) > 0.005}
        if zs: out.append({'ref': f"{r[:8]} 안쪽 꼭짓점 {len(zs)}개", 'op': 'update_road', 'args': {'id': r, 'expectedRevision': x['revision'], 'vertexOps': vmoves(r[:8], zs), 'zMode': 'explicit', 'densify': False}})
    return out
def group_V(k):
    ops = bukak_vertices(); return {'id': f'V{k}', 'title': f'북악관 실내 길 높이 옮기기: 길 안쪽 꼭짓점 (B10-1), {k}번째 묶음 (전체 {len(ops)})', 'ops': ops[(k - 1) * 24:k * 24]}

def strip(): return by_name('지하 차도 보행 구간')
def group_U1():
    return {'id': 'U1', 'title': '지하 높이(보행 기록의 가장 낮은 곳 128.4~128.7 m): 본관 쪽 계단 아래·지하 차도 아래 끝 126.82 -> 128.5, B1 진입 계단 이름·구조', 'ops': [
        move('2b5185cc', 128.5, '본관 쪽 계단 아래(보행 구간 서쪽 끝) 126.82 -> 128.5 (추정 127.8~128.7)'),
        move('81ff89df', 128.5, '지하 차도 951c157d 아래 끝 126.82 -> 128.5 (추정)'),
        {'ref': 'f99540e3 이름', 'op': 'update_road', 'args': {'id': rid('f99540e3'), 'expectedRevision': rev('f99540e3'), 'attrs': {'name': '북악관 B1 진입 계단 (4~6칸 올라감, 129.7 → 130.5 m. 높이 추정)'}}},
        {'ref': '05378724 계단 -> 평지 통로', 'op': 'update_road', 'args': {'id': rid('05378724'), 'expectedRevision': rev('05378724'), 'attrs': {'structure': 'indoor_corridor', 'name': '북악관 B1 진입 통로 (계단 위, 평지 130.5 m. 추정)'}}},
    ]}
def group_U2():
    st = strip(); c = st['coordinates']
    low = {i: 128.5 for i in range(1, len(c) - 1) if c[i][2] < 128.5}
    ve = ROADS[rid('951c157d')]; cv = ve['coordinates']
    lowv = {i: 128.6 for i in range(1, len(cv) - 1) if cv[i][2] < 128.6}
    x = ROADS[rid('8fde6a04')]
    return {'id': 'U2', 'title': '지하 횡단보도·통로: 8fde6a04 를 보행 길로 바꾸고 그림 14 의 자리로(보행 구간 ~ 횡단보도 ~ 통로 ~ B1 계단 아래)', 'ops': [
        {'ref': '보행 구간 서쪽 꼭짓점 128.5', 'op': 'update_road', 'args': {'id': st['id'], 'expectedRevision': st['revision'], 'vertexOps': vmoves(st['id'][:8], low), 'zMode': 'explicit', 'densify': False}},
        {'ref': '지하 차도 아래쪽 꼭짓점 128.6', 'op': 'update_road', 'args': {'id': ve['id'], 'expectedRevision': ve['revision'], 'vertexOps': vmoves('951c157d', lowv), 'zMode': 'explicit', 'densify': False}},
        {'ref': '8fde6a04 -> 지하 횡단보도·통로(보행)', 'op': 'update_road', 'args': {'id': x['id'], 'expectedRevision': x['revision'],
          'attrs': {'roadClass': 'pedestrian', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'name': '북악관 B1 가는 지하 횡단보도·통로 (본관 쪽 보행 구간 ~ 지하 차도 건넘 ~ 통로 ~ 계단 아래. 사용자 그림 14, 위치 ±2 m·높이 추정)'},
          'path': [{'at': {'roadId': st['id'], 'measureM': 3.0}}, pt(201045.7, 557350.6, 128.6), pt(201047.5, 557354.3, 128.9), pt(201046.9, 557359.8, 129.4), at_node('18b2d87e')], 'zMode': 'explicit', 'densify': False}},
    ]}
def group_G():
    b = {'buildingId': '북악관'}
    return {'id': 'G', 'title': '북악관 서쪽 옆길, GS25 문과 문 안 계단(B10-3·4), 정문 계단, 장소(B10-5·6, B08-7)', 'ops': [
        road('옆길 남쪽', 'pedestrian', '북악관 서쪽 옆길 (회차 공간 ~ GS25 문 앞. 포장 폭 약 6 m, 높이 S-MAP)', [pt(201004.5, 557384.5, 131.3), pt(201005.0, 557388.0, 131.4), pt(201006.5, 557395.0, 131.7)], widthM=6),
        road('옆길 북쪽', 'pedestrian', '북악관 서쪽 옆길 (GS25 문 앞 ~ 북서 모서리. 뒤편 산책로와는 아직 안 이음, 높이 S-MAP)', [pt(201006.5, 557395.0, 131.7), pt(201009.0, 557403.0, 132.2), pt(201012.0, 557411.0, 132.9)], widthM=6),
        road('GS25 문 앞', 'pedestrian', '북악관 입구(4) GS25 문 앞 (옆길 ~ 문)', [pt(201006.5, 557395.0, 131.7), pt(201008.5, 557395.0, 131.7)]),
        road('B10-4', 'pedestrian', 'GS25 문 안 계단 (문 ~ B1 복도, 6~9칸 내려감. 평면·계단 길이 추정)', [pt(201008.5, 557395.0, 131.7), pt(201009.6, 557395.2, 130.5)], structure='stairs', **b),
        road('B10-3', 'pedestrian', '북악관 B1 복도 서쪽 끝 ~ GS25 문 안 계단 아래 (평지 130.5 m, 추정)', [pt(201009.6, 557395.2, 130.5), at_node('f645a7b9')], structure='indoor_corridor', **b),
        road('정문 계단', 'pedestrian', '북악관 정문 계단 (바깥 12칸 + 안쪽 5칸 = 17칸, 131.4 → 1층 134.1 m. 칸 수 확정, 높이 추정)',
             [pt(201039.5, 557360.5, 131.4), pt(201041.5, 557365.0, 133.3), pt(201043.7, 557368.7, 133.3), at_node('596405f1')], structure='stairs', **b),
        {'ref': 'B10-5', 'op': 'create_place', 'args': {'name': '편의점 (북악관 B1)', 'category': 'facility', 'buildingId': '북악관', 'description': 'B10-5. 계단을 올라 바로 좌회전하면 있다(사용자 확정). 위치 추정 ±10 m(네이버 GS25 표지는 여기서 2.5 m). 높이 B1 130.5 m 추정', 'position': pt(201048.1, 557381.1, 130.5)}},
        {'ref': 'B10-6', 'op': 'create_place', 'args': {'name': '라운지 (북악관 B1)', 'category': 'facility', 'buildingId': '북악관', 'description': 'B10-6. 계단을 올라 바로 좌회전하면 있다(사용자 확정). 위치 추정 ±10 m. 높이 B1 130.5 m 추정', 'position': pt(201046.5, 557381.3, 130.5)}},
        {'ref': 'B08-7', 'op': 'create_place', 'args': {'name': '북악관 입구(4) = GS25 출입구', 'category': 'building_entrance', 'buildingId': '북악관', 'description': 'B08-7. B1층 입구(사용자 확정). 문 앞 지면 131.7 m(S-MAP), 문 안에서 6~9칸 내려가 B1 130.5 m. 위치는 학교 표지를 서쪽 끝 벽 앞으로 옮긴 자리(±2 m)', 'position': pt(201008.5, 557395.0, 131.7)}},
    ]}

LEVELS = {'북악관_Z143.47_추정': '북악관_3F_추정', '북악관_Z146.18_추정': '북악관_5F_추정', '북악관_Z148.92_추정': '북악관_6F_추정', '북악관_Z151.79_추정': '북악관_7F_추정', '북악관_Z154.51_추정': '북악관_8F_추정'}
def level_ops():
    return [{'ref': f"{r['id'][:8]} {r['levelId']} -> {LEVELS[r['levelId']]}", 'op': 'update_road', 'args': {'id': r['id'], 'expectedRevision': r['revision'], 'attrs': {'levelId': LEVELS[r['levelId']]}}}
            for r in sorted(S['roads'], key=lambda r: (r['levelId'] or '', r['id'])) if r['levelId'] in LEVELS]
def group_L(k):
    ops = level_ops(); return {'id': f'L{k}', 'title': f'북악관 층 표기 (B10-2): 높이가 든 이름을 층 이름으로, {k}번째 묶음 (전체 {len(ops)})', 'ops': ops[(k - 1) * 24:k * 24]}

def group_Y():
    return {'id': 'Y', 'title': '유담관 입구(1) 6층 로비 문 앞(분수 광장 114.1 m) 노드. 차도와는 잇지 않음(보행 길 근거 없음)', 'ops': [
        road('유담관 6층 문 앞', 'pedestrian', '유담관 입구(1) 6층 로비 문 앞 ~ 분수 광장 (114.1 m, 문 자리는 학교 표지. 차도와 안 이음)', [pt(201057.2, 557234.5, 114.1), pt(201060.5, 557231.5, 114.1)]),
        {'ref': '유담관 입구(1)', 'op': 'create_place', 'args': {'name': '유담관 입구(1) = 6층 로비 (분수 광장)', 'category': 'building_entrance', 'buildingId': '유담관',
          'description': 'N02. 분수 광장 높이 = 6층(사용자 확정). 바닥 114.1 m(S-MAP 광장 평탄면). 광장과 차도(주 진입로 하부)는 잇지 않았다: 차도가 광장 높이를 지나는 자리(201084~201088, 557218~557222)에서 S-MAP 지면은 114.0~114.2 m 로 이어지지만 보행 길이 있다는 근거가 없다', 'position': pt(201057.2, 557234.5, 114.1)}},
    ]}

if __name__ == '__main__':
    for g in sys.argv[2:]:
        base = g.rstrip('0123456789')
        grp = globals()['group_' + g]() if 'group_' + g in globals() else globals()['group_' + base](int(g[len(base):]))
        (HERE / 'groups').mkdir(exist_ok=True)
        json.dump(grp, open(HERE / 'groups' / f'{g}.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(g, len(grp['ops']), 'ops')
