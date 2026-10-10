"""N02: 사용자 그림 11(네이버 위성 화면에 붉은 테두리)을 EPSG:5186 으로 옮긴다. 읽기 전용.
  python georef.py <audit-dir> <out.json>
기준점은 화면에서 눈으로 고른 지면 가까운 모서리 4곳(건물 외곽 원천 좌표와 S-MAP 메시에서 읽은 화단 모서리). 닮음 변환(축척·회전·이동) 최소제곱."""
import sys, json, pathlib
import numpy as np
from PIL import Image
audit = pathlib.Path(sys.argv[1])
IMG = audit / '사용자-서문·제2주차장·수인관-20261010' / '11-네이버위성-회차공간·오르막길-포장면-사용자표시.webp'
# (화면 x, y) -> (동, 북)
GCP = [
    ('북악관 남서 모서리(낮은 단 모서리)', (165, 212), (201004.76, 557387.19), '원천 외곽'),
    ('본관 북서 모서리', (468, 522), (201044.69, 557344.20), '원천 외곽(지붕 가장자리라 처마만큼 어긋날 수 있음)'),
    ('정문 계단 동쪽 화단의 남서 모서리', (480, 462), (201046.5, 557357.0), 'S-MAP 1 m 메시의 131.5 m 턱'),
    ('유담관 9층 쪽 데크(둥근 화단) 북쪽 끝', (215, 745), (201011.0, 557318.5), 'S-MAP 2 m 메시의 131 m 단'),
]
def fit(px, en):
    # en = s*R*[x, -y] + t  -> complex least squares
    z = np.array([complex(x, -y) for x, y in px]); w = np.array([complex(e, n) for e, n in en])
    zc, wc = z.mean(), w.mean(); a = ((w - wc) * np.conj(z - zc)).sum() / (abs(z - zc) ** 2).sum()
    return a, wc - a * zc
a, b = fit([g[1] for g in GCP], [g[2] for g in GCP])
to_en = lambda x, y: (lambda c: (round(c.real, 2), round(c.imag, 2)))(a * complex(x, -y) + b)
res = [round(abs(complex(*to_en(*g[1])) - complex(*g[2])), 2) for g in GCP]
im = np.asarray(Image.open(IMG).convert('RGB')).astype(int)
red = (im[:, :, 0] > 190) & (im[:, :, 1] < 90) & (im[:, :, 2] < 90)
ys, xs = np.nonzero(red)
pts = [to_en(int(x), int(y)) for x, y in zip(xs[::3], ys[::3])]
out = {'image': IMG.name, 'imageSize': list(im.shape[1::-1]), 'scaleMPerPx': round(abs(a), 4), 'rotationDeg': round(float(np.degrees(np.angle(a))), 2),
       'gcp': [{'name': g[0], 'px': g[1], 'en': g[2], 'source': g[3], 'residualM': r} for g, r in zip(GCP, res)],
       'rmsM': round(float(np.sqrt(np.mean(np.square(res)))), 2), 'maxResidualM': max(res),
       'transform': {'a': [a.real, a.imag], 'b': [b.real, b.imag], 'note': 'E + iN = a * (x - i*y) + b'},
       'markers': {'버스 표지 북': to_en(175, 395), '버스 표지 남': to_en(266, 612), 'GS25 표지': to_en(480, 273), '횡단보도 띠 서쪽 끝': to_en(172, 512), '횡단보도 띠 동쪽 끝': to_en(333, 466)},
       'redLinePointCount': len(pts), 'redLine': pts}
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)
print({k: v for k, v in out.items() if k not in ('redLine', 'transform')})
