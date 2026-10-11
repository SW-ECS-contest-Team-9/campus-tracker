"""U11: 사용자 사진과 시험 지도 1인칭 화면을 나란히 놓는다(볼트 u11 폴더에만 쓴다. 사용자 사진은 저장소에 넣지 않는다).   python compare.py"""
import pathlib
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u11'; SRC = A / '사용자-운동장지하-20261012'
op = lambda f: Image.open(f).convert('RGB')
def row(parts, name, h=620):
    ims = [(t, im.resize((round(im.width * h / im.height), h), Image.LANCZOS)) for t, im in parts]
    out = Image.new('RGB', (sum(im.width for _, im in ims) + 8 * (len(ims) - 1), h + 30), 'white'); d = ImageDraw.Draw(out); x = 0
    for t, im in ims: out.paste(im, (x, 30)); d.text((x + 6, 5), t, fill='black', font=FONT); x += im.width + 8
    out.save(OUT / name, quality=88); print('saved', name, out.size)
m = lambda n: op(next(OUT.glob(f'지도-u11-{n}-*.jpg')))
row([('사진 23 (지하 2층 통로에서 경사로를 올려다봄)', op(SRC / '23-곧은경사로-고화질.webp')), ('시험 지도: 같은 자리(발치 기둥 12.2 m 앞)', m('01'))], '비교-u11-01-사진23-옆에.jpg')
row([('사진 26 (경사로 위, 굽은 곳 쪽)', op(SRC / '26-사람표시-경사로굽은곳-새사진-두사람.png')), ('시험 지도: 경사로 위 발치에서 7 m', m('02'))], '비교-u11-02-사진26-옆에.jpg')
row([('사진 22 (= 11, 지하 1층 섬 앞)', op(SRC / '22-경사로섬-사진-왼쪽위-걸린표지-사용자표시.webp')), ('시험 지도: 섬 남서 3.8 m 에서 북동으로', m('03'))], '비교-u11-03-사진22-옆에.jpg')
row([('사진 24 (= 14, 간판 벽 쪽에서. 사람 = 낮은 벽 자리)', op(SRC / '24-사람표시-주차장안-낮은벽자리.webp')), ('시험 지도: S03 앞 통로에서 남남동으로', m('04'))], '비교-u11-04-사진24-옆에.jpg')
row([('사진 20', op(SRC / '20-은주관벽과-오른쪽-걸린표지-사용자표시.png')), ('사진 21', op(SRC / '21-주차관리센터·은주관-문과-오른쪽계단.jpg')), ('시험 지도: 간판 벽(세모의 빗변) 정면', m('05'))], '비교-u11-05-사진20·21-옆에-간판벽.jpg', 480)
row([('사용자 그림 29 (세모 = 관리실·화장실·통로)', op(SRC / '29-띄운-지하1층-사용자표시-세모-관리실·화장실·통로.png')), ('시험 지도: 띄운 지하 1층, 같은 방향', m('06'))], '비교-u11-06-그림29-옆에-띄운지하1층.jpg', 700)
row([('띄운 지하 1층', m('07')), ('띄운 지하 2층', m('08'))], '비교-u11-07-띄움-지하1층·지하2층.jpg', 700)
