"""Z03: 유담관 '탑 남동 띠' 외곽을 S-MAP 0.5 m 메시의 건물 모델 칸에 맞춰 다시 자른다(B03 은 2 m 칸의 볼록 껍질이라 남동 끝이 최대 5~6 m 넘쳤다).
  python -I tower_se.py   -> docs/audit/z03/tower-se.json (동 노트 유담관.md 의 부분 '탑 남동 띠' 외곽 좌표로 옮겨 적는다)
둥근 기단부 = 원천 외곽의 둥근 남동 끝에서 이 탑 칸을 뺀 초승달. S-MAP 은 기단부를 건물 모델로도 땅으로도 싣지 않았다(그 자리를 114~119 m 땅으로 읽음)."""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
import yaml
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union
M = Mesh(); st = M.step
head = yaml.safe_load((VAULT / '모델링 개선' / '건물' / '유담관.md').read_text(encoding='utf-8').split('\n---', 1)[0][3:])
old = Polygon(next(p for p in head['부분'] if p.get('모델_부분', {}).get('id') == '탑남동')['외곽']['좌표'][0])
mid = Polygon(next(p for p in head['부분'] if p.get('모델_부분', {}).get('id') == '탑가운데')['외곽']['좌표'][0])
b = next(b for b in buildings() if b['name'] == '유담관')['coordinates']
while isinstance(b[0][0], list): b = b[0]
foot = Polygon(b).buffer(0)
bm = ~M.g; jj, ii = np.nonzero(bm)
cells = unary_union([sbox(M.x0 + i * st - st / 2, M.y0 + j * st - st / 2, M.x0 + i * st + st / 2, M.y0 + j * st + st / 2) for j, i in zip(jj, ii) if 201040 <= M.x0 + i * st <= 201082 and 557230 <= M.y0 + j * st <= 557269.5])
model = max(cells.geoms, key=lambda g: g.area) if cells.geom_type != 'Polygon' else cells
model = Polygon(model.exterior).buffer(0.75).buffer(-0.75).simplify(0.5)   # 칸 톱니를 편 외곽
new = old.intersection(model).intersection(foot).difference(mid).buffer(0)
new = max(new.geoms, key=lambda g: g.area) if new.geom_type != 'Polygon' else new
new = new.simplify(0.4)
drum = foot.intersection(sbox(201045, 557221, 201080, 557262)).difference(model).difference(old.difference(new).buffer(-0.01).buffer(0.01) if False else Polygon()).buffer(0)
zs = M.z[bm & (np.abs(M.z - 169) < 12)]
res = {'old_area': round(old.area, 1), 'new_area': round(new.area, 1), 'removed_area': round(old.difference(new).area, 1), 'new_ring': [[round(x, 2), round(y, 2)] for x, y in new.exterior.coords],
       'removed_ground_z': [round(float(v), 1) for v in np.percentile(M.at(*np.array([(p.x, p.y) for p in [old.difference(new).representative_point()]]).T), [50])],
       'inside_footprint': bool(foot.buffer(0.02).contains(new)), 'overlap_mid': round(new.intersection(mid).area, 3)}
(HERE / 'tower-se.json').write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8', newline='\n'); print(json.dumps(res, ensure_ascii=False))
# 넘친 자리(옛 외곽 − 새 외곽)의 S-MAP 높이
rem = old.difference(new); xs, ys = np.meshgrid(np.arange(201044, 201080, .5), np.arange(557232, 557262, .5))
from shapely import contains_xy
m = contains_xy(rem, xs, ys); z = M.at(xs[m], ys[m]); g = np.isfinite(M.at(xs[m], ys[m], ground=True))
print('removed cells', int(m.sum()), 'ground', int(g.sum()), 'z ground p10/50/90', np.round(np.percentile(z[g], [10, 50, 90]), 1) if g.any() else None)
