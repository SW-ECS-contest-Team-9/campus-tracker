"""X22: 시험용 DB 변경 묶음 두 개를 만든다. DB 는 읽기만(docker psql, 컨테이너 campus-tracker-test-db).
  python build_group.py roads   -> groups/x22-roads.json   청운관 앞 계단 자리(항공사진), 데크 동쪽 끝, 상승관 쪽 작은 계단과 마당 길(사용자 지정 길), 옥상 마당 길
  python build_group.py levels  -> groups/x22-levels.json  "건물_층" 규칙에 어긋난 levelId 이름 바꾸기(북악관_6F_추정 → 북악관_6F 등)
적용: C:\\campus-tracker-testdb\\backend 에서 npx tsx ../docs/audit/n02/n02.ts apply <묶음> <결과.json> [--commit] (시험용 DB 127.0.0.1:5544 만)."""
import sys, json, subprocess, pathlib, importlib.util
HERE = pathlib.Path(__file__).parent
sp = importlib.util.spec_from_file_location('z02common', HERE.parent / 'z02' / 'common.py'); Z = importlib.util.module_from_spec(sp); sp.loader.exec_module(Z)
def q(sql): return subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()
def rev(prefix):
    rows = [l.split('|') for l in q(f"select id, revision from mobility.road_segments where status='DRAFT' and id::text like '{prefix}%'")]
    assert len(rows) == 1, (prefix, rows); return rows[0][0], int(rows[0][1])
def node(prefix):
    rows = q(f"select id from mobility.network_nodes where id::text like '{prefix}%'"); assert len(rows) == 1, prefix; return rows[0]
uv = lambda u, v: [round(float(c), 2) for c in Z.uv_to_xy(u, v)]
NOTE = '볼트 데이터/모델링 개선/2026-10-22 전경 영상 비교.md, 건물 노트 대일관·청운관·본관 2026-10-22 절'
ops = []
if sys.argv[1] == 'roads':
    AE = '사용자 항공사진(항공-대일관앞-원본/-데크-사용자표시, 운동장 칠 무늬로 S-MAP 정사 화면에 맞춤 ±1 m), 사진 09·11, 구조물 z02-daeil-front(X22 고침)'
    rid, r = rev('838cdada')
    ops.append({'ref': '청운관 앞 계단 발치 노드: 항공사진의 계단 띠 가운데(u 52.8)로 3.6 m 서쪽', 'op': 'move_node', 'args': {'nodeId': node('71e6ebfe'), 'to': {'xy': uv(52.8, 6.3), 'z': 148.9}}, 'grade': '추정', 'evidence': AE})
    ops.append({'ref': '청운관 앞 계단 길: 계단 머리 꼭짓점을 새 계단 위(u 52.8, v 2.7)로, 이름', 'op': 'update_road', 'args': {'id': rid, 'expectedRevision': r + 1, 'zMode': 'explicit', 'densify': False,
        'attrs': {'name': '청운관 앞 계단: 운동장 → 참 (13단 추정, 148.9 → 151.0 m. 자리는 사용자 항공사진: 데크 앞 화단 끝과 가운데 화단 사이)'},
        'vertexOps': [{'op': 'move', 'index': 1, 'point': {'xy': uv(52.8, 2.7), 'z': 151.0}}]}, 'grade': '확정(자리: 사용자 항공사진), 추정(±1 m, 단 수)', 'evidence': AE})
    ops.append({'ref': '데크 동쪽 끝 노드: 데크 끝(u 49.4)으로. 그 동쪽은 참 151.0', 'op': 'move_node', 'args': {'nodeId': node('110c17e5'), 'to': {'xy': uv(49.4, 2.6), 'z': 151.3}}, 'grade': '확정(데크 끝: 사용자 항공사진), 추정(±1 m)', 'evidence': AE})
    US = '사용자 표시 사용자표시-청운관앞계단-갈림.png(빨간 꺾은선: 참에서 작은 계단으로 조금 더 올라 오른쪽 위로 굽어 상승관), 구조물 X22-SANGSEUNG-STAIR'
    base = {'roadClass': 'pedestrian', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'zMode': 'explicit', 'densify': False}
    ops.append({'ref': '참 → 작은 계단 발치(광장 151.0)', 'op': 'create_road', 'args': {**base, 'name': '청운관 앞 참 → 상승관 쪽 작은 계단 발치 (151.0 m, 사용자 지정 길)', 'structure': 'ordinary', 'widthM': 3.0,
        'path': [{'at': {'nodeId': node('46f69825')}}, {'xy': uv(53.7, -2.75), 'z': 151.0}]}, 'grade': '확정(길: 사용자 표시), 추정(선 ±1 m)', 'evidence': US})
    ops.append({'ref': '상승관 쪽 작은 계단(12단, 151.0 → 153.1)', 'op': 'create_road', 'args': {**base, 'name': '상승관 쪽 작은 계단 (12단 추정, 151.0 → 153.1 m, 사용자 지정 길)', 'structure': 'stairs', 'widthM': 3.0,
        'path': [{'xy': uv(53.7, -2.75), 'z': 151.0}, {'xy': uv(57.1, -2.75), 'z': 153.1}]}, 'grade': '확정(작은 계단: 사용자 표시), 추정(자리·단 수)', 'evidence': US})
    fid, fr = rev('fd1fee86')
    ops.append({'ref': '작은 계단 머리 → 안쪽 마당을 지나 오른쪽 위로 굽어 상승관 입구 길에 붙음', 'op': 'create_road', 'args': {**base, 'name': '상승관 쪽 작은 계단 머리 → 안쪽 마당 → 상승관 입구 길 (153.1 m, 사용자 지정 길)', 'structure': 'ordinary', 'widthM': 2.5,
        'path': [{'xy': uv(57.1, -2.75), 'z': 153.1}, {'xy': uv(58.4, -4.2), 'z': 153.1}, {'xy': [201214.0, 557296.6], 'z': 153.1}, {'at': {'roadId': fid, 'vertexIndex': 2}}]}, 'grade': '확정(길: 사용자 표시), 추정(선 ±1.5 m)', 'evidence': US})
    RS = '사진 15(남쪽 유리문 밖 옥상 마당), 사용자 2026-10-22(후보 가), 구조물 X22-ROOF-YARD-*, X22-LINK-DOOR-S'
    ops.append({'ref': '유리 통로 남쪽 문 → 옥상 마당', 'op': 'create_road', 'args': {**base, 'name': '본관–한림관 유리 통로 남쪽 문 → 옥상 마당 (137.8 m, 둥근 벽돌 화단. 자리는 사용자 후보 가, 선 추정)', 'structure': 'ordinary', 'widthM': 1.5,
        'path': [{'at': {'nodeId': node('ebb31930')}}, {'xy': [201098.07, 557300.96], 'z': 137.8}, {'xy': [201097.6, 557296.0], 'z': 137.8}, {'xy': [201096.4, 557291.6], 'z': 137.8}]}, 'grade': '확정(옥상 마당·남쪽 문: 사진 15·사용자), 추정(선)', 'evidence': RS})
    gid, comment = 'X22-ROADS', 'X22 사진·항공사진 대조: 청운관 앞 계단 자리, 데크 동쪽 끝, 상승관 쪽 작은 계단과 마당 길, 옥상 마당 길(시험용 DB 만)'
elif sys.argv[1] == 'cheongun':
    V2 = '전경 영상 2(틀 밑 통로 2~12 초, 내려가는 계단 18~30 초, 청록 앞방 31·33 초, 주차장 문 39~44 초), 사용자 2026-10-22(꺾임은 영상 그대로·가파름, 앞방에서 왼쪽 문 = 지하 1층 주차장, 앞방에서 계속 내려가면 지하 2층, 30~40 단)'
    base = {'roadClass': 'pedestrian', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'zMode': 'explicit', 'densify': False}
    import numpy as np
    PO = np.array([201213.35, 557281.05]); PP = np.array([0.7205, 0.6935]); PQ = np.array([-0.6935, 0.7205])
    at = lambda p, q: [round(float(c), 2) for c in PO + PP * p + PQ * q]
    R, E = at(4.0, 0.0), at(2.6, 0.0)           # 붉은 벽 칸 가운데·어귀(149.2)
    F1T, F1B = E, [201211.9, 557282.85]        # 첫 줄 13 단(149.2 → 145.3): 칸 어귀에서 서쪽으로(틀 밑·운동장 슬래브 밑)
    F2T, F2B = [201211.4, 557282.85], [201208.1, 557282.85]   # 참 다음 한 줄 더 13 단(145.3 → 141.4), 같은 쪽(꺾임 더하지 않음)
    AN = F2B                                   # 청록 앞방(지하 1층 141.4). 주차장 문은 내려가는 방향(서)의 왼쪽(남), 주차장 북쪽 벽 바깥
    B2T, B2B = [201208.1, 557283.65], [201211.4, 557283.65]   # 앞방에서 계속 내려가는 줄(되돌림, 지하 2층 계단)
    B3T, B3B = [201211.4, 557282.05], [201208.1, 557282.05]
    DOOR = [201209.4, 557280.8]               # 초록 점 "청운관 서" = 주차장 북쪽 벽 꺾이는 자리(두 층 같은 평면 자리)
    ops.append({'ref': '운동장 쪽 → 틀 밑 통로 → 디딤 2단 → 붉은 벽 칸(149.2)', 'op': 'create_road', 'args': {**base, 'name': '청운관 현관 틀 밑 통로 → 붉은 벽 칸 (148.9 → 149.2 m, 디딤 2단. 영상 2)', 'structure': 'ordinary', 'widthM': 3.0,
        'path': [{'at': {'nodeId': node('223c46db')}}, {'xy': at(1.5, 0.0), 'z': 148.9}, {'xy': E, 'z': 149.2}, {'xy': R, 'z': 149.2}]}, 'grade': '확정(있음: 영상 2), 추정(선 ±1.5 m, 칸 높이)', 'evidence': V2})
    ops.append({'ref': '붉은 벽 칸 어귀 → 계단 두 줄(참 하나, 꺾임 없음) → 청록 앞방(지하 1층 141.4)', 'op': 'create_road', 'args': {**base, 'name': '청운관 계단실: 붉은 벽 칸 → 청록 앞방 (149.2 → 141.4 m, 두 줄 x 13단 = 단 높이 0.30 m 가파름. 꺾임 없음(영상 2·사용자), 평면 추정)', 'structure': 'stairs', 'widthM': 1.2,
        'path': [{'xy': E, 'z': 149.2}, {'xy': F1B, 'z': 145.3}, {'xy': F2T, 'z': 145.3}, {'xy': F2B, 'z': 141.4}]}, 'grade': '확정(계단·되돌림 한 번·가파름: 영상 2·사용자), 추정(평면·단 수: 높이 7.8 m 를 두 줄 26 단에 나눔)', 'evidence': V2})
    ops.append({'ref': '청록 앞방 → 왼쪽 문 → 지하 1층 주차장', 'op': 'create_road', 'args': {**base, 'name': '청운관 계단실 청록 앞방 → 왼쪽 문 → 운동장 지하 1층 주차장 (141.4 m)', 'structure': 'ordinary', 'widthM': 1.2,
        'path': [{'xy': AN, 'z': 141.4}, {'xy': DOOR, 'z': 141.4}]}, 'grade': '확정(왼쪽 문 = 지하 1층 주차장: 사용자·영상 2 31 초), 추정(자리)', 'evidence': V2})
    ops.append({'ref': '청록 앞방 → 계속 내려가는 계단 → 지하 2층(137.9)', 'op': 'create_road', 'args': {**base, 'name': '청운관 계단실: 지하 1층 앞방 → 지하 2층 (141.4 → 137.9 m, 되돌림 한 번. 사용자는 30~40 단이라 했으나 지금 층 높이 차 3.5 m 로는 맞지 않음: 높이 확인 필요)', 'structure': 'stairs', 'widthM': 1.2,
        'path': [{'xy': AN, 'z': 141.4}, {'xy': B2T, 'z': 141.4}, {'xy': B2B, 'z': 139.65}, {'xy': B3T, 'z': 139.65}, {'xy': B3B, 'z': 137.9}]}, 'grade': '확정(지하 2층으로 이어짐: 사용자·영상 2 33 초), 추정(평면, 높이는 지금 노트 값)', 'evidence': V2})
    ops.append({'ref': '지하 2층 계단 발치 → 주차장 지하 2층', 'op': 'create_road', 'args': {**base, 'name': '청운관 계단실 지하 2층 발치 → 운동장 지하 2층 주차장 (137.9 m)', 'structure': 'ordinary', 'widthM': 1.2,
        'path': [{'xy': B3B, 'z': 137.9}, {'xy': DOOR, 'z': 137.9}]}, 'grade': '확정(이어짐: 사용자), 추정(자리)', 'evidence': V2})
    SH = '전경 영상 2 12~17 초(붉은 벽 칸에서 약 10 단 위 상가 앞, 간판 emart24·No Brand Burger), 사용자 항공사진 표기, 사용자 2026-10-22(상가 앞은 151.0 참이 아니고 운동장과 곧바로 이어짐)'
    SHOP = at(5.0, -3.2)
    ops.append({'ref': '붉은 벽 칸 → 상가 앞으로 오르는 계단(약 10 단)', 'op': 'create_road', 'args': {**base, 'name': '청운관 틀 밑 붉은 벽 칸 → 상가 앞 (149.2 → 150.9 m 추정, 약 10 단. 영상 2)', 'structure': 'stairs', 'widthM': 1.5,
        'path': [{'xy': R, 'z': 149.2}, {'xy': at(4.0, -1.6), 'z': 149.2}, {'xy': at(5.0, -3.2), 'z': 150.9}]}, 'grade': '확정(있음: 영상 2), 추정(평면·높이)', 'evidence': SH})
    for nm, dq in (('emart24', -0.8), ('노브랜드버거', 0.8)):
        ops.append({'ref': f'장소 {nm}', 'op': 'create_place', 'args': {'name': nm, 'category': 'destination', 'description': '청운관 현관 틀 밑 상가 앞(영상 2: 붉은 벽 칸에서 약 10 단 위). 높이 150.9 m 추정. 사용자: 운동장과 곧바로 이어짐(이음 길의 자리는 확인 필요)',
            'position': {'xy': at(5.0 + dq, -3.6), 'z': 150.9}}, 'grade': '확정(상가: 영상 2 간판·항공사진 표기), 추정(자리·높이)', 'evidence': SH})
    gid, comment = 'X22-CHEONGUN', '영상 2: 청운관 틀 밑 통로 → 붉은 벽 칸 → 계단실 → 지하 1층 주차장(왼쪽 문)·지하 2층, 상가 앞 계단과 장소(시험용 DB 만)'
else:
    MAP = {'북악관_3F_추정': '북악관_3F', '북악관_5F_추정': '북악관_5F', '북악관_6F_추정': '북악관_6F', '북악관_7F_추정': '북악관_7F'}
    LV = '사용자 지시 2026-10-22(levelId 는 "건물_층" 꼴), 북악관 노트 2026-10-22(층 B1·1·2·3·5·6·7). "_추정" 은 이름이 아니라 등급이라 뺌. 북악관_8F_추정(철계단 출구 152.5 m, 층 아님)은 맞는 이름이 정해지지 않아 그대로'
    for l in q("select id, revision, level_id from mobility.road_segments where status='DRAFT' and level_id in ('" + "','".join(MAP) + "') order by level_id, id"):
        i, r, lv = l.split('|')
        ops.append({'ref': f'길 {i[:8]} levelId {lv} → {MAP[lv]}', 'op': 'update_road', 'args': {'id': i, 'expectedRevision': int(r), 'zMode': 'explicit', 'densify': False, 'attrs': {'levelId': MAP[lv]}}, 'grade': '확정(이름 규칙)', 'evidence': LV})
    for l in q("select id, revision, level_id from mobility.places where status<>'RETIRED' and level_id in ('" + "','".join(MAP) + "')"):
        i, r, lv = l.split('|')
        ops.append({'ref': f'장소 {i[:8]} levelId {lv} → {MAP[lv]}', 'op': 'update_place', 'args': {'id': i, 'expectedRevision': int(r), 'levelId': MAP[lv]}, 'grade': '확정(이름 규칙)', 'evidence': LV})
    gid, comment = 'X22-LEVELS', 'levelId 를 "건물_층" 꼴로(북악관 _추정 꼬리 뗌). 시험용 DB 만'
(HERE / 'groups').mkdir(exist_ok=True)
chunks = [ops] if len(ops) <= 25 else [ops[i:i + 20] for i in range(0, len(ops), 20)]   # apply_changes 한 번에 25 개까지
for k, part in enumerate(chunks):
    tag = f'-{k + 1}' if len(chunks) > 1 else ''
    (HERE / 'groups' / f'x22-{sys.argv[1]}{tag}.json').write_text(json.dumps({'id': gid + tag, 'comment': comment, 'ops': part}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(f'x22-{sys.argv[1]}{tag}', len(part))
