"""B13: 사진 | 전 | 후 를 나란히 붙인다(그림은 볼트에만 쓴다).   python compare.py"""
import pathlib
from PIL import Image
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'b13'
def side(name, parts, h=620, crop=None):
    ims = [Image.open(p if pathlib.Path(p).is_absolute() else EV / p).convert('RGB') for p in parts]
    if crop: ims[0] = ims[0].crop(crop)
    ims = [i.resize((round(i.width * h / i.height), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=88); print(name)
side('비교-b13-01-정면-사진01-전-후.jpg', ['사용자-혜인관-20261012/01-혜인관-정면-운동장에서.jpg', 'b13/전-지도-01-정면-운동장에서.jpg', 'b13/후-지도-01-정면-운동장에서.jpg'])
side('비교-b13-02-정면-사진02(흐린날)·08-후.jpg', ['사용자-학교전경-20261012/02-혜인관-정면-흐린날.jpg', '사용자-학교전경-20261012/08-혜인관-정면-전광판-줄무늬출입부.jpg', 'b13/후-지도-01-정면-운동장에서.jpg'])
side('비교-b13-03-좌측면-사진02-전-후.jpg', ['사용자-혜인관-20261012/02-혜인관-좌측면(정면기준)-현관과-정류장.jpg', 'b13/전-지도-02-좌측면-북동에서.jpg', 'b13/후-지도-02-좌측면-북동에서.jpg'])
side('비교-b13-04-현관-그림03-전-후.jpg', ['사용자-혜인관-20261012/03-지금모델-혜인관-현관-계단한쪽.png', 'b13/전-지도-06-현관-옛자리.jpg', 'b13/후-지도-03-현관-가까이.jpg', 'b13/후-지도-04-현관-위에서.jpg'])
side('비교-b13-05-윗부분-사진19·05-후.jpg', ['사용자-학교전경-20261012/19-운동장-위에서-대일관-청운관-혜인관-은주관지붕.jpg', '사용자-학교전경-20261012/05-혜인관-윗부분-가까이-전원버튼-컨테이너.jpg', 'b13/후-지도-05-윗부분-북쪽위에서.jpg'])
side('비교-b13-06-편집기-정면·좌측면·현관.jpg', ['b13/후-편집기-01-정면-운동장에서.jpg', 'b13/후-편집기-02-좌측면-북동에서.jpg', 'b13/후-편집기-04-현관-위에서.jpg'])
side('비교-b13-07-편집기-전-후-정면.jpg', ['b13/전-편집기-01-정면-운동장에서.jpg', 'b13/후-편집기-01-정면-운동장에서.jpg'])
