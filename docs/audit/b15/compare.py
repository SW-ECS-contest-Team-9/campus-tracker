"""B15: 근거 | 전 | 후 를 나란히 붙인다(그림은 볼트에만 쓴다).   python compare.py"""
import pathlib
from PIL import Image
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'b15'
A, B = '사용자-SMAP-건물전후면-20261012/', '사용자-청운관현관·은주1관돌계단-20261012/'
def side(name, parts, h=600):
    ims = [Image.open(EV / p).convert('RGB') for p in parts]
    ims = [i.resize((round(i.width * h / i.height), h)) for i in ims]
    c = Image.new('RGB', (sum(i.width for i in ims) + 8 * (len(ims) - 1), h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=88); print(name)
def tri(n, title, ev, view): side(f'비교-b15-{n:02d}-{title}.jpg', [ev, f'b15/전-지도-{view}.jpg', f'b15/후-지도-{view}.jpg'])
tri(1, '청운관현관-정면-사진11', B + '11-청운관-현관틀-정면-혜인관사이계단.webp', '01-청운관-현관-정면')
tri(2, '청운관현관-왼쪽-사용자표시01', B + '01-사용자표시-청운관현관-왼쪽-이어지는곳.png', '02-청운관-현관-왼쪽-이어지는곳')
tri(3, '청운관현관-가까이-사진02', B + '02-청운관-현관틀-운동장에서-가까이.jpg', '03-청운관-현관-가까이')
tri(4, '은주1관-위에서-사진10', B + '10-위에서-본관-유담관-아치다리-바위정원-은주1관.jpg', '11-은주1관-위에서-사진10')
tri(5, '은주1관-긴면-사진09', B + '09-은주1관-긴면-유담관-아치다리.jpg', '12-은주1관-긴면-사진09')
tri(6, '은주1관-박공덩어리-사진08', B + '08-은주1관-회전돌계단-고리무늬포장.jpg', '13-은주1관-박공덩어리-사진08')
side('비교-b15-07-은주1관-서쪽면-전-후.jpg', ['b15/전-지도-14-은주1관-서쪽면-정면.jpg', 'b15/후-지도-14-은주1관-서쪽면-정면.jpg'])
tri(8, '혜인관뒷면-SMAP01', A + '01-SMAP-혜인관뒷면-청운관-운동장-남쪽에서.webp', '21-SMAP01-혜인관-뒷면')
side('비교-b15-09-혜인관뒷면-가까이-전-후.jpg', ['b15/전-지도-24-혜인관-뒷면-가까이.jpg', 'b15/후-지도-24-혜인관-뒷면-가까이.jpg'])
tri(10, '대일관·청운관-SMAP02', A + '02-SMAP-대일관뒷면-청운관-문예관-북악관-동쪽에서.webp', '22-SMAP02-대일관뒷면-청운관')
tri(11, '북악관·본관·유담관-SMAP03', A + '03-SMAP-북악관-본관-유담관-문예관-서쪽에서.webp', '23-SMAP03-북악관-본관')
