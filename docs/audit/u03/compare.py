"""U03: 갈무리를 안내 글 사진 옆에 붙이고, 걷는 길을 학교 지하도 지도 위에 겹친다(그림은 볼트에만 쓴다).   python compare.py"""
import json, pathlib, numpy as np
from PIL import Image, ImageDraw
HERE = pathlib.Path(__file__).parent
EV = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = EV / 'u03'; BL = EV / '사용자-운동장지하-20261012' / '블로그-사진'
def side(name, shot, blogs, h=640):
    ims = [Image.open(OUT / shot)] + [Image.open(BL / f'블로그-{b:02d}.jpg') for b in blogs]
    ims = [i.convert('RGB').resize((round(i.width * h / i.height), h)) for i in ims]
    w = sum(i.width for i in ims) + 8 * (len(ims) - 1); c = Image.new('RGB', (w, h), 'white'); x = 0
    for i in ims: c.paste(i, (x, 0)); x += i.width + 8
    c.save(OUT / name, quality=88); print(name)
side('비교-u03-01-연결통로-은주1관·한림관-사진09·10-옆에.jpg', '지도-u03-03-연결통로-은주1관·한림관-남쪽위에서.jpg', [9, 10])
side('비교-u03-02-연결통로-본관·한림관-사진11-옆에.jpg', '지도-u03-04-연결통로-본관·한림관-남쪽위에서.jpg', [11])
side('비교-u03-03-본관-정류장에서-사진20-옆에.jpg', '지도-u03-05-본관-정류장에서.jpg', [20])
side('비교-u03-04-단면-본관2층·유담관7층-사진17-옆에.jpg', '지도-u03-06-단면-본관2층-유담관7층.jpg', [17])
# 학교 지도 위에 걷는 길
G = json.loads((HERE.parent / 'u02' / 'georef.json').read_text(encoding='utf-8')); M = np.array(G['matrix']); A = np.linalg.inv(M[:2]); px = lambda x, y: tuple((np.array([x, y]) - M[2]) @ A)
s = json.loads((OUT / 'b-40-state-after.json').read_text(encoding='utf-8')); R = json.loads((OUT / 'b-41-routes.json').read_text(encoding='utf-8'))
im = Image.open(EV / '사용자-운동장지하-20261012' / '02-학교-캠퍼스맵-지하도-연결지점.jpg').convert('RGB'); k = 2; im = im.resize((im.width * k, im.height * k)); dr = ImageDraw.Draw(im)
names = set(R['혜인관 지하 1층 문 → 정류장 (지하도)']['via'])
for r in s['roads']:
    nm = (r['name'] or r['id'])[:28]
    if nm in names and r['structure'] != 'elevator': dr.line([tuple(k * v for v in px(c[0], c[1])) for c in r['coordinates']], fill=(255, 40, 200), width=5)
for r in s['roads']:
    if r['structure'] == 'elevator' and (r['name'] or '').startswith(('본관 승강기', '유담관 지하통로')): x, y = (k * v for v in px(*r['coordinates'][0][:2])); dr.rectangle([x - 7, y - 7, x + 7, y + 7], outline=(255, 255, 0), width=3)
for p in s['places']:
    if p['name'].startswith('지하통로 입구'): x, y = (k * v for v in px(*p['coordinate'][:2])); dr.ellipse([x - 8, y - 8, x + 8, y + 8], outline=(0, 255, 255), width=3)
im.save(OUT / '비교-u03-05-학교지도-위에-걷는길.jpg', quality=90); print('map')
