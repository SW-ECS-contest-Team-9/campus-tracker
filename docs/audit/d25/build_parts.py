"""D25(2026-10-25): 대일관 현관 일대를 사용자가 승인한 판독대로 고친다. DB·네트워크 접근 없음.   python -I build_parts.py
근거: 볼트 데이터/보완자료/학교-전경-20261022/대일관-현관-판독/판독.md(그림 20·21), 동 노트 대일관.md "2026-10-25 현관 일대 판독 반영".
  사용자 승인(2026-10-25) "다 좋은데 데크만 평행하게 하자, 건물이랑" + 추가 지시 둘(뒤 화단의 벤치 턱, 계단 양옆 화단 같은 크기).
두 축:
  판독 축 (u, v): (201152.6, 557312.3) 에서 (0.906, -0.424) 방향, v = 건물 쪽 +. 현관·계단·양옆 화단·지붕은 이 축.
  벽 축(Z02 축, z02/common.py): 대일관 남쪽 벽 선을 따라 u, v = 벽에서 운동장 쪽 +. 데크·난간·뒤 화단·벤치·앞 화단은 이 축(벽과 평행).
고치는 파일(id 로 찾아 고침, 몇 번 돌려도 같다. d23/build_parts.py 다음에 돌린다):
  frontend/public/structures/z02-daeil-front.geojson  현관 몸체·처마·지붕, 넓은 계단·볼, 양옆 화단, 참 기단, 데크 기단·데크·난간·앞 화단·끝 단·참
  frontend/public/structures/x22-photo-fixes.geojson  뒤 화단(셋), 벤치(셋), 나무 여섯, 운동장 가장자리 가로등 넷
  frontend/public/structures/x40-parts.geojson        현관 동면 기둥(X40) → 남쪽 기둥은 걷고 북쪽은 막힌 벽으로
  frontend/public/structures/z10-parts.geojson        옛 남면 아치 조각(Z10-DAEIL-PORCH-*)을 걷음(z10/build_parts.py 에서도 뺐다)
  frontend/public/structures/z06-trees.geojson        서쪽 화단 소나무(Z06-TREE-09)를 새 화단 가운데로, W2 의 소나무(Z06-TREE-10)는 걷음
높이 값(운동장 148.9, 참 151.3, 1층 151.8, 처마 155.2~155.8, 꼭대기 158.0, 데크 151.3)은 바꾸지 않는다."""
import json, pathlib, importlib.util
import numpy as np
from shapely.geometry import Polygon, box as sbox
from shapely import affinity

HERE = pathlib.Path(__file__).parent; AUDIT = HERE.parent; REPO = AUDIT.parents[1]
STR = REPO / 'frontend' / 'public' / 'structures'
sp = importlib.util.spec_from_file_location('z02common', AUDIT / 'z02' / 'common.py'); Z = importlib.util.module_from_spec(sp); sp.loader.exec_module(Z)
r2 = lambda v: round(float(v), 2)

# ---------- 축 ----------
PO = np.array([201152.6, 557312.3]); PU = np.array([0.906, -0.424]); PU = PU / np.hypot(*PU); PV = np.array([-PU[1], PU[0]])
def P(u, v): return PO + u * PU + v * PV                      # 판독 축 → EPSG:5186
def toP(xy): d = np.asarray(xy) - PO; return float(d @ PU), float(d @ PV)
def W(u, v): return np.array([float(c) for c in Z.uv_to_xy(u, v)])   # 벽 축 → EPSG:5186
def toW(xy): a, b = Z.xy_to_uv(*xy); return float(a), float(b)
def ring(pts):
    p = [[r2(x), r2(y)] for x, y in pts]
    if Polygon(p).exterior.is_ccw is False: p = p[::-1]
    return p + [p[0]]
def geom(poly):
    poly = poly.buffer(0); assert poly.geom_type == 'Polygon' and poly.area > 0.01, poly
    return {'type': 'Polygon', 'coordinates': [ring(list(poly.exterior.coords)[:-1])]}
def gP(uvs): return geom(Polygon([P(u, v) for u, v in uvs]))
def gW(uvs): return geom(Polygon([W(u, v) for u, v in uvs]))
def rectP(u0, u1, v0, v1): return gP([(u0, v0), (u1, v0), (u1, v1), (u0, v1)])
BIG = 400.0
def half_P_u(lo=-BIG, hi=BIG):
    """판독 u 가 lo~hi 인 띠(EPSG:5186 다각형)."""
    return Polygon([P(lo, -BIG), P(hi, -BIG), P(hi, BIG), P(lo, BIG)])
def band_W(u0, u1, v0, v1): return Polygon([W(u0, v0), W(u1, v0), W(u1, v1), W(u0, v1)])

# 건물 벽(판독 축의 v): 서쪽 돌출부 v 1.76(u 3.0 까지), 본 벽은 벽 축 v 0 인 선
U_JOG_P = 3.0
def wallP(u):
    """본 벽 선 위의 판독 v."""
    xy = W(toW(P(u, 3.5))[0], 0.0); return toP(xy)[1]
INTO = 0.2   # 벽 안으로 들여 그림(건물에 가려짐)

# ---------- 판독 값 ----------
U_W, U_E = 0.5, 10.3            # 현관 몸체 서·동
V_S = -2.2; T_S = 0.6           # 남면, 남면 벽 두께
T_SIDE = 0.45                   # 서면·동면 벽 두께
PIERS = [(0.5, 1.9), (4.55, 6.25), (8.9, 10.3)]           # 남면 기둥(끝 1.4, 가운데 1.7), 아치 너비 2.65
S_OPEN = [(1.9, 4.55), (6.25, 8.9)]
W_OPEN = (-1.3, 0.9); E_OPEN = (-1.6, 0.8)
CROWN, F_PORCH, HEAD_TOP = 154.2, 151.3, 155.2
V_STAIR_HEAD, V_STAIR_FOOT = -2.5, -6.9; N_TREAD = 12; RISE = (151.3 - 148.9) / (N_TREAD + 1); RUN = (V_STAIR_HEAD - V_STAIR_FOOT) / N_TREAD
EAVE_U, EAVE_V, EAVE_Z = (-1.0, 12.6), -3.6, (155.2, 155.8)
TOP_U, TOP_V, RIDGE = (1.0, 10.6), -1.4, 158.0
PL_V = (-6.7, -2.3); PL_W = 2.9; PL_R = 1.2; PL_TOP = 150.2   # 계단 양옆 화단(같은 크기, 사용자 지시)
U_MID = (U_W + U_E) / 2
F_U = (U_W - PL_W, U_W); C_U = (U_E, U_E + PL_W)
# 데크(벽 축): 판독 (10.3, -2.3)·(10.3, 0.95) 를 지나 벽과 나란한 선
VF = toW(P(U_E, -2.3))[1]; VB = toW(P(U_E, 0.95))[1]
BENCH_D, BENCH_Z, G_TOP = 0.45, 151.75, 151.95
VBS = VB - BENCH_D                                             # 벤치 뒤 = 화단 흙의 데크 쪽 끝
U_JOG, V_WALL_E, U_DE, U_STEP, U_STAIR, U_HE = 40.1, 1.67, 49.4, 50.0, 50.6, 50.4   # 벽 꺾임(동쪽은 벽 v 1.67), 데크 끝, 끝 단 끝, 동쪽 계단 서쪽, 앞 화단 동쪽 끝
DOOR_GAP = (30.4, 32.6)
RT = 0.12
BL = json.loads((AUDIT / 'd23' / 'blue_lines.json').read_text(encoding='utf-8'))['lines']
(_u0, _v0), (_u1, _v1) = BL[2]['uv']
def b3(u): return _v0 + (u - _u0) * (_v1 - _v0) / (_u1 - _u0)   # 파랑 3 = 옹벽 앞면(그대로)

SRC = ('판독 보완자료/학교-전경-20261022/대일관-현관-판독/판독.md(그림 20-종합-평면, 21-종합-남쪽입면), 사용자 승인 2026-10-25 '
       '"다 좋은데 데크만 평행하게 하자, 건물이랑", 사용자 추가 지시 2026-10-25(벤치 턱: 영상 148.75 초 표시, 계단 양옆 화단 같은 크기)')
GRADE = '확정(형태: 판독의 확정 항목·사용자 승인), 추정(치수: 사진·영상·항공 판독 ±0.5~1 m)'

def load(fn): return json.loads((STR / fn).read_text(encoding='utf-8'))
def dump(fn, obj): (STR / fn).write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
def note_of(p, what): return p.get('assumption', '').split(' D25:')[0] + ' D25: ' + what

class File:
    def __init__(self, fn):
        self.fn = fn; self.obj = load(fn)
        self.obj['features'] = [f for f in self.obj['features'] if not f['properties']['id'].startswith('D25-')]
    def F(self): return {f['properties']['id']: f for f in self.obj['features']}
    def drop(self, pred):
        self.obj['features'] = [f for f in self.obj['features'] if not pred(f['properties']['id'])]
    def set(self, fid, g, what, **props):
        f = self.F()[fid]; f['geometry'] = g; p = f['properties']
        p.update(props); p['grade'] = GRADE; p['source'] = SRC; p['assumption'] = note_of(p, what)
    def add(self, fid, typ, g, fromM, toM, what, basePlane, after=None, **extra):
        assert toM > fromM, fid
        f = {'type': 'Feature', 'properties': {'id': fid, 'type': typ, 'kind': 'extrude', 'estimated': True, 'grade': GRADE, 'basePlane': basePlane,
             'fromM': r2(fromM), 'toM': r2(toM), 'assumption': 'D25: ' + what, 'source': SRC, **extra}, 'geometry': g}
        feats = self.obj['features']
        if after is not None:
            ids = [x['properties']['id'] for x in feats]; feats.insert(max(i for i, x in enumerate(ids) if x == after or x.startswith(after)) + 1, f)
        else: feats.append(f)
        return f
    def save(self): dump(self.fn, self.obj)

z02 = File('z02-daeil-front.geojson')
# ---------- 현관 몸체 ----------
z02.drop(lambda i: i in ('Z02-PORCH-SIDE-W-HEAD', 'Z02-PORCH-SIDE-W-HEAD-2', 'Z02-DECK-WEST-END', 'Z02-RAILING-JOG', 'Z02-PLANTER-W2')
         or i.startswith('Z02-FRONT-STAIR-CHEEK-'))
for k, (a, b) in enumerate(PIERS):
    z02.set(f'Z02-PORCH-PIER-{k + 1}', rectP(a, b, V_S, V_S + T_S), f'현관 남면 기둥(판독 u {a}~{b}, 남면 v {V_S}, 두께 {T_S}). 끝 기둥 1.4·가운데 1.7 m', fromM=F_PORCH, toM=CROWN)
z02.set('Z02-PORCH-HEADER', rectP(U_W, U_E, V_S, V_S + T_S), '남면 아치 위 머리벽(판독 u 0.5~10.3, 남면 v -2.2)', fromM=CROWN, toM=HEAD_TOP)
z02.set('Z02-PORCH-SIDE-W', rectP(U_W, U_W + T_SIDE, V_S + T_S, 1.76), '서면 아치 위 머리벽(서면 = 남면 뒤 ~ 돌출부 벽 v 1.76)', fromM=CROWN, toM=HEAD_TOP, basePlane='없음(아치 위에 걸침)')
z02.set('Z02-PORCH-SIDE-E', rectP(U_E - T_SIDE, U_E, V_S + T_S, wallP(U_E) + INTO), '동면 머리벽(남쪽 아치 위 ~ 북쪽 막힌 벽 위)', fromM=CROWN, toM=HEAD_TOP, basePlane='없음(아치·벽 위에 걸침)')
z02.add('D25-PORCH-W-PIER-S', 'wall', rectP(U_W, U_W + T_SIDE, V_S + T_S, W_OPEN[0]), F_PORCH, CROWN, '서면 아치 남쪽 기둥', 'Z02-PLATFORM-ENTRANCE', after='Z02-PORCH-SIDE-W', material='brick')
z02.add('D25-PORCH-W-PIER-N', 'wall', rectP(U_W, U_W + T_SIDE, W_OPEN[1], 1.76), F_PORCH, CROWN, '서면 아치 북쪽 기둥(돌출부 벽까지)', 'Z02-PLATFORM-ENTRANCE', after='D25-PORCH-W-PIER-S', material='brick')
def arches(pid, openings, along_u, d0, d1, what, after):
    """z10/build_parts.py 의 둥근 아치와 같은 방식: 뚫린 곳(s0~s1, 위 CROWN)의 윗모서리를 반원으로 읽히게 반쪽마다 6 조각."""
    K = 6; last = after
    for n, (s0, s1) in enumerate(openings):
        r = (s1 - s0) / 2; c = (s0 + s1) / 2; spring = CROWN - r; xs = [r * np.cos(np.radians(90 * k / K)) for k in range(K + 1)]
        for k in range(K):
            xa, xb = xs[k + 1], xs[k]; z = spring + np.sqrt(max(r * r - ((xa + xb) / 2) ** 2, 0.0))
            if CROWN - z < 0.04: continue
            for side, (a, b) in (('L', (c - xb, c - xa)), ('R', (c + xa, c + xb))):
                g = rectP(a, b, d0, d1) if along_u else rectP(d0, d1, a, b)
                fid = f'{pid}{n + 1}-{side}{k + 1}'
                z02.add(fid, 'wall', g, z, CROWN, f'{what}: 반원 머리(반지름 {r:.2f} m, 아치 시작 {spring:.2f} m)를 계단 모양 {K}조각으로', f'{pid} 머리벽', after=last, material='brick'); last = fid
    return last
last = arches('D25-PORCH-ARCH-S', S_OPEN, True, V_S, V_S + T_S, '현관 남면 아치 둘(판독: 너비 약 2.6, 높이 약 3.0)', 'Z02-PORCH-HEADER')
last = arches('D25-PORCH-ARCH-W', [W_OPEN], False, U_W, U_W + T_SIDE, '현관 서면 아치(서쪽 옆 계단 머리 참으로)', 'D25-PORCH-W-PIER-N')
last = arches('D25-PORCH-ARCH-E', [E_OPEN], False, U_E - T_SIDE, U_E, '현관 동면 남쪽 아치(데크로)', 'Z02-PORCH-SIDE-E')
# 회랑 안 북쪽 벽 따라 문 앞 단 3단(추정, 기존 Z06 값), 1층 바닥
IN_U = (U_W + T_SIDE, U_E - T_SIDE)
z02.set('Z02-PORCH-INNER-STEP-1', rectP(*IN_U, 0.15, 0.45), '회랑 안 북쪽 벽 따라 문 앞 단 1(회랑 서~동 벽 전체). 3단은 사용자 미확인이라 기존 Z06 값(추정)', widthM=r2(IN_U[1] - IN_U[0]))
z02.set('Z02-PORCH-INNER-STEP-2', rectP(*IN_U, 0.45, 0.75), '문 앞 단 2(회랑 서~동 벽 전체, 추정)', widthM=r2(IN_U[1] - IN_U[0]))
z02.set('Z02-PORCH-FLOOR-1F', gP([(IN_U[0], 0.75), (IN_U[1], 0.75), (IN_U[1], wallP(IN_U[1]) + INTO), (IN_U[0], wallP(IN_U[0]) + INTO)]),
        '문 앞 단 위 1층 바닥(151.8, 입구 유리문 앞). 서쪽 u 3.0 까지는 돌출부 벽(v 1.76) 안으로 들어가 가려짐')
# 처마(흰 띠)와 모임지붕(서·남·동 비탈, 벽 쪽 뒤 변 수평)
def backP(u): return wallP(u) + INTO
z02.set('Z02-PORCH-EAVE', gP([(EAVE_U[0], EAVE_V), (EAVE_U[1], EAVE_V), (EAVE_U[1], backP(EAVE_U[1])), (EAVE_U[0], backP(EAVE_U[0]))]),
        '처마 흰 띠(판독 u -1.0~12.6, 앞선 v -3.6, 뒤는 건물 벽). 몸체보다 앞 1.4, 옆 1.5~2.3 m', fromM=EAVE_Z[0], toM=EAVE_Z[1])
def slope(fid, uvs, o_uv, dir_uv, run, what, new=False):
    o = P(*o_uv); d = P(*dir_uv) - P(0, 0)
    prof = {'origin': [r2(o[0]), r2(o[1])], 'direction': [round(float(d[0]), 4), round(float(d[1]), 4)], 'points': [[0.0, EAVE_Z[1]], [r2(run), RIDGE]]}
    props = dict(fromM=EAVE_Z[1] - 0.04, toM=RIDGE, bottomM=EAVE_Z[1] - 0.04, topProfile=prof, basePlane='Z02-PORCH-EAVE', material='roof_tile', type='canopy')
    if new: z02.add(fid, 'canopy', gP(uvs), EAVE_Z[1] - 0.04, RIDGE, what, 'Z02-PORCH-EAVE', after='Z02-PORCH-ROOF-2', material='roof_tile', bottomM=EAVE_Z[1] - 0.04, topProfile=prof)
    else: z02.set(fid, gP(uvs), what, **props)
z02.set('Z02-PORCH-ROOF-2', gP([(TOP_U[0], TOP_V), (TOP_U[1], TOP_V), (TOP_U[1], backP(TOP_U[1])), (TOP_U[0], backP(TOP_U[0]))]),
        '모임지붕 꼭대기(158.0, 평평한 판으로 둠: 평판인지 짧은 용마루인지 모름)', fromM=EAVE_Z[1] - 0.04, toM=RIDGE, basePlane='Z02-PORCH-EAVE')
slope('Z02-PORCH-ROOF-1', [(EAVE_U[0], EAVE_V), (EAVE_U[1], EAVE_V), (TOP_U[1], TOP_V), (TOP_U[0], TOP_V)], (0, EAVE_V), (0, 1), TOP_V - EAVE_V,
      '모임지붕 남쪽 비탈(처마 155.8 → 꼭대기 158.0)')
slope('D25-PORCH-ROOF-W', [(EAVE_U[0], EAVE_V), (TOP_U[0], TOP_V), (TOP_U[0], backP(TOP_U[0])), (EAVE_U[0], backP(EAVE_U[0]))], (EAVE_U[0], 0), (1, 0), TOP_U[0] - EAVE_U[0],
      '모임지붕 서쪽 비탈(뒤 변은 벽에 닿아 수평)', new=True)
slope('D25-PORCH-ROOF-E', [(TOP_U[1], TOP_V), (EAVE_U[1], EAVE_V), (EAVE_U[1], backP(EAVE_U[1])), (TOP_U[1], backP(TOP_U[1]))], (EAVE_U[1], 0), (-1, 0), EAVE_U[1] - TOP_U[1],
      '모임지붕 동쪽 비탈(뒤 변은 벽에 닿아 수평)', new=True)
# 참 기단: 몸체 안 + 남면 앞 0.3 m(추정) + 서쪽 옆 계단 머리 참(서쪽 화단 F 북쪽 끝 v -2.3 까지)
ent = Polygon([P(-2.48, 1.76), P(U_JOG_P + 0.02, 1.85), P(U_JOG_P + 0.09, wallP(U_JOG_P + 0.09) + INTO), P(U_E, backP(U_E)), P(U_E, V_STAIR_HEAD),
               P(U_W, V_STAIR_HEAD), P(U_W, PL_V[1]), P(-2.41, PL_V[1])])
z02.set('Z02-PLATFORM-ENTRANCE', geom(ent), '참(151.3) = 회랑 바닥 + 남면 앞 0.3 m(v -2.5~-2.2, 사용자 미확인 → 판독 0~0.5 m 의 0.3 m, 추정) + 서면 아치 밖 서쪽 옆 계단 머리 참')
# ---------- 넓은 계단(디딤 12 + 참으로 오르는 단 = 13단)과 단마다 꺾인 볼 ----------
ST_U = (U_W + T_SIDE, U_E - T_SIDE)
for k in range(1, N_TREAD + 1):
    v0 = V_STAIR_FOOT + (k - 1) * RUN; v1 = V_STAIR_FOOT + k * RUN; top = 148.9 + k * RISE
    z02.set(f'Z02-FRONT-STAIR-S{k:02d}', rectP(*ST_U, v0, v1), f'현관 넓은 계단 디딤 {k}/12(+참으로 오르는 단 = 13단, 단 높이 {RISE:.3f}, 단 너비 {RUN:.3f} m). 몸체 폭 전체(양 끝 0.45 m 는 흰 돌 볼)',
            fromM=148.9, toM=r2(top), riseM=r2(RISE), runM=r2(RUN), widthM=r2(ST_U[1] - ST_U[0]))
    for side, (a, b) in (('W', (U_W, ST_U[0])), ('E', (ST_U[1], U_E))):
        z02.add(f'D25-FRONT-STAIR-CHEEK-{side}{k:02d}', 'wall', rectP(a, b, v0, v1), 148.9, top + 0.15, '넓은 계단 양옆 흰 돌 볼(단마다 꺾임, 디딤 위 0.15 m)', 'Z02-PLATFORM-APRON',
                after=f'Z02-FRONT-STAIR-S{N_TREAD:02d}' if k == 1 and side == 'W' else None, material='white_stone')
# ---------- 계단 양옆 화단(같은 크기·모양, 계단 가운데 선 대칭: 사용자 지시) ----------
def planter_shape(u0, u1):
    """판독 축의 네모(u0~u1, PL_V) 에서 운동장 쪽 두 모서리를 반지름 PL_R 로 둥글게."""
    v0, v1 = PL_V; pts = []
    for cu, a0 in ((u0 + PL_R, 180), (u1 - PL_R, 270)):
        for t in np.linspace(a0, a0 + 90, 7): pts.append((cu + PL_R * np.cos(np.radians(t)), v0 + PL_R + PL_R * np.sin(np.radians(t))))
    return gP(pts + [(u1, v1), (u0, v1)])
PLA = (f'계단 양옆 화단(사용자 지시 2026-10-25: 계단 양옆 화단 같은 크기). 폭 {PL_W} × 깊이 {PL_V[1] - PL_V[0]:.1f} m, 운동장 쪽 모서리 둥글게, 흰 돌 테, 윗면 {PL_TOP}. '
       f'계단 가운데 선 u {U_MID} 에 대해 대칭. 깊이는 C 판독(v -6.7~-2.3), 폭은 서쪽 옆 계단 머리(u -2.4)에 걸리지 않게 C 판독 3.6(±1)에서 줄임(추정)')
for fid, us, what in (('Z02-PLANTER-W1', F_U, '서쪽 화단 F'), ('Z02-PLANTER-BASTION', C_U, '동쪽 화단 C: 북쪽 끝 v -2.3(그 북쪽은 데크)')):
    z02.set(fid, planter_shape(*us), f'{what}. {PLA}', fromM=148.9, toM=PL_TOP, material='white_stone', topColor='#7f9a6b', basePlane='Z02-PLATFORM-APRON')
# 동쪽 화단 C 의 소나무(서쪽 F 의 Z06-TREE-09 를 계단 가운데 선에 대칭으로)
z06 = File('z06-trees.geojson'); T6 = z06.F()
z06.drop(lambda i: i.startswith('Z06-TREE-10-'))
PL_C = (np.mean(F_U), (PL_V[0] + PL_V[1]) / 2 - 0.1)   # 처마(v -3.6) 아래로 나무 머리가 들어가지 않게 가운데보다 0.1 m 운동장 쪽
for part, h, z0, z1 in (('TRUNK', 0.25, 0.0, 3.0), ('CROWN', 1.75, 2.8, 4.2), ('TOP', 1.0, 4.2, 5.2)):
    fid = f'Z06-TREE-09-{part}'; p = T6[fid]['properties']
    z06.set(fid, rectP(PL_C[0] - h, PL_C[0] + h, PL_C[1] - h, PL_C[1] + h), '서쪽 화단 F 가운데의 소나무(W2 의 소나무 Z06-TREE-10 은 걷음: 판독 F = 소나무 하나)',
            fromM=r2(PL_TOP + z0), toM=r2(PL_TOP + z1))
    cu = 2 * U_MID - PL_C[0]
    z02.add(f'D25-PLANTER-C-TREE-{part}', 'tree', rectP(cu - h, cu + h, PL_C[1] - h, PL_C[1] + h), PL_TOP + z0, PL_TOP + z1,
            '동쪽 화단 C 의 소나무(판독: 소나무, 위에서 둥글게 보이는 것은 나무 머리). 서쪽 F 와 같은 크기로 대칭', 'Z02-PLANTER-BASTION', material=p['material'])
z06.save()

# ---------- 데크·난간·앞 화단(벽과 평행) ----------
west = half_P_u(lo=U_E)
def cutW(u0, u1, v0, v1, west_cut=True): return geom(band_W(u0, u1, v0, v1).intersection(west) if west_cut else band_W(u0, u1, v0, v1))
# 데크 기단(콘크리트): 벽 ~ 데크 앞선, 현관 동면(u 10.3) ~ 끝 단 끝
pas = band_W(-10, U_JOG, -0.2, VF).union(band_W(U_JOG, U_STEP, 1.46, VF)).intersection(west)
z02.set('Z02-PLATFORM-PASSAGE', geom(pas), f'데크·뒤 화단 밑 기단. 앞선 = 데크 앞선(벽과 평행, 벽 v {VF:.2f}), 서쪽 끝 = 현관 동면(판독 u 10.3)')
z02.set('Z02-DECK-MAIN', cutW(-10, U_JOG, VB, VF), f'나무 데크 = 벽과 평행한 두 선 사이(벽 v {VB:.2f}~{VF:.2f}, 폭 {VF - VB:.2f} m, 사용자 승인). 서쪽 끝 = 현관 동면 아치(판독 u 10.3), 회랑 바닥과 턱 없이')
z02.set('Z02-DECK-EAST', cutW(U_JOG, U_DE, VB, VF, False), f'나무 데크 동쪽 구간(같은 폭, 벽 v {VB:.2f}~{VF:.2f})')
z02.set('Z02-DECK-STEP-E', cutW(U_DE, U_STEP, V_WALL_E, VF, False), '데크 끝에서 참으로 내려서는 단(벽 ~ 데크 앞선)', widthM=r2(VF - V_WALL_E))
z02.set('Z02-RAILING-MAIN', cutW(-10, U_JOG, VF - RT, VF),
        '빨간 물결 난간: 현관 동면 남쪽 모서리(판독 10.3, -2.2)에서 데크 앞선 안쪽 0.12 m 를 따라 곧게(꺾임 없음)')
z02.set('Z02-RAILING-EAST', cutW(U_JOG, U_STEP, VF - RT, VF, False), '난간 동쪽 구간(데크 앞선 안쪽 0.12 m, 끝 단 끝까지)')
# 앞 화단: 데크 앞선 ~ 옹벽 앞면(파랑 3, 그대로). 서쪽 끝 = 동쪽 화단 C 동쪽 끝
def front_bed(u0, u1):
    us = [u0] + [u for u in np.arange(12.0, u1, 4.0) if u > u0] + [u1]
    return Polygon([W(u, VF) for u in us] + [W(u, b3(u)) for u in us[::-1]])
cw = half_P_u(lo=C_U[1])
z02.set('Z02-PLANTER-MAIN', geom(front_bed(0.0, U_JOG).intersection(cw)), f'앞 화단 = 데크 앞선 ~ 옹벽 앞면(파랑 3, 그대로). 서쪽 끝 = 동쪽 화단 C(판독 u {C_U[1]}). 데크와 옹벽 사이를 빈틈 없이 채움')
z02.set('Z02-PLANTER-EAST', geom(front_bed(U_JOG, U_HE)), '앞 화단 동쪽 = 데크 앞선 ~ 파랑 3, 동쪽 끝은 계단 서쪽 옆(u 50.4)')
# 동쪽 끝 참(서쪽 부분): 끝 단 ~ 동쪽 계단 서쪽 옆을 데크 앞선까지
f = z02.F()['X22-DAEIL-EAST-LANDING']
f['geometry'] = gW([(U_STEP, V_WALL_E), (54.0, V_WALL_E), (54.0, 2.7), (U_STAIR, 2.7), (U_STAIR, VF), (U_STEP, VF)])
f['properties']['assumption'] = note_of(f['properties'], '서쪽 끝을 데크 끝 단 폭(데크 앞선)까지')
z02.save()

# ---------- x22: 뒤 화단·벤치·나무·가로등 ----------
x22 = File('x22-photo-fixes.geojson'); G = x22.F()
BPA = ('데크 뒤(건물 쪽) 나무 줄 화단 = 벽 ~ 벤치 뒤. 데크 뒤선이 벽과 평행(사용자 승인)이라 폭이 끝까지 같다. 윗면 = 데크 위 0.65(벤치보다 0.2 높음, 영상 148.5~152.5 초 눈대중). '
       '서쪽 끝 = 현관 동면 북쪽 막힌 벽(판독 u 10.3). 입구(2) 문 앞 벽 u 30.4~32.6 은 틈(추정)')
BENCH = ('벤치 턱(사용자 2026-10-25: "데크가 상대적으로 좁게 보이는 이유는 벽 쪽 화단에 의자 형태로 올라온 부분이 있어서", 영상 148.75 초 초록 표시). '
         '데크 뒤선 위 화단 쪽, 깊이 0.45·앉는 면 데크 위 0.45 m(151.75), 짙은 앞면·밝은 윗면(영상). 동면 아치 바로 옆에서 시작(영상 148.5~152.5 초), '
         '길이·끊김은 영상 밖이라 모름 → 화단 전체 길이(문 앞 틈만 끊음, 추정). 걷는 면에서는 장애물(높이 차 0.45 m)')
segs = [('X22-DAEIL-BACK-PLANTER', 'D25-DAEIL-DECK-BENCH-1', band_W(-10, DOOR_GAP[0], 0.0, VBS).intersection(west), band_W(-10, DOOR_GAP[0], VBS, VB).intersection(west)),
        ('X22-DAEIL-BACK-PLANTER-E', 'D25-DAEIL-DECK-BENCH-2', band_W(DOOR_GAP[1], U_JOG, 0.0, VBS), band_W(DOOR_GAP[1], U_JOG, VBS, VB)),
        ('D25-DAEIL-BACK-PLANTER-E2', 'D25-DAEIL-DECK-BENCH-3', band_W(U_JOG, U_DE, V_WALL_E, VBS), band_W(U_JOG, U_DE, VBS, VB))]
for pid, bid, soil, bench in segs:
    if pid in G: x22.set(pid, geom(soil), BPA, toM=G_TOP)
    else: x22.add(pid, 'planter', geom(soil), 151.25, G_TOP, BPA + '. 벽 꺾임(u 40.1) 동쪽: 전에는 데크가 벽까지 갔으나 데크 뒤선이 평행이라 폭 1.06 m 의 화단 띠가 생김(벽 ~ 벤치 뒤 0.6 m)',
                  'Z02-PLATFORM-PASSAGE', after='X22-DAEIL-BACK-PLANTER-E', color='#b3ad9f', topColor='#7f9a6b')
    x22.add(bid, 'wall', geom(bench), 151.25, BENCH_Z, BENCH, 'Z02-PLATFORM-PASSAGE', after=pid, material='stone', color='#4b4640', topColor='#8f7d63')
G = x22.F()
def translate(f, d): f['geometry'] = {'type': 'Polygon', 'coordinates': [[[r2(x + d[0]), r2(y + d[1])] for x, y in r] for r in f['geometry']['coordinates']]}
def centroid(fid): return np.array(Polygon(G[fid]['geometry']['coordinates'][0]).centroid.coords[0])
V_AX = W(0, 1) - W(0, 0)
for k in range(1, 7):
    cu, cv = toW(centroid(f'X22-DAEIL-BACK-TREE-{k}-TRUNK')); d = V_AX * (VBS / 2 - cv)
    for part in ('TRUNK', 'CROWN', 'TOP'):
        g = G[f'X22-DAEIL-BACK-TREE-{k}-{part}']; translate(g, d); p = g['properties']
        dz = G_TOP - 151.75 if 'D25: 줄기를' not in p.get('assumption', '') else 0.0
        p['fromM'] = r2(p['fromM'] + dz); p['toM'] = r2(p['toM'] + dz)
        p['assumption'] = note_of(p, '줄기를 뒤 화단 흙(벽 ~ 벤치 뒤) 가운데로, 화단 윗면에 맞춰 올림')
for k in range(1, 5):
    lid = f'X22-LAMP-FIELD-{k:02d}'; cu, cv = toW(centroid(lid)); d = V_AX * ((VF + b3(cu)) / 2 - cv)
    for fid in [i for i in G if i == lid or i.startswith(lid + '-')]: translate(G[fid], d)
x22.save()

# ---------- x40: 동면 기둥 → 남쪽은 걷고(모서리 기둥 Z02-PORCH-PIER-3 가 대신), 북쪽은 막힌 벽 ----------
x40 = File('x40-parts.geojson')
x40.drop(lambda i: i == 'X40-PORCH-E-PIER-S')
x40.set('X40-PORCH-E-PIER-N', rectP(U_E - T_SIDE, U_E, E_OPEN[1], wallP(U_E) + INTO), '동면 북쪽 막힌 벽(v 0.8 ~ 건물 벽, 판독). 안쪽 작은 벽감은 그리지 않음', fromM=F_PORCH, toM=CROWN)
x40.save()
# ---------- z10: 옛 남면 아치 조각 걷음 ----------
z10 = File('z10-parts.geojson'); z10.drop(lambda i: i.startswith('Z10-DAEIL-PORCH-')); z10.save()
print(f'데크 벽 v 뒤 {VB:.3f} 앞 {VF:.3f} 폭 {VF - VB:.3f}; 계단 단 높이 {RISE:.4f} 단 너비 {RUN:.4f}; 앞 화단 폭 u12 {b3(12) - VF:.2f} u50 {b3(50) - VF:.2f}')
