"""U08: 학교 지하도 지도·사용자 그림·사진과 새 갈무리를 나란히 놓는다(볼트 u08 폴더에만 쓴다. 지도 그림·사용자 사진은 저장소에 넣지 않는다).   python compare.py
1 학교 지도 조각 | 지하 1층 | 지하 2층 (같은 틀, ㄴ자 가운데 선과 지도의 부채꼴 외곽을 겹침)   2 사용자 그림 16 | 새 지하 1층   3 사진 04 | 남쪽 다리 머리에서 | 지하 2층 발치에서
4 띄운 지하 1층 | 지하 2층   5 단면: 북쪽 다리 | 남쪽 다리 (경사로 전체)   6 사진 11 | 1인칭"""
import json, pathlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
HERE = pathlib.Path(__file__).parent
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u08'; SRC = A / '사용자-운동장지하-20261012'
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); CR = json.loads((HERE.parent / 'u07' / 'crescent.json').read_text(encoding='utf-8')); R = M['ramp']
V = json.loads((HERE / 'views.json').read_text(encoding='utf-8')); G = json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8')); MX = np.array(G['matrix'])
def row(parts, name, h=None):
    h = h or max(im.height for _, im in parts); ims = [(t, im.resize((round(im.width * h / im.height), h), Image.LANCZOS)) for t, im in parts]
    out = Image.new('RGB', (sum(im.width for _, im in ims) + 8 * (len(ims) - 1), h + 30), 'white'); d = ImageDraw.Draw(out); x = 0
    for t, im in ims: out.paste(im, (x, 30)); d.text((x + 6, 5), t, fill='black', font=FONT); x += im.width + 8
    out.save(OUT / name, quality=90); print('saved', name, out.size)
op = lambda f: Image.open(f).convert('RGB')
MAP = op(SRC / '블로그-사진' / '블로그-03.jpg'); F = MAP.width / 800
def framed(shot, lift):
    im = op(OUT / shot); W, H = im.size; (cx, cy), wm = lift['centre'], lift['widthM']; k = W / wm
    to_px = lambda x, y: ((x - cx) * k + W / 2, H / 2 - (y - cy) * k)
    a = np.array([[1 / k, 0, cx - W / 2 / k], [0, -1 / k, cy + H / 2 / k], [0, 0, 1]]); b = np.c_[MX, [0, 0, 1]]; t = (a.T @ np.linalg.inv(b)) * F   # 틀의 화소 → 좌표 → 지도 화소
    mp = MAP.transform((W, H), Image.AFFINE, (t[0, 0], t[1, 0], t[2, 0], t[0, 1], t[1, 1], t[2, 1]), Image.BICUBIC)
    return im, mp, to_px
ring = CR['outline'] + [CR['outline'][0]]; path = [p['xy'] for p in R['path']]
lift = V['01-띄움-지하1층-학교지도틀']['lift']
b1, mp, to_px = framed('지도-u08-01-띄움-지하1층-학교지도틀.jpg', lift); b2, _, _ = framed('지도-u08-02-띄움-지하2층-학교지도틀.jpg', lift)
for im in (mp, b1, b2):
    d = ImageDraw.Draw(im); d.line([to_px(*p) for p in ring], fill=(255, 40, 40), width=2); d.line([to_px(*p) for p in path], fill=(255, 0, 255), width=3)
    for p, t in ((path[0], '머리 141.4'), (R['band']['xy'], f"낮은 벽 밑 {R['band']['z']}"), (path[-1], '발치 133.0')):
        x, y = to_px(*p); d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=(255, 0, 255), outline='white'); d.text((x + 9, y - 9), t, fill=(255, 0, 255), font=FONT, stroke_width=3, stroke_fill='white')
    x, y = to_px(201146.21, 557283.45); d.rectangle([x - 6, y - 6, x + 6, y + 6], outline=(255, 255, 255), width=2)
row([('학교 지하도 지도(블로그-03)를 같은 틀로. 붉은 선 = 읽은 부채꼴, 자홍 = ㄴ자 가운데 선, 흰 네모 = 은주관 문', mp), ('새 지하 1층(띄움): 남쪽 다리 + 모서리가 트여 있고 낮은 벽에서 바닥 아래로', b1), ('새 지하 2층(띄움): 북쪽 다리가 내려와 발치', b2)], '비교-u08-01-학교지도-옆에-지하1층·지하2층-ㄴ자.jpg')
u16 = op(SRC / '16-U07비교그림-사용자-붉은화살표.webp'); w3 = u16.width // 3
row([('사용자 그림 16 의 가운데 칸(U07 지하 1층 위의 붉은 화살표)', u16.crop((w3, 0, 2 * w3, u16.height))), ('새 지하 1층(같은 틀). 자홍 = ㄴ자 가운데 선', b1)], '비교-u08-02-사용자그림16-옆에-새지하1층.jpg', 820)
row([('사용자 사진 04', op(SRC / '04-지하1층에서-지하2층-내려가는길-경사.jpg')), ('1인칭: 남쪽 다리 머리 앞(지하 1층)에서 내려다봄', op(OUT / '지도-u08-05-1인칭-남쪽다리-머리에서-내려다봄.jpg')), ('1인칭: 지하 2층 발치 앞에서 북쪽 다리를 올려다봄', op(OUT / '지도-u08-06-1인칭-지하2층-발치에서-북쪽다리-올려다봄.jpg'))], '비교-u08-03-사진04-옆에-1인칭.jpg', 600)
row([('띄운 지하 1층', op(OUT / '지도-u08-03-띄움-지하1층-전체.jpg')), ('띄운 지하 2층', op(OUT / '지도-u08-04-띄움-지하2층-전체.jpg'))], '비교-u08-04-띄움-지하1층·지하2층.jpg')
row([(f"단면: 북쪽 다리를 따라(오른쪽 = 모서리, 왼쪽 = 지하 2층 발치). 낮은 벽 밑 {R['belowFloorAtBandM']} m 아래", op(OUT / '지도-u08-09-단면-북쪽다리-따라.jpg')), (f"단면: 남쪽 다리를 따라(오른쪽 = 머리 141.4, 왼쪽 = 모서리). 전체 {R['lengthM']} m 에 {R['dropM']} m, {R['gradePct']} %", op(OUT / '지도-u08-08-단면-남쪽다리-따라.jpg'))], '비교-u08-05-단면-경사로전체-북쪽다리·남쪽다리.jpg')
row([('사용자 사진 11 (X 둘, 화살표)', op(SRC / '11-경사로-섬-사진-사용자표시.webp')), ('1인칭: U07-06 과 같은 자리(부채꼴 남쪽 끝의 남쪽에서 북쪽을 봄)', op(OUT / '지도-u08-07-1인칭-섬사진11-자리.jpg'))], '비교-u08-06-섬사진11-옆에-1인칭.jpg', 700)
