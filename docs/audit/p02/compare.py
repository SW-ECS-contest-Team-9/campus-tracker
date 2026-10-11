"""P02: 근거 그림 | 전 | 후 를 나란히 붙인다(그림은 볼트에만 쓴다).   python compare.py
전 = p02 폴더의 '전-지도-…', 없으면 P01 의 '후-지도-…'(= P02 를 시작할 때의 모습). 후 = p02 폴더의 '후-지도-…'."""
import pathlib
from PIL import Image
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'p02'; P01 = EV / 'p01'
PH, AR, SV, G3, EN = '사용자-학교전경-20261012', '사용자-회차공간서쪽-유담관아케이드-20261012', '사용자-네이버거리뷰-20261012', '사용자-SP카페·대일관계단·3생활관-20261012', '사용자-출입구·주차장-20261010'
def find(folder, head): return next(p for p in sorted((EV / folder).iterdir()) if p.name.startswith(head))
def side(name, src, view, crop=None, h=560):
    im = Image.open(src).convert('RGB')
    if crop: w, hh = im.size; im = im.crop((int(w * crop[0]), int(hh * crop[1]), int(w * crop[2]), int(hh * crop[3])))
    before = OUT / f'전-지도-{view}.jpg'; before = before if before.exists() else P01 / f'후-지도-{view}.jpg'
    ims = [im] + [Image.open(f).convert('RGB') for f in (before, OUT / f'후-지도-{view}.jpg') if f.exists()]
    ims = [i.resize((max(1, round(i.width * h / i.height)), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=86); print(name, len(ims))
side('비교-사진19-운동장-위에서.jpg', find(PH, '19-'), 'q19-운동장-위에서')
for n, v in (('01', 'p01-전경-남서-원경'), ('16', 'p16-전경-남서-원경2'), ('20', 'p20-전경-남서-원경3'), ('17', 'p17-수인관-남쪽면'), ('04', 'p04-한림관-아래에서'), ('12', 'p12-서쪽길-유담관')): side(f'비교-사진{n}-{v[4:]}.jpg', find(PH, n + '-'), v)
side('비교-사진20-수인관-유리덩어리.jpg', find(PH, '20-'), 't20-수인관-유리덩어리', crop=(0.42, 0.55, 1, 0.9))
side('비교-거리뷰24-북악관-정면.jpg', find(SV, '24-'), 's24-북악관-정면')
side('비교-거리뷰20-북악관-정면과-화단.jpg', find(SV, '20-네이버거리뷰-면-f'), 'b20-북악관-정면-거리뷰20')
side('비교-거리뷰09-바위정원.jpg', find(SV, '09-네이버거리뷰-전방위'), 's09-바위정원', crop=(0.20, 0, 0.60, 1))
side('비교-거리뷰09-바위정원-남서에서.jpg', find(SV, '09-네이버거리뷰-전방위'), 't09b-바위정원-남서에서', crop=(0.20, 0, 0.60, 1))
side('비교-거리뷰02-회차공간-바닥표시.jpg', find(SV, '02-네이버거리뷰-전방위'), 't01-회차공간-위에서', crop=(0.30, 0, 0.67, 1))
side('비교-사진13-유담관3층입구.jpg', find(G3, '06-'), 't13-유담관3층입구')
side('비교-사진13b-유담관3층입구-위에서.jpg', find(PH, '13-'), 't13b-유담관3층입구-위에서')
side('비교-3생활관04-바깥길.jpg', find(G3, '04-'), 'g04-제3생활관-바깥길')
