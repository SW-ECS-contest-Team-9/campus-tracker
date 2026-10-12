"""Z12: 유담관 옆 차도 동쪽 인도의 길을 다시 만든 계단 띠(z03-fountain 의 Z03-EAST-*)에 맞추는 변경 묶음. DB 는 읽기만(docker psql, 시험용 컨테이너).
  python -X utf8 build_group.py 1   -> groups/z12-1.json  동쪽 인도 길을 계단 첫 단·맨 위 참에서 나눔, 횡단 자리의 동쪽 노드를 참이 차도와 같은 높이인 곳으로 옮김
  python -X utf8 build_group.py 2   -> groups/z12-2.json  (1 을 적용한 뒤) 계단 구간의 인도 길 조각을 거두고 계단 길 둘을 새로: 묶음 발치·머리·참 끝마다 꼭짓점, 높이 = 구조물 윗면
서쪽 인도 길은 그대로다(같은 줄, 폭 1.5 m, 높이는 차도 종단). 끝점과 높이는 z12/model.json·z03/model.json(구조물과 같은 정의)에서 온다."""
import sys, json, subprocess, pathlib
HERE = pathlib.Path(__file__).parent
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8'))['eastStair']; F = json.loads((HERE.parent / 'z03' / 'model.json').read_text(encoding='utf-8'))['eastStair']
def q(sql): return subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()
EV = '사용자 그림 12(2026-10-12: 계단 형상이 아래 끝까지 이어짐), 거리뷰 Y02~Y08·전방위 사진 08~11(계단은 차도 턱 바로 옆, 첫 단 북좌표 557203.5 ±1.5 m). 구조물 Z03-EAST-STAIR-F1~F7 과 같은 자리·높이'
EAST = "status='DRAFT' and name like '정문 ~ 제2주차장 차도 동쪽 인도%'"
CROSS = 'bad7719d-ac92-438b-b93d-3bf9d821cb9a'   # 분수 광장 출입 자리 횡단의 동쪽 노드
path = M['path']; FLUSH = next(p for p in path if abs(p[1] - (557000 + F['flights'][1]['landingTo'])) < 0.01)   # 둘째 참의 위 끝: 차도와 같은 높이
if sys.argv[1] == '1':
    rows = {l.split('|')[0][:8]: l.split('|') for l in q(f"select id, revision from mobility.road_segments where {EAST}")}
    ops = [{'ref': '동쪽 인도 길을 계단 첫 단에서 나눔', 'op': 'split_road', 'args': {'roadId': rows['97445741'][0], 'expectedRevision': int(rows['97445741'][1]), 'nearest': M['footXY']}, 'grade': '원천(전방위 사진), 추정 ±1.5 m', 'evidence': EV},
           {'ref': '동쪽 인도 길을 계단 맨 위 참 끝에서 나눔', 'op': 'split_road', 'args': {'roadId': rows['615a3dd1'][0], 'expectedRevision': int(rows['615a3dd1'][1]), 'nearest': M['topXY']}, 'grade': '추정(포장 띠 끝)', 'evidence': EV},
           {'ref': f'횡단 자리의 동쪽 노드를 둘째 참이 차도와 같은 높이가 되는 곳으로({FLUSH[2]} m)', 'op': 'move_node', 'args': {'nodeId': CROSS, 'to': {'xy': FLUSH[:2], 'z': FLUSH[2]}}, 'grade': '추정', 'evidence': EV}]
else:
    y0, y1 = M['footXY'][1], M['topXY'][1]
    rows = [l.split('|') for l in q(f"select id, revision, from_node_id, to_node_id, st_y(st_startpoint(geom)), st_y(st_endpoint(geom)) from mobility.road_segments where {EAST}")]
    inside = [r for r in rows if y0 - 1.0 <= min(float(r[4]), float(r[5])) and max(float(r[4]), float(r[5])) <= y1 + 1.0]
    assert len(inside) == 2, inside
    lo = next(r for r in inside if CROSS == r[3]); hi = next(r for r in inside if CROSS == r[2])
    foot, top = lo[2], hi[3]
    pt = lambda p: {'xy': [p[0], p[1]], 'z': p[2]}
    i = path.index(FLUSH); n = len(F['flights']); rise = round(F['riseM'], 3)
    def stairs(ref, name, a, mid, b):
        return {'ref': ref, 'op': 'create_road', 'args': {'roadClass': 'pedestrian', 'name': name, 'structure': 'stairs', 'widthM': 4, 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'wheelchairAccess': 'prohibited',
                'path': [{'at': {'nodeId': a}}] + [pt(p) for p in mid] + [{'at': {'nodeId': b}}], 'zMode': 'explicit', 'densify': False}, 'grade': '확정(계단 띠가 아래 끝까지 이어짐), 추정(묶음 수·자리·단 치수)', 'evidence': EV}
    ops = [{'ref': f'계단 구간의 인도 길 조각 거둠 {r[0][:8]}', 'op': 'retire_feature', 'args': {'type': 'road', 'id': r[0], 'expectedRevision': int(r[1])}, 'grade': '확정', 'evidence': EV} for r in (lo, hi)] + [
           stairs('계단 길 아랫부분', f"유담관 옆 차도 동쪽 계단식 인도 아랫부분 (첫 단 {path[0][2]} m ~ 횡단 자리 {FLUSH[2]} m. 묶음 2개 x 6단, 한 단 {rise} m: 묶음 수·자리는 추정)", foot, path[1:i], CROSS),
           stairs('계단 길 윗부분', f"유담관 옆 차도 동쪽 계단식 인도 윗부분 (횡단 자리 {FLUSH[2]} m ~ 바위 정원 옆 맨 위 참 {path[-1][2]} m. 묶음 {n - 2}개 x 6단, 한 단 {rise} m: 묶음 수·자리는 추정)", CROSS, path[i + 1:-1], top)]
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / f'z12-{sys.argv[1]}.json').write_text(json.dumps({'id': f'Z12-{sys.argv[1]}', 'comment': 'Z12 유담관 옆 차도 동쪽 인도의 계단 구간을 계단 길로(구조물 계단 띠와 같은 자리·높이)', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(len(ops))
