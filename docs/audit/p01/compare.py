"""P01: 근거 그림 | 전 | 후 를 나란히 붙인다(그림은 볼트에만 쓴다).   python compare.py
거리뷰 지점은 전방위 축소본에서 그 방향 둘레를 오려 쓴다(crop = 전방위 그림의 가로 범위 0~1)."""
import pathlib
from PIL import Image
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'p01'
PH, AR, SV = '사용자-학교전경-20261012', '사용자-회차공간서쪽-유담관아케이드-20261012', '사용자-네이버거리뷰-20261012'
def find(folder, head): return next(p for p in sorted((EV / folder).iterdir()) if p.name.startswith(head))
def side(name, src, view, crop=None, h=560):
    ims = [Image.open(src).convert('RGB')]
    if crop: w, hh = ims[0].size; ims[0] = ims[0].crop((int(w * crop[0]), 0, int(w * crop[1]), hh))
    for tag in ('전', '후'):
        f = OUT / f'{tag}-지도-{view}.jpg'
        if f.exists(): ims.append(Image.open(f).convert('RGB'))
    ims = [i.resize((max(1, round(i.width * h / i.height)), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=86); print(name, len(ims))
P = {'01': 'p01-전경-남서-원경', '16': 'p16-전경-남서-원경2', '20': 'p20-전경-남서-원경3', '19': 'p19-운동장-위에서', '06': 'p06-운동장-전경', '03': 'p03-문예관-고층부', '04': 'p04-한림관-아래에서', '07': 'p07-풋살장-위에서', '09': 'p09-본관-기둥과-회차공간',
     '10': 'p10-본관-서쪽끝-현관', '11': 'p11-줄무늬구조물', '12': 'p12-서쪽길-유담관', '13': 'p13-스포렉스-입구', '14': 'p14-본관-기둥열', '15': 'p15-본관-서쪽위에서', '17': 'p17-수인관-남쪽면', '18': 'p18-내리막길-하행'}
for n, v in P.items(): side(f'비교-사진{n}-{v[4:]}.jpg', find(PH, n + '-'), v)
for n, v in (('04', 'a04-아치벽-남동에서'), ('07', 'a07-아치벽-정면'), ('09', 'a07-아치벽-정면'), ('08', 'a08-아치벽과-북악관'), ('01', 'a01-편집기-틀'), ('12', 'a04-아치벽-남동에서')): side(f'비교-아치{n}-{v[4:]}.jpg', find(AR, n + '-'), v)
side('비교-아치10-거리뷰01-서쪽.jpg', find(AR, '10-네이버거리뷰-사용자링크'), 'a10-거리뷰01-서쪽', crop=(0.28, 0.62))
for n, v, crop in (('02', 's02-본관서쪽끝', (0.28, 0.58)), ('03', 's03-둥근화단', (0.25, 0.60)), ('04', 's04-지하어귀', (0.0, 0.25)), ('04', 's04-본관기둥', (0.26, 0.56)), ('05', 's05-본관남쪽', (0.27, 0.60)), ('06', 's06-본관기둥정면', (0.22, 0.56)),
                   ('07', 's07-굽잇길어귀', (0.22, 0.62)), ('08', 's08-굽잇길', (0.22, 0.62)), ('09', 's09-바위정원', (0.20, 0.60)), ('10', 's10-분수광장쪽', (0.0, 0.30))):
    side(f'비교-거리뷰{n}-{v[4:]}.jpg', find(SV, n + '-네이버거리뷰-전방위'), v, crop=crop)
side('비교-거리뷰22-흡연장.jpg', find(SV, '22-'), 's21-흡연장'); side('비교-거리뷰23-본관서쪽끝-아치.jpg', find(SV, '23-'), 'p10-본관-서쪽끝-현관'); side('비교-거리뷰24-북악관-정면.jpg', find(SV, '24-'), 's24-북악관-정면'); side('비교-거리뷰16-북악관-서쪽끝.jpg', find(SV, '16-네이버거리뷰-전방위'), 's16-북악관-서쪽끝', crop=(0.0, 0.4))
