"""U04: 학교 지하도 지도(볼트의 그림 02, 800 화소)에서 운동장 지하 주차장의 주차 칸 묶음을 화소로 읽는다. DB·네트워크 접근 없음.   python digitise.py
방법: 그림을 4배로 키우고, 주차장 외곽(georef.py 의 parking 화소) 안에서 배경(가운데값 흐림)보다 밝은 선(주차 칸 테두리)을 고른 뒤 닫기·열기로 묶음마다 한 덩어리로 만들고 가장 작은 기운 네모를 맞춘다.
손으로 고친 것 둘: 북쪽 둘째 묶음(선이 흐려 절반만 잡힘 → 확대 그림에서 읽은 크기의 네모), 남쪽 셋째 묶음(둘로 갈라져 잡힘 → 합침).
쓰는 파일: stalls-px.json (묶음마다 가운데·긴 변·짧은 변·기운 각, 그림 02 의 화소). 그림은 볼트에 있다(저장소에 넣지 않는다)."""
import json, pathlib
import numpy as np, cv2
from PIL import Image
HERE = pathlib.Path(__file__).parent
IMG = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/사용자-운동장지하-20261012/02-학교-캠퍼스맵-지하도-연결지점.jpg')
S = 4
im = Image.open(IMG).convert('RGB'); big = im.resize((im.width * S, im.height * S), Image.BICUBIC); a = np.asarray(big).astype(np.float32); g = a.mean(2)
park = np.array(json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8'))['px']['parking'], np.int32) * S
mask = np.zeros(g.shape, np.uint8); cv2.fillPoly(mask, [park], 255); mask = cv2.erode(mask, np.ones((5, 5), np.uint8), iterations=S)   # 외곽선은 뺀다
bg = cv2.medianBlur(g.astype(np.uint8), 51).astype(np.float32)
lines = (((g - bg) > 7) & (mask > 0) & ((a.max(2) - a.min(2)) < 40)).astype(np.uint8) * 255
cl = cv2.morphologyEx(lines, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (4 * S + 1, 4 * S + 1)))
cl = cv2.morphologyEx(cl, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * S + 1, 2 * S + 1)))
n, lab, st, _ = cv2.connectedComponentsWithStats(cl)
comps = [np.argwhere(lab == i)[:, ::-1].astype(np.float32) for i in range(1, n) if st[i, 4] >= 60 * S * S]
def rect(pts):
    (cx, cy), (w, h), _ = cv2.minAreaRect(pts); box = cv2.boxPoints(cv2.minAreaRect(pts)) / S
    return {'c': [round(cx / S, 1), round(cy / S, 1)], 'box': [[round(float(x), 2), round(float(y), 2)] for x, y in box]}
out = [rect(p) for p in comps]
near = lambda c: min(range(len(out)), key=lambda i: np.hypot(out[i]['c'][0] - c[0], out[i]['c'][1] - c[1]))
# 고침 1: 북쪽 둘째 묶음(가운데 (489, 332) 쯤으로 잡힌 반쪽)을 확대 그림에서 읽은 네모로
ax, ac = np.array([-0.53, 0.848]), np.array([0.848, 0.53]); c0 = np.array([491.5, 329.0])   # 줄 방향(긴 줄들의 기운 각 -58도)과 그 직각, 화소
i = near((489, 332)); out[i] = {'c': [491.5, 329.0], 'box': [[round(float(v), 2) for v in c0 + ax * a + ac * b] for a, b in ((-9.5, -12), (-9.5, 12), (9.5, 12), (9.5, -12))], 'manual': '선이 흐려 절반만 잡힘: 확대 그림에서 읽은 크기(줄 방향 19, 직각 24 화소, ±3)의 네모'}
# 고침 2: 남쪽 셋째 묶음이 둘로 갈라짐 → 합쳐 다시 맞춤
i, j = near((460, 507)), near((471, 513)); merged = rect(np.vstack([comps[i], comps[j]])); merged['manual'] = '둘로 갈라져 잡힌 것을 합침'
out = [o for k, o in enumerate(out) if k not in (i, j)] + [merged]
out.sort(key=lambda o: (round(o['c'][1] / 40), o['c'][0]))
(HERE / 'stalls-px.json').write_text(json.dumps({'image': str(IMG.name), 'scale': 'px of the 800 px image', 'blocks': out}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(out), 'blocks'); [print(o['c'], o.get('manual', '')) for o in out]
