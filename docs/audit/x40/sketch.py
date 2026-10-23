"""X40: 문예관 저층부 동쪽 끝 ~ 대일관 서쪽 현관 길 구조 그림(Claude 유추, 구역 노트 오르막길과 주변 X40 절의 표).   python sketch.py <출력 png>
바탕 = 사용자 표시 항공사진(D23 변환, georef.json). 구조물은 지금 파일(x40-parts·g02-way·z02-daeil-front)에서 읽는다."""
import json, sys, glob, pathlib, importlib.util
import numpy as np
from PIL import Image, ImageEnhance
from shapely.geometry import shape, Polygon
from shapely.ops import unary_union
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'
HERE = pathlib.Path(__file__).parent; STR = HERE.parents[2] / 'frontend' / 'public' / 'structures'
sp = importlib.util.spec_from_file_location('g', HERE.parent / 'g02' / 'common.py'); G = importlib.util.module_from_spec(sp); sp.loader.exec_module(G)
M = np.array(json.loads((HERE / 'georef.json').read_text(encoding='utf-8'))['M'])
IMG = 'C:/campus-tracker-backend/데이터/보완자료/학교-전경-20261022/항공/사용자표시-한림관북쪽-화단.webp'
BX = (201098, 201172, 557296, 557342); res = 0.05
W, H = int((BX[1] - BX[0]) / res), int((BX[3] - BX[2]) / res)
im = np.asarray(Image.open(IMG).convert('RGB')); Ai = np.linalg.inv(np.vstack([M.T, [0, 0, 1]]))
gx, gy = np.meshgrid(BX[0] + np.arange(W) * res, BX[3] - np.arange(H) * res); v = Ai @ np.vstack([gx.ravel(), gy.ravel(), np.ones(gx.size)])
bg = ImageEnhance.Brightness(Image.fromarray(im[np.clip(v[1].round().astype(int), 0, im.shape[0] - 1), np.clip(v[0].round().astype(int), 0, im.shape[1] - 1)].reshape(H, W, 3))).enhance(1.1)
F = {f['properties']['id']: shape(f['geometry']).buffer(0) for fn in glob.glob(str(STR / '*.geojson')) for f in json.load(open(fn, encoding='utf-8'))['features'] if f.get('geometry')}
U = lambda pre: unary_union([g for i, g in F.items() if i.startswith(pre)])
ST = lambda s, t: tuple(float(c) for c in G.st_to_xy(s, t))
fig, ax = plt.subplots(figsize=(16, 10.5)); ax.imshow(bg, extent=[BX[0], BX[1], BX[2], BX[3]], alpha=0.75)
items = [  # (모양, 색, 이름과 높이)
    (U('X36-UPHILL-TOP-LANE').union(F['G02-PLATFORM-WAY'].intersection(Polygon([ST(55, -5), ST(76, -5), ST(76, 4.6), ST(55, 4.6)]))), '#9e9e9e', '지상 오르막(차로·인도)\n140.7 → 148.9 (동쪽으로 오름)'),
    (U('X40-FULL-STAIR-S'), '#ff7f0e', '가 통 계단(폭 9.4 m)\n길 → 144.2, 20단'),
    (F['G02-PLATFORM-FORK'], '#1f77b4', '나 차양 앞 마당 144.2'),
    (U('Z05-MUNYE-3F-STEPS'), '#17becf', '다 3층 로비 4칸 → 144.8'),
    (U('X40-FORK-TOP-STAIR-S'), '#d62728', '라 난간 계단 8단\n144.2 → 145.5'),
    (F['G02-PLATFORM-TOP'], '#9467bd', '마 카페 앞 평탄부 145.5'),
    (U('X40-TILE-STEP'), '#e377c2', '바 3단 145.5 → 145.95'),
    (F['X40-PLATFORM-TILE'], '#bcbd22', '사 타일 면 145.95(평평)'),
    (U('X40-SIDE-STAIR-LOW').union(U('Z02-SIDE-STAIR-S')), '#8c564b', '아 대일관 옆 계단 34단\n145.95 → 151.3'),
    (F['Z02-PLATFORM-ENTRANCE'], '#2ca02c', '자 현관 참 151.3'),
    (U('X40-PORCH-E-PIER').union(F['Z02-PORCH-SIDE-E']).buffer(0.4), '#ff00ff', '자 동쪽 옆 아치(트임)'),
    (U('Z02-DECK-WEST-END').union(U('Z02-DECK-MAIN')), '#7f7f7f', '데크 151.25'),
    (F['X40-WEDGE-PLANTER'], '#00a000', '쐐기 화단(항목 1)'),
]
for g, c, name in items:
    for q in (g.geoms if g.geom_type == 'MultiPolygon' else [g]):
        if q.is_empty: continue
        ax.fill(*q.exterior.xy, color=c, alpha=0.35, lw=0); ax.plot(*q.exterior.xy, color=c, lw=1.2)
    p = g.representative_point(); ax.text(p.x, p.y, name, fontsize=8, ha='center', va='center', bbox=dict(fc='white', alpha=0.8, lw=0.5, ec=c, pad=1.5))
route = [ST(72, 2.0), ST(72, 4.6), ST(72, 11.3), ST(73.5, 14.5), ST(76.4, 14.5), ST(80.8, 11.2), ST(81.8, 11.2), ST(90, 11.6), ST(97.1, 13.0), (201144.05, 557315.53), (201150.14, 557312.8), (201156.34, 557308.77), (201161.69, 557310.2), (201164.61, 557309.39)]
ax.plot(*zip(*route), color='red', lw=2.2, ls='--'); ax.annotate('', xy=route[-1], xytext=route[-2], arrowprops=dict(arrowstyle='->', color='red', lw=2))
ax.text(*ST(66, 1.0), '시험용 DB 길(빨간 점선): 오르막 → 통 계단 → 마당 → 난간 계단 → 평탄부 → 3단 → 타일 면 → 옆 계단 → 현관 참 → 동쪽 아치 → 데크', fontsize=8, color='red', bbox=dict(fc='white', alpha=0.85, lw=0))
ax.set_xlim(BX[0], BX[1]); ax.set_ylim(BX[2], BX[3]); ax.set_aspect('equal'); ax.grid(color='w', lw=0.3, alpha=0.5); ax.tick_params(labelsize=7)
ax.set_title('F5 문예관 저층부 동쪽 끝 ~ 대일관 서쪽 현관: Claude 유추 길 구조(사진 skuniv-6ab01da5 + 항공사진 + 사용자 표시). 북 ↑, 높이 m, 가~자 = 구역 노트 X40 표', fontsize=11)
fig.tight_layout(); fig.savefig(sys.argv[1], dpi=100); print(sys.argv[1])
