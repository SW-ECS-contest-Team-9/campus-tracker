"""Z02: 시험용 DB 편집 묶음(편집기 MCP apply_changes 입력)을 만든다. DB 는 읽기만(docker psql).
  python build_groups.py   -> <볼트>/z02/group-A.json(옛 길 거둠), group-B.json(새 길)
길 끝점과 높이는 model.json(build_inputs.py 가 구조물과 같은 정의로 씀)에서 온다."""
import sys, subprocess; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8')); P, L = M['points'], M['levels']
q = subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c',
                    "select id, revision, name from mobility.road_segments where status='DRAFT'"], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()
roads = {l.split('|')[0][:8]: l.split('|') for l in q}
OLD = {'88ba01e6': '옛 정문 계단(145.8 → 148.9 m, 운동장보다 낮은 문 앞에서 올라오는 것으로 저장됨)', '8e03aa9e': '옛 문 앞 평탄부 145.8 m', '19800cee': '옛 문 앞 145.8 m 와 실내 통로를 잇던 선(현관 단 151.0 m 와 5.2 m 어긋남)',
       'b14ac1da': '옛 하행 계단 1 (145.8 → 144.8)', '00cd9c0f': '옛 계단참 144.8', '2f206e6c': '옛 하행 계단 2 (144.8 → 143.8)', '618385b9': '옛 하단 평탄 연결부(143.8 m. 새 선으로 바꿈)',
       'b7c0792f': 'N01 현관 앞 계단 선(구조물에 맞춘 새 선으로 바꿈)', '6e30f94e': 'N01 상승관 왼쪽 계단 선(새 선으로 바꿈)', '568ba2aa': 'N01 상승관 오른쪽 계단 선(아래 끝이 운동장 바닥으로 돼 있었음. 광장에서 시작하는 새 선으로 바꿈)'}
A = [{'ref': f'Z02 거둠 {k}: {why}', 'op': 'retire_feature', 'args': {'type': 'road', 'id': roads[k][0], 'expectedRevision': int(roads[k][1])}} for k, why in OLD.items() if k in roads]
pt = lambda name, z: {'xy': P[name], 'z': z}
xy = lambda u, v, z: {'xy': [round(float(c), 2) for c in uv_to_xy(u, v)], 'z': z}
E, PA, PZ, Y, F = L['entrance'], L['passage'], L['plaza'], L['yard'], L['field']
def road(ref, name, structure, width, path, **kw):
    return {'ref': ref, 'op': 'create_road', 'args': {'roadClass': 'pedestrian', 'name': name, 'structure': structure, 'widthM': width, 'path': path, 'zMode': 'explicit', 'densify': False, **kw}}
Lc, Lw, Le = xy(1.7, 5.2, E), xy(-4.6, 5.2, E), xy(7.4, 5.2, E)
B = [
 road('Z02-front-stair', '대일관 현관 앞 넓은 계단 (13단 추정, 148.9 → 151.0 m)', 'stairs', 10.6, [pt('frontStairFoot', F), pt('frontStairTop', E)]),
 road('Z02-entrance-door', '대일관 현관 단 (151.0 m 추정): 계단 위 → 현관 문', 'ordinary', 3.0, [pt('frontStairTop', E), Lc, pt('entranceDoor', E)]),
 road('Z02-entrance-west', '대일관 현관 단: 서쪽 끝(하행 계단 위)까지', 'ordinary', 2.0, [Lc, Lw, pt('sideStairTop', E)]),
 road('Z02-entrance-east', '대일관 현관 단: 동쪽 끝(높은 통로 앞)까지', 'ordinary', 2.0, [Lc, Le, xy(7.9, 1.25, E)]),
 road('Z02-deck-steps-w', '현관 단 → 높은 가장자리 길 (2칸 추정)', 'stairs', 2.5, [xy(7.9, 1.25, E), pt('deckWest', PA)]),
 road('Z02-deck', '높은 가장자리 길 = 나무 데크 (151.3 m 추정, 대일관 입구(2) 앞을 지남)', 'ordinary', 2.2, [pt('deckWest', PA), pt('deckDoor2', PA), xy(39.6, 1.25, PA), pt('deckJog', PA), pt('deckEast', PA)]),
 road('Z02-deck-steps-e', '높은 가장자리 길 동쪽 끝 → 작은 광장 (2칸 추정)', 'stairs', 1.9, [pt('deckEast', PA), pt('plazaW', PZ)]),
 road('Z02-plaza', '대일관·청운관 사이 작은 광장 (151.0 m)', 'ordinary', 3.0, [pt('plazaW', PZ), pt('plaza', PZ), pt('rightStairFoot', PZ)]),
 road('Z02-east-stair', '동쪽 끝 계단: 운동장 → 작은 광장 (13단 추정, 148.9 → 151.0 m)', 'stairs', 4.4, [pt('eastStairFoot', F), pt('eastStairTop', PZ), pt('plaza', PZ)]),
 road('Z02-right-stair', '오른쪽 계단: 작은 광장 → 안쪽 마당 (13단 추정, 151.0 → 153.1 m)', 'stairs', 4.0, [pt('rightStairFoot', PZ), pt('rightStairTop', Y)]),
 road('Z02-yard', '안쪽 마당 (153.1 m) → 상승관 입구(추정 위치)', 'ordinary', 3.0, [pt('rightStairTop', Y), pt('yardSouth', Y), pt('yardNorth', Y), pt('sangseungDoor', Y)]),
 road('Z02-side-stair', f"대일관 출구 옆 하행 계단 ({M['stairs']['side']['risers']}단 추정, 151.0 → 145.5 m, 가운데 참)", 'stairs', 2.2,
      [pt('sideStairTop', E), pt('sideStairLandingE', P['sideStairLandingZ']), pt('sideStairLandingW', P['sideStairLandingZ']), pt('sideStairFoot', L['sideStairFoot'])]),
 road('Z02-side-stair-foot', '하행 계단 아래 → 대일관 서쪽 끝 앞 평탄부 (145.5 m) → 문예관 쪽 계단 위', 'ordinary', 2.5, [pt('sideStairFoot', L['sideStairFoot']), {'xy': [201125.8, 557324.6], 'z': 145.6}]),
]
for nm, ops, c in (('A', A, 'Z02 대일관 정면의 옛 길 거둠(145.8 m 문 앞 묶음과 N01 임시 계단 선). 지우지 않고 보관'), ('B', B, 'Z02 대일관 정면·운동장 북쪽 가장자리의 새 길: 구조물 파일(z02-daeil-front)의 기단·계단과 같은 자리·높이')):
    (OUT / f'group-{nm}.json').write_text(json.dumps({'id': f'Z02-{nm}', 'comment': c, 'ops': ops}, ensure_ascii=False, indent=1), encoding='utf-8'); print(nm, len(ops))
