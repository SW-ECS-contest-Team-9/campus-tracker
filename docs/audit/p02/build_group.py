"""P02 길 변경 묶음: 유담관 3층 입구(서경스포렉스 간판) 앞 돌계단을 길로(문 앞 104.0 m ~ 바깥 길 보도), 입구 표지를 문 앞으로.   python build_group.py STATE.json  -> groups/p02.json
STATE.json = n02.ts state 가 쓴 파일(개정 번호를 거기서 읽는다). 시험용 DB 에만 적용한다(apply.sh). 바깥 길(공도)에는 길 자료가 없어 이 계단은 따로 떨어진 한 토막이다."""
import json, pathlib, sys
import parts2 as B
HERE = pathlib.Path(__file__).parent
st = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
place = lambda p: next(n for n in st['places'] if n['id'].startswith(p))
pt = lambda xy, z: {'xy': [round(float(xy[0]), 2), round(float(xy[1]), 2)], 'z': round(float(z), 2)}
E06 = '데이터/보완자료/3d-map-audit-20261009/사용자-SP카페·대일관계단·3생활관-20261012/06-유담관-3층입구-서경스포렉스.jpg'
G = '확정(서경스포렉스 간판의 입구 = 유담관 3층 입구, 바깥 길 쪽·우편취급국 옆: 사용자 2026-10-10·10-12), 원천(넓은 돌계단 8단쯤: 사용자 사진), S-MAP(문 앞 길 103.0~103.3 m), 추정(문 앞 바닥 104.0 m, 계단 선 ±3 m)'
foot = B.ENT_FOOT; zf = B.ground(foot[0], foot[1])
ops = []
if not any(r['name'].startswith('유담관 3층 입구 앞 돌계단') for r in st['roads']):
    ops.append({'ref': '유담관 3층 입구 앞 돌계단', 'op': 'create_road', 'args': {'roadClass': 'pedestrian', 'structure': 'stairs', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'widthM': 6.3, 'buildingId': '유담관',
        'name': f'유담관 3층 입구 앞 돌계단 (서경스포렉스 간판 아래 문 앞 {B.ENT_FLOOR} m ~ 바깥 길 보도 {zf:.1f} m, 8단쯤. 바깥 길에는 길 자료가 없어 여기서 끝난다)', 'zMode': 'explicit', 'densify': False,
        'path': [pt(B.ENT_DOOR, B.ENT_FLOOR), pt(B.EP(-0.8, 2.0), B.ENT_FLOOR), pt(foot, zf)]}, 'grade': G, 'evidence': f'{E06}, 사용자-학교전경-20261012/13, 사용자-출입구·주차장-20261010/06·07'})
p = place('d5ea71e7')
if abs(p['coordinate'][0] - B.ENT_DOOR[0]) > 0.05:
    ops.append({'ref': '유담관 입구(3) 표지를 문 앞으로', 'op': 'update_place', 'args': {'id': p['id'], 'expectedRevision': p['revision'], 'position': pt(B.ENT_DOOR, B.ENT_FLOOR), 'description': 'N03·P02. 유담관 3층 입구 = 바깥 길 쪽 "서경스포렉스" 간판 아래 유리문(우편취급국 옆): 사용자 확정 2026-10-10·10-12. 문 앞 바닥 104.0 m(추정), 앞에 돌계단 8단쯤과 경사로. 학교 지도 표지 자리 (200994.6, 557307.6)에서 벽 쪽으로 옮김. 문 안은 모름(사용자가 나중에 기록)'}, 'grade': G, 'evidence': E06})
out = {'id': 'P02', 'zone': '서문과 서쪽 옹벽', 'comment': 'P02: 유담관 3층 입구(서경스포렉스) 앞 돌계단, 입구 표지를 문 앞으로', 'ops': ops}
(HERE / 'groups').mkdir(exist_ok=True); (HERE / 'groups' / 'p02.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(len(ops), 'ops')
