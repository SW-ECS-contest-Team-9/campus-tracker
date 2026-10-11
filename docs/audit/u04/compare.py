"""U04: 볼트의 학교 지하도 지도와 새 갈무리를 견주는 그림을 만든다(볼트 u04 폴더에만 쓴다. 지도 그림은 저장소에 넣지 않는다).   python compare.py
1 학교 지도 조각(좌표에 맞춰 편 것) | 지하 길 켠 평면 갈무리: 같은 틀(같은 좌표 범위, 북이 위)   2 학교 지도 위에 주차 칸 묶음·통로 면   3 운동장 위에서 U02 | U04(지하 길 끔)와 화소 차"""
import json, pathlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
HERE = pathlib.Path(__file__).parent
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u04'; SRC = A / '사용자-운동장지하-20261012'
G = json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8')); MX = np.array(G['matrix']); INV = np.linalg.inv(np.c_[MX, [0, 0, 1]])
S = json.loads((HERE / 'stalls.json').read_text(encoding='utf-8')); VW = json.loads((HERE / 'views.json').read_text(encoding='utf-8'))
MAP = Image.open(SRC / '02-학교-캠퍼스맵-지하도-연결지점.jpg').convert('RGB')

# ---------- 1 같은 틀 ----------
plan = VW['01-지하길-주차장-바로위에서']['plan']; (CX, CY), W = plan['centre'], plan['widthM']
shot = Image.open(OUT / '지도-u04-01-지하길-주차장-바로위에서.jpg').convert('RGB'); k = shot.width / W; HALF = 68.0   # 화소 / m, 틀의 반 변(m)
box = [round(shot.width / 2 - HALF * k), round(shot.height / 2 - HALF * k), round(shot.width / 2 + HALF * k), round(shot.height / 2 + HALF * k)]
right = shot.crop(box); n = right.width
# 출력 화소 (i, j) → 좌표 (CX - HALF + i / k, CY + HALF - j / k) → 지도 화소
wx = np.array([1 / k, 0, CX - HALF]); wy = np.array([0, -1 / k, CY + HALF])
co = [float(v) for v in (wx * INV[0, 0] + wy * INV[1, 0] + np.array([0, 0, INV[2, 0]]))] + [float(v) for v in (wx * INV[0, 1] + wy * INV[1, 1] + np.array([0, 0, INV[2, 1]]))]
left = MAP.transform((n, n), Image.AFFINE, co, resample=Image.BICUBIC)
im = Image.new('RGB', (2 * n + 8, n + 30), 'white'); im.paste(left, (0, 30)); im.paste(right, (n + 8, 30)); d = ImageDraw.Draw(im)
d.text((6, 5), f"학교 지하도 지도(좌표 맞춤 잔차 RMS {G['residualM']['rms']} m로 편 조각)", fill='black', font=FONT); d.text((n + 14, 5), f'시험 지도, 지하 길 켬, 바로 위에서 (같은 좌표 범위 {2 * HALF:.0f} m, 북이 위)', fill='black', font=FONT)
im.save(OUT / '비교-u04-01-학교지도-옆에-지하1층평면.jpg', quality=90)

# ---------- 2 학교 지도 위에 ----------
K = 4; mp = MAP.resize((MAP.width * K, MAP.height * K), Image.BICUBIC); d = ImageDraw.Draw(mp, 'RGBA'); px = lambda x, y: tuple(float(v) for v in (np.array([x, y, 1.0]) @ INV)[:2] * K)
a = S['B1']['aisle']; d.line([px(*p) for p in a[0]], fill=(255, 60, 60, 255), width=3)
for b in S['B1']['blocks']: d.line([px(*p) for p in b['polygon']], fill=(255, 230, 0, 255), width=2)
for b in S['mapBlocks']: d.text(px(*b['centre']), b['id'], fill=(0, 255, 255, 255), font=FONT)
crop = mp.crop((350 * K, 270 * K, 670 * K, 610 * K)); d = ImageDraw.Draw(crop); d.rectangle([0, crop.height - 28, crop.width, crop.height], fill=(20, 20, 20))
d.text((8, crop.height - 25), '빨강 = 지하 1층 통로 면의 바깥 테두리, 노랑 = 둔 주차 칸 묶음(칸 2.5 × 5.0 m 추정). 지도의 칸 그림과 어긋난 만큼이 치수 차·옮긴 양', fill='white', font=FONT)
crop.save(OUT / '비교-u04-02-학교지도-위에-칸묶음.jpg', quality=90)

# ---------- 3 운동장 위(지하 길 끔): U02 와 ----------
p, q = (np.array(Image.open(f).convert('RGB')).astype(int) for f in (A / 'u02' / '지도-u02-08-운동장-위에서-지하길끔.jpg', OUT / '지도-u04-04-운동장-위에서-지하길끔.jpg'))
diff = np.abs(p - q).max(axis=2); tan = (np.abs(p - np.array([201, 149, 107])).max(axis=2) < 40)   # 운동장 면 색(#c9956b) 근처인 화소
l, r = Image.fromarray(p.astype(np.uint8)), Image.fromarray(q.astype(np.uint8)); im = Image.new('RGB', (l.width * 2 + 8, l.height), 'white'); im.paste(l, (0, 0)); im.paste(r, (l.width + 8, 0)); im.save(OUT / '비교-u04-03-운동장위에서-U02-옆에.jpg', quality=90)
out = {'sameFrame': {'centre': [CX, CY], 'sideM': 2 * HALF, 'pxPerM': round(k, 3)}, 'fieldFromAbove': {'maxPixelDiffOnField': int(diff[tan].max()), 'fieldPixels': int(tan.sum()), 'fieldPixelsOver32': int((diff[tan] > 32).sum()), 'allPixelsOver32': int((diff > 32).sum()), 'pixels': int(diff.size)}}
(HERE / 'compare.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(out)
