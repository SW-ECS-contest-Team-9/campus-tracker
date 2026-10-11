"""U09: 사용자 그림·학교 지하도 지도와 새 갈무리를 나란히 놓는다(볼트 u09 폴더에만 쓴다. 지도 그림·사용자 그림은 저장소에 넣지 않는다).   python compare.py
1 사용자 그림 17 | 새 지하 1층(같은 방향)   2 학교 지도 조각 | 지하 1층 | 지하 2층 (같은 틀, ㄴ자 가운데 선과 지도의 부채꼴)   3 사용자 그림 16 | 새 지하 1층
4 옛 외곽·새 외곽·운동장 외곽 겹침   5 단면: 북쪽 다리 | 남쪽 다리   + 운동장 위 화면의 U08 과의 화소 차"""
import json, pathlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageChops
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
HERE = pathlib.Path(__file__).parent
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u09'; SRC = A / '사용자-운동장지하-20261012'
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); CR = json.loads((HERE.parent / 'u07' / 'crescent.json').read_text(encoding='utf-8')); R = M['ramp']; O = M['outline']
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
row([('사용자 그림 17 (U08 의 띄운 지하 1층, 붉은 동그라미 = 굽은 곳)', op(SRC / '17-띄운-지하1층-경사로-굽은곳-사용자표시.png')), (f"새 지하 1층(같은 방향, 바로 위에서). 굽은 곳 바깥 벽 ~ 평면 가장자리 {R['outerArcToWallU08M']} → {R['outerArcToWallM']} m", op(OUT / '지도-u09-03-띄움-지하1층-그림17방향.jpg'))], '비교-u09-01-사용자그림17-옆에-새지하1층.jpg', 860)
ring = CR['outline'] + [CR['outline'][0]]; path = [p['xy'] for p in R['path']]
lift = V['01-띄움-지하1층-학교지도틀']['lift']
b1, mp, to_px = framed('지도-u09-01-띄움-지하1층-학교지도틀.jpg', lift); b2, _, _ = framed('지도-u09-02-띄움-지하2층-학교지도틀.jpg', lift)
for im in (mp, b1, b2):
    d = ImageDraw.Draw(im); d.line([to_px(*p) for p in ring], fill=(255, 40, 40), width=2); d.line([to_px(*p) for p in path], fill=(255, 0, 255), width=3)
    for p, t in ((path[0], '머리 141.4'), (R['band']['xy'], f"낮은 벽 밑 {R['band']['z']}"), (path[-1], '발치 133.0')):
        x, y = to_px(*p); d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=(255, 0, 255), outline='white'); d.text((x + 9, y - 9), t, fill=(255, 0, 255), font=FONT, stroke_width=3, stroke_fill='white')
    x, y = to_px(201146.21, 557283.45); d.rectangle([x - 6, y - 6, x + 6, y + 6], outline=(255, 255, 255), width=2)
row([('학교 지하도 지도(블로그-03)를 같은 틀로. 붉은 선 = 읽은 부채꼴, 자홍 = ㄴ자 가운데 선, 흰 네모 = 은주관 문', mp), ('새 지하 1층(띄움): 남쪽 다리 + 모서리 + 북쪽 다리 첫 구간이 트여 있고 낮은 벽에서 바닥 아래로', b1), ('새 지하 2층(띄움): 북쪽 다리가 서쪽 벽과 나란히 내려와 발치', b2)], '비교-u09-02-학교지도-옆에-지하1층·지하2층-ㄴ자.jpg')
u16 = op(SRC / '16-U07비교그림-사용자-붉은화살표.webp'); w3 = u16.width // 3
row([('사용자 그림 16 의 가운데 칸(U07 지하 1층 위의 붉은 화살표)', u16.crop((w3, 0, 2 * w3, u16.height))), ('새 지하 1층(같은 틀). 자홍 = ㄴ자 가운데 선', b1)], '비교-u09-03-사용자그림16-옆에-새지하1층.jpg', 820)
# 외곽 견줌: 띄운 지하 1층 전체(북이 위) 위에 운동장 외곽(흰 선), U08 외곽(붉은 선), 새 외곽(초록 선), 서쪽으로 넓힌 곳(노랑)
wl = V['04-띄움-지하1층-전체']['lift']; im, _, px = framed('지도-u09-04-띄움-지하1층-전체.jpg', wl); d = ImageDraw.Draw(im)
d.line([px(*p) for p in O['fieldRing']], fill=(255, 255, 255), width=4); d.line([px(*p) for p in O['fieldRing']], fill=(30, 60, 200), width=2)
d.line([px(*p) for p in O['u08Ring']], fill=(230, 30, 30), width=2); d.line([px(*p) for p in O['ring']], fill=(20, 170, 60), width=3); d.line([px(*p) for p in O['westExtension']['ring']], fill=(240, 200, 0), width=2)
for q in O['outsideFieldB1']:
    x, y = px(*q['centre']); d.text((x + 6, y - 8), f"+{q['areaM2']:.0f} ㎡ / {q['maxBeyondFieldM']} m", fill=(0, 110, 30), font=FONT, stroke_width=3, stroke_fill='white')
row([(f"파랑 = 운동장 외곽, 빨강 = U08 평면({O['u08AreaM2']:.0f} ㎡), 초록 = 새 평면(지하 1층 {O['b1AreaM2']:.0f} ㎡), 노랑 = 서쪽으로 넓힌 곳. 숫자 = 운동장 밖 넓이 / 가장 먼 곳", im)], '비교-u09-04-외곽-옛것·새것·운동장.jpg')
row([(f"단면: 북쪽 다리를 따라(서쪽 벽과 나란히). 낮은 벽 밑 {R['belowFloorAtBandM']} m 아래, 은주관 문 옆에서 바닥 밑 {R['levelBelowDoorM']} m", op(OUT / '지도-u09-09-단면-북쪽다리-따라.jpg')), (f"단면: 남쪽 다리를 따라(벽의 직각). 전체 {R['lengthM']} m 에 {R['dropM']} m, {R['gradePct']} %", op(OUT / '지도-u09-08-단면-남쪽다리-따라.jpg'))], '비교-u09-05-단면-경사로전체-북쪽다리·남쪽다리.jpg')
a, b = op(A / 'u08' / '지도-u08-11-운동장-위에서-지하길끔.jpg'), op(OUT / '지도-u09-11-운동장-위에서-지하길끔.jpg'); df = np.asarray(ImageChops.difference(a, b)).max(axis=2)
print('운동장 위 화면 U08 과의 화소 차: 최대', int(df.max()), '/ 255, 차 > 24 인 화소', int((df > 24).sum()), '/', df.size)
