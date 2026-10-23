"""X40: 위에서 본 그림. 사용자 표시 항공사진(georef.json 으로 EPSG:5186 에 폄) 위에 구조물 외곽(기단 하늘색 점선, 계단·참 분홍, 화단 초록, 그 밖 노랑)과 길(주황, 계단 빨강).
python -I topdown.py <구조물 폴더 전> <구조물 폴더 후> <길 전 json> <길 후 json> <출력 png> [x0 x1 y0 y1]
길 json = [{"structure", "coordinates": [[x, y, z], ...]}, ...] (시험용 DB 에서 뽑은 것)."""
import json, sys, glob, pathlib
import numpy as np
from PIL import Image, ImageEnhance
from shapely.geometry import shape, box as sbox
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
HERE = pathlib.Path(__file__).parent
import os
_A = 'C:/campus-tracker-backend/데이터/보완자료/학교-전경-20261022/항공/'
IMG = _A + os.environ.get('IMG', '사용자표시-한림관북쪽-화단.webp')   # 다른 바탕: IMG=그림 이름(georef-more.json 에 있는 것) 또는 d23(항공-대일관앞-원본, D23 변환)
MD23 = [[0.06406216770736912, 0.00048373671647442245], [0.00037821296498918855, -0.061974081796051905], [201121.09622608882, 557346.6850637228]]
if os.environ.get('IMG') == 'd23': IMG = _A + '../항공-대일관앞-원본.webp'; M = np.array(MD23)
else: M = np.array(json.loads((HERE / 'georef-more.json').read_text(encoding='utf-8'))[os.environ['IMG']]['M'] if os.environ.get('IMG') else json.loads((HERE / 'georef.json').read_text(encoding='utf-8'))['M'])
TITLE = os.environ.get('TITLE')
BX = tuple(float(v) for v in sys.argv[6:10]) if len(sys.argv) > 9 else (201128, 201185, 557288, 557325)
res = 0.05
W, H = int((BX[1] - BX[0]) / res), int((BX[3] - BX[2]) / res)
im = np.asarray(Image.open(IMG).convert('RGB'))
A = np.vstack([M.T, [0, 0, 1]]); Ainv = np.linalg.inv(A)
gx, gy = np.meshgrid(BX[0] + np.arange(W) * res, BX[3] - np.arange(H) * res)
v = Ainv @ np.vstack([gx.ravel(), gy.ravel(), np.ones(gx.size)])
px = np.clip(v[0].round().astype(int), 0, im.shape[1] - 1); py = np.clip(v[1].round().astype(int), 0, im.shape[0] - 1)
bg = ImageEnhance.Brightness(Image.fromarray(im[py, px].reshape(H, W, 3))).enhance(1.4)
B = sbox(BX[0], BX[2], BX[1], BX[3])
def draw(ax, sdir, roads, title):
    ax.imshow(bg, extent=[BX[0], BX[1], BX[2], BX[3]])
    for fn in sorted(glob.glob(sdir + '/*.geojson')):
        for f in json.load(open(fn, encoding='utf-8'))['features']:
            if not f.get('geometry'): continue
            g = shape(f['geometry']).buffer(0); p = f['properties']
            if not g.intersects(B) or p.get('kind') == 'void' or p.get('type') == 'tree' or p.get('underground') or p.get('inVoid'): continue
            if (p.get('toM') or 0) > 156 or p.get('type') == 'canopy': continue   # 지붕·처마는 빼고 땅 위 것만
            new = p['id'].startswith('X40-')
            if p.get('kind') == 'platform': c, lw, ls = ('#00e5ff', 0.9, '--')
            elif p.get('type') in ('stair_step', 'landing'): c, lw, ls = ('#ff3df5', 0.5, '-')
            elif p.get('type') == 'planter': c, lw, ls = ('#39ff6a', 1.2 if new else 0.7, '-')
            else: c, lw, ls = ('#ffe600', 1.2 if new else 0.4, '-')
            for q in (g.geoms if g.geom_type == 'MultiPolygon' else [g]):
                ax.plot(*q.exterior.xy, color=c, lw=lw, ls=ls)
    for r in json.load(open(roads, encoding='utf-8')):
        c = r['coordinates']
        ax.plot([q[0] for q in c], [q[1] for q in c], color='#ff2a2a' if r['structure'] == 'stairs' else '#ff9900', lw=2.0)
    ax.set_xlim(BX[0], BX[1]); ax.set_ylim(BX[2], BX[3]); ax.set_aspect('equal')
    ax.set_xticks(np.arange(BX[0], BX[1] + 1, 5)); ax.set_yticks(np.arange(BX[2], BX[3] + 1, 5)); ax.tick_params(labelsize=6); ax.grid(color='w', lw=0.25, alpha=0.5)
    ax.set_title(title, fontsize=10)
fig, axs = plt.subplots(1, 2, figsize=(22, 22 * (BX[3] - BX[2]) / (BX[1] - BX[0]) / 2 + 1))
draw(axs[0], sys.argv[1], sys.argv[3], '전 (main 85472a2)')
draw(axs[1], sys.argv[2], sys.argv[4], '후 (굵은 선 = X40 새 상자, 주황·빨강 = 시험용 DB 길)')
fig.suptitle(TITLE or '한림관 북쪽 ~ 대일관 현관 서쪽, 북 ↑, 격자 5 m. 바탕 = 사용자 표시 항공사진(X27 사진에 특징점 906개로 맞춤). 하늘색 점선 = 기단, 분홍 = 계단·참, 초록 = 화단, 노랑 = 그 밖, 주황 = 길, 빨강 = 계단 길', fontsize=11)
fig.tight_layout(); fig.savefig(sys.argv[5], dpi=95); print('saved', sys.argv[5])
