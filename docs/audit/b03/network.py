"""B03 2단계 — 운영 실내 길(스냅숏)의 층 표기·높이를 1단계 층 바닥 높이와 견준다. 분석만 한다(DB·MCP 쓰기 없음).

  python docs/audit/b03/network.py <audit-dir> <anchors.json> <out.json>

입력: <audit-dir>/claude-live/roads-live-2.json (운영 도로 스냅숏 2026-10-09), anchors.py 의 결과.
- 동별로 실내 길(복도·계단·승강기)의 평평한 높이를 모아 "저장된 층"으로 묶고, 사다리에서 가장 가까운 층과 차이를 적는다.
- 길 이름에 적힌 층(B1, 1F, 2F, 1층 ...)과 levelId 를 함께 적는다.
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
add(building='유담관', op='relabel_level', roadIds=ids('유담관', 145.22, 145.22) + ids('유담관', 152.84, 152.84), fromLabel="이름 '상부', levelId 없음", toLabel='14층·16층(13층 번호가 없을 때) 또는 13층·15층', grade='추정',
    evidence=f"승강기 정지 높이가 입구 층(9층)보다 15.62 m, 23.24 m 높다 = 층당 3.9 m 로 4개·6개 층. 계산한 14층 {yl['14'][0]} m, 16층 {yl['16'][0]} m 와 0.7 m 안에서 맞는다. 13층 번호가 있는지에 따라 이름이 달라진다. 사용자가 본 16층 호실(1613~1624)과 어긋나지 않는다")
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
count = collections.Counter((p['op'], p['grade']) for p in P)
json.dump({'method': __doc__, 'snapshot': 'roads-live-2.json (128 roads)', 'applied': False, 'perBuilding': T, 'bukakLadderVsRoof': bukak,
           'proposals': P, 'proposalCounts': {f'{a} / {b}': c for (a, b), c in sorted(count.items())}}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for b, t in T.items():
    print(f"\n{b} (서버 id {t['serverBuildingId']}, 실내 길 {t['indoorRoads']}개) 단 사이 {t['stepsBetweenStoredLevelsM']}")
    for r in t['storedLevels']: print('  ', r['storedM'], f"길 {r['roads']}", '이름', r['namedFloor'], 'levelId', r['levelId'], '가까운 층', r['nearestLadderFloor'])
print('\n북악관', bukak)
for p in P: print(p['building'], p['op'], len(p['roadIds']), '개', p.get('fromLabel', ''), '->', p.get('toLabel', p.get('deltaM')), '|', p['grade'])
print(dict(count))
