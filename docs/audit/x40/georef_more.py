"""X40: 다른 항공사진(카카오 등)을 X27 항공사진(땅 위 표시 셋으로 맞춘 항공-한림관정문-은주1관, x27/aerial-georef.json)에 SIFT 특징점으로 맞춰 EPSG:5186 으로.
python georef_more.py -> georef-more.json   (그림마다 M: [px, py, 1] @ M -> (x, y), 맞춘 특징점 수)
건물 지붕은 기울어 보이므로 결과는 땅 위 것에만 쓴다. 출처가 다른 사진끼리라 맞춤 오차는 ±1~2 m 로 본다(추정)."""
import json, pathlib, numpy as np, cv2
from PIL import Image
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/학교-전경-20261022/항공')
HERE = pathlib.Path(__file__).parent
M27 = np.array(json.loads((HERE.parent / 'x27' / 'aerial-georef.json').read_text(encoding='utf-8'))['M'])
ref = np.asarray(Image.open(A / '항공-한림관정문-은주1관.webp').convert('L'))
sift = cv2.SIFT_create(10000)
k2, d2 = sift.detectAndCompute(ref, None)
out = {}
for name in ['항공-카카오-은주관-한림관-풋살파크.webp', '항공-카카오-한림관-중간옥상.webp']:
    im = np.asarray(Image.open(A / name).convert('L'))
    best = None
    for s in (1.0, 1.5, 2.0, 2.5):   # 축척이 다르면 키워서 다시
        imr = cv2.resize(im, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
        k1, d1 = sift.detectAndCompute(imr, None)
        good = [a for a, b in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
        if len(good) < 8: continue
        p1 = np.float32([k1[a.queryIdx].pt for a in good]) / s; p2 = np.float32([k2[a.trainIdx].pt for a in good])
        S, inl = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=4)
        if S is not None and (best is None or inl.sum() > best[1]): best = (S, int(inl.sum()), len(good), s)
    S, n, g, s = best
    M = np.vstack([S, [0, 0, 1]]).T @ M27
    out[name] = {'M': M.tolist(), 'inliers': n, 'matches': g, 'mPerPx': float(np.hypot(*M[0]))}
    print(name, n, g, s, round(float(np.hypot(*M[0])), 4))
json.dump(out, open(HERE / 'georef-more.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
