"""U04: 도달 쌍 파일을 만든다(u03/pairs.json 에서 차량 쌍의 도착만 바꿈). DB 접근 없음.   python pairs.py
지하 1층: 종착 표지 노드(거둔 차로의 끝) → 혜인관 통로 어귀(통로 면을 건너야 닿는다). 지하 2층: U자 경사로 발치(지하 2층 통로 면의 하나뿐인 접속점). 쌍 id 는 그대로라 전후를 견줄 수 있다."""
import json, pathlib
HERE = pathlib.Path(__file__).parent
d = json.loads((HERE.parent / 'u03' / 'pairs.json').read_text(encoding='utf-8')); S = json.loads((HERE / 'stalls.json').read_text(encoding='utf-8'))
for q in d['pairs']:
    if not q.get('vehicle'): continue
    if '지하 1층' in q['id']: q['to'] = {'point': S['points']['hyeinOut']}; q['label'] += ' (통로 면을 건너 혜인관 통로 어귀까지)'; q['snapRadiusM'] = 1
    else: q['to'] = {'nodeId': S['points']['rampBottomNode']}; q['label'] += ' (U자 경사로 발치 = 지하 2층 통로 면의 접속점)'
d['note'] = 'U04: u03/pairs.json(걷는 66 + 차량 4 + 지하도 3)에서 차량 쌍의 도착만 바꿈. 쌍 id 는 그대로'
(HERE / 'pairs.json').write_text(json.dumps(d, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(d['pairs']), [q['id'] for q in d['pairs'] if q.get('vehicle')])
