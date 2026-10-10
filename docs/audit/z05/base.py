"""Z05 공용: Z04 의 입력(S-MAP 1 m 메시, 캠퍼스 외곽, 건물, 끝난 세 구역의 기단, 차도 종단)을 읽고, 손으로 정한 길 띠·마당(HAND)을 만든다. DB·네트워크 접근 없음."""
import sys, pathlib; HERE5 = pathlib.Path(__file__).parent; sys.path.insert(0, str(HERE5.parent / 'z04'))
from common import *
import shapely
from shapely.geometry import Polygon, LineString, Point, box as sbox
from shapely.ops import unary_union
from shapely import contains_xy
Z05 = AUDIT / 'z05'; Z05.mkdir(exist_ok=True)
REC = REPO / 'backend' / 'data' / 'terrain' / 'recipes'; STR = REPO / 'frontend' / 'public' / 'structures'
r2 = lambda v: round(float(v), 2)
dump = lambda path, obj: path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}
MESH = 'S-MAP 3D 뷰어 메시 1 m 판독(z04/smap-mesh-z04-1m-w0~e3.txt, 2026-10-11)'
def parts(g, min_area=0.0):
    g = g.buffer(0); return [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.geom_type == 'Polygon' and q.area > min_area]
def big(g):
    p = parts(g); return max(p, key=lambda q: q.area) if p else Polygon()
def geom(poly):
    rings = []
    for ring in [poly.exterior] + list(poly.interiors):
        c = [[r2(x), r2(y)] for x, y in ring.coords]; c[-1] = c[0]; rings.append(c)
    return {'type': 'Polygon', 'coordinates': rings}
M = Mesh(); Z = M.z
CAMPUS = Polygon(json.loads((HERE / 'campus-outline-5186.json').read_text(encoding='utf-8'))['ring'])
XS, YS = np.meshgrid(MX0 + np.arange(MNX), MY0 + np.arange(MNY))
BLD = building_polys(); BLD_ALL = unary_union(list(BLD.values()))
SCENE = json.loads((HERE / 'scene-buildings-before.json').read_text(encoding='utf-8'))['buildings']
DRAWN = unary_union([Polygon(b['ring']).buffer(0) for b in SCENE])
UNDER = DRAWN.buffer(-1.0)   # 기단은 건물 벽 안쪽 1 m 까지만 들어간다(벽 밑 틈 막기)
def feats_of(fn): return json.loads((STR / (fn + '.geojson')).read_text(encoding='utf-8'))['features']
DONE_F = [f for fn in ('g02-way', 'z02-daeil-front', 'z03-fountain') for f in feats_of(fn) if f['properties']['kind'] == 'platform' and f['properties']['id'] != 'G02-PLATFORM-PLAZA']
DONE = unary_union([Polygon(f['geometry']['coordinates'][0]).buffer(0) for f in DONE_F])
PLAT = {f['properties']['name']: Polygon(f['geometry']['coordinates'][0]) for f in json.loads((REC / 'f05-plateaus.geojson').read_text(encoding='utf-8'))['features']}
FIELD, PLAZA = PLAT['field'].buffer(0), big(PLAT['plaza'].buffer(0).difference(DONE))
LINES = {l['name']: np.array(l['points']) for l in json.loads((REC / 't06-road-corridors.json').read_text(encoding='utf-8'))['lines']}
_gy, _gx = np.gradient(np.where(M.g, Z, np.nan)); SLOPE = np.nan_to_num(np.hypot(_gx, _gy), nan=9)
def prof_z(pr, x, y):
    o, d, p = pr['origin'], pr['direction'], np.array(pr['points']); return np.interp((np.asarray(x) - o[0]) * d[0] + (np.asarray(y) - o[1]) * d[1], p[:, 0], p[:, 1])
def top_z(top, x, y): return prof_z(top, x, y) if isinstance(top, dict) else np.full(np.shape(x), float(top))
def plane_profile(poly, cells_poly=None, inset=1.0, clip=None):
    """다각형(또는 cells_poly) 안 땅 칸에 평면 하나를 맞춰 한 방향 경사 profile 로. 가운데값에서 먼 칸(나무·벽이 뭉개진 칸)은 한 번 걸러 다시 맞춘다. 돌려줌: profile, 경사 %, 잔차 90 %, 칸 수."""
    pp = (cells_poly or poly).buffer(-inset); m = contains_xy(pp, XS, YS) & M.g & np.isfinite(Z) & (SLOPE <= 0.30)   # 가파른 칸(벽·계단이 뭉개진 곳)은 맞춤에서 뺀다
    if m.sum() < 12: m = contains_xy(cells_poly or poly, XS, YS) & M.g & np.isfinite(Z)
    zz, xs, ys = Z[m], XS[m], YS[m]
    A = np.c_[xs, ys, np.ones(len(xs))]; co, *_ = np.linalg.lstsq(A, zz, rcond=None); res = zz - A @ co; k = np.abs(res) <= max(0.3, 2 * np.percentile(np.abs(res), 75))
    co, *_ = np.linalg.lstsq(A[k], zz[k], rcond=None); a, b, c = co; g = max(np.hypot(a, b), 1e-9); d = np.array([a, b]) / g; o = np.array([poly.centroid.x, poly.centroid.y]); z0 = a * o[0] + b * o[1] + c
    ext = (np.array(poly.exterior.coords) - o) @ d; smin, smax = ext.min(), ext.max(); zl, zh = z0 + g * smin, z0 + g * smax
    clip = clip or (float(np.percentile(zz[k], 2)) - 0.3, float(np.percentile(zz[k], 98)) + 0.3)   # 평면을 칸이 있는 높이 범위 밖으로 늘이지 않는다
    if clip: zl, zh = max(zl, clip[0]), min(zh, clip[1]); smin, smax = (zl - z0) / g, (zh - z0) / g
    return ({'origin': [r2(o[0]), r2(o[1])], 'direction': [round(float(d[0]), 4), round(float(d[1]), 4)], 'points': [[r2(smin), r2(zl)], [r2(smax), r2(zh)]]}, g * 100, float(np.percentile(np.abs(zz[k] - A[k] @ co), 90)), int(k.sum()))

# ---------- 손으로 정한 기단(HAND): Z04 와 같은 정의. 길 띠만 다르게 자른다 ----------
HAND = []
PLAZA_PROF, pl_slope, pl_res, pl_n = plane_profile(PLAZA)
V02 = 'docs/audit/v02/road-profile.geojson(사용자 S-MAP 핀으로 고른 종단), backend/data/terrain/recipes/t06-road-corridors.json'
GR = 'S-MAP·사용자 핀(종단, V02), 추정(폭)'
def dp(P, tol):
    """Douglas–Peucker(평면): 남길 꼭짓점 번호."""
    keep = [0, len(P) - 1]; st = [(0, len(P) - 1)]
    while st:
        i, j = st.pop()
        if j <= i + 1: continue
        a, b = P[i, :2], P[j, :2]; v = b - a; L = np.hypot(*v); d = np.abs(np.cross(P[i + 1:j, :2] - a, v / L)); k = int(np.argmax(d))
        if d[k] > tol: keep.append(i + 1 + k); st += [(i, i + 1 + k), (i + 1 + k, j)]
    return sorted(set(keep))
def ribbon(zone, key, line, half, grade, source, what, material='paving', clip=None, tol=0.3, overlap=0.25, left=None, right=None):
    """길 가운데 선(x, y, z)을 곧은 구간마다 한 조각으로(굽은 곳에서만 자른다). 조각의 윗면은 그 구간 방향의 종단(꼭짓점마다 높이), 폭 방향 평평.
    이웃 조각과는 overlap 만큼 겹쳐 틈이 없다. left/right = 가운데 선에서 왼쪽·오른쪽 폭(없으면 half)."""
    line = np.asarray(line, float); ln = LineString(line[:, :2]); idx = dp(line, tol); left = half if left is None else left; right = half if right is None else right
    rib = unary_union([ln.buffer(left, cap_style=2, single_sided=True), ln.buffer(-right, cap_style=2, single_sided=True)]).buffer(0.01).buffer(-0.01)
    if clip is not None: rib = rib.intersection(clip)
    V = line[idx]; n = len(V) - 1
    tang = [(V[min(i + 1, n)][:2] - V[max(i - 1, 0)][:2]) for i in range(n + 1)]; tang = [t / np.hypot(*t) for t in tang]
    for i in range(n):
        a, b = V[i], V[i + 1]; v = (b[:2] - a[:2]); L = np.hypot(*v); v = v / L; na, nb = np.array([-tang[i][1], tang[i][0]]), np.array([-tang[i + 1][1], tang[i + 1][0]]); R = max(left, right) + 6
        ea = overlap if i > 0 else 0.0; eb = overlap if i < n - 1 else 0.0
        slab = Polygon([a[:2] - v * ea + na * R, b[:2] + v * eb + nb * R, b[:2] + v * eb - nb * R, a[:2] - v * ea - na * R]).buffer(0)
        piece = big(rib.intersection(slab).difference(DONE))
        if piece.is_empty or piece.area < 4: continue
        seg = line[idx[i]:idx[i + 1] + 1]; s = (seg[:, :2] - a[:2]) @ v; pts = [[r2(s[0]), r2(seg[0, 2])]]
        for sk, zk in zip(s[1:], seg[1:, 2]):
            if sk > pts[-1][0] + 0.05: pts.append([r2(sk), r2(zk)])
        top = {'origin': [r2(a[0]), r2(a[1])], 'direction': [round(float(v[0]), 4), round(float(v[1]), 4)], 'points': pts}
        HAND.append(dict(zone=zone, name=f'{key}-{i + 1:02d}', poly=piece, top=top, material=material, grade=grade, source=source, road=key,
            assumption=f'{what}: 가운데 선의 곧은 구간 {i + 1}/{n}(길이 {L:.1f} m, {a[2]:.2f} → {b[2]:.2f} m), 폭 {left + right:.1f} m(추정), 폭 방향 평평. 이웃 조각과 {overlap} m 겹침', reason=f'Z05 {what} 구간 {i + 1}/{n}'))
