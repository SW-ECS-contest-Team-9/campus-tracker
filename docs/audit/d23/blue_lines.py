"""D23: 사용자 파란 구분선 세 줄을 EPSG:5186 과 대일관 정면 축 (u, v) 로 옮긴다.   python -I blue_lines.py -> blue_lines.json
그림: 볼트 보완자료/학교-전경-20261022/비교-후/사용자표시-대일관-데크-화단-구분선.webp(사용자가 선을 그린 것)와 그 바탕 항공-대일관앞-전후.png.
바탕의 아래 "후" 칸(y 620~1180)은 항공사진 원본(항공-대일관앞-원본, 1753 x 1598) 픽셀 (550, 520) 부터 자른 1000 x 560 이고,
원본 픽셀 -> EPSG:5186 은 그 그림을 만들 때 쓴 1차 변환 M([px, py, 1] @ M, 2026-10-22 X22, 대일관 앞 땅 위 점 넷으로 맞춤) 그대로다.
두 그림의 차에서 파란 픽셀만 골라 RANSAC 직선 셋."""
import json, pathlib
import numpy as np
from PIL import Image
HERE = pathlib.Path(__file__).parent
B = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/학교-전경-20261022/비교-후')
M = np.array([[0.06406216770736912, 0.00048373671647442245], [0.00037821296498918855, -0.061974081796051905], [201121.09622608882, 557346.6850637228]])
W0 = np.array([201156.91, 557314.21]); W1 = np.array([201193.30, 557297.91]); U = (W1 - W0) / np.hypot(*(W1 - W0)); V = np.array([U[1], -U[0]])   # z02/common.py 와 같음
u = np.asarray(Image.open(B / '사용자표시-대일관-데크-화단-구분선.webp').convert('RGB')).astype(int)
c = np.asarray(Image.open(B / '항공-대일관앞-전후.png').convert('RGB')).astype(int)
r, g, b = u[..., 0], u[..., 1], u[..., 2]
m = (np.abs(u - c).sum(2) > 80) & (b > 130) & (b - r > 70) & (b - g > 25); m[:620] = False; m[:, 740:] = False   # 동쪽 끝 하늘색 외곽(상승관)은 뺌
ys, xs = np.nonzero(m); P = np.c_[xs, ys].astype(float)
world = lambda x, y: np.array([x + 550, y - 620 + 520, 1.0]) @ M
rng = np.random.default_rng(1); out = []
for _ in range(3):
    best = None
    for _ in range(4000):
        i, j = rng.choice(len(P), 2, replace=False); a, bb = P[i], P[j]
        if abs(bb[0] - a[0]) < 200: continue
        k = (bb[1] - a[1]) / (bb[0] - a[0]); inl = np.abs(P[:, 1] - (k * P[:, 0] + a[1] - k * a[0])) < 6
        if best is None or inl.sum() > best.sum(): best = inl
    Q = P[best]; k = np.polyfit(Q[:, 0], Q[:, 1], 1); x0, x1 = Q[:, 0].min(), Q[:, 0].max()
    E = [world(x, np.polyval(k, x)) for x in (x0, x1)]
    out.append({'px': [[float(x0), round(float(np.polyval(k, x0)), 1)], [float(x1), round(float(np.polyval(k, x1)), 1)]], 'world': [[round(float(t), 2) for t in e] for e in E],
                'uv': [[round(float((e - W0) @ U), 2), round(float((e - W0) @ V), 2)] for e in E], 'pixels': int(len(Q)), 'sdPx': round(float((Q[:, 1] - np.polyval(k, Q[:, 0])).std()), 2)})
    P = P[~best]
out.sort(key=lambda L: L['px'][0][1])
for L, n in zip(out, ('파랑 1: 뒤 화단 / 데크', '파랑 2: 데크 / 앞 화단', '파랑 3: 앞 화단 / 운동장(옹벽 앞면)')): L['name'] = n
(HERE / 'blue_lines.json').write_text(json.dumps({'note': __doc__.splitlines()[0], 'M': M.tolist(), 'leftPixels': int(len(P)),
    'lean': {'roofShiftM': [0.6, 3.6], 'perMeterHeight': [0.03, 0.2], 'note': '대일관 외곽을 이 그림의 지붕 처마 선에 맞춘 이동(동, 북). 처마 약 17~18 m 위 -> 높이 1 m 마다 약 0.2 m, 방위 약 N9E(운동장에서 멀어짐). 땅 위 선은 그대로'},
    'lines': out}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
for L in out: print(L['name'], L['uv'], L['pixels'], L['sdPx'])
