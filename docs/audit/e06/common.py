# E06 공통: 격자 읽기, 좌표 변환(위경도 -> EPSG:5186), 구역 마스크
import json, io, math
import numpy as np

class Grids:
    def __init__(self, audit):
        self.meta = m = json.load(io.open(audit + '/terrain-grid-meta.json'))
        self.res = m['resolution']
        shape = (m['height'], m['width'])
        self.old = np.fromfile(audit + '/terrain-grid.f32', dtype='<f4').reshape(shape)
        self.new = np.fromfile(audit + '/t01/dem-T01.f32', dtype='<f4').reshape(shape)
        self.diff = self.new - self.old
        gy, gx = np.gradient(self.old.astype('f8'), self.res)
        self.slope_old = np.hypot(gx, gy)

    def frac(self, x, y):
        m = self.meta
        return (x - m['originX']) / self.res - .5, (y - m['originY']) / self.res - .5

    def samp(self, g, x, y):  # 칸 중심 기준 쌍선형, 0행 = 남쪽
        fx, fy = self.frac(x, y)
        i, j = int(math.floor(fx)), int(math.floor(fy)); tx, ty = fx - i, fy - j
        if i < 0 or j < 0 or i + 1 >= g.shape[1] or j + 1 >= g.shape[0]: return None
        return float(g[j, i] * (1 - tx) * (1 - ty) + g[j, i + 1] * tx * (1 - ty) + g[j + 1, i] * (1 - tx) * ty + g[j + 1, i + 1] * tx * ty)

    def window(self, g, x, y, r, fn):  # 반경 r(m) 정사각 창에서 fn
        fx, fy = self.frac(x, y); k = int(math.ceil(r / self.res))
        i, j = int(round(fx)), int(round(fy))
        if i - k < 0 or j - k < 0 or i + k >= g.shape[1] or j + k >= g.shape[0]: return None
        return float(fn(g[j - k:j + k + 1, i - k:i + k + 1]))

# TM 정변환, GRS80, 위도원점 38, 경도원점 127, 축척 1, 가산 200000/600000 (EPSG:5186)
_a = 6378137.0; _f = 1 / 298.257222101; _e2 = _f * (2 - _f); _ep2 = _e2 / (1 - _e2)
def _M(p):
    return _a * ((1 - _e2 / 4 - 3 * _e2**2 / 64 - 5 * _e2**3 / 256) * p - (3 * _e2 / 8 + 3 * _e2**2 / 32 + 45 * _e2**3 / 1024) * math.sin(2 * p)
                 + (15 * _e2**2 / 256 + 45 * _e2**3 / 1024) * math.sin(4 * p) - (35 * _e2**3 / 3072) * math.sin(6 * p))
def tm(lat, lon):
    p = math.radians(lat); l = math.radians(lon - 127); N = _a / math.sqrt(1 - _e2 * math.sin(p)**2); T = math.tan(p)**2; C = _ep2 * math.cos(p)**2; A = l * math.cos(p)
    x = 200000 + N * (A + (1 - T + C) * A**3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * _ep2) * A**5 / 120)
    y = 600000 + _M(p) - _M(math.radians(38)) + N * math.tan(p) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A**4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * _ep2) * A**6 / 720)
    return x, y
