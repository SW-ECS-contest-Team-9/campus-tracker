"""V02: 사진 13(한림관 가는 길 높이 표시)의 카메라 맞춤. 화면 글자가 없어 핀 6개와 한림관 지붕 원 둘을 같이 쓴다.
   python georef_p13.py <볼트 audit 폴더> readings_P13.json <출력 json>"""
import sys, json, math, pathlib, warnings
import numpy as np
from scipy.optimize import least_squares
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from surface import Surface
from georef import to_world, project
warnings.filterwarnings('ignore')
audit, rd, outp = sys.argv[1:4]
R = json.loads(pathlib.Path(rd).read_text(encoding='utf-8'))
S = Surface(audit)
uv = np.array([[p['u'], p['v']] for p in R['pins']]); val = np.array([p['value'] for p in R['pins']])
size = (669, 570); FOV = 43.7
C = R['controls']

def res(q, full=False):
    ex, ey, ez, h, tilt, cx, cy = q  # 잘린 캡처라 화면 중심도 같이 맞춘다
    par = [ex, ey, ez, h, tilt, FOV, cx, cy]
    xy = to_world(par, uv, val, size); dz = S.at(xy[:, 0], xy[:, 1]) - val
    dz = np.where(np.isnan(dz), 3.0, np.clip(dz, -3, 3)) / 0.15
    out = [dz]
    for c in C:
        p = project(par, [c['xyz']], size)[0]
        out.append((p - [c['u'], c['v']]) / 5.0)
        # 반지름: 중심에서 화면 오른쪽 방향으로 radius_m 떨어진 점까지의 픽셀 거리
        hr = math.radians(h); rt = np.array([math.cos(hr), -math.sin(hr), 0.0])
        q2 = project(par, [np.array(c['xyz']) + rt * c['radius_m']], size)[0]
        out.append([(np.hypot(*(q2 - p)) - c['radius_px']) / 4.0])
    return np.concatenate([np.ravel(o) for o in out])

best = None
for h in range(270, 361, 10):
    for tilt in (60, 68, 76, 84):
        for ez in (250, 320, 400):
            hr, tr = math.radians(h), math.radians(tilt)
            D = (ez - 123) / math.sin(tr)
            ex = 201095 - D * math.cos(tr) * math.sin(hr); ey = 557275 - D * math.cos(tr) * math.cos(hr)
            try:
                r = least_squares(res, [ex, ey, ez, h, tilt, 0, 0], x_scale=[5, 5, 10, 2, 2, 30, 30], loss='soft_l1', f_scale=1.0, diff_step=1e-3)
            except Exception: continue
            if best is None or r.cost < best.cost: best = r
q = best.x; par = [*q[:5], FOV, q[5], q[6]]
xy = to_world(par, uv, val, size); zs = S.at(xy[:, 0], xy[:, 1])
print('camera', [round(float(v), 2) for v in q], 'cost', round(best.cost, 2))
print('residuals', np.round(res(q), 2))
pins = []
for p, a, z in zip(R['pins'], xy, zs):
    pins.append({**p, 'x': round(float(a[0]), 2), 'y': round(float(a[1]), 2), 'mesh_z_at_xy': None if np.isnan(z) else round(float(z), 2)})
    print(p['value'], pins[-1]['x'], pins[-1]['y'], pins[-1]['mesh_z_at_xy'])
dz = zs - val
json.dump({'image': R['image'], 'card': 'P13', 'camera': dict(zip(['eye_x', 'eye_y', 'eye_z', 'heading_deg', 'tilt_deg', 'cx_off', 'cy_off'], map(float, q)), fov_deg=FOV),
           'fit': {'median_abs_dz': float(np.nanmedian(np.abs(dz))), 'rms_dz': float(np.sqrt(np.nanmean(dz ** 2))), 'n_used': len(val), 'controls': len(C)}, 'size': list(size), 'pins': pins},
          open(outp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
