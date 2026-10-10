"""Z06: 대일관 현관의 길 높이를 구조물과 맞추는 편집 묶음을 만든다(시험용 DB 에만 쓴다. 적용은 n02.ts apply).   python build_groups.py A|B STATE.json OUT.json
A = 노드 높이(계단 위 참 151.0 → 151.3, 현관 문 151.0 → 151.8), B = 길의 안쪽 꼭짓점 높이와 이름(A 뒤의 STATE 로 만든다: 개정 번호가 바뀐다).
근거: 대일관 노트 Z06 절. 참 151.3 = 운동장 + 13단(사진을 다시 셈), 높은 띠 151.3 과 같은 높이. 1층 151.8 = S-MAP(입구(2) 151.7, 뒷문 152.0), 참에서 아치 밑 3단(추정)."""
import sys, json, pathlib
which, state, out = sys.argv[1:4]
S = json.loads(pathlib.Path(state).read_text(encoding='utf-8')); N = {n['id'][:8]: n for n in S['nodes']}; R = {r['id'][:8]: r for r in S['roads']}
EV = '대일관 노트 Z06 절: 사진(대일관-현관-계단-가까이)에서 참까지 13단 + 아치 밑 2~3단. 참 151.3 m(추정, 높은 띠 151.3 과 같음), 1층 151.8 m(S-MAP). 구조물 파일 z02-daeil-front 와 같은 값'
LAND = json.loads((pathlib.Path(__file__).parents[1] / 'z02' / 'model.json').read_text(encoding='utf-8'))['points']['sideStairLandingZ']
ops = []
if which == 'A':
    for nid, z, what in (('6dc0b41f', 151.3, '넓은 계단 위(참)'), ('3bd52867', 151.3, '현관 참 가운데'), ('0c2a31b0', 151.3, '현관 참 서쪽 끝(하행 계단 위)'), ('1f06689e', 151.3, '현관 참 동쪽 끝(높은 통로 앞)'), ('e36d63e5', 151.8, '현관 문(1층 로비 바닥)')):
        n = N[nid]; x, y, z0 = n['coordinate']
        ops.append({'ref': f'대일관 {what} {z0} → {z}', 'op': 'move_node', 'args': {'nodeId': n['id'], 'to': {'xy': [x, y], 'z': z}}, 'grade': '추정(참 151.3), S-MAP(1층 151.8)', 'evidence': EV})
else:
    def road(rid, name=None, structure=None, mids=None):
        r = R[rid]; a = {'id': r['id'], 'expectedRevision': r['revision']}; attrs = {}
        if name: attrs['name'] = name
        if structure: attrs['structure'] = structure
        if attrs: a['attrs'] = attrs
        if mids: a.update(zMode='explicit', densify=False, vertexOps=[{'op': 'move', 'index': i, 'point': {'xy': r['coordinates'][i][:2], 'z': z}} for i, z in mids.items()])
        ops.append({'ref': f'{rid} {name or "안쪽 꼭짓점 높이"}', 'op': 'update_road', 'args': a, 'grade': '추정(참 151.3), S-MAP(1층 151.8)', 'evidence': EV})
    road('8d276e10', '대일관 현관 앞 넓은 계단 (13단 추정, 148.9 → 151.3 m)')
    road('a704ec27', '대일관 현관 참 (151.3 m 추정): 계단 위 → 참 가운데')
    road('14a66625', '대일관 현관: 참 151.3 → 아치 밑 3단(추정) → 현관 문 151.8 m', structure='stairs')
    road('8ae8686a', '대일관 현관 참: 서쪽 끝(하행 계단 위)까지', mids={1: 151.3})
    road('acd80bae', '대일관 현관 참: 동쪽 끝(높은 통로 앞)까지', mids={1: 151.3})
    road('b15ec913', '현관 참 → 높은 가장자리 길 (같은 높이 151.3 m 로 그대로 이어짐, 추정)', structure='ordinary')
    road('f50b9ad8', '대일관 출구 옆 하행 계단 (36단 추정, 151.3 → 145.5 m, 가운데 참)', mids={1: LAND, 2: LAND})
    road('c3575f67', '대일관 1층 로비 (현관 문 ~ 실내 통로, 151.8 m. 현관 참 151.3 과의 차는 아치 밑 3단: Z06)')
pathlib.Path(out).write_text(json.dumps({'id': 'Z06-' + which, 'zone': '대일관 정면', 'comment': 'Z06 대일관 현관: 계단 위 참 151.3 m, 현관 문·1층 로비 151.8 m(구조물과 같은 값)' + (' — 노드' if which == 'A' else ' — 길 꼭짓점·이름'), 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(which, len(ops), 'ops')
