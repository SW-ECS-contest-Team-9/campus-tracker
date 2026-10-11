"""B12: 사진 | 전 | 후 를 나란히 붙인다(그림은 볼트에만 쓴다).   python compare.py"""
import pathlib
from PIL import Image
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'b12'
def side(name, parts, h=620, crop=None):
    ims = [Image.open(p if pathlib.Path(p).is_absolute() else EV / p).convert('RGB') for p in parts]
    if crop: ims[0] = ims[0].crop(crop)
    ims = [i.resize((round(i.width * h / i.height), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=88); print(name)
side('비교-b12-01-정류장에서-사진20-전-후.jpg', ['사용자-운동장지하-20261012/블로그-사진/블로그-20.jpg', 'b12/전-지도-01-본관-정류장에서-사진20.jpg', 'b12/후-지도-01-본관-정류장에서-사진20.jpg'])
side('비교-b12-02-분수광장-넓게-전-후.jpg', ['사용자-유담관분수-북악관앞-20261010/유담관-분수광장-넓게.jpg', 'b12/전-지도-02-분수광장-넓게.jpg', 'b12/후-지도-02-분수광장-넓게.jpg'])
side('비교-b12-03-분수광장-본관확대-전-후.jpg', ['z07/근거-본관-남쪽면-확대.png', 'b12/전-지도-03-분수광장-본관확대.jpg', 'b12/후-지도-03-분수광장-본관확대.jpg'])
side('비교-b12-04-내리막길-사진21-전-후.jpg', ['사용자-SMAP높이-20261010/사진-21-사잇길-상행.png', 'b12/전-지도-04-내리막길-상행-사진21.jpg', 'b12/후-지도-04-내리막길-상행-사진21.jpg'])
side('비교-b12-05-편집기-정류장·남동.jpg', ['b12/후-지도-01-본관-정류장에서-사진20.jpg', 'b12/후-편집기-01-본관-정류장에서-사진20.jpg', 'b12/후-지도-06-본관-남동위에서.jpg', 'b12/후-편집기-06-본관-남동위에서.jpg'], h=480)
