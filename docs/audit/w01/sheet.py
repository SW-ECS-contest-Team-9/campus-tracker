"""W01: 갈무리 여러 장을 한 장에 모아 본다(볼트에만 쓴다).   python sheet.py <전|후> <출력 이름> <시점 이름 일부 ...>"""
import sys, pathlib
from PIL import Image, ImageDraw
OUT = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009\w01')
tag, name, keys = sys.argv[1], sys.argv[2], sys.argv[3:]
fs = [f for f in sorted(OUT.glob(f'{tag}-지도-*.jpg')) if any(k in f.name for k in keys)]
ims = [Image.open(f).convert('RGB').resize((800, 600)) for f in fs]; n = len(ims); cols = 2; rows = (n + 1) // 2
c = Image.new('RGB', (cols * 800, rows * 600), 'white')
for i, im in enumerate(ims): ImageDraw.Draw(im).text((8, 8), fs[i].stem, fill='yellow'); c.paste(im, ((i % cols) * 800, (i // cols) * 600))
c.save(OUT / name, quality=85); print(name, n)
