"""Z05: S-MAP 1 m 메시 단면을 숫자로 찍는다.  python sec.py x0 y0 x1 y1 [step]   (건물 모델 칸은 b 표시)"""
import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'z04'))
from common import *
M = Mesh()
def sec(x0, y0, x1, y1, step=1.0):
    L = np.hypot(x1 - x0, y1 - y0); n = int(L / step) + 1; out = []
    for k in range(n):
        x, y = x0 + (x1 - x0) * k * step / L, y0 + (y1 - y0) * k * step / L; ix, iy = int(round(x - MX0)), int(round(y - MY0))
        if not (0 <= ix < MNX and 0 <= iy < MNY) or not np.isfinite(M.z[iy, ix]): out.append('  --'); continue
        out.append(f"{M.z[iy, ix]:.0f}b" if not M.g[iy, ix] else f"{M.z[iy, ix]:.1f}")
    return ' '.join(out)
if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == 'rows':   # rows xa xb y...
        for y in a[3:]: print(y, sec(float(a[1]), float(y), float(a[2]), float(y)))
    elif a[0] == 'cols':
        for x in a[3:]: print(x, sec(float(x), float(a[1]), float(x), float(a[2])))
    else: print(sec(*map(float, a)))
