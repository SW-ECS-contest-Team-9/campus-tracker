"""V02 3·4(a)단계: 사용자 높이 핀을 가장 무겁게 써서 차도의 매끄러운 가운데 선과 종단(z(s))을 만든다.
   python build_road.py <볼트 audit 폴더> <저장소 루트>
   입력: 시험용 DB 의 지금 길(<audit>/n02/06-state-after.json, N02 뒤 상태), user-readings.json, E09 판독점(길 꼭짓점 높이), S-MAP 메시 격자.
   출력: road-profile.geojson, editor-ops.json, profile.json(1 m 간격 종단), results.json 의 road 절은 evaluate 단계에서 합친다.
   DB·서버 접근 없음."""
import sys, json, math, pathlib, warnings
import numpy as np
from scipy.interpolate import splprep, splev
from scipy.optimize import lsq_linear
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from surface import Surface
warnings.filterwarnings('ignore')
audit = pathlib.Path(sys.argv[1]); repo = pathlib.Path(sys.argv[2]); here = pathlib.Path(__file__).parent
state = json.loads((audit / 'n02/06-state-after.json').read_text(encoding='utf-8'))
ROADS = {r['id'][:8]: r for r in state['roads']}
NODES = {n['id']: n for n in state['nodes']}
UR = json.loads((here / 'user-readings.json').read_text(encoding='utf-8'))['points']
S = Surface(audit)
_pk = json.loads((repo / 'docs/audit/e09/picks.json').read_text(encoding='utf-8'))
PICKS = np.array([p for k in ('mainGate', 'mainFountain', 'mainBend', 'mainS06C1R4', 'mainPlaza', 'lowerPortalLane', 'p1Lane', 'p1ThresholdS07C1', 'upperBranch', 'upperBranchSouth') for p in _pk[k]])
LAM = float(sys.argv[3]) if len(sys.argv) > 3 else 10000.0
TOL = {'U1': 1.2}


def picks_on(line, c):
    out = []
    for p in PICKS:
        d, s = project(line, c, p[0], p[1])
        if d <= 2.0: out.append((s, float(p[2])))
    return np.array(sorted(out))
# 구간: 이름 -> 시험용 DB 길 id(앞 8자)들(이어서 한 줄로 다듬는다)
MAIN = [('V1', '729bd2ad'), ('V2', 'e934fcd3'), ('V3', '499ab1ab'), ('V4a', '07615440'), ('V4b', '67e234b5')]
BRANCH = [('P-LOW', '1b2219e1', 'V1'), ('P-UP', '192703b3', 'V3'), ('U1', '9713befb', 'V2')]  # (이름, 길, 시작 높이를 받는 본선 구간의 끝)
USER_SEG = {'V1': 'main', 'V2': 'main', 'V3': 'main', 'V4': 'main', 'P-LOW': 'P-LOW', 'U1': 'U1'}
PLAN_TOL = 0.8      # 다듬은 선이 지금 꼭짓점에서 벗어나도 되는 한도(m). E09 판독 평면 오차 가정 1.5 m, 차도 반폭 3.5 m 보다 작다
STEP = 2.5          # 새 꼭짓점 간격(m)
DISPLAY_DEFAULT_W = 6.0


def cum(p):
    return np.r_[0, np.cumsum(np.hypot(*np.diff(p[:, :2], axis=0).T))]


def smooth_plan(P, fixed, tol=PLAN_TOL):
    """P: (n,2). fixed: 꼭 지나야 하는 꼭짓점 번호. 3차 B-스플라인(곡률 연속)으로 다듬고, 꼭짓점 이탈이 PLAN_TOL 이하인 가장 매끄러운 것을 고른다."""
    u = cum(P); u = u / u[-1]
    w = np.ones(len(P)); w[list(fixed)] = 1000.0
    if len(P) < 4:
        dense = np.c_[np.interp(np.linspace(0, 1, 200), u, P[:, 0]), np.interp(np.linspace(0, 1, 200), u, P[:, 1])]
        return dense, 0.0
    lo, hi, best = 0.0, len(P) * 4.0, None
    for _ in range(40):
        s = (lo + hi) / 2
        tck, _ = splprep([P[:, 0], P[:, 1]], u=u, w=w, k=3, s=s)
        d = np.hypot(*(np.array(splev(u, tck)).T - P).T)
        if d.max() <= tol: best = (tck, s); lo = s
        else: hi = s
    tck = best[0] if best else splprep([P[:, 0], P[:, 1]], u=u, k=3, s=0)[0]
    t = np.linspace(0, 1, max(400, int(cum(P)[-1] / 0.2)))
    return np.array(splev(t, tck)).T, (best[1] if best else 0.0)


def project(line, c, x, y):
    """점을 꺾은선에 내린다 -> (거리, 누적 거리)."""
    a, b = line[:-1], line[1:]; d = b - a; L2 = (d ** 2).sum(1); L2[L2 == 0] = 1
    t = np.clip(((x - a[:, 0]) * d[:, 0] + (y - a[:, 1]) * d[:, 1]) / L2, 0, 1)
    q = a + t[:, None] * d; dist = np.hypot(x - q[:, 0], y - q[:, 1]); i = int(np.argmin(dist))
    return float(dist[i]), float(c[i] + t[i] * math.sqrt(L2[i]))


def at(line, c, s):
    return np.array([np.interp(s, c, line[:, 0]), np.interp(s, c, line[:, 1])]).T


def normal(line, c, s):
    e = 0.5; a = at(line, c, np.clip(s - e, 0, c[-1])); b = at(line, c, np.clip(s + e, 0, c[-1])); t = b - a; t /= np.hypot(*t.T)[:, None]
    return np.c_[-t[:, 1], t[:, 0]]


def turn_stats(line):
    c = cum(line); h = np.unwrap(np.arctan2(*np.diff(line, axis=0).T[::-1]))
    return float(np.degrees(np.abs(np.diff(h)).max())) if len(h) > 1 else 0.0, c


def curvature_stats(dense):
    c = cum(dense); s = np.arange(0, c[-1], 1.0); p = at(dense, c, s)
    h = np.unwrap(np.arctan2(*np.diff(p, axis=0).T[::-1])); k = np.abs(np.diff(h))  # 1 m 마다 방향 변화(rad/m)
    return (float(1 / k.max()) if len(k) and k.max() > 1e-6 else float('inf')), (float(np.degrees(k.max())) if len(k) else 0.0)


def fit_profile(L, data, fixed=(), monotone=True, lam=None):
    """1 m 간격 높이. 자료 (s, z, sigma). 경사가 매끄럽게 바뀌도록 '경사의 2차 차분'에 벌점, monotone 이면 내려가지 않게."""
    lam = LAM if lam is None else lam
    n = int(math.ceil(L)) + 1; g = np.linspace(0, L, n); h = g[1] - g[0]
    def row(s):
        r = np.zeros(n); k = min(n - 2, max(0, int(s / h))); t = s / h - k; r[k] = 1 - t; r[k + 1] = t; return r
    C = np.tril(np.ones((n, n)));  # z = C @ [z0, d1..d(n-1)]
    A, b = [], []
    for s, z, sg in data: A.append(row(min(max(s, 0), L)) @ C / sg); b.append(z / sg)
    for s, z in fixed: A.append(row(s) @ C * 1e3); b.append(z * 1e3)
    D2 = np.zeros((n - 3, n));
    for k in range(n - 3): D2[k, k + 1], D2[k, k + 2], D2[k, k + 3] = 1, -2, 1   # 경사 d 의 2차 차분
    D1 = np.zeros((n - 2, n))
    for k in range(n - 2): D1[k, k + 1], D1[k, k + 2] = -1, 1                     # 경사 변화
    A = np.vstack([np.array(A), math.sqrt(lam) * D2 / h, math.sqrt(lam * 0.05) * D1 / h]); b = np.r_[b, np.zeros(n - 3 + n - 2)]
    lb = np.r_[-np.inf, np.zeros(n - 1) if monotone else np.full(n - 1, -np.inf)]
    r = lsq_linear(A, b, bounds=(lb, np.full(n, np.inf)), lsmr_tol='auto')
    return g, C @ r.x


def mesh_along(line, c, half=1.5, step=2.0):
    s = np.arange(0, c[-1] + 1e-6, step); p = at(line, c, s); nrm = normal(line, c, s)
    z = np.array([S.at(p[:, 0] + o * nrm[:, 0], p[:, 1] + o * nrm[:, 1]) for o in (-half, 0, half)])
    med = np.nanmedian(z, axis=0); ok = ~np.isnan(med) & (np.nanmax(z, axis=0) - np.nanmin(z, axis=0) < 1.0)
    return s[ok], med[ok]


def flat_band(line, c, zs_fn, step=4.0, tol=0.35, reach=14.0):
    """가운데에서 양옆으로 0.5 m 씩 나가며 메시 높이가 가운데와 tol 넘게 달라지는(턱·옹벽·건물) 곳까지의 폭. 2 m 격자라 경계석(0.15 m)은 못 본다."""
    out = []
    for s in np.arange(2, c[-1] - 2, step):
        p = at(line, c, np.array([s]))[0]; nrm = normal(line, c, np.array([s]))[0]; z0 = float(S.at(p[0], p[1]))
        if math.isnan(z0): continue
        ext = []
        for sign in (-1, 1):
            o = 0.5
            while o <= reach:
                z = float(S.at(p[0] + sign * o * nrm[0], p[1] + sign * o * nrm[1]))
                if math.isnan(z) or abs(z - z0) > tol: break
                o += 0.5
            ext.append(o - 0.5)
        out.append(ext[0] + ext[1])
    return out


def grade_stats(g, z, win=15):
    d = np.diff(z) / np.diff(g) * 100
    i = int(np.argmax(np.abs(d))); res = {'max1mPct': round(float(d[i]), 1), 'max1mAtS': round(float(g[i]), 1)}
    if len(g) > win:
        w = (z[win:] - z[:-win]) / (g[win:] - g[:-win]) * 100; j = int(np.argmax(np.abs(w)))
        res.update({'max15mPct': round(float(w[j]), 1), 'max15mFromS': round(float(g[j]), 1)})
    res['avgPct'] = round(float((z[-1] - z[0]) / (g[-1] - g[0]) * 100), 1)
    res['over15pct_stations'] = [[round(float(g[a]), 1), round(float(g[b + 1]), 1)] for a, b in runs(np.abs(d) > 15)]
    res['maxGradeChangePctPerM'] = round(float(np.abs(np.diff(d)).max()), 2) if len(d) > 1 else 0.0
    return res


def runs(mask):
    out = []; a = None
    for i, m in enumerate(mask):
        if m and a is None: a = i
        if not m and a is not None: out.append((a, i - 1)); a = None
    if a is not None: out.append((a, len(mask) - 1))
    return out


# ---------------- 본선 ----------------
P = []; bounds = [0]
for name, rid in MAIN:
    c = np.array(ROADS[rid]['coordinates'])
    P.extend(c[(1 if P else 0):].tolist()); bounds.append(len(P) - 1)
P = np.array(P)
dense, s_par = smooth_plan(P[:, :2], bounds)
dc = cum(dense)
node_s = [project(dense, dc, *P[i, :2])[1] for i in bounds]; node_s[0] = 0.0; node_s[-1] = float(dc[-1])
user_main = []
for r in UR:
    if USER_SEG.get(r['segment']) != 'main': continue
    dist, s = project(dense, dc, r['x'], r['y'])
    user_main.append({**{k: r[k] for k in ('id', 'value_m', 'x', 'y', 'xy_err_m', 'surface')}, 'dist_m': round(dist, 2), 's': s, 'use': dist <= 6.0})
pm = picks_on(dense, dc); old_s, old_z = pm[:, 0], pm[:, 1]
ms, mz = mesh_along(dense, dc)
data = [(float(s), float(z), 0.30) for s, z in zip(old_s, old_z)] + [(float(s), float(z), 0.30) for s, z in zip(ms, mz)]
# 사용자 점: 한 번 거칠게 맞춰 경사를 얻고, 자리 오차를 높이 오차로 바꿔 무게를 정한다(가장 무겁다)
g0, z0 = fit_profile(dc[-1], data)
for u in user_main:
    if not u['use']: continue
    grade = abs(np.interp(u['s'] + 1, g0, z0) - np.interp(u['s'] - 1, g0, z0)) / 2
    u['sigma'] = round(math.sqrt(0.08 ** 2 + (grade * u['xy_err_m'] / math.sqrt(2)) ** 2), 3)
    data.append((u['s'], u['value_m'], u['sigma'] / 2.0))   # 무게 두 배(시그마 절반)
gm, zm = fit_profile(dc[-1], data)
zf = lambda s: np.interp(s, gm, zm)
for u in user_main: u['profile_z'] = round(float(zf(u['s'])), 2); u['profile_minus_user'] = round(float(zf(u['s'])) - u['value_m'], 2)

features, ops_nodes, ops_roads, prof, summary = [], {}, [], {}, {}


def emit(name, rid, line, c, s0, s1, zfn, extra):
    road = ROADS[rid]; n = max(1, int(round((s1 - s0) / STEP))); ss = np.linspace(s0, s1, n + 1)
    old = np.array(road['coordinates'])
    if len(old) < 4: ss = np.array([project(line, c, *p[:2])[1] for p in old]); ss[0], ss[-1] = s0, s1   # 짧은 길(P-UP)은 평면을 그대로 두고 높이만
    xy = at(line, c, ss); z = zfn(ss)
    xy[0], xy[-1] = old[0, :2], old[-1, :2]                       # 양 끝(노드)의 평면 자리는 그대로
    coords = [[round(float(a), 2), round(float(b), 2), round(float(k), 2)] for (a, b), k in zip(xy, z)]
    oc = cum(old); newline = np.array(coords)[:, :2]; nc = cum(newline)
    dev_old = max(project(newline, nc, *p[:2])[0] for p in old)   # 지금 꼭짓점이 새 선에서 벗어난 거리
    dev_new = max(project(old[:, :2], oc, *p)[0] for p in newline)
    dz_old = [float(zfn(project(line, c, *p[:2])[1]) - p[2]) for p in old]
    fb = flat_band(line[(c >= s0) & (c <= s1)], c[(c >= s0) & (c <= s1)] - s0, None) if s1 - s0 > 8 else []
    width = road['widthM']
    g = np.arange(s0, s1 + 1e-6, 1.0); gs = grade_stats(g - s0, zfn(g)) if len(g) > 2 else {}
    props = {'id': name, 'roadId': road['id'], 'fromNodeId': road['fromNodeId'], 'toNodeId': road['toNodeId'], 'lengthM': round(float(nc[-1]), 2), 'vertices': len(coords),
             'zStart': coords[0][2], 'zEnd': coords[-1][2], 'grade': gs, 'widthM_stored': width,
             'flatBandWidthM': ({'n': len(fb), 'median': round(float(np.median(fb)), 1), 'p25': round(float(np.percentile(fb, 25)), 1), 'p75': round(float(np.percentile(fb, 75)), 1)} if fb else None),
             'plan': {'maxDeviationOfOldVertexM': round(dev_old, 2), 'maxDeviationOfNewVertexM': round(dev_new, 2), 'maxTurnAtOldVertexDeg': round(turn_stats(old[:, :2])[0], 1),
                      'maxTurnAtNewVertexDeg': round(turn_stats(newline)[0], 1)},
             'zChangeAtOldVertices': {'min': round(min(dz_old), 2), 'max': round(max(dz_old), 2), 'medianAbs': round(float(np.median(np.abs(dz_old))), 2)},
             'kind': 'vehicle-road', 'accuracyVerified': False, **extra}
    features.append({'type': 'Feature', 'properties': props, 'geometry': {'type': 'LineString', 'coordinates': coords}})
    for nid, cc in ((road['fromNodeId'], coords[0]), (road['toNodeId'], coords[-1])):
        ops_nodes.setdefault(nid, {'nodeId': nid, 'now': NODES[nid]['coordinate'], 'to': cc, 'roads': []})['roads'].append(name)
    ops_roads.append({'id': 'V02-' + name, 'op': 'update_road', 'segment': name,
                      'preState': {'revision': road['revision'], 'vertexCount': len(old), 'lengthM': road['lengthM'], 'first': old[0].tolist(), 'last': old[-1].tolist(), 'widthM': road['widthM']},
                      'args': {'id': road['id'], 'expectedRevision': road['revision'], 'path': [{'xy': c[:2], 'z': c[2]} for c in coords], 'zMode': 'explicit', 'densify': False}})
    prof[name] = {'s': [round(float(v - s0), 1) for v in g], 'z': [round(float(v), 3) for v in zfn(g)]}
    return props


for k, (name, rid) in enumerate(MAIN):
    emit(name, rid, dense, dc, node_s[k], node_s[k + 1], zf, {'line': 'main', 'mainStationStartM': round(node_s[k], 1)})
minR, maxk = curvature_stats(dense)
summary['main'] = {'lengthM': round(float(dc[-1]), 1), 'junctionStationsM': [round(v, 1) for v in node_s], 'junctionHeightsM': [round(float(zf(v)), 2) for v in node_s],
                   'grade': grade_stats(gm, zm), 'minRadiusM': round(minR, 1), 'maxHeadingChangeDegPerM': round(maxk, 1),
                   'userPoints': user_main, 'data': {'e09_picks': len(old_s), 'mesh_samples': len(ms), 'user_points_used': sum(u['use'] for u in user_main)},
                   'residualAtAutomated': {'e09_pick_medianAbs': round(float(np.median(np.abs(zf(old_s) - old_z))), 2), 'e09_pick_maxAbs': round(float(np.abs(zf(old_s) - old_z).max()), 2),
                                           'mesh_medianAbs': round(float(np.median(np.abs(zf(ms) - mz))), 2), 'mesh_p90Abs': round(float(np.percentile(np.abs(zf(ms) - mz), 90)), 2), 'mesh_maxAbs': round(float(np.abs(zf(ms) - mz).max()), 2)}}
prof['main'] = {'s': [round(float(v), 1) for v in gm], 'z': [round(float(v), 3) for v in zm], 'xy': [[round(float(a), 2), round(float(b), 2)] for a, b in at(dense, dc, gm)]}
JZ = {'V1': float(zf(node_s[1])), 'V2': float(zf(node_s[2])), 'V3': float(zf(node_s[3]))}

# ---------------- 갈래 ----------------
for name, rid, parent in BRANCH:
    old = np.array(ROADS[rid]['coordinates'])
    bd, _ = smooth_plan(old[:, :2], [0, len(old) - 1], TOL.get(name, PLAN_TOL)); bc = cum(bd)
    us = []
    for r in UR:
        if USER_SEG.get(r['segment']) != name: continue
        dist, s = project(bd, bc, r['x'], r['y'])
        us.append({**{k: r[k] for k in ('id', 'value_m', 'x', 'y', 'xy_err_m', 'surface')}, 'dist_m': round(dist, 2), 's': s, 'use': dist <= 6.0})
    pb = picks_on(bd, bc); pb = pb[pb[:, 0] > 3.5] if len(pb) else np.zeros((0, 2)); os_, oz_ = pb[:, 0], pb[:, 1]; bs, bz = mesh_along(bd, bc)
    mono = name == 'U1'
    data = [(float(s), float(z), 0.30) for s, z in zip(os_, oz_)] + [(float(s), float(z), 0.30) for s, z in zip(bs, bz) if s > 3.5]  # 처음 3.5 m 는 본선 차로 위
    fixed = [(0.0, JZ[parent])]
    lam = LAM
    if name == 'P-UP': data = [(float(bc[-1]), float(old[-1, 2]), 0.3)]
    g0, z0 = fit_profile(bc[-1], data, fixed, mono, lam)
    for u in us:
        if not u['use']: continue
        grade = abs(np.interp(u['s'] + 1, g0, z0) - np.interp(u['s'] - 1, g0, z0)) / 2
        u['sigma'] = round(math.sqrt(0.08 ** 2 + (grade * u['xy_err_m'] / math.sqrt(2)) ** 2), 3); data.append((u['s'], u['value_m'], u['sigma'] / 2.0))
    gb, zb = fit_profile(bc[-1], data, fixed, mono, lam)
    zfb = lambda s, gb=gb, zb=zb: np.interp(s, gb, zb)
    for u in us: u['profile_z'] = round(float(zfb(u['s'])), 2); u['profile_minus_user'] = round(float(zfb(u['s'])) - u['value_m'], 2)
    emit(name, rid, bd, bc, 0.0, float(bc[-1]), zfb, {'line': name, 'startsAtMainJunctionOf': parent})
    minR, maxk = curvature_stats(bd)
    summary[name] = {'lengthM': round(float(bc[-1]), 1), 'zStart': round(float(zfb(0)), 2), 'zEnd': round(float(zfb(bc[-1])), 2), 'grade': grade_stats(gb, zb), 'minRadiusM': round(minR, 1),
                     'userPoints': us, 'residualAtAutomated': {'e09_pick_maxAbs': (round(float(np.abs(zfb(os_) - oz_).max()), 2) if len(os_) else None),
                                                               'mesh_p90Abs': round(float(np.percentile(np.abs(zfb(bs) - bz), 90)), 2) if len(bs) else None, 'mesh_maxAbs': round(float(np.abs(zfb(bs) - bz).max()), 2) if len(bs) else None}}
    prof[name] = {'s': [round(float(v), 1) for v in gb], 'z': [round(float(v), 3) for v in zb], 'xy': [[round(float(a), 2), round(float(b), 2)] for a, b in at(bd, bc, gb)]}

# ---------------- 선택 제안: 윗길에서 풋살장 쪽으로(사용자 핀 4개) ----------------
ext = sorted([r for r in UR if r['segment'] == 'U1-EXT'], key=lambda r: r['y'], reverse=True)
if ext:
    u1end = features[-1]['geometry']['coordinates'][-1]
    coords = [u1end] + [[r['x'], r['y'], r['value_m']] for r in ext]
    z = np.maximum.accumulate([c[2] for c in coords])  # 내려가지 않게(마지막 132.2 → 132.1 은 0.1 m 차라 132.2 로 둔다)
    coords = [[c[0], c[1], round(float(k), 2)] for c, k in zip(coords, z)]
    features.append({'type': 'Feature', 'properties': {'id': 'U1-EXT', 'roadId': None, 'optional': True, 'lengthM': round(float(cum(np.array(coords))[-1]), 1),
                     'note': '사용자 핀 4개(두 캡처에서 자리 차 3 m 이내)를 그대로 이은 선. E09 제안·시험용 DB 에 없는 구간. 폭·포장 경계 미확인. 만들지는 사용자 확인 뒤', 'kind': 'vehicle-road', 'accuracyVerified': False},
                     'geometry': {'type': 'LineString', 'coordinates': coords}})

for nid, o in ops_nodes.items():
    features.append({'type': 'Feature', 'properties': {'id': 'node-' + nid[:8], 'nodeId': nid, 'roads': o['roads'], 'zNow': o['now'][2], 'zNew': o['to'][2], 'dz': round(o['to'][2] - o['now'][2], 2)},
                     'geometry': {'type': 'Point', 'coordinates': o['to']}})
json.dump({'type': 'FeatureCollection', 'name': 'v02-road-profile', 'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::5186'}}, 'features': features},
          open(here / 'road-profile.geojson', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
others = {}
for r in state['roads']:
    for nid in (r['fromNodeId'], r['toNodeId']):
        if nid in ops_nodes and r['id'][:8] not in [x[1] for x in MAIN] + [x[1] for x in BRANCH]: others.setdefault(nid, []).append({'id': r['id'], 'name': r.get('name'), 'roadClass': r['roadClass']})
moves = [{'id': 'V02-node-' + nid[:8], 'op': 'move_node', 'preState': {'coordinate': o['now'], 'otherRoadsOnNode': others.get(nid, [])}, 'dz': round(o['to'][2] - o['now'][2], 2),
          'args': {'nodeId': nid, 'to': {'xy': o['now'][:2], 'z': o['to'][2]}}} for nid, o in ops_nodes.items() if abs(o['to'][2] - o['now'][2]) >= 0.05]
json.dump({'title': 'V02 차도를 매끄러운 선·종단으로 바꾸는 편집 제안(시험용 DB)', 'applied': False, 'requiresUserApproval': True,
           'basedOn': {'state': '3d-map-audit-20261009/n02/06-state-after.json (N02 뒤 시험용 DB, ' + state['at'] + ')', 'coordinatePrecisionM': 0.01},
           'howToApply': '편집기 MCP apply_changes 에 operations[].{op,args} 를 순서대로. 먼저 dryRun=true. 1) move_node 로 만나는 점의 높이만 바꾼다(평면 자리 그대로, 붙은 길 끝이 같이 움직인다). '
                         '2) update_road 로 각 길의 꼭짓점을 통째로 바꾼다(zMode explicit, densify false). move_node 가 붙은 길의 revision 을 올리므로 expectedRevision 은 적용 직전 get_feature 로 다시 읽어 넣는다(여기 값은 N02 뒤 상태). '
                         'N02 가 그 뒤에 길을 더 바꿨으면 preState 와 다를 수 있다: 다르면 멈추고 다시 만든다. 운영 DB 에는 쓰지 않는다.',
           'operations': moves + ops_roads}, open(here / 'editor-ops.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
json.dump(prof, open(here / 'profile.json', 'w', encoding='utf-8'), ensure_ascii=False)
json.dump({'planTolM': PLAN_TOL, 'vertexStepM': STEP, 'segments': {f['properties']['id']: f['properties'] for f in features if f['geometry']['type'] == 'LineString'},
           'lines': summary, 'nodeMoves': [{'nodeId': m['args']['nodeId'], 'dz': m['dz'], 'zNew': m['args']['to']['z'], 'others': len(m['preState']['otherRoadsOnNode'])} for m in moves]},
          open(here / 'road-summary.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for k, v in summary.items():
    print(k, 'L', v['lengthM'], 'grade', v['grade'], 'R', v.get('minRadiusM'))
    for u in v['userPoints']: print('   ', u['id'], u['value_m'], 's %.1f' % u['s'], 'd', u['dist_m'], 'use', u['use'], 'sig', u.get('sigma'), 'res', u['profile_minus_user'])
    print('   auto', v['residualAtAutomated'])
print('junction', summary['main']['junctionStationsM'], summary['main']['junctionHeightsM'])
for f in features:
    p = f['properties']
    if f['geometry']['type'] == 'LineString' and p.get('roadId'): print(p['id'], p['lengthM'], p['vertices'], p['zStart'], p['zEnd'], p['plan'], p['zChangeAtOldVertices'], p['flatBandWidthM'], p['widthM_stored'])
for m in moves: print(m['id'], m['dz'], len(m['preState']['otherRoadsOnNode']))
