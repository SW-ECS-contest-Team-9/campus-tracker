"""R01: 지형 격자 둘(전·후, float32 450x464, 2 m)을 견줘 바뀐 칸을 적는다(읽기만).   python check_cells.py 전.f32 후.f32 [목록.csv]
바뀐 칸은 모두 두 작업 구역 상자 안이어야 하고, 건물 칸(시험용 장면의 건물 외곽·캠퍼스 지도 건물)과 끝난 구역(G02·Z02·Z03 기단, 운동장, 회차 공간 포장면)의 칸은 하나도 없어야 한다. 아니면 종료값 1."""
import sys, json, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'z05'))
from base import *
W, H, X0, Y0, R = 450, 464, 200668, 556798, 2
AREAS = {'A 바위 정원·가운데 옹벽(Z03 차도 포장 띠의 동쪽 변 ~ 윗벽)': (201098, 557204, 201108, 557256), 'B 수인관 남동 유리 덩어리': (201150, 557072, 201196, 557124)}
a, b = (np.fromfile(f, dtype='<f4').reshape(H, W) for f in sys.argv[1:3])
jj, ii = np.nonzero(a != b); cx, cy = X0 + (ii + 0.5) * R, Y0 + (jj + 0.5) * R
PLAZA_ALL = PLAT['plaza'].buffer(0)
zones = {'건물(장면 외곽)': DRAWN, '건물(캠퍼스 지도)': BLD_ALL, '끝난 구역 기단(G02·Z02·Z03)': DONE, '운동장': FIELD, '회차 공간 포장면': PLAZA_ALL}
bad = 0; rows = []; cnt = {k: 0 for k in AREAS}; box = {k: [1e9, 1e9, -1e9, -1e9] for k in AREAS}
for x, y, i, j in zip(cx, cy, ii, jj):
    ar = next((k for k, (x0, y0, x1, y1) in AREAS.items() if x0 <= x <= x1 and y0 <= y <= y1), None)
    zs = [k for k, g in zones.items() if contains_xy(g, x, y)]
    if ar is None or zs: bad += 1; print('구역 밖 또는 지켜야 할 칸', x, y, a[j, i], b[j, i], ar, zs)
    if ar: cnt[ar] += 1; q = box[ar]; box[ar] = [min(q[0], x - 1), min(q[1], y - 1), max(q[2], x + 1), max(q[3], y + 1)]
    rows.append((ar or '밖', x, y, float(a[j, i]), float(b[j, i])))
print('바뀐 칸', len(rows), '어긋난 칸', bad)
for k in AREAS:
    d = np.array([r[4] - r[3] for r in rows if r[0] == k]); print(f'  {k}: {cnt[k]}칸, 칸 둘레 상자(동·북 최소 ~ 최대) {box[k]}, 허용 상자 {AREAS[k]}, 높이 차 {d.min():+.1f} ~ {d.max():+.1f} m' if len(d) else f'  {k}: 0칸')
if len(sys.argv) > 3:
    with open(sys.argv[3], 'w', encoding='utf-8', newline='\n') as f:
        f.write('area,x,y,before_m,after_m\n'); [f.write(f'{r[0]},{r[1]:.0f},{r[2]:.0f},{r[3]:.2f},{r[4]:.2f}\n') for r in rows]
sys.exit(1 if bad else 0)
