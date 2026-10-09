# 사잇길 표면 후보 v5.1 (v5 수정: 좌표 반올림 없이 저장, 내부 고리 기록, 모든 검사를 저장 파일 재판독으로 수행): 사잇길 내부 S-MAP 표본(corridor_cells, 2 m 격자)만으로 만든 국소 삼각망.
# 삼각형 꼭짓점 = 표본 원값(내부 표본 재현). 표본이 빠진 셀은 이어 붙이지 않고 '빈칸(미검증)'으로 표시. 다른 보행면·지붕과 보간하지 않음.
# 구역: 평탄(<5 %), 경사(5~25 %), 급경사/계단 후보(>25 %, 메시가 계단을 매끈하게 그리므로 계단 확정 아님).
# 사용법: corridor_surface_v5.py <smap-mesh-reads-v3.json> <field-surfaces-v3.geojson> <path-graph-candidate.json> <building-outlines-5186.json> <출력 폴더>
import json, sys, os, math
import numpy as np
from shapely.geometry import Polygon, Point, box, mapping, shape
from shapely.ops import unary_union
if len(sys.argv) != 6: sys.exit("사용법: corridor_surface_v5.py <mesh-reads> <field-surfaces-v3> <path-graph-candidate> <outlines> <출력 폴더>")
MR, FS, PG, OL, OUT = sys.argv[1:]
M = json.load(open(MR, encoding="utf-8")); V3 = {f["properties"]["id"]: f for f in json.load(open(FS, encoding="utf-8"))["features"]}
PGD = json.load(open(PG, encoding="utf-8")); OUTL = {b["name"]: Polygon(b["coordinates"][0][0]) for b in json.load(open(OL, encoding="utf-8"))}
S = {(c[0], c[1]): c[2] for c in M["corridor_cells"]}
corr = shape(V3["SF-CORRIDOR"]["geometry"])
others = [shape(V3[k]["geometry"]) for k in ("SF-FIELD", "SF-HIGH-STRIP", "SF-WALL", "SF-DAEIL-CANOPY") if V3[k]["geometry"]] + [OUTL[n] for n in ("한림관", "문예관", "대일관", "본관")]
TOL = 0.15
from shapely import force_2d
corr = force_2d(corr); others = [force_2d(o) for o in others]
mask = corr
for o in others: mask = mask.difference(o)
EPS = 1e-6   # 면적 허용치(m²)
tris = []
for (x, y) in S:
    a, b, c, d = (x, y), (x + 2, y), (x + 2, y + 2), (x, y + 2)
    q = [p for p in (a, b, c, d) if p in S]
    if len(q) == 4: cand = [(a, b, c), (a, c, d)]
    elif len(q) == 3: cand = [tuple(q)]
    else: continue
    tris += cand
def plane(t):
    P = np.array([[p[0], p[1], 1] for p in t], float); z = np.array([S[p] for p in t]); return np.linalg.solve(P, z)
def zone(t):
    a, b, _ = plane(t); g = math.hypot(a, b) * 100
    return ("평탄" if g < 5 else "경사" if g <= 25 else "급경사/계단 후보"), round(g, 1)
pieces = []   # (원 삼각형, 절단 다각형)
for t in tris:
    cp = Polygon(t).intersection(mask)
    for g in (cp.geoms if hasattr(cp, "geoms") else [cp]):
        if g.geom_type == "Polygon" and g.area > EPS: pieces.append((t, g))
feats = []; zstat = {}
def zxy(t, x, y): a_, b_, c_ = plane(t); return round(float(a_ * x + b_ * y + c_), 4)
for t, g in pieces:
    zn, gr = zone(t); zstat[zn] = zstat.get(zn, 0) + 1
    def rz(r): return [[x, y, (S[(x, y)] if (x, y) in S else zxy(t, x, y))] for x, y in r.coords]
    ring = rz(g.exterior); holes = [rz(h) for h in g.interiors]
    feats.append({"type": "Feature", "properties": {"kind": "사잇길 표면 조각", "zone": zn, "grade_pct": gr, "accuracyVerified": False,
                  "z_src": "꼭짓점: 표본 원값, 절단 꼭짓점: 같은 원 삼각형 평면", "source_triangle": [list(p) for p in t]}, "geometry": {"type": "Polygon", "coordinates": [ring] + holes}})
cover = unary_union([g for _, g in pieces])
gaps = mask.difference(cover)
gaps = [g for g in (gaps.geoms if hasattr(gaps, "geoms") else [gaps]) if g.area >= 1.0]
for g in gaps:
    feats.append({"type": "Feature", "properties": {"kind": "빈칸(표본 없음)", "zone": "미검증", "z": None, "area_m2": round(g.area, 1), "note": "보간하지 않음"}, "geometry": mapping(g)})
def z_at(x, y):
    for t, g in pieces:
        if g.buffer(1e-6).contains(Point(x, y)): return round(zxy(t, x, y), 3), zone(t)[0]
    return None, "표면 밖(절단으로 제외)"
fc = {"type": "FeatureCollection", "name": "corridor-surface-v5.1", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
      "properties": {"created": "2026-10-10", "accuracyVerified": False, "status": "검토 데이터, 운영 미반영", "source_triangles": len(tris), "pieces": len(pieces), "samples": len(S), "zone_counts": zstat}, "features": feats}
json.dump(fc, open(os.path.join(OUT, "corridor-surface-v5.1.geojson"), "w", encoding="utf-8"), ensure_ascii=False)
L = []
def chk(n, c, t=""): L.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
# ---- 이하 모든 검사는 저장 파일을 다시 읽어 수행 ----
RD = json.load(open(os.path.join(OUT, "corridor-surface-v5.1.geojson"), encoding="utf-8"))
saved = [(tuple(tuple(p) for p in f["properties"]["source_triangle"]), Polygon([p[:2] for p in f["geometry"]["coordinates"][0]], [[p[:2] for p in h] for h in f["geometry"]["coordinates"][1:]]), f)
         for f in RD["features"] if f["properties"]["kind"].startswith("사잇길")]
pieces = [(t, g) for t, g, _ in saved]
n_holes = sum(len(f["geometry"]["coordinates"]) - 1 for _, _, f in saved)
out_area = sum(g.difference(corr).area for _, g in pieces)
ov = {}
for name, o in zip(["SF-FIELD", "SF-HIGH-STRIP", "SF-WALL", "SF-DAEIL-CANOPY", "한림관", "문예관", "대일관", "본관"], others): ov[name] = round(sum(g.intersection(o).area for _, g in pieces), 6)
chk(f"SF-CORRIDOR 밖 면적 = 0 (허용 {EPS} m²)", out_area <= EPS, f"{out_area:.2e} m²")
chk(f"다른 표면·건물과 겹침 = 0 (허용 {EPS} m²)", all(v <= EPS for v in ov.values()), json.dumps(ov, ensure_ascii=False))
inside = [p for p in S if mask.buffer(1e-6).contains(Point(p))]
verts = {(v[0], v[1]): v[2] for _, _, f in saved for r in f["geometry"]["coordinates"] for v in r}
kept = [p for p in inside if p in verts and abs(verts[p] - S[p]) < 1e-9]
chk("마스크 안 원 표본이 꼭짓점으로 원값 유지", len(kept) == len([p for p in inside if any(p in t for t in tris)]), f"{len(kept)}/{len(inside)} (마스크 밖 표본 {len(S) - len(inside)}개는 다른 면 경계 밖이라 제외)")
rep = [abs(z_at(*p)[0] - S[p]) for p in kept]
chk("표본 위치 재현 오차", max(rep) < 1e-6, f"최대 {max(rep):.2e} m")
chk("빈칸은 보간 없이 표시(저장 파일)", all(f["properties"].get("z") is None for f in RD["features"] if f["properties"]["kind"].startswith("빈칸")), f"{len(gaps)}곳, 합 {sum(g.area for g in gaps):.1f} m²")
chk("내부 고리 꼭짓점 z도 기록", all(len(v) == 3 and v[2] is not None for _, _, f in saved for r in f["geometry"]["coordinates"][1:] for v in r), f"내부 고리 {n_holes}개")
L.append(f"INFO 저장 정밀도 | 좌표 반올림 없음(float 전체), 면적 허용치 {EPS} m² 동일 적용")
L.append("INFO 경계 확장 | 원천 경계(SF-CORRIDOR)는 넓히지 않음. 넓힐 근거 없음(별도 후보 없음)")
cn = {n["node"]: n for n in PGD["candidate_nodes_z"]}
pts = {"EXIT 하단 C1-N-EXITBOT": "C1-N-EXITBOT", "A14 상단 C1-N-A14T": "C1-N-A14T", "A14 하단 C1-N-A14B": "C1-N-A14B"}
sync = []
for lab, k in pts.items():
    x, y = cn[k]["xy"]; z, zn = z_at(x, y); zc = cn[k]["z_cand"]
    d = None if z is None else round(z - zc, 3)
    sync.append({"point": lab, "xy": [x, y], "surface_z": z, "zone": zn, "graph_node_z": zc, "diff": d, "within_tol": bool(d is not None and abs(d) <= TOL)})
    L.append(("PASS " if d is not None and abs(d) <= TOL else "FAIL ") + f"노드 지점 표면 z 일치(같은 XY, 접속 방향 검사 아님) {lab} (±{TOL} m)" + f" | 표면 {z} ({zn}) / 노드 {zc} / 차 {d}")
L.append("INFO 구역별 삼각형 | " + json.dumps(zstat, ensure_ascii=False))
L.append("INFO 그래프 동기 | 노드 z는 바꾸지 않음. 위 '노드 지점 일치'는 진행 방향 접속 검사(예: A14 하단 +0.90 FAIL)를 대신하지 않음")
json.dump({"stair_points": sync}, open(os.path.join(OUT, "corridor-surface-v5.1-stairpoints.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
open(os.path.join(OUT, "corridor-surface-v5.1-checks.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
sys.exit(1 if any(l.startswith("FAIL") for l in L) else 0)
