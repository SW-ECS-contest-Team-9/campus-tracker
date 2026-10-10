"""V02: 사용자 캡처의 카메라를 되찾아 핀 바닥점을 EPSG:5186 좌표로 옮긴다.
   python georef.py <볼트 audit 폴더> <readings_XX.json> <출력 json> [확인용 png]
   방법: 바늘구멍 카메라(눈 위치 x,y, 방향, 시야각; 높이·기울기는 화면 글자에서 시작).
   각 핀의 시선을 '핀 값과 같은 높이의 수평면'과 만나게 해 XY 를 얻고, 그 자리의 S-MAP 메시 지면 높이가 핀 값과 같아지도록 카메라를 맞춘다.
   (핀 값 = S-MAP 표고, 메시 지면 = 같은 계열 자료. 위치를 값으로 맞춘 것이므로 '값 일치'는 독립 확인이 아니다. 독립 확인은 건물 외곽·차도 겹쳐 보기와 표고 조회.)"""
import sys, json, math, pathlib, warnings
import numpy as np
from scipy.optimize import least_squares
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from surface import Surface
warnings.filterwarnings('ignore')


def rays(par, uv, size):
    ex, ey, ez, h, p, fov, cx, cy = par
    W, H = size
    F = (H / 2) / math.tan(math.radians(fov) / 2)
    xc = (uv[:, 0] - (W / 2 + cx)) / F; yc = ((H / 2 + cy) - uv[:, 1]) / F
    hr, pr = math.radians(h), math.radians(p)
    f = np.array([math.sin(hr) * math.cos(pr), math.cos(hr) * math.cos(pr), -math.sin(pr)])
    r = np.array([math.cos(hr), -math.sin(hr), 0.0])
    up = np.cross(r, f)
    return f[None, :] + xc[:, None] * r[None, :] + yc[:, None] * up[None, :]


def to_world(par, uv, z, size):
    d = rays(par, uv, size)
    t = (par[2] - z) / (-d[:, 2])
    return np.c_[par[0] + t * d[:, 0], par[1] + t * d[:, 1]]


def project(par, xyz, size):
    ex, ey, ez, h, p, fov, cx, cy = par
    W, H = size
    F = (H / 2) / math.tan(math.radians(fov) / 2)
    hr, pr = math.radians(h), math.radians(p)
    f = np.array([math.sin(hr) * math.cos(pr), math.cos(hr) * math.cos(pr), -math.sin(pr)])
    r = np.array([math.cos(hr), -math.sin(hr), 0.0]); up = np.cross(r, f)
    v = np.asarray(xyz, float) - np.array([ex, ey, ez])
    zc = v @ f
    return np.c_[W / 2 + cx + F * (v @ r) / zc, H / 2 + cy - F * (v @ up) / zc]


def fit(S, uv, val, size, alt, tilt, use, free_centre=False, log=print):
    def cost(par, cap=3.0):
        xy = to_world(par, uv[use], val[use], size)
        dz = S.at(xy[:, 0], xy[:, 1]) - val[use]
        return np.where(np.isnan(dz), cap, np.clip(dz, -cap, cap))
    best = []
    for fov in (15, 20, 25, 30, 37, 45, 55):
        for h in range(0, 360, 6):
            par0 = [0, 0, alt, h, tilt, fov, 0, 0]
            d = rays(par0, uv[use], size); t = (alt - val[use]) / (-d[:, 2]); off = d[:, :2] * t[:, None]
            # 눈 위치 후보: 격자 전체(4 m)
            gx, gy = np.meshgrid(np.arange(200960, 201270, 4.0), np.arange(557090, 557420, 4.0))
            c = off.mean(axis=0)
            ex = gx.ravel() - c[0]; ey = gy.ravel() - c[1]
            X = ex[:, None] + off[None, :, 0]; Y = ey[:, None] + off[None, :, 1]
            dz = S.at(X, Y) - val[use][None, :]
            sc = np.where(np.isnan(dz), 3.0, np.clip(np.abs(dz), 0, 3.0)).mean(axis=1)
            k = int(np.argmin(sc)); best.append((float(sc[k]), [float(ex[k]), float(ey[k]), alt, h, tilt, fov, 0, 0]))
    best.sort(key=lambda b: b[0])
    log('coarse best:', [(round(b[0], 2), [round(v, 1) for v in b[1]]) for b in best[:5]])
    out = []
    for sc, p0 in best[:8]:
        idx = [0, 1, 3, 5] + ([4] if True else []) + ([6, 7] if free_centre else [])
        def res(q):
            par = list(p0)
            for i, v in zip(idx, q): par[i] = v
            return np.r_[cost(par), (par[4] - tilt) / 1.0 * 0.3]
        q0 = [p0[i] for i in idx]
        for _ in range(3):
            r = least_squares(res, q0, loss='soft_l1', f_scale=0.3, diff_step=1e-3, x_scale=[5, 5, 1, 2, 1, 20, 20][:len(idx)])
            q0 = r.x
        par = list(p0)
        for i, v in zip(idx, r.x): par[i] = float(v)
        c = cost(par)
        out.append((float(np.median(np.abs(c))), float(np.sqrt(np.mean(c ** 2))), par))
    out.sort(key=lambda o: o[1])
    return out


if __name__ == '__main__':
    audit, rd, outp = sys.argv[1:4]
    R = json.loads(pathlib.Path(rd).read_text(encoding='utf-8'))
    S = Surface(audit)
    uv = np.array([[p['u'], p['v']] for p in R['pins']]); val = np.array([p['value'] for p in R['pins']])
    use = np.array([not p.get('skip_fit', False) for p in R['pins']])
    from PIL import Image
    size = Image.open(pathlib.Path(audit) / R.get('path', R['image'])).size
    sols = fit(S, uv, val, size, R['ui']['altitude_m'], R['ui']['tilt_deg'], use, free_centre=R.get('free_centre', False))
    for s in sols[:4]: print('fit: med|dz| %.2f rms %.2f' % s[:2], [round(v, 2) for v in s[2]])
    par = sols[0][2]
    xy = to_world(par, uv, val, size); zs = S.at(xy[:, 0], xy[:, 1])
    # 화면 3 px 가 땅에서 몇 m 인지(핀별)
    e = np.hypot(*(to_world(par, uv + [3, 3], val, size) - xy).T)
    pins = []
    for p, q, z, k in zip(R['pins'], xy, zs, e):
        pins.append({**p, 'x': round(float(q[0]), 2), 'y': round(float(q[1]), 2), 'mesh_z_at_xy': None if np.isnan(z) else round(float(z), 2), 'px3_m': round(float(k), 2)})
        print(p['value'], pins[-1]['x'], pins[-1]['y'], pins[-1]['mesh_z_at_xy'])
    json.dump({'image': R['image'], 'card': R.get('card'), 'camera': dict(zip(['eye_x', 'eye_y', 'eye_z', 'heading_deg', 'tilt_deg', 'fov_deg', 'cx_off', 'cy_off'], par)),
               'fit': {'median_abs_dz': sols[0][0], 'rms_dz': sols[0][1], 'n_used': int(use.sum())}, 'size': list(size), 'pins': pins},
              open(outp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
