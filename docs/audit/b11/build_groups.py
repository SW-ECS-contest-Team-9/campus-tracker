"""B11: 시험용 DB 변경 묶음을 지금 상태 파일에서 만든다(개정 번호를 거기서 읽는다). DB 접근 없음.

  python docs/audit/b11/build_groups.py STATE.json      -> groups/hyein-id.json, groups/deck.json

STATE.json = `npx tsx ../docs/audit/n02/n02.ts state OUT.json` 의 결과. 적용은 n02.ts apply GROUP.json OUT.json --commit (시험용 DB 만).
- hyein-id: 건물 표기 '건물5' 인 길·장소를 '혜인관'으로(건물 id 를 바로잡은 뒤에 적용: scripts/building-ids-rename.ts).
- deck: 본관–한림관 데크와 지하 보행 구간 끝을 층 사슬 값 137.8 m 로 올린다. B11b 에서 적용(높이는 추정. 사용자 보행 기록이 오면 다시 맞춘다).
"""
import json, pathlib, sys
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).parent
S = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
live = lambda x: x.get('status') in ('DRAFT', 'APPROVED')
OLD, NEW, DECK_Z = '건물5', '혜인관', 137.8
EVID = '혜인관 노트 B11: 캠퍼스 지도 파일이 실제 혜인관 도형에 이름을 주지 않아 서버 건물 id 가 건물5 였다. backend/data/campus-map/overrides/building-ids.json 이 혜인관으로 바로잡았다(H02)'

ops = []
for r in sorted((r for r in S['roads'] if live(r) and r.get('buildingId') == OLD), key=lambda r: r['name']):
    ops.append({'ref': f"길 {r['id'][:8]} {r['name']}: 건물 표기 {OLD} → {NEW}", 'op': 'update_road', 'args': {'id': r['id'], 'expectedRevision': r['revision'], 'attrs': {'buildingId': NEW}}, 'grade': '원천(건물 자료)', 'evidence': EVID})
for p in sorted((p for p in S['places'] if p.get('status') != 'RETIRED' and p.get('buildingId') == OLD), key=lambda p: p['name']):
    ops.append({'ref': f"장소 {p['id'][:8]} {p['name']}: 건물 표기 {OLD} → {NEW}", 'op': 'update_place', 'args': {'id': p['id'], 'expectedRevision': p['revision'], 'buildingId': NEW}, 'grade': '원천(건물 자료)', 'evidence': EVID})
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups/hyein-id.json').write_text(json.dumps({'id': 'B11-hyein-id', 'zone': '혜인관', 'comment': f"B11 혜인관 건물 표기 {OLD} → {NEW} (길 {sum(o['op'] == 'update_road' for o in ops)}, 장소 {sum(o['op'] == 'update_place' for o in ops)})", 'ops': ops}, ensure_ascii=False, indent=1), encoding='utf-8')
print('hyein-id:', [o['ref'] for o in ops])

# ---- 데크(준비만)
road = lambda p: next(r for r in S['roads'] if live(r) and r['id'].startswith(p))
dev = '본관·한림관 노트 B11: 데크 = 본관 5층 = 한림관 3층. 층 사슬 137.8 m(추정, 136.0~138.9). 표지 자리 S-MAP 130.5 는 평탄면이 아닌 좁은 틈의 값. B11b 에서 시험용 DB 에 적용'
d1, d2, ext = road('0399773c'), road('f8bb47f5'), road('2b765aa4')
node_ids = [d1['fromNodeId'], d1['toNodeId'], d2['toNodeId']]
nodes = {n['id']: n for n in S['nodes']}
ops = [{'ref': f'데크 노드 {i[:8]} {nodes[i]["coordinate"][2]} → {DECK_Z}', 'op': 'move_node', 'args': {'nodeId': i, 'to': {'xy': nodes[i]['coordinate'][:2], 'z': DECK_Z}}, 'grade': '추정', 'evidence': dev} for i in node_ids]
c = ext['coordinates']     # B11b: 그림 끝(아래 끝, 그대로)에서 데크까지 한 줄로 고르게 오른다. 내려가는 곳 없음
seg = [((c[i][0] - c[i - 1][0]) ** 2 + (c[i][1] - c[i - 1][1]) ** 2) ** .5 for i in range(1, len(c))]
total = sum(seg); run = 0; vops = []
for i in range(1, len(c) - 1):
    run += seg[i - 1]
    vops.append({'op': 'move', 'index': i, 'point': {'xy': c[i][:2], 'z': round(c[0][2] + (DECK_Z - c[0][2]) * run / total, 2)}})
ops.append({'ref': f'보행 구간 연장 2b765aa4: {c[0][2]} m 에서 데크 {DECK_Z} m 까지 {total:.1f} m 를 한 경사({(DECK_Z - c[0][2]) / total * 100:.1f} %)로(전: {max(v[2] for v in c)} m 까지 올랐다가 {c[-1][2]} m 로 내려감)', 'op': 'update_road',
            'args': {'id': ext['id'], 'expectedRevision': ext['revision'], 'zMode': 'explicit', 'densify': False, 'vertexOps': vops}, 'grade': '추정', 'evidence': dev})
for p in S['places']:
    if p.get('status') != 'RETIRED' and '연결통로' in p['name'] and '본관' in p['name']:
        ops.append({'ref': f"장소 {p['name']} 높이 {p['coordinate'][2]} → {DECK_Z}", 'op': 'update_place', 'args': {'id': p['id'], 'expectedRevision': p['revision'], 'position': {'xy': p['coordinate'][:2], 'z': DECK_Z}}, 'grade': '추정', 'evidence': dev})
(HERE / 'groups/deck.json').write_text(json.dumps({'id': 'B11-deck', 'zone': '본관·한림관', 'comment': 'B11b: 본관–한림관 데크와 보행 구간 연장을 137.8 m 로(추정). 보행 구간은 데크까지 한 경사', 'ops': ops}, ensure_ascii=False, indent=1), encoding='utf-8')
print('deck(준비만):', [o['ref'] for o in ops])
