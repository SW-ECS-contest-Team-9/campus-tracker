"""B03 2단계 — 운영 실내 길(스냅숏)의 층 표기·높이를 1단계 층 바닥 높이와 견준다. 분석만 한다(DB·MCP 쓰기 없음).

  python docs/audit/b03/network.py <audit-dir> <anchors.json> <out.json>

입력: <audit-dir>/claude-live/roads-live-2.json (운영 도로 스냅숏 2026-10-09), anchors.py 의 결과.
- 동별로 실내 길(복도·계단·승강기)의 평평한 높이를 모아 "저장된 층"으로 묶고, 사다리에서 가장 가까운 층과 차이를 적는다.
- 길 이름에 적힌 층(B1, 1F, 2F, 1층 ...)과 levelId 를 함께 적는다.
- B06 갱신: docs/audit/b06/results.json (사용자 확정 2026-10-10 과 S-MAP 판독)을 읽어 북악관 B1·사슬 2a·2c·1a 제안을 더한다.
- 제안(PROPOSALS)은 사람이 정한 규칙표다: 층 이름 바꾸기(relabel_level), 이어진 실내 묶음의 높이 옮기기(shift_z). 근거 등급을 붙인다. 적용하지 않는다.
"""
import json, pathlib, re, sys, collections
sys.stdout.reconfigure(encoding='utf-8')
audit, anchors, out = map(pathlib.Path, sys.argv[1:4])
A = json.loads(anchors.read_text(encoding='utf-8')); LAD = {b: {k: v for k, v in s['ladder'].items()} for b, s in A['buildings'].items()}
roads = json.loads((audit / 'claude-live/roads-live-2.json').read_text(encoding='utf-8'))['items']
ALIAS = {'건물5': '혜인관'}                      # 서버 건물 id -> 동 이름 (혜인관 노트)
INDOOR = ('indoor_corridor', 'stairs', 'elevator')
r1 = lambda v: round(float(v), 1); r2 = lambda v: round(float(v), 2)


def named_floor(name):
    m = re.search(r'(B\d|\d+F|\d+층|지하)', name or '')
    return m.group(1) if m else None


def nearest(b, z):
    lad = LAD.get(b) or (LAD.get(b + '1관') if b == '은주' else None)
    if not lad: return None
    k = min(lad, key=lambda f: abs(lad[f][0] - z)); return {'floor': k, 'ladderM': lad[k][0], 'kind': lad[k][1], 'storedMinusLadderM': r1(z - lad[k][0])}


by = collections.defaultdict(list)
for r in roads:
    if r['buildingId'] and r['structure'] in INDOOR: by[ALIAS.get(r['buildingId'], r['buildingId'])].append(r)
T = {}
for b, rs in sorted(by.items()):
    levels = collections.defaultdict(lambda: {'corridors': [], 'names': collections.Counter(), 'levelIds': collections.Counter(), 'zRange': [1e9, -1e9]})
    connectors = []
    for r in rs:
        z = [c[2] for c in r['coordinates']]; lo, hi = min(z), max(z)
        if r['structure'] == 'indoor_corridor' or hi - lo < 1.0:
            # 0.5 m 안의 높이는 같은 층으로 묶는다
            key = next((k for k in levels if abs(k - (lo + hi) / 2) <= 0.5), r1((lo + hi) / 2)); L = levels[key]
            L['corridors'].append(r['id'][:8]); L['names'][named_floor(r['name'])] += 1; L['levelIds'][r['levelId']] += 1
            L['zRange'] = [min(L['zRange'][0], lo), max(L['zRange'][1], hi)]
        else:
            connectors.append({'id': r['id'][:8], 'structure': r['structure'], 'fromM': lo, 'toM': hi, 'riseM': r2(hi - lo), 'name': r['name'], 'levelId': r['levelId']})
    rows = []
    for k in sorted(levels):
        L = levels[k]; mid = (L['zRange'][0] + L['zRange'][1]) / 2
        rows.append({'storedM': [r2(L['zRange'][0]), r2(L['zRange'][1])], 'roads': len(L['corridors']), 'roadIds': L['corridors'],
                     'namedFloor': {str(a): c for a, c in L['names'].items()}, 'levelId': {str(a): c for a, c in L['levelIds'].items()}, 'nearestLadderFloor': nearest(b, mid)})
    steps = [r2(rows[i + 1]['storedM'][0] - rows[i]['storedM'][0]) for i in range(len(rows) - 1)]
    T[b] = {'serverBuildingId': next((k for k, v in ALIAS.items() if v == b), b), 'indoorRoads': len(rs), 'storedLevels': rows, 'stepsBetweenStoredLevelsM': steps, 'connectors': connectors}

ids = lambda b, lo, hi: sorted(r['id'] for r in by[b] if lo - 0.01 <= min(c[2] for c in r['coordinates']) and max(c[2] for c in r['coordinates']) <= hi + 0.01)
touch = lambda b, z: sorted(r['id'] for r in by[b] if min(c[2] for c in r['coordinates']) - 0.01 <= z <= max(c[2] for c in r['coordinates']) + 0.01)
bk = A['buildings']['북악관']; e = {x['name']: x for x in A['entrances']}
# 북악관: 보행 기록으로 만든 8단과 S-MAP 지붕
walk = [132.8, 136.7, 140.6, 143.47, 146.18, 148.92, 151.79, 154.51]; top_step = walk[-1] - walk[-2]
bukak = {'storedLadderM': walk, 'stepsM': [r2(b - a) for a, b in zip(walk, walk[1:])], 'smapRoofM': bk['smapRoofM'],
         'if8StoreysRoofM': r1(walk[-1] + top_step), 'if8StoreysMinusSmapRoofM': r1(walk[-1] + top_step - bk['smapRoofM']),
         'if9StoreysRoofM': r1(walk[-1] + 2 * top_step), 'if9StoreysMinusSmapRoofM': r1(walk[-1] + 2 * top_step - bk['smapRoofM']),
         'entrances1F': {n: [e[n]['groundM'], e[n]['spread']] for n in ('북악관 입구(1)', '북악관 입구(2)', '북악관 입구(3)')}, 'entranceB1': [e['북악관 입구(4)']['groundM'], e['북악관 입구(4)']['spread']],
         'reading': '4층 없음(사용자 확정)이면 8단 = 1,2,3,5~9층으로 건물의 모든 층이다. 맨 위 단 위로 한 층 높이를 더한 지붕이 S-MAP 지붕보다 3.4 m 낮다(난간·지붕 구조물이거나 저장 Z 가 낮은 것. 남는 차이)'}
P = []
add = lambda **k: P.append(k)
add(building='북악관', op='relabel_level', roadIds=touch('북악관', 132.8) and ids('북악관', 131.0, 132.9), fromLabel="이름 'B1' (levelId 없음)", toLabel='1층', grade='원천+S-MAP',
    evidence=f"학교 출입구 목록: 정면 입구 3곳이 1층(로비·복도), S-MAP 지면 {e['북악관 입구(3)']['groundM']}~{e['북악관 입구(1)']['groundM']} m. 저장 높이 132.8 m 가 그 범위 안. B1층 입구는 따로 있다")
add(building='북악관', op='relabel_level', roadIds=ids('북악관', 136.2, 136.9), fromLabel="이름 '1F'", toLabel='2층', grade='원천+S-MAP(순서)', evidence='132.8 m 가 1층이면 그 위 단(136.7 m)은 2층')
add(building='북악관', op='relabel_level', roadIds=ids('북악관', 140.6, 140.6), fromLabel="이름 '2F'", toLabel='3층', grade='원천+S-MAP(순서)', evidence='같은 이유. 140.6 m 는 3층')
for z, lab in zip(walk[3:], ('5층', '6층', '7층', '8층', '9층')):
    add(building='북악관', op='relabel_level', roadIds=ids('북악관', z, z), fromLabel=f'levelId 북악관_Z{z}_추정 또는 없음', toLabel=lab, grade='확정+원천(순서)', evidence='사용자 확정 2026-10-10: 학교 건물에는 4층이 없다(3층 다음이 5층). 132.8 m 가 1층이면 8단은 1·2·3·5·6·7·8·9층이다. 단 높이(저장 Z)는 보행 기록 추정 그대로')
add(building='북악관', op='relabel_level', roadIds=sorted(r['id'] for r in by['북악관'] if r['structure'] != 'indoor_corridor' and max(c[2] for c in r['coordinates']) - min(c[2] for c in r['coordinates']) >= 1.0 and re.search(r'B1|1F|2F', r['name'] or '')),
    fromLabel="계단·승강기 이름의 'B1-1F', '1F-2F', '2F-…'", toLabel="'1층-2층', '2층-3층', '3층-…'", grade='원천+S-MAP(순서)', evidence='층 이름이 한 층씩 밀려 있다')
y9 = e['유담관 입구(2)']
add(building='유담관', op='relabel_level', roadIds=ids('유담관', 129.3, 129.7), fromLabel="이름 '하부', levelId 없음", toLabel='9층', grade='확정+원천',
    evidence='사용자 확정: 버스 정류장 쪽에서 들어간 자리가 9층. 학교 출입구 목록: 입구(2) = 9층. 이 묶음은 그 입구 옆(북쪽 면)에서 시작한다')
yl = A['buildings']['유담관']['ladder']
add(building='유담관', op='no_change', roadIds=sorted(r['id'] for r in by['유담관']), deltaM=0, grade='추정',
    evidence=f"입구 층 저장 129.38~129.6 m 대 탑 북서 모서리 앞마당 S-MAP 지면 {yl['9'][0]} m: 맞는다. 입구(2) 표지의 벽 앞 지면은 {y9['groundM']} m 로 2.7 m 낮지만 표지가 문에서 어긋난 것으로 본다(추정). 옮기지 않는다")
add(building='유담관', op='relabel_level', roadIds=ids('유담관', 145.22, 145.22) + ids('유담관', 152.84, 152.84), fromLabel="이름 '상부', levelId 없음", toLabel='13층·15층', grade='추정(층 수) + 확정(13층 있음)',
    evidence=f"승강기 정지 높이가 입구 층(9층)보다 15.62 m, 23.24 m 높다 = 층당 3.9 m 로 4개·6개 층. B06: 13층은 있다(사용자 확정 2026-10-10)이므로 9층에서 4개 층 위는 13층, 6개 층 위는 15층이다. 계산한 13층 {yl['13'][0]} m, 15층 {yl['15'][0]} m 와 1.0 m 안에서 맞는다. B03 의 '14층·16층'은 거둔다. 층 수는 층고가 같다는 가정의 추정")
d = A['buildings']['대일관']['ladder']['1'][0]
add(building='대일관', op='shift_z', roadIds=sorted(r['id'] for r in by['대일관']), deltaM=r1(d - 145.8), deltaRangeM=[r1(e['대일관 입구(2)']['spread'][0] - 145.8), r1(e['대일관 입구(3)']['spread'][1] - 145.8)], grade='S-MAP',
    evidence=f"1층 복도 입구 두 곳의 S-MAP 벽 앞 지면 {e['대일관 입구(2)']['groundM']}, {e['대일관 입구(3)']['groundM']} m -> 1층 {d} m. 저장 145.80 m 는 옛 운동장 높이(141.73)에 맞춘 값. 운동장 쪽 오차 +7.2 m 와 같은 종류지만 양은 다르다(+6.0)")
add(building='대일관', op='relabel_level', roadIds=sorted(r['id'] for r in by['대일관']), fromLabel='levelId 없음', toLabel='1층', grade='원천', evidence="길 이름이 이미 '1층 내부 통로'. 학교 출입구 목록의 1층 복도 입구와 같은 층")
add(building='대일관', op='shift_z', scope='건물 id 가 없는 대일관 앞·옆 실외 계단 6개(141.73~145.80 m)', roadIds=sorted(r['id'] for r in roads if not r['buildingId'] and r['structure'] == 'stairs' and '대일관' in (r['name'] or '')),
    deltaM=None, grade='추정', evidence=f"아래 끝은 운동장(148.9, 측정) 또는 현관 앞 바닥({e['대일관 입구(1)']['groundM']}, S-MAP), 위 끝은 1층({d}). 저장된 단차 4.07 m 대 실제 약 1.9~2.9 m 라 통째 이동으로는 맞지 않는다. 끝점마다 다시 정해야 한다(E07 의 대일관 앞 145.80 평탄면과 같은 문제)")
m3 = A['buildings']['문예관']
add(building='문예관', op='relabel_level', roadIds=ids('문예관', 142.44, 142.44), fromLabel="이름 '상부 진입 통로', levelId 없음", toLabel='3층', grade='원천+S-MAP',
    evidence=f"학교 출입구 목록: 입구(1) = 3층 로비. 저장 142.44 m 는 입구 둘레 S-MAP 지면 {e['문예관 입구(1)']['spread'][0]}~{e['문예관 입구(1)']['spread'][1]} m 의 위쪽 끝과 맞고, 2층 입구 지면 {e['문예관 입구(2)']['groundM']} m 보다 3.5 m 높다(한 층)")
add(building='문예관', op='relabel_level', roadIds=ids('문예관', 136.39, 136.39), fromLabel="이름 '지하'", toLabel='1층(추정) — 지하는 아님', grade='추정',
    evidence=f"136.39 m 는 3층(142.44)보다 6.05 m, 2층 입구 지면({e['문예관 입구(2)']['groundM']})보다 2.5 m 낮다. 2개 층 아래(층당 3.0 m)면 1층이다. 학교 표기의 B1 은 그보다 더 아래다")
h = A['buildings']['혜인관']['ladder']
add(building='혜인관', op='rename_building_id', roadIds=sorted(r['id'] for r in by['혜인관']), fromLabel="buildingId '건물5'", toLabel='혜인관', grade='확정', evidence='혜인관 노트(H02): 서버 건물 id 가 뒤바뀌어 있다. 건물 id 정리와 함께 해야 한다')
add(building='혜인관', op='shift_z', roadIds=sorted(r['id'] for r in by['혜인관']), deltaM=-1.1, deltaRangeM=[-1.7, -0.9], grade='추정',
    evidence=f"'B1' 통로 150.26~150.94 m 대 B1 입구 두 곳의 S-MAP 지면 {h['B1'][0]} m (운동장 높이). 0.9~1.6 m 높다. '1층' 154.25~155.09 m 대 사다리 1층 {h['1'][0]} m, 승강기 6F 171.0 m 대 사다리 6층 {h['6'][0]} m: 세 층 모두 약 1.1 m 높다(층 간격은 맞음). B1 바닥이 바깥 지면보다 1 m 높을 수도 있어(문턱·계단) 옮기지 않는 쪽을 권한다")
# ---- B06 (2026-10-10): 사용자 확정(북악관 B1 = GS25 문, 사진 10 의 길)과 S-MAP 1 m 판독으로 더한 제안. 모두 제안만.
B06 = json.loads((pathlib.Path(__file__).resolve().parent.parent / 'b06/results.json').read_text(encoding='utf-8'))
bd = B06['bukakB1']; a14 = B06['a14']
add(building='북악관', op='add_level', roadIds=[], toLabel='B1층 (새 층. 지금 저장된 길 중 이 층은 없다)', heightM=None, heightUpperBoundM=bd['doorGroundM'], heightComputedM=r1(132.8 - bk['storeyHeightBelowAnchorsM']), grade='확정(층·문) / 높이는 모름',
    evidence=f"사용자 확정 2026-10-10: B1층 입구 = GS25 로 들어가는 문(사진 08 = 학교 입구(4)). 문 앞 S-MAP 지면 {bd['doorGroundM']} m ({bd['doorGroundRangeM'][0]}~{bd['doorGroundRangeM'][1]}, 1 m 판독). 1층(132.8~133.1 m)과 1.1~1.4 m 차뿐이라 문 앞 지면은 B1 바닥이 아니다(문 안에서 내려가는 구조로 보임, 추정). B1 바닥은 이 값 이하. 층고 3.44 m 로 계산하면 {r1(132.8 - bk['storeyHeightBelowAnchorsM'])} m(추정). 높이가 정해지기 전에는 B1 실내 길을 만들지 않는다")
add(building='북악관', op='create_node', chain='2c', roadIds=[], coordinate=bd['door'], grade='확정(문이 있다는 사실) + 원천(학교 표지 위치) + S-MAP(지면)',
    evidence=f"사슬 2c 의 문 노드. 학교 표지 (201009.8, 557395.0)는 S-MAP 건물 칸 가장자리 0.8 m 안쪽이라 벽 앞 칸으로 옮겼다. 평면 오차 2 m 가정. 실내 쪽(B1 바닥, 가장 가까운 운영 실내 길 a648c084)과는 잇지 않는다: B1 바닥 높이 모름")
add(building='북악관', op='create_road', chain='2c', roadIds=[], coordinates=bd['approach'], structure='ordinary(실외 보행)', grade='S-MAP(평면·높이). 길이 실제로 포장 보행로인지는 사진 08(추정)',
    evidence='사슬 2c 의 실외 구간: 북악관 서쪽 끝 벽을 따라 정면 광장 모서리에서 GS25 문 앞까지. S-MAP 1 m 판독에서 벽 앞 1~2 m 칸의 높이. 옆길이 계단인지 경사인지는 사진 08 에서 경사 포장으로 보인다(추정)')
add(building='북악관', op='create_road', chain='2a', roadIds=[], coordinates=bd['sideLane'], joinsNode='7895ac0d (저장 128.13 m)', grade='S-MAP(높이). 평면은 2차 후보 선(추정)',
    evidence=f"사슬 2a 의 옆길: 후보 선 (201001.9, 557387.6) → (201016.0, 557418.2) 위의 S-MAP 지면은 {bd['sideLane'][0][2]} → {bd['sideLane'][-1][2]} m 로 북쪽으로 오른다. 뒤편 산책로 끝 노드 7895ac0d 는 128.13 m 로 저장돼 있어 같은 자리 S-MAP 지면보다 {bd['promenadeEndGapM']} m 낮다. 옆길을 S-MAP 높이로 그리면 이 노드에서 단이 생긴다: 산책로 서쪽 끝 높이를 먼저 고쳐야 한다. 사용자 말 '지하로 내려가는 옆길'과 S-MAP 의 '북쪽으로 오르는 지면'은 어긋난다(기록, 미정)")
add(building='문예관·대일관 사이', op='create_road', chain='1a', roadIds=[], coordinates=a14['stub'], structure='stairs', joinsNode='4f294196 (201106.22, 557324.73, 저장 141.73 m)', grade='확정(길이 있다는 사실·방향: 사용자 그림) / 평면 추정(±3 m) / 높이 S-MAP',
    evidence=f"사용자 그림(사진 10): 대일관 서쪽 끝에서 온 길이 갈림 지점에서 남서쪽으로 짧게 내려간다. 그 끝이 문예관 옆 오르막 c52095ad 의 위 끝 노드 4f294196 에서 {a14['stubEndToNodeM']} m 다. S-MAP 지면 {a14['stub'][0][2]} → {a14['stub'][-1][2]} m. 사슬 1a 의 빠진 구간(A14 아래 끝)이 여기다. 2차 후보의 A14 아래 끝 (201118, 557312, 141.3)은 사용자 그림 위에 없어 거둔다")
add(building='문예관·대일관 사이', op='shift_z', chain='1a·2b', roadIds=sorted(r['id'] for r in roads if r['id'][:8] in ('618385b9', 'a7a51d3c', 'fdb059c4', '9112314a', '3ab80c19')), deltaM=None, storedM=[143.8, 142.44], smapM=a14['eastBranchZ'] + [a14['forkZ']], grade='S-MAP(높이) / 평면 일치는 추정',
    evidence=f"사용자 그림의 동쪽 갈래와 문예관 쪽 갈래는 운영 길 618385b9 서쪽 절반 → a7a51d3c → fdb059c4 → 9112314a → 3ab80c19 와 {a14['lineToRoadsM']} m 안에서 겹친다(확정: 이 길이 실제 동선). 그 자리 S-MAP 지면은 {a14['eastBranchZ'][0]}~{a14['eastBranchZ'][1]} m, 갈림 지점 {a14['forkZ']} m 로 저장 높이(143.8, 142.44)보다 1.6~1.8 m 높다. G1 묶음이라 끝점별로 다시 정해야 한다(통째 이동 아님)")
# ---- B07 (2026-10-10): 사용자 그림 14(본관·북악관 사이 지하 공간). 범례는 확정, 좌표는 그림에서 옮긴 추정(±2 m). 모두 제안만.
D14 = json.loads((pathlib.Path(__file__).resolve().parent.parent / 'b07/drawing14.json').read_text(encoding='utf-8')); f14 = D14['features']
z14 = lambda q: [*q['xy'], q['smap'][0] if q['smap'][1] == 'terrain' else None]
add(building='본관·북악관 사이', op='create_road', chain='2d', roadIds=[], structure='ordinary(실외 보행: 계단 위 → 횡단보도 → 통로 → 북악관 벽 앞 계단)',
    coordinates=[z14(f14['mainSideStairs']['centre']), z14(f14['crossing']['from']), z14(f14['crossing']['to']), z14(f14['bukakPassage']['centre']), z14(f14['bukakStairs']['centre'])],
    grade='확정(계단·횡단보도·통로·계단이 이 순서로 있다: 사용자 그림 14) / 평면 추정(±2 m) / 높이 S-MAP 지상 면(계단 아래·통로 바닥 높이는 모름)',
    evidence=f"사용자 그림 14: 본관 북서 모서리 앞 계단(본관 입구(2) 표지에서 {D14['compare']['markers']['본관 입구(2)']['toMainSideStairsM']} m) → 차도를 건너는 횡단보도 → 북악관 쪽 통로(상자) → 북악관 벽 앞 계단(북악관 입구(1) 표지에서 {D14['compare']['markers']['북악관 입구(1)']['toBukakStairsM']} m). 두 계단이 오르는지 내리는지, 통로가 지상인지 지하인지는 그림에 없다(모름). 마지막 점은 건물 칸이라 높이 없음")
add(building='북악관', op='no_change', roadIds=sorted(r['id'] for r in roads if r['id'][:8] in ('f99540e3', '8fde6a04')), grade='추정',
    evidence=f"운영 길 f99540e3('북악관 B1 진입 계단 (추정)')과 8fde6a04 의 북악관 쪽 끝은 사용자 그림 14 의 북악관 벽 앞 계단에서 {D14['compare']['markers']['8fde6a04 끝(북악관 B1 진입 계단 아래)']['toBukakStairsM']} m 다. 계단 자리는 그림과 맞는다. 다만 8fde6a04 는 951c157d 아래 끝에서 지하로 곧장 이어지는 차량 선으로 저장돼 있고, 그림은 그 사이를 지상의 횡단보도와 통로로 그렸다. 두 지하 공간이 지하로 이어지는지는 모름: 그대로 두고 사용자 확인 뒤 정한다")
add(building='북악관', op='record_only', roadIds=[], coordinates=[f14['bukakWallStrip']['from']['xy'], f14['bukakWallStrip']['to']['xy']], grade='확정(북악관 남쪽 벽을 따라 지하 공간이 있다: 사용자 그림 14) / 평면 추정(±2 m) / 깊이 모름',
    evidence=f"붉은 선 길이 {f14['bukakWallStrip']['lengthM']} m. B06 의 GS25 문 (201008.5, 557395.0)은 이 선의 서쪽 끝에서 {D14['compare']['markers']['B06 GS25 문(북악관 입구(4)를 서쪽 끝 벽 앞으로 옮긴 자리)']['toBukakWallStripM']} m 떨어진 서쪽 끝 벽에 있고 그림 범위 밖이다. 이 지하 공간이 B1(GS25) 층인지는 그림에 없다(모름). 실내 길을 만들지 않는다")
count = collections.Counter((p['op'], p['grade']) for p in P)
json.dump({'method': __doc__, 'snapshot': 'roads-live-2.json (128 roads)', 'applied': False, 'perBuilding': T, 'bukakLadderVsRoof': bukak,
           'proposals': P, 'proposalCounts': {f'{a} / {b}': c for (a, b), c in sorted(count.items())}}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for b, t in T.items():
    print(f"\n{b} (서버 id {t['serverBuildingId']}, 실내 길 {t['indoorRoads']}개) 단 사이 {t['stepsBetweenStoredLevelsM']}")
    for r in t['storedLevels']: print('  ', r['storedM'], f"길 {r['roads']}", '이름', r['namedFloor'], 'levelId', r['levelId'], '가까운 층', r['nearestLadderFloor'])
print('\n북악관', bukak)
for p in P: print(p['building'], p['op'], len(p['roadIds']), '개', p.get('fromLabel', ''), '->', p.get('toLabel', p.get('deltaM')), '|', p['grade'], '|', p.get('chain', ''))
print(dict(count))
