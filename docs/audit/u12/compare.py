"""U12: 사용자 현장 사진 30·31 과 시험 지도 1인칭 화면(가운데 정사각)을 나란히 놓는다(볼트 u12 폴더에만 쓴다. 사용자 사진은 저장소에 넣지 않는다).   python compare.py"""
import pathlib
from PIL import Image, ImageDraw, ImageFont, ImageOps
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u12'; SRC = A / '사용자-운동장지하-20261012'
op = lambda f: ImageOps.exif_transpose(Image.open(f)).convert('RGB')
def sq(im): w, h = im.size; return im.crop(((w - h) // 2, 0, (w + h) // 2, h))
def row(parts, name, h=760):
    ims = [(t, im.resize((round(im.width * h / im.height), h), Image.LANCZOS)) for t, im in parts]
    out = Image.new('RGB', (sum(im.width for _, im in ims) + 8 * (len(ims) - 1), h + 30), 'white'); d = ImageDraw.Draw(out); x = 0
    for t, im in ims: out.paste(im, (x, 30)); d.text((x + 6, 5), t, fill='black', font=FONT); x += im.width + 8
    out.save(OUT / name, quality=88); print('saved', name, out.size)
m = lambda n: sq(op(next(OUT.glob(f'지도-u12-{n}-*.jpg'))))
row([('현장 사진 30 (지하 1층, 통로 건너 간판 벽 쪽)', op(SRC / '30-현장-지하1층-통로-화살표-사람.jpg')), ('시험 지도: S04·S07 사이 통로, 섬 북동 25 m 에서 서북서(289도)', m('30'))], '비교-u12-30-현장사진30-옆에.jpg')
row([('현장 사진 31 (지하 1층, 통로를 따라 남서. 붉은 화살표 = 지하 2층)', op(SRC / '31-현장-지하1층-통로-사용자표시-B2방향.webp')), ('시험 지도: 같은 통로, 섬 북동 24 m 에서 서남서(241도)', m('31'))], '비교-u12-31-현장사진31-옆에.jpg')
