"""Z03: 구조물 파일의 기단·상자를 S-MAP 정사 그림 위에 겹쳐 그린다(자리 확인). python -I plot_plan.py"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from PIL import Image
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
im = np.asarray(Image.open(Z03 / 'smap-정사-분수광장-01m.png')); X0, X1, Y0, Y1 = 201024, 201110, 557163, 557266
fs = json.loads((REPO / 'frontend/public/structures/z03-fountain.geojson').read_text(encoding='utf-8'))['features']
fig, ax = plt.subplots(1, 2, figsize=(26, 15))
for a in ax: a.imshow(im, extent=[X0, X1, Y0, Y1]); a.set_xlim(X0, X1); a.set_ylim(Y0 - 9, Y1)
col = {'platform': 'yellow', 'wall': 'red', 'canopy': 'cyan', 'planter': 'lime', 'landing': 'white', 'stair_step': 'orange', 'barrier': 'magenta'}
for f in fs:
    p = f['properties']; c = np.array(f['geometry']['coordinates'][0])
    ax[1].plot(c[:, 0], c[:, 1], color=col[p['type']], lw=1.6 if p['kind'] == 'platform' else 0.8)
    if p['kind'] == 'platform': ax[1].text(c[:, 0].mean(), c[:, 1].mean(), p['id'][13:] + '\n' + str(p.get('topM', '종단')), color='yellow', fontsize=8, ha='center')
for b in buildings():
    c = b['coordinates']
    while isinstance(c[0][0], list): c = c[0]
    c = np.array(c); ax[1].plot(c[:, 0], c[:, 1], 'b--', lw=1)
ax[0].set_title('S-MAP 위에서 본 그림(0.1 m/px로 편 것)'); ax[1].set_title('기단(노랑)·상자, 건물 원천 외곽(파란 점선)')
plt.tight_layout(); plt.savefig(Z03 / '평면-기단과-상자.png', dpi=60); print('ok')
