"""U07: 학교 지하도 지도·사용자 사진과 새 갈무리를 나란히 놓는다(볼트 u07 폴더에만 쓴다. 지도 그림·사용자 사진은 저장소에 넣지 않는다).   python compare.py
1 학교 지도 조각 | 지하 1층 평면(같은 틀, 지도의 부채꼴 외곽을 겹침) | 지하 2층   2 사진 14 | 1인칭   3 사진 11 | 1인칭   4 띄운 지하 1층 | 지하 2층   5 학교 지도 위에 새 평면"""
import json, pathlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
HERE = pathlib.Path(__file__).parent
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u07'; SRC = A / '사용자-운동장지하-20261012'
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); S = json.loads((HERE.parent / 'u04' / 'stalls.json').read_text(encoding='utf-8')); CR = json.loads((HERE / 'crescent.json').read_text(encoding='utf-8'))
V = json.loads((HERE / 'views.json').read_text(encoding='utf-8')); G = json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8')); MX = np.array(G['matrix']); INV = np.linalg.inv(np.c_[MX, [0, 0, 1]])
def row(parts, name, h=None):
    h = h or max(im.height for _, im in parts); ims = [(t, im.resize((round(im.width * h / im.height), h), Image.LANCZOS)) for t, im in parts]
    out = Image.new('RGB', (sum(im.width for _, im in ims) + 8 * (len(ims) - 1), h + 30), 'white'); d = ImageDraw.Draw(out); x = 0
    for t, im in ims: out.paste(im, (x, 30)); d.text((x + 6, 5), t, fill='black', font=FONT); x += im.width + 8
    out.save(OUT / name, quality=90); print('saved', name, out.size)
op = lambda f: Image.open(f).convert('RGB')
# 1 학교 지도 조각을 갈무리와 같은 틀(북이 위, 가운데·가로 m)로 옮겨 놓고, 둘 다에 지도에서 읽은 부채꼴 외곽을 그린다
MAP = op(SRC / '블로그-사진' / '블로그-03.jpg'); F = MAP.width / 800
def framed(shot, lift):
    im = op(OUT / shot); W, H = im.size; (cx, cy), wm = lift['centre'], lift['widthM']; k = W / wm
    to_px = lambda x, y: ((x - cx) * k + W / 2, H / 2 - (y - cy) * k)
    # 틀의 화소 (u, v) → 좌표 → 지도 화소: PIL 의 AFFINE 은 출력 화소에서 입력 화소로 가는 6개 값
    a = np.array([[1 / k, 0, cx - W / 2 / k], [0, -1 / k, cy + H / 2 / k], [0, 0, 1]])        # 화소 → 좌표
    b = np.c_[MX, [0, 0, 1]]; t = (a.T @ np.linalg.inv(b)) * F                                  # 행벡터 꼴: [u v 1] a^T inv(b) = 800 화소 그림의 화소
    mp = MAP.transform((W, H), Image.AFFINE, (t[0, 0], t[1, 0], t[2, 0], t[0, 1], t[1, 1], t[2, 1]), Image.BICUBIC)
    return im, mp, to_px
ring = CR['outline'] + [CR['outline'][0]]
lift = V['01-띄움-지하1층-학교지도틀']['lift']
b1, mp, to_px = framed('지도-u07-01-띄움-지하1층-학교지도틀.jpg', lift); b2, _, _ = framed('지도-u07-02-띄움-지하2층-학교지도틀.jpg', lift)
for im, col in ((mp, (255, 40, 40)), (b1, (255, 40, 40)), (b2, (255, 40, 40))):
    d = ImageDraw.Draw(im); d.line([to_px(*p) for p in ring], fill=col, width=2); x, y = to_px(201146.21, 557283.45); d.rectangle([x - 6, y - 6, x + 6, y + 6], outline=(255, 255, 255), width=2)
row([('학교 지하도 지도(블로그-03)를 같은 틀로. 붉은 선 = 읽은 부채꼴 외곽, 흰 네모 = 은주관 문 노드', mp), ('새 지하 1층(띄움): 부채꼴 = 바닥 구멍(흰 곳)', b1), ('새 지하 2층(띄움): 섬 둘레로 더 돌아 곧은 구간으로 발치', b2)], '비교-u07-01-학교지도-옆에-지하1층·지하2층-부채꼴겹침.jpg')
row([('사용자 사진 14 (은주관 문 벽을 등지고, 오른쪽 낮은 벽)', op(SRC / '14-은주관벽을-등지고-본-주차장-낮은벽표시.webp')), ('1인칭: 은주관 문 앞에서 주차장 쪽', op(OUT / '지도-u07-05-1인칭-은주관문-등지고-사진14.jpg'))], '비교-u07-02-사진14-옆에-1인칭.jpg', 600)
row([('사용자 사진 11 (X 둘, 화살표)', op(SRC / '11-경사로-섬-사진-사용자표시.webp')), ('1인칭: 부채꼴 남쪽 끝(어귀) 앞에서 북쪽을 봄', op(OUT / '지도-u07-06-1인칭-섬사진11-자리.jpg'))], '비교-u07-03-섬사진11-옆에-1인칭.jpg', 700)
row([('띄운 지하 1층', op(OUT / '지도-u07-03-띄움-지하1층-사용자그림12틀.jpg')), ('띄운 지하 2층', op(OUT / '지도-u07-04-띄움-지하2층-사용자그림12틀.jpg'))], '비교-u07-04-띄움-지하1층·지하2층.jpg')
# 5 학교 지도 위에 새 평면
K = 5; big = MAP.resize((MAP.width * K, MAP.height * K), Image.BICUBIC); d = ImageDraw.Draw(big, 'RGBA'); px = lambda x, y: tuple(float(v) for v in (np.array([x, y, 1.0]) @ INV)[:2] * F * K)
for bl in S['B1']['blocks']: d.line([px(*p) for p in bl['polygon']], fill=(255, 230, 0, 255), width=2)
R = M['ramp']
d.line([px(*p) for p in R['footprint']], fill=(255, 150, 60, 255), width=2); d.line([px(*p['xy']) for p in R['path']], fill=(255, 150, 60, 255), width=4)
d.line([px(*p) for p in ring], fill=(0, 220, 255, 255), width=3); d.line([px(*p) for p in R['island']['polygon']], fill=(0, 255, 120, 255), width=2); d.line([px(*p) for p in R['guide']], fill=(255, 255, 255, 255), width=2)
x, y = px(201146.21, 557283.45); d.rectangle([x - 7, y - 7, x + 7, y + 7], outline=(255, 255, 255, 255), width=3)
crop = big.crop((int(360 * F * K), int(280 * F * K), int(560 * F * K), int(460 * F * K))); d = ImageDraw.Draw(crop); d.rectangle([0, crop.height - 73, crop.width, crop.height], fill=(20, 20, 20))
d.text((8, crop.height - 70), "노랑 = 주차 칸 묶음(지하 1층), 하늘 = 바닥 구멍(지도의 부채꼴), 초록 = 섬, 흰 선 = 유도선, 흰 네모 = 은주관 문 노드", fill='white', font=FONT)
d.text((8, crop.height - 47), "주황 = 경사로(굵은 선은 가운데 선. 부채꼴 밖은 지하 1층 바닥 아래, 추정)", fill='white', font=FONT)
d.text((8, crop.height - 24), f"부채꼴: 중심 ({CR['centre'][0]}, {CR['centre'][1]}), 반지름 {CR['innerRadiusM']}~{CR['outerRadiusM']} m, 가운데 선 {CR['centreLineLengthM']} m. 좌표 맞춤 잔차 RMS {G['residualM']['rms']} m", fill='white', font=FONT)
crop.save(OUT / '비교-u07-05-학교지도-위에-새평면.jpg', quality=90); print('saved 5', crop.size)
