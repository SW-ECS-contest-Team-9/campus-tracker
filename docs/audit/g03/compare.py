"""G03: 근거 그림 | 전 | 후 를 나란히 붙인다(그림은 볼트에만 쓴다).   python compare.py
거리뷰 지점 21 의 앞면(화각 90도 정사각형)은 지도 갈무리의 가로·세로 비에 맞춰 가운데를 오린다."""
import pathlib
from PIL import Image
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'g03'
def side(name, src, view, crop=None, h=640, match=False):
    ph = Image.open(src).convert('RGB'); ims = []
    for tag in ('전', '후'):
        f = OUT / f'{tag}-지도-{view}.jpg'
        if f.exists(): ims.append(Image.open(f).convert('RGB'))
    if crop: w, hh = ph.size; ph = ph.crop((int(w * crop[0]), int(hh * crop[1]), int(w * crop[2]), int(hh * crop[3])))
    if match and ims: w, hh = ph.size; nw = round(hh * ims[0].width / ims[0].height); ph = ph.crop(((w - nw) // 2, 0, (w + nw) // 2, hh))
    ims = [ph] + ims
    ims = [i.resize((max(1, round(i.width * h / i.height)), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=88); print(name, len(ims))
W = EV / '사용자-오르막길-20261012'; S = EV / '사용자-SMAP높이-20261010'; C = EV / '사용자-SP카페·대일관계단·3생활관-20261012'
side('비교-01-어귀-위로-거리뷰21.jpg', W / '03-거리뷰21-앞면-2048.jpg', 'g03-어귀-위로', match=True)
side('비교-02-흡연장-거리뷰22.jpg', next((EV / '사용자-네이버거리뷰-20261012').glob('22-*')), 'g03-흡연장')
side('비교-03-하행-전경사진18.jpg', next((EV / '사용자-학교전경-20261012').glob('18-*')), 'g03-하행-사진18')
side('비교-04-상행-사진21.jpg', S / '사진-21-사잇길-상행.png', 'g03-상행-사진21')
side('비교-05-하행-사진26.jpg', S / '사진-26-사잇길-하행.png', 'g03-하행-사진26')
side('비교-06-하행-로고-사용자사진02.jpg', W / '02-오르막길-하행-링무늬-로고-옛사진.jpg', 'g03-하행-로고-사진02')
side('비교-07-카페-사진02.jpg', C / '02-SP카페-데크-크게.jpg', 'g03-카페-사진02')
side('비교-08-카페-사진03-대일관계단.jpg', C / '03-SP카페-사용자표시-대일관-계단.png', 'g03-카페-사진03')
