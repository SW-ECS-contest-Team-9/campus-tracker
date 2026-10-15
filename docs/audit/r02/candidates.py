"""R02: 오르막길 윗구간 꺾임·좁아짐 후보 셋(같은 축척, 북쪽이 위). 바탕 = S-MAP 메시 - 길 경사면. python -X utf8 candidates.py"""
import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'g02'))
from common import *
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'
OUT = AUDIT / 'r02'; m = Mesh()
X = np.arange(201085, 201160, 0.5); Y = np.arange(557290, 557345, 0.5); gx, gy = np.meshgrid(X, Y)
s_, t_ = xy_to_st(gx, gy); dz = m.at(gx, gy) - way_z(s_)
RS = np.array([50, 63.4, 67, 70, 72, 74, 80, 88, 94, 100, 105])
def cand(wf_t, np_t, sw):
    wf = np.interp(RS, [50, 63.4, 72, 88, 100, 105], wf_t); npl = np.interp(RS, [50, 70, 74, 105], np_t)
    return wf, wf + np.interp(RS, [63.4, 72], sw), npl - 2.0, npl
C = {'가(만든 것): 남 옹벽 -3.8→-0.4→0.8, 북 4.6→7.0': cand([-3.8, -3.8, -0.4, 0.4, 0.8, 0.4], [4.6, 4.6, 7.0, 7.0], [2.2, 1.2]),
     '나: 메시 가장자리 그대로(남 0.0→2.0), 길 선 옮김 필요': cand([-3.8, -3.8, 0.0, 1.0, 2.0, 0.0], [4.6, 4.6, 7.5, 7.5], [2.2, 1.2]),
     '다: 남쪽만 꺾임, 북쪽 그대로(4.6)': cand([-3.8, -3.8, -0.4, 0.4, 0.8, 0.4], [4.6, 4.6, 4.6, 4.6], [2.2, 1.2])}
for k, (nm, (a, b, c, d)) in enumerate(C.items()):
    fig, ax = plt.subplots(figsize=(10, 7.5))
    ax.pcolormesh(X, Y, dz, cmap='RdBu_r', vmin=-3, vmax=3, shading='auto')
    for tt, col, lab in ((a, 'k', '남 옹벽 면'), (b, 'orange', '본관 쪽 인도 | 차로'), (c, 'orange', '차로 | 북쪽 인도'), (d, 'g', '북쪽 화단 벽')):
        p = st_to_xy(RS, tt); ax.plot(p[:, 0], p[:, 1], color=col, lw=2, label=lab)
    for sm in range(60, 110, 10):
        p = st_to_xy(sm, -6); ax.text(p[0], p[1], f's{sm}', fontsize=8)
    ax.set_aspect('equal'); ax.set_xlim(X[0], X[-1]); ax.set_ylim(Y[0], Y[-1]); ax.grid(alpha=.3); ax.legend(loc='upper right', fontsize=8)
    ax.set_title('R02 후보 ' + nm + '\n바탕: 메시 - 길 경사면(붉음 높음, 푸름 낮음, ±3 m)', fontsize=10)
    plt.savefig(OUT / f'후보-{"가나다"[k]}.png', dpi=90, bbox_inches='tight'); plt.close()
print('ok')
