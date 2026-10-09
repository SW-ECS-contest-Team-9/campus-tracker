# 문예관 고층부 형상 보정 후보 (미리보기 전용, accuracyVerified=false). 읽기 전용 입력, 운영·GPKG 변경 없음.
# 사용법: build_munye.py <smap-grid-2m.txt> <building-outlines-5186.json> <scene-live.json> <campus.gpkg> <볼트 출력 폴더> <미리보기 data 폴더>
# 분류(tower_identify.py와 같은 규칙): W 모델 셀만. jump = 같은 모델 4방향 이웃과 |dz| 최대.
#   고층 지붕 = z >= p90-10 이고 jump <= 3 / 저층 날개 = z < p90-10 이고 jump <= 3 / 나머지 불명확(경계·벽·지면 등)
# 지붕 메시: 고층 지붕 표본만 정점(x,y,z 원값), 2x2 블록 두 삼각형, 세 변 |dz| <= 3 m. 불명확·저층 셀 너머 연결·외삽 없음.
# 매스 후보: 고층부 = (z >= p90-10 인 W 셀의 2m 정사각형 합) ∩ 원외곽선, 저층 날개 = (저층 날개 셀 정사각형 합) ∩ 원외곽선 - 고층부,
#   나머지 = 원외곽선 - 둘. 상단: 고층부 = 고층 지붕 z 중앙값, 저층·나머지 = 원본 roofM 유지. 하단 = 원본 baseM(미확정).
import json, os, sys, shutil, sqlite3, hashlib, statistics
from shapely.geometry import Polygon, Point, box, mapping
from shapely.ops import unary_union
if len(sys.argv) != 7: sys.exit("사용법: build_munye.py <smap-grid-2m.txt> <building-outlines-5186.json> <scene-live.json> <campus.gpkg> <볼트 출력 폴더> <미리보기 data 폴더>")
GRID, OUTL, SCENE, GPKG, V, PREVIEW = sys.argv[1:]
X0, Y0, R, NX = 201070, 557270, 2, 36
JUMP, TOPDROP = 3.0, 10.0
Z, C = {}, {}
for ln in open(GRID, encoding="utf-8"):
    if ln.startswith("#") or not ln.strip(): continue
    j, sm, ids, vals = ln.strip().split(":"); vals = [int(v) for v in vals.split(",")]
    assert len(vals) == NX and sum(vals) == int(sm)
    for i, (v, c) in enumerate(zip(vals, ids)): Z[(i, int(j))] = v / 10 if v > 0 else None; C[(i, int(j))] = c
assert hashlib.sha256(open(GPKG, "rb").read()).hexdigest() == "26c66faa36bd03c3f7106d68ac8a2f8e0a89a452f7899e5b0f20ab0673b45d13"
con = sqlite3.connect("file:" + GPKG + "?mode=ro", uri=True)
gp = dict(zip(("height_m", "height_source", "ground_floors", "base_m", "roof_m"),
              con.execute("select height_m,height_source,ground_floors,base_m,roof_m from buildings_3d where name='문예관'").fetchone()))
sc = next(b for b in json.load(open(SCENE, encoding="utf-8"))["buildings"] if b["name"] == "문예관")
outl = Polygon(next(b for b in json.load(open(OUTL, encoding="utf-8")) if b["name"] == "문예관")["coordinates"][0][0])
XY = lambda k: (X0 + R * k[0], Y0 + R * k[1])
cells = [k for k in Z if C[k] == "W" and Z[k] is not None]
zs = sorted(Z[k] for k in cells); TOP = round(zs[min(len(zs) - 1, int(len(zs) * .9))] - TOPDROP, 2)
cls = {}
for (i, j) in cells:
    nb = [(i + a, j + b) for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1)) if C.get((i + a, j + b)) == "W" and Z.get((i + a, j + b)) is not None]
    jump = max((abs(Z[n] - Z[(i, j)]) for n in nb), default=None)
    cls[(i, j)] = ("불명확" if jump is None or jump > JUMP else ("고층 지붕" if Z[(i, j)] >= TOP else "저층 날개"), jump)
roof = {k for k, (c, _) in cls.items() if c == "고층 지붕"}
rz = sorted(Z[k] for k in roof); RMED = statistics.median(rz)
EQ = RMED + 1.0  # 옥상 구조물 의심 표시 기준(시각 검토용, 메시에서 빼지 않음)
def ok(a, b): return abs(Z[a] - Z[b]) <= JUMP
def tri_ok(t): return all(c in roof for c in t) and ok(t[0], t[1]) and ok(t[1], t[2]) and ok(t[0], t[2])
tris = []
for (i, j) in sorted(roof):
    a, b, c, d = (i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)
    g1 = [t for t in [(a, b, c), (a, c, d)] if tri_ok(t)]; g2 = [t for t in [(a, b, d), (b, c, d)] if tri_ok(t)]
    tris += g1 if len(g1) >= len(g2) else g2
used = {c for t in tris for c in t}
P3 = lambda k: [*XY(k), Z[k]]
CRS = {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}}
common = {"status": "미리보기 후보 전용, 운영·원본 반영 금지", "accuracyVerified": False, "created": "2026-10-10",
          "source": "S-MAP 3D 메시 표면 z·모델 id 2m 격자(2026-10-10, 고층부식별/smap-grid-2m.txt), 모델 W=174587905 (추정 문예관)"}
samp = {"type": "FeatureCollection", "name": "munye-sample-class", "crs": CRS,
        "properties": {**common, "rule": f"W 셀만. jump=같은 모델 4방향 이웃 |dz| 최대. 고층 지붕: z>={TOP} (W p90-{TOPDROP}) 그리고 jump<={JUMP}; 저층 날개: z<{TOP} 그리고 jump<={JUMP}; 나머지 불명확",
                       "roof_structure_suspect_rule": f"고층 지붕 중 z > 지붕 중앙값+1 ({EQ:.1f}) = 옥상 구조물(테두리·옥탑) 의심(추정)"},
        "features": [{"type": "Feature", "properties": {"i": k[0], "j": k[1], "z": Z[k], "class": c, "jump": j_, "inside_outline": outl.contains(Point(XY(k))),
                       "roof_structure_suspect": c == "고층 지붕" and Z[k] > EQ, "in_mesh": k in used},
                       "geometry": {"type": "Point", "coordinates": P3(k)}} for k, (c, j_) in sorted(cls.items())]}
surf = {"type": "FeatureCollection", "name": "munye-roof-surface", "crs": CRS,
        "properties": {**common, "rule": f"고층 지붕 표본만 정점(x,y,z 원값), 2x2 블록 삼각형, 세 변 |dz|<={JUMP}m, 저층·불명확 셀 너머 연결·외삽 없음",
                       "walls_base_floors": "미확정(그리지 않음)"},
        "features": [{"type": "Feature", "properties": {"id": "MY-T-surface", "triangles": len(tris), "vertices": len(used), "accuracyVerified": False},
                      "geometry": {"type": "MultiPolygon", "coordinates": [[[P3(c) for c in (*t, t[0])]] for t in tris]}}]}
sq = lambda ks: unary_union([box(XY(k)[0] - 1, XY(k)[1] - 1, XY(k)[0] + 1, XY(k)[1] + 1) for k in ks])
hi = sq([k for k in cells if Z[k] >= TOP]).intersection(outl)
lo = sq([k for k, (c, _) in cls.items() if c == "저층 날개"]).intersection(outl).difference(hi)
rest = outl.difference(hi).difference(lo)
base, roof0 = sc["baseM"], sc["roofM"]
parts = [("MY-T", "고층부 후보", hi, RMED, "S-MAP 고층 지붕 표본 z 중앙값(추정)"),
         ("MY-L", "저층 날개 후보", lo, roof0, "원본 roofM 유지(저층 표본 중앙값은 참고만)"),
         ("MY-R", "불명확 나머지", rest, roof0, "원본 roofM 유지(경계·벽·지면 표본, 미확정)")]
lowz = sorted(Z[k] for k, (c, _) in cls.items() if c == "저층 날개")
mass = {"type": "FeatureCollection", "name": "munye-massing-candidate", "crs": CRS,
        "properties": {**common, "original": {"scene_live": {"baseM": base, "roofM": roof0}, "gpkg_buildings_3d": gp},
                       "not_used": "55m 단일 extrusion, H59.2+DEM 지붕, 저층 날개 189.4 상향 — 모두 사용 안 함",
                       "base_floors_indoor_roads": "원본 유지, 미확정"},
        "features": [{"type": "Feature", "properties": {"id": pid, "part": name, "area_m2": round(g.area, 1), "topZ": round(top, 3), "top_source": src,
                       "baseM": base, "base_status": "미확정(원본 baseM)", "ground_floors": gp["ground_floors"], "floors_status": "미확정(원본 값)",
                       "indoor_roads": "변경 없음·미확정", "roof_diff_vs_scene_roofM": round(top - roof0, 2), "roof_diff_vs_gpkg_roof_m": round(top - gp["roof_m"], 2),
                       "accuracyVerified": False, **({"low_sample_z_median": statistics.median(lowz), "low_sample_n": len(lowz)} if pid == "MY-L" else {})},
                       "geometry": mapping(g)} for pid, name, g, top, src in parts if not g.is_empty]}
os.makedirs(V, exist_ok=True)
for name, fc in (("munye-sample-class-5186.geojson", samp), ("munye-roof-surface-5186.geojson", surf), ("munye-massing-candidate-5186.geojson", mass)):
    p = os.path.join(V, name); json.dump(fc, open(p, "w", encoding="utf-8"), ensure_ascii=False)
    if name != "munye-sample-class-5186.geojson": shutil.copy(p, os.path.join(PREVIEW, name))
cnt = {}
for c, _ in cls.values(): cnt[c] = cnt.get(c, 0) + 1
inside = {}
for k, (c, _) in cls.items():
    if outl.contains(Point(XY(k))): inside[c] = inside.get(c, 0) + 1
print(json.dumps({"TOP": TOP, "counts": cnt, "counts_inside_outline": inside, "roof_median": RMED, "roof_range": [rz[0], rz[-1]],
                  "suspect": sum(1 for k in roof if Z[k] > EQ), "tris": len(tris), "verts": len(used), "unused_roof": len(roof - used), "low_z": lowz,
                  "areas": {p[0]: round(p[2].area, 1) for p in parts}, "outline_area": round(outl.area, 1)}, ensure_ascii=False))
