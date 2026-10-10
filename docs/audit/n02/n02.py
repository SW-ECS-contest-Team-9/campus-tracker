"""N02: 제안 파일에 시험용 DB 적용 결과를 표시한다(DB 접속 없음).
  python docs/audit/n02/n02.py --write-proposals
고치는 것: docs/audit/b03/network.json (북악관·포장면 제안의 status, 'n02' 절, N02-# 제안), docs/audit/e09/editor-ops.json (V4·8fde6a04·c52095ad 항목의 status, 'n02' 절).
b03/network.py, b08/b08.py, e09/build.py, b10/b10.py --write-proposals 를 다시 돌리면 이 표시가 지워진다. 그 뒤에 이 스크립트를 다시 돌린다(B10 표시는 건드리지 않는다)."""
import json, sys, pathlib, collections
HERE = pathlib.Path(__file__).parent
R = json.loads((HERE / 'results.json').read_text(encoding='utf-8'))
T = '시험용 DB 적용(N02)'
NET = {  # b08Id / b10Id -> (status, note)
    'B10-1': (T, '노드 57개 옮김 + 길 15개의 안쪽 꼭짓점. B1 계단 f99540e3 만 129.7 → 130.5 m(4~6칸), 05378724 는 평지 통로로'),
    'B10-2': (T, '층 표기 31개 길: 북악관_Z143.47/146.18/148.92/151.79/154.51_추정 → 북악관_3F/5F/6F/7F/8F_추정. 노드의 층 표기는 일부만 따라 바뀜(도구 동작)'),
    'B10-3': (T, None), 'B10-4': (T, '계단 평면 길이 1.1 m 는 그대로(추정)'), 'B10-5': (T, None), 'B10-6': (T, '편의점과 1.6 m 떨어진 복도 꼭짓점에 둠'),
    'B08-1': ('거둠(N02): 없애지 않고 보행 길로 고침', '8fde6a04 = 사용자가 말한 지하 횡단보도·통로(확정: 횡단보도는 지하). 보행·차량 금지로 바꾸고 그림 14 의 자리로 옮김, 높이 128.5 → 129.7 m(추정)'),
    'B08-2': ('거둠(N02): 지상 횡단 길은 없다', 'N01 이 넣은 지상 선 6b695a7c·dc9e833a 를 시험용 DB 에서 거둠'),
    'B08-3': ('거둠(N02): 포장면이 잇는다', 'N01 이 넣은 c738cda0 을 거둠. 오르막 보행로를 포장면 가장자리까지 늘임'),
    'B08-4': ('시험용 DB 적용(N01), 높이 고침(N02)', '계단 아래 126.82 → 128.5 m(보행 기록의 가장 낮은 곳 128.4~128.7, 추정)'),
    'B08-5': ('시험용 DB 적용(N01), 높이 고침(N02)', '서쪽 꼭짓점 4개 128.5 m. 횡단보도가 붙는 자리에서 둘로 나뉨'),
    'B08-7': (T, None), 'B08-8': (T + ': 뒤편 산책로 끝 7895ac0d 에는 안 붙임', '7895ac0d 저장 128.13 m 가 S-MAP 132.5 m 보다 4.4 m 낮다. 옆길은 (201012, 557411, 132.9) 에서 끝남'), 'B08-9': (T, None),
}
NEW = [
    {'n02Id': 'N02-1', 'op': 'create_area', 'building': '회차 공간', 'name': R['area']['name'], 'kind': R['area']['kind'], 'elevationM': R['area']['elevationM'], 'areaM2': R['area']['areaM2'], 'coordinatesFile': 'docs/audit/n02/area-plaza.json',
     'grade': '확정(전부 포장면, 사용자 그림 11) + S-MAP(평탄 범위 130.5~131.5 m) + 추정(경계 ±1~2 m)', 'status': T, 'rollback': '편집기 공간 영역 삭제(변경 묶음 되돌리기에 안 들어감)'},
    {'n02Id': 'N02-2', 'op': 'update_road', 'building': '문예관 옆', 'name': '오르막 보행로 c52095ad: 높이 S-MAP(131.4 → 141.0 m), 포장면 가장자리까지 늘임(67.3 m), 폭 9 m, 보행 유지', 'grade': '확정(보행로, 포장면과 이어짐) + S-MAP(높이, 폭 8~10 m)', 'status': T, 'rollback': 'revert_changeset'},
    {'n02Id': 'N02-3', 'op': 'shift_z', 'building': '문예관·대일관 사이', 'name': '갈림 지점 일대 노드 4개를 S-MAP 으로: 3df2b596 144.3, 85a0ed07 144.1, b5e0b6b5 144.3, 59f9ab35 145.6, 오르막 위 끝 4f294196 141.0. 갈림 계단 040d4571 은 144.3 → 141.0 m',
     'grade': 'S-MAP(표고 조회 2026-10-11)', 'status': T, 'leftSteps': '9112314a(문예관 입구 쪽 144.3 → 142.44), 618385b9(145.6 → 143.80, 실제는 149.3 으로 오름)', 'rollback': 'revert_changeset'},
    {'n02Id': 'N02-4', 'op': 'create_road', 'building': '북악관', 'name': '정문 계단 131.4 → 133.3(바깥 12칸) → 1층 로비 길 끝 596405f1(133.72) → 134.1 m', 'grade': '확정(17칸) + S-MAP(계단 아래) + 추정(평면)', 'status': T, 'rollback': 'revert_changeset'},
    {'n02Id': 'N02-5', 'op': 'create_road', 'building': '회차 공간', 'name': '본관 입구(2) 문 앞 ~ 본관 모서리 앞 계단 위 / 북쪽 버스 표지 ~ 서쪽 가장자리 ~ 횡단보도(흰 띠) / 남쪽 버스 표지 앞에서 차도 나눔', 'grade': '원천(문 자리) + 사용자 그림 11(표지·흰 띠, ±3 m) + S-MAP(높이)', 'status': T, 'rollback': 'revert_changeset'},
    {'n02Id': 'N02-6', 'op': 'retire_feature', 'building': '회차 공간', 'name': '회차 공간 차도 끝 5.7 m(d5d8cd64) 거둠, 남은 차도(b30c65f1)에 폭 14 m', 'grade': '검사 경고 2건(옆에서 끊김, 겹쳐 달림) 정리. 포장면이 버스 공간을 대신한다', 'status': T, 'rollback': 'revert_changeset'},
    {'n02Id': 'N02-7', 'op': 'create_road', 'building': '유담관', 'name': '유담관 입구(1) 6층 로비 문 앞 4.5 m(114.1 m)와 장소', 'grade': '확정(분수 광장 = 6층) + 원천(문 자리) + S-MAP(광장 114.1)', 'status': T + ': 차도와는 안 이음', 'rollback': 'revert_changeset'},
    {'n02Id': 'N02-8', 'op': 'shift_z', 'building': '지하 차도', 'name': '951c157d 아래 끝 126.82 → 128.5 m, 그 앞 꼭짓점 128.6 m', 'grade': '추정(횡단보도가 차도를 건넌다는 확정 + 보행 기록의 가장 낮은 곳 128.4~128.7). E09 의 "높이는 건드리지 않는다"와 다르게 한 것', 'status': T, 'rollback': 'revert_changeset'},
    {'n02Id': 'N02-9', 'op': 'shift_z', 'building': '대일관', 'name': '대일관 앞 실외 길을 S-MAP 으로(미적용): d85f61a5 149.3, e0591f2c 150.6, 552b685d 150.6, f0cca79e 151.1, 0e650ceb 151.0, 016416b6 152.4 (저장 143.80~145.80). 8e71c240 은 141.0 → 144.0 → 147.2',
     'grade': 'S-MAP(표고 조회 2026-10-11). 대일관 1층 실내 길(+6.0 m)과 함께 옮겨야 문에서 단이 안 생긴다', 'status': '제안(미적용)', 'rollback': 'revert_changeset'},
    {'n02Id': 'N02-10', 'op': 'move_node', 'building': '북악관 뒤', 'name': '뒤편 산책로 서쪽 끝 7895ac0d 128.13 → 132.5 m 와 a03d33c3 서쪽 구간, 그 뒤 옆길 끝과 잇기(6.9 m)', 'grade': 'S-MAP(132.5). a03d33c3 의 다음 꼭짓점도 2.5~4 m 낮아 함께 고쳐야 한다', 'status': '제안(미적용)', 'rollback': 'revert_changeset'},
    {'n02Id': 'N02-11', 'op': 'schema', 'building': '-', 'name': '공간 영역 종류에 "포장 광장(차·사람 함께)"을 따로 두기. 지금은 plaza 를 썼다(지도 화면은 parking 만 검게 칠한다)', 'grade': '제안', 'status': '제안(미적용, 마이그레이션 필요)'},
]
E09 = {'E09-V4': 'N01 적용. N02: 북쪽 끝 5.7 m 조각 거둠, 폭 14 m, 남쪽 버스 표지 앞에서 둘로 나눔', 'E09-B08-1': '거둠(N02): 8fde6a04 를 없애지 않고 지하 횡단보도·통로(보행)로 고침',
       'E09-FIX-c52095ad': 'N01 적용. N02: 높이 S-MAP, 포장면까지 늘임, 폭 9 m(보행 유지)', 'E09-FIX-8e71c240': 'N01 적용. N02: 서쪽 끝만 141.0 m(오르막 위 끝과 같은 노드). 나머지 141.73 은 그대로(S-MAP 144.0 → 147.2)',
       'E09-B08-6': 'N01 적용. N02: 아래 끝 126.82 → 128.5 m(추정)', 'E09-JOIN-N1': '쓸 수 없음(N01: 이미 이어짐으로 거부)', 'E09-JOIN-N2': '쓸 수 없음(N01)', 'E09-JOIN-N3': '쓸 수 없음(N01)'}

if '--write-proposals' in sys.argv:
    npath = HERE.parent / 'b03/network.json'; net = json.loads(npath.read_text(encoding='utf-8'))
    net['proposals'] = [o for o in net['proposals'] if not o.get('n02Id')]
    touched = []
    for o in net['proposals']:
        key = o.get('b10Id') or o.get('b08Id')
        if key in NET:
            if 'statusBeforeN02' not in o: o['statusBeforeN02'] = o.get('status')
            o['status'] = NET[key][0]
            if NET[key][1]: o['n02Note'] = NET[key][1]
            touched.append([key, o['status']])
    net['proposals'] += NEW
    net['proposalCounts'] = dict(collections.Counter(f"{o['op']} / {o.get('status') or '제안'}" for o in net['proposals']))
    net['n02'] = {'date': '2026-10-11', 'appliedTo': '시험용 DB(campus-tracker-test-db)만. 운영 적용 없음', 'touched': touched, 'new': [o['n02Id'] for o in NEW],
                  'settled': '횡단보도는 지하(사용자 확정): B10 의 해석 D. 8fde6a04 는 그 횡단보도·통로, f99540e3 은 4~6칸 계단(129.7 → 130.5 m)',
                  'results': 'docs/audit/n02/results.json', 'rerun': 'b10.py --write-proposals 뒤에 n02.py --write-proposals'}
    npath.write_text(json.dumps(net, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    epath = HERE.parent / 'e09/editor-ops.json'; e = json.loads(epath.read_text(encoding='utf-8'))
    for o in e['operations']:
        if o['id'] in E09:
            if 'statusBeforeN02' not in o: o['statusBeforeN02'] = o.get('status')
            o['status'] = E09[o['id']]
    e['n02'] = {'date': '2026-10-11', 'appliedTo': '시험용 DB만', 'note': '차량 7구간은 N01 이 넣었다. N02 는 회차 공간 평탄부를 공간 영역(plaza)으로 두고 차도 V4 는 그 남쪽 가장자리에서 끝낸다. 951c157d 아래 끝 높이를 128.5 m 로 올렸다(추정)',
                'roadMinusTerrainAfter': [x for x in R['roadMinusTerrain']['rows'] if x['class'] == 'vehicle']}
    epath.write_text(json.dumps(e, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print('network touched', len(touched), 'new', len(NEW), '| e09 marked', len(E09))
