"""U05: 사용자 그림·학교 지하도 지도와 새 갈무리를 나란히 놓는다(볼트 u05 폴더에만 쓴다. 사용자 그림·지도 그림은 저장소에 넣지 않는다).   python compare.py
1 북서 모서리: 사용자 그림 05 | 전 | 후   2 사용자 붉은 선(07) | 후 지하 2층 | 후 지하 1층: 같은 틀(같은 가운데·4.46 화소/m, 북이 위)   3 학교 지도 위에 새 평면(지하 1층 외곽·곧은 차로·지하 차도 선·주차 칸·바깥 차로·사용자 붉은 선)"""
import json, pathlib, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'u05'; SRC = A / '사용자-운동장지하-20261012'
VW = json.loads((HERE / 'views.json').read_text(encoding='utf-8')); M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); S = json.loads((HERE.parent / 'u04' / 'stalls.json').read_text(encoding='utf-8'))
def row(parts, name, h=None):
    h = h or max(im.height for _, im in parts); ims = [(t, im.resize((round(im.width * h / im.height), h), Image.LANCZOS)) for t, im in parts]
    out = Image.new('RGB', (sum(im.width for _, im in ims) + 8 * (len(ims) - 1), h + 30), 'white'); d = ImageDraw.Draw(out); x = 0
    for t, im in ims: out.paste(im, (x, 30)); d.text((x + 6, 5), t, fill='black', font=FONT); x += im.width + 8
    out.save(OUT / name, quality=90); print('saved', name, out.size)
op = lambda f: Image.open(f).convert('RGB')
# 1
b, a = op(OUT / '지도-u05-전-01-띄움-지하1층-북서모서리.jpg'), op(OUT / '지도-u05-후-01-띄움-지하1층-북서모서리.jpg')
row([('사용자 그림 05 (지적한 자리)', op(SRC / '05-사용자지적-주차장북서모서리-지하차도-일직선.png')), ('전: 28도 꺾어 북쪽 벽으로(U02)', b), ('후: 한 직선으로 목에 닿음(U05)', a)], '비교-u05-01-북서모서리-사용자그림05-전-후.jpg', 700)
# 2 같은 틀: 갈무리는 가운데가 같은 자리, 4.46 화소/m -> 사용자 그림의 크기(915 x 781)만큼 가운데에서 잘라 낸다
user = op(SRC / '07-띄운-지하2층-사용자-붉은선.png')
def same(f): im = op(f); cx, cy = im.width // 2, im.height // 2; return im.crop((cx - 457, cy - 390, cx + 458, cy + 391))
row([('사용자 붉은 선(그림 07, 띄운 지하 2층 위)', user), ('후: 지하 2층(곧은 차로 비움, 서쪽 바깥 차로)', same(OUT / '지도-u05-후-03-띄움-지하2층-전체.jpg')), ('후: 지하 1층(지하 차도 목 + 곧은 차로)', same(OUT / '지도-u05-후-02-띄움-지하1층-전체.jpg'))], '비교-u05-02-사용자붉은선-옆에-지하2층·지하1층.jpg')
# 3 학교 지도 위에
G = json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8')); MX = np.array(G['matrix']); INV = np.linalg.inv(np.c_[MX, [0, 0, 1]])
MAP = op(SRC / '02-학교-캠퍼스맵-지하도-연결지점.jpg'); K = 4; mp = MAP.resize((MAP.width * K, MAP.height * K), Image.BICUBIC); d = ImageDraw.Draw(mp, 'RGBA'); px = lambda x, y: tuple(float(v) for v in (np.array([x, y, 1.0]) @ INV)[:2] * K)
F = {f['properties']['id']: f for f in json.loads((REPO / 'frontend/public/structures/u01-field-basement.geojson').read_text(encoding='utf-8'))['features']}
d.line([px(*p) for p in F['U02-VOID-B1']['geometry']['coordinates'][0]], fill=(255, 60, 60, 255), width=3)
d.line([px(*p) for p in F['U02-VOID-B2']['geometry']['coordinates'][0]], fill=(255, 150, 60, 255), width=1)
for bl in S['B1']['blocks']: d.line([px(*p) for p in bl['polygon']], fill=(255, 230, 0, 255), width=2)
AP = M['approach']; D = np.array(AP['direction']); N = np.array([-D[1], D[0]]); E0, LE, P0 = np.array(AP['entry']['xy']), np.array(AP['laneEnd']['xy']), np.array(AP['from']['xy'])
for o in (-3.6, 3.6): d.line([px(*(P0 + N * o)), px(*(LE + N * o))], fill=(0, 255, 120, 255), width=2)
d.line([px(*P0), px(*AP['junction']['xy'])], fill=(0, 255, 120, 255), width=4)
d.line([px(201053.9, 557349.2), px(*P0)], fill=(0, 200, 255, 255), width=4)
d.line([px(*p) for p in M['ramp']['outer']['polygon']], fill=(255, 150, 60, 255), width=2)
ST = json.loads((HERE / 'strokes.json').read_text(encoding='utf-8'))
for k in ('line1', 'line1b'): d.line([px(*ST[k]['from']), px(*ST[k]['to'])], fill=(255, 0, 255, 255), width=3)
crop = mp.crop((180 * K, 150 * K, 670 * K, 480 * K)); d = ImageDraw.Draw(crop); d.rectangle([0, crop.height - 50, crop.width, crop.height], fill=(20, 20, 20))
d.text((8, crop.height - 47), f"빨강 = 지하 1층 평면(목 포함), 주황 = 지하 2층 평면·바깥 차로, 초록 = 지하 차도 연장(굵은 선)과 폭 7.2 m 곧은 차로의 양 가장자리, 하늘 = 본관 옆 구간(951c157d, 그대로), 자홍 = 사용자 붉은 선 1·1b(직선 맞춤), 노랑 = 주차 칸 묶음", fill='white', font=FONT)
d.text((8, crop.height - 24), f"지도의 점선 끝은 축에서 남쪽 {abs(AP['mapEndOffAxisM'])} m(폭의 가장자리), 좌표 맞춤 잔차 RMS {G['residualM']['rms']} m. 본관 옆 구간과 {AP['bendAtFromDeg']['vsRoad951c157d']}도", fill='white', font=FONT)
crop.save(OUT / '비교-u05-03-학교지도-위에-새평면.jpg', quality=90); print('saved 3', crop.size)
