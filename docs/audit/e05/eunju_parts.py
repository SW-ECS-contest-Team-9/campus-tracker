"""E05 공용: 은주관 원천 외곽(campus.gpkg fid 3)을 S-MAP 건물 모델의 지붕 단에 맞춰 나눈 부분 도형.
경계는 원천 외곽의 변과 나란한 선(2관 남서 변 기준 t=축 방향, o=운동장 쪽 수직 거리; 1관 서쪽 변 기준 s)과 탑의 원이다.
경계 값은 1 m 격자에서 지붕 높이가 바뀌는 칸 사이로 잡았다(±0.5 m).
"""
import math
from shapely.geometry import Polygon, Point, box
from shapely.affinity import affine_transform

V6, V5 = (201129.1, 557204.7), (201181.4, 557158.9)      # 2관 남서 변(접합부 -> 동쪽)
V10, V15 = (201117.7, 557215.2), (201131.7, 557301.7)    # 1관 서쪽 변(남 -> 북)
TOWER_C, TOWER_R = (201131.7, 557220.2), 4.8             # 162.5 m 칸 72개의 중심과 등가 반지름
O_SPLIT = 7.0     # 2관: 낮은 단(146.8) | 높은 지붕
T0, T1 = -1.0, 74.5   # 2관 몸통의 축 방향 범위(접합부 | 몸통 | 동쪽 끝)
S0 = 14.5         # 1관: 서쪽 변을 따라 이 거리부터 북쪽이 1관 몸통


def _frame(a, b):
    L = math.hypot(b[0] - a[0], b[1] - a[1]); u = ((b[0] - a[0]) / L, (b[1] - a[1]) / L); n = (-u[1], u[0])
    to = lambda x, y: ((x - a[0]) * u[0] + (y - a[1]) * u[1], (x - a[0]) * n[0] + (y - a[1]) * n[1])
    # local (t, o) box -> world polygon
    back = lambda poly: affine_transform(poly, [u[0], n[0], u[1], n[1], a[0], a[1]])
    return to, back


to2, back2 = _frame(V6, V5)     # o > 0 = 북동(운동장 쪽)
to1, back1 = _frame(V10, V15)   # o > 0 = 서쪽
B = 500


def parts(outline: Polygon):
    tower = Point(TOWER_C).buffer(TOWER_R, 6).intersection(outline)   # 24각형
    b1 = back1(box(S0, -B, B, B))
    one = outline.intersection(b1).difference(tower)
    rest = outline.difference(b1)
    w = rest.intersection(back2(box(-B, -B, B, 0.0))).difference(tower)          # 남서 변 바깥으로 나온 두 날개
    big = sorted((q for q in getattr(w, 'geoms', [w]) if q.area > 1), key=lambda q: q.centroid.x)   # 변 위의 실 조각은 몸통에 둔다
    assert len(big) == 2
    wing_w, wing_e = big
    wings = wing_w.union(wing_e)
    body = rest.difference(wings).difference(tower)
    main = body.intersection(back2(box(T0, O_SPLIT, T1, B)))
    low = body.intersection(back2(box(T0, -B, T1, O_SPLIT)))
    east_hi = body.intersection(back2(box(T1, O_SPLIT, B, B)))
    east_lo = body.intersection(back2(box(T1, -B, B, O_SPLIT)))
    junction = body.intersection(back2(box(-B, -B, T0, B)))
    out = {'은주1관': one, '접합부': junction, '접합부 남서 날개': wing_w, '탑': tower, '은주2관': main, '은주2관 낮은 단': low,
           '동쪽 끝 높은 부분': east_hi, '동쪽 끝 낮은 부분': east_lo, '동쪽 끝 남쪽 날개': wing_e}
    assert all(v.geom_type == 'Polygon' for v in out.values()), {k: v.geom_type for k, v in out.items()}
    return out
