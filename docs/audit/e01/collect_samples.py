# E01: S-MAP 지면 표본 수집·중복 제거·구역 분류.
# 사용법: python collect_samples.py <3d-map-audit-20261009 폴더> <출력 samples.json>
# 표본 두 종류(이 실험에서 붙인 이름):
#   api  = S-MAP 표고 조회 응답의 dem_z (지면 DEM 값, XY만 보내 받은 값). buld_z 가 null 이 아니면 건물 자리이므로 제외.
#   mesh = S-MAP 3D 화면에서 2 m 격자로 읽은 메시 표면 z. 모델 구분이 지형('.')인 칸만 사용. 나무·차량·옹벽 번짐이 섞일 수 있다.
import json, sys, os, math
A, OUT = sys.argv[1], sys.argv[2]
J = lambda p: json.load(open(os.path.join(A, p), encoding='utf-8'))
S = []      # 채택 표본
X = []      # 제외 표본(이유 포함)

def add_api(x, y, raw, src, name):
    r = json.loads(raw)['result']
    rec = dict(x=x, y=y, z=r['dem_z'], kind='api', src=src, name=name)
    if r['buld_z'] is not None: X.append(dict(rec, why='buld_z 있음(건물 자리)'))
    else: S.append(rec)

for p in J('smap-coordinate-checks.json')['points']:
    add_api(p['x'], p['y'], p['responseRaw'], 'smap-coordinate-checks.json', p['id'])
for f in ['claude-m16/smap-elevation-raw-20261009.json', 'claude-m17/smap-elevation-raw-m17.json',
          'claude-user-20261010/고층부식별/smap-elevation-raw.json', 'claude-user-20261010/위치대응/smap-elevation-raw.json']:
    for p in J(f): add_api(p['x'], p['y'], p['raw'], f, p['name'])
for f in ['s06-cross-sections-raw-20261010.json', 's06-end-cross-sections-raw-20261010.json',
          's06-lower-interior-raw-20261010.json', 's06-outer-cross-sections-raw-20261010.json']:
    for p in J('claude-m16/' + f)['points']:
        add_api(p['x'], p['y'], p['raw'], 'claude-m16/' + f, f"st{p['station']} off{p['offsetM']}")

# --- mesh ---
M = J('claude-user-20261010/운동장구조/smap-mesh-reads-v3.json')
MR = 'claude-user-20261010/운동장구조/smap-mesh-reads-v3.json'
for seg in M['field_flat_component']['rle_y_xranges'].split(';'):
    y, rest = seg.split(':')
    for r in rest.split(','):
        a, b = map(int, r.split('-'))
        for x in range(a, b + 1, 2):
            # 원값은 저장돼 있지 않다. 선택 규칙 |z-148.92|<=0.12 로 고른 칸이므로 148.92 로 둔다(±0.12).
            S.append(dict(x=x, y=int(y), z=148.92, kind='mesh', src=MR + '#field_flat_component', name='운동장 평지 칸(규칙값)'))
for key in ['high_strip_cells', 'wall_transition_cells', 'corridor_cells']:
    for x, y, z in M[key]: S.append(dict(x=x, y=y, z=z, kind='mesh', src=MR + '#' + key, name=key))
for key in ['daeil_canopy_cells', 'cheongun_roof_cells']:
    for x, y, z in M[key]: X.append(dict(x=x, y=y, z=z, kind='mesh', src=MR + '#' + key, why='건물 모델 칸(지붕)'))

def grid_m17():
    z = {}; m = {}
    for ln in open(os.path.join(A, 'claude-m17/smap-surface-grid-2m.txt'), encoding='utf-8'):
        if ln.startswith('#') or not ln.strip(): continue
        j, _, vals = ln.strip().split(':')
        for i, v in enumerate(vals.split(',')): z[(200984 + 2 * i, 557214 + 2 * int(j))] = int(v)
    for ln in open(os.path.join(A, 'claude-m17/smap-modelid-grid-2m.txt'), encoding='utf-8'):
        if ln.startswith('#') or not ln.strip(): continue
        j, chars = ln.strip().split(':')
        for i, c in enumerate(chars): m[(200984 + 2 * i, 557214 + 2 * int(j))] = c
    return z, m
z, m = grid_m17()
for k, v in z.items():
    rec = dict(x=k[0], y=k[1], z=v / 10, kind='mesh', src='claude-m17/smap-surface-grid-2m.txt', name='m17 격자')
    if v < 0 or m.get(k) is None or m.get(k) == '?': continue
    if m[k] != '.': X.append(dict(rec, why='건물 모델 칸 ' + m[k]))
    else: S.append(rec)
for ln in open(os.path.join(A, 'claude-user-20261010/고층부식별/smap-grid-2m.txt'), encoding='utf-8'):
    if ln.startswith('#') or not ln.strip(): continue
    j, _, sym, vals = ln.strip().split(':')
    for i, (c, v) in enumerate(zip(sym, vals.split(','))):
        if int(v) < 0: continue
        rec = dict(x=201070 + 2 * i, y=557270 + 2 * int(j), z=int(v) / 10, kind='mesh', src='claude-user-20261010/고층부식별/smap-grid-2m.txt', name='고층부식별 격자')
        if c != '.': X.append(dict(rec, why='건물 모델 칸 ' + c))
        else: S.append(rec)

# --- 구역 ---
R = [(201091.11, 557241.71), (201075.75, 557270.59), (201062.18, 557281.71), (201052.66, 557287.23), (201043.19, 557293.51)]  # S06 중심 표본 R1~R5
def dseg(x, y):
    best = 1e9
    for (ax, ay), (bx, by) in zip(R, R[1:]):
        t = max(0, min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
        best = min(best, math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)))
    return best
def area(s):
    x, y = s['x'], s['y']
    if 201100 <= x <= 201150 and 557300 <= y <= 557336: return '사잇길'
    if 'field_flat' in s['src'] or 'high_strip' in s['src'] or 'wall_transition' in s['src']: return '운동장'
    if 201136 <= x <= 201240 and 557176 <= y <= 557312: return '운동장'
    if dseg(x, y) <= 8: return 'S06'
    return '기타'
for s in S: s['area'] = area(s)

# --- 중복 제거: 같은 종류·같은 XY(0.01 m 반올림)는 먼저 나온 것만 남긴다. 출처가 다른 mesh 값이 0.5 m 넘게 다르면 둘 다 뺀다 ---
seen = {}; dup = []; out = []; bad = set()
for s in S:
    k = (s['kind'], round(s['x'], 2), round(s['y'], 2))
    if k in seen:
        dz = round(s['z'] - seen[k]['z'], 3)
        dup.append(dict(x=s['x'], y=s['y'], kind=s['kind'], a=seen[k]['src'], b=s['src'], dz=dz))
        if s['kind'] == 'mesh' and abs(dz) > 0.5: bad.add(k)
    else: seen[k] = s; out.append(s)

# --- mesh 걸러내기(이 실험의 규칙) ---
#  1) 이웃 8칸 중 건물 모델 칸이 있으면 제외(건물 가장자리 시차 오류)
#  2) 지형 이웃이 없거나 |z - 이웃 중앙값| > 1.5 m 이면 제외(튀는 값: 나무·차량·시차)
#  3) 기타 구역의 mesh 는 입력에 쓰지 않는다(api 와 9~19 m 어긋나는 칸이 확인돼 지면이라고 볼 근거가 없다)
bld = {(e['x'], e['y']) for e in X if e['kind'] == 'mesh'}
N8 = [(dx, dy) for dx in (-2, 0, 2) for dy in (-2, 0, 2) if dx or dy]
for s in out:
    s['use'] = True
    if s['kind'] != 'mesh': continue
    k = (s['x'], s['y'])
    why = None
    if ('mesh', round(k[0], 2), round(k[1], 2)) in bad: why = '출처 간 0.5 m 초과 불일치'
    elif any((k[0] + dx, k[1] + dy) in bld for dx, dy in N8): why = '건물 칸 이웃'
    elif s['area'] == '기타': why = '기타 구역 mesh(지면 근거 부족)'
    if why: s['use'] = False; s['why'] = why
changed = True
while changed:   # 남은 칸끼리만 이웃을 보고, 더 빠지는 칸이 없을 때까지 반복
    changed = False
    mz = {(s['x'], s['y']): s['z'] for s in out if s['kind'] == 'mesh' and s['use']}
    for s in out:
        if s['kind'] != 'mesh' or not s['use']: continue
        k = (s['x'], s['y'])
        nb = sorted(mz[(k[0] + dx, k[1] + dy)] for dx, dy in N8 if (k[0] + dx, k[1] + dy) in mz)
        why = None
        if not nb: why = '이웃 지형 칸 없음(고립)'
        elif abs(s['z'] - (nb[len(nb) // 2] if len(nb) % 2 else (nb[len(nb) // 2 - 1] + nb[len(nb) // 2]) / 2)) > 1.5: why = '이웃 중앙값과 1.5 m 초과'
        if why: s['use'] = False; s['why'] = why; changed = True
cnt = {}; drop = {}
for s in out:
    if s['use']: cnt[(s['area'], s['kind'])] = cnt.get((s['area'], s['kind']), 0) + 1
    else: drop[s['why']] = drop.get(s['why'], 0) + 1
dz = sorted(abs(d['dz']) for d in dup if d['a'] != d['b'])
summary = dict(collected=len(S), afterDedup=len(out), used=sum(s['use'] for s in out), excludedBuilding=dict(api=sum(e['kind'] == 'api' for e in X), mesh=sum(e['kind'] == 'mesh' for e in X)), duplicates=len(dup),
               usedCount={f'{a}/{k}': n for (a, k), n in sorted(cnt.items())}, notUsed=drop,
               crossSourceDuplicates=dict(n=len(dz), medianAbs=dz[len(dz) // 2], p90Abs=dz[int(.9 * (len(dz) - 1))], maxAbs=dz[-1], over05=sum(d > .5 for d in dz)))
json.dump(dict(summary=summary, samples=out, excluded=X, duplicates=dup), open(OUT, 'w', encoding='utf-8'), ensure_ascii=False)
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=1))
