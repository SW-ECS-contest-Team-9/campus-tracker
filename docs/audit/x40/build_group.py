"""X40 시험용 DB 변경 묶음(2026-10-23). DB 는 읽기만(docker psql).   python -I -B build_group.py -> groups/x40-roads-a.json, -b.json
적용: C:\\campus-tracker-testdb\\backend 에서 npx tsx ../docs/audit/n02/n02.ts apply ../docs/audit/x40/groups/x40-roads-a.json, -b.json <결과> --commit (시험용 DB 만).
- 2 대일관 서쪽 현관 참 → 동쪽 옆 아치 → 데크 서쪽 끝(acd80bae 를 아치 가운데로 곧게)
- 3·4 통 계단(옛 굽은 돌계단 길 040d4571 걷음), 마당 → 카페 앞 평탄부 난간 계단, 평탄부 → 타일 면 3단, 타일 면 → 대일관 옆 계단 발치(새 아랫단 5단)
- 5 청운관 앞 참 위 작은 계단을 뒤쪽(-v)으로
- 6 은주1관 정면: 북쪽 아랫줄 → 가운데 참 128.9 → 위 두 줄 → 테라스 → 입구(1), 남쪽 아랫줄 → 위쪽 갈래 차도
근거: 볼트 구역 노트 오르막길과 주변·건물 노트 대일관·청운관·은주관 X40 절, 구조물 x40/build_parts.py(model.json)."""
import json, math, pathlib, subprocess, importlib.util, sys
import numpy as np
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent; AUDIT = HERE.parent
def mod(name): sp = importlib.util.spec_from_file_location(name, AUDIT / name / 'common.py'); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m); return m
G = mod('g02'); Z = mod('z02')
def q(sql): return [l.split('|') for l in subprocess.run(['docker', 'exec', 'campus-tracker-test-db', 'psql', '-U', 'campus', '-d', 'campus', '-At', '-F', '|', '-c', sql], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()]
def road(prefix):
    (rid, rev, a, b), = q(f"select id, revision, from_node_id, to_node_id from mobility.road_segments where status='DRAFT' and id::text like '{prefix}%'"); return rid, int(rev), a, b
def node(prefix): (nid,), = q(f"select id from mobility.network_nodes where id::text like '{prefix}%'"); return nid
r2 = lambda v: round(float(v), 2)
ST = lambda s, t: [r2(c) for c in G.st_to_xy(s, t)]
UV = lambda u, v: [r2(c) for c in Z.uv_to_xy(u, v)]
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8'))
base = {'roadClass': 'pedestrian', 'pedestrianAccess': 'allowed', 'vehicleAccess': 'prohibited', 'zMode': 'explicit', 'densify': False}
ops = []
def P(xy, z): return {'xy': xy, 'z': r2(z)}
def add(ref, args, grade, ev, op='create_road'): ops.append({'ref': ref, 'op': op, 'args': args, 'grade': grade, 'evidence': ev})

# ---- 2 현관 참 → 동쪽 옆 아치 → 데크 ----
EV2 = '영상 1 frames t068~t076(현관 회랑 끝 아치), 사용자 표시 항공/사용자표시-대일관현관-동쪽-틈.webp, 구조물 X40-PORCH-E-PIER'
GR2 = '확정(트인 통로: 사용자), 추정(선)'
rid, rev, a, b = road('acd80bae')
ARCH = [201161.69, 557310.2]
add('현관 참 → 동쪽 옆 아치 → 데크 서쪽 끝: 꺾인 가운데 꼭짓점을 아치 가운데로', {'id': rid, 'expectedRevision': rev, 'zMode': 'explicit', 'densify': False, 'attrs': {'name': '대일관 현관 참: 동쪽 옆 아치(트인 통로)로 데크 서쪽 끝까지 (151.3 m, 턱 없음)'},
    'vertexOps': [{'op': 'move', 'index': 1, 'point': P(ARCH, 151.3)}]}, GR2, EV2, 'update_road')

# ---- 3·4 문예관 저층부 동쪽 끝 ----
EV3 = '사용자 편집기 표시(타일면 화살표·통계단), 사진 문예관-저층부-동쪽끝-계단-위에서, 구역 노트 오르막길과 주변 X40 절, 구조물 X40-FULL-STAIR·X40-FORK-TOP-STAIR·X40-TILE·X40-SIDE-STAIR-LOW'
GR3 = '확정(통 계단·평평한 타일 면: 사용자), Claude 결정(짜임·높이: 사진), 추정(선)'
F4 = M['fullStair']; S4 = (F4['s'][0] + F4['s'][1]) / 2 + 1.0
zl = lambda s: float(np.interp(s, [-3.5, 20, 55, 100, 110], [130.96, 133.75, 138.95, 146.68, 148.9]))
old, orev, oa, ob = road('040d4571')
add('옛 굽은 돌계단 길(통 계단으로 바뀜)', {'type': 'road', 'id': old, 'expectedRevision': orev}, GR3, EV3, 'retire_feature')
lane, *_ = road('8e71c240')
FOOT = ST(S4, F4['t'][0] - 1.0)
add('통 계단 길: 지상 오르막(8e71c240) → 계단 발치 → 마당 144.2 → 갈림 지점 3df2b596', {**base, 'name': f"문예관 저층부 앞 통 계단 (오르막 {zl(S4):.2f} → 차양 앞 마당 144.2 m, 폭 9.4 m 전체가 계단, {F4['risers']}단 추정)", 'structure': 'stairs', 'widthM': 9.4,
    'path': [{'at': {'roadId': lane, 'nearest': FOOT}}, P(ST(S4, F4['t'][0]), zl(S4)), P(ST(S4, F4['t'][1] + 0.3), 144.2)]}, GR3, EV3)
add('통 계단 머리 → 갈림 지점(144.3)', {**base, 'name': '차양 앞 마당 (144.2 m): 통 계단 머리 → 갈림 지점', 'structure': 'ordinary', 'widthM': 3.0,
    'path': [P(ST(S4, F4['t'][1] + 0.3), 144.2), {'at': {'nodeId': node('3df2b596')}}]}, GR3, EV3)
FT = M['forkTop']; TT = (FT['t'][0] + FT['t'][1]) / 2
for pre in ('a7a51d3c', '706a4384'):
    rid, rev, *_ = road(pre); add(f'옛 길 {pre}(마당 → 평탄부 계단·타일 면 길을 새 계단 자리로)', {'type': 'road', 'id': rid, 'expectedRevision': rev}, GR3, EV3, 'retire_feature')
ST_W = M['tile']['sWest']
add('마당 85a0ed07 → 난간 계단 → 카페 앞 평탄부', {**base, 'name': '차양 앞 마당 144.2 → 카페 앞 평탄부 145.5 m 난간 계단 (8단 추정, 사진)', 'structure': 'stairs', 'widthM': 4.0,
    'path': [{'at': {'nodeId': node('85a0ed07')}}, P(ST(FT['s'][0] - 0.2, TT), 144.2), P(ST(FT['s'][1] + 0.2, TT), 145.5)]}, GR3, EV3)
add('카페 앞 평탄부 → 타일 면 3단 앞', {**base, 'name': '카페 SP 앞 평탄부 (145.5 m)', 'structure': 'ordinary', 'widthM': 3.0,
    'path': [P(ST(FT['s'][1] + 0.2, TT), 145.5), P(ST(ST_W - 0.8, 11.2), 145.5)]}, GR3, EV3)
add('평탄부 → 타일 면(3단)', {**base, 'name': '카페 앞 평탄부 145.5 → 타일 면 145.95 m (3단)', 'structure': 'stairs', 'widthM': 2.5,
    'path': [P(ST(ST_W - 0.8, 11.2), 145.5), P(ST(ST_W + 0.2, 11.2), 145.95)]}, GR3, EV3)
sid, srev, sa, sb = road('f50b9ad8'); foot = node('2ca531d8')
NEWFOOT = ST(97.1, 13.0)
add('대일관 옆 계단 발치 노드 → 새 아랫단 아래(타일 면 145.95)', {'nodeId': foot, 'to': P(NEWFOOT, 145.95)}, GR3, EV3, 'move_node')
add('대일관 옆 계단 길 이름(34단)', {'id': sid, 'expectedRevision': srev + 1, 'attrs': {'name': '대일관에서 내려오는 계단 (SP 카페 데크 끝 옆, 34단 추정, 151.3 → 145.95 m: 아랫단 5단은 타일 면 위, 넓은 돌계단·가운데 난간·가운데 참)'}}, GR3, EV3, 'update_road')
add('타일 면 길: 3단 머리 → 카페 데크 앞 59f9ab35 → 옆 계단 발치', {**base, 'name': '타일 면 (조각 돌 포장, 평평 145.95 m: 카페 SP 데크 앞 ~ 대일관 옆 계단 발치)', 'structure': 'ordinary', 'widthM': 3.0,
    'path': [P(ST(ST_W + 0.2, 11.2), 145.95), P(ST(90.0, 11.6), 145.95), {'at': {'nodeId': foot}}]}, GR3, EV3)
# ---- 5 청운관 앞 참 위 작은 계단을 뒤쪽으로 ----
EV5 = '사진 청운관-정면-운동장에서-상승관계단.webp(참에서 뒤로 곧게 오름), 구조물 X22-SANGSEUNG-STAIR(X40 에서 돌림)'
GR5 = '확정(사진), 추정(선)'
add('작은 계단 발치 노드 → 계단 앞(v −1.0)', {'nodeId': node('5d945df0'), 'to': P(UV(55.5, -1.0), 151.0)}, GR5, EV5, 'move_node')
add('작은 계단 머리 노드 → 위 끝(v −4.45)', {'nodeId': node('bb967025'), 'to': P(UV(55.5, -4.45), 153.1)}, GR5, EV5, 'move_node')
rid, rev, *_ = road('a5668b4f')
add('작은 계단 길 이름', {'id': rid, 'expectedRevision': rev + 2, 'attrs': {'name': '상승관 쪽 작은 계단 (12단 추정, 151.0 → 153.1 m, 참에서 뒤쪽으로 곧게: 사진 2026-10-23)'}}, GR5, EV5, 'update_road')

N6 = len(ops)
# ---- 6 은주1관 정면 ----
EV6 = '사진 사진/은주1관-정면-바위정원-곡선계단.webp, 카카오 항공(평면), 구조물 X40-EUNJU-*, 건물 노트 은주관 X40 절'
GR6 = '확정(짜임·굽이에서 오름: 사진·사용자 화살표), Claude 결정(높이 128.9), 추정(선)'
E = M['eunju1']; TC = np.array(E['TC']); ND = np.array(E['ND']); WD = np.array(E['WD']); ZW, ZT = E['landingZ'], E['terraceZ']
def PP(r, phi): a = math.radians(phi); return [r2(c) for c in TC + r * (math.cos(a) * ND + math.sin(a) * WD)]
sid, srev, sa, sb = road('850b756f'); top = node('20be4c38'); door = node('de20cbd7')
add('북쪽 아랫줄 위 끝 노드 → 가운데 참 높이 128.9', {'nodeId': top, 'to': P([201115.74, 557257.53], ZW)}, GR6, EV6, 'move_node')
(pts,), = q(f"select string_agg(st_x(dp.geom)||' '||st_y(dp.geom)||' '||st_z(dp.geom), ',') from st_dumppoints((select geom from mobility.road_segments where id='{sid}')) dp")
ps = [[float(v) for v in p.split()] for p in pts.split(',')]
new = [P([p[0], p[1]], 125.2 + (p[2] - 125.2) * (ZW - 125.2) / (131.3 - 125.2)) for p in ps]
add('북쪽 아랫줄 길(높이 다시 나눔)', {'id': sid, 'expectedRevision': srev + 1, 'zMode': 'explicit', 'densify': False, 'attrs': {'name': f'은주1관 북쪽 아랫줄 곡선 돌계단 (24단 추정, 굽이 125.2 → 가운데 참 {ZW} m, 사용자 지정 길)'}, 'path': new}, GR6, EV6, 'update_road')
rid, rev, *_ = road('9a5da733'); add('옛 테라스 → 입구(1) 길(반원 테라스가 없어짐)', {'type': 'road', 'id': rid, 'expectedRevision': rev + 1}, GR6, EV6, 'retire_feature')
AN, AS = PP(5.4, 12), PP(5.4, -12)
add('가운데 참: 북쪽 아랫줄 머리 → 북쪽 위 줄 앞', {**base, 'name': f'은주1관 가운데 참 ({ZW} m, 둥근 화단 앞)', 'structure': 'ordinary', 'widthM': 2.0, 'path': [{'at': {'nodeId': top}}, P(PP(5.6, 26), ZW), P(AN, ZW)]}, GR6, EV6)
add('가운데 참: 북 → 남(둥근 화단 안쪽)', {**base, 'name': f'은주1관 가운데 참 ({ZW} m, 둥근 화단 안쪽)', 'structure': 'ordinary', 'widthM': 2.0, 'path': [P(AN, ZW), P(PP(5.0, 0), ZW), P(AS, ZW)]}, GR6, EV6)
for nm, sg, A in (('북', 1, AN), ('남', -1, AS)):
    arc = [P(PP(4.0, sg * p), ZW + (ZT - ZW) * (p - 10) / 75) for p in (10, 25, 40, 55, 70, 85)]
    add(f'{nm}쪽 위 줄 곡선 계단', {**base, 'name': f'은주1관 {nm}쪽 위 곡선 계단 (15단 추정, 가운데 참 {ZW} → 위 테라스 {ZT} m, 사진)', 'structure': 'stairs', 'widthM': 1.2, 'path': [P(A, ZW)] + arc}, GR6, EV6)
    add(f'{nm}쪽 계단 머리 → 입구(1) 문', {**base, 'name': f'은주1관 위 테라스 ({ZT} m): {nm}쪽 계단 머리 → 입구(1) 아치 문', 'structure': 'ordinary', 'widthM': 1.6,
        'path': [P(PP(4.0, sg * 85), ZT), P([r2(c) for c in TC + ND * 0.9 + WD * sg * 1.2], ZT), {'at': {'nodeId': door}}]}, GR6, EV6)
wr, *_ = road('41dc7abe')
add('남쪽 아랫줄: 가운데 참 남쪽 끝 → 위쪽 갈래 차도', {**base, 'name': f"은주1관 남쪽 아랫줄 계단 (가운데 참 {ZW} → 위쪽 갈래 차도 {E['southFootZ']} m, 사진: 남쪽으로 벌어져 내려감, 단 수 추정)", 'structure': 'stairs', 'widthM': 2.0,
    'path': [P(AS, ZW), P(E['southTop'], ZW), P(E['southFoot'], E['southFootZ'])]}, GR6, EV6)
add('남쪽 아랫줄 발치 → 위쪽 갈래 차도(41dc7abe)', {**base, 'name': '은주1관 남쪽 아랫줄 발치 → 위쪽 갈래 차도', 'structure': 'ordinary', 'widthM': 2.0, 'path': [P(E['southFoot'], E['southFootZ']), {'at': {'roadId': wr, 'nearest': [201108.31, 557248.4]}}]}, GR6, EV6)

(HERE / 'groups').mkdir(exist_ok=True)
for nm, part, cm in (('x40-roads-a', ops[:N6], 'X40 항목 2~5 길(시험용 DB 만)'), ('x40-roads-b', ops[N6:], 'X40 항목 6 은주1관 정면 길(시험용 DB 만)')):
    (HERE / 'groups' / f'{nm}.json').write_text(json.dumps({'id': nm.upper(), 'comment': cm, 'ops': part}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(nm, len(part), 'ops')
