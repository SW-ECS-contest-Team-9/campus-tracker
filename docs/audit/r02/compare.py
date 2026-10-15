"""R02: 근거 | 전 | 후 를 나란히(그림은 볼트에만).  python -X utf8 compare.py
전 = R02 앞의 갈무리(g03 폴더, 시점이 조금 다름: 카메라가 옹벽 뒤 화단 자리였음)."""
import pathlib
from PIL import Image
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'r02'
def side(name, files, h=640):
    ims = [Image.open(f).convert('RGB') for f in files if pathlib.Path(f).exists()]
    ims = [i.resize((max(1, round(i.width * h / i.height)), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=88); print(name, len(ims))
S = EV / '사용자-SMAP높이-20261010'
side('비교-r02-01-하행-사진26.jpg', [S / '사진-26-사잇길-하행.png', EV / 'g03' / '후-지도-g03-하행-사진26.jpg', OUT / '후-지도-r02-하행-사진26.jpg'])
side('비교-r02-02-위에서-메시선.jpg', [OUT / '후보-가.png', OUT / '후-지도-r02-위에서-윗구간.jpg'])
side('비교-r02-03-상행-꺾임-SMAP사진11.jpg', [S / '사진-11-사잇길-면적.png', OUT / '후-지도-r02-상행-꺾임.jpg'])
