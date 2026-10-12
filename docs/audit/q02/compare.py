"""Q02: 사용자 사진 02 | 전 | 후 를 나란히(지도 갈무리는 가운데를 사진의 가로·세로 비 542:369 로 오림). 그림은 볼트에만 쓴다.   python compare.py"""
import pathlib
from PIL import Image, ImageDraw, ImageFont
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'q02'; FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
ph = Image.open(EV / '사용자-오르막길-20261012' / '02-오르막길-하행-링무늬-로고-옛사진.jpg').convert('RGB'); parts = [('사용자 사진 02', ph)]
for tag, title in (('전', '전(Q01b: 길을 따라 10 m)'), ('후', '후(Q02: 차도를 비스듬히 가로지름)')):
    im = Image.open(OUT / f'{tag}-지도-q02-하행-로고-사진02.jpg').convert('RGB'); hh = round(im.width * ph.height / ph.width); parts.append((title, im.crop((0, (im.height - hh) // 2, im.width, (im.height + hh) // 2))))
h = 449; parts = [(t, i.resize((round(i.width * h / i.height), h), Image.LANCZOS)) for t, i in parts]
out = Image.new('RGB', (sum(i.width for _, i in parts) + 8 * (len(parts) - 1), h + 30), 'white'); d = ImageDraw.Draw(out); x = 0
for t, i in parts: out.paste(i, (x, 30)); d.text((x + 6, 5), t, fill='black', font=FONT); x += i.width + 8
out.save(OUT / '비교-q02-로고-사진02-전-후.jpg', quality=90); print(out.size)
Image.open(OUT / '후-지도-q02-위에서-로고.jpg').save(OUT / '위에서-로고.jpg', quality=90)
