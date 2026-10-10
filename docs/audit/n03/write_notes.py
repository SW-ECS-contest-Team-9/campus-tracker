"""N03: 볼트 노트의 표 자리(MATRIX, N03TABLE, OPLIST, {수})를 결과 파일에서 채운다. 글은 노트에 직접 쓴다.
  python -I write_notes.py   -> <볼트>/모델링 개선/길 규칙서.md, <볼트>/모델링 개선/N03 운영 도로망 변경 목록.md"""
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import *
V = VAULT / '모델링 개선'
R = json.loads((HERE / 'results.json').read_text(encoding='utf-8')); O = json.loads((HERE / 'oplist.json').read_text(encoding='utf-8'))

# 길 규칙서: 도달 표(서문 두 열은 출발 노드가 없어 뺀다)
rows = [l for l in (N03 / '41-matrix-after.md').read_text(encoding='utf-8').splitlines() if l.startswith('|')]
def cut(l):
    c = l.strip('|').split('|'); return '| ' + ' | '.join(x.strip() for x in (c[0], c[1], c[2], c[3], c[5], c[6])) + ' |'
p = V / '길 규칙서.md'; t = p.read_text(encoding='utf-8')
if 'MATRIX' in t: p.write_text(t.replace('MATRIX', '\n'.join(cut(l) for l in rows)), encoding='utf-8', newline='\n')

# 변경 목록
op = (N03 / '50-oplist.md').read_text(encoding='utf-8')
old = '| c52095ad | (이름 없음) | 공용·경사로 | 54.5 | 129.8~141.7 |'
op = op.replace(old, '| c52095ad | (이름 없음) = 문예관 옆 오르막. 거두는 것이 아니라 보행로로 바꾸고 선을 옮긴 것: 조각 939d3e3a(4.2 m)·aba83944(62.7 m) "문예관 옆 오르막 보행로"(길 추가 표) | 공용·경사로 | 54.5 | 129.8~141.7 |')
n03 = ['| 묶음 | 넣은 것 | 근거 등급 | 근거 |', '|---|---|---|---|']
for g in R['groups']:
    if g['id'] in ('X', 'P'): n03.append(f"| {g['id']} | {g['comment']} ({len(g['ops'])}건) | {g['ops'][0]['grade']} 등 | {g['ops'][0]['evidence']} |"); continue
    for o in g['ops']: n03.append(f"| {g['id']} | {o['ref']} | {o['grade']} | {o['evidence'].replace('|', '/')} |")
c = O['counts']
fill = {'opRoads': c['operationalRoads'], 'opNodes': O['nodes']['operational'], 'tRoads': c['testRoads'], 'tNodes': O['nodes']['test'], 'tPlaces': c['testPlaces'], 'areas': len(O['areas']),
        'added': c['added'], 'changed': c['changed'], 'split': c['split'], 'retired': c['retired'], 'placesAdded': len(O['places']['added']),
        'nAdded': O['nodes']['added'], 'nGone': O['nodes']['gone'], 'nMoved': len(O['nodes']['moved']), 'warn': R['after']['validation']['bySeverity']['warning'], 'info': R['after']['validation']['bySeverity']['info'],
        'before': R['before']['reachedFromGate'], 'after': R['after']['reachedFromGate'], 'changeSets': R['changeSets'], 'N03TABLE': '\n'.join(n03), 'OPLIST': op}
p = V / 'N03 운영 도로망 변경 목록.md'; body = p.read_text(encoding='utf-8')
for k, v in fill.items(): body = body.replace('{' + k + '}', str(v))
p.write_text(body, encoding='utf-8', newline='\n'); print('ok')
