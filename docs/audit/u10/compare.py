"""U10: 사용자 사진과 시험 지도 1인칭 화면을 나란히 놓는다(볼트 u10 폴더에만 쓴다. 사용자 사진은 저장소에 넣지 않는다).   python compare.py"""
import pathlib
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u10'; SRC = A / '사용자-운동장지하-20261012'
op = lambda f: Image.open(f).convert('RGB')
def row(parts, name, h=620):
    ims = [(t, im.resize((round(im.width * h / im.height), h), Image.LANCZOS)) for t, im in parts]
    out = Image.new('RGB', (sum(im.width for _, im in ims) + 8 * (len(ims) - 1), h + 30), 'white'); d = ImageDraw.Draw(out); x = 0
    for t, im in ims: out.paste(im, (x, 30)); d.text((x + 6, 5), t, fill='black', font=FONT); x += im.width + 8
    out.save(OUT / name, quality=88); print('saved', name, out.size)
row([('사진 23 (지하 2층에서 올려다봄)', op(SRC / '23-곧은경사로-고화질.webp')), ('시험 지도: 지하 2층 발치 북쪽에서 남쪽으로', op(OUT / '지도-u10-01-1인칭-지하2층-발치에서-경사로-사진23.jpg'))], '비교-u10-01-사진23-옆에-지하2층에서.jpg')
row([('사진 22 (지하 1층, 섬과 어귀. 동그라미 = 걸린 표지)', op(SRC / '22-경사로섬-사진-왼쪽위-걸린표지-사용자표시.webp')), ('시험 지도: 지하 1층 경사로 머리에서 북서쪽으로', op(OUT / '지도-u10-02-1인칭-지하1층-굽은곳-사진11·22.jpg'))], '비교-u10-02-사진22-옆에-지하1층에서.jpg')
row([('사진 24 (= 14, 은주관 벽을 등짐. 사람 = 낮은 벽 자리)', op(SRC / '24-사람표시-주차장안-낮은벽자리.webp')), ('시험 지도: 은주관 벽을 등지고', op(OUT / '지도-u10-03-1인칭-은주관벽-등지고-사진14.jpg'))], '비교-u10-03-사진14·24-옆에-은주관벽등지고.jpg')
row([('사진 20', op(SRC / '20-은주관벽과-오른쪽-걸린표지-사용자표시.png')), ('사진 21', op(SRC / '21-주차관리센터·은주관-문과-오른쪽계단.jpg')), ('시험 지도: 은주관 벽 정면', op(OUT / '지도-u10-04-1인칭-은주관벽-정면-사진20·21.jpg'))], '비교-u10-04-사진20·21-옆에-은주관벽.jpg', 480)
row([('띄운 지하 1층(푸른 기둥·노란 줄, 은주관 벽, 표지)', op(OUT / '지도-u10-05-띄움-지하1층-은주관벽·경사로.jpg')), ('띄운 지하 2층(흰 기둥·색 띠)', op(OUT / '지도-u10-06-띄움-지하2층-같은틀.jpg'))], '비교-u10-05-띄움-지하1층·지하2층.jpg', 700)
