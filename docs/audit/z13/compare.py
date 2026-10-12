"""Z13: 근거 그림 | 전 | 후 를 나란히 붙인다(볼트 z13 폴더에 저장. 사진은 저장소에 넣지 않는다).   python -X utf8 compare.py
거리뷰 쪽은 네이버 전방위 사진의 면(90도)을 받아 둔 `정문길-NNN-근접-양쪽인도-왼·앞·오른.jpg`(면의 아래 624/1024, 세 면)에서 해당 면을 잘라 쓴다(z12/compare.py 와 같은 방식)."""
import pathlib
from PIL import Image, ImageDraw, ImageFont
A = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009'); V = A / 'z13'; SV = A / '사용자-네이버거리뷰-20261012'; PH = A / '사용자-청운관현관·은주1관돌계단-20261012'
H = 520
try: FONT = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 20)
except OSError: FONT = ImageFont.load_default()
def fit(im): return im.resize((round(im.width * H / im.height), H), Image.LANCZOS)
def label(im, text):
    d = ImageDraw.Draw(im); d.rectangle([0, 0, 14 + d.textlength(text, font=FONT), 30], fill=(0, 0, 0)); d.text((7, 3), text, fill=(255, 255, 255), font=FONT); return im
def face(n, k): im = Image.open(SV / f'정문길-{n}-근접-양쪽인도-왼·앞·오른.jpg'); return im.crop((k * 1024, 0, (k + 1) * 1024, 624))   # k: 0 왼, 1 앞, 2 오른
def shot(tag, name): im = Image.open(V / f'{tag}-지도-{name}.jpg'); s = im.width / 1024; return im.crop((0, round(im.height / 2 - 112 * s), im.width, min(im.height, round(im.height / 2 + 512 * s))))
def row(out, parts):
    ims = [label(fit(im.convert('RGB')), t) for im, t in parts]; w = sum(i.width for i in ims) + 6 * (len(ims) - 1); o = Image.new('RGB', (w, H), (255, 255, 255)); x = 0
    for i in ims: o.paste(i, (x, 0)); x += i.width + 6
    o.save(V / out, quality=88); print(out, o.size)
k = 0
for n, view, f, what in [('113', 'g113', 1, '거리뷰 정문길-113 앞'), ('123', 'g123', 1, '정문길-123 앞'), ('133', 'g133', 1, '정문길-133 앞'), ('142', 'g142', 1, '정문길-142 앞'), ('152', 'g152', 1, '정문길-152 앞'), ('152', 'g152-왼', 0, '정문길-152 왼쪽'),
                         ('152', 'g152-오른', 2, '정문길-152 오른쪽'), ('162', 'g162', 1, '정문길-162 앞'), ('162', 'g162-왼', 0, '정문길-162 왼쪽'), ('162', 'g162-오른', 2, '정문길-162 오른쪽'), ('171', 'g171', 1, '정문길-171(사진 12) 앞')]:
    k += 1; row(f'비교-z13-{k:02d}-{view}-거리뷰-전-후.jpg', [(face(n, f), what), (shot('전', view), '전'), (shot('후', view), '후')])
row('비교-z13-12-정문길-위에서-전-후.jpg', [(Image.open(V / '전-지도-g-위에서.jpg'), '전(위에서)'), (Image.open(V / '후-지도-g-위에서.jpg'), '후(위에서)')])
p11 = Image.open(PH / '11-청운관-현관틀-정면-혜인관사이계단.webp').crop((240, 300, 1100, 550)); p02 = Image.open(PH / '02-청운관-현관틀-운동장에서-가까이.jpg')
row('비교-z13-13-청운관-첫단-사진11-전-후.jpg', [(p11, '사진 11(첫 단 둘레)'), (Image.open(V / '전-지도-c11-청운관-현관-정면.jpg'), '전'), (Image.open(V / '후-지도-c11-청운관-현관-정면.jpg'), '후')])
row('비교-z13-14-청운관-첫단-사진02-전-후.jpg', [(p02, '사진 02'), (Image.open(V / '전-지도-c02-청운관-현관-가까이.jpg'), '전'), (Image.open(V / '후-지도-c02-청운관-현관-가까이.jpg'), '후')])
row('비교-z13-15-청운관-첫단-왼쪽끝-사진02-전-후.jpg', [(p02.crop((0, 60, 360, 260)), '사진 02(왼쪽)'), (Image.open(V / '전-지도-c02b-첫단-왼쪽끝.jpg'), '전'), (Image.open(V / '후-지도-c02b-첫단-왼쪽끝.jpg'), '후')])
