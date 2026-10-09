# v3.1: 기존 낮은길 8e71c240(DRAFT ramp, z 141.73 일정)과 인접 c52095ad·45682ee7 끝을 사잇길 표면 v5.1·S-MAP 표본과 대조하고,
# A14 하단 → 8e71c240 접속 후보를 방향·꺾임각·인접 면 소속·높이 프로파일로 평가. 운영 도로는 이동·z 변경하지 않는다.
# 사용법: low_road_check_v31.py <roads-live-2.json> <corridor-surface-v5.1.geojson> <field-surfaces-v3.geojson> <smap-mesh-reads-v3.json> <field-structure-patch-v2.json> <출력 json>
import json, sys, math
import numpy as np
from shapely.geometry import LineString, Point, Polygon, shape
from shapely import force_2d
if len(sys.argv) != 7: sys.exit("사용법: low_road_check_v31.py <roads> <corridor-v5.1> <field-surfaces-v3> <mesh-reads> <patch-v2> <출력 json>")
RP, CS, FS, MR, P2, OUTP = sys.argv[1:]
R = json.load(open(RP, encoding="utf-8")); R = R["items"] if isinstance(R, dict) else R; RO = {r["id"][:8]: r for r in R}
PIECES = [(Polygon([p[:2] for p in f["geometry"]["coordinates"][0]]), f) for f in json.load(open(CS, encoding="utf-8"))["features"] if f["properties"]["kind"].startswith("사잇길")]
GAPS = [Polygon([p[:2] for p in f["geometry"]["coordinates"][0]]) for f in json.load(open(CS, encoding="utf-8"))["features"] if f["properties"]["kind"].startswith("빈칸")]
V3 = {f["properties"]["id"]: force_2d(shape(f["geometry"])) for f in json.load(open(FS, encoding="utf-8"))["features"] if f["geometry"]}
M = json.load(open(MR, encoding="utf-8")); CC = {(c[0], c[1]): c[2] for c in M["corridor_cells"]}
P = json.load(open(P2, encoding="utf-8")); pins = {s["id"]: s for s in P["samples"]}
def surf_z(x, y):
    for g, f in PIECES:
        if g.buffer(1e-6).contains(Point(x, y)):
            t = f["properties"]["source_triangle"]; A = np.array([[p[0], p[1], 1] for p in t], float)
            a, b, c = np.linalg.solve(A, np.array([CC[(p[0], p[1])] for p in t], float)); return round(float(a * x + b * y + c), 2), "사잇길 v5.1", f["properties"]["zone"]
    for g in GAPS:
        if g.contains(Point(x, y)): return None, "사잇길 빈칸(표본 없음)", None
    for k in ("SF-FIELD", "SF-HIGH-STRIP", "SF-WALL", "SF-PLANTER", "SF-DAEIL-CANOPY", "SF-DAEIL-ENTRY-PAVE"):
        if k in V3 and V3[k].contains(Point(x, y)): return None, k, None
    return None, "어느 표면에도 없음", None
def along(rk, step=1.0):
    r = RO[rk]; ls = LineString([p[:2] for p in r["coordinates"]]); zs = [p[2] for p in r["coordinates"]]
    out = []
    for d in np.arange(0, ls.length + 1e-9, step):
        q = ls.interpolate(d); z_op = zs[0] + (zs[-1] - zs[0]) * d / ls.length
        z, s_, zone = surf_z(q.x, q.y); out.append({"d": round(float(d), 1), "xy": [round(q.x, 2), round(q.y, 2)], "z_op": round(z_op, 2), "surface": s_, "zone": zone, "z_surface": z, "diff": None if z is None else round(z - z_op, 2)})
    return out
lines = {k: along(k) for k in ("8e71c240", "45682ee7", "c52095ad")}
def summ(rows):
    mem = {}
    for r in rows: mem[r["surface"]] = mem.get(r["surface"], 0) + 1
    d = [r["diff"] for r in rows if r["diff"] is not None]
    return {"samples": len(rows), "membership": mem, "diff_min": min(d) if d else None, "diff_max": max(d) if d else None, "diff_median": float(np.median(d)) if d else None}
SUM = {k: summ(v) for k, v in lines.items()}
vert = {k: [{"xy": [round(p[0], 2), round(p[1], 2)], "z_op": p[2], **dict(zip(("z_surface", "surface", "zone"), surf_z(p[0], p[1])))} for p in RO[k]["coordinates"]] for k in ("8e71c240",)}
# 접속 후보: A14 하단 → (1) 8e71c240 최근접점, (2) 서쪽 끝 4f294196, (3) 동쪽 끝 ef5a3c9c
a14 = next(o for o in P["ops"] if o.get("id") == "NEW-A14"); A14T = tuple(a14["coordinates_xy"][0])
A14B = (201118.0, 557312.0)
ls8 = LineString([p[:2] for p in RO["8e71c240"]["coordinates"]]); qn = ls8.interpolate(ls8.project(Point(A14B)))
targets = {"최근접점": (qn.x, qn.y), "서쪽 끝 4f294196": tuple(RO["8e71c240"]["coordinates"][0][:2]), "동쪽 끝 ef5a3c9c": tuple(RO["8e71c240"]["coordinates"][-1][:2])}
sd = (A14B[0] - A14T[0], A14B[1] - A14T[1])
def ang(u, v): return round(math.degrees(math.acos(max(-1, min(1, (u[0] * v[0] + u[1] * v[1]) / (math.hypot(*u) * math.hypot(*v)))))), 1)
cands = []
for name, tg in targets.items():
    v = (tg[0] - A14B[0], tg[1] - A14B[1]); L = math.hypot(*v); prof = []
    for i in range(int(L) + 1):
        x, y = A14B[0] + v[0] * i / L, A14B[1] + v[1] * i / L; z, s_, zone = surf_z(x, y); prof.append({"d": i, "z": z, "surface": s_})
    zs = [p["z"] for p in prof if p["z"] is not None]
    trend = None if len(zs) < 2 else ("오르막" if zs[-1] - zs[0] > 0.5 else "내리막" if zs[0] - zs[-1] > 0.5 else "평탄")
    maxg = max((abs(prof[i + 1]["z"] - prof[i]["z"]) for i in range(len(prof) - 1) if prof[i]["z"] is not None and prof[i + 1]["z"] is not None), default=None)
    cands.append({"target": name, "xy": [round(tg[0], 2), round(tg[1], 2)], "gap_m": round(L, 2), "direction_vec": [round(v[0], 2), round(v[1], 2)], "bearing_deg": round(math.degrees(math.atan2(v[0], v[1])) % 360, 1),
                  "turn_from_stair_deg": ang(sd, v), "profile": prof, "trend": trend, "max_step_per_m": None if maxg is None else round(maxg, 2), "surfaces": sorted({p["surface"] for p in prof})})
pin_note = {k: {"xy": pins[k]["xy"], "value": pins[k]["value"], "map_err_m": pins[k]["err_m"], "dist_to_8e71c240_m": round(ls8.distance(Point(pins[k]["xy"])), 1)} for k in ("P8-141.4", "P8-141.9", "P8-144.9", "P8-145.4")}
out = {"created": "2026-10-10", "status": "검토(운영 도로 이동·z 변경 없음)", "line_samples": lines, "summary": SUM, "vertices_8e71c240": vert, "a14_bottom": A14B, "stair_dir_vec": [round(sd[0], 2), round(sd[1], 2)],
       "connection_candidates": cands, "photo8_pins": pin_note}
json.dump(out, open(OUTP, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for k, v in SUM.items(): print(k, json.dumps(v, ensure_ascii=False))
print("verts", json.dumps(vert, ensure_ascii=False))
for c in cands: print(c["target"], c["gap_m"], c["bearing_deg"], c["turn_from_stair_deg"], c["trend"], c["max_step_per_m"], c["surfaces"], [p["z"] for p in c["profile"]])
print(json.dumps(pin_note, ensure_ascii=False))
