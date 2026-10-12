# F11 전후 갈무리 비교: 다른 화소 비율과 가장 큰 차, 나란히 붙인 그림(왼쪽 전, 가운데 후, 오른쪽 차이 8배).
#   python compare.py <폴더> 전 후
import sys, glob, os
from PIL import Image, ImageChops
d, a, b = sys.argv[1:4]
for fa in sorted(glob.glob(os.path.join(d, f'*-{a}.png'))):
    fb = fa[:-len(f'-{a}.png')] + f'-{b}.png'
    if not os.path.exists(fb): continue
    ia, ib = Image.open(fa).convert('RGB'), Image.open(fb).convert('RGB')
    diff = ImageChops.difference(ia, ib); g = diff.convert('L'); h = g.histogram(); n = ia.width * ia.height
    over = sum(h[25:]); print(f'{os.path.basename(fa)[:-len(a)-5]}: 차이 10% 넘는 화소 {over / n * 100:.3f}% , 조금이라도 다른 화소 {(n - h[0]) / n * 100:.2f}% , 최대 {max(i for i, v in enumerate(h) if v)}')
    out = Image.new('RGB', (ia.width * 3, ia.height)); out.paste(ia, (0, 0)); out.paste(ib, (ia.width, 0)); out.paste(diff.point(lambda v: min(255, v * 8)), (ia.width * 2, 0))
    out.save(fa[:-len(f'-{a}.png')] + f'-비교-{a}-{b}.jpg', quality=85)
