"""U02: 볼트의 근거 그림과 새 갈무리를 나란히 놓은 그림을 만든다(볼트 u02 폴더에만 쓴다. 근거 그림은 저장소에 넣지 않는다).   python compare.py
1 사용자 붉은 선 단면 | 새 단면(같은 틀, 사용자 선 높이를 점선으로)   2 U01 지하 길 | U02 지하 길   3 사진 03 | U자 경사로   4 학교 지도 위에 새 평면   5 운동장 위에서 U01 | U02 와 화소 차"""
import json, pathlib
import numpy as np
from PIL import Image, ImageDraw
from PIL import ImageFont
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 14)
HERE = pathlib.Path(__file__).parent; REPO = HERE.parents[2]
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); U = A / 'u02'; SRC = A / '사용자-운동장지하-20261012'
def side(left, right, out, h=None):
    l, r = Image.open(left).convert('RGB'), Image.open(right).convert('RGB') if not isinstance(right, Image.Image) else right
    h = h or min(l.height, r.height); l = l.resize((round(l.width * h / l.height), h)); r = r.resize((round(r.width * h / r.height), h))
    im = Image.new('RGB', (l.width + r.width + 8, h), 'white'); im.paste(l, (0, 0)); im.paste(r, (l.width + 8, 0)); im.save(U / out, quality=90); return im
# 1 단면
um = Image.open(SRC / '01-단면-사용자표시-B1-B2.png').convert('RGB'); a = np.array(um).astype(int); red = (a[:, :, 0] > 200) & (a[:, :, 1] < 70) & (a[:, :, 2] < 70)
Y160, Y110 = 239.0, 815.0; ppm = (Y110 - Y160) / 50; y2m = lambda y: 160 - (y - Y160) / ppm; m2y = lambda m: Y160 + (160 - m) * ppm   # 눈금 줄(160·110 m)의 화소 행
rows = {0: [], 1: [], 2: []}
for x in [x for x in range(150, 1055) if not 285 < x < 530]:   # B1·B2 글자 자리는 뺀다
    yy = np.where(red[:, x])[0]
    for g in (np.split(yy, np.where(np.diff(yy) > 6)[0] + 1) if len(yy) else []): rows[0 if g.mean() < 440 else 1 if g.mean() < 500 else 2].append(g.mean())
user = [round(y2m(float(np.median(rows[k]))), 2) for k in range(3)]; spread = [[round(y2m(float(v)), 2) for v in np.percentile(rows[k], [90, 10])] for k in range(3)]
new = Image.open(U / '지도-u02-02-단면-지하차도-운동장밑.jpg').convert('RGB').resize(um.size); d = ImageDraw.Draw(new)
for m in user:
    for x in range(0, new.width, 14): d.line([(x, m2y(m)), (x + 7, m2y(m))], fill=(225, 30, 30), width=2)
    d.text((8, m2y(m) - 16), f'사용자 선 {m:.1f} m', fill=(200, 0, 0), font=FONT)
side(SRC / '01-단면-사용자표시-B1-B2.png', new, '비교-u02-01-단면-사용자표시-옆에.jpg')
# 2 지하 길, 5 운동장 위에서
side(A / 'u01' / '지도-u01-06-지하길-운동장-남서위에서.jpg', U / '지도-u02-06-지하길-운동장-남서위에서.jpg', '비교-u02-02-지하길-U01-옆에.jpg')
p, q = (np.array(Image.open(f).convert('RGB')).astype(int) for f in (A / 'u01' / '지도-u01-08-운동장-위에서-지하길끔.jpg', U / '지도-u02-08-운동장-위에서-지하길끔.jpg'))
diff = np.abs(p - q).max(axis=2); side(A / 'u01' / '지도-u01-08-운동장-위에서-지하길끔.jpg', U / '지도-u02-08-운동장-위에서-지하길끔.jpg', '비교-u02-05-운동장위에서-U01-옆에.jpg')
# 3 사진 03
side(SRC / '03-지하1층에서-지하2층-내려가는길-곡선.jpg', U / '지도-u02-11-지하길-U자경사로-사진03자리.jpg', '비교-u02-03-U자경사로-사진03-옆에.jpg', h=600)
# 4 학교 지도 위에 새 평면
G = json.loads((HERE / 'georef.json').read_text(encoding='utf-8')); Mx = np.array(G['matrix']); inv = np.linalg.inv(np.c_[Mx, [0, 0, 1]])
to_px = lambda x, y: tuple((np.array([x, y, 1.0]) @ inv)[:2] * 2)
mp = Image.open(SRC / '02-학교-캠퍼스맵-지하도-연결지점.jpg').convert('RGB'); mp = mp.resize((mp.width * 2, mp.height * 2)); d = ImageDraw.Draw(mp)
F = {f['properties']['id']: f for f in json.loads((REPO / 'frontend/public/structures/u01-field-basement.geojson').read_text(encoding='utf-8'))['features']}
def poly(fid, color, width=3):
    c = [to_px(*xy) for xy in F[fid]['geometry']['coordinates'][0]]; d.line(c, fill=color, width=width)
poly('U02-VOID-B1', (255, 60, 60)); poly('U02-VOID-RAMP-OPENING', (255, 160, 0), 2); poly('U02-VOID-ROAD-LINK', (255, 60, 60), 2); poly('U02-VOID-HYEIN-PASSAGE', (0, 200, 255), 2); poly('U02-VOID-FIELD-STAIR', (0, 200, 255), 2)
for k in [k for k in F if k.startswith('U02-VOID-ROAD-') and k[-1].isdigit()][::6]: poly(k, (255, 60, 60), 1)
M = json.loads((HERE / 'model.json').read_text(encoding='utf-8'))
def line(pts, color, width=3): d.line([to_px(*p) for p in pts], fill=color, width=width)
xy = lambda o: o['xy']
line([[201021.95, 557307.07], [201023.5, 557313.0], [201025.2, 557323.1], [201034.0, 557342.5], [201034.5, 557351.2], [201046.6, 557352.45], [201053.9, 557349.2], [201056.2, 557348.2], [201081.2, 557336.5], xy(M['approach']['from']), xy(M['approach']['entry']), xy(M['approach']['wall']), xy(M['approach']['junction']), xy(M['points']['E1']), xy(M['ramp']['top'])] + [xy(o) for o in M['ramp']['arc']] + [xy(M['ramp']['curveEnd']), xy(M['ramp']['bottom'])], (255, 235, 0))
line([[200984.0, 557399.5], [200997.0, 557394.5], [201003.5, 557380.5], [201006.0, 557362.0], [201012.0, 557350.5], [201022.0, 557347.5], [201034.5, 557351.2]], (255, 235, 0), 2)
H = M['hyein']; line([xy(H['door']), xy(H['l0']), xy(H['f1']), xy(H['l1']), xy(H['bottom']), xy(H['out'])] + [xy(o) for o in H['via']] + [xy(M['approach']['junction']), xy(M['points']['SBN']), xy(M['points']['DOOR'])], (0, 220, 255), 2)
line([xy(M['points']['SBN']), xy(M['points']['ST'])], (0, 220, 255), 2)
d.rectangle([8, mp.height - 62, 700, mp.height - 6], fill=(20, 20, 20))
d.text((14, mp.height - 58), font=FONT, text=f"빨강 = U02 지하 1층·2층 평면과 지하 차도 빈 곳, 노랑 = 차량 길(가는 선 = 서문 쪽, 지도에 없음), 하늘색 = 사람 길 셋", fill='white')
d.text((14, mp.height - 38), font=FONT, text=f"좌표 맞춤: 건물 모서리 19점 아핀, 잔차 RMS {G['residualM']['rms']} m (최대 {G['residualM']['max']} m)", fill='white')
mp.save(U / '비교-u02-04-학교지도-위에-새평면.jpg', quality=90)
out = {'userLinesM': user, 'userLineSpreadM': spread, 'modelM': {'b1Ceiling': M['heights']['b1Ceiling'], 'b1Floor': M['heights']['b1Floor'], 'b1SlabBottom': M['heights']['b2Ceiling'], 'b2Floor': M['heights']['b2Floor']},
       'fieldFromAbove': {'maxPixelDiff': int(diff.max()), 'pixelsOver32': int((diff > 32).sum()), 'pixels': int(diff.size)}}
(HERE / 'compare.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print(out)
