# 사잇길 표면 후보 v4: 사잇길 내부 S-MAP 표본(corridor_cells, 2 m 격자)만으로 만든 국소 삼각망.
# 삼각형 꼭짓점 = 표본 원값(내부 표본 재현). 표본이 빠진 셀은 이어 붙이지 않고 '빈칸(미검증)'으로 표시. 다른 보행면·지붕과 보간하지 않음.
# 구역: 평탄(<5 %), 경사(5~25 %), 급경사/계단 후보(>25 %, 메시가 계단을 매끈하게 그리므로 계단 확정 아님).
# 사용법: corridor_surface_v4.py <smap-mesh-reads-v3.json> <field-surfaces-v3.geojson> <path-graph-candidate.json> <building-outlines-5186.json> <출력 폴더>
import json, sys, os, math
import numpy as np
from shapely.geometry import Polygon, Point, box, mapping, shape
from shapely.ops import unary_union
if len(sys.argv) != 6: sys.exit("사용법: corridor_surface_v4.py <mesh-reads> <field-surfaces-v3> <path-graph-candidate> <outlines> <출력 폴더>")
MR, FS, PG, OL, OUT = sys.argv[1:]
M = json.load(open(MR, encoding="utf-8")); V3 = {f["properties"]["id"]: f for f in json.load(open(FS, encoding="utf-8"))["features"]}
PGD = json.load(open(PG, encoding="utf-8")); OUTL = {b["name"]: Polygon(b["coordinates"][0][0]) for b in json.load(open(OL, encoding="utf-8"))}
S = {(c[0], c[1]): c[2] for c in M["corridor_cells"]}
corr = shape(V3["SF-CORRIDOR"]["geometry"])
others = [shape(V3[k]["geometry"]) for k in ("SF-FIELD", "SF-HIGH-STRIP", "SF-WALL", "SF-DAEIL-CANOPY") if V3[k]["geometry"]] + [OUTL[n] for n in ("한림관", "문예관", "대일관", "본관")]
TOL = 0.15
tris = []
for (x, y) in S:
    a, b, c, d = (x, y), (x + 2, y), (x + 2, y + 2), (x, y + 2)
    q = [p for p in (a, b, c, d) if p in S]
    if len(q) == 4: cand = [(a, b, c), (a, c, d)]
    elif len(q) == 3: cand = [tuple(q)]
    else: continue
    for t in cand:
        poly = Polygon(t)
        if not corr.buffer(1.0).contains(poly.centroid): continue          # 사잇길 면 안에서만
        if any(o.intersection(poly).area > 0.5 * poly.area for o in others): continue   # 다른 면·건물 위 삼각형 제외
        tris.append(t)
def plane(t):
    P = np.array([[p[0], p[1], 1] for p in t], float); z = np.array([S[p] for p in t]); return np.linalg.solve(P, z)
def zone(t):
    a, b, _ = plane(t); g = math.hypot(a, b) * 100
    return ("평탄" if g < 5 else "경사" if g <= 25 else "급경사/계단 후보"), round(g, 1)
feats = []; zstat = {}
for t in tris:
    zn, g = zone(t); zstat[zn] = zstat.get(zn, 0) + 1
    feats.append({"type": "Feature", "properties": {"kind": "사잇길 표면 삼각형", "zone": zn, "grade_pct": g, "accuracyVerified": False, "z_src": "S-MAP 메시 내부 표본(꼭짓점 원값)"},
                  "geometry": {"type": "Polygon", "coordinates": [[[p[0], p[1], S[p]] for p in t + (t[0],)]]}})
cover = unary_union([Polygon(t) for t in tris])
gaps = corr.difference(cover.buffer(0.01))
gaps = [g for g in (gaps.geoms if gaps.geom_type == "MultiPolygon" else [gaps]) if g.area >= 1.0]
for g in gaps:
    feats.append({"type": "Feature", "properties": {"kind": "빈칸(표본 없음·다른 면 경계)", "zone": "미검증", "z": None, "area_m2": round(g.area, 1), "note": "보간하지 않음"}, "geometry": mapping(g)})
def z_at(x, y):
    for t in tris:
        P = Polygon(t)
        if P.buffer(1e-6).contains(Point(x, y)):
            a, b, c = plane(t); return round(float(a * x + b * y + c), 3), zone(t)[0]
    return None, "삼각망 밖"
fc = {"type": "FeatureCollection", "name": "corridor-surface-v4", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
      "properties": {"created": "2026-10-10", "accuracyVerified": False, "status": "검토 데이터, 운영 미반영", "triangles": len(tris), "samples": len(S), "zone_counts": zstat}, "features": feats}
json.dump(fc, open(os.path.join(OUT, "corridor-surface-v4.geojson"), "w", encoding="utf-8"), ensure_ascii=False)
L = []
def chk(n, c, t=""): L.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
used = {p for t in tris for p in t}
rep = []
for p in used:
    z, _ = z_at(*p); rep.append(abs(z - S[p]) if z is not None else 99)
chk("표본 위치 재현 오차(삼각형 꼭짓점 = 표본)", max(rep) < 1e-6, f"최대 {max(rep):.2e} m, 표본 {len(used)}/{len(S)} 사용")
chk("삼각망 꼭짓점이 모두 사잇길 내부 표본(다른 면 표본 없음)", used <= set(S))
chk("구역 밖(다른 보행면·지붕·건물) 삼각형 없음", all(all(o.intersection(Polygon(t)).area <= 0.5 * Polygon(t).area for o in others) for t in tris))
chk("빈칸은 보간 없이 표시", all(f["properties"].get("z") is None for f in feats if f["properties"]["kind"].startswith("빈칸")), f"{len(gaps)}곳, 합 {sum(g.area for g in gaps):.1f} m²")
cn = {n["node"]: n for n in PGD["candidate_nodes_z"]}
pts = {"EXIT 하단 C1-N-EXITBOT": "C1-N-EXITBOT", "A14 상단 C1-N-A14T": "C1-N-A14T", "A14 하단 C1-N-A14B": "C1-N-A14B"}
sync = []
for lab, k in pts.items():
    x, y = cn[k]["xy"]; z, zn = z_at(x, y); zc = cn[k]["z_cand"]
    d = None if z is None else round(z - zc, 3)
    sync.append({"point": lab, "xy": [x, y], "surface_z": z, "zone": zn, "graph_node_z": zc, "diff": d, "within_tol": bool(d is not None and abs(d) <= TOL)})
    L.append(("PASS " if d is not None and abs(d) <= TOL else "FAIL ") + f"계단 검사점 {lab} 표면 z vs 그래프 노드 z(±{TOL} m)" + f" | 표면 {z} ({zn}) / 노드 {zc} / 차 {d}")
L.append("INFO 구역별 삼각형 | " + json.dumps(zstat, ensure_ascii=False))
L.append("INFO 그래프 동기 | 노드 z는 바꾸지 않음. 차이가 허용치를 넘는 노드는 위 FAIL로 보고")
json.dump({"stair_points": sync}, open(os.path.join(OUT, "corridor-surface-v4-stairpoints.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
open(os.path.join(OUT, "corridor-surface-v4-checks.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
sys.exit(1 if any(l.startswith("FAIL") for l in L) else 0)
