"""Z12: 근거 그림 | 전 | 후 를 나란히 붙인다(볼트 z12 폴더에 저장. 사진은 저장소에 넣지 않는다).   python -X utf8 compare.py
거리뷰 쪽은 네이버 전방위 사진의 한 면(90도)을 받아 둔 `NN-근접-양쪽인도-왼·앞·오른.jpg`(면의 아래 624/1024, 세 면)에서 해당 면을 잘라 쓴다. 지도 화면은 가로 90도라 같은 높이 범위만 남긴다."""
import pathlib
from PIL import Image, ImageDraw, ImageFont
A = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009'); V = A / 'z12'; SV = A / '사용자-네이버거리뷰-20261012'
H = 520
try: FONT = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 20)
except OSError: FONT = ImageFont.load_default()
def fit(im): return im.resize((round(im.width * H / im.height), H), Image.LANCZOS)
def label(im, text):
    d = ImageDraw.Draw(im); d.rectangle([0, 0, 14 + d.textlength(text, font=FONT), 30], fill=(0, 0, 0)); d.text((7, 3), text, fill=(255, 255, 255), font=FONT); return im
def face(n, k):   # k: 0 왼, 1 앞, 2 오른. 면의 400~1024 행이 저장돼 있다(지평선 = 원래 512 행 = 여기 112 행)
    im = Image.open(SV / f'{n}-근접-양쪽인도-왼·앞·오른.jpg'); return im.crop((k * 1024, 0, (k + 1) * 1024, 624))
def shot(tag, name):   # 1400x1000, 가로 90도 = 한 면의 가로. 지평선(500 행)에서 위 112·아래 512 에 해당하는 높이만(1 면 px = 1400/1024 화면 px)
    im = Image.open(V / f'{tag}-지도-{name}.jpg'); s = im.width / 1024; return im.crop((0, round(im.height / 2 - 112 * s), im.width, min(im.height, round(im.height / 2 + 512 * s))))
def row(out, parts):
    ims = [label(fit(im.convert('RGB')), t) for im, t in parts]; w = sum(i.width for i in ims) + 6 * (len(ims) - 1); o = Image.new('RGB', (w, H), (255, 255, 255)); x = 0
    for i in ims: o.paste(i, (x, 0)); x += i.width + 6
    o.save(V / out, quality=88); print(out, o.size)
user = Image.open(A / '사용자-청운관현관·은주1관돌계단-20261012' / '12-사용자표시-바위정원옆-인도와-계단-이어짐.webp')
row('비교-z12-01-사용자표시-전-후.jpg', [(user, '사용자 그림 12'), (Image.open(V / '전-지도-01-사용자표시.jpg'), '전'), (Image.open(V / '후-지도-01-사용자표시.jpg'), '후')])
for k, (n, view, f, what) in enumerate([('11', 'sv11', 1, '거리뷰 11 앞'), ('10-11사이', 'sv10-11', 1, '거리뷰 10·11 사이 앞'), ('10-11사이', 'sv10-11-오른', 2, '거리뷰 10·11 사이 오른쪽'), ('10', 'sv10', 1, '거리뷰 10 앞'), ('10', 'sv10-왼', 0, '거리뷰 10 왼쪽'),
                                  ('09', 'sv09', 1, '거리뷰 09 앞'), ('08-09사이', 'sv08-09', 1, '거리뷰 08·09 사이 앞'), ('08', 'sv08', 1, '거리뷰 08 앞')], start=2):
    row(f'비교-z12-{k:02d}-{view}-거리뷰-전-후.jpg', [(face(n, f), what), (shot('전', view), '전'), (shot('후', view), '후')])
