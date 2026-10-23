"""X40: 사용자 파란 표시 -> EPSG:5186.   python -I blue_marks.py -> blue_marks.json
화단 그림: 화단 고리(위 선 + 서쪽 끝 + 아래 선), 화단 안 가로 선, 화단 끝에서 운동장 쪽으로 내려가는 선과 '?'.
틈 그림: 파란 동그라미(대일관 현관 동쪽)."""
import json, pathlib, numpy as np
from PIL import Image
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/학교-전경-20261022/항공')
HERE = pathlib.Path(__file__).parent
M = np.array(json.loads((HERE / 'georef.json').read_text(encoding='utf-8'))['M'])
w = lambda px: (np.hstack([np.asarray(px, float), np.ones((len(px), 1))]) @ M)
def blue(name):
    a = np.asarray(Image.open(A / name).convert('RGB')).astype(int)
    m = (a[..., 2] > 170) & (a[..., 0] < 90) & (a[..., 1] > 80) & (a[..., 1] < 170) & (a[..., 2] - a[..., 0] > 120)
    ys, xs = np.nonzero(m); return np.c_[xs, ys]
out = {}
p = blue('사용자표시-한림관북쪽-화단.webp')
out['planter_pixels'] = len(p)
# groups by pixel region (see the picture): ring = y < 700 and x < 1400 ; tail line = y >= 660 and x in 1280..1440 ; '?' = x > 1430
ring = p[(p[:, 1] < 700) & (p[:, 0] < 1400) & ~((p[:, 1] > 655) & (p[:, 0] > 1285) & (p[:, 0] < 1320))]
tail = p[(p[:, 1] >= 655) & (p[:, 0] >= 1285) & (p[:, 0] < 1435)]
q = p[p[:, 0] >= 1435]
for k, v in (('ring', ring), ('tail', tail), ('question', q)):
    W = w(v); out[k] = {'n': len(v), 'bbox': [*W.min(0).round(2).tolist(), *W.max(0).round(2).tolist()]}
# ring outline: per column of user x, top and bottom stroke
xs = np.arange(ring[:, 0].min(), ring[:, 0].max() + 1, 10)
top, bot = [], []
for x in xs:
    c = ring[np.abs(ring[:, 0] - x) <= 3]
    if len(c): top.append([x, c[:, 1].min()]); bot.append([x, c[:, 1].max()])
out['ring_top'] = w(top).round(2).tolist(); out['ring_bottom'] = w(bot).round(2).tolist()
ys = np.arange(tail[:, 1].min(), tail[:, 1].max() + 1, 20)
out['tail_line'] = w([[tail[np.abs(tail[:, 1] - y) <= 3][:, 0].mean(), y] for y in ys if (np.abs(tail[:, 1] - y) <= 3).any()]).round(2).tolist()
g = blue('사용자표시-대일관현관-동쪽-틈.webp')
W = w(g); out['gap_circle'] = {'n': len(g), 'center': W.mean(0).round(2).tolist(), 'bbox': [*W.min(0).round(2).tolist(), *W.max(0).round(2).tolist()]}
json.dump(out, open(HERE / 'blue_marks.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in out.items() if k not in ('ring_top', 'ring_bottom')}, ensure_ascii=False))
