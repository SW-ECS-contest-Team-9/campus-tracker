"""X40: 사용자 표시 그림(한림관 북쪽 화단·대일관 현관 동쪽 틈, 같은 바탕 2000 x 1275)을 EPSG:5186 으로.   python georef_user.py -> georef.json
바탕을 D23 항공사진(항공-대일관앞-원본, 픽셀 -> EPSG:5186 변환은 X22 의 대일관 앞 땅 위 점 넷: docs/audit/d23/blue_lines.py 의 M)에 SIFT 특징점으로 맞춘다(닮음 변환).
비교: X27 사진(aerial-georef.json, 한림관 정문 앞 땅 위 표시 셋)으로 맞추면 이 자리에서 서·남으로 5~7 m 다르다(멀리 밖으로 늘린 변환이라).
대일관 앞 모델(Z02·X22·D23)이 D23 변환으로 놓였으므로 같은 변환을 쓴다."""
import json, pathlib, numpy as np, cv2
from PIL import Image
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/학교-전경-20261022')
HERE = pathlib.Path(__file__).parent
MD = np.array([[0.06406216770736912, 0.00048373671647442245], [0.00037821296498918855, -0.061974081796051905], [201121.09622608882, 557346.6850637228]])
G27 = json.loads((HERE.parent / 'x27' / 'aerial-georef.json').read_text(encoding='utf-8')); M27 = np.array(G27['M'])
usr = np.asarray(Image.open(A / '항공' / '사용자표시-한림관북쪽-화단.webp').convert('L'))
sift = cv2.SIFT_create(8000)


def fit(ref):
    k1, d1 = sift.detectAndCompute(usr, None); k2, d2 = sift.detectAndCompute(ref, None)
    good = [a for a, b in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.7 * b.distance]
    p1 = np.float32([k1[a.queryIdx].pt for a in good]); p2 = np.float32([k2[a.trainIdx].pt for a in good])
    S, inl = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=3)
    return np.vstack([S, [0, 0, 1]]), int(inl.sum()), len(good)


S, n, g = fit(np.asarray(Image.open(A / '항공-대일관앞-원본.webp').convert('L')))
S27, n27, _ = fit(np.asarray(Image.open(A / '항공' / '항공-한림관정문-은주1관.webp').convert('L')))
M = S.T @ MD; Mx = S27.T @ M27
probe = np.array([[1560, 670, 1], [1300, 620, 1], [1000, 700, 1], [1500, 900, 1]], float)
diff = (probe @ Mx - probe @ M).round(2).tolist()
json.dump({'note': 'user px [u, v, 1] @ M -> EPSG:5186 (x, y). D23 항공사진 변환을 거침. 사용자표시-한림관북쪽-화단.webp 와 -대일관현관-동쪽-틈.webp 는 같은 바탕', 'matches': g, 'inliers': n,
           'M': M.tolist(), 'x27Compare': {'inliers': n27, 'probePx': probe[:, :2].tolist(), 'x27MinusD23M': diff}},
          open(HERE / 'georef.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('inliers', n, 'of', g, '/ X27 와 차(m):', diff)
