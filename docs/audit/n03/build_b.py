"""N03b: 사용자 확정 두 가지(2026-10-11)를 시험용 DB 편집 묶음과 구조물 파일로. DB 접근 없음.
  python -I build_b.py STATE.json AREAS.json D|S|C|structures
  D  본관 5층–한림관 3층 데크를 지하 보행 구간의 높이로 내리고 보행 구간을 데크까지 늘여 잇기(높이 차 없음, 계단 없음: 확정)
  S  정문 ~ 제2주차장 차도 양쪽 인도 두 줄(보행 허용, 선은 추정), 제2주차장 위쪽 차도와 한림관 1층 가는 길의 보행 허용
  C  인도와 차도 갈림 노드를 잇는 횡단(인도가 저장된 뒤의 상태로 만든다)
  E  유담관 6층 ↔ 9층 임시 승강기 하나(자리표), H  청운관 좌우 계단과 1층 현관
  structures  frontend/public/structures/n03b-sidewalks.geojson (인도 띠 = 얇은 포장 상자, 지형에는 싣지 않는다)
인도 자리: 차도 가운데 선에서 양쪽 4.25 m (Z03 판독: 차도 약 7 m + 보도 약 1.5 m), 폭 1.5 m. 높이는 그 자리 차도 종단(V02)과 같다."""
import sys, json, math, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import build_groups as B
from build_groups import *
from shapely.geometry import LineString, Point

OFFSET, SW_W = 4.25, 1.5
CHAIN = ['정문 진입로', '주 진입로 하부', '주 진입로 하부', '주 경사로 상부 = S06']
def centreline():
    """정문(공도 분기) → 본관 남서 모서리 P1 분기까지 차도 가운데 선(꼭짓점 x, y, z)과 지나는 노드."""
    gate = node_at([201134.83, 557097.35]); end = node_at([201032.6, 557302.3], None, 1.0)
    roads = [r for r in S['roads'] if r['roadClass'] == 'vehicle' and any((r['name'] or '').startswith(k) for k in CHAIN)]
    cur, pts, nodes = gate, [], [gate]
    while cur != end:
        r = next(r for r in roads if cur in (r['fromNodeId'], r['toNodeId'])); roads.remove(r)
        c = r['coordinates'] if r['fromNodeId'] == cur else r['coordinates'][::-1]
        pts += c if not pts else c[1:]; cur = r['toNodeId'] if r['fromNodeId'] == cur else r['fromNodeId']; nodes.append(cur)
    return pts, nodes
def side_line(pts, sign):
    """가운데 선에서 sign(+1 진행 방향 왼쪽, −1 오른쪽)으로 OFFSET 만큼 옮긴 선. 3 m 마다 꼭짓점, 높이는 가운데 선의 가장 가까운 자리."""
    cl = LineString([(p[0], p[1]) for p in pts]); off = cl.offset_curve(sign * OFFSET, join_style=1)
    if off.geom_type != 'LineString': off = max(off.geoms, key=lambda g: g.length)
    cum = [0.0]
    for a, b in zip(pts, pts[1:]): cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    def zat(s):
        for i in range(1, len(cum)):
            if s <= cum[i] or i == len(cum) - 1:
                t = 0 if cum[i] == cum[i - 1] else max(0, min(1, (s - cum[i - 1]) / (cum[i] - cum[i - 1]))); return pts[i - 1][2] + t * (pts[i][2] - pts[i - 1][2])
    n = int(off.length // 3); out = []
    for k in range(n + 1):
        q = off.interpolate(k * off.length / n); s = cl.project(q)
        if 3.0 <= s <= cl.length - 3.0: out.append([round(q.x, 2), round(q.y, 2), round(zat(s), 2)])
    return out
SIDES = [(+1, '서쪽'), (-1, '동쪽')]   # 정문에서 북으로 오르므로 진행 방향 왼쪽이 서쪽(분수 광장 쪽)
EV_SW = '사용자 확정 2026-10-11: 정문에서 올라오는 차도 양쪽에 인도가 있고 제2주차장 전까지는 인도로 걷는다. 자리: Z03 판독(차도 약 7 m + 보도 약 1.5 m), 그 밖의 구간은 같은 치수를 늘인 추정'

def group_D():
    m1 = node_at([201098.53, 557302.41], None, 0.5); w = node_at([201096.42, 557303.56], None, 0.5); e = node_at([201100.63, 557301.25], None, 0.5)
    strip_end = node_at([201083.5, 557329.7], None, 1.0); zd = ground(201098.5, 557302.4)
    ev = '사용자 확정 2026-10-11: 데크는 지하 보행 구간에서 바로 이어진다(계단 없음, 높이 차 없음). 높이 = 그 자리 보행 구간의 높이 = S-MAP 1 m 메시의 땅(130.4~131.0 m). 앞의 137.9 m(본관 5층 계산값)는 틀렸다'
    ops = []
    for r in S['roads']:
        if (r['name'] or '').startswith('본관 5층–한림관 3층 연결통로'):
            ops.append(op(f"데크 이름 {r['id'][:8]}", 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'attrs': {'name': r['name'].split(' 137.9')[0].rstrip('.') + f'. {zd:.1f} m = 지하 보행 구간과 같은 높이: 확정)'}}, '확정(높이 차 없음)', ev))
    for n, what in ((w, '데크 본관 쪽 문'), (m1, '데크 가운데'), (e, '데크 한림관 쪽 문')): ops.append(move(f'{what} {nz(n):.1f} → {zd:.2f}', n, zd, '확정(보행 구간과 같은 높이) + S-MAP(값)', ev))
    line = [(201106.0, 557311.8), (201104.9, 557310.2), (201103.8, 557308.5), (201102.6, 557306.9), (201101.5, 557305.3), (201100.4, 557303.6)]
    ops.append(road('보행 구간 연장', 'pedestrian', '지하 차도 보행 구간 연장 (본관 북쪽 벽 ~ 북동 모서리 ~ 본관·한림관 사이 ~ 데크. 이어짐·높이 차 없음은 확정, 선은 추정)', 'ordinary',
                    [at_node(strip_end), pt(201092.7, 557325.2, 135.0), pt(201101.9, 557320.6, 136.4)] + [pt(x, y, ground(x, y)) for x, y in line] + [at_node(m1)],
                    '확정(바로 이어짐), 선은 추정, 높이는 구조물 빈 곳 바닥(134.3~135.35)·지하 차도 위 끝 136.4·S-MAP 메시(135.6 → 130.7)',
                    ev + '. 선: 본관 북쪽 벽을 따라 지하 차도 옆으로 북동 모서리까지, 모서리를 돌아 본관 동쪽 벽과 한림관 사이 비탈을 내려가 데크', widthM=2))
    for p in S['places']:
        if p['name'].startswith('본관–한림관 연결통로'):
            ops.append(op('장소 본관–한림관 연결통로 높이', 'update_place', {'id': p['id'], 'expectedRevision': p['revision'], 'position': pt(201098.0, 557302.7, zd),
                          'description': f'N03b. 자리 = 사용자 확정(학교 표지). 높이 {zd:.1f} m = 지하 보행 구간과 같은 높이(사용자 확정 2026-10-11: 바로 이어진다). 본관 5층·한림관 3층 계산값(138.1 / 137.8)과 맞지 않는 것은 동 노트에 적음'}, '확정', ev))
    return {'id': 'D', 'zone': '안', 'comment': '본관–한림관 데크를 지하 보행 구간의 높이로, 보행 구간을 데크까지 늘여 잇기', 'ops': ops}

def group_S():
    pts, nodes = centreline(); ops = []
    for sign, side in SIDES:
        ln = side_line(pts, sign)
        ops.append(road(f'인도 {side}', 'pedestrian', f'정문 ~ 제2주차장 차도 {side} 인도 (차도 가운데 선에서 {OFFSET} m, 폭 {SW_W} m. 있다는 것은 확정, 선은 추정)', 'sidewalk',
                        [at_node(nodes[0])] + [pt(*p) for p in ln] + [at_node(nodes[-1])], '확정(양쪽 인도, 걷는 길), 선·폭은 추정', EV_SW, widthM=SW_W))
    free = '사용자 확정 2026-10-11: 제2주차장 위쪽 공간은 사람들이 자유롭게 다닌다'
    for r in S['roads']:
        n = r['name'] or ''
        if r['pedestrianAccess'] == 'allowed': continue
        if n.startswith('본관 서쪽 회차 공간 내리막') or n.startswith('P1 주차장 차로'):
            ops.append(op(f"보행 허용 {r['id'][:8]} {n[:24]}", 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'attrs': {'roadClass': 'shared', 'pedestrianAccess': 'allowed'}}, '확정(자유 보행)', free + '. 기운 포장면이라 영역(한 높이)으로 못 만들고 폭을 준 길에 보행 허용을 준다'))
        if n.startswith('본관·한림관 사이 지선') and math.hypot(r['coordinates'][0][0] - 201080.26, r['coordinates'][0][1] - 557265.61) < 1 and r['lengthM'] < 40:
            ops.append(op(f"보행 허용 {r['id'][:8]} 한림관 1층 가는 길", 'update_road', {'id': r['id'], 'expectedRevision': r['revision'], 'attrs': {'roadClass': 'shared', 'pedestrianAccess': 'allowed'}}, '확정(한림관 1층으로 걸어가는 차도와 계단)', '사용자 2026-10-10(B06: 한림관 1층으로 가는 차도와 계단, 사진 05·13)'))
    ops = ops[2:] + ops[:2]   # 보행 허용을 먼저: 인도가 저장되면 만나는 길이 조각으로 바뀐다
    return {'id': 'S', 'zone': '밖', 'comment': '정문 ~ 제2주차장 차도 양쪽 인도, 제2주차장 위쪽과 한림관 1층 가는 길의 보행 허용', 'ops': ops}

def group_C():
    """인도가 차도 갈림 노드와 만나는 자리의 횡단: 분수 광장 출입 자리(4ee2e962), 굽이(7e93e170), 하단 주차장 차로 분기(3660818d)."""
    walks = [r for r in S['roads'] if (r['name'] or '').startswith('정문 ~ 제2주차장 차도')]
    def piece(side, xy): return min((r for r in walks if side in r['name']), key=lambda r: LineString([(p[0], p[1]) for p in r['coordinates']]).distance(Point(xy)))
    ops = []
    for xy, what in (([201124.92, 557122.98], '하단 주차장 차로 분기'), ([201089.13, 557218.5], '분수 광장 출입 자리'), ([201080.26, 557265.61], '유담관·한림관 굽이')):
        n = node_at(xy, None, 1.0)
        ops.append(road(f'횡단 {what}', 'pedestrian', f'차도 횡단: {what} (서쪽 인도 ~ 차도 ~ 동쪽 인도. 횡단보도 표시가 있는지는 모름)', 'crossing',
                        [at_road(piece('서쪽', xy), xy), at_node(n), at_road(piece('동쪽', xy), xy)], '추정(양쪽 인도를 오가는 자리)', EV_SW + '. 횡단 자리는 갈림 노드에 둔 추정', widthM=3))
    import os
    if os.environ.get('N03B_ONE'): ops = [ops[int(os.environ['N03B_ONE'])]]   # 횡단 하나가 인도를 나누면 다음 횡단이 가리킬 조각 id 가 바뀌므로 하나씩 만든다
    return {'id': 'C', 'zone': '밖', 'comment': '인도와 차도 갈림 노드를 잇는 횡단 셋', 'ops': ops}

def structures():   # Z12: 유담관 옆 구간(북좌표 557180 ~ 굽이)의 마디 상자는 docs/audit/z12/build_parts.py 가 걷어 내고 기운 판으로 다시 만든다. 이 함수를 다시 돌린 뒤에는 그 스크립트도 다시 돌릴 것
    pts, _ = centreline(); feats = []
    for sign, side in SIDES:
        ln = side_line(pts, sign); tag = 'W' if sign > 0 else 'E'
        for k in range(0, len(ln) - 1, 2):     # 약 6 m 마디마다 평평한 윗면(형식 문서: 경사진 윗면은 마디로 자른다)
            seg = ln[k:k + 3]
            if len(seg) < 2: continue
            poly = LineString([(p[0], p[1]) for p in seg]).buffer(SW_W / 2, cap_style=2, join_style=2); z = sum(p[2] for p in seg) / len(seg)
            feats.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [[[round(x, 2), round(y, 2)] for x, y in poly.exterior.coords]]},
                          'properties': {'id': f'N03B-SIDEWALK-{tag}{k // 2:02d}', 'kind': 'extrude', 'type': 'landing', 'name': f'정문 ~ 제2주차장 차도 {side} 인도', 'fromM': round(z - 0.3, 2), 'toM': round(z + 0.15, 2),
                                         'basePlane': '차도 포장 띠(V02 종단)', 'material': 'paving', 'grade': '확정(양쪽 인도가 있음), 추정(자리·폭·턱 높이)', 'estimated': True,
                                         'assumption': f'차도 가운데 선에서 {OFFSET} m, 폭 {SW_W} m, 턱 0.15 m. Z03 판독(차도 약 7 m + 보도 약 1.5 m)을 정문부터 제2주차장 분기까지 늘임', 'source': '사용자 확정 2026-10-11, 시험용 DB 인도 길, docs/audit/v02 종단'}})
    fc = {'type': 'FeatureCollection', 'name': 'n03b-sidewalks', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}},
          'provenance': {'script': 'docs/audit/n03/build_b.py structures', 'note': '인도 띠는 폭이 지형 격자 한 칸보다 좁아 지형 조리법에 싣지 않는다(상자만)'}, 'features': feats}
    (REPO / 'frontend/public/structures/n03b-sidewalks.geojson').write_text(json.dumps(fc, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n'); print('structures', len(feats))

def group_E():
    """유담관 6층 ↔ 9층 임시 승강기 하나(사용자 확정 2026-10-11: 승강기 6대와 계단, 대부분 6층·9층에 선다. 낱낱의 승강기·계단은 사용자 동선 기록 뒤). 자리는 추정."""
    lobby = node_at([201060.5, 557231.5], 114.1, 0.5); hall = node_at([201040.0, 557275.0], 129.6, 0.5); z9 = nz(hall)
    ev = '사용자 확정 2026-10-11(유담관 노트): 승강기 6대와 계단이 있고 6층 ↔ 9층은 대부분의 승강기로 오간다. 어느 승강기가 어디 서는지와 자리는 사용자 동선 기록 뒤에 정한다'
    ops = [
        road('유담관 임시 승강기', 'pedestrian', '유담관 6층–9층 승강기 (임시 자리표: 6층 로비 안쪽에 하나만 둠. 실제 승강기 6대·계단의 자리는 동선 기록 뒤 교체)', 'elevator',
             [at_node(lobby), pt(*nxy(lobby), z9)], '확정(6층 ↔ 9층을 승강기로 오감), 자리는 추정', ev, buildingId='유담관'),
        road('유담관 임시 9층 연결', 'pedestrian', '유담관 9층 승강기 앞 ~ 9층 홀 (임시 자리표: 위 임시 승강기를 9층 홀에 잇는 선. 동선 기록 뒤 교체)', 'indoor_corridor',
             [pt(*nxy(lobby), z9), at_node(hall)], '추정(임시 연결선)', ev + '. 9층 높이는 이미 있는 9층 홀 노드(129.6 m, 노트의 9층 128.4~129.6)를 그대로 씀', buildingId='유담관'),
    ]
    return {'id': 'E', 'zone': '안', 'comment': '유담관 6층 ↔ 9층 임시 승강기 하나와 9층 홀까지의 임시 연결선', 'ops': ops}

def group_H():
    """청운관(사용자 확정 2026-10-11, Z05 노트): 운동장 높이 문은 지하 1층, 1층 로비 문은 열린 기둥부의 좌우 계단이 만나는 한 층 위 현관(153.1 m 추정). 계단 자리는 구조물 파일 z05-cheongun."""
    e = ENT['청운관 입구(1층, 현관 위)']; ops = []; F = json.loads((REPO / 'frontend/public/structures/z05-cheongun.geojson').read_text(encoding='utf-8'))['features']
    def centre(i):
        g = next(f for f in F if f['properties']['id'] == i)['geometry']['coordinates'][0][:-1]; return [sum(q[0] for q in g) / len(g), sum(q[1] for q in g) / len(g)]
    top = centre('Z05-CHEONGUN-PORCH-LANDING'); ev = '사용자 확정 2026-10-11(청운관 노트): 좌우 계단은 한 층 위 1층 로비 앞 현관에서 만난다. 계단 자리·단 수는 구조물 파일 z05-cheongun(사진 16·23, 추정), 현관 높이 153.1 m 는 S-MAP'
    old = road_by('청운관 1층 입구(학교 표지) ~ 운동장')
    ops.append(op('청운관 운동장 쪽 문 이름', 'update_road', {'id': old['id'], 'expectedRevision': old['revision'], 'attrs': {'name': '청운관 운동장 쪽 문(지하 1층, 148.9 m) ~ 운동장 (열린 기둥부 아래. 문 자리는 모름, 학교 표지 자리에 둠)'}},
                  '확정(운동장 높이 문 = 지하 1층), 측정(148.9), 문 자리는 추정', '사용자 확정 2026-10-11. N03 에서는 이 문을 1층으로 잘못 적었다'))
    ops.append(road('청운관 1층 현관', 'pedestrian', '청운관 1층 현관 (좌우 계단 위 참 ~ 1층 로비 문, 153.1 m 추정. 문 자리는 학교 표지)', 'ordinary', [pt(*top, e['z']), pt(*e['xy'], e['z'])], '확정(계단 위 현관), 높이·자리는 추정', ev, widthM=3))
    for tag, side in (('L', '왼쪽(서)'), ('R', '오른쪽(동)')):
        foot = centre(f'Z05-CHEONGUN-PORCH-STAIR-{tag}-S01'); a = pt(*(foot if NET._on([FRING], foot) else into_field(foot, 0.6)), FZ)
        ops.append(road(f'청운관 {side} 계단', 'pedestrian', f'청운관 열린 기둥부 {side} 계단 (운동장 148.9 → 1층 현관 153.1 m, 26단 추정)', 'stairs', [a, pt(*top, e['z'])], '확정(좌우 계단이 현관에서 만남), 자리·단 수는 추정', ev, widthM=2))
    return {'id': 'H', 'zone': '안', 'comment': '청운관: 운동장 높이 문은 지하 1층으로 고쳐 적고, 좌우 계단과 1층 현관 문을 잇기', 'ops': ops}

if __name__ == '__main__':
    what = sys.argv[3]
    if what == 'structures': structures()
    else:
        g = globals()[f'group_{what}'](); (HERE / 'groups' / f'b{what}.json').write_text(json.dumps(g, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(what, len(g['ops']), g['comment'])
