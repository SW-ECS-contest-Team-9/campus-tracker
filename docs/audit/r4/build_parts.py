"""R4(2026-10-25): 운동장 칠·가장자리, 대일관 뒷문 상자를 전수 판독 R4 대로 고친다. DB·네트워크 접근 없음.
  python -X utf8 build_parts.py          # 고쳐 씀
  python -X utf8 build_parts.py --dry    # 쓰지 않고 수치만
근거: 볼트 데이터/보완자료/학교-전경-20261022/전수판독/R4/판독.md(보완 목록 D1~D11, 그림 01·02·05·20, S-MAP 정사 10),
  동 노트 대일관·청운관·상승관, 구역 노트 대일관 정면과 운동장 북쪽 가장자리, 지표면 노트의 "2026-10-25 R4 전수 판독 반영" 절.
옛 생성 스크립트(p01/p02 parts)는 뒤 작업이 같은 파일을 id 로 고쳐 다시 돌릴 수 없다. 그래서 r1~r3 처럼 id 로 고친다.
처음 실행 때 고치는 지물의 원본을 base.json 에 남기고, 다음 실행은 원본에서 다시 시작한다(몇 번 돌려도 같다. r3/build_parts.py 다음에 돌린다).

D3 글자 SEOKYEONG UNIVERSITY: 글자 가운데 줄 Y(P02-FIELD-TEXT-20-Y 중심) → S(P02-FIELD-TEXT-01-S 중심)를
    Y (201164.4, 557251.3) → S (201208.8, 557212.5) 로. 방향 그대로, 길이·글자 크기 같은 비(약 1.23 배, 크기 추정).
D4 큰 주황 네모 둘(P02-FIELD-SQUARE-1·2): 6.0 x 13.9 m 직사각, 긴 축 방위 131.3°, 중심 (201172.1, 557231.2)·(201189.5, 557215.5)(둘째 추정).
D5 농구: 골대 기둥 셋(A (201151.9, 557229.0)·B (201171.2, 557211.9) 확정, C (201189.7, 557194.5) 추정), 기둥마다 앞뒤(방위 131.3° 축)로
    노랑 골대 칸 4.4 x 5.2 m(기둥에서 1.15~6.35 m), 3점 호(골대 점 = 기둥에서 1.2 m, 반지름 6.7 m), 가운데 원(반지름 1.8 m, AB·BC 사이),
    기둥 + 판 둘(테 높이 3.05 m = 151.95, 추정). 판독 표의 A (201154.2, 557226.2)는 A 기둥 남동쪽 칸의 중심이다(정사: 기둥마다 칸 둘이 등을 맞댐).
    코트 테(옆줄)는 폭을 정사에서 못 정해 그리지 않는다.
D6 줄무늬(P02-FIELD-STRIPE-*): 옹벽 앞면(D23 파랑 3) 에서 운동장 쪽 4.0 m 안을 뗀다(파랑 3 따라 s −25 ~ 41 m, 그 동쪽 청운관 앞은 그대로).
D10 운동장 바탕(P02-FIELD-BASE): 북쪽 가장자리 포장 = 운동장 바탕과 같은 회색(확정) → 바탕과 옹벽 사이에 보이던 기단(Z02-PLATFORM-APRON) 조각을 바탕에 합친다.
D8 게시판 틀 둘: 앞 화단 위, SKON SQUARE 글자 바로 뒤(글자 폭을 반씩), 흰 기둥 + 현수막 판(높이 추정).
D9 주차 번호 줄: (201216, 557282) → (201246, 557256), 2.5 m 칸마다 흰 번호 칸(숫자는 네모로 줄임, 0.7 x 0.9 m), 그 자리 바닥 높이 위.
D2 대일관 뒷문 상자: 뒷벽 오목한 자리 서쪽 끝, 꺾인 벽 (201171.77, 557326.43) 에서 벽을 따라 0~6.5 m, 벽에서 북으로 0~4.0 m
    (정사 상자 북면 = 벽에서 3.9~4.3 m), 바닥 152.0, 지붕 155.5(추정), 문은 북면 가운데(폭 1.8 m).
고치는 파일(frontend/public/structures): p02-parts, r4-field(새)."""
import json, pathlib, copy, sys, math
import numpy as np
from shapely.geometry import Polygon, LineString, Point, shape, box
from shapely.ops import unary_union

DRY = '--dry' in sys.argv
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
STR = REPO / 'frontend' / 'public' / 'structures'
BASEF = HERE / 'base.json'
r2 = lambda v: round(float(v), 2)
OUT = 'r4-field.geojson'
SRC = '판독 보완자료/학교-전경-20261022/전수판독/R4/판독.md(S-MAP 정사 10, 사진 10·대일관 정면 낮·청운관 정면, 카카오 항공, S-MAP 비스듬, 사용자 그림 13)'

FILES = ['p02-parts.geojson']
D = {fn: json.loads((STR / fn).read_text(encoding='utf-8')) for fn in FILES}
def dump(path, obj):
    if not DRY: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
BASE = json.loads(BASEF.read_text(encoding='utf-8')) if BASEF.exists() else None
if BASE:   # 다시 돌릴 때: 원본으로 되돌림
    for fn in FILES:
        orig = BASE['features'].get(fn, {})
        D[fn]['features'] = [copy.deepcopy(orig[f['properties']['id']]) if f['properties']['id'] in orig else f
                             for f in D[fn]['features'] if not f['properties']['id'].startswith('R4-')]
IDX = {f['properties']['id']: (fn, f) for fn in FILES for f in D[fn]['features']}
def F(i): return IDX[i][1]
TEXT = sorted(i for i in IDX if i.startswith('P02-FIELD-TEXT-'))
STRIPES = sorted(i for i in IDX if i.startswith('P02-FIELD-STRIPE-'))
TOUCH = ['P02-FIELD-BASE', 'P02-FIELD-SQUARE-1', 'P02-FIELD-SQUARE-2'] + TEXT + STRIPES
if not BASE and not DRY:
    BASE = {'features': {}}
    for i in TOUCH: fn, f = IDX[i]; BASE['features'].setdefault(fn, {})[i] = copy.deepcopy(f)
    dump(BASEF, BASE)

OTHERS = {}
for fp in sorted(STR.glob('*.geojson')):
    if fp.name in FILES or fp.name == OUT or fp.name.startswith('a2-'): continue
    for ft in json.loads(fp.read_text(encoding='utf-8'))['features']: OTHERS[ft['properties'].get('id')] = ft
def O(i): return shape(OTHERS[i]['geometry']).buffer(0)

def ring1(coords, ccw):
    p = []
    for x, y in list(coords)[:-1]:
        q = [r2(x), r2(y)]
        if not p or q != p[-1]: p.append(q)
    if p[0] == p[-1]: p.pop()
    if Polygon(p).exterior.is_ccw is not ccw: p = p[::-1]
    return p + [p[0]]
def ring(poly):   # 바깥 고리(반시계) + 구멍(시계: 가운데 원 같은 고리 칠)
    return [ring1(poly.exterior.coords, True)] + [ring1(i.coords, False) for i in poly.interiors if Polygon(i).area > 0.01]
def geom(g):
    g = g.buffer(0)
    if g.geom_type in ('MultiPolygon', 'GeometryCollection'):
        parts = [q for q in g.geoms if q.geom_type == 'Polygon' and q.area > 0.01]
        if len(parts) == 1: g = parts[0]
        else: return {'type': 'MultiPolygon', 'coordinates': [ring(q) for q in parts]}
    assert g.geom_type == 'Polygon' and g.area > 0.0005, g
    return {'type': 'Polygon', 'coordinates': ring(g)}
def note(f, what):
    p = f['properties']; p['assumption'] = p.get('assumption', '').split(' [R4')[0] + f' [R4 2026-10-25: {what}]'
def center(g): b = g.bounds; return np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])
REPORT = []
NEW = []
def feat(fid, typ, g, z0, z1, what, grade, base, **extra):
    assert z1 > z0, fid
    NEW.append({'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': grade, 'basePlane': base,
                'fromM': r2(z0) if z0 < 150 else round(float(z0), 3), 'toM': round(float(z1), 3), 'assumption': 'R4: ' + what, 'source': SRC, **extra}, 'geometry': geom(g)})
def paint(fid, g, z0, z1, color, what, grade):
    feat(fid, 'wall', g, z0, z1, what, grade, 'Z02-PLATFORM-FIELD(운동장 148.9)', color=color, surfaceMark=True)

def axis_rect(c, bearing, along, across):
    """중심 c, 긴 축 방위(북에서 시계) bearing, 축 따라 along, 가로 across 인 직사각."""
    e = np.array([math.sin(math.radians(bearing)), math.cos(math.radians(bearing))]); n = np.array([-e[1], e[0]])
    c = np.asarray(c, float)
    return Polygon([tuple(c + e * a + n * b) for a, b in ((-along / 2, -across / 2), (along / 2, -across / 2), (along / 2, across / 2), (-along / 2, across / 2))])

# ===================== D3 글자 =====================
Y0, S0 = center(shape(F('P02-FIELD-TEXT-20-Y')['geometry'])), center(shape(F('P02-FIELD-TEXT-01-S')['geometry']))
Y1, S1 = np.array([201164.4, 557251.3]), np.array([201208.8, 557212.5])
K = np.hypot(*(S1 - Y1)) / np.hypot(*(S0 - Y0))
M0, M1 = (Y0 + S0) / 2, (Y1 + S1) / 2
ang0 = math.degrees(math.atan2(*(S0 - Y0))); ang1 = math.degrees(math.atan2(*(S1 - Y1)))
def mv_text(c):   # 글자는 모양 그대로(점·구멍 그대로) 좌표만 옮긴다(r2 와 같음: buffer 하면 가는 획이 뭉개진다)
    if isinstance(c[0], (int, float)): q = M1 + (np.array(c[:2]) - M0) * K; return [round(float(q[0]), 3), round(float(q[1]), 3)]
    return [mv_text(x) for x in c]
for i in TEXT:
    f = F(i); f['geometry'] = {'type': f['geometry']['type'], 'coordinates': mv_text(f['geometry']['coordinates'])}
    note(f, f'글자 줄을 S-MAP 정사 자리로(Y {Y1.tolist()} → S {S1.tolist()}, 59 m). 약 10 m 북동, {K:.3f} 배(글자 크기 같은 비, 추정)')
REPORT.append(f'D3 글자: 옛 Y {Y0.round(2).tolist()} S {S0.round(2).tolist()} 길이 {np.hypot(*(S0 - Y0)):.2f} 방위 {ang0:.2f} → 새 길이 {np.hypot(*(S1 - Y1)):.2f} 방위 {ang1:.2f}, 배율 {K:.4f}, 옮김 {(M1 - M0).round(2).tolist()}')

# ===================== D4 큰 주황 네모 =====================
for i, c, g_ in (('P02-FIELD-SQUARE-1', (201172.1, 557231.2), '확정'), ('P02-FIELD-SQUARE-2', (201189.5, 557215.5), '추정(그늘에 일부 가림)')):
    f = F(i); old = center(shape(f['geometry'])); f['geometry'] = geom(axis_rect(c, 131.3, 13.9, 6.0))
    note(f, f'S-MAP 정사 색 나눔: 6.0 x 13.9 m 직사각, 긴 축 131.3°, 중심 {list(c)}({g_})')
    REPORT.append(f'D4 {i}: 중심 {old.round(1).tolist()} → {list(c)} ({np.hypot(*(np.array(c) - old)):.1f} m)')

# ===================== D6 줄무늬 끝 =====================
PA, PB = np.array([201163.78, 557302.79]), np.array([201200.00, 557287.45])   # D23 파랑 3 = 옹벽 앞면
WE = (PB - PA) / np.hypot(*(PB - PA)); WN = np.array([WE[1], -WE[0]])             # WN: 운동장 쪽 +
def wp(s, t): q = PA + WE * s + WN * t; return float(q[0]), float(q[1])
CUT = Polygon([wp(-25, -30), wp(41, -30), wp(41, 4.0), wp(-25, 4.0)])
cut_area = 0.0
for i in STRIPES:
    f = F(i); g = shape(f['geometry']).buffer(0); h = g.difference(CUT)
    if h.area < g.area - 0.01:
        cut_area += g.area - h.area
        if h.area < 0.05: f['properties']['_drop'] = True; REPORT.append(f'D6 {i}: 다 뗌'); continue
        f['geometry'] = geom(h); note(f, '옹벽 앞면(D23 파랑 3)에서 운동장 쪽 4.0 m 안을 뗌(그 사이는 민 회색: 정사·사진 10·카카오)')
REPORT.append(f'D6 줄무늬 뗀 넓이 {cut_area:.1f} ㎡')

# ===================== D10 운동장 바탕 =====================
f = F('P02-FIELD-BASE'); g0 = shape(f['geometry']).buffer(0)
apron = O('Z02-PLATFORM-APRON')
cover = []
for i, ft in OTHERS.items():
    p = ft['properties']
    if not ft.get('geometry'): continue
    if p.get('kind') == 'platform':
        if i != 'Z02-PLATFORM-APRON' and (p.get('topM') or 0) > 148.95: cover.append(shape(ft['geometry']).buffer(0))
    elif p.get('fromM') is not None and p['fromM'] <= 149.5 and p['toM'] >= 148.9 and p.get('type') not in ('tree',): cover.append(shape(ft['geometry']).buffer(0))
gap = apron.difference(g0).difference(unary_union(cover))
gap = unary_union([q for q in (gap.geoms if gap.geom_type == 'MultiPolygon' else [gap]) if q.area > 0.5])
g1 = unary_union([g0, gap.buffer(0.05).intersection(apron)])
f['geometry'] = geom(g1); note(f, f'북쪽 가장자리 포장 = 운동장 바탕과 같은 회색(확정: 사진 10·정면 낮·카카오·정사). 바탕과 옹벽 사이 기단 APRON 조각 {gap.area:.1f} ㎡ 를 합침')
REPORT.append(f'D10 바탕에 합친 APRON 조각 {gap.area:.1f} ㎡ (바탕 {g0.area:.1f} → {g1.area:.1f})')

# ===================== D5 농구 =====================
G_A = '확정(골대·칸 자리: S-MAP 정사, 사용자 그림 13), 추정(칸·호 크기, 골대 높이)'
G_C = '추정(그늘에 가림: 정사)'
BEAR = 131.3
E = np.array([math.sin(math.radians(BEAR)), math.cos(math.radians(BEAR))]); N_ = np.array([-E[1], E[0]])
STANDS = {'A': (np.array([201151.9, 557229.0]), G_A), 'B': (np.array([201171.2, 557211.9]), G_A), 'C': (np.array([201189.7, 557194.5]), G_C)}
ZF = 148.9
LW = 0.05   # 흰 줄 반폭(줄 폭 0.1 m)
def arc_line(h, sgn):
    """골대 점 h 에서 기둥 반대쪽(sgn·E)으로 반지름 6.7 m 반원 + 기둥 줄까지 곧은 다리."""
    pts = [tuple(h - E * sgn * 1.2 + N_ * 6.7)]
    for k in range(0, 37):
        a = math.radians(-90 + 5 * k)
        pts.append(tuple(h + E * sgn * 6.7 * math.cos(a) + N_ * 6.7 * -math.sin(a)))
    pts.append(tuple(h - E * sgn * 1.2 - N_ * 6.7))
    return LineString(pts)
for nm, (P, grade) in STANDS.items():
    for side, sgn in (('NW', -1), ('SE', 1)):
        kc = P + E * sgn * 3.75
        paint(f'R4-FIELD-COURT-{nm}-{side}-KEY', axis_rect(kc, BEAR, 5.2, 4.4), ZF + 0.04, ZF + 0.055, '#e2b44a',
              f'농구 골대 칸 {nm}{side}(노랑, 4.4 x 5.2 m, 기둥에서 1.15~6.35 m)', grade)
        h = P + E * sgn * 1.2
        paint(f'R4-FIELD-COURT-{nm}-{side}-ARC', arc_line(h, sgn).buffer(LW, cap_style=2), ZF + 0.055, ZF + 0.07, '#f2f2ee',
              f'농구 3점 호 {nm}{side}(반지름 6.7 m, 추정)', grade)
    feat(f'R4-FIELD-COURT-{nm}-POLE', 'wall', Point(*P).buffer(0.13, 8), ZF, ZF + 3.6, f'농구 골대 기둥 {nm}(앞뒤 판 둘, 정사 그림자)', grade,
         'Z02-PLATFORM-FIELD', color='#3c4046', material='metal')
    for side, sgn in (('NW', -1), ('SE', 1)):
        feat(f'R4-FIELD-COURT-{nm}-{side}-BOARD', 'wall', axis_rect(P + E * sgn * 0.95, BEAR, 0.06, 1.8), ZF + 2.9, ZF + 3.95,
             f'농구 판 {nm}{side}(1.8 x 1.05 m, 테 151.95 = 바닥 + 3.05, 추정)', grade, f'R4-FIELD-COURT-{nm}-POLE', color='#f2f2ee')
        feat(f'R4-FIELD-COURT-{nm}-{side}-ARM', 'wall', axis_rect(P + E * sgn * 0.5, BEAR, 0.85, 0.1), ZF + 3.3, ZF + 3.42,
             f'농구 판 팔 {nm}{side}', grade, f'R4-FIELD-COURT-{nm}-POLE', color='#3c4046', material='metal')
for a, b in (('A', 'B'), ('B', 'C')):
    m = (STANDS[a][0] + STANDS[b][0]) / 2
    paint(f'R4-FIELD-COURT-{a}{b}-CIRCLE', Point(*m).buffer(1.8 + LW, 32).difference(Point(*m).buffer(1.8 - LW, 32)), ZF + 0.055, ZF + 0.07, '#f2f2ee',
          f'농구 가운데 원 {a}{b}(반지름 1.8 m, 정사 BC 단면)', G_A if b == 'B' else G_C)
REPORT.append('D5 골대 사이 AB %.1f m, BC %.1f m' % (np.hypot(*(STANDS['B'][0] - STANDS['A'][0])), np.hypot(*(STANDS['C'][0] - STANDS['B'][0]))))

# ===================== D8 게시판 틀 둘 =====================
G_B = '확정(있음: 대일관 정면 낮 사진·S-MAP 정사), 추정(크기·높이)'
SK = unary_union([shape(ft['geometry']) for i, ft in OTHERS.items() if str(i).startswith('X22-SKON-')])
sk = [((np.array(c) - PA) @ WE) for c in SK.envelope.exterior.coords]
s0, s1 = min(sk), max(sk)
PL_TOP = 150.2
TB = -0.95   # 앞 화단 가운데(옹벽 앞면에서 건물 쪽 0.95 m, 글자 -0.35 m 뒤)
def wr(sa, sb, ta, tb): return Polygon([wp(sa, ta), wp(sb, ta), wp(sb, tb), wp(sa, tb)])
mid = (s0 + s1) / 2
for k, (sa, sb) in enumerate(((s0 - 0.2, mid - 0.1), (mid + 0.1, s1 + 0.2))):
    for j, sp in enumerate((sa, sb)):
        feat(f'R4-DAEIL-BOARD-{k + 1}-POST-{j + 1}', 'wall', wr(sp - 0.1, sp + 0.1, TB - 0.1, TB + 0.1), PL_TOP, PL_TOP + 3.4,
             f'게시판 틀 {k + 1} 흰 기둥(SKON SQUARE 글자 바로 뒤, 앞 화단 위)', G_B, 'X22-DAEIL-FRONT-PLANTER', color='#f4f4f2')
    feat(f'R4-DAEIL-BOARD-{k + 1}-PANEL', 'wall', wr(sa + 0.1, sb - 0.1, TB - 0.04, TB + 0.04), PL_TOP + 1.0, PL_TOP + 3.3,
         f'게시판 틀 {k + 1} 현수막 판(흰 테, 길이 {sb - sa:.1f} m)', G_B, f'R4-DAEIL-BOARD-{k + 1}-POST-1', color='#e9e7e0')
REPORT.append(f'D8 SKON 글자 s {s0:.2f}~{s1:.2f} (x {wp(s0, 0)[0]:.1f}~{wp(s1, 0)[0]:.1f}), 틀 둘 각 {(s1 - s0) / 2 + 0.1:.2f} m')

# ===================== D9 주차 번호 줄 =====================
G_N = '확정(있음: S-MAP 정사·청운관 정면 사진), 추정(칸 간격·크기, 숫자 모양은 네모로 줄임)'
NA, NB = np.array([201216.0, 557282.0]), np.array([201246.0, 557256.0])
LN = np.hypot(*(NB - NA)); NE_ = (NB - NA) / LN; NN = np.array([-NE_[1], NE_[0]])
SURF = []
for i, ft in OTHERS.items():
    p = ft['properties']
    if not ft.get('geometry'): continue
    if p.get('kind') == 'platform' and p.get('topM') is not None and not p.get('topPlane'): SURF.append((shape(ft['geometry']).buffer(0), p['topM']))
    elif p.get('fromM') is not None and p['toM'] <= 149.8 and p.get('type') not in ('tree',) and not p.get('surfaceMark'): SURF.append((shape(ft['geometry']).buffer(0), p['toM']))
SURF.append((shape(F('P02-FIELD-BASE')['geometry']).buffer(0), 148.94))
nk = int(LN // 2.5)
for k in range(nk + 1):
    c = NA + NE_ * (k * 2.5 + (LN - nk * 2.5) / 2)
    tops = [z for g, z in SURF if g.contains(Point(*c))]
    if not tops: continue
    z = max(tops)
    poly = Polygon([tuple(c + NE_ * a + NN * b) for a, b in ((-0.35, -0.45), (0.35, -0.45), (0.35, 0.45), (-0.35, 0.45))])
    feat(f'R4-FIELD-PARKNO-{k + 1:02d}', 'wall', poly, z + 0.02, z + 0.04, f'주차 번호 칸 {k + 1}(청운관 앞 북동 변 흰 숫자 줄, 바닥 {z:.2f})', G_N,
         '그 자리 바닥', color='#f2f2ee', surfaceMark=True)
REPORT.append(f'D9 번호 칸 {len([f for f in NEW if "PARKNO" in f["properties"]["id"]])}개, 줄 길이 {LN:.1f} m')

# ===================== D2 대일관 뒷문 상자 =====================
G_D = '확정(자리: S-MAP 정사 어두운 네모·S-MAP 비스듬 북면 밝은 문·사용자 그림 13 화살표), 추정(크기 ±0.5 m, 지붕 높이)'
BO = np.array([201171.77, 557326.43]); BE = np.array([201190.98, 557317.42]) - BO; BE = BE / np.hypot(*BE); BN = np.array([-BE[1], BE[0]])
def bq(u0, u1, n0, n1): return Polygon([tuple(BO + BE * u + BN * n) for u, n in ((u0, n0), (u1, n0), (u1, n1), (u0, n1))])
def bxy(u, n): q = BO + BE * u + BN * n; return [r2(q[0]), r2(q[1])]
WW = np.array([201173.51, 557330.86]) - BO; WW = WW / np.hypot(*WW)                  # 서쪽(본체 서쪽 덩어리) 벽 방향
BOX = Polygon([tuple(BO), tuple(BO + BE * 6.5), tuple(BO + BE * 6.5 + BN * 4.0), tuple(BO + WW * 4.0 / float(WW @ BN))])   # 서쪽 변은 벽을 따라
plats = [(i, shape(ft['geometry']).buffer(0), ft['properties'].get('topM')) for i, ft in OTHERS.items() if ft['properties'].get('kind') == 'platform']
under = [(i, round(BOX.intersection(g).area, 1), z) for i, g, z in plats if BOX.intersects(g) and BOX.intersection(g).area > 0.05]
def ptop(ft, x, y):
    p = ft['properties']
    if p.get('topM') is not None: return p['topM']
    tp = p['topProfile']; s = (x - tp['origin'][0]) * tp['direction'][0] + (y - tp['origin'][1]) * tp['direction'][1]
    (s0_, z0_), (s1_, z1_) = tp['points'][0], tp['points'][-1]; return z0_ + (z1_ - z0_) * min(1, max(0, (s - s0_) / (s1_ - s0_)))
lows = [ptop(OTHERS[i], *xy) for i, g, _ in plats for xy in BOX.exterior.coords if g.buffer(0.01).contains(Point(*xy)) and i in dict((u[0], 1) for u in under)]
Z0 = round(min([152.0] + lows) - 0.1, 2)   # 서쪽 띠(8 ㎡)는 뒤 비탈 기단(149.1) 위라 상자를 그 밑까지 내림
feat('R4-DAEIL-BACKDOOR-BOX', 'wall', BOX, Z0, 155.5, '대일관 뒷문(입구(3)) 상자: 뒷벽 오목한 자리 서쪽 끝 꺾인 벽에 붙음, 벽 따라 6.5 m · 북으로 4.0 m, 지붕 155.5(추정)',
     G_D, 'Z05-PLATFORM-BACK-DAEIL-BACKDOOR', color='#5e6268')
feat('R4-DAEIL-BACKDOOR-ROOF', 'wall', bq(-0.05, 6.55, 0, 4.05), 155.5, 155.65, '뒷문 상자 지붕 테(추정)', G_D, 'R4-DAEIL-BACKDOOR-BOX', color='#7c8086')
feat('R4-DAEIL-BACKDOOR-DOOR', 'wall', bq(2.35, 4.15, 4.0, 4.06), 152.0, 154.3, '뒷문 상자 북면 문(밝은 유리문, 폭 1.8 m: S-MAP 비스듬)', G_D,
     'R4-DAEIL-BACKDOOR-BOX', color='#dfe6ea', material='glass')
REPORT.append(f'D2 상자 아래 기단 {under}, 상자 밑 {Z0:.2f}; 꼭짓점 {bxy(0, 0)} {bxy(6.5, 0)} {bxy(6.5, 4.0)} {bxy(0, 4.0)}; 북면 가운데 {bxy(3.25, 4.0)}, 문 노드(북면 앞 0.5 m) {bxy(3.25, 4.5)}')
REPORT.append(f'D2 길 f5e89f52 새 꼭짓점: 상자 앞 {bxy(6.9, 5.1)} → {bxy(0.0, 5.1)}; 실내 문턱 노드 af836123 → {bxy(3.25, -0.8)}')

# ===================== 겹침 검사(새·고친 것 대 모든 상자) =====================
ALL = dict(OTHERS)
for fn in FILES:
    for ft in D[fn]['features']:
        if not ft['properties'].get('_drop'): ALL[ft['properties']['id']] = ft
for ft in NEW: ALL[ft['properties']['id']] = ft
def solid(ft):
    p = ft['properties']
    if p.get('kind') in ('platform',) or p.get('type') in ('tree', 'surface', 'curb') or not ft.get('geometry') or p.get('fromM') is None: return None
    return shape(ft['geometry']).buffer(0), p['fromM'], p['toM'], p.get('kind') == 'void'
SOL = {i: s for i, ft in ALL.items() if (s := solid(ft))}
CHECK = ['P02-FIELD-SQUARE-1', 'P02-FIELD-SQUARE-2'] + TEXT + [f['properties']['id'] for f in NEW]
seen = set()
for i in CHECK:
    if i not in SOL: continue
    g, lo, hi, vi = SOL[i]
    for j, (h, lo2, hi2, vj) in SOL.items():
        if j == i or (j, i) in seen or vi != vj: continue
        if i.startswith('R4-') and j.startswith('R4-'): continue
        if i.startswith('P02-FIELD-TEXT') and j.startswith('P02-FIELD-TEXT'): continue
        if hi2 > lo + 0.005 and lo2 < hi - 0.005:
            a = g.intersection(h).area
            if a > 0.05: REPORT.append(f'겹침 {i} × {j} {a:.2f} ㎡ ({lo}~{hi} / {lo2}~{hi2})'); seen.add((i, j))

for fn in FILES:
    D[fn]['features'] = [f for f in D[fn]['features'] if not f['properties'].pop('_drop', False)]
    dump(STR / fn, D[fn])
dump(STR / OUT, {'type': 'FeatureCollection', 'name': 'r4-field', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': NEW})
print('\n'.join(REPORT)); print(f'{OUT}: {len(NEW)}', '(dry)' if DRY else '')
