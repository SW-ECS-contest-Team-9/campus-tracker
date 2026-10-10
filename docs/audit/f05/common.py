"""F05 공용: EPSG:5186 <-> 경위도(GRS80 가로 메르카토르), S-MAP 메시 합치기."""
import json, math, pathlib, sys
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'e05'))
from grids import Grid

A, F = 6378137.0, 1 / 298.257222101
LAT0, LON0, K0, FE, FN = math.radians(38), math.radians(127), 1.0, 200000.0, 600000.0
E2 = F * (2 - F); EP2 = E2 / (1 - E2)

def _m(lat):
    e4, e6 = E2 * E2, E2 ** 3
    return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * lat - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * lat)
                + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * lat) - (35 * e6 / 3072) * math.sin(6 * lat))

def to_tm(lon, lat):
    lat, lon = math.radians(lat), math.radians(lon)
    n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2); t = math.tan(lat) ** 2; c = EP2 * math.cos(lat) ** 2; a = (lon - LON0) * math.cos(lat)
    x = FE + K0 * n * (a + (1 - t + c) * a ** 3 / 6 + (5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5 / 120)
    y = FN + K0 * (_m(lat) - _m(LAT0) + n * math.tan(lat) * (a * a / 2 + (5 - t + 9 * c + 4 * c * c) * a ** 4 / 24 + (61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6 / 720))
    return x, y

def to_lonlat(x, y):
    m = _m(LAT0) + (y - FN) / K0; mu = m / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256)); e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    p = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu) + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu)
    c = EP2 * math.cos(p) ** 2; t = math.tan(p) ** 2; n = A / math.sqrt(1 - E2 * math.sin(p) ** 2); r = A * (1 - E2) / (1 - E2 * math.sin(p) ** 2) ** 1.5; d = (x - FE) / (n * K0)
    lat = p - (n * math.tan(p) / r) * (d * d / 2 - (5 + 3 * t + 10 * c - 4 * c * c - 9 * EP2) * d ** 4 / 24 + (61 + 90 * t + 298 * c + 45 * t * t - 252 * EP2 - 3 * c * c) * d ** 6 / 720)
    lon = LON0 + (d - (1 + 2 * t + c) * d ** 3 / 6 + (5 - 2 * c + 28 * t - 3 * c * c + 8 * EP2 + 24 * t * t) * d ** 5 / 120) / math.cos(p)
    return math.degrees(lon), math.degrees(lat)

T = 419430528  # S-MAP 지형 모델 id (건물 모델이 아닌 면)

def smap(audit):
    """운동장 둘레 1 m 격자: 1 m 메시(은주 a·b·c, 상승관)를 먼저, 없는 칸은 2 m 메시(남·북동)의 가장 가까운 칸. (z, 모델 id, 출처 1|2)"""
    audit = pathlib.Path(audit); x0, y0, nx, ny = 201100, 557150, 170, 180
    z = np.full((ny, nx), np.nan); mid = np.zeros((ny, nx), dtype=np.int64); src = np.zeros((ny, nx), dtype=int)
    for name in ['e05/smap-mesh-south-2m.txt', 'e05/smap-mesh-ne-2m.txt']:
        g = Grid(audit / name)
        for j in range(ny):
            for i in range(nx):
                gi, gj = round((x0 + i - g.x0) / 2), round((y0 + j - g.y0) / 2)
                if 0 <= gi < g.nx and 0 <= gj < g.ny and not np.isnan(g.z[gj, gi]): z[j, i], mid[j, i], src[j, i] = g.z[gj, gi], g.id[gj, gi], 2
    for name in ['e05/smap-mesh-eunju-1m-a.txt', 'e05/smap-mesh-eunju-1m-b.txt', 'e05/smap-mesh-eunju-1m-c.txt', 'b09/smap-mesh-b09-sangseung-1m.txt']:
        g = Grid(audit / name)
        for gj in range(g.ny):
            for gi in range(g.nx):
                i, j = g.x0 + gi - x0, g.y0 + gj - y0
                if 0 <= i < nx and 0 <= j < ny and not np.isnan(g.z[gj, gi]): z[j, i], mid[j, i], src[j, i] = g.z[gj, gi], g.id[gj, gi], 1
    return x0, y0, z, mid, src
