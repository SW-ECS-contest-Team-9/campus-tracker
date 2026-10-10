"""Z04: 캠퍼스 안 나머지 구역의 기단(땅 덩어리)과 그 위 상자를 만든다. DB·네트워크 접근 없음.   python build_inputs.py
쓰는 파일:
  frontend/public/structures/z04-<구역>.geojson      구역마다 기단(platform) + 상자(extrude). 형식은 docs/audit/g02/STRUCTURES.md
  backend/data/terrain/recipes/z04-surface.geojson   같은 기단에서 나온 지형 조리법 surface 입력(폭이 좁은 기단은 싣지 않음)
  backend/data/terrain/recipes/z04-smooth-ground.json 조리법 = Z03 조리법 단계 + 위 surface 단계
  docs/audit/z04/model.json                          구역별 기단 목록(높이·넓이·등급), 길 높이 맞춤에 쓰는 값
기단은 세 가지로 만든다.
  손으로 정한 것(HAND): 회차 공간 포장면(한 경사면), 차도 띠(V02 종단을 6 m 마디의 경사면 조각으로), 근거 높이가 있는 마당.
  평탄면(T): S-MAP 1 m 메시에서 이웃 칸과 0.06 m 안으로 이어지는 평평한 칸 묶음. 윗면 = 그 칸들의 가운데값(0.1 m 로 맞춤). 한 높이.
  경사면(R): 평탄면이 아닌 완만한 칸 묶음. 윗면 = 그 칸들에 맞춘 평면 하나(한 방향 경사). 울퉁불퉁한 면을 따라가지 않는다.
가파른 칸(S-MAP 이 벽·계단을 2~4 m 폭으로 뭉갠 곳)은 가장 가까운 기단에 붙인다 -> 기단끼리는 벽면으로 만난다. 좌표 EPSG:5186."""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from collections import Counter, defaultdict
from scipy import ndimage as ndi
import shapely
from shapely.geometry import Polygon, LineString, Point, box as sbox
from shapely.ops import unary_union
from shapely import contains_xy
REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
dump = lambda path, obj: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}
MESH = 'S-MAP 3D 뷰어 메시 1 m 판독(z04/smap-mesh-z04-1m-w0~e3.txt, 2026-10-11)'
def big(g):
    g = g.buffer(0); return max(g.geoms, key=lambda q: q.area) if g.geom_type not in ('Polygon',) else g
def geom(poly):
    c = [[r2(x), r2(y)] for x, y in poly.exterior.coords]; c[-1] = c[0]; return {'type': 'Polygon', 'coordinates': [c]}
M = Mesh(); Z = M.z
CAMPUS = Polygon(json.loads((HERE / 'campus-outline-5186.json').read_text(encoding='utf-8'))['ring'])
XS, YS = np.meshgrid(MX0 + np.arange(MNX), MY0 + np.arange(MNY))
BLD = building_polys(); BLD_ALL = unary_union(list(BLD.values()))
# 지도에 실제로 그려지는 건물 덩어리(건물 노트의 부분들. 원천 외곽 가운데 그리지 않는 곳은 빠져 있다)
DRAWN = unary_union([Polygon(b['ring']).buffer(0) for b in json.loads((HERE / 'scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']])
UNDER = DRAWN.buffer(-1.0)   # 기단은 건물 벽 안쪽 1 m 까지만 들어간다(벽 밑 틈 막기)
def feats_of(fn): return json.loads((STR / (fn + '.geojson')).read_text(encoding='utf-8'))['features']
DONE = unary_union([Polygon(f['geometry']['coordinates'][0]).buffer(0) for fn in ('g02-way', 'z02-daeil-front', 'z03-fountain') for f in feats_of(fn) if f['properties']['kind'] == 'platform' and f['properties']['id'] != 'G02-PLATFORM-PLAZA'])
PLAT = {f['properties']['name']: Polygon(f['geometry']['coordinates'][0]) for f in json.loads((REC / 'f05-plateaus.geojson').read_text(encoding='utf-8'))['features']}
FIELD, PLAZA = PLAT['field'].buffer(0), big(PLAT['plaza'].buffer(0).difference(DONE))
LINES = {l['name']: np.array(l['points']) for l in json.loads((REC / 't06-road-corridors.json').read_text(encoding='utf-8'))['lines']}

# ---------- 구역 ----------
ZONES = {'turnaround': '북악관 앞 회차 공간과 본관 앞 포장면', 'upper-branch': '위쪽 갈래(본관·한림관 사이 차도, 한림관 1층 가는 길, 한림관 옆 낮은 곳)', 'back-paths': '문예관–대일관 사잇길, 북악관 옆길, 뒤편 산책로',
         'cheongun': '청운관 앞', 'hyein': '혜인관 둘레', 'eunju': '은주관 둘레(풋살장·수인관)', 'yudam9': '유담관 둘레(9층 쪽 앞마당, 본관 앞 차도 S06, 분수 광장 서쪽 아래)', 'west': '서문과 서쪽 옹벽', 'gate': '정문'}
BACK_LINE = LineString([(200990, 557408), (201085, 557362), (201125, 557340), (201225, 557300), (201266, 557290)])   # 북악관·문예관·대일관의 가운데를 지나는 선: 이 선의 북쪽이 뒤편
def zone_of(x, y):
    c = BACK_LINE.interpolate(BACK_LINE.project(Point(x, y)))
    if y > c.y or (x < 201014 and y > 557378): return 'back-paths'
    if x < 201002 and y > 557282: return 'west'
    if x < 201048 and y >= 557314: return 'turnaround'
    if x < 201080 and y >= 557184: return 'yudam9'
    if (y < 557184 and x < 201112) or y < 557112: return 'gate'
    if x < 201136 and y >= 557205: return 'upper-branch'
    if x >= 201204 and y >= 557257: return 'cheongun'
    if x >= 201196 and y < 557257: return 'hyein'
    return 'eunju'

# ---------- 1. 손으로 정한 기단 ----------
HAND = []
def profile_fit(poly, inset=1.0):
    """다각형 안 땅 칸에 평면 하나를 맞춰 기단 윗면 profile 로(한 방향 경사). 돌려줌: profile, 경사 %, 잔차 90 %, 칸 수."""
    zz, xs, ys = M.inside(poly, inset=inset); A = np.c_[xs, ys, np.ones(len(xs))]; (a, b, c), *_ = np.linalg.lstsq(A, zz, rcond=None)
    g = np.hypot(a, b); d = np.array([a, b]) / g; o = np.array([poly.centroid.x, poly.centroid.y]); z0 = a * o[0] + b * o[1] + c
    ext = (np.array(poly.exterior.coords) - o) @ d; smin, smax = ext.min(), ext.max()
    return ({'origin': [r2(o[0]), r2(o[1])], 'direction': [round(float(d[0]), 4), round(float(d[1]), 4)], 'points': [[r2(smin), r2(z0 + g * smin)], [r2(smax), r2(z0 + g * smax)]]},
            g * 100, float(np.percentile(np.abs(zz - A @ np.array([a, b, c])), 90)), len(zz))
def prof_z(pr, x, y):
    o, d, p = pr['origin'], pr['direction'], np.array(pr['points']); return np.interp((np.asarray(x) - o[0]) * d[0] + (np.asarray(y) - o[1]) * d[1], p[:, 0], p[:, 1])
PLAZA_PROF, pl_slope, pl_res, pl_n = profile_fit(PLAZA)
HAND.append(dict(zone='turnaround', name='PLAZA', poly=PLAZA, top=PLAZA_PROF, terrain=True, material='paving', bottom=126.0, bottomNote='지하 차도·통로(128.5 m)보다 아래의 안전 깊이',
    grade='확정(회차 공간·북악관 현관 앞·본관 앞·오르막길이 끊김 없는 한 포장면: 사용자 그림 11), S-MAP(높이)', source=MESH + ', backend/data/terrain/recipes/f05-plateaus.geojson(외곽, T06), 사용자 핀 12개 130.2~131.2',
    assumption=f'외곽은 T06·F05 의 포장면 다각형 그대로. 윗면은 한 평면: 메시 {pl_n}칸에 맞춘 경사 {pl_slope:.1f} %, 맞춤 잔차 90 % {pl_res:.2f} m. G02 까지는 130.6 m 한 높이여서 북쪽 가장자리와 오르막 아래 끝이 0.7~0.8 m 낮았다',
    reason=f'Z04 회차 공간 포장면: 한 경사면(경사 {pl_slope:.1f} %). 130.6 m 평탄면을 대신한다'))
def ribbon(zone, key, line, half, step, grade, source, what, terrain=True, material='paving', clip=None):
    """길 가운데 선(x, y, z)을 step 마디로 잘라 마디마다 한 방향 경사면 조각(폭 방향 평평)을 만든다."""
    ln = LineString(line[:, :2]); d = np.r_[0, np.cumsum(np.hypot(*np.diff(line[:, :2], axis=0).T))]; n = max(1, int(round(ln.length / step))); cuts = np.linspace(0, ln.length, n + 1)
    rib = ln.buffer(half, cap_style=2)
    if clip is not None: rib = rib.intersection(clip)
    P = np.array([[np.interp(c, d, line[:, 0]), np.interp(c, d, line[:, 1]), np.interp(c, d, line[:, 2])] for c in cuts])
    tang = [(P[min(i + 1, n)][:2] - P[max(i - 1, 0)][:2]) for i in range(n + 1)]; tang = [t / np.hypot(*t) for t in tang]
    for i in range(n):
        a, b = P[i], P[i + 1]; na, nb = np.array([-tang[i][1], tang[i][0]]), np.array([-tang[i + 1][1], tang[i + 1][0]]); R = half + 6
        slab = Polygon([a[:2] + na * R, b[:2] + nb * R, b[:2] - nb * R, a[:2] - na * R]).buffer(0)
        piece = rib.intersection(slab).difference(DONE).buffer(0)
        if piece.is_empty or piece.area < 4: continue
        piece = big(piece); v = (b[:2] - a[:2]); L = np.hypot(*v); v = v / L
        top = {'origin': [r2(a[0]), r2(a[1])], 'direction': [round(float(v[0]), 4), round(float(v[1]), 4)], 'points': [[0.0, r2(a[2])], [r2(L), r2(b[2])]]}
        HAND.append(dict(zone=zone, name=f'{key}-{i + 1:02d}', poly=piece, top=top, terrain=terrain, material=material, grade=grade, source=source,
            assumption=f'{what}: 가운데 선을 {ln.length / n:.1f} m 마디로 자른 경사면 조각 {i + 1}/{n}({a[2]:.2f} → {b[2]:.2f} m), 폭 {2 * half:.1f} m(추정), 폭 방향 평평', reason=f'Z04 {what} 조각 {i + 1}/{n}'))
V02 = 'docs/audit/v02/road-profile.geojson(사용자 S-MAP 핀으로 고른 종단), backend/data/terrain/recipes/t06-road-corridors.json'
GR = 'S-MAP·사용자 핀(종단, V02), 추정(폭)'
V4 = np.vstack([LINES['V4a'], LINES['V4b'][1:]])
ribbon('turnaround', 'V4', V4, 7.0, 6.0, GR, V02, '본관 서쪽 회차 공간 내리막(V4, P1 갈림 ~ 포장면 남쪽 끝)', clip=CAMPUS.difference(PLAZA))
ribbon('yudam9', 'V3', LINES['V3'], 4.5, 6.0, GR, V02, '본관 앞 차도 S06(V3, 굽이 ~ P1 갈림)')
ribbon('yudam9', 'PUP', LINES['P-UP'], 3.0, 6.5, GR, V02, 'P1(제2주차장) 차로')
ribbon('upper-branch', 'U1', LINES['U1'], 3.25, 6.0, GR + ', 사용자 높이 표시 121.4~126.1 m(그림 13)', V02 + ', 사용자-출입구·주차장-20261010/13-SMAP-한림관-가는길-높이표시.webp', '위쪽 갈래 차도(U1, 굽이 ~ 본관·한림관 사이 ~ 은주1관 서쪽)')
U1X = np.array([(201112.12, 557211.18, 130.92), (201116.32, 557208.17, 131.2), (201120.14, 557204.47, 131.7), (201124.53, 557200.64, 132.2), (201128.3, 557195.63, 132.2)])
ribbon('eunju', 'U1X', U1X, 3.0, 5.7, 'S-MAP·사용자 핀 U030·U031·U033·U034(높이), 추정(선·폭. 차도인지 모름)', V02, '윗길 끝에서 풋살장 쪽으로 이어지는 포장(U1-EXT)')
ribbon('gate', 'V1', LINES['V1'], 6.0, 7.0, GR, V02, '정문 진입로(V1, 공도 분기 ~ 주차장 차로 갈림)')
V2S = LINES['V2'][LINES['V2'][:, 1] <= 557181.5]
ribbon('gate', 'V2S', V2S, 5.0, 6.0, GR, V02, '주 진입로 아래 구간(V2, 갈림 ~ 분수 광장 남쪽 끝. 그 북쪽은 Z03 차도 포장 띠)', clip=sbox(201000, 557000, 201300, 557180))
ribbon('gate', 'PLOW', LINES['P-LOW'], 3.0, 7.0, GR, V02, '제1주차장(표지판 P2) 차로')
# 한림관 둘레의 낮은 통로(G02 가 남긴 곳): 본관·한림관 사이 틈 -> 한림관 북쪽 -> 한림관·은주1관 사이. 무엇인지는 모름(본관 5층–한림관 3층 데크와 한림관–은주관 연결통로가 이 높이대)
HSRC = MESH + ', 건물 노트 한림관(북쪽 모퉁이 133.8~141.2·가운데 135.1, 남동 평탄면 136.3~136.4, 서쪽 틈 130.3~135.2), 구역 노트 오르막길 A17'
_wgap = Polygon([(201096.5, 557290), (201103.5, 557290), (201104.5, 557300), (201104.5, 557313), (201099, 557313), (201097, 557300)])
_narc = sbox(201099, 557303, 201129, 557319).difference(_wgap); _eslot = sbox(201121, 557271, 201137, 557308).difference(_narc)
for nm, pl, top, gr, ass in (
  ('HANLIM-WGAP', _wgap, {'origin': [201100.0, 557290.0], 'direction': [0.0, 1.0], 'points': [[0.0, 127.2], [22.0, 135.3]]}, 'S-MAP(양 끝 높이 127.2·135.3), 추정(한 경사면으로 봄. 계단인지 경사인지 모름)',
   '본관 동쪽 끝과 한림관 사이 틈(폭 2~4 m): S-MAP 이 22 m 에 8.1 m 오름(37 %)으로 읽는다. 계단일 것(추정). 위에 계단 상자를 얹는다'),
  ('HANLIM-NARC', _narc, 135.3, 'S-MAP(한림관 벽 옆 낮은 값 134.2~135.9), 추정(한 높이로 봄, 범위)',
   '한림관 북쪽의 낮은 자리: 오르막길 가장자리(141~146 m) 아래 6~10 m. S-MAP 은 3~6 m 폭 비탈로 뭉개 읽는다(133.8~141.2). 벽 옆 낮은 값을 바닥으로 봄. 본관 5층–한림관 3층 나무 데크(137.9 m 추정)가 이 서쪽 끝 위'),
  ('HANLIM-ESLOT', _eslot, 136.3, 'S-MAP(평탄면 136.3~136.4), 추정(범위)',
   '한림관과 은주1관 사이의 좁은 자리: 남쪽 끝에 S-MAP 평탄면 136.3 m. 북쪽은 135.0~137.7 로 읽힌다. 한림관 3층 = 은주1관 2층 연결(학교 설명)이 이 높이대. 무엇인지는 모름')):
    pl = big(pl.difference(DONE).difference(UNDER))
    HAND.append(dict(zone='upper-branch', name=nm, poly=pl, top=top, terrain=True, material='concrete', grade=gr, source=HSRC, assumption=ass, reason='Z04 한림관 둘레 낮은 통로: ' + nm))
HAND.append(dict(zone='upper-branch', name='HANLIM-1F', poly=big(sbox(201100.5, 557277.5, 201111.0, 557283.0).difference(UNDER)), top=127.2, terrain=True, material='paving',
    grade='확정(한림관 1층은 앞 길에서 계단 몇 개 위), S-MAP(126.9~127.5)', source=MESH + ', 건물 노트 한림관(1층 127.2 m), 05-한림관1층-가는길-네이버거리뷰-202506.webp',
    assumption='한림관 1층 로비 문 앞 단(계단 위): 127.2 m 한 높이. 범위는 S-MAP 평탄면(북좌표 557277~557282)과 건물 벽 사이(±1.5 m)', reason='Z04 한림관 1층 문 앞 단 127.2 m'))
HAND.append(dict(zone='yudam9', name='FORECOURT-9F', poly=big(sbox(201017.5, 557287.5, 201030.5, 557296.5).difference(UNDER)), top=129.2, terrain=True, material='paving',
    grade='확정(버스 정류장 쪽에서 들어간 자리가 유담관 9층), S-MAP(128.4~129.6)', source=MESH + ', 건물 노트 유담관(앞마당 x 201018~201030, 북좌표 557288~557296, 129.2 m)',
    assumption='유담관 9층 쪽 앞마당: 129.2 m 한 높이. 9층 문 자리는 모름. 제2주차장을 덮는 보행 길의 선도 모름(이 마당이 그 길의 일부로 보임, 추정)', reason='Z04 유담관 9층 쪽 앞마당 129.2 m'))
# 겹치는 조각은 먼저 만든 쪽이 가진다(갈림에서 본선이 우선)
_acc = PLAZA
for h in HAND[1:]:
    h['poly'] = big(h['poly'].difference(_acc.buffer(0))) if not h['poly'].difference(_acc).is_empty else h['poly'].buffer(-99); _acc = unary_union([_acc, h['poly']]) if not h['poly'].is_empty else _acc
HAND = [h for h in HAND if not h['poly'].is_empty and h['poly'].area >= 4]
HAND_UNION = unary_union([h['poly'] for h in HAND])
OCC = unary_union([DONE, FIELD, HAND_UNION]).buffer(0)

# ---------- 2. S-MAP 메시에서 평탄면·경사면 ----------
in_campus = contains_xy(CAMPUS.buffer(3), XS, YS); occ = contains_xy(OCC, XS, YS)
g = M.g & np.isfinite(Z) & in_campus & ~occ
def grow(mask, tol):
    lab = np.zeros(Z.shape, int); n = 0; H, W = Z.shape
    for sy, sx in zip(*np.nonzero(mask)):
        if lab[sy, sx]: continue
        n += 1; lab[sy, sx] = n; st = [(sy, sx)]
        while st:
            y, x = st.pop()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                v, u = y + dy, x + dx
                if 0 <= v < H and 0 <= u < W and mask[v, u] and not lab[v, u] and abs(Z[v, u] - Z[y, x]) <= tol: lab[v, u] = n; st.append((v, u))
    return lab, n
gy, gx = np.gradient(np.where(M.g, Z, np.nan)); slope = np.nan_to_num(np.hypot(gx, gy), nan=9)
FLAT_SLOPE, FLAT_MIN, RAMP_SLOPE, RAMP_MIN, REACH = 0.06, 16, 0.30, 25, 5.0
lab, n = grow(g & (slope <= FLAT_SLOPE), FLAT_SLOPE)
regs = {}; out = np.zeros(Z.shape, int)
def plane(m):
    ys, xs = np.nonzero(m); zz = Z[m]; A = np.c_[MX0 + xs, MY0 + ys, np.ones(len(xs))]; co, *_ = np.linalg.lstsq(A, zz, rcond=None); return co, float(np.percentile(np.abs(zz - A @ co), 90))
for k in range(1, n + 1):
    m = lab == k
    if m.sum() < FLAT_MIN: continue
    zz = Z[m]; i = len(regs) + 1
    if np.percentile(zz, 95) - np.percentile(zz, 5) <= 0.5: regs[i] = dict(kind='T', z=round(float(np.median(zz)), 1), n=int(m.sum()), p10=r2(np.percentile(zz, 10)), p90=r2(np.percentile(zz, 90)))
    else: co, res = plane(m); regs[i] = dict(kind='R', co=co, res=res, n=int(m.sum()), p10=r2(np.percentile(zz, 10)), p90=r2(np.percentile(zz, 90)))
    out[m] = i
lab2, n2 = grow(g & (out == 0) & (slope <= RAMP_SLOPE), RAMP_SLOPE)
SPLIT_RES, SPLIT_MIN = 0.40, 120
def add_ramp(m, depth=0):
    """경사면 후보. 평면 하나로 맞지 않으면(잔차 90 % > 0.40 m) 긴 쪽을 반으로 갈라 조각마다 평면 하나씩(길을 마디로 자르는 것과 같다)."""
    zz = Z[m]; co, res = plane(m)
    if res > SPLIT_RES and m.sum() >= SPLIT_MIN and depth < 5:
        ys, xs = np.nonzero(m); P = np.c_[xs, ys].astype(float); P -= P.mean(0); w, v = np.linalg.eigh(np.cov(P.T)); t = P @ v[:, -1]; cut = np.median(t)
        for side in (t <= cut, t > cut):
            mm = np.zeros_like(m); mm[ys[side], xs[side]] = True; lb, k = ndi.label(mm)
            for q in range(1, k + 1):
                if (lb == q).sum() >= 12: add_ramp(lb == q, depth + 1)
        return
    i = max(list(regs) + [int(out.max())]) + 1; regs[i] = dict(kind='R', co=co, res=res, n=int(m.sum()), p10=r2(np.percentile(zz, 10)), p90=r2(np.percentile(zz, 90))); out[m] = i
for i in [k for k, r in regs.items() if r['kind'] == 'R']:
    m = out == i; del regs[i]; out[m] = 0; add_ramp(m)
for k in range(1, n2 + 1):
    m = lab2 == k
    if m.sum() >= RAMP_MIN: add_ramp(m)
# 가파른 칸과 건물 모델 가장자리 칸을 가장 가까운 면에 붙인다(면끼리 벽으로 만나게, 건물 벽까지 닿게)
def attach(reach):
    dist, (iy, ix) = ndi.distance_transform_edt(out == 0, return_indices=True)
    tgt = (out == 0) & in_campus & ~occ & (dist <= reach) & (M.g | (dist <= 2.5)); f = out.copy(); f[tgt] = out[iy[tgt], ix[tgt]]; return f
full = attach(REACH)
# 그래도 남는 넓은 가파른 곳(비탈·계단식 화단): 높이 2 m 띠마다 한 단으로 나눈다. 실제 단의 수와 자리는 모른다(추정)
BAND = 2.0
rest = M.g & np.isfinite(Z) & in_campus & ~occ & (full == 0); lb, k = ndi.label(rest, structure=np.ones((3, 3)))
for q in range(1, k + 1):
    m = lb == q
    if m.sum() < 12: continue
    zz = Z[m]; lo_, hi_ = np.percentile(zz, [3, 97]); nb = max(1, int(np.ceil((hi_ - lo_) / BAND))); band = np.clip(((Z - lo_) / max(hi_ - lo_, 1e-6) * nb).astype(int), 0, nb - 1)
    for bnd in range(nb):
        l2, k2 = ndi.label(m & (band == bnd), structure=np.ones((3, 3)))
        for t in range(1, k2 + 1):
            mm = l2 == t
            if mm.sum() < 8: continue
            i = max(list(regs) + [int(out.max())]) + 1; z2 = Z[mm]; regs[i] = dict(kind='S', z=round(float(np.median(z2)), 1), n=int(mm.sum()), p10=r2(np.percentile(z2, 10)), p90=r2(np.percentile(z2, 90))); out[mm] = i
full = attach(12.0)
LEFT = int((M.g & np.isfinite(Z) & in_campus & ~occ & (full == 0)).sum())
AUTO = []
for i, r in regs.items():
    m = full == i
    if not m.any(): continue
    poly = shapely.union_all(shapely.box(XS[m] - .5, YS[m] - .5, XS[m] + .5, YS[m] + .5)); poly = big(poly.buffer(0.45).buffer(-0.45).simplify(0.6)).buffer(0.3, join_style=2).difference(OCC).difference(UNDER)
    if poly.is_empty: continue
    poly = big(poly)
    if poly.area < 12: continue
    if r['kind'] in 'TS': top = r['z']; lo = r['z']
    else:
        a, b, c0 = r['co']; gg = np.hypot(a, b); d = np.array([a, b]) / gg; o = np.array([poly.centroid.x, poly.centroid.y]); ext = (np.array(poly.exterior.coords) - o) @ d
        z0 = a * o[0] + b * o[1] + c0; zl, zh = max(z0 + gg * ext.min(), r['p10'] - 1.0), min(z0 + gg * ext.max(), r['p90'] + 1.0)   # 평면을 칸이 있는 높이 범위 밖으로 늘이지 않는다
        s0, s1 = (zl - z0) / gg, (zh - z0) / gg
        top = {'origin': [r2(o[0]), r2(o[1])], 'direction': [round(float(d[0]), 4), round(float(d[1]), 4)], 'points': [[r2(s0), r2(zl)], [r2(s1), r2(zh)]]}; lo = zl; r['slope'] = gg * 100
    AUTO.append(dict(zone=zone_of(poly.centroid.x, poly.centroid.y), poly=poly, top=top, lo=float(lo), reg=r, core=int((out == i).sum())))
print('regions', Counter(r['kind'] for r in regs.values()), 'auto platforms', len(AUTO), 'ground cells left without platform', LEFT)
exec((HERE / 'build_part2.py').read_text(encoding='utf-8'))
