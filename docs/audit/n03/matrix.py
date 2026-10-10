"""N03 도달 표: 학교 출입구(정문·서문·주차장 입구) -> 동 노트의 모든 건물 출입구. DB 접근 없음.
  python -I matrix.py STATE.json AREAS.json OUT.json [OUT.md [PAIRS.json]]
출입구가 '이어졌다'고 보는 조건: 문 자리(동 노트 좌표)에서 평면 6 m 안에, 문 바닥 높이와 0.3 m 안인 노드가 있고, 출발 노드에서 그 노드까지 걸어서 닿는다.
0.3~1.25 m 차이는 '높이 어긋남', 그보다 크면 '노드 없음'과 같다(다른 층). 바닥 높이가 모름인 문은 가장 가까운 노드로 보고 '높이 모름'으로 적는다.
영역(운동장·포장면·광장)은 바닥 높이 ±0.5 m 인 노드끼리 면을 건너는 것으로 센다(서버 도달 검사와 같은 규칙, 길이는 직선)."""
import sys, json
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *

state, areas, out = sys.argv[1:4]
N = Net(state, areas)
school = {p['name']: p for p in school_places()}

# 출발점: 사용자 확정 자리가 학교 표지와 다르면 사용자 자리를 쓴다(이유는 길 규칙서의 출입구 표).
SOURCES = [
    {'id': '정문', 'xy': [201134.83, 557097.35], 'z': 106.9, 'note': '공도 분기(E09). 학교 표지 (201129.2, 557112.8)'},
    {'id': '서문(후문)', 'xy': school['서문(후문)']['xy'], 'z': None, 'note': '학교 표지. 사용자 표시는 북악관 북서쪽 옹벽 자리(B08, ±6 m)'},
    {'id': '제1주차장 입구', 'xy': [201099.8, 557146.2], 'z': 106.05, 'note': 'E09 하단 주차장 입구(사용자: 정문 바로 옆). 학교 표지 (201096.7, 557150.7)'},
    {'id': '제2주차장 입구', 'xy': [201021.95, 557307.07], 'z': 127.94, 'note': '표지판 P1 입구 = 사용자 표시(회차 공간 남서쪽 끝, 유담관 바로 북쪽). 학교 표지 (201057.8, 557267.2)는 54 m 남동'},
    {'id': '서문 주차장 입구', 'xy': school['서문 주차장 출입구']['xy'], 'z': None, 'note': '학교 표지'},
]
TARGETS = [{'id': e['name'], 'building': e['building'], 'xy': e['xy'], 'z': e['z'], 'floor': e['floor']} for e in note_entrances()
           if '운영 노드' not in e['name'] and '학교 표지, 자리가' not in e['name'] and e['name'] != '정문 앞']
TARGETS += [
    {'id': '본관–한림관 연결통로(데크)', 'building': '본관·한림관', 'xy': [201098.0, 557302.7], 'z': 137.8, 'floor': '본관 5층 = 한림관 3층 (높이 추정 137.8~138.1)'},
    {'id': '한림관–은주관 연결통로', 'building': '한림관·은주관', 'xy': [201131.7, 557297.5], 'z': None, 'floor': '한림관 3층 = 은주1관 2층, 한림관 6층 = 은주1관 5층'},
]

# 문 표지 자리와 그 문으로 들어가 닿는 층의 노드가 다른 곳(이유를 적은 곳만).
OVERRIDE = {
    '북악관 입구(1) = 정문': {'xy': [201052.98, 557379.96], 'z': 134.1, 'why': '문은 정문 계단 17칸의 중간(바깥 12칸 위 133.3 m)에 있다. 계단을 다 오른 1층 로비 노드로 본다'},
    '북악관 입구(3)': {'xy': [201007.65, 557385.84], 'z': 133.64, 'needsRoad': '북악관 입구(3) 계단', 'why': '보행 기록에서 나온 1층 복도의 서쪽 끝(표지에서 6.9 m)에서 계단이 옆길로 내려간다. 1층 바닥 134.1 m 와 0.46 m 차는 기록의 치우침'},
    '문예관 입구(1)': {'xy': [201107.67, 557339.65], 'z': 142.44, 'why': '사용자가 확정한 길의 문 앞 노드. 3층 바닥 높이는 두 읽기(142.4~142.8 / 144.7~144.9)가 미정이라 노트 값이 모름'},
    '유담관 입구(2)': {'xy': [201040.0, 557275.0], 'z': 129.6, 'why': '9층 홀 노드(129.6 m). 노트의 9층 바닥 129.2 m 는 추정이고 범위가 128.4~129.6 m 다. 문 자리는 모름(표지가 문에서 어긋남)'},
}
def pick(t, radius=6.0):
    o = OVERRIDE.get(t.get('id'))
    if o and (not o.get('needsRoad') or any((r['name'] or '').startswith(o['needsRoad']) for r in N.roads)):
        c = N.nearest(o['xy'], o['z'], 1.0)
        if c and abs(c[0][1]) <= SAME_Z: return {'node': c[0][2][:8], 'nodeId': c[0][2], 'planeM': round(math.hypot(o['xy'][0] - t['xy'][0], o['xy'][1] - t['xy'][1]), 2), 'dz': 0.0, 'why': o['why']}
    c = N.nearest(t['xy'], t['z'], radius)
    if not c: return None
    d, dz, n = c[0]
    return {'node': n[:8], 'nodeId': n, 'planeM': d, 'dz': dz}

rows = []; srcs = []
for s in SOURCES:
    p = pick(s, 8.0)
    srcs.append({**s, 'pick': p, 'dist': {m: N.dijkstra(p['nodeId'], m)[0] for m in ('walk', 'walk_assume')} if p else None})
for t in TARGETS:
    p = pick(t)
    if p is None: status = '노드 없음'
    elif p['dz'] is None: status = '노드 있음(높이 모름)'
    elif abs(p['dz']) <= SAME_Z: status = '노드 있음'
    elif abs(p['dz']) <= NEAR_Z: status = f"높이 어긋남 {p['dz']:+.2f} m"
    else: status = f"다른 높이 {p['dz']:+.2f} m"
    usable = p is not None and (p['dz'] is None or abs(p['dz']) <= SAME_Z)
    row = {'target': t['id'], 'building': t['building'], 'floor': t['floor'], 'doorZ': t['z'], 'pick': p and {k: p[k] for k in ('node', 'nodeId', 'planeM', 'dz', 'why') if k in p}, 'status': status, 'from': {}}
    for s in srcs:
        if not s['pick']: row['from'][s['id']] = '출발 노드 없음'; continue
        if not usable: row['from'][s['id']] = None; continue
        a, w = s['dist']['walk_assume'].get(p['nodeId']), s['dist']['walk'].get(p['nodeId'])
        row['from'][s['id']] = None if a is None else {'m': round(a, 1), 'strict': w is not None}
    rows.append(row)

comp = N.components()
import collections
res = {'state': str(state), 'sources': [{k: v for k, v in s.items() if k != 'dist'} for s in srcs], 'overrides': OVERRIDE, 'rows': rows,
       'components': sorted(collections.Counter(comp.values()).values(), reverse=True), 'areaAccess': {str(k): [n[:8] for n in v] for k, v in N.access.items()}}
pathlib.Path(out).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')
ok = sum(1 for r in rows if isinstance(r['from'].get('정문'), dict))
lines = ['| 건물 출입구 | 문 바닥 (m) | 붙는 노드 (평면 m / 높이 차) | ' + ' | '.join(s['id'] for s in srcs) + ' |', '|---|---|---|' + '---|' * len(srcs)]
for r in rows:
    p = r['pick']; cells = []
    for s in srcs:
        v = r['from'][s['id']]
        cells.append(v if isinstance(v, str) else '끊김' if v is None else f"{v['m']:.0f} m" + ('' if v['strict'] else '*'))
    lines.append(f"| {r['target']} | {r['doorZ'] if r['doorZ'] is not None else '모름'} | " + (f"{p['node']} ({p['planeM']} / {p['dz'] if p['dz'] is not None else '–'}) {r['status']}" if p else '없음') + ' | ' + ' | '.join(cells) + ' |')
lines += ['', f"정문에서 닿는 출입구 {ok} / {len(rows)}. 걸을 수 있는 묶음(노드 수): {res['components']}. `*` = 보행 출입이 '모름'인 길을 지나야 닿음."]
for s in srcs: lines.append(f"- 출발 {s['id']}: " + (f"노드 {s['pick']['node']} (평면 {s['pick']['planeM']} m)" if s['pick'] else '8 m 안에 노드 없음') + f". {s['note']}")
md = '\n'.join(lines)
if len(sys.argv) > 4: pathlib.Path(sys.argv[4]).write_text(md + '\n', encoding='utf-8')
print(md)
if len(sys.argv) > 5:   # 서버 도달 검사(n02.ts state)로 다시 확인할 쌍: 노드 id 로 준다. 정문에서는 끊긴 것도 넣어 서버 답과 견준다
    def usable(r): return r['pick'] and (r['pick']['dz'] is None or abs(r['pick']['dz']) <= SAME_Z)
    pairs = [{'id': f"{s['id']}>{r['target']}", 'label': f"{s['id']} → {r['target']}", 'from': {'nodeId': s['pick']['nodeId']}, 'to': {'nodeId': r['pick']['nodeId']}, 'vehicle': False,
              'expect': r['from'][s['id']]} for s in srcs if s['pick'] for r in rows if usable(r) and (s['id'] == '정문' or isinstance(r['from'][s['id']], dict))]
    pathlib.Path(sys.argv[5]).write_text(json.dumps({'note': 'N03 도달 표를 서버 검사로 다시 확인하는 쌍', 'pairs': pairs}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
