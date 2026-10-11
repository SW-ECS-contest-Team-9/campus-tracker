"""U05: 사용자가 띄운 지하 2층 화면 위에 그린 붉은 선(볼트 그림 07, 원본 화면 06)을 좌표로 읽는다. 볼트의 그림은 읽기만 한다(저장소에 넣지 않는다).   python strokes.py
방법: 원본 화면(06)에서 판의 짙은 외곽선 화소를 고르고, 구획 파일의 지하 2층 외곽(0.5 m 간격 점)이 그 선 위에 오도록 평면 사영 변환(8 값)을 맞춘다 → 06 과 07 의 차에서 붉은 화소를 골라 좌표로 옮긴다.
쓰는 파일: strokes.json (맞춤 잔차, 선 1·선 1b 의 직선 맞춤, 고리의 서쪽 벽 기준 자리). build_parts.py 의 축 방향은 여기서 나온 값이다.
주의: 구획 파일(zones.geojson)이 U05 로 바뀐 뒤에 다시 돌리면 외곽이 달라 맞춤이 어긋난다. 저장된 strokes.json 은 U04 때의 외곽(구조물 파일 커밋 23b9a6c)으로 맞춘 값이다."""
import json, pathlib, subprocess
import numpy as np, cv2
from PIL import Image
from scipy.optimize import least_squares
from shapely.geometry import Polygon
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
SRC = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/사용자-운동장지하-20261012')
r2 = lambda v: round(float(v), 2)
clean = np.array(Image.open(SRC / '06-띄운-지하2층-원본화면.png').convert('RGB')).astype(int); drawn = np.array(Image.open(SRC / '07-띄운-지하2층-사용자-붉은선.png').convert('RGB')).astype(int)
zones = json.loads(subprocess.run(['git', '-C', str(REPO), 'show', '23b9a6c:frontend/public/zones.geojson'], capture_output=True).stdout.decode('utf-8'))
ring = np.array(next(f for f in zones['features'] if f['properties']['id'] == 'b2')['geometry']['coordinates'][0][0]); O = np.array([201190.0, 557240.0])
seed_w = np.array([[201144.72, 557298.4], [201242.87, 557257.07], [201197.28, 557177.35], [201137.0, 557231.13]]) - O; seed_px = np.array([[341, 165], [780, 350], [576, 708], [308, 467]], float)   # 판 모서리 넷(눈으로 고른 시작 값)
H0, _ = cv2.findHomography(seed_w, seed_px)
line = (np.abs(clean - np.array([0x1f, 0x29, 0x37])).max(2) < 26).astype(np.uint8); line[:, :262] = 0; line[:150, :] = 0; line[720:, :] = 0   # 패널·화면 밖을 가림
dt = cv2.distanceTransform(1 - line, cv2.DIST_L2, 5)
poly = Polygon(ring - O); pts = np.array([poly.exterior.interpolate(s).coords[0] for s in np.arange(0, poly.exterior.length, 0.5)])
def proj(h, p): Hm = np.append(h, 1).reshape(3, 3); q = np.c_[p, np.ones(len(p))] @ Hm.T; return q[:, :2] / q[:, 2:]
def res(h): q = proj(h, pts); return np.minimum(cv2.remap(dt, np.clip(q[:, 0], 0, 914).astype(np.float32).reshape(-1, 1), np.clip(q[:, 1], 0, 780).astype(np.float32).reshape(-1, 1), cv2.INTER_LINEAR).ravel(), 6)
fit = least_squares(res, (H0 / H0[2, 2]).ravel()[:8], x_scale=np.abs((H0 / H0[2, 2]).ravel()[:8]) + 1e-6, loss='soft_l1'); H = np.append(fit.x, 1).reshape(3, 3); Hi = np.linalg.inv(H)
c = proj(fit.x, np.array([[0.0, 0.0], [1.0, 0.0]])); PX_PER_M = float(np.hypot(*(c[1] - c[0])))
red = (np.abs(clean - drawn).max(2) > 40) & (drawn[:, :, 0] > 180) & (drawn[:, :, 1] < 90)
n, lab = cv2.connectedComponents(red.astype(np.uint8), connectivity=8); strokes = []
for k in range(1, n):
    ys, xs = np.nonzero(lab == k)
    if len(xs) < 60: continue
    w = np.c_[xs, ys, np.ones(len(xs))] @ Hi.T; strokes.append(w[:, :2] / w[:, 2:] + O)
strokes.sort(key=lambda w: -w[:, 0].max()); long1, short1, loop = strokes[0], strokes[1], strokes[2]   # 동쪽 끝이 먼 차례: 긴 선, 짧은 선, 고리
P0 = np.array([201100.3, 557327.58])   # 본관 옆 구간(951c157d)의 위 끝
u, s, vt = np.linalg.svd(long1 - P0, full_matrices=False); d = vt[0] if vt[0][0] > 0 else -vt[0]; nrm = np.array([-d[1], d[0]])   # P0 를 지나는 직선 가운데 긴 선에 가장 잘 맞는 것
def own(w): c0 = w.mean(0); _, sv, v = np.linalg.svd(w - c0); dd = v[0] if v[0][0] > 0 else -v[0]; t = (w - c0) @ dd; return {'from': [r2(x) for x in c0 + dd * t.min()], 'to': [r2(x) for x in c0 + dd * t.max()], 'lengthM': r2(np.ptp(t)), 'azimuthSouthOfEastDeg': r2(np.degrees(np.arctan2(-dd[1], dd[0])))}
WA, WB = np.array([201140.1, 557255.5]), np.array([201146.2, 557293.5]); wd = (WB - WA) / np.hypot(*(WB - WA)); e = np.array([wd[1], -wd[0]]); sl, xl = (loop - WA) @ wd, (loop - WA) @ e
bins = {}
for lo in np.arange(-14, 36, 4):
    m = (sl >= lo) & (sl < lo + 4)
    if m.sum(): xs_ = np.sort(xl[m]); bins[f'{lo:.0f}~{lo + 4:.0f}'] = [r2(g.mean()) for g in np.split(xs_, np.nonzero(np.diff(xs_) > 1.2)[0] + 1)]
outer = [min(v) for k, v in bins.items() if 2 <= float(k.split('~')[0]) <= 24]
out = {'image': '데이터/보완자료/3d-map-audit-20261009/사용자-운동장지하-20261012/07-띄운-지하2층-사용자-붉은선.png', 'fit': {'meanPx': r2(res(fit.x).mean()), 'p90Px': r2(np.percentile(res(fit.x), 90)), 'pxPerM': r2(PX_PER_M), 'residualM': r2(res(fit.x).mean() / PX_PER_M), 'handDrawnM': '±1~3 (가닥 굵기 1 m, 두 번 그은 가닥의 차)'},
       'line1': {**own(long1), 'throughP0': {'direction': [float(d[0]), float(d[1])], 'azimuthSouthOfEastDeg': r2(np.degrees(np.arctan2(-d[1], d[0])))}, 'rmsOffAxisM': r2(np.sqrt((((long1 - P0) @ nrm) ** 2).mean())), 'rangeOffAxisM': [r2(((long1 - P0) @ nrm).min()), r2(((long1 - P0) @ nrm).max())]},
       'line1b': {**own(short1), 'meanOffAxisM': r2(((short1 - P0) @ nrm).mean())},
       'loop': {'alongWallM': [r2(sl.min()), r2(sl.max())], 'offWallByAlongM': bins, 'outerOffWallM': {'min': r2(-max(outer)), 'max': r2(-min(outer)), 'median': r2(-np.median(outer))}, 'note': 'offWall: 운동장 서쪽 벽(은주1관 쪽) 선에서 동쪽이 +. 벽을 따라 남쪽 끝이 0, 북쪽이 +'}}
(HERE / 'strokes.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(json.dumps(out, ensure_ascii=False))
