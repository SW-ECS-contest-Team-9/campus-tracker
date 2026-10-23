"""X27: 위에서 본 그림(사용자 항공사진 위에 모델 기단·상자 외곽, 길). 전/후 둘.   python topdown.py <구조물 폴더 전> <구조물 폴더 후> <길 전 txt> <길 후 txt> <출력 png>
항공사진은 aerial-georef.json 의 변환으로 EPSG:5186 에 펴서 깐다."""
import json, sys, re, glob, pathlib
import numpy as np
from PIL import Image, ImageEnhance
from shapely.geometry import shape, box as sbox
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
HERE = pathlib.Path(__file__).parent; G = json.loads((HERE / 'aerial-georef.json').read_text(encoding='utf-8'))
IMG = 'C:/campus-tracker-backend/데이터/보완자료/학교-전경-20261022/항공/항공-한림관정문-은주1관.webp'
M = np.array(G['M']); Minv = np.linalg.inv(np.vstack([M.T, [0, 0, 1]]))
BX = (201080, 201135, 557238, 557292); res = 0.06
W, H = int((BX[1] - BX[0]) / res), int((BX[3] - BX[2]) / res)
im = np.asarray(Image.open(IMG).convert('RGB'))
gx, gy = np.meshgrid(BX[0] + np.arange(W) * res, BX[3] - np.arange(H) * res)
v = Minv @ np.vstack([gx.ravel(), gy.ravel(), np.ones(gx.size)])
px = np.clip(v[0].round().astype(int), 0, im.shape[1] - 1); py = np.clip(v[1].round().astype(int), 0, im.shape[0] - 1)
bg = ImageEnhance.Brightness(Image.fromarray(im[py, px].reshape(H, W, 3))).enhance(1.5)
B = sbox(BX[0], BX[2], BX[1], BX[3])
def draw(ax, sdir, roads, title):
    ax.imshow(bg, extent=[BX[0], BX[1], BX[2], BX[3]])
    for fn in sorted(glob.glob(sdir + '/*.geojson')):
        for f in json.load(open(fn, encoding='utf-8'))['features']:
            if not f.get('geometry'): continue
            g = shape(f['geometry']).buffer(0); p = f['properties']
            if not g.intersects(B) or p.get('kind') == 'void' or p.get('type') == 'tree': continue
            new = p['id'].startswith('X27-')
            if p.get('kind') == 'platform': c, lw, ls = ('#00e5ff', 1.0, '--')
            elif p.get('type') in ('stair_step', 'landing'): c, lw, ls = ('#ff3df5' if new else '#ffb3f8', 0.7 if new else 0.5, '-')
            else: c, lw, ls = ('#ffe600' if new else '#fff7a8', 0.6 if new else 0.35, '-')
            for q in (g.geoms if g.geom_type == 'MultiPolygon' else [g]):
                ax.plot(*q.exterior.xy, color=c, lw=lw, ls=ls)
    for r in [l.rstrip(chr(10)).split('|') for l in open(roads, encoding='utf-8') if '|' in l]:
        c = [(float(a), float(b)) for a, b in re.findall(r'([\d.]+) ([\d.]+)', r[-1])]
        ax.plot([q[0] for q in c], [q[1] for q in c], color='#ff2a2a' if r[3] == 'stairs' else '#ff9900', lw=2.0)
    ax.set_xlim(BX[0], BX[1]); ax.set_ylim(BX[2], BX[3]); ax.set_aspect('equal')
    ax.set_xticks(np.arange(BX[0], BX[1] + 1, 5)); ax.set_yticks(np.arange(BX[2] + 2, BX[3] + 1, 5)); ax.tick_params(labelsize=6); ax.grid(color='w', lw=0.25, alpha=0.5)
    ax.set_title(title, fontsize=10)
fig, axs = plt.subplots(1, 2, figsize=(22, 11.5))
draw(axs[0], sys.argv[1], sys.argv[3], '전: 모델(구조물·길) / 사용자 항공사진')
draw(axs[1], sys.argv[2], sys.argv[4], '후: X27~X31·X33·X34(진한 선 = 새 상자)')
fig.suptitle('한림관 정문 앞, 북 ↑, 격자 5 m. 바탕 = 사용자 항공사진(땅 위 표시 셋으로 맞춤, ±1.5 m). 하늘색 점선 = 기단, 분홍 = 계단·참, 노랑 = 그 밖의 상자, 빨강 = 계단 길, 주황 = 길', fontsize=11)
fig.tight_layout(); fig.savefig(sys.argv[5], dpi=95); print('saved', sys.argv[5])
