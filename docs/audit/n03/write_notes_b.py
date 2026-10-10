"""N03b: 볼트 노트 갱신(길 규칙서의 도달 표·출입구 줄, 변경 목록의 수·전체 목록·N03b 표). 한 번 돌리는 스크립트.
  python -I write_notes_b.py"""
import json, pathlib, re, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import *
V = VAULT / '모델링 개선'
R = json.loads((HERE / 'results.json').read_text(encoding='utf-8')); O = json.loads((HERE / 'oplist.json').read_text(encoding='utf-8'))
A = R['afterN03b']

# ---------------- 길 규칙서
p = V / '길 규칙서.md'; L = p.read_text(encoding='utf-8').split('\n')
rows = [l for l in (N03 / '81-matrix-final.md').read_text(encoding='utf-8').splitlines() if l.startswith('|')]
def cut(l):
    c = l.strip('|').split('|'); return '| ' + ' | '.join(x.strip() for x in (c[0], c[1], c[2], c[3], c[5], c[6])) + ' |'
i = next(k for k, l in enumerate(L) if l.startswith('| 건물 출입구 |')); j = i
while L[j].startswith('|'): j += 1
L[i:j] = [cut(l) for l in rows]
def swap(prefix, new):
    k = next(k for k, l in enumerate(L) if l.startswith(prefix)); L[k] = new
swap('- 전 → 후(정문에서 닿는 출입구)', f"- 정문에서 닿는 출입구: N03 전 9 / 27 → N03 뒤 21 → N03b 뒤 {A['reachedFromGate']} / 27. 그 가운데 보행 \"허용\"인 길만으로 닿는 것 {A['reachedFromGateAllowedOnly']}(N03 뒤에는 0). 걸을 수 있는 묶음(노드 수) 146 / 9 / 1 → 194 / 1(남은 1은 지하 차도 아래 끝). 서버 도달 검사로 66쌍을 다시 돌려 같은 답을 확인했다.")
swap('- 모든 길이에 `*`', '- `*` 가 남은 곳: 은주2관 입구(1)(은주관 서쪽 윗길의 한림관 위쪽 구간이 차도이고 사람이 걷는지 모름), 제1주차장 입구에서 출발하는 모든 길(주차장 차로 25 m 가 차도). 정문과 제2주차장에서는 인도·자유 보행 구간으로 "허용"만으로 닿는다(N03b).')
swap('| 19 | 청운관 입구', '| 19 | 청운관 입구 | 1층 153.1 (계단 위 현관, 추정) | 이어짐 | 운동장 → 열린 기둥부 좌우 계단(26단 추정) → 현관 → 문. 운동장 높이(148.9)의 문은 지하 1층이고 따로 접속점이 있다(문 자리 모름) | 확정(계단 위 현관), 높이·자리 추정 |')
swap('| 30 | 본관–한림관 연결통로', '| 30 | 본관–한림관 연결통로 | 본관 5층 = 한림관 3층, 데크 130.5 | 이어짐 | 지하 차도 보행 구간 → 본관 북동 모서리 → 본관·한림관 사이 → 데크(높이 차 없음: 확정 2026-10-11). 두 건물에 실내 길 없음 | 확정(자리·바로 이어짐), 선 추정, 높이 S-MAP |')
swap('| 1 | 정문 |', '| 1 | 정문 | 107.1 | 이어짐 | 공도 분기 → 차도 양쪽 인도(제2주차장 분기까지) | 확정(양쪽 인도), 선 추정 |')
swap('| 6 | 유담관 입구(1)', '| 6 | 유담관 입구(1) | 6층 로비 114.1 | 이어짐 | 서쪽 인도 → 출입 자리(붉은 말뚝) → 분수 광장(면) → 문. 안에서 9층으로는 임시 승강기 자리표 하나(실제 6대·계단은 동선 기록 뒤) | 확정(층, 6층↔9층 승강기), 자리 추정 |')
swap('| 유담관 6층 ↔ 9층 실내', '| 유담관 6층 ↔ 9층 실내 | 승강기 6대와 계단, 6층 ↔ 9층은 대부분의 승강기로 오감(확정 2026-10-11). 임시 승강기 하나와 9층 홀까지의 임시 선을 넣음 | 승강기·계단 낱낱의 자리와 서는 층 | 유담관 노트. 사용자 동선 기록 뒤 교체 |')
swap('| 지하 보행 구간 ↔ 본관–한림관 데크', '| 본관 5층·한림관 3층 높이 | 데크는 지하 보행 구간에서 바로 이어진다(확정). 그 자리 높이 130.5 m(S-MAP 130.4~131.0) | 동 노트의 계산값(본관 5층 138.1, 한림관 3층 137.8)과 7 m 넘게 다르다. 층 표를 어떻게 고칠지 | 본관·한림관 노트의 N03b 절(맞지 않는 것으로 적음, 묻지 않음) |')
swap('| 차도의 보행 출입', '| 차도의 보행 출입 | 정문 ~ 제2주차장: 양쪽 인도로 걷는다. 그 위: 자유 보행(확정 2026-10-11) | 인도의 정확한 선·폭, 횡단 자리. 윗길(은주관 서쪽)·제1주차장 차로를 사람이 걷는지 | 구조물 파일 n03b-sidewalks(추정) |')
k = next(k for k, l in enumerate(L) if l.startswith('건물 입구 24곳 가운데')); L[k] = L[k].replace('데크는 따로', '데크는 따로')
p.write_text('\n'.join(L), encoding='utf-8', newline='\n')

# ---------------- 변경 목록
p = V / 'N03 운영 도로망 변경 목록.md'; t = p.read_text(encoding='utf-8')
op = (N03 / '83-oplist.md').read_text(encoding='utf-8')
old = '| c52095ad | (이름 없음) | 공용·경사로 | 54.5 | 129.8~141.7 |'
op = op.replace(old, '| c52095ad | (이름 없음) = 문예관 옆 오르막. 거두는 것이 아니라 보행로로 바꾸고 선을 옮긴 것: 조각 둘 "문예관 옆 오르막 보행로"(길 추가 표) | 공용·경사로 | 54.5 | 129.8~141.7 |')
a = t.index('기계가 읽는 원본'); a = t.index('\n', a) + 1; b = t.index('## 사용자에게 묻는 것')
t = t[:a] + '\n' + op + '\n' + t[b:]
c = O['counts']
def row(label, val):
    global t
    m = re.search(r'^\| ' + re.escape(label) + r'[^|]*\| .*$', t, re.M); assert m, label
    t = t[:m.start()] + f'| {m.group(0).split("|")[1].strip()} | {val} |' + t[m.end():]
row('길 추가', c['added']); row('길 바뀜', c['changed']); row('길 나뉨', c['split']); row('노드', f"새로 {O['nodes']['added']}, 없어짐 {O['nodes']['gone']}, 옮김 {len(O['nodes']['moved'])}")
t = re.sub(r'시험용 DB 2026-10-11\(길 \d+개·노드 \d+개', f"시험용 DB 2026-10-11(길 {c['testRoads']}개·노드 {O['nodes']['test']}개", t)
t = re.sub(r'- 시험용 DB 길 검사: 오류 0\(경고 \d+, 알림 \d+\)', f"- 시험용 DB 길 검사: 오류 0(경고 {A['validation']['bySeverity']['warning']}, 알림 {A['validation']['bySeverity']['info']})", t)
t = re.sub(r'- 정문에서 닿는 건물 출입구: .*', f"- 정문에서 닿는 건물 출입구: N03 전 9 / 27 → N03 뒤 21 → N03b 뒤 {A['reachedFromGate']} / 27(보행 \"허용\"만으로 {A['reachedFromGateAllowedOnly']}). 표는 길 규칙서.", t)
nb = ['## N03b 에서 넣은 것 (사용자 확정 2026-10-11 세 가지, 시험용 DB, 변경 묶음 ' + str(R['changeSetsN03b']) + '개)', '| 묶음 | 넣은 것 | 근거 등급 | 근거 |', '|---|---|---|---|']
for g in R['groups']:
    if not g['id'].startswith('b'): continue
    if g['id'] == 'bG': nb.append(f"| {g['id']} | {g['comment']} ({len(g['ops'])}건) | {g['ops'][0]['grade']} | {g['ops'][0]['evidence']} |"); continue
    for o in g['ops']: nb.append(f"| {g['id']} | {o['ref']} | {o['grade']} | {o['evidence'].replace('|', '/')} |")
nb += ['', '- 구조물: `frontend/public/structures/n03b-sidewalks.geojson`(인도 띠 상자 77개, 자리·폭 추정, 지형에는 싣지 않음), `g02-way.geojson` 의 데크 윗면 137.9 → 130.5 m.',
       '- 인도가 차도의 갈림 길·분수 광장 출입 길·본관 입구(1) 앞 길과 만나는 자리에서 편집기가 길을 조각으로 나눴다(0.3~1.4 m 짜리 조각 포함). 검사 경고 "끝이 옆에서 끊김" 9, "겹쳐 달림" 5 는 이 조각들과 전부터 있던 것이다.',
       '- 제2주차장 위쪽은 기운 포장면이라 공간 영역(한 높이)으로 만들 수 없어, 폭을 준 길(본관 서쪽 회차 공간 내리막, P1 차로)을 공용·보행 허용으로 했다. 평평한 회차 공간은 이미 영역이다.',
       '- 되돌리기 저장본: `데이터/보완자료/3d-map-audit-20261009/n03/00-backup-mobility-before-n03b.sql`.', '']
a = t.index('## 넣지 않은 것 (이유)'); t = t[:a] + '\n'.join(nb) + '\n' + t[a:]
for oldrow in ('| 지하 보행 구간 → 데크 연결선 |', '| 유담관 6층 ↔ 9층 실내 길 |', '| 차도의 보행 출입 |'):
    m = re.search(r'^' + re.escape(oldrow) + r'.*\n', t, re.M); assert m, oldrow; t = t[:m.start()] + t[m.end():]
a = t.index('## 사용자에게 묻는 것')
t = t[:a] + '''## 사용자에게 묻는 것 (볼트에 답이 없는 것만)
앞의 1(유담관 6층↔9층)·2(데크)·4(차도 보행)는 2026-10-11 에 답을 받아 반영했다. 남은 것:
1. 북악관 입구(2)(동쪽, 1층 복도) 문 앞에 계단이 있는가, 그 문으로는 어느 길에서 가는가.
2. 본관 입구(1)(남쪽)은 남서 모서리에서 본관 남쪽 평탄부로 걸어가는 것이 맞는가(S-MAP 으로 평평해서 그렇게 이었다).
3. 은주관 서쪽 윗길(한림관 1층 계단 위쪽 ~ 은주2관 1층 로비 앞)을 사람이 걷는가. 걷는다면 은주2관 입구(1)도 "허용"만으로 닿는다.
'''
p.write_text(t, encoding='utf-8', newline='\n'); print('ok')
