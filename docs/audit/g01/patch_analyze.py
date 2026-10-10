# G01: smap_patch.py 가 받은 구획(2 m 격자)과 0.25 m 간격 줄을 읽어, 건물 자리에서 무엇이 오는지, 조회값의 격자 크기,
# 서버 지형(2015)·기존 S-MAP 메시 표본과의 차를 계산한다. 읽기 전용.
#   python -I patch_analyze.py <audit 폴더> <결과 json> [그림 png]
import sys, json, io, math
import numpy as np
AUD, OUT = sys.argv[1:3]; G = AUD + "/g01"
def load(f):
    r = {}
    for l in io.open(f, encoding="utf-8"):
        o = json.loads(l)
        if o["status"] == 200: q = json.loads(o["raw"])["result"]; r[(o["x"], o["y"])] = (q["dem_z"], q["buld_z"])
    return r
P = load(G + "/smap-patch-hanlim-field-2m.jsonl")
m = json.load(open(AUD + "/terrain-grid-meta.json")); g = np.fromfile(AUD + "/terrain-grid.f32", dtype="<f4").reshape(m["height"], m["width"])
def grid(x, y):
    fx, fy = (x - m["originX"]) / 2 - .5, (y - m["originY"]) / 2 - .5; i, j = int(fx), int(fy); tx, ty = fx - i, fy - j
    return float(g[j, i] * (1 - tx) * (1 - ty) + g[j, i + 1] * tx * (1 - ty) + g[j + 1, i] * (1 - tx) * ty + g[j + 1, i + 1] * tx * ty)
outl = {b["name"]: b["coordinates"] for b in json.load(open(AUD + "/building-outlines-5186.json", encoding="utf-8"))}
def inside(x, y, ring):
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
def bname(x, y):
    for n, mp in outl.items():
        for poly in mp:
            if inside(x, y, [tuple(p[:2]) for p in poly[0]]): return n
    return None
def st(v):
    v = np.array(v, float); a = np.abs(v)
    return {"n": int(v.size), "median": round(float(np.median(v)), 2), "p90abs": round(float(np.percentile(a, 90)), 2), "maxabs": round(float(a.max()), 2), "min": round(float(v.min()), 2), "max": round(float(v.max()), 2)} if v.size else {"n": 0}
res = {"patch": {"points": len(P), "bbox": [min(k[0] for k in P), min(k[1] for k in P), max(k[0] for k in P), max(k[1] for k in P)]}}
# 1) 건물 자리
bz = {k: v for k, v in P.items() if v[1] is not None}; fp = {k: bname(*k) for k in P}
res["building"] = {"buldZ_points": len(bz), "footprint_points": sum(1 for v in fp.values() if v), "both": sum(1 for k in bz if fp[k]), "buldZ_only": sum(1 for k in bz if not fp[k]),
                   "footprint_only": sum(1 for k in P if fp[k] and k not in bz), "buldZ_values": sorted({round(v[1], 2) for v in bz.values()}),
                   "demZ_under_buldZ": st([v[0] for v in bz.values()]), "demZ_range_by_buldZ": {}}
for h in res["building"]["buldZ_values"]:
    z = [v[0] for v in bz.values() if round(v[1], 2) == h]; res["building"]["demZ_range_by_buldZ"][str(h)] = [len(z), round(min(z), 2), round(max(z), 2), round(min(z) + h, 2), round(max(z) + h, 2)]
# 건물 자리 dem_z 가 바로 옆 열린 칸과 이어지는가: 건물 칸과 맞닿은 열린 칸과의 높이차
edge = [P[k][0] - P[n][0] for k in bz for n in ((k[0] + 2, k[1]), (k[0] - 2, k[1]), (k[0], k[1] + 2), (k[0], k[1] - 2)) if n in P and n not in bz]
res["building"]["step_building_cell_minus_open_neighbour"] = st(edge)
# 2) 서버 지형과의 차
d = {k: grid(*k) - v[0] for k, v in P.items()}
res["server_minus_smap"] = {"all": st(list(d.values())), "open": st([d[k] for k in P if k not in bz]), "building": st([d[k] for k in bz])}
# 3) 기존 메시 표본(E01 samples.json: 2 m 격자에서 읽은 3D 화면 표면 높이)과의 차
S = json.load(open(AUD + "/e01/samples.json", encoding="utf-8")); mesh = {}
for part in ("samples", "excluded"):
    for s in S[part]:
        if s.get("kind") == "mesh": mesh[(round(s["x"], 1), round(s["y"], 1))] = (s["z"], part, s.get("why"))
pair = [(k, mesh[k][0] - P[k][0], mesh[k][1], k in bz) for k in P if k in mesh]
res["mesh_minus_smap_dem"] = {"used_open": st([p[1] for p in pair if p[2] == "samples"]), "excluded_as_building_or_other_open": st([p[1] for p in pair if p[2] == "excluded" and not p[3]]),
                             "excluded_buldZ": st([p[1] for p in pair if p[2] == "excluded" and p[3]])}
# 4) 격자 크기: 0.25 m 간격 줄에서 값이 바뀌는 자리
res["lines"] = {}
for name in ("smap-line-y557290-025m", "smap-line-y557240-025m"):
    try: L = sorted(load(f"{G}/{name}.jsonl").items())
    except FileNotFoundError: continue
    ch = [L[i][0][0] for i in range(1, len(L)) if L[i][1][0] != L[i - 1][1][0]]
    res["lines"][name] = {"points": len(L), "distinct": len({v[0] for _, v in L}), "changes_at_x": ch, "z_first_last": [round(L[0][1][0], 3), round(L[-1][1][0], 3)],
                          "max_step": round(max(abs(L[i][1][0] - L[i - 1][1][0]) for i in range(1, len(L))), 3)}
json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1); print(json.dumps(res, ensure_ascii=False, indent=1))
if len(sys.argv) > 3:
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    xs = sorted({k[0] for k in P}); ys = sorted({k[1] for k in P}); Z = np.array([[P[(x, y)][0] for x in xs] for y in ys]); Gd = np.array([[grid(x, y) for x in xs] for y in ys])
    fig, ax = plt.subplots(1, 3, figsize=(15, 5)); ext = [xs[0] - 1, xs[-1] + 1, ys[0] - 1, ys[-1] + 1]
    for a, im, t, kw in ((ax[0], Z, "S-MAP dem_z (m)", dict(cmap="terrain", vmin=120, vmax=152)), (ax[1], Gd, "server terrain 2015 (m)", dict(cmap="terrain", vmin=120, vmax=152)), (ax[2], Gd - Z, "server - S-MAP (m)", dict(cmap="RdBu", vmin=-10, vmax=10))):
        h = a.imshow(im, origin="lower", extent=ext, **kw); fig.colorbar(h, ax=a, shrink=.8); a.set_title(t)
        for mp in outl.values():
            for poly in mp: r = np.array([p[:2] for p in poly[0]]); a.plot(r[:, 0], r[:, 1], "k-", lw=1)
        bx = [k for k in bz]; a.plot([k[0] for k in bx], [k[1] for k in bx], "k.", ms=2); a.set_xlim(ext[:2]); a.set_ylim(ext[2:])
    fig.suptitle("G01 patch x 201110-201150, y 557270-557310 (EPSG:5186), 2 m; dots = buld_z returned, lines = building outlines"); fig.tight_layout(); fig.savefig(sys.argv[3], dpi=110)
