"""F09: 전 | 후 나란히 붙이기.   python compare.py <갈무리 폴더>   -> 비교-f09-<지도|편집기>-<이름>.jpg (전이 있는 것만)"""
import glob, os, sys
from PIL import Image, ImageDraw, ImageFont
d = sys.argv[1]
font = ImageFont.truetype('C:/Windows/Fonts/malgunbd.ttf', 26)
n = 0
for after in sorted(glob.glob(os.path.join(d, '*-f09-*-후.jpg'))):
    before = after[:-5] + '전.jpg'
    if not os.path.exists(before): continue
    a, b = Image.open(before).convert('RGB'), Image.open(after).convert('RGB')
    out = Image.new('RGB', (a.width + b.width + 12, max(a.height, b.height) + 44), '#ffffff')
    out.paste(a, (0, 44)); out.paste(b, (a.width + 12, 44))
    draw = ImageDraw.Draw(out)
    name = os.path.basename(after)[:-6]
    draw.text((10, 6), f'전 (F08) · {name}', fill='#7f1d1d', font=font); draw.text((a.width + 22, 6), '후 (F09)', fill='#14532d', font=font)
    out.save(os.path.join(d, '비교-f09-' + name.replace('-f09-', '-') + '.jpg'), quality=86); n += 1
print('비교 그림', n)
