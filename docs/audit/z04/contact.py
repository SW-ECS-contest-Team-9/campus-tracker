"""Z04: 비교 그림을 세 장씩 한 쪽에 모은다(훑어보기용).  python contact.py -> <볼트>/z04/모아보기-N.jpg"""
import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import Z04
from PIL import Image
fs = sorted(Z04.glob('비교-*.png')); W = 1500
for n in range(0, len(fs), 3):
    ims = [Image.open(f).convert('RGB') for f in fs[n:n + 3]]; ims = [i.resize((W, round(i.height * W / i.width))) for i in ims]
    sheet = Image.new('RGB', (W, sum(i.height for i in ims) + 8 * len(ims)), 'white'); y = 0
    for i in ims: sheet.paste(i, (0, y)); y += i.height + 8
    sheet.save(Z04 / f'모아보기-{n // 3 + 1}.jpg', quality=85)
print(len(fs))
