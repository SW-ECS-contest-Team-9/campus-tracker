"""Z03: 시험용 DB 편집 묶음(편집기 MCP apply_changes 입력)과 광장 영역(편집기 REST POST areas 입력), 도달 검사 쌍을 만든다. DB 접근 없음.
  python -I build_groups.py   -> <볼트>/z03/group-A.json, area-fountain-plaza.json, docs/audit/z03/pairs.json
길 끝점과 높이는 구조물 파일·model.json(build_inputs.py)과 같은 정의에서 온다."""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8')); ZP = M['heights']['plaza']
plaza = next(f for f in json.loads((REPO / 'frontend/public/structures/z03-fountain.geojson').read_text(encoding='utf-8'))['features'] if f['properties']['id'] == 'Z03-PLATFORM-PLAZA')['geometry']['coordinates'][0]
fx, fy = M['fountain']['centre']; R = M['fountain']['rimRadiusM'] + 0.2
hole = [[round(fx + R * np.cos(a), 2), round(fy + R * np.sin(a), 2)] for a in np.linspace(0, 2 * np.pi, 16, endpoint=False)]
area = {'name': '유담관 분수 광장 (6층 로비 앞)', 'kind': 'plaza', 'elevationM': ZP,
        'note': 'Z03. 사용자 확정: 분수 광장 = 유담관 6층 로비 입구 앞. 바닥 114.1 m(S-MAP 평탄 칸 가운데값 114.04, 사용자 핀 113.9~114.2). 경계는 구조물 파일 z03-fountain 의 기단 Z03-PLATFORM-PLAZA 그대로(S-MAP 0.5 m 메시 ±1 m, 북쪽은 유담관 원천 외곽). 분수 물받이(반지름 6.3 m)는 구멍. 사람이 걷는 광장이고 차는 들어오지 않는다(출입 자리에 붉은 말뚝).',
        'coordinates': plaza[:-1], 'holes': [hole]}
(Z03 / 'area-fountain-plaza.json').write_text(json.dumps(area, ensure_ascii=False, indent=1), encoding='utf-8')
LOBBY = '974c510c'   # 시험용 DB 노드 (201060.5, 557231.5, 114.1): N02 가 넣은 6층 로비 문 앞 길의 광장 쪽 끝(건물 외곽 안 1.8 m)
DOORFRONT = [201064.5, 557228.0]; ENTRY_IN = [201083.5, 557218.5]; ENTRY_ROAD = [201089.13, 557218.5]
zr = M['heights']['roadAtEntry']
def road(ref, name, structure, width, path, **kw):
    return {'ref': ref, 'op': 'create_road', 'args': {'roadClass': 'pedestrian', 'name': name, 'structure': structure, 'widthM': width, 'path': path, 'zMode': 'explicit', 'densify': False, **kw}}
A = [
 road('Z03-lobby-door', '유담관 6층 로비 문 ~ 유리 차양 아래 ~ 분수 광장 (114.1 m, 문 자리 추정 ±3 m)', 'ordinary', 3.0, [{'xy': [201060.5, 557231.5], 'z': ZP}, {'xy': DOORFRONT, 'z': ZP}]),
 road('Z03-plaza-entry', '분수 광장 출입 자리(붉은 말뚝) ~ 보도 ~ 차도 (광장과 차도가 같은 높이인 곳, S-MAP 114.0~114.2 m)', 'ordinary', 3.0, [{'xy': ENTRY_IN, 'z': ZP}, {'xy': ENTRY_ROAD, 'z': zr}]),
]
(Z03 / 'group-A.json').write_text(json.dumps({'id': 'Z03-A', 'comment': 'Z03 유담관 6층 로비 문 → 분수 광장(영역) → 출입 자리 → 차도. 광장은 영역으로 건넌다', 'ops': A}, ensure_ascii=False, indent=1), encoding='utf-8')
pairs = {'note': 'Z03 도달 검사 쌍. point 는 가장 가까운 노드(평면, snapRadiusM 안)로 붙는다.', 'pairs': [
 {'id': 'gate>yudam6F', 'label': '정문(공도 분기) → 유담관 6층 로비 문(학교 표지)', 'from': {'point': [201134.83, 557097.35]}, 'to': {'point': [201057.2, 557234.5]}, 'vehicle': False, 'snapRadiusM': 3},
 {'id': 'yudam6F>turn', 'label': '유담관 6층 로비 문 → 회차 공간(차도가 포장면에 닿는 곳)', 'from': {'point': [201057.2, 557234.5]}, 'to': {'point': [201017.81, 557344.49]}, 'vehicle': False, 'snapRadiusM': 3},
 {'id': 'yudam6F>yudam9F', 'label': '유담관 6층 로비 문 → 유담관 9층 쪽 실내 홀(129.6 m)', 'from': {'point': [201057.2, 557234.5]}, 'to': {'point': [201040.0, 557275.0]}, 'vehicle': False, 'snapRadiusM': 3},
 {'id': 'yudam6F>bukak1F', 'label': '유담관 6층 로비 문 → 북악관 정문 계단 아래', 'from': {'point': [201057.2, 557234.5]}, 'to': {'point': [201041.7, 557360.5]}, 'vehicle': False, 'snapRadiusM': 5},
]}
(HERE / 'pairs.json').write_text(json.dumps(pairs, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print('ops', len(A), 'area pts', len(plaza) - 1, 'pairs', len(pairs['pairs']))
