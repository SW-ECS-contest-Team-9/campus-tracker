"""U03: 상태 파일(n02.ts state)에서 지하도를 지나는 길의 길이·오르내림을 잰다(지정한 노드를 차례로 지나는 최단 보행 경로).   python route.py STATE.json [OUT.json]
check_reachability 의 최단 경로는 지상(운동장 면)을 지날 수 있어, 지하도 경로는 거치는 노드를 정해 따로 잰다. 차량 전용 길은 뺀다."""
import json, sys, heapq, math
s = json.load(open(sys.argv[1], encoding='utf-8'))
G = {}
for r in s['roads']:
    if r['pedestrianAccess'] == 'prohibited': continue
    c = r['coordinates']; L = sum(math.dist(a, b) if r['structure'] == 'elevator' else math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(c, c[1:]))
    up = sum(max(0, b[2] - a[2]) for a, b in zip(c, c[1:])); dn = sum(max(0, a[2] - b[2]) for a, b in zip(c, c[1:]))
    plan = 0 if r['structure'] == 'elevator' else L
    G.setdefault(r['fromNodeId'], []).append((r['toNodeId'], plan, up, dn, r)); G.setdefault(r['toNodeId'], []).append((r['fromNodeId'], plan, dn, up, r))
def leg(a, b):
    D = {a: 0}; P = {}; q = [(0, a)]
    while q:
        dd, u = heapq.heappop(q)
        if u == b: break
        if dd > D[u]: continue
        for v, L, up, dn, r in G.get(u, []):
            if dd + L + 1e-9 < D.get(v, 1e18): D[v] = dd + L; P[v] = (u, L, up, dn, r); heapq.heappush(q, (D[v], v))
    out = []; u = b
    while u != a: p = P[u]; out.append(p); u = p[0]
    return out[::-1]
N = {'혜인관 지하 1층 문': '07c38541', '혜인관 계단 발치': '79988154', '은주관 간판 옆 문': '8e608a71', '은주1관 3층 계단실': '5893ed26', '한림관 본관 쪽 문': '5bcc9f6d', '본관 5층 동쪽 문': '0ba82e17', '본관 2층 유리문 앞': '2b5185cc',
     '유담관 9층 홀': '43a7f874', '정류장(유담관 9층 정류장 쪽 문)': '6404f1ee', '운동장(은주관 문 옆 계단 위)': '92516307', '운동장 계단 발치': '4eebbb98'}
full = {k: next(n['id'] for n in s['nodes'] if n['id'].startswith(v)) for k, v in N.items()}
ROUTES = {'혜인관 지하 1층 문 → 정류장 (지하도)': ['혜인관 지하 1층 문', '혜인관 계단 발치', '은주관 간판 옆 문', '은주1관 3층 계단실', '한림관 본관 쪽 문', '본관 5층 동쪽 문', '본관 2층 유리문 앞', '유담관 9층 홀', '정류장(유담관 9층 정류장 쪽 문)'],
          '정류장 → 운동장 (지하도)': ['정류장(유담관 9층 정류장 쪽 문)', '유담관 9층 홀', '본관 2층 유리문 앞', '본관 5층 동쪽 문', '한림관 본관 쪽 문', '은주1관 3층 계단실', '은주관 간판 옆 문', '운동장 계단 발치', '운동장(은주관 문 옆 계단 위)'],
          '유담관 9층 홀 → 은주1관 3층': ['유담관 9층 홀', '본관 2층 유리문 앞', '본관 5층 동쪽 문', '한림관 본관 쪽 문', '은주1관 3층 계단실']}
res = {}
for name, way in ROUTES.items():
    steps = [x for a, b in zip(way, way[1:]) for x in leg(full[a], full[b])]
    res[name] = {'planLengthM': round(sum(x[1] for x in steps), 1), 'climbM': round(sum(x[2] for x in steps), 1), 'descentM': round(sum(x[3] for x in steps), 1), 'roads': len(steps),
                 'elevatorRideM': round(sum(x[2] + x[3] for x in steps if x[4]['structure'] == 'elevator'), 1), 'stairsM': round(sum(x[2] + x[3] for x in steps if x[4]['structure'] == 'stairs'), 1),
                 'via': [(x[4]['name'] or x[4]['id'])[:28] for x in steps]}
    print(name, {k: v for k, v in res[name].items() if k != 'via'})
if len(sys.argv) > 2: open(sys.argv[2], 'w', encoding='utf-8', newline='\n').write(json.dumps(res, ensure_ascii=False, indent=1) + '\n')
