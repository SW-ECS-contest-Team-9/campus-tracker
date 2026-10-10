"""WGS84/GRS80 lon,lat -> EPSG:5186 (Korea 2000 Central Belt 2010): TM, lat0 38, lon0 127, k 1, FE 200000, FN 600000."""
import math
A, F = 6378137.0, 1 / 298.257222101
E2 = F * (2 - F); EP2 = E2 / (1 - E2)


def _m(phi):
    e2, e4, e6 = E2, E2 ** 2, E2 ** 3
    return A * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
                + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi) - 35 * e6 / 3072 * math.sin(6 * phi))


def to5186(lon, lat):
    phi, lam = math.radians(lat), math.radians(lon) - math.radians(127)
    n = A / math.sqrt(1 - E2 * math.sin(phi) ** 2); t = math.tan(phi) ** 2; c = EP2 * math.cos(phi) ** 2; a = lam * math.cos(phi)
    x = n * (a + (1 - t + c) * a ** 3 / 6 + (5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5 / 120)
    y = _m(phi) - _m(math.radians(38)) + n * math.tan(phi) * (a * a / 2 + (5 - t + 9 * c + 4 * c * c) * a ** 4 / 24 + (61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6 / 720)
    return 200000 + x, 600000 + y
