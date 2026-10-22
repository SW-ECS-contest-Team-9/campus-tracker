"""사용자 그림(2026-10-22, 사람 다니는 곳 표시)을 EPSG:5186 으로 옮겨 GeoJSON 으로 쓴다. 읽기 전용(DB·서버를 고치지 않는다).

  python georef.py IMAGE SCENE.json ROADS.json TERRAIN.json OUT.geojson [OVERLAY.png]

IMAGE   : 볼트 `데이터/보완자료/학교-전경-20261022/사람-다니는-곳-표시.webp` (편집기 3D 화면을 위에서 본 갈무리 + 빨간 펜)
SCENE   : 시험 서버 GET /api/v1/scene (건물 외곽·지붕 높이)
ROADS   : 시험 서버 GET /api/v1/mobility/roads (주 진입로 중심선으로 카메라를 다듬는다)
TERRAIN : {"originX","originY","resolutionM","width","height","heights": f32 파일 경로} (시험 DB 활성 지형, 행 0 = 남쪽)

방법
1. 카메라: 원근 투영(DLT, 11 변수). 기준점은 gcp.json 의 건물 지붕 모서리(x, y, 지붕 높이) 7개.
   주 진입로 세 조각(1b708df6, f3eaad1d, 499ab1ab)의 중심선이 그림의 검은 포장 가운데 선에 오도록 함께 맞춘다.
2. 빨간 펜 화소를 덩어리로 나누고, 덩어리마다 뼈대 선을 뽑아 땅 높이(지형)에서 평면 좌표로 되돌린다.
3. 외곽: 북쪽 선(건물 뒤) + 서·남쪽 선(공도 쪽)을 잇고, 동쪽은 그림에 선이 없어 운동장 빗금 묶음과 정문 쪽 선 끝들의
   볼록 껍질로 닫는다(추정. 그 안에 든 것은 은주2관·수인관 건물뿐이라 길 판정에는 영향 없음).
4. 빗금 묶음 넷: 운동장 위 주차면, 본관–문예관 사이 차도, 회차 공간·서쪽 옆길, 분수 쪽 차도. 묶음마다 획의 오목 껍질.
"""

import json
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.optimize import least_squares
from shapely import concave_hull
from shapely.geometry import LineString, MultiPoint, Point, Polygon, mapping
from shapely.ops import unary_union
from skimage.morphology import medial_axis, skeletonize

HERE = __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0] if ("/" in __file__ or "\\" in __file__) else "."
O = np.array([201100.0, 557250.0, 130.0])  # 계산용 원점
MAIN_ROADS = ("1b708df6", "f3eaad1d", "499ab1ab")

# 이미지 좌표(화소). 빨간 펜 덩어리를 고르는 씨앗과 빗금 묶음의 범위.
SEEDS = {"north": (700, 283), "southwest": (600, 880), "street_n": (1200, 830), "street_s": (1300, 960)}
ZONES = {
    "운동장 위 주차면": {"kind": "comps", "poly": [(1080, 280), (1340, 200), (1560, 250), (1660, 620), (1500, 650), (1200, 570)]},
    "본관–문예관 사이 차도": {"kind": "comps", "poly": [(600, 480), (800, 400), (1130, 300), (1150, 420), (1000, 455), (640, 575)]},
    "회차 공간·서쪽 옆길": {"kind": "comps", "poly": [(380, 575), (600, 545), (625, 640), (700, 785), (560, 795), (380, 680)]},
    "분수 쪽 차도": {"kind": "pixels", "poly": [(1020, 850), (1240, 850), (1240, 1000), (990, 990)]},
}


def load_terrain(meta_path):
    m = json.load(open(meta_path, encoding="utf8"))
    h = np.fromfile(m["heights"], "<f4").reshape(m["height"], m["width"])
    ox, oy, r = m["originX"], m["originY"], m["resolutionM"]

    def z(x, y):
        ix = np.clip((x - ox) / r - 0.5, 0, h.shape[1] - 1.001)
        iy = np.clip((y - oy) / r - 0.5, 0, h.shape[0] - 1.001)
        x0, y0 = np.floor(ix).astype(int), np.floor(iy).astype(int)
        fx, fy = ix - x0, iy - y0
        return (
            h[y0, x0] * (1 - fx) * (1 - fy)
            + h[y0, x0 + 1] * fx * (1 - fy)
            + h[y0 + 1, x0] * (1 - fx) * fy
            + h[y0 + 1, x0 + 1] * fx * fy
        )

    return z


def project(P, X):
    X = np.c_[np.asarray(X, float) - O, np.ones(len(X))]
    h = X @ P.T
    return h[:, :2] / h[:, 2:3]


def unproject(P, uv, zfun, iters=8):
    uv = np.asarray(uv, float)
    zz = np.full(len(uv), O[2])
    for _ in range(iters):
        a = P[0] - uv[:, :1] * P[2]
        b = P[1] - uv[:, 1:2] * P[2]
        A = np.stack([a[:, :2], b[:, :2]], axis=1)
        rhs = -np.c_[a[:, 2] * (zz - O[2]) + a[:, 3], b[:, 2] * (zz - O[2]) + b[:, 3]]
        xy = np.linalg.solve(A, rhs[..., None])[..., 0] + O[:2]
        zz = zfun(xy[:, 0], xy[:, 1])
    return np.c_[xy, zz]


def fit_camera(im, gcps, roads):
    gi = np.array([g["img"] for g in gcps], float)
    gw = np.array([g["xyz"] for g in gcps], float)
    # 1단계: 평행 투영(아핀 8 변수) 최소제곱 → 2단계 초깃값
    A = np.c_[gw - O, np.ones(len(gw))]
    M = np.linalg.lstsq(A, gi, rcond=None)[0].T
    p0 = np.r_[M[0], M[1], 0, 0, 0]
    dark = ndimage.binary_opening(im.max(axis=2) < 50, iterations=2)
    dist_axis = ndimage.distance_transform_edt(~medial_axis(dark))
    samp = []
    for r in roads:
        if r["id"][:8] not in MAIN_ROADS:
            continue
        c = np.array(r["geometry"]["coordinates"], float)
        for a, b in zip(c, c[1:]):
            n = max(1, int(np.linalg.norm(b[:2] - a[:2]) / 2))
            samp += [a + t * (b - a) for t in np.linspace(0, 1, n, endpoint=False)]
    samp = np.array(samp)

    def resid(p):
        P = np.r_[p, 1.0].reshape(3, 4)
        q = project(P, samp)
        xi = np.clip(q[:, 0], 0, im.shape[1] - 1).astype(int)
        yi = np.clip(q[:, 1], 0, im.shape[0] - 1).astype(int)
        return np.r_[(project(P, gw) - gi).ravel(), 0.5 * np.minimum(dist_axis[yi, xi], 25.0)]

    p = least_squares(resid, p0, x_scale="jac", diff_step=1e-4).x
    P = np.r_[p, 1.0].reshape(3, 4)
    q = project(P, samp)
    road_px = dist_axis[q[:, 1].astype(int), q[:, 0].astype(int)]
    gres = np.linalg.norm(project(P, gw) - gi, axis=1)
    return P, gres, road_px


def ordered_path(mask):
    """덩어리 뼈대에서 가장 긴 길(화소 순서)."""
    sk = skeletonize(mask)
    ys, xs = np.nonzero(sk)
    idx = {(y, x): i for i, (y, x) in enumerate(zip(ys, xs))}
    nb = [[] for _ in idx]
    for (y, x), i in idx.items():
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                j = idx.get((y + dy, x + dx))
                if j is not None and j != i:
                    nb[i].append(j)

    def bfs(s):
        prev = {s: -1}
        q = [s]
        for u in q:
            for v in nb[u]:
                if v not in prev:
                    prev[v] = u
                    q.append(v)
        return q[-1], prev

    a, _ = bfs(0)
    b, prev = bfs(a)
    path = []
    while b != -1:
        path.append(b)
        b = prev[b]
    return np.c_[xs[path], ys[path]]


def main(img_path, scene_path, roads_path, terrain_path, out_path, overlay=None):
    im = np.asarray(Image.open(img_path).convert("RGB")).astype(int)
    gcps = json.load(open(f"{HERE}/gcp.json", encoding="utf8"))
    roads = json.load(open(roads_path, encoding="utf8"))["roads"]
    zfun = load_terrain(terrain_path)
    P, gres, road_px = fit_camera(im, gcps, roads)
    # 축척: 원점 부근 1 m 가 몇 화소인지
    s = np.linalg.norm(project(P, [O + [1, 0, 0]]) - project(P, [O]))
    report = {
        "scalePxPerM": round(float(s), 2),
        "gcpResidualPx": {g["name"]: round(float(e), 1) for g, e in zip(gcps, gres)},
        "gcpRmsM": round(float(np.sqrt((gres**2).mean()) / s), 2),
        "roadCenterlineToAsphaltAxisM": {
            "median": round(float(np.median(road_px) / s), 2),
            "p90": round(float(np.percentile(road_px, 90) / s), 2),
        },
    }

    red = (im[:, :, 0] > 180) & (im[:, :, 1] < 90) & (im[:, :, 2] < 90)
    red = ndimage.binary_closing(red, iterations=2)
    lab, n = ndimage.label(red)

    def comp_at(seed):
        ys, xs = np.nonzero(lab)
        k = np.argmin((xs - seed[0]) ** 2 + (ys - seed[1]) ** 2)
        return lab[ys[k], xs[k]]

    def to_plan(uv):
        return unproject(P, uv, zfun)

    lines = {}
    for name, seed in SEEDS.items():
        c = comp_at(seed)
        path = ordered_path(lab == c)
        xyz = to_plan(path[::3])
        lines[name] = (c, LineString(xyz[:, :2]).simplify(0.5))
    north, sw = lines["north"][1], lines["southwest"][1]
    # 북쪽 선은 서→동, 서남쪽 선은 북→남→동 으로 맞춘다
    if north.coords[0][0] > north.coords[-1][0]:
        north = LineString(north.coords[::-1])
    if sw.coords[0][1] < sw.coords[-1][1]:
        sw = LineString(sw.coords[::-1])

    zones = {}
    boundary_comps = {c for c, _ in lines.values()}
    for name, z in ZONES.items():
        poly = Polygon(z["poly"])
        uv = []
        if z["kind"] == "comps":
            for c in range(1, n + 1):
                if c in boundary_comps:
                    continue
                ys, xs = np.nonzero(lab == c)
                if len(xs) < 60 or not poly.contains(Point(xs.mean(), ys.mean())):
                    continue
                uv.append(np.c_[xs, ys][::4])
        else:
            ys, xs = np.nonzero(lab > 0)
            inside = np.array([poly.contains(Point(x, y)) for x, y in zip(xs[::4], ys[::4])])
            uv.append(np.c_[xs[::4], ys[::4]][inside])
        xyz = to_plan(np.vstack(uv))
        hull = concave_hull(MultiPoint(xyz[:, :2]), ratio=0.35).buffer(1.0).simplify(0.5)
        zones[name] = (hull, xyz)

    field = zones["운동장 위 주차면"][0]
    ring = Polygon(list(north.coords) + list(sw.coords)[::-1])
    if not ring.is_valid:
        ring = ring.buffer(0)
    # 동쪽 닫기(추정): 북쪽 선 동쪽 끝, 서남쪽 선 동쪽 끝, 주 진입로 양쪽 선의 정문 쪽 끝, 운동장 빗금 묶음의 볼록 껍질
    ends = [north.coords[-1], sw.coords[-1]]
    for key in ("street_n", "street_s"):
        ln = lines[key][1]
        ends.append(max(ln.coords[0], ln.coords[-1], key=lambda c: c[0]))
    east = MultiPoint(ends + list(field.exterior.coords)).convex_hull
    outer = unary_union([ring, east]).simplify(0.5)
    if outer.geom_type != "Polygon":
        outer = max(outer.geoms, key=lambda g: g.area)
    outer = Polygon(outer.exterior)

    feats = [
        {
            "type": "Feature",
            "properties": {
                "role": "walkable_boundary",
                "name": "사람이 다니는 곳 외곽",
                "areaM2": round(outer.area),
                "grade": "사용자 그림(2026-10-22) 옮김. 동쪽(운동장 동쪽~정문)은 그림에 선이 없어 운동장 빗금 묶음으로 닫음: 추정",
            },
            "geometry": mapping(outer),
        }
    ]
    for name, (hull, xyz) in zones.items():
        feats.append(
            {
                "type": "Feature",
                "properties": {
                    "role": "hatched_zone",
                    "name": name,
                    "areaM2": round(hull.area),
                    "groundZ": {
                        "min": round(float(xyz[:, 2].min()), 1),
                        "p50": round(float(np.median(xyz[:, 2])), 1),
                        "max": round(float(xyz[:, 2].max()), 1),
                    },
                    "grade": "사용자 빗금 획의 오목 껍질 + 1 m. 경계는 ±2 m 추정",
                },
                "geometry": mapping(hull),
            }
        )
    for name, (_, ln) in lines.items():
        feats.append(
            {
                "type": "Feature",
                "properties": {
                    "role": "drawn_line",
                    "name": {
                        "north": "북쪽 외곽 선",
                        "southwest": "서·남쪽 외곽 선",
                        "street_n": "주 진입로 북동쪽 선(은주관 쪽 고리 포함)",
                        "street_s": "주 진입로 남서쪽 선(분수 쪽)",
                    }[name],
                },
                "geometry": mapping(ln),
            }
        )
    out = {
        "type": "FeatureCollection",
        "name": "walkable-areas-20261022",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
        "georef": {**report, "camera": "DLT", "P": np.round(P, 9).tolist(), "origin": O.tolist()},
        "features": feats,
    }
    for f in out["features"]:
        f["geometry"] = json.loads(json.dumps(f["geometry"]), parse_float=lambda v: round(float(v), 2))
    open(out_path, "w", encoding="utf8").write(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps(report, ensure_ascii=False))
    for f in feats:
        print(f["properties"]["role"], f["properties"]["name"], f["properties"].get("areaM2"), f["properties"].get("groundZ"))

    if overlay:
        img = Image.open(img_path).convert("RGB")
        d = ImageDraw.Draw(img)
        scene = json.load(open(scene_path, encoding="utf8"))
        from pyproj import Transformer

        tr = Transformer.from_crs(4326, 5186, always_xy=True)
        for b in scene["buildings"]:
            g = b["geometry"]
            for poly in g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]:
                xs, ys = tr.transform([c[0] for c in poly[0]], [c[1] for c in poly[0]])
                q = project(P, np.c_[xs, ys, np.full(len(xs), b["roofM"])])
                d.line([tuple(p) for p in q], fill=(0, 0, 255), width=2)
        for f in feats:
            geom = f["geometry"]
            rings = [geom["coordinates"][0]] if geom["type"] == "Polygon" else [geom["coordinates"]]
            for r in rings:
                r = np.array(r)
                q = project(P, np.c_[r, zfun(r[:, 0], r[:, 1])])
                col = {"walkable_boundary": (0, 200, 255), "hatched_zone": (255, 230, 0), "drawn_line": (255, 0, 255)}
                d.line([tuple(p) for p in q], fill=col[f["properties"]["role"]], width=3)
        img.save(overlay)


if __name__ == "__main__":
    main(*sys.argv[1:])
