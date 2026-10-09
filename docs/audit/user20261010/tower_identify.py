# 사진 7 고층 유리 건물 식별: S-MAP 격자(모델 id·표면 z)와 campus.gpkg·building-outlines 대조 (읽기 전용).
# 사용법: tower_identify.py <smap-grid-2m.txt> <building-outlines-5186.json> <campus.gpkg> <scene-live.json> <smap-elevation-raw.json> <출력 폴더>
import json, sys, os, sqlite3, hashlib, statistics
from shapely.geometry import Polygon, Point
if len(sys.argv) != 7: sys.exit("사용법: tower_identify.py <smap-grid-2m.txt> <building-outlines-5186.json> <campus.gpkg> <scene-live.json> <smap-elevation-raw.json> <출력 폴더>")
GRID, OUTL, GPKG, SCENE, ELEV, OUT = sys.argv[1:]
X0, Y0, R, NX, NY = 201070, 557270, 2, 36, 56
Z, C = {}, {}
for ln in open(GRID, encoding="utf-8"):
    if ln.startswith("#") or not ln.strip(): continue
    j, sm, ids, vals = ln.strip().split(":"); vals = [int(v) for v in vals.split(",")]
    assert len(vals) == NX and len(ids) == NX and sum(vals) == int(sm), ("checksum", j)
    for i, (v, c) in enumerate(zip(vals, ids)): Z[(i, int(j))] = v / 10 if v > 0 else None; C[(i, int(j))] = c
NAMES = {"W": "174587905", "B": "174522369", "H": "173539329", "M": "173473793", "D": "173604865", "E": "172556289"}
outl = {b["name"]: Polygon(b["coordinates"][0][0]) for b in json.load(open(OUTL, encoding="utf-8"))}
sha = hashlib.sha256(open(GPKG, "rb").read()).hexdigest()
assert sha == "26c66faa36bd03c3f7106d68ac8a2f8e0a89a452f7899e5b0f20ab0673b45d13", sha
con = sqlite3.connect("file:" + GPKG + "?mode=ro", uri=True)
cols = [r[1] for r in con.execute("pragma table_info(buildings_3d)")]
gp = {r[cols.index("name")]: {k: r[cols.index(k)] for k in ("fid", "source_fid", "height_m", "height_source", "ground_floors", "base_m", "roof_m", "note")}
      for r in con.execute("select * from buildings_3d")}
scene = {b["name"]: {k: b.get(k) for k in ("id", "baseM", "roofM")} for b in json.load(open(SCENE, encoding="utf-8")).get("buildings", [])}
elev = [{"name": e["name"], "x": e["x"], "y": e["y"], **json.loads(e["raw"])["result"]} for e in json.load(open(ELEV, encoding="utf-8"))]
# 분류(M17과 같은 생각): 같은 모델 4방향 이웃과 |dz| 최대값 jump. 상부 지붕 = z >= p90-10 이고 jump<=3, 하부면 = z < p90-10 이고 jump<=3, 나머지 판독불가
def q(a, p): return a[min(len(a) - 1, int(len(a) * p))]
res = {}
for code, mid in NAMES.items():
    cells = [k for k, c in C.items() if c == code and Z[k] is not None]
    zs = sorted(Z[k] for k in cells); top = q(zs, .9) - 10
    cls = {}
    for (i, j) in cells:
        nb = [(i + a, j + b) for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1)) if C.get((i + a, j + b)) == code and Z.get((i + a, j + b)) is not None]
        jump = max((abs(Z[n] - Z[(i, j)]) for n in nb), default=None)
        c = "판독불가" if jump is None or jump > 3 else ("상부 지붕" if Z[(i, j)] >= top else "하부면")
        cls.setdefault(c, []).append(Z[(i, j)])
    def summ(a):
        a = sorted(a); return {"n": len(a), "area_m2": 4 * len(a), "min": a[0], "p10": q(a, .1), "median": statistics.median(a), "p90": q(a, .9), "max": a[-1]}
    xy = [(X0 + R * i, Y0 + R * j) for i, j in cells]
    ov = {n: round(sum(1 for x, y in xy if p.contains(Point(x, y))) / len(xy), 3) for n, p in outl.items() if any(p.contains(Point(x, y)) for x, y in xy)}
    res[code] = {"model_id": mid, "cells": len(cells), "bbox": [min(x for x, _ in xy), min(y for _, y in xy), max(x for x, _ in xy), max(y for _, y in xy)],
                 "share_inside_outline": ov, "class_rule": f"상부 지붕: z >= p90-10 ({round(top,1)}) 그리고 이웃 |dz|<=3; 하부면: z < p90-10 그리고 |dz|<=3; 나머지 판독불가",
                 "classes": {k: summ(v) for k, v in cls.items()}}
# 외곽선별: 그 외곽선 안 격자점의 모델 구성
cover = {}
for n in ("문예관", "북악관", "한림관", "본관", "대일관"):
    p = outl[n]; ins = [k for k in Z if p.contains(Point(X0 + R * k[0], Y0 + R * k[1]))]
    cnt = {}
    for k in ins: cnt[C[k]] = cnt.get(C[k], 0) + 1
    cover[n] = {"grid_points_inside": len(ins), "models": cnt}
out = {"gpkg_sha256": sha, "gpkg_buildings_3d": {n: gp.get(n) for n in ("문예관", "북악관", "한림관", "본관", "대일관")},
       "scene_live": {n: scene.get(n) for n in ("문예관", "북악관", "한림관")}, "smap_elevation": elev, "models": res, "outline_cover": cover}
json.dump(out, open(os.path.join(OUT, "tower-identify.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for code in ("W", "B", "H"):
    r = res[code]; print(code, r["model_id"], r["bbox"], r["share_inside_outline"], {k: (v["n"], v["median"], v["p90"]) for k, v in r["classes"].items()})
print(json.dumps(cover, ensure_ascii=False)); print(json.dumps(out["gpkg_buildings_3d"]["문예관"], ensure_ascii=False))
try:
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    plt.rcParams["font.family"] = "Malgun Gothic"; plt.rcParams["axes.unicode_minus"] = False
    import numpy as np
    A = np.full((NY, NX), np.nan)
    for (i, j), v in Z.items():
        if v is not None and C[(i, j)] != ".": A[j, i] = v
    fig, ax = plt.subplots(figsize=(8, 10))
    im = ax.imshow(A, origin="lower", extent=[X0 - 1, X0 + R * NX - 1, Y0 - 1, Y0 + R * NY - 1], cmap="viridis", vmin=140, vmax=200)
    for n in ("문예관", "북악관", "한림관", "본관", "대일관"):
        ax.plot(*outl[n].exterior.xy, color="r", lw=1); c = outl[n].representative_point(); ax.text(c.x, c.y, n, color="w", fontsize=9, ha="center")
    ax.plot(201107.67, 557339.65, "wx", ms=10); ax.text(201108.5, 557337, "문예 입구점(buld_z 59.18)", color="w", fontsize=8)
    ax.set_xlim(X0 - 1, X0 + R * NX - 1); ax.set_ylim(Y0 - 1, Y0 + R * NY - 1); ax.set_aspect("equal")
    fig.colorbar(im, ax=ax, shrink=0.7, label="S-MAP 건물 모델 표면 z (m)"); ax.set_title("S-MAP 건물 모델 표면 z (지형 제외) + 외곽선")
    fig.savefig(os.path.join(OUT, "smap-model-top-z.png"), dpi=100, bbox_inches="tight")
except Exception as e:
    print("plot skipped", e)
