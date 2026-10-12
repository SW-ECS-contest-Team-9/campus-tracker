"""W01: 거리뷰 | 전 | 후 를 나란히 붙인다(그림은 볼트에만 쓴다).   python -X utf8 compare.py"""
import pathlib
from PIL import Image
EV = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009'); OUT = EV / 'w01'; SV = EV / '사용자-네이버거리뷰-20261012'
PAIRS = [('01-유담관-남서모서리', '27-근접-유담관공도쪽-남서모서리.jpg', '27-유담관-남서모서리'), ('02-서쪽면-북쪽보기', '28-근접-유담관서쪽면-북쪽보기.jpg', '28-서쪽면-북쪽보기'), ('03-스포렉스입구', '29-근접-사용자시선.jpg', '29-스포렉스입구'),
         ('04-서쪽면-가게칸', '31-근접-사용자시선.jpg', '31-서쪽면-가게칸'), ('05-북쪽끝-남쪽보기', '33-근접-유담관북쪽끝-남쪽보기.jpg', '33-북쪽끝-남쪽보기'), ('06-돌옹벽과-서문', '33-근접-사용자시선.jpg', '33-서문쪽-북쪽보기'),
         ('07-서문-가까이', '34-근접-서문.jpg', '34-서문-가까이'), ('08-서문-정면', '35-근접-서문정면.jpg', '35-서문-정면'), ('09-정문북서-밝은돌옹벽', '39-근접-밝은돌옹벽.jpg', '39-밝은돌옹벽'),
         ('10-정문-수인관', '40-근접-정문-수인관.jpg', '40-정문-수인관'), ('11-수인관-남쪽끝', '41-근접-수인관남쪽끝.jpg', '41-수인관-남쪽끝'), ('12-공연실습소', '36-근접-공연실습소간판.jpg', '36-공연실습소'),
         ('13-제3생활관', '36-근접-제3생활관동쪽면.jpg', '36-제3생활관'), ('14-광장아래-건물면', '38-근접-분수광장아래건물남쪽끝.jpg', '38-광장아래-건물면'), ('15-회전교차로', '26-근접-사용자시선.jpg', '26-회전교차로')]
for name, sv, view in PAIRS:
    ims = [Image.open(f).convert('RGB') for f in (SV / sv, OUT / f'전-지도-{view}.jpg', OUT / f'후-지도-{view}.jpg') if f.exists()]; h = 560
    ims = [i.resize((max(1, round(i.width * h / i.height)), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / f'비교-w01-{name}.jpg', quality=86); print(name, len(ims))
