"""B14: S-MAP 화면 | 전 | 후 를 나란히 붙인다(그림은 볼트에만 쓴다).   python compare.py"""
import pathlib
from PIL import Image
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'b14'; U = '사용자-상승관-SMAP-20261012/'
def side(name, parts, h=620):
    ims = [Image.open(EV / p).convert('RGB') for p in parts]
    ims = [i.resize((round(i.width * h / i.height), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=88); print(name)
side('비교-b14-01-SMAP화면01-전-후.jpg', [U + '01-SMAP-상승관-청운관·대일관-사이.webp', 'b14/전-지도-01-SMAP01-북서위에서.jpg', 'b14/후-지도-01-SMAP01-북서위에서.jpg'])
side('비교-b14-02-SMAP화면02-전-후.jpg', [U + '02-SMAP-상승관-가까이.webp', 'b14/전-지도-02-SMAP02-북동위에서-가까이.jpg', 'b14/후-지도-02-SMAP02-북동위에서-가까이.jpg'])
side('비교-b14-03-운동장쪽-전-후.jpg', ['b14/전-지도-03-운동장쪽-남서위에서.jpg', 'b14/후-지도-03-운동장쪽-남서위에서.jpg'])
side('비교-b14-04-안쪽마당-입구-전-후.jpg', ['b14/전-지도-04-안쪽마당에서-입구.jpg', 'b14/후-지도-04-안쪽마당에서-입구.jpg'])
side('비교-b14-05-위에서-전-후.jpg', ['b14/전-지도-05-위에서-평면.jpg', 'b14/후-지도-05-위에서-평면.jpg'])
side('비교-b14-06-SMAP화면01·02-맞춘시점-후.jpg', [U + '01-SMAP-상승관-청운관·대일관-사이.webp', 'b14/후-지도-06-SMAP01-더-가깝게-맞춘-시점.jpg', U + '02-SMAP-상승관-가까이.webp', 'b14/후-지도-07-SMAP02-더-가깝게-맞춘-시점.jpg'], h=520)
side('비교-b14-07-옆에서-SMAP-후.jpg', ['b14/smap-옆에서-북쪽면-동쪽끝덩어리가-더높음.jpg', 'b14/후-지도-08-옆에서-숲쪽-북쪽면.jpg'])
