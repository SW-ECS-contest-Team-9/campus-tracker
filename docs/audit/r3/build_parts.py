"""R3(2026-10-25): 은주관 입구 상자 길이(C2)와 풋살파크 북서 끝 놀이터·계단(C5)을 전수 판독 R3 대로 고친다. DB·네트워크 접근 없음.   python -X utf8 build_parts.py
근거: 볼트 데이터/보완자료/학교-전경-20261022/전수판독/R3/판독.md(보완 목록 C2·C5, 그림 01·05·20, S-MAP 정사 10·11, 드론 항공),
  동 노트 은주관·구역 노트 은주관 둘레와 풋살장의 "2026-10-25 R3 전수 판독 반영" 절.
옛 생성 스크립트(x22/build_parts.py, u02/build_parts.py, y01/build_parts.py)는 뒤 작업이 같은 파일을 id 로 고쳐 다시 돌릴 수 없다. 그래서 r1·r2 처럼 id 로 고친다.
처음 실행 때 고치는 지물의 원본을 base.json 에 남기고, 다음 실행은 원본에서 다시 시작한다(몇 번 돌려도 같다. r2/build_parts.py 다음에 돌린다).

C2: 상자 틀(x22: KO 남서 모서리, KA 긴 축 북 방위 9.4도, KB 짧은 축 동)에서 남쪽 벽을 a = 0 → 2.0 으로(남쪽 벽 가운데 557291.4 → 557293.4).
    북쪽 끝(a 8.5)·폭(4.0)·문·높이 그대로. 벽 4.0 x 6.5 m, 지붕(처마 포함) 7.1 m.
    a < 1 인 꼭짓점을 a + 2.0 으로 옮긴다(서·남·동 벽, 지붕, 남쪽 골). 동쪽 골 가운데 a < 2.05 인 것(3개)은 걷는다.
    안 계단(빈 곳): 상자 안 윗부분 U02-VOID-FIELD-STAIR-BOX 는 a 2.12 ~ 6.8(146.6 ~ 148.9 그대로),
    운동장 밑 계단실 U02-VOID-FIELD-STAIR 는 지하 1층 참 SBN → 새 남쪽 끝(a 2.0, b 2.0) 폭 2.2 m(143.5 ~ 148.2 그대로),
    주차관리센터 구역 U11-OFFICE-BLOCK-0 은 새 계단실 자리를 비움(u02 와 같이 선에서 1.2 m, 0.12 m 줄임).
    화단 Z05-EUNJU-FIELD-PLANTER-4 북쪽 끝을 X22 이전 모양(557293.5)으로 되돌리고 새 상자 자리만 뺌.
C5: 풋살파크(수인관 옥상 132.2) 북서 끝, 작은 코트 C 북서 짧은 변과 옥상 북서 가장자리 사이 띠에 파란 바닥 놀이터·나무 데크·놀이 기구 둘,
    그 북동 끝에서 옥상 가장자리 밖으로 3단 계단(132.2 → 131.7)과 참(131.7, 윗길 끝 포장 U1X-02 의 남동 모서리까지). 자리 추정(±2 m).
    계단 자리만큼 북서 난간벽 Y01-SUIN-PARAPET-NW·울타리 Z05-FUTSAL-FENCE-02 를 뗀다.
고치는 파일(frontend/public/structures): x22-photo-fixes, u01-field-basement, z05-eunju, y01-futsal-yard, r3-eunju(새)."""
import json, pathlib, copy
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape
from shapely.ops import unary_union

HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
STR = REPO / 'frontend' / 'public' / 'structures'
BASEF = HERE / 'base.json'
r2 = lambda v: round(float(v), 2)
OUT = 'r3-eunju.geojson'
SRC = '판독 보완자료/학교-전경-20261022/전수판독/R3/판독.md(S-MAP 정사 10·11, 카카오·네이버 항공, 드론 풋살파크, 확인/은주관-박스-탑다운-사양, 전경 영상 158~159 s)'
G_BOX = '확정(남쪽 끝 = 화단 북쪽 끝 약 557293.4: S-MAP 정사·카카오·네이버 세 항공), 추정(길이 ±0.5 m, 동서 ±1 m)'
G_PLAY = '확정(있음: 드론·S-MAP 옥상 정사), 추정(자리·크기 ±2 m, 기구 모양)'
G_STAIR = '확정(있음: 드론), 추정(자리 ±2 m, 단 수·높이: 옥상 132.2 → 윗길 끝 포장 131.7)'

FILES = ['x22-photo-fixes.geojson', 'u01-field-basement.geojson', 'z05-eunju.geojson', 'y01-futsal-yard.geojson']
D = {fn: json.loads((STR / fn).read_text(encoding='utf-8')) for fn in FILES}
def dump(path, obj): path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
BASE = json.loads(BASEF.read_text(encoding='utf-8')) if BASEF.exists() else None
if BASE:   # 다시 돌릴 때: 원본으로 되돌림(걷은 것도 되살림)
    for fn in FILES:
        orig = BASE['features'].get(fn, {})
        feats = [f for f in D[fn]['features'] if not f['properties']['id'].startswith('R3-')]
        have = {f['properties']['id'] for f in feats}
        feats = [copy.deepcopy(orig[f['properties']['id']]) if f['properties']['id'] in orig else f for f in feats]
        feats += [copy.deepcopy(f) for i, f in orig.items() if i not in have]
        D[fn]['features'] = feats
IDX = {f['properties']['id']: (fn, f) for fn in FILES for f in D[fn]['features']}
def F(i): return IDX[i][1]

BOXIDS = sorted(i for i in IDX if i.startswith('X22-EUNJU-BOX-'))
TOUCH = BOXIDS + ['U02-VOID-FIELD-STAIR', 'U02-VOID-FIELD-STAIR-BOX', 'U11-OFFICE-BLOCK-0', 'Z05-EUNJU-FIELD-PLANTER-4', 'Y01-SUIN-PARAPET-NW', 'Z05-FUTSAL-FENCE-02']
if not BASE:
    BASE = {'features': {}}
    for i in TOUCH: fn, f = IDX[i]; BASE['features'].setdefault(fn, {})[i] = copy.deepcopy(f)
    dump(BASEF, BASE)

def ring(poly):
    p = []
    for x, y in list(poly.exterior.coords)[:-1]:
        q = [r2(x), r2(y)]
        if not p or q != p[-1]: p.append(q)
    if p[0] == p[-1]: p.pop()
    if Polygon(p).exterior.is_ccw is False: p = p[::-1]
    return p + [p[0]]
def geom(g):
    g = g.buffer(0)
    if g.geom_type == 'MultiPolygon':
        parts = [q for q in g.geoms if q.area > 0.01]
        if len(parts) == 1: g = parts[0]
        else: return {'type': 'MultiPolygon', 'coordinates': [[ring(q)] for q in parts]}
    assert g.geom_type == 'Polygon' and g.area > 0.0005, g
    return {'type': 'Polygon', 'coordinates': [ring(g)]}
def note(f, what):
    p = f['properties']; p['assumption'] = p.get('assumption', '').split(' [R3')[0] + f' [R3 2026-10-25: {what}]'
REPORT = []

# ===================== C2 은주관 입구 상자 =====================
KO = np.array([201143.02, 557291.74]); KA = (np.array([201144.40, 557300.13]) - KO) / 8.5; KB = (np.array([201146.96, 557291.09]) - KO) / 4.0
KA, KB = KA / np.hypot(*KA), KB / np.hypot(*KB)
A0 = 2.0   # 새 남쪽 벽 바깥면(a)
def ab(x, y): d = np.array([x, y]) - KO; return float(d @ KA), float(d @ KB)
def xy(a, b): q = KO + KA * a + KB * b; return float(q[0]), float(q[1])
def kq(a0, a1, b0, b1): return Polygon([xy(a, b) for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))])
def shift_south(g):
    def mv(poly): return Polygon([xy(a + A0 if a < 1.0 else a, b) for a, b in (ab(x, y) for x, y in poly.exterior.coords)])
    g = shape(g)
    return unary_union([mv(q) for q in g.geoms]) if g.geom_type == 'MultiPolygon' else mv(g)
for i in BOXIDS:
    f = F(i); c = shape(f['geometry']).centroid; a, b = ab(c.x, c.y)
    if i.startswith('X22-EUNJU-BOX-SEAM-E-') and a < A0 + 0.05:
        f['properties']['_drop'] = True; continue
    if min(ab(x, y)[0] for x, y in shape(f['geometry']).exterior.coords) < 1.0:
        f['geometry'] = geom(shift_south(f['geometry'])); note(f, '상자 남쪽 끝을 2.0 m 북쪽(남쪽 벽 가운데 557293.4: 세 항공의 화단 북쪽 끝)으로. 벽 4.0 x 6.5 m, 지붕 7.1 m')
f = F('U02-VOID-FIELD-STAIR-BOX'); f['geometry'] = geom(shift_south(f['geometry']))
note(f, '상자가 짧아져 안 계단 윗부분은 a 2.12 ~ 6.8(4.7 m). 높이 146.6 ~ 148.9 그대로')
SBN = np.array([201148.605, 557282.015])                     # 지하 1층 계단 참(u02 SBN, 노드 4eebbb98)
ST_BOT = np.array(xy(A0, 2.0)); ST_TOP = np.array(xy(6.8, 2.0))
line = LineString([tuple(SBN), tuple(ST_BOT)])
f = F('U02-VOID-FIELD-STAIR'); f['geometry'] = geom(line.buffer(1.1, cap_style=2))
note(f, f'계단실을 지하 1층 참 → 새 상자 남쪽 끝({r2(ST_BOT[0])}, {r2(ST_BOT[1])})까지 {r2(line.length)} m. 높이 143.5 ~ 148.2 그대로')
f = F('U11-OFFICE-BLOCK-0'); g = shape(f['geometry']).difference(line.buffer(1.32, cap_style=2))
f['geometry'] = geom(max(g.geoms, key=lambda q: q.area) if g.geom_type == 'MultiPolygon' else g); note(f, '새 계단실(상자 남쪽 끝이 2 m 북쪽) 자리를 비움')
BOXP = kq(A0 - 0.05, 9.05, -0.15, 4.15)                        # 지붕 테(-0.1 ~ 4.1) 밖 0.05 m
PL_OLD = Polygon([(201143.18, 557293.99), (201143.25, 557293.98), (201143.2, 557293.5), (201146.24, 557293.5), (201140.1, 557255.5), (201137.04, 557255.99)])   # X22(5cbe613) 이전
f = F('Z05-EUNJU-FIELD-PLANTER-4'); g = PL_OLD.difference(BOXP)
f['geometry'] = geom(max(g.geoms, key=lambda q: q.area) if g.geom_type == 'MultiPolygon' else g)
p = f['properties']; p['assumption'] = p['assumption'].replace(' 2026-10-22: 북쪽 끝을 은주관 입구 상자 남쪽 벽 앞에서 자름', '')
note(f, '북쪽 끝을 X22 이전(557293.5)으로 되돌림: 세 항공에서 화단이 상자 남쪽 끝까지. 새 상자 자리만 뺌')
REPORT.append(f'C2 상자 남쪽 벽 바깥 a {A0}: 남서 {xy(A0, 0)}, 남동 {xy(A0, 4.0)}; 계단 남쪽 끝 {xy(A0, 2.0)}, 안쪽 끝(a 2.2) {xy(2.2, 2.0)}, 북쪽 참 앞 {xy(6.8, 2.0)}')
REPORT.append(f'C2 계단실 길이 {line.length:.2f} m, 상자 안 계단 {6.8 - A0 - 0.12:.2f} m')

# ===================== C5 풋살파크 북서 끝 놀이터·계단 =====================
YA, YB = np.array([201102.9, 557190.1]), np.array([201125.6, 557204.3])   # 옥상 기단 Y01-PLATFORM-SUIN-YARD 북서 가장자리
E = (YB - YA) / np.hypot(*(YB - YA)); NO = np.array([-E[1], E[0]])          # s: 가장자리 따라 북동 +, t: 밖(북서) +
def sp(s, t): q = YA + E * s + NO * t; return float(q[0]), float(q[1])
def SR(s0, s1, t0, t1): return Polygon([sp(s, t) for s, t in ((s0, t0), (s1, t0), (s1, t1), (s0, t1))])
COURT = shape(json.loads((STR / 'p01-parts.geojson').read_text(encoding='utf-8'))['features'][[f['properties']['id'] for f in json.loads((STR / 'p01-parts.geojson').read_text(encoding='utf-8'))['features']].index('P01-SUIN-COURT-3')]['geometry'])
ZY = 132.2
NEW = []
def feat(fid, typ, g, z0, z1, what, grade, base, **extra):
    assert z1 > z0, fid
    NEW.append({'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base,
                'fromM': r2(z0), 'toM': r2(z1), 'assumption': 'R3: ' + what, 'source': SRC, **extra}, 'geometry': geom(g)})
strip = SR(3.0, 15.0, -6.8, -0.55).difference(COURT.buffer(0.3))
feat('R3-FUTSAL-PLAY-FLOOR', 'wall', strip.intersection(SR(2.9, 15.1, -7.0, -1.75)), ZY, ZY + 0.03,
     '풋살파크 북서 끝 놀이터 파란 바닥 칠(작은 코트 C 북서 끝과 옥상 가장자리 사이, 드론: 기구·파란 바닥, 그 북서에 나무 데크)', G_PLAY, 'Y01-PLATFORM-SUIN-YARD', color='#4f9cc8', surfaceMark=True)
feat('R3-FUTSAL-PLAY-DECK', 'deck', SR(3.0, 15.0, -1.75, -0.55), ZY, ZY + 0.15, '놀이터 북서 쪽 나무 데크 띠(폭 1.4 m, 드론)', G_PLAY, 'Y01-PLATFORM-SUIN-YARD', color='#8c6b4f')
feat('R3-FUTSAL-PLAY-TOWER', 'wall', SR(6.0, 7.8, -4.4, -2.6), ZY + 0.03, ZY + 2.4, '놀이 기구(미끄럼틀 탑, 흰·분홍, 네모로 줄임)', G_PLAY, 'R3-FUTSAL-PLAY-FLOOR', color='#e9e3e6')
feat('R3-FUTSAL-PLAY-SLIDE', 'wall', SR(7.8, 10.0, -3.8, -3.2), ZY + 0.03, ZY + 0.9, '미끄럼틀(낮은 판으로 줄임)', G_PLAY, 'R3-FUTSAL-PLAY-TOWER', color='#d9d2c4')
feat('R3-FUTSAL-PLAY-FRAME', 'wall', SR(10.6, 12.4, -4.6, -2.8), ZY + 0.03, ZY + 1.6, '놀이 기구(오르기 틀, 흰색, 네모로 줄임)', G_PLAY, 'R3-FUTSAL-PLAY-FLOOR', color='#f0eee8')
# 계단: 옥상 가장자리(t 0)에서 밖으로 3단(디딤 0.3, 단 높이 (132.2 - 131.7)/3), 참 131.7 은 윗길 끝 포장 U1X-02 남동 모서리(s 19.4, t 2.2)까지
S0, S1, ZB, NST = 15.6, 18.0, 131.7, 3
RISE = (ZY - ZB) / NST
GROUND = 129.4   # 그 밑 가운데 옹벽 남쪽 끝 경사 기단(Z05-PLATFORM-EUNJU-CENTRAL-SOUTH, 이 자리 약 129.6) 보다 조금 아래
for k in range(NST):
    feat(f'R3-FUTSAL-PLAY-STAIR-{k + 1:02d}', 'stair_step', SR(S0, S1, 0.3 * k, 0.3 * (k + 1)), GROUND, ZY - RISE * (k + 1),
         f'놀이터 북동 끝 → 윗길 끝 포장 계단 {k + 1}/{NST}(드론 오른쪽 끝 계단, 자리 추정)', G_STAIR, 'Z05-PLATFORM-EUNJU-CENTRAL-SOUTH',
         stair='R3-FUTSAL-PLAY-STAIR', riseM=r2(RISE), runM=0.3, material='stone', color='#b9b5ab')
feat('R3-FUTSAL-PLAY-STAIR-LANDING', 'landing', SR(S0, 19.6, 0.3 * NST, 2.4), GROUND, ZB, '계단 발치 참(131.7 = 윗길 끝 포장 U1X-02 의 그 자리 높이)', G_STAIR,
     'Z05-PLATFORM-EUNJU-CENTRAL-SOUTH', material='stone', color='#b9b5ab')
CUT = SR(S0, S1, -0.6, 0.6)
for i in ('Y01-SUIN-PARAPET-NW', 'Z05-FUTSAL-FENCE-02'):
    f = F(i); g = shape(f['geometry']).difference(CUT); f['geometry'] = geom(g); note(f, '놀이터 북동 끝 계단 자리(s 15.6~18.0)를 뗌')
REPORT.append(f'C5 계단 윗끝 가운데 {sp((S0 + S1) / 2, 0)}, 참 가운데 {sp(17.6, 1.65)}, 놀이터 가운데 {sp(9.0, -3.6)}')

# ===================== 겹침 검사(새·고친 상자 대 모든 상자) =====================
ALL = {}
for fp in sorted(STR.glob('*.geojson')):
    if fp.name in FILES or fp.name == OUT or fp.name.startswith('a2-'): continue
    for ft in json.loads(fp.read_text(encoding='utf-8'))['features']: ALL[ft['properties'].get('id')] = ft
for fn in FILES:
    for ft in D[fn]['features']:
        if not ft['properties'].get('_drop'): ALL[ft['properties']['id']] = ft
for ft in NEW: ALL[ft['properties']['id']] = ft
def solid(ft):
    p = ft['properties']
    if p.get('kind') in ('platform',) or p.get('type') in ('tree', 'surface', 'curb') or not ft.get('geometry') or p.get('fromM') is None: return None
    return shape(ft['geometry']).buffer(0), p['fromM'], p['toM'], p.get('kind') == 'void'
SOL = {i: s for i, ft in ALL.items() if (s := solid(ft))}
CHECK = TOUCH + [f['properties']['id'] for f in NEW]
seen = set()
for i in CHECK:
    if i not in SOL: continue
    g, lo, hi, vi = SOL[i]
    for j, (h, lo2, hi2, vj) in SOL.items():
        if j == i or (j, i) in seen or vi != vj: continue
        if i.startswith('X22-EUNJU-BOX') and j.startswith('X22-EUNJU-BOX'): continue
        if i.startswith('R3-') and j.startswith('R3-'): continue
        if hi2 > lo + 0.02 and lo2 < hi - 0.02:
            a = g.intersection(h).area
            if a > 0.05: REPORT.append(f'겹침 {i} × {j} {a:.2f} ㎡'); seen.add((i, j))

for fn in FILES:
    D[fn]['features'] = [f for f in D[fn]['features'] if not f['properties'].pop('_drop', False)]
    dump(STR / fn, D[fn])
dump(STR / OUT, {'type': 'FeatureCollection', 'name': 'r3-eunju', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': NEW})
print('\n'.join(REPORT)); print(f'{OUT}: {len(NEW)}')
