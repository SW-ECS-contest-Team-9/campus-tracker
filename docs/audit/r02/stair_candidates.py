"""R02: 본관 남쪽 앞 계단 후보 셋(같은 축척, 북쪽이 위). 바탕 = main_front.py 그림(메시·모델 상자·거리뷰 지점). 더할 계단은 거리뷰 05·06·07 전방위와 S-MAP 정사(claude-m16/S07)를 눈대중으로 옮긴 것(전부 추정 ±3 m)."""
import numpy as np, matplotlib.pyplot as plt
from main_front import base, OUT
def strip(ax, p, q, w, col, lab):
    p, q = np.array(p), np.array(q); v = q - p; n = np.array([-v[1], v[0]]) / np.hypot(*v) * w / 2
    c = np.array([p + n, q + n, q - n, p - n, p + n]); ax.fill(c[:, 0], c[:, 1], fc=col, ec='k', alpha=0.7, label=lab)
C = {
 '가: 지금 모델 그대로(돌계단 한 곳, 폭 4.6 m)': [],
 '나: 섬 서쪽 끝 넓은 계단(거리뷰 05·정사의 줄무늬 칸) + 굽잇길 어귀 섬 계단(거리뷰 07)': [((201043.5, 557293.0), (201047.5, 557297.0), 6.0, 'orange', '섬 서쪽 끝 넓은 계단(추정)'), ((201084.0, 557270.5), (201088.5, 557275.0), 2.2, 'm', '굽잇길 섬 계단(추정)')],
 '다: 길가 전체를 긴 디딤 단(거리뷰 05 앞쪽)으로 + 갈림 끝 계단을 7 m 로 넓힘': [((201040.5, 557296.5), (201074.0, 557276.5), 1.6, 'orange', '길가 긴 디딤 단(추정)'), ((201061.0, 557287.0), (201067.0, 557291.5), 7.0, 'm', '넓힌 갈림 끝 계단(추정)')],
}
for k, (nm, add) in enumerate(C.items()):
    fig, ax = plt.subplots(figsize=(10, 8)); base(ax, 'R02 본관 남쪽 앞 계단 후보 ' + nm)
    for p, q, w, col, lab in add: strip(ax, p, q, w, col, lab)
    if add: ax.legend(loc='upper right', fontsize=8)
    plt.savefig(OUT / f'후보-본관남쪽계단-{"가나다"[k]}.png', dpi=90, bbox_inches='tight'); plt.close()
print('ok')
