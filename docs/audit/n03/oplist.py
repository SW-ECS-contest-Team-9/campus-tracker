"""N03 운영 반영 목록: 운영 스냅숏(2026-10-09, 볼트 claude-live/roads-live-2.json·nodes-live-2.json·places.json) 대 시험용 DB 지금 상태. DB 접근 없음.
  python -I oplist.py STATE.json AREAS.json OUT.json OUT.md
길: 추가 / 바뀜(같은 id) / 나뉨(운영 길 하나가 시험용 DB 에서 조각 여럿) / 거둠. 노드·장소·영역도 같은 식으로 센다.
운영에는 아무것도 하지 않는다. 승인받을 목록을 만드는 것뿐이다."""
import sys, json, math, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import *

state, areas_f, out_json, out_md = sys.argv[1:5]
T = json.loads(pathlib.Path(state).read_text(encoding='utf-8'))
LIVE = AUDIT / 'claude-live'
def items(f):
    d = json.loads((LIVE / f).read_text(encoding='utf-8')); return d['items'] if isinstance(d, dict) else d
OR = {r['id']: r for r in items('roads-live-2.json')}; ON = {n['id']: n for n in items('nodes-live-2.json')}; OP = {p['id']: p for p in items('places.json')}
TR = {r['id']: r for r in T['roads']}; TN = {n['id']: n for n in T['nodes']}; TP = {p['id']: p for p in T['places']}
AREAS = json.loads(pathlib.Path(areas_f).read_text(encoding='utf-8')); AREAS = AREAS if isinstance(AREAS, list) else AREAS.get('areas') or AREAS.get('items')
ATTRS = ['name', 'roadClass', 'structure', 'pedestrianAccess', 'vehicleAccess', 'pedestrianDirection', 'vehicleDirection', 'widthM', 'wheelchairAccess', 'buildingId', 'levelId']
KO = {'pedestrian': '보행', 'vehicle': '차량', 'shared': '공용', 'ordinary': '일반', 'stairs': '계단', 'ramp': '경사로', 'elevator': '승강기', 'indoor_corridor': '실내 복도', 'sidewalk': '보도', 'crossing': '횡단',
      'allowed': '허용', 'prohibited': '금지', 'unknown': '모름', 'restricted': '제한'}
ko = lambda v: KO.get(v, v)
def length(c): return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(c, c[1:]))
def seg_d(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]; L = dx * dx + dy * dy; t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) if L else 0
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
def off(p, line): return min(seg_d(p, a, b) for a, b in zip(line, line[1:])) if len(line) > 1 else math.hypot(p[0] - line[0][0], p[1] - line[0][1])
def zr(c): z = [p[2] for p in c]; return f'{min(z):.1f}~{max(z):.1f}' if max(z) - min(z) > 0.05 else f'{z[0]:.1f}'
def kind(r): return f"{ko(r['roadClass'])}·{ko(r['structure'])}"
def nm(r): return (r.get('name') or '(이름 없음)').replace('|', '/')
def geom_delta(a, b):
    """같은 id 의 운영 선 a 와 시험 선 b: 평면으로 가장 멀어진 거리, 높이 변화 범위(시험 꼭짓점에서 운영 선의 가장 가까운 점 높이와의 차)."""
    plan = max(max(off(p, a) for p in b), max(off(p, b) for p in a)); dz = []
    for p in b:
        best = None
        for u, v in zip(a, a[1:]):
            dx, dy = v[0] - u[0], v[1] - u[1]; L = dx * dx + dy * dy; t = max(0, min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / L)) if L else 0
            d = math.hypot(p[0] - u[0] - t * dx, p[1] - u[1] - t * dy)
            if best is None or d < best[0]: best = (d, u[2] + t * (v[2] - u[2]))
        dz.append(p[2] - best[1])
    return round(plan, 2), round(min(dz), 2), round(max(dz), 2)

res = {'added': [], 'changed': [], 'split': [], 'retired': [], 'nodes': {}, 'places': {'added': [], 'changed': [], 'retired': []}, 'areas': []}
new_ids = [i for i in TR if i not in OR]; claimed = set()
for i, o in OR.items():
    if i in TR: continue
    oc = o['coordinates']
    if length(oc) < 0.05:    # 승강기처럼 평면 길이가 없는 길: 같은 자리의 새 길
        pieces = [j for j in new_ids if j not in claimed and length(TR[j]['coordinates']) < 0.05 and math.hypot(TR[j]['coordinates'][0][0] - oc[0][0], TR[j]['coordinates'][0][1] - oc[0][1]) < 0.3
                  and TR[j]['structure'] == o['structure']]
    else:
        pieces = [j for j in new_ids if j not in claimed and length(TR[j]['coordinates']) > 0.05 and max(off(p, oc) for p in TR[j]['coordinates']) < 0.6 and TR[j]['roadClass'] in (o['roadClass'], 'pedestrian', 'vehicle', 'shared')
                  and TR[j]['structure'] == o['structure'] or (j in new_ids and j not in claimed and (TR[j].get('name') == o.get('name') and o.get('name')) and max(off(p, oc) for p in TR[j]['coordinates']) < 6)]
    tot = sum(length(TR[j]['coordinates']) for j in pieces)
    if pieces and (length(oc) < 0.05 or 0.1 * length(oc) <= tot <= 1.5 * length(oc) + 1):
        claimed.update(pieces)
        res['split'].append({'id': i, 'name': nm(o), 'kind': kind(o), 'lengthM': round(length(oc), 1), 'pieces': [{'id': j, 'name': nm(TR[j]), 'kind': kind(TR[j]), 'lengthM': round(length(TR[j]['coordinates']), 1), 'z': zr(TR[j]['coordinates']),
                             'ped': ko(TR[j]['pedestrianAccess']), 'veh': ko(TR[j]['vehicleAccess'])} for j in pieces], 'zBefore': zr(oc), 'droppedM': round(max(0.0, length(oc) - tot), 1)})
    else:
        res['retired'].append({'id': i, 'name': nm(o), 'kind': kind(o), 'lengthM': round(length(oc), 1), 'z': zr(oc)})
for i in new_ids:
    if i in claimed: continue
    r = TR[i]; c = r['coordinates']
    res['added'].append({'id': i, 'name': nm(r), 'kind': kind(r), 'lengthM': round(length(c), 1), 'z': zr(c), 'ped': ko(r['pedestrianAccess']), 'veh': ko(r['vehicleAccess']), 'widthM': r.get('widthM'), 'buildingId': r.get('buildingId'),
                         'from': [round(v, 1) for v in c[0]], 'to': [round(v, 1) for v in c[-1]]})
for i, o in OR.items():
    if i not in TR: continue
    r = TR[i]; diff = {k: [o.get(k), r.get(k)] for k in ATTRS if (o.get(k) or None) != (r.get(k) or None)}
    plan, dz0, dz1 = geom_delta(o['coordinates'], r['coordinates'])
    if diff or plan > 0.05 or max(abs(dz0), abs(dz1)) > 0.05 or abs(length(o['coordinates']) - length(r['coordinates'])) > 0.1:
        res['changed'].append({'id': i, 'name': nm(r), 'nameBefore': nm(o), 'kind': kind(r), 'attrs': diff, 'planShiftM': plan, 'dz': [dz0, dz1], 'lengthM': [round(length(o['coordinates']), 1), round(length(r['coordinates']), 1)],
                               'z': [zr(o['coordinates']), zr(r['coordinates'])]})
moved = []
for i, o in ON.items():
    if i in TN:
        a, b = o['coordinate'], TN[i]['coordinate']; d = math.hypot(a[0] - b[0], a[1] - b[1]); dz = b[2] - a[2]
        if d > 0.05 or abs(dz) > 0.05: moved.append({'id': i, 'planM': round(d, 2), 'dz': round(dz, 2), 'xy': [round(b[0], 1), round(b[1], 1)], 'z': [round(a[2], 2), round(b[2], 2)]})
used = {n for r in T['roads'] for n in (r['fromNodeId'], r['toNodeId'])}
res['nodes'] = {'operational': len(ON), 'test': len(TN), 'moved': moved, 'added': len([i for i in TN if i not in ON]), 'gone': len([i for i in ON if i not in TN]), 'unusedInTest': len([i for i in TN if i not in used])}
for i, p in TP.items():
    if i not in OP: res['places']['added'].append({'id': i, 'name': p['name'], 'category': p['category'], 'buildingId': p.get('buildingId'), 'coordinate': [round(v, 1) for v in p['coordinate']]})
    elif any(p.get(k) != OP[i].get(k) for k in ('name', 'category', 'buildingId', 'coordinate')): res['places']['changed'].append({'id': i, 'name': p['name']})
res['places']['retired'] = [{'id': i, 'name': p['name']} for i, p in OP.items() if i not in TP]
for a in AREAS: res['areas'].append({'id': a['id'], 'name': a['name'], 'kind': a['kind'], 'elevationM': a['elevationM'], 'areaM2': round(a['areaM2']), 'note': (a.get('note') or '')[:200]})
res['counts'] = {'operationalRoads': len(OR), 'testRoads': len(TR), 'added': len(res['added']), 'changed': len(res['changed']), 'split': len(res['split']), 'retired': len(res['retired']),
                 'operationalPlaces': len(OP), 'testPlaces': len(TP)}
pathlib.Path(out_json).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')

L = []
L += ['### 길 추가', '| id | 이름 | 종류 | 길이 (m) | 높이 (m) | 보행 / 차량 |', '|---|---|---|---|---|---|']
for r in sorted(res['added'], key=lambda r: r['name']): L.append(f"| {r['id'][:8]} | {r['name']} | {r['kind']} | {r['lengthM']} | {r['z']} | {r['ped']} / {r['veh']} |")
L += ['', '### 길 바뀜 (운영의 같은 id)', '| id | 이름(시험용) | 바뀐 속성 | 선이 옮겨진 거리 (m) | 높이 변화 (m) | 높이 전 → 후 |', '|---|---|---|---|---|---|']
for r in sorted(res['changed'], key=lambda r: r['name']):
    at = '; '.join(f"{k}: {ko(v[0]) if v[0] is not None else '없음'} → {ko(v[1]) if v[1] is not None else '없음'}" for k, v in r['attrs'].items() if k != 'name') + ('; 이름' if 'name' in r['attrs'] else '')
    L.append(f"| {r['id'][:8]} | {r['name']} | {at.strip('; ') or '–'} | {r['planShiftM']} | {r['dz'][0]:+.2f} ~ {r['dz'][1]:+.2f} | {r['z'][0]} → {r['z'][1]} |")
L += ['', '### 길 나뉨 (운영 길 하나 → 시험용 조각 여럿. 새 길과 만나는 자리에서 편집기가 나눈 것)', '| 운영 id | 운영 이름 | 길이 (m) | 조각 (id 길이 높이 보행/차량) |', '|---|---|---|---|']
for r in sorted(res['split'], key=lambda r: r['name']):
    L.append(f"| {r['id'][:8]} | {r['name']} | {r['lengthM']} | " + '; '.join(f"{p['id'][:8]} {p['lengthM']} m {p['z']} {p['ped']}/{p['veh']}" + (f" 「{p['name']}」" if p['name'] != r['name'] else '') for p in r['pieces']) + (f" (나머지 {r['droppedM']} m 는 거둠)" if r['droppedM'] > 1 else '') + ' |')
L += ['', '### 길 거둠 (운영에 있고 시험용에 없음)', '| id | 이름 | 종류 | 길이 (m) | 높이 (m) |', '|---|---|---|---|---|']
for r in sorted(res['retired'], key=lambda r: r['name']): L.append(f"| {r['id'][:8]} | {r['name']} | {r['kind']} | {r['lengthM']} | {r['z']} |")
L += ['', '### 장소 추가', '| id | 이름 | 종류 | 건물 id | 좌표 (x, y, z) |', '|---|---|---|---|---|']
for p in sorted(res['places']['added'], key=lambda p: p['name']): L.append(f"| {p['id'][:8]} | {p['name'].replace('|', '/')} | {p['category']} | {p['buildingId'] or '–'} | {p['coordinate'][0]}, {p['coordinate'][1]}, {p['coordinate'][2]} |")
L += ['', '### 공간 영역', '| 이름 | 종류 | 바닥 (m) | 넓이 (㎡) |', '|---|---|---|---|']
for a in res['areas']: L.append(f"| {a['name']} | {a['kind']} | {a['elevationM']} | {a['areaM2']} |")
n = res['nodes']; mv = n['moved']
L += ['', f"### 노드", f"운영 {n['operational']}개 → 시험용 {n['test']}개. 새 노드 {n['added']}, 없어진 노드 {n['gone']}, 자리나 높이가 바뀐 노드 {len(mv)}"
      + (f"(높이 변화 {min(m['dz'] for m in mv):+.2f} ~ {max(m['dz'] for m in mv):+.2f} m, 평면 이동 최대 {max(m['planM'] for m in mv):.2f} m)" if mv else '') + '. 노드별 값은 저장소 파일.']
pathlib.Path(out_md).write_text('\n'.join(L) + '\n', encoding='utf-8')
print(json.dumps(res['counts'], ensure_ascii=False), 'nodes moved', len(mv), 'places +', len(res['places']['added']), 'retired places', len(res['places']['retired']))
