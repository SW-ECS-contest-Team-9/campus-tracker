"""R01: 근거 그림 | 전 | 후 를 나란히 붙인다(그림은 볼트에만 쓴다).   python compare.py"""
import pathlib
from PIL import Image
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'r01'
PH, SV = '사용자-학교전경-20261012', '사용자-네이버거리뷰-20261012'
def find(folder, head): return next(p for p in sorted((EV / folder).iterdir()) if p.name.startswith(head))
def side(name, src, view, crop=None, h=560):
    ims = []
    if src:
        im = Image.open(src).convert('RGB')
        if crop: w, hh = im.size; im = im.crop((int(w * crop[0]), int(hh * crop[1]), int(w * crop[2]), int(hh * crop[3])))
        ims.append(im)
    ims += [Image.open(OUT / f'{t}-지도-{view}.jpg').convert('RGB') for t in ('전', '후')]
    ims = [i.resize((max(1, round(i.width * h / i.height)), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=86); print(name, len(ims))
side('비교-사진04-한림관-아래에서.jpg', find(PH, '04-'), 'p04-한림관-아래에서')
side('비교-거리뷰09-바위정원.jpg', find(SV, '09-네이버거리뷰-전방위'), 'r09-바위정원-거리뷰09', crop=(0.26, 0, 0.60, 1))
side('비교-거리뷰09-바위정원-s09.jpg', find(SV, '09-네이버거리뷰-전방위'), 's09-바위정원', crop=(0.20, 0, 0.60, 1))
side('비교-거리뷰10-옹벽과-화단.jpg', find(SV, '10-네이버거리뷰-전방위'), 'r10-옹벽-거리뷰10', crop=(0.26, 0, 0.60, 1))
side('비교-바위정원-위에서.jpg', None, 'r09t-바위정원-위에서')
side('비교-사진20-수인관-유리덩어리.jpg', find(PH, '20-'), 't20-수인관-유리덩어리', crop=(0.42, 0.55, 1, 0.9))
side('비교-사진17-수인관-남쪽면.jpg', find(PH, '17-'), 'p17-수인관-남쪽면')
for v in ('r20-유리덩어리-길에서', 'r20b-유리덩어리-위에서', 'r20c-유리덩어리-북서에서'): side(f'비교-{v[4:]}.jpg' if False else f'비교-유리덩어리-{v.split("-")[-1]}.jpg', None, v)
for v in ('w1-전체-북동에서', 'w2-전체-남동에서', 'w3-전체-북서에서', 'w4-전체-남서에서', 'w5-전체-바로위에서', 'p20-전경-남서-원경3'): side(f'비교-전체-{v.split("-", 1)[1]}.jpg', None, v, h=520)
