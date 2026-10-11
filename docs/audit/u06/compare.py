"""U06: 사용자 그림·사진·학교 지하도 지도와 새 갈무리를 나란히 놓는다(볼트 u06 폴더에만 쓴다. 사용자 그림·사진·지도 그림은 저장소에 넣지 않는다).   python compare.py
1 사용자 그림 12 | 지하 2층 | 지하 1층(같은 틀)   2 사진 11 | 1인칭   3 사진 14 | 1인칭   4 학교 지도 위에 새 평면   5 사진 08 | 북악관 지하 입구"""
import json, pathlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u06'; SRC = A / '사용자-운동장지하-20261012'
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); S = json.loads((HERE.parent / 'u04' / 'stalls.json').read_text(encoding='utf-8'))
def row(parts, name, h=None):
    h = h or max(im.height for _, im in parts); ims = [(t, im.resize((round(im.width * h / im.height), h), Image.LANCZOS)) for t, im in parts]
    out = Image.new('RGB', (sum(im.width for _, im in ims) + 8 * (len(ims) - 1), h + 30), 'white'); d = ImageDraw.Draw(out); x = 0
    for t, im in ims: out.paste(im, (x, 30)); d.text((x + 6, 5), t, fill='black', font=FONT); x += im.width + 8
    out.save(OUT / name, quality=90); print('saved', name, out.size)
op = lambda f: Image.open(f).convert('RGB')
def same(f): im = op(f); cx, cy = im.width // 2, im.height // 2; return im.crop((cx - 457, cy - 390, cx + 458, cy + 391))
row([('사용자 그림 12 (X 둘과 굽은 선, 옛 지하 2층 위)', op(SRC / '12-띄운-지하2층-사용자표시-X둘과-굽은선.png')), ('새 지하 2층: 서쪽 벽 옆으로 내려와 북서 모서리 밑에서 되돎', same(OUT / '지도-u06-01-띄움-지하2층-사용자그림12틀.jpg')), ('새 지하 1층: 어귀 구멍·반원 섬·낮은 벽, 문 앞 주차 칸', same(OUT / '지도-u06-02-띄움-지하1층-사용자그림12틀.jpg'))], '비교-u06-01-사용자그림12-옆에-지하2층·지하1층.jpg')
row([('사용자 사진 11 (X 둘, 화살표)', op(SRC / '11-경사로-섬-사진-사용자표시.webp')), ('1인칭: 어귀 남쪽에서 북쪽을 봄', op(OUT / '지도-u06-11-1인칭-섬사진11-자리.jpg'))], '비교-u06-02-섬사진11-옆에-1인칭.jpg', 700)
row([('사용자 사진 14 (은주관 문 벽을 등지고, 오른쪽 낮은 벽)', op(SRC / '14-은주관벽을-등지고-본-주차장-낮은벽표시.webp')), ('1인칭: 은주관 문 앞에서 주차장 쪽', op(OUT / '지도-u06-12-1인칭-은주관문-등지고-사진14.jpg'))], '비교-u06-03-사진14-옆에-1인칭.jpg', 600)
row([('사용자 사진 08 (북악관 지하 입구와 횡단 표시)', op(SRC / '08-지하차도-북악관-입구-횡단.webp')), ('지하 길 켬: 차도 남쪽에서 낮게', op(OUT / '지도-u06-10-북악관-지하입구-낮게.jpg')), ('지하 길 켬: 본관 쪽 위에서', op(OUT / '지도-u06-09-북악관-지하입구-남쪽위에서.jpg'))], '비교-u06-05-북악관지하입구-사진08-옆에.jpg', 600)
# 4 학교 지도 위에
G = json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8')); MX = np.array(G['matrix']); INV = np.linalg.inv(np.c_[MX, [0, 0, 1]])
MAP = op(SRC / '02-학교-캠퍼스맵-지하도-연결지점.jpg'); K = 5; mp = MAP.resize((MAP.width * K, MAP.height * K), Image.BICUBIC); d = ImageDraw.Draw(mp, 'RGBA'); px = lambda x, y: tuple(float(v) for v in (np.array([x, y, 1.0]) @ INV)[:2] * K)
F = {f['properties']['id']: f for f in json.loads((REPO / 'frontend/public/structures/u01-field-basement.geojson').read_text(encoding='utf-8'))['features']}
d.line([px(*p) for p in F['U02-VOID-B1']['geometry']['coordinates'][0]], fill=(255, 60, 60, 255), width=3)
for bl in S['B1']['blocks']: d.line([px(*p) for p in bl['polygon']], fill=(255, 230, 0, 255), width=2)
R = M['ramp']
d.line([px(*p) for p in R['footprint']], fill=(255, 150, 60, 255), width=2)
d.line([px(*p['xy']) for p in R['path']], fill=(255, 150, 60, 255), width=4)
d.line([px(*p) for p in R['opening']], fill=(0, 220, 255, 255), width=3)
d.line([px(*p) for p in R['island']['polygon']], fill=(0, 255, 120, 255), width=3)
for q in G['xy']['rampSymbol']: x, y = px(*q); d.ellipse([x - 6, y - 6, x + 6, y + 6], outline=(255, 0, 255, 255), width=3)
x, y = px(201146.21, 557283.45); d.rectangle([x - 7, y - 7, x + 7, y + 7], outline=(255, 255, 255, 255), width=3)
crop = mp.crop((330 * K, 250 * K, 600 * K, 480 * K)); d = ImageDraw.Draw(crop); d.rectangle([0, crop.height - 50, crop.width, crop.height], fill=(20, 20, 20))
d.text((8, crop.height - 47), "빨강 = 지하 1층 평면, 노랑 = 주차 칸 묶음, 하늘 = 어귀 구멍, 초록 = 반원 섬, 주황 = 경사로(굵은 선은 가운데 선: 지하 1층 바닥 아래), 흰 네모 = 은주관 문 노드, 자홍 동그라미 = 지도의 반원 표시를 읽은 세 점", fill='white', font=FONT)
d.text((8, crop.height - 24), f"섬 중심 ~ 지도 표시 {R['mapSymbol']['islandOffM']} m, 어귀 ~ 지도 표시 {R['mapSymbol']['mouthOffM']} m (좌표 맞춤 잔차 RMS {G['residualM']['rms']} m)", fill='white', font=FONT)
crop.save(OUT / '비교-u06-04-학교지도-위에-새평면.jpg', quality=90); print('saved 4', crop.size)
