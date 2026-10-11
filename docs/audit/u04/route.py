"""U04: 지하도를 지나는 길의 길이를 서버 도달 검사(check_reachability)로 잰다: 지정한 노드를 차례로 지나는 구간마다 최단 보행 경로를 묻고 더한다.   python route.py [OUT.json]
(C:/campus-tracker-testdb/backend 에서. 시험용 백엔드가 떠 있어야 한다.) U03 의 route.py 는 길만 따라가서, 주차장 안이 통로 면으로 바뀐 뒤에는 쓸 수 없다. 길이는 서버가 세는 값 그대로다(U03 표의 평면 길이와 세는 법이 다를 수 있다)."""
import json, pathlib, subprocess, sys, tempfile
sys.stdout.reconfigure(encoding='utf-8')
N = {'혜인관 지하 1층 문': '07c38541', '혜인관 계단 발치': '79988154', '은주관 간판 옆 문': '8e608a71', '은주1관 3층 계단실': '5893ed26', '한림관 본관 쪽 문': '5bcc9f6d', '본관 5층 동쪽 문': '0ba82e17',
     '본관 2층 유리문 앞': '2b5185cc', '유담관 9층 홀': '43a7f874', '정류장(유담관 9층 정류장 쪽 문)': '6404f1ee', '운동장(은주관 문 옆 계단 위)': '92516307', '운동장 계단 발치': '4eebbb98'}
TMP = pathlib.Path(tempfile.gettempdir()) / 'u04-route-args.json'
def call(tool, args):
    TMP.write_text(json.dumps(args), encoding='utf-8')
    r = subprocess.run(['npx', 'tsx', '../docs/audit/n02/n02.ts', 'call', tool, '@' + str(TMP).replace('\\', '/')], capture_output=True, shell=sys.platform == 'win32')
    return json.loads(r.stdout.decode('utf-8'))
nodes = []; off = 0
while True:
    page = call('list_features', {'type': 'node', 'limit': 200, 'offset': off}); nodes += page['items']; off += 200
    if off >= page['total']: break
full = {k: next(n['id'] for n in nodes if n['id'].startswith(v)) for k, v in N.items()}
ROUTES = {'혜인관 지하 1층 문 → 정류장 (지하도)': ['혜인관 지하 1층 문', '혜인관 계단 발치', '은주관 간판 옆 문', '은주1관 3층 계단실', '한림관 본관 쪽 문', '본관 5층 동쪽 문', '본관 2층 유리문 앞', '유담관 9층 홀', '정류장(유담관 9층 정류장 쪽 문)'],
          '정류장 → 운동장 (지하도)': ['정류장(유담관 9층 정류장 쪽 문)', '유담관 9층 홀', '본관 2층 유리문 앞', '본관 5층 동쪽 문', '한림관 본관 쪽 문', '은주1관 3층 계단실', '은주관 간판 옆 문', '운동장 계단 발치', '운동장(은주관 문 옆 계단 위)'],
          '유담관 9층 홀 → 은주1관 3층': ['유담관 9층 홀', '본관 2층 유리문 앞', '본관 5층 동쪽 문', '한림관 본관 쪽 문', '은주1관 3층 계단실']}
res = {}
for name, way in ROUTES.items():
    legs = []
    for a, b in zip(way, way[1:]):
        r = call('check_reachability', {'from': {'nodeId': full[a]}, 'to': {'nodeId': full[b]}, 'mode': 'pedestrian'})
        legs.append({'from': a, 'to': b, 'reachable': r.get('reachable'), 'lengthM': r.get('lengthM'), 'viaArea': sorted({str(x['roadId']).split(':')[1] for x in r.get('roads', []) if str(x['roadId']).startswith('area:')})})
    res[name] = {'serverLengthM': round(sum(l['lengthM'] or 0 for l in legs), 1), 'allReachable': all(l['reachable'] for l in legs),
                 'areaLegs': [f"{l['from']} → {l['to']} {l['lengthM']} m (영역 {','.join(l['viaArea'])})" for l in legs if l['viaArea']], 'legs': legs}
    print(name, res[name]['serverLengthM'], 'm', '이어짐' if res[name]['allReachable'] else '끊김', res[name]['areaLegs'])
if len(sys.argv) > 1: open(sys.argv[1], 'w', encoding='utf-8', newline='\n').write(json.dumps(res, ensure_ascii=False, indent=1) + '\n')
