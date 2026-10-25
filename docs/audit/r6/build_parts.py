"""R6(2026-10-25): 전수 판독 R6 보완 목록 가운데 모델(구조물) 쪽 F2·F3·F7·F8·F9·F10·F11 을 넣는다. DB·네트워크 접근 없음.
  python -X utf8 build_parts.py          # 고쳐 씀
  python -X utf8 build_parts.py --dry    # 쓰지 않고 수치만
근거: 볼트 데이터/보완자료/학교-전경-20261022/전수판독/R6/판독.md(보완 목록 F1~F14, 그림 01·03·05·20·21, S-MAP 정사 10~13),
  구역 노트 서문과 서쪽 옹벽·뒤편 산책로와 북악관 옆길·정문, 동 노트 외국인 생활관·공연실습소·유담관·상승관·청운관의 "2026-10-25 R6 전수 판독 반영" 절.
r1~r5 처럼 id 로 고친다. 처음 실행 때 지우거나 고치는 지물(구조물·지형 입력)의 원본을 base.json 에 남기고, 다음 실행은 원본에서 다시 시작한다
(몇 번 돌려도 같다. w01·z05·p02·r5 build 다음에 돌린다).

F8 서경로 캠퍼스 쪽(유담관 쪽) 보도·경계석: W01 정문 북서쪽 보도 북쪽 끝(557171) → 유담관 벽 발치 → 회전교차로(W01 서쪽 보도 남쪽 끝).
   길 쪽 가장자리(경계석) = S-MAP 벽 발치 선(판독 ③④⑤, 정사에서 차도 가장자리와 같은 선), 안쪽은 모델 벽(Z07·Z11·W01 남면)까지 포장.
   모델 벽은 S-MAP 벽 발치보다 1.3~5.3 m 북동이라(벽 자리는 고치지 않음) 보도가 2.5~6 m 로 넓게 보인다. 높이 = 공도 기단 + 0.15(W01 과 같은 단면).
   얼룩말(공연실습소 동쪽 끝): 걷는 축 (201055.8, 557195.0) → (201063.3, 557199.2), 폭 3.5 m, 흰 띠 0.45 m 간격.
F7 회전교차로 동쪽 얼룩말: 옛 P02-DORMSTREET-CROSSWALK-01~09(생활관 문 바로 북쪽, 정사에 칠 없음)를 걷고 걷는 축 (201005.5, 557231) → (201011.5, 557237)
   에 새로. 바로 동쪽 노랑·흰 빗금 띠(201012.5~201017.5, 557226.5~557232)는 칠만(고원식 횡단인지 과속방지턱인지 모름).
F9 서문 위 단: 모델의 문 위는 W01-WESTGATE-MASS 윗면 125.11(판독의 119.9~120.5 는 그 밑 공도 기단 값), S-MAP 126.2~127.5 → 문 칸 뒤(557414 북쪽)에
   기단 R6-PLATFORM-WESTGATE-TOP 126.8(소나무 비탈, 동쪽은 GATE-BANK 126.65~ 와 이어짐). 정면 글자 띠·문 칸(118.5~125.1)은 그대로.
F3 서문 왼쪽 철 계단(있음 확정: 거리뷰 색인 34·W01 노트, 네이버 길 선이 같은 자리에서 서문 쪽으로 갈라짐, S-MAP 산책로 점선; 자리·단 수 추정):
   왼쪽 날개벽(MASS 서쪽 변) 안쪽 0.3~1.5 m 띠로 공도(문 앞) → 문 위 단 126.8. MASS 에서 계단 자리를 뺌(날개벽 0.3 m 는 남음).
F10 상승관·청운관 뒤 단: 기단 R6-PLATFORM-BEHIND-SANGSEUNG(판독 외곽, 148.0 → 149.0 서→동 한 경사면). BANK-E(숲 비탈, 그 자리 150.0~151.4)에서 이 자리를 뺌.
F11·F2 청운관 동쪽 흙길: 기단 R6-PLATFORM-CHEONGUN-EAST-TRAIL(뒤 산책로 선 폭 3 m 띠, 148.9 → 149.4 북→남 한 경사면, 윗면 흙: 지표면 노트).
   흙길 고리 안 숲(R6-PLATFORM-CHEONGUN-EAST-WOOD, 같은 면, 추정): 비워 두면 지도 화면에서 그 안 지형이 잘려 빈 곳으로 보인다.
고치는 파일(frontend/public/structures): r6-back(새), p02-parts(옛 얼룩말 걷음), w01-parts(MASS 계단 자리), z05-back-paths(BANK-E 외곽),
  backend/data/terrain/recipes/z05-surface.geojson(새 기단 셋, BANK-E 외곽). docs/audit/r6/model.json(길 변경 묶음이 읽는 점·높이)."""
import json, pathlib, copy, sys, math
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape, box
from shapely.ops import unary_union

DRY = '--dry' in sys.argv
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
STR = REPO / 'frontend' / 'public' / 'structures'; REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'
BASEF = HERE / 'base.json'
r2 = lambda v: round(float(v), 2)
unit = lambda v: np.array(v, float) / np.hypot(*np.array(v, float))
OUT = 'r6-back.geojson'
SRC = '판독 보완자료/학교-전경-20261022/전수판독/R6/판독.md'
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}

FILES = ['p02-parts.geojson', 'w01-parts.geojson', 'z05-back-paths.geojson', 'z09-parts.geojson']
DROP = [f'P02-DORMSTREET-CROSSWALK-{k:02d}' for k in range(1, 10)]
TREES = [f'Z09-BANK-E-TREE-22-{p}' for p in ('TRUNK', 'CROWN', 'TOP')]   # BANK-E 위 나무 가운데 새 단 안에 선 것(내림)
MOD = ['W01-WESTGATE-MASS', 'Z05-PLATFORM-BACK-BANK-E'] + TREES
SURF_MOD = ['Z05-BACK-BANK-E']
D = {fn: json.loads((STR / fn).read_text(encoding='utf-8')) for fn in FILES}
SURF = json.loads((REC / 'z05-surface.geojson').read_text(encoding='utf-8'))
def dump(path, obj):
    if not DRY: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
BASE = json.loads(BASEF.read_text(encoding='utf-8')) if BASEF.exists() else None
if BASE:   # 다시 돌릴 때: 원본으로 되돌림(걷은 것을 되살린 뒤 다시 걷는다)
    for fn in FILES:
        orig = BASE['features'].get(fn, {}); have = {f['properties']['id'] for f in D[fn]['features']}
        D[fn]['features'] = [copy.deepcopy(orig[f['properties']['id']]) if f['properties']['id'] in orig else f for f in D[fn]['features']]
        D[fn]['features'] += [copy.deepcopy(f) for i, f in orig.items() if i not in have]
    SURF['features'] = [s for s in SURF['features'] if not s['properties']['name'].startswith('R6-')]
    for s in SURF['features']:
        if s['properties']['name'] in BASE['surfaces']: s['geometry'] = copy.deepcopy(BASE['surfaces'][s['properties']['name']])
IDX = {f['properties']['id']: (fn, f) for fn in FILES for f in D[fn]['features']}
SIDX = {s['properties']['name']: s for s in SURF['features']}
if not BASE and not DRY:
    BASE = {'features': {}, 'surfaces': {n: copy.deepcopy(SIDX[n]['geometry']) for n in SURF_MOD}}
    for i in DROP + MOD: fn, f = IDX[i]; BASE['features'].setdefault(fn, {})[i] = copy.deepcopy(f)
    dump(BASEF, BASE)

OTHERS = {}
for fp in sorted(STR.glob('*.geojson')):
    if fp.name == OUT or fp.name.startswith('a2-'): continue
    src = D[fp.name]['features'] if fp.name in D else json.loads(fp.read_text(encoding='utf-8'))['features']
    for ft in src:
        if ft['properties'].get('id') not in DROP: OTHERS[ft['properties'].get('id')] = ft

def ring1(coords, ccw):
    p = []
    for x, y in list(coords)[:-1]:
        q = [r2(x), r2(y)]
        if not p or q != p[-1]: p.append(q)
    if p[0] == p[-1]: p.pop()
    if Polygon(p).exterior.is_ccw is not ccw: p = p[::-1]
    return p + [p[0]]
def one(g):
    g = g.buffer(0)
    if g.geom_type != 'Polygon': g = max(g.geoms, key=lambda q: q.area)
    return g
def geom(g):
    g = one(g)
    assert g.area > 0.0005, g
    return {'type': 'Polygon', 'coordinates': [ring1(g.exterior.coords, True)] + [ring1(r.coords, False) for r in g.interiors if Polygon(r).area > 0.05]}
REPORT = []
NEW = []
def feat(fid, typ, g, z0, z1, what, grade, base, kind='extrude', **extra):
    assert z1 > z0, fid
    NEW.append({'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': kind, 'estimated': True, 'grade': grade, 'basePlane': base,
                'fromM': r2(z0), 'toM': r2(z1), 'assumption': 'R6: ' + what, 'source': SRC, **extra}, 'geometry': geom(g)})

def top_fn(p):
    if p.get('topProfile') is None: return lambda x, y: float(p['topM'])
    tp = p['topProfile']; (ox, oy), (dx, dy) = tp['origin'], tp['direction']; n = math.hypot(dx, dy); pts = sorted(tp['points'])
    def f(x, y):
        d = ((x - ox) * dx + (y - oy) * dy) / n
        return float(np.interp(d, [a for a, _ in pts], [h for _, h in pts]))
    return f
def plats():
    return [(i, shape(ft['geometry']).buffer(0), top_fn(ft['properties'])) for i, ft in OTHERS.items()
            if ft['properties'].get('kind') == 'platform' and ('topM' in ft['properties'] or 'topProfile' in ft['properties'])]
PLATS = plats()
def ground(x, y, only=None):
    hit = [(i, t(x, y)) for i, g, t in PLATS if g.contains(Point(x, y)) and (only is None or i in only)]
    assert hit, (x, y)
    return max(hit, key=lambda h: h[1])
STREETS = ['Z05-PLATFORM-WEST-STREET', 'Z05-PLATFORM-GATE-ROUNDABOUT', 'Z05-PLATFORM-GATE-STREET-SW']
def street(x, y):
    """그 자리 공도 윗면(공도 기단 셋 가운데 낮은 것: 공도 위에 얹힌 다른 기단은 보지 않는다)."""
    hit = [(i, t(x, y)) for i, g, t in PLATS if i in STREETS and g.contains(Point(x, y))]
    if not hit:   # 기단 가장자리 밖 몇 cm: 가장 가까운 공도 기단의 면을 늘림
        i = min(STREETS, key=lambda k: dict((a, b) for a, b, _ in PLATS)[k].distance(Point(x, y)))
        return i, dict((a, c) for a, _, c in PLATS)[i](x, y)
    return min(hit, key=lambda h: h[1])
def pieces(g):   # 기단마다 나눈 조각과 그 윗면(겹친 기단은 높은 쪽)
    out = []
    for i, h, t in PLATS:
        q = g.intersection(h)
        if q.area < 0.02: continue
        for part in (q.geoms if q.geom_type in ('MultiPolygon', 'GeometryCollection') else [q]):
            if part.geom_type == 'Polygon' and part.area >= 0.02: c = part.representative_point(); out.append((part, i, t(c.x, c.y)))
    keep = []
    for part, i, z in sorted(out, key=lambda o: -o[2]):
        rest = part.difference(unary_union([k[0] for k in keep])) if keep else part
        if rest.area >= 0.02: keep.append((rest, i, z))
    return keep
def paint_on(fid, g, dz0, dz1, what, grade, color, exclude=None):
    if exclude is not None: g = g.difference(exclude)
    ps = []
    for part, gb, z in pieces(g):
        for sub in (part.geoms if part.geom_type in ('MultiPolygon', 'GeometryCollection') else [part]):
            if sub.geom_type == 'Polygon' and sub.area >= 0.02: ps.append((sub, gb, z))
    for n, (sub, gb, z) in enumerate(ps):
        feat(fid if len(ps) == 1 else f'{fid}-{n + 1}', 'wall', sub, z + dz0, z + dz1, f'{what}, 바닥 {z:.2f}', grade, gb, color=color, surfaceMark=True)
    return len(ps)
def band(line, d0, d1):
    """선의 왼쪽 d0~d1 m 띠(d < 0 은 오른쪽)."""
    a, b = line.offset_curve(d0, join_style=2), line.offset_curve(d1, join_style=2)
    return Polygon(list(a.coords) + list(b.coords)[::-1]).buffer(0)
class Axis:
    """걷는 축 a → b 위의 사각형: s 는 a 에서 축 방향(m), w 는 축 왼쪽(m)."""
    def __init__(self, a, b): self.a = np.array(a, float); self.u = unit(np.array(b, float) - self.a); self.n = np.array([-self.u[1], self.u[0]]); self.L = float(np.hypot(*(np.array(b) - self.a)))
    def P(self, s, w=0.0): q = self.a + self.u * s + self.n * w; return (float(q[0]), float(q[1]))
    def R(self, s0, s1, w0, w1): return Polygon([self.P(s0, w0), self.P(s1, w0), self.P(s1, w1), self.P(s0, w1)])
MODEL = {}

# ===================== F8 서경로 캠퍼스 쪽 보도·경계석 =====================
G8 = '확정(정문 → 회전교차로 캠퍼스 쪽 보도·경계석이 끊김 없음: 사용자 사진 04, 거리뷰 36·37·38, S-MAP 정사), 추정(폭: 모델 벽까지, 선 ±1 m)'
S8 = SRC + '(③④⑤, 그림 01·02, S-MAP 정사 10)'
# 길 쪽 가장자리(경계석 안쪽 선), 남 → 북. 557199 북쪽은 판독의 S-MAP 벽 발치 선(③④⑤)에서 2.0 m 남서(판독 "보도는 그 1~2 m 남서", 정사의 회색 띠),
# 그 남쪽은 정사의 차도 동쪽 가장자리(196335d9 선 동쪽). 벽 발치 선과 모델 벽 사이(정사에서 화단 띠·나무)도 포장으로 둔다(화단 띠는 넣지 않음, 추정).
FOOT = LineString([(201064.0, 557199.0), (201052.0, 557212.5), (201040.0, 557220.5), (201028.0, 557228.5), (201016.0, 557236.5), (201008.0, 557244.5)])
CURB = LineString([(201074.9, 557169.2), (201072.6, 557179.0), (201069.6, 557188.5)] + list(FOOT.offset_curve(2.0, join_style=2).coords) + [(201003.2, 557247.9)])
TALL = []   # 보도 안쪽을 막는 것: 공도에서 1 m 넘게 솟은 벽 상자와 기단
for i, ft in OTHERS.items():
    p = ft['properties']; g = shape(ft['geometry']).buffer(0) if ft.get('geometry') else None
    if g is None or g.is_empty or not g.intersects(CURB.buffer(9)): continue
    c = g.representative_point()
    if p.get('kind') == 'platform' and i not in STREETS and p.get('material') != 'asphalt':
        if top_fn(p)(c.x, c.y) > street(c.x, c.y)[1] + 1.0: TALL.append(g)
    elif p.get('kind') == 'extrude' and p.get('type') in ('wall', 'planter') and p.get('fromM', 999) < street(c.x, c.y)[1] + 1.0 and p.get('toM', 0) > street(c.x, c.y)[1] + 1.0 \
            and not str(i).startswith(('W01-GATE-', 'W01-WEST-', 'P02-DORM', 'Z12-', 'R5-')):
        TALL.append(g)
TALL = unary_union(TALL).buffer(0)
OLDWALK = unary_union([shape(ft['geometry']).buffer(0) for i, ft in OTHERS.items() if str(i).startswith(('W01-GATE-SIDEWALK-', 'W01-GATE-KERB-', 'W01-WEST-SIDEWALK-', 'W01-WEST-KERB-', 'W01-WEST-TACTILE-'))]).buffer(0)
INNER = band(CURB, -9.0, 0.0); side = -1   # 벽 쪽 = 남 → 북 선의 오른쪽(북동)
WALK = INNER.difference(TALL.buffer(0.02)).difference(OLDWALK)
WALK = unary_union([q for q in (WALK.geoms if WALK.geom_type == 'MultiPolygon' else [WALK]) if q.intersects(CURB.buffer(0.05))]).buffer(0)
KERB = band(CURB, -side * 0.2, 0.0).difference(OLDWALK).difference(TALL)
STREET_ALL = unary_union([g for i, g, _ in PLATS if i in STREETS]).buffer(0)
WALK = WALK.intersection(STREET_ALL.buffer(0.3)); KERB = KERB.intersection(STREET_ALL.buffer(0.3))
def slab(fid, g, lift, thick, what, color, grade, src, **extra):
    """공도 위 기운 판: 조각마다 공도 윗면 + lift 의 평평한 판(조각 2.5 m 라 기울기 차는 3 cm 안)."""
    n = 0; L = CURB
    for q in (g.geoms if g.geom_type == 'MultiPolygon' else [g]):
        if q.geom_type != 'Polygon' or q.area < 0.05: continue
        s_all = [L.project(Point(c)) for c in q.exterior.coords]; a, b = min(s_all), max(s_all)
        for j in range(int(math.floor(a / 2.5)), int(math.ceil(b / 2.5))):   # 조각: 경계석 선을 2.5 m 마디로 나눈 수직 띠
            p0, p1 = L.interpolate(j * 2.5), L.interpolate((j + 1) * 2.5)
            if p0.equals(p1): continue
            u = unit(np.array(p1.coords[0]) - np.array(p0.coords[0])); nn = np.array([-u[1], u[0]])
            stripe = Polygon([tuple(np.array(p0.coords[0]) - u * 0.01 - nn * 12), tuple(np.array(p1.coords[0]) + u * 0.01 - nn * 12),
                              tuple(np.array(p1.coords[0]) + u * 0.01 + nn * 12), tuple(np.array(p0.coords[0]) - u * 0.01 + nn * 12)])
            part = q.intersection(stripe)
            for sub in (part.geoms if part.geom_type in ('MultiPolygon', 'GeometryCollection') else [part]):
                if sub.geom_type != 'Polygon' or sub.area < 0.05: continue
                c = sub.representative_point(); gb, z = street(c.x, c.y); n += 1
                feat(f'{fid}-{n:03d}', 'landing' if 'SIDEWALK' in fid else 'wall', sub, z + lift - thick, z + lift, what, grade, gb, color=color, source=src, **extra)
    return n
n_walk = slab('R6-SEOGYEONG-SIDEWALK', WALK, 0.15, 0.3, '서경로 캠퍼스 쪽(유담관 벽 아래) 회색 블록 보도: 차도 + 0.15 m, 벽 발치까지 포장으로 둠(벽 발치 화단 띠·나무는 넣지 않음)', '#a9a59c', G8, S8, material='paving')
n_kerb = slab('R6-SEOGYEONG-KERB', KERB, 0.16, 0.3, '화강석 경계석 줄', '#d2cfc6', G8, S8)
wd = [r2(TALL.distance(Point(CURB.coords[k]))) for k in range(len(CURB.coords))]
MODEL['sidewalk'] = {'pieces': n_walk, 'kerbPieces': n_kerb, 'areaM2': r2(WALK.area), 'curbToModelWallM': wd}
REPORT.append(f'F8 보도 {WALK.area:.0f} ㎡ 조각 {n_walk}, 경계석 조각 {n_kerb}, 경계석 선에서 모델 벽까지 {wd} m')
WALKKERB = unary_union([WALK, KERB]).buffer(0)

# ---- 얼룩말(F8 공연실습소 동쪽 끝, F7 회전교차로 동쪽) ----
def zebra(fid, a, b, width, what, grade):
    ax = Axis(a, b); n = 0; s = 0.3
    while s + 0.45 <= ax.L - 0.2:
        n += paint_on(f'{fid}-{int(round(s / 0.9)) + 1:02d}', ax.R(s, s + 0.45, -width / 2, width / 2), 0.0, 0.03, what, grade, '#f2f2ee', exclude=WALKKERB)
        s += 0.9
    return ax
G8Z = '확정(칠: S-MAP 정사 10, 거리뷰 37 시점 앞 남동), 추정(띠 수·폭 ±0.5 m)'
ZE = zebra('R6-SEOGYEONG-CROSSWALK', (201055.8, 557195.0), (201063.3, 557199.2), 3.5, '서경로 횡단보도(공연실습소 동쪽 끝) 흰 띠', G8Z)
G7 = '확정(칠: S-MAP 정사 10 두 번 맞춤 같음, 사용자 사진 04·외국인생활관의 앞 얼룩말·말뚝), 추정(띠 수, 자리 ±1 m)'
ZD = zebra('R6-DORM-CROSSWALK', (201005.5, 557231.0), (201011.5, 557237.0), 3.5, '회전교차로 동쪽 횡단보도(생활관 문 앞 → 유담관 남서 모서리 보도) 흰 띠', G7)
HB = Axis((201013.09, 557227.39), (201016.91, 557231.21))   # 빗금 띠: 얼룩말과 나란한 띠(축 길이 = 차도 폭 쪽)
NH = 6
for k in range(NH):
    s0 = HB.L * k / NH
    paint_on(f'R6-DORM-HATCH-{k + 1}', HB.R(s0, s0 + HB.L / NH, -1.0, 1.0), 0.0, 0.03, f'회전교차로 동쪽 노랑·흰 빗금 띠 {k + 1}/{NH}(고원식 횡단인지 과속방지턱인지 모름: 칠만, 턱 없음)',
             '확정(띠: S-MAP 정사 10), 추정(용도·마디 수)', '#f2c230' if k % 2 == 0 else '#f2f2ee', exclude=WALKKERB)
REPORT.append(f'F7 옛 얼룩말 {len(DROP)}개 걷음, 새 얼룩말 축 {ZD.L:.1f} m, F8 얼룩말 축 {ZE.L:.1f} m')

# ===================== F9 서문 위 단, F3 철 계단 =====================
MASS_F = OTHERS['W01-WESTGATE-MASS']; MASS = shape(MASS_F['geometry']).buffer(0)
G9 = '차 확정(S-MAP 지면 126.2~127.5, 모델 문 위 덩어리 125.11), 추정(단 외곽·한 높이 126.8)'
G3 = '있음 확정(거리뷰 색인 34·W01 노트 "왼쪽 날개벽 뒤 언덕을 오르는 철 계단", 네이버 길 선이 같은 자리에서 서문 쪽으로 갈라져 내려옴, S-MAP 산책로 점선), 추정(자리·폭·단 수·되돌림 없음)'
ZTOP = 126.8
E0, E1 = np.array([200963.6, 557408.7]), np.array([200959.2, 557422.8])   # 왼쪽 날개벽(MASS 서쪽 변)
SA = Axis(E0, E1)                       # w > 0 = 오른쪽? Axis.n 은 왼쪽(서쪽). 안쪽(동쪽)은 w < 0
W_IN = (-1.5, -0.3)                     # 날개벽 안쪽 0.3~1.5 m
S_FOOT, S_TOP = -1.4, 14.2             # 계단 발치(문 앞 공도) ~ 위 끝(문 위 단)
foot = SA.P(S_FOOT, -0.9); gfoot, zfoot = street(*foot)
NR = int(round((ZTOP - zfoot) / 0.175)); RISE = (ZTOP - zfoot) / NR; RUN = (S_TOP - S_FOOT) / NR
STAIR = SA.R(S_FOOT, S_TOP + 0.3, *W_IN)
TOPZONE = MASS.intersection(box(200955, 557414.0, 200985.0, 557428))        # 문 칸·정면(557404.9~557411.4) 뒤
TOPZONE = TOPZONE.difference(STAIR.buffer(0.02))
feat('R6-PLATFORM-WESTGATE-TOP', 'platform', TOPZONE, 116.5, ZTOP, '서문 위 단(문 칸 뒤 소나무 비탈의 평평한 단, 126.8 한 높이. 동쪽은 GATE-BANK 126.65~ 로 이어짐)', G9,
     '', kind='platform', topM=ZTOP, bottomM=116.5, bottomNote='문 앞 공도·문 위 덩어리 밑(틈이 없게)', material='planting', surfaceName='R6-WESTGATE-TOP')
del NEW[-1]['properties']['fromM'], NEW[-1]['properties']['toM']
STEEL = '#5d6166'
for k in range(1, NR):
    s0 = S_FOOT + RUN * (k - 1)
    feat(f'R6-WESTGATE-STEELSTAIR-S{k:02d}', 'stair_step', SA.R(s0, s0 + RUN, W_IN[0] + 0.1, W_IN[1] - 0.1), zfoot - 0.3, zfoot + RISE * k,
         f'서문 왼쪽 날개벽 뒤 철 계단 {k}/{NR} 단(문 앞 공도 {zfoot:.2f} → 문 위 단 {ZTOP})', G3, gfoot, color=STEEL, stair='R6-WESTGATE-STEELSTAIR', riseM=round(RISE, 3), runM=round(RUN, 3), widthM=1.0)
feat('R6-WESTGATE-STEELSTAIR-TOP', 'landing', SA.R(S_FOOT + RUN * (NR - 1), S_TOP + 0.3, W_IN[0] + 0.1, W_IN[1] - 0.1), zfoot - 0.3, ZTOP, '철 계단 위 끝 참(문 위 단 높이)', G3, 'R6-PLATFORM-WESTGATE-TOP', color=STEEL)
for j, w in enumerate((W_IN[0] + 0.05, W_IN[1] - 0.05)):   # 난간: 양옆 가는 벽(손잡이 높이 1.0 m, 계단 기울기 따라 마디마다)
    for k in range(0, NR, 6):
        s0, s1 = S_FOOT + RUN * k, min(S_FOOT + RUN * (k + 6), S_TOP + 0.3); zt = zfoot + RISE * min(k + 6, NR)
        feat(f'R6-WESTGATE-STEELSTAIR-RAIL-{"WE"[j]}{k // 6 + 1:02d}', 'wall', SA.R(s0, s1, w - 0.05, w + 0.05), zfoot + RISE * k, zt + 1.0, '철 계단 난간(가는 철 막대를 벽 판으로 줄임)', G3, gfoot, material='rail')
mass_new = MASS.difference(STAIR.buffer(0.01))
MASS_F['geometry'] = geom(mass_new)
MASS_F['properties']['assumption'] = MASS_F['properties'].get('assumption', '').split(' [R6')[0] + f' [R6 2026-10-25: 왼쪽 날개벽 안쪽 철 계단 자리(폭 1.2 m)를 뺌. 문 칸 뒤 557414 북쪽은 R6-PLATFORM-WESTGATE-TOP {ZTOP} 이 덮음]'
OTHERS['W01-WESTGATE-MASS'] = MASS_F
STAIR_DB = [SA.P(S_FOOT - 0.6, -0.9), SA.P(S_FOOT, -0.9), SA.P(S_TOP, -0.9), SA.P(S_TOP + 1.2, -2.4)]
MODEL['westgate'] = {'zfoot': r2(zfoot), 'footPlatform': gfoot, 'steps': NR, 'riseM': round(RISE, 3), 'runM': round(RUN, 3), 'ztop': ZTOP,
                     'stairLine': [[r2(x), r2(y)] for x, y in STAIR_DB], 'massAreaM2': [r2(MASS.area), r2(mass_new.area)], 'topAreaM2': r2(TOPZONE.area)}
REPORT.append(f'F3 철 계단 발치 {gfoot} {zfoot:.2f} → {ZTOP}, {NR} 단 x {RISE:.3f} m, 디딤 {RUN:.3f} m, 길이 {S_TOP - S_FOOT:.1f} m; F9 문 위 단 {TOPZONE.area:.0f} ㎡, MASS {MASS.area:.0f} → {mass_new.area:.0f} ㎡')

# ===================== F10 상승관·청운관 뒤 단, F11 청운관 동쪽 흙길 =====================
G10 = 'S-MAP(지면 148.0~149.1, 모델 BANK-E 는 그 자리 150.0~151.4), 추정(외곽: 판독 안, 한 경사면으로 줄임)'
SG = Polygon([(201196, 557327), (201220, 557315), (201246, 557304), (201250, 557318), (201222, 557334), (201200, 557342)])
UD = unit((50.0, -23.0))
TP10 = {'origin': [201196.0, 557327.0], 'direction': [round(float(UD[0]), 4), round(float(UD[1]), 4)], 'points': [[0.0, 148.0], [55.0, 149.0]]}
feat('R6-PLATFORM-BEHIND-SANGSEUNG', 'platform', SG, 139.8, 149.0, '상승관·청운관 뒤 단(뒤 산책로가 지나는 곳, 148.0 → 149.0 서→동). BANK-E(숲 비탈)는 이 바깥부터', G10, '',
     kind='platform', topProfile=TP10, bottomM=139.8, bottomNote='BEHIND-DAEIL-E 의 bottomM 과 같음', material='paving', surfaceName='R6-BEHIND-SANGSEUNG')
del NEW[-1]['properties']['fromM'], NEW[-1]['properties']['toM']
TRAIL = LineString([(201233.0, 557320.0), (201250.0, 557314.0), (201265.0, 557312.0), (201280.0, 557306.0), (201287.0, 557300.0), (201289.0, 557292.0),
                    (201282.0, 557280.0), (201270.0, 557266.0), (201262.0, 557259.0), (201256.0, 557257.8)])
G11 = '확정(흙길 있음·폭 약 3 m: S-MAP 정사 12, 네이버 위성 사진 6), S-MAP(지면 148.9~149.4), 추정(한 경사면으로 줄임 ±0.3 m, 끝 선 ±3 m)'
TB = TRAIL.buffer(1.5, cap_style=2, join_style=2)
CG = shape(OTHERS['Z05-PLATFORM-CHEONGUN-CHEONGUN-GROUND']['geometry']).buffer(0)
TB = TB.difference(CG.buffer(-0.5))   # 청운관 둘레(149.6) 밑으로 0.5 m 들어감
TP11 = {'origin': [201270.0, 557318.0], 'direction': [0.0, -1.0], 'points': [[0.0, 148.9], [59.0, 149.4]]}
feat('R6-PLATFORM-CHEONGUN-EAST-TRAIL', 'platform', TB, 140.5, 149.4, '청운관 동쪽 흙길(뒤 산책로가 숲 사이로 혜인관 북동 어귀까지 내려오는 길, 폭 3 m, 148.9 → 149.4 북→남). 둘레는 숲 비탈(지형)',
     G11, '', kind='platform', topProfile=TP11, bottomM=140.5, bottomNote='청운관 둘레 기단 bottomM 과 같음', material='paving', surfaceName='R6-CHEONGUN-EAST-TRAIL')
del NEW[-1]['properties']['fromM'], NEW[-1]['properties']['toM']
# 흙길·청운관 둘레·뒤 단으로 둘러싸인 숲(약 920 ㎡): 기단으로 채운다. 비워 두면 캠퍼스 영역 + 기단 합집합에 구멍이 생기고
# 화면은 지형을 바깥 고리로만 잘라(terrain-clip) 그 안이 빈 곳으로 보인다. 높이는 흙길과 같은 면(숲 안 땅 높이는 모름, 추정)
from shapely.geometry import MultiPoint
BLD = unary_union([Polygon(b['ring']).buffer(0) for b in json.loads((REPO / 'docs/audit/z04/scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']])
WD = MultiPoint(list(TRAIL.coords)).convex_hull.difference(TB).difference(CG).difference(SG).difference(BLD.buffer(0.05))
WD = max((WD.geoms if hasattr(WD, 'geoms') else [WD]), key=lambda q: q.area)
feat('R6-PLATFORM-CHEONGUN-EAST-WOOD', 'platform', WD, 140.5, 149.4, '청운관 동쪽 흙길 고리 안 숲(흙길과 같은 면으로 둠. 숲 안 땅 높이는 모름)', '추정(높이·외곽: 흙길·청운관 둘레·뒤 단으로 둘러싸인 곳), 확정(나무 덮인 곳: S-MAP 정사 12)', '',
     kind='platform', topProfile=TP11, bottomM=140.5, bottomNote='청운관 둘레 기단 bottomM 과 같음', material='planting', surfaceName='R6-CHEONGUN-EAST-WOOD')
del NEW[-1]['properties']['fromM'], NEW[-1]['properties']['toM']
BK = IDX['Z05-PLATFORM-BACK-BANK-E'][1]; bk0 = shape(BK['geometry']).buffer(0); bk1 = bk0.difference(SG.buffer(-0.5)).difference(TB.buffer(-0.5))
BK['geometry'] = geom(bk1)
BK['properties']['assumption'] = BK['properties'].get('assumption', '').split(' [R6')[0] + ' [R6 2026-10-25: 상승관·청운관 뒤 단(R6-PLATFORM-BEHIND-SANGSEUNG) 자리를 뺌(0.5 m 는 새 단 밑으로 겹침)]'
OTHERS['Z05-PLATFORM-BACK-BANK-E'] = BK
REPORT.append(f'F10 단 {SG.area:.0f} ㎡, BANK-E {bk0.area:.0f} → {bk1.area:.0f} ㎡; F11 흙길 {TB.area:.0f} ㎡, 고리 안 숲 {WD.area:.0f} ㎡')
# 걸린 나무: BANK-E 를 바탕으로 둔 상자 가운데 새 단 안에 선 것은 새 단 윗면으로 내림
PLATS = plats() + [(f['properties']['id'], shape(f['geometry']).buffer(0), top_fn(f['properties'])) for f in NEW if f['properties']['kind'] == 'platform']
moved = []
for i, ft in list(OTHERS.items()):
    p = ft['properties']
    if p.get('basePlane') != 'Z05-PLATFORM-BACK-BANK-E' or p.get('kind') != 'extrude': continue
    c = shape(ft['geometry']).centroid
    for nid, g in (('R6-PLATFORM-BEHIND-SANGSEUNG', SG), ('R6-PLATFORM-CHEONGUN-EAST-TRAIL', TB)):
        if g.buffer(-0.5).contains(c): moved.append((i, nid))
assert sorted(i for i, _ in moved) == sorted(TREES), moved
bank_top = top_fn(BK['properties'])
for i, nid in moved:
    fn, ft = IDX[i]; p = ft['properties']; c = shape(ft['geometry']).centroid; t_new = ground(c.x, c.y, only=[nid])[1]; dz = t_new - bank_top(c.x, c.y)
    p['fromM'], p['toM'] = r2(p['fromM'] + dz), r2(p['toM'] + dz); p['basePlane'] = nid
    p['assumption'] = p.get('assumption', '').split(' [R6')[0] + f' [R6 2026-10-25: 바탕 BANK-E 가 이 자리에서 빠져 새 단 {nid} 윗면으로 {dz:+.2f} m 내림]'
    REPORT.append(f'나무 {i} {dz:+.2f} m')

# ===================== 길 변경 묶음이 읽는 점의 높이 =====================
def gz(x, y): return r2(ground(x, y)[1])
def sz(x, y): return r2(street(x, y)[1] + 0.15)
MODEL['heights'] = {
    'N1': [[x, y, sz(x, y)] for x, y in [(200999.0, 557290.0), (201000.9, 557275.0), (201002.8, 557260.0), (201004.4, 557248.2), (201008.0, 557243.0), (201011.5, 557237.3)]],
    'N4': [[x, y, sz(x, y)] for x, y in [(200995.2, 557320.0), (200993.2, 557335.0), (200991.3, 557350.0), (200989.4, 557364.4), (200987.3, 557379.3), (200983.6, 557393.9)]],
    'N3': [[x, y, sz(x, y)] for x, y in [(201052.0, 557211.0), (201044.0, 557215.5), (201036.0, 557221.5), (201028.0, 557227.0), (201020.0, 557231.5)]],
    'F4': {'ne': [201063.3, 557199.2, sz(201063.3, 557199.2)], 'sw': [201055.8, 557195.0, r2(street(201055.8, 557195.0)[1])]},
    'N5street': [[x, y, r2(street(x, y)[1])] for x, y in [(200979.0, 557404.5), (200969.5, 557405.5)] + [tuple(STAIR_DB[0])]],
    'N5stair': [[r2(STAIR_DB[1][0]), r2(STAIR_DB[1][1]), r2(zfoot)], [r2(STAIR_DB[2][0]), r2(STAIR_DB[2][1]), ZTOP]],
    'N5top': [[x, y, gz(x, y)] for x, y in [STAIR_DB[3], (200972.0, 557421.0), (200983.0, 557418.0), (200991.5, 557421.2), (200999.6, 557423.6), (201008.3, 557423.6), (201016.9, 557423.6)]],
    'N6': [[x, y, gz(x, y)] for x, y in [(201200.0, 557338.0), (201212.0, 557335.0), (201222.0, 557331.0), (201235.0, 557318.0), (201250.0, 557314.0), (201265.0, 557312.0),
                                         (201280.0, 557306.0), (201287.0, 557300.0), (201289.0, 557292.0), (201282.0, 557280.0), (201270.0, 557266.0), (201262.0, 557259.0)]],
}
for k, v in MODEL['heights'].items(): REPORT.append(f'높이 {k}: {v}')

# ===================== 겹침 검사(새 상자 대 다른 상자) =====================
def solid(ft):
    p = ft['properties']
    if p.get('kind') in ('platform',) or p.get('surfaceMark') or p.get('type') in ('tree', 'surface', 'curb') or not ft.get('geometry') or p.get('fromM') is None: return None
    try: return shape(ft['geometry']).buffer(0), p['fromM'], p['toM'], p.get('kind') == 'void'
    except Exception: return None
SOL = {i: s for i, ft in OTHERS.items() if (s := solid(ft))}
for ft in NEW:
    s = solid(ft)
    if not s: continue
    i = ft['properties']['id']; g, lo, hi, vi = s
    for j, (h, lo2, hi2, vj) in SOL.items():
        if vi != vj or hi2 <= lo + 0.005 or lo2 >= hi - 0.005 or j == 'W01-WESTGATE-MASS' and 'STEELSTAIR' in i and g.intersection(h).area < 0.05: continue
        a = g.intersection(h).area
        if a > 0.05: REPORT.append(f'겹침 {i} × {j} {a:.2f} ㎡ ({lo}~{hi} / {lo2}~{hi2})')

# ===================== 쓰기 =====================
for fn in FILES:
    D[fn]['features'] = [f for f in D[fn]['features'] if f['properties']['id'] not in DROP]
    dump(STR / fn, D[fn])
dump(STR / OUT, {'type': 'FeatureCollection', 'name': 'r6-back', 'crs': CRS, 'provenance': {'builder': 'docs/audit/r6/build_parts.py', 'basePlanes': 'backend/data/terrain/recipes/z05-surface.geojson',
     'schema': 'docs/audit/g02/STRUCTURES.md', 'note': 'R6 전수 판독: 서경로 캠퍼스 쪽 보도·얼룩말, 회전교차로 얼룩말, 서문 위 단·철 계단, 상승관·청운관 뒤 단, 청운관 동쪽 흙길. 치수 대부분 추정.'}, 'features': NEW})
# 지형 입력: 새 기단 셋(겹치지 않는 외곽: 더 높은 이웃 기단의 지형 입력을 뺌), BANK-E 외곽
def surf_poly(name): return shape(SIDX[name]['geometry']).buffer(0)
SIDX['Z05-BACK-BANK-E']['geometry'] = geom(surf_poly('Z05-BACK-BANK-E').difference(SG).difference(TB))
news = {'R6-WESTGATE-TOP': (TOPZONE.difference(surf_poly('Z05-WEST-GATE-BANK')), {'heightM': ZTOP}, '서문 위 단', G9),
        'R6-BEHIND-SANGSEUNG': (SG, {'profile': TP10}, '상승관·청운관 뒤 단', G10),
        'R6-CHEONGUN-EAST-TRAIL': (TB.difference(surf_poly('Z05-CHEONGUN-CHEONGUN-GROUND')).difference(SG), {'profile': TP11}, '청운관 동쪽 흙길', G11),
        'R6-CHEONGUN-EAST-WOOD': (WD.difference(surf_poly('Z05-CHEONGUN-CHEONGUN-GROUND')), {'profile': TP11}, '청운관 동쪽 흙길 고리 안 숲', '추정')}
for nm, (g, h, what, grade) in news.items():
    SURF['features'].append({'type': 'Feature', 'properties': {'name': nm, 'srid': 5186, 'reason': 'R6 ' + what, 'grade': grade, 'source': SRC, **h}, 'geometry': geom(g)})
lowz = lambda f: f['properties'].get('heightM', min([p[1] for p in f['properties'].get('profile', {}).get('points', [[0, 0]])]))
SURF['features'] = sorted(SURF['features'], key=lowz); dump(REC / 'z05-surface.geojson', SURF)
dump(HERE / 'model.json', MODEL)
print('\n'.join(REPORT)); print(f'{OUT}: {len(NEW)}', '(dry)' if DRY else '')
