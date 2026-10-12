"""Q02: 사용자 사진 02(오르막길을 위에서 내려다본 옛 사진)의 포장면을 펴서 나뭇잎 로고의 방향·크기를 잰다. 읽기만 한다.   python -I rectify_leaf.py
가정(추정): 핀홀, 기울어짐(roll) 0, 주점 = 그림 가운데, 차도 폭 4.2 m 를 자로. 초점거리 f 는 고리 무늬 줄(차도에 직각이라 봄)의 소실점과 고리 타원의 납작한 정도에서 375 ± 30 px(가로 화각 약 72도).
쓰는 그림(볼트에만): q02/사진02-편그림.jpg (위가 내리막, 왼쪽이 본관 쪽, 1 px = 2 cm)"""
import pathlib, sys
import numpy as np
from PIL import Image, ImageDraw
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009')
PHOTO = EV / '사용자-오르막길-20261012' / '02-오르막길-하행-링무늬-로고-옛사진.jpg'
CX, CY = 271.0, 184.5
VP = (314.4, 118.0)                                   # 차도 양쪽 가장자리 선이 만나는 점
XL = lambda y: 62 + 2.07 * (240 - y)                  # 차도 왼쪽(본관 쪽) 가장자리: 짙은 띠의 안쪽 선
XR = lambda y: 420 + 0.80 * (y - 250)                 # 차도 오른쪽(문예관 쪽) 가장자리
ROAD_W, T_MID = 4.2, 0.5                              # 차도 t −1.6 ~ 2.6
def ground(f):
    d = np.array([VP[0] - CX, VP[1] - CY, f]); d /= np.linalg.norm(d)           # 내리막 방향
    n = -np.array([0.0, f, CY - VP[1]]); n /= np.linalg.norm(n)                 # 포장면의 위쪽 법선(소실선이 수평 y = 118)
    a = np.cross(d, n); a /= np.linalg.norm(a)
    if a[0] < 0: a = -a                                                         # 그림 오른쪽 = 문예관 쪽 = +t
    def raw(x, y):
        r = np.stack([np.asarray(x, float) - CX, np.asarray(y, float) - CY, np.full(np.shape(x), f)], -1)
        X = r * (-1.0 / (r @ n))[..., None]; return X @ d, X @ a
    ys = np.array([180.0, 220.0, 260.0, 300.0]); rl = raw(XL(ys), ys)[1]; rr = raw(XR(ys), ys)[1]
    H = ROAD_W / float(np.mean(rr - rl)); mid = float(np.mean(rr + rl)) / 2 * H
    ground.cam_t = T_MID - mid                                                  # 사진기 발치의 t
    return (lambda x, y: (raw(x, y)[0] * H, raw(x, y)[1] * H - mid + T_MID)), H, (rr - rl) * H
# 사진에서 읽은 점(px, ±1.5): 잎 끝, 가운데 잎맥, 잎 몸통 외곽(먼 쪽 → 오른쪽 끝 → 가까운 쪽), 잎자루(바깥 선 → 끝 → 안쪽 선), 곁 잎맥 둘
TIP = (203, 175)
RIB = [(203, 175), (250, 188), (290, 200), (330, 212), (356, 221)]
BODY = [(203, 175), (215, 176), (230, 177.5), (250, 179.5), (270, 182), (290, 184.5), (310, 187), (325, 189), (335, 191.5), (345, 195), (352, 199), (357, 203), (361, 208), (363, 214), (362, 222),
        (352, 226), (340, 222), (320, 219), (300, 216.5), (280, 214), (260, 211.5), (240, 208), (222, 204), (210, 199), (203, 193), (201, 186)]
STEM_OUT = [(363, 215), (375, 226), (388, 238), (393, 250), (393, 260), (388, 268), (380, 275), (368, 279)]
STEM_IN = [(362, 277), (372, 270), (378, 262), (380, 252), (377, 244), (372, 238), (365, 233), (355, 228)]
VEIN1 = [(325, 209), (324, 203), (327, 197), (333, 192)]
VEIN2 = [(322, 210), (335, 211), (350, 213)]
if __name__ == '__main__':
    for f in (345, 375, 405):
        g, H, w = ground(f)
        P = lambda pts: np.array([g(x, y) for x, y in pts])
        tip, base = P([TIP])[0], P([RIB[-1]])[0]; body = P(BODY); so = P(STEM_OUT); end = P([STEM_OUT[-1], STEM_IN[0]]).mean(0)
        ax = base - tip; L = np.hypot(*ax); ang = np.degrees(np.arctan2(abs(ax[1]), abs(ax[0])))
        u = ax / L; nn = np.array([-u[1], u[0]]); wid = np.ptp((body - tip) @ nn)
        print(f'f {f}: 눈높이 {H:.2f} m, 차도 폭 검산 {np.round(w, 2)}')
        print(f'  잎 끝 (내리막 {tip[0]:.2f}, t {tip[1]:.2f}) 잎자루 뿌리 (내리막 {base[0]:.2f}, t {base[1]:.2f}): 끝이 {tip[0] - base[0]:.2f} m 더 아래, 옆으로 {base[1] - tip[1]:.2f} m, 몸통 축 길이 {L:.2f} m, 길과 이루는 각 {ang:.0f}도, 몸통 폭 {wid:.2f} m')
        print(f'  몸통 t {body[:, 1].min():.2f} ~ {body[:, 1].max():.2f}, 내리막 {body[:, 0].min():.2f} ~ {body[:, 0].max():.2f} | 잎자루 끝 (내리막 {end[0]:.2f}, t {end[1]:.2f}), 잎자루 바깥 선 t 최대 {so[:, 1].max():.2f}')
        if f == 375: np.save(pathlib.Path(__file__).with_name('leaf-ground.npy'), {'tip': tip, 'rib': P(RIB), 'body': body, 'stem_out': so, 'stem_in': P(STEM_IN), 'v1': P(VEIN1), 'v2': P(VEIN2)}, allow_pickle=True)
    g, H, _ = ground(375); im = np.asarray(Image.open(PHOTO).convert('RGB')).astype(float)
    # 편 그림: 가로 t −2.6 ~ 3.6, 세로 내리막 거리 2.5 ~ 14 m (위가 먼 쪽). 땅 → 그림 은 3x3 사영으로
    src = np.array([(150, 200), (400, 200), (60, 330), (480, 330)], float); dst = np.array([g(x, y) for x, y in src])
    A = []
    for (D, T), (x, y) in zip(dst, src): A += [[D, T, 1, 0, 0, 0, -x * D, -x * T, -x], [0, 0, 0, D, T, 1, -y * D, -y * T, -y]]
    Hm = np.linalg.svd(np.array(A))[2][-1].reshape(3, 3)
    R = 0.02; T, D = np.meshgrid(np.arange(-2.6, 3.6, R), np.arange(14, 2.5, -R)); q = np.stack([D, T, np.ones_like(D)], -1) @ Hm.T; x = q[..., 0] / q[..., 2]; y = q[..., 1] / q[..., 2]
    ok = (x >= 0) & (y >= 0) & (x < im.shape[1] - 1) & (y < im.shape[0] - 1); xi = np.clip(x, 0, im.shape[1] - 2).astype(int); yi = np.clip(y, 0, im.shape[0] - 2).astype(int)
    o = im[yi, xi]; o[~ok] = 255; out = Image.fromarray(o.astype(np.uint8)); dr = ImageDraw.Draw(out)
    for m in range(3, 14):
        yy = (14 - m) / R; dr.line([(0, yy), (12, yy)], fill=(255, 0, 0)); dr.text((14, yy - 6), f'{m} m', fill=(255, 0, 0))
    for t in (-1.6, 0.5, 2.6): dr.line([((t + 2.6) / R, 0), ((t + 2.6) / R, out.height)], fill=(255, 255, 0))
    out.save(EV / 'q02' / '사진02-편그림.jpg', quality=90); print('saved', out.size)
