"""V02: 사용자 S-MAP 화면 캡처에서 높이 핀(노란 풍선 + 줄기 + 파란 바닥점)을 찾아 바닥점 화면 좌표를 적는다.
   python detect_pins.py <이미지> <출력 json> <확인용 png>
   값(숫자)은 사람이 확인용 그림을 보고 적는다(readings_*.json). 여기서는 위치만 찾는다."""
import sys, json, os
import numpy as np, cv2

src, out_json, out_png = sys.argv[1:4]
bgr = cv2.imdecode(np.fromfile(src, dtype=np.uint8), cv2.IMREAD_COLOR)
H, W = bgr.shape[:2]
b, g, r = [bgr[:, :, i].astype(int) for i in range(3)]
scale = W / 1945.0 if W > 1200 else 1.0  # 풍선 크기는 화면 픽셀로 일정(지름 약 80)
if len(sys.argv) > 4: scale = float(sys.argv[4])
# 바닥점: 반투명 남색 원(지름 약 28*scale) 가운데 흰 점
blue = ((b > r + 28) & (b > g + 28) & (b > 62)).astype(np.uint8)
blue = cv2.morphologyEx(blue, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
n, lab, st, cen = cv2.connectedComponentsWithStats(blue, 8)
yellow = ((r > 150) & (g > 120) & (r - b > 60) & (g - b > 35) & (abs(r - g) < 75)).astype(np.uint8)
yellow = cv2.morphologyEx(yellow, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
pins = []
for i in range(1, n):
    x, y, w, h, a = st[i]
    d = 28 * scale
    if not (0.45 * d <= w <= 1.9 * d and 0.45 * d <= h <= 1.9 * d): continue
    if a < 0.35 * w * h: continue
    cx, cy = cen[i]
    # 위쪽에 풍선(노랑)이 있어야 한다: 같은 x 띠에서 위로 올라가며 노란 칸을 찾는다
    xs = slice(max(0, int(cx - 4)), int(cx + 5))
    col = yellow[:int(cy), xs].max(axis=1)
    ys = np.nonzero(col)[0]
    ys = ys[ys > cy - 330 * scale]
    if len(ys) == 0: continue
    yb = int(ys.max())  # 풍선 아래 끝
    if cy - yb < 6 * scale: continue
    pins.append({'u': round(float(cx), 1), 'v': round(float(cy), 1), 'balloon_bottom_v': yb, 'blob_w': int(w), 'blob_h': int(h)})
pins.sort(key=lambda p: (p['v'], p['u']))
vis = bgr.copy()
for k, p in enumerate(pins):
    p['k'] = k
    u, v = int(p['u']), int(p['v'])
    cv2.circle(vis, (u, v), 5, (0, 0, 255), -1)
    cv2.line(vis, (u, v), (u, p['balloon_bottom_v']), (0, 255, 0), 1)
    cv2.putText(vis, str(k), (u + 8, v + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4)
    cv2.putText(vis, str(k), (u + 8, v + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
json.dump({'image': os.path.basename(src), 'size': [W, H], 'pins': pins}, open(out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
cv2.imencode('.png', vis)[1].tofile(out_png)
print(len(pins), 'pins')
