# 운동장 주변 표면 통합 데이터 v3 (scene 연결용 검토 데이터, 운영 미반영).
# 입력: smap-mesh-reads-v3.json(S-MAP 뷰어 표본), field-annotation-5186.geojson(사용자 주석 대응), field-structure-patch-v2.json(사진 표본),
#       building-outlines-5186.json, roads-live-2.json
# 출력: field-surfaces-v3.geojson, field-surfaces-v3-checks.txt
# 원칙: z는 S-MAP 표본/메시 읽기값만. 모르면 null + 추정 표시. 다른 표면·벽을 가로질러 보간하지 않는다. 표면·정점마다 출처 기록.
# 사용법: build_field_v3.py <mesh-reads.json> <annotation.geojson> <patch-v2.json> <building-outlines.json> <roads-live-2.json> <출력 폴더>
import json, sys, os, statistics
import numpy as np
from shapely.geometry import box, Polygon, Point, LineString, shape, mapping
from shapely.ops import unary_union
if len(sys.argv) != 7: sys.exit("사용법: build_field_v3.py <mesh-reads.json> <annotation.geojson> <patch-v2.json> <building-outlines.json> <roads-live-2.json> <출력 폴더>")
MR, AN, PV2, OL, RD, OUT = sys.argv[1:]
M = json.load(open(MR, encoding="utf-8")); A = {f["properties"]["id"]: f for f in json.load(open(AN, encoding="utf-8"))["features"]}
P2 = json.load(open(PV2, encoding="utf-8")); OUTL = {b["name"]: Polygon(b["coordinates"][0][0]) for b in json.load(open(OL, encoding="utf-8"))}
R = json.load(open(RD, encoding="utf-8")); R = R["items"] if isinstance(R, dict) else R
ROAD = {r["id"][:8]: r for r in R}
MESH = "S-MAP 3D 메시 표면 읽기(2026-10-10, 2 m 격자, smap-mesh-reads-v3.json)"
def cells_poly(cells, simp=0.5):
    u = unary_union([box(x - 1, y - 1, x + 1, y + 1) for x, y, *_ in cells]).simplify(simp, preserve_topology=True)
    return u
def big(g): return max(g.geoms, key=lambda p: p.area) if g.geom_type == "MultiPolygon" else g
def rings(g): return [g] if g.geom_type == "Polygon" else list(g.geoms)
def vz_nearest(poly, cells, key):  # 정점 z = 같은 표면 셀 중 가장 가까운 셀의 메시 z (다른 표면 셀은 쓰지 않음)
    arr = np.array([[c[0], c[1]] for c in cells]); out = []
    for ring in rings(poly):
        coords = []
        for x, y in ring.exterior.coords:
            d = np.hypot(arr[:, 0] - x, arr[:, 1] - y); k = int(d.argmin())
            coords.append({"x": round(x, 2), "y": round(y, 2), "z": cells[k][2], "z_src": f"{key} 셀 ({cells[k][0]},{cells[k][1]}) {MESH}", "dist_to_cell_m": round(float(d[k]), 2)})
        out.append(coords)
    return out
F = []
def add(fid, kind, geom, props, verts=None, z3=None):
    p = {"id": fid, "kind": kind, "accuracyVerified": False, **props}
    if verts is not None: p["vertices"] = verts
    if z3 is not None and geom.geom_type == "Polygon":
        g = {"type": "Polygon", "coordinates": [[[v["x"], v["y"], v["z"]] for v in verts[0]]]}
    else: g = mapping(geom)
    F.append({"type": "Feature", "properties": p, "geometry": g}); return geom
# 1 운동장 평지
rle = M["field_flat_component"]["rle_y_xranges"]; fc = []
for row in rle.split(";"):
    y, rs = row.split(":"); y = int(y)
    for r in rs.split(","):
        a, b = map(int, r.split("-")); fc += [(x, y) for x in range(a, b + 1, 2)]
field = big(cells_poly(fc, 0.8))
add("SF-FIELD", "운동장 평지", field, {"walkable": True, "z": 148.9, "z_src": "메시 |z-148.92|<=0.12 연결 성분 + 사용자 사진 표기 148.9/149.0", "area_m2": round(field.area, 1),
    "boundary_src": "S-MAP 메시 평탄 성분(사진15 경계와 교차 검증, 아래 INFO)", "z_mode": "surface"})
# 사진15 경계 호모그래피 교차 검증
H = M["photo15_homography"]; src = np.array([c[0] for c in H["ctrl_photo_px_to_smap_xy"]], float); dst = np.array([c[1] for c in H["ctrl_photo_px_to_smap_xy"]], float)
Am = []; bm = []
for (u, v), (x, y) in zip(src, dst):
    Am.append([u, v, 1, 0, 0, 0, -u * x, -v * x]); bm.append(x); Am.append([0, 0, 0, u, v, 1, -u * y, -v * y]); bm.append(y)
h, *_ = np.linalg.lstsq(np.array(Am), np.array(bm), rcond=None); Hm = np.append(h, 1).reshape(3, 3)
def hp(u, v): w = Hm @ [u, v, 1]; return (w[0] / w[2], w[1] / w[2])
ph15 = Polygon([hp(u, v) for u, v in H["polygon_px"]]).buffer(0)
ctrl_res = [float(np.hypot(*(np.array(hp(*s)) - d))) for s, d in zip(src, dst)]
add("REF-PHOTO15", "참고: 사진15 사용자 평지 경계(호모그래피 대응)", ph15, {"walkable": None, "z": None, "user_area_m2": 8058.8, "area_m2": round(ph15.area, 1),
    "src": "사진15 경계 화면 px → 코트 표식 5점 호모그래피(지면 평면 가정). 표식이 남서쪽에 몰려 북·동쪽 경계는 외삽", "ctrl_resid_m": [round(r, 2) for r in ctrl_res]})
# 2 높은 가장자리 띠(보행면) / 옹벽 / 화단
strip_cells = M["high_strip_cells"]; strip = big(cells_poly(strip_cells, 0.5))
add("SF-HIGH-STRIP", "높은 가장자리 띠(보행면 후보)", strip, {"walkable": True, "z_mode": "per_vertex", "z_src": MESH,
    "samples_in": [s["id"] for s in P2["samples"] if s["surface"].startswith("높은 가장자리")], "area_m2": round(strip.area, 1),
    "note": "사진14(125.0㎡는 치수 근거 아님)·사용자 주석 A1·사진6 151.3/151.6과 같은 띠. 메시상 벽 위 띠라 화단 상면과 완전 구분은 미확정(추정)"},
    vz_nearest(strip, strip_cells, "높은띠"), True)
wall_cells = M["wall_transition_cells"]; wall = big(cells_poly(wall_cells, 0.5)).difference(strip).difference(field)
add("SF-WALL", "옹벽·전이(수직면 성격, 보행면 아님)", wall, {"walkable": False, "z": None, "geometry_src": "전이 셀(149.1<z<150.8) 합집합에서 띠·평지 제외 " + MESH, "z_bottom_ref": 148.9, "z_top_ref": "SF-HIGH-STRIP 정점값",
    "note": "메시가 옹벽을 경사로 번지게 그림. 운동장 148.9와 띠 151.x 사이를 경사면으로 보간하지 않음", "area_m2": round(wall.area, 1)})
daeil = OUTL["대일관"]
planter = strip.buffer(4.0).difference(strip).difference(field).difference(wall).difference(daeil)
planter = Polygon() if planter.is_empty else big(planter.intersection(box(201148, 557296, 201214, 557320)))
add("SF-PLANTER", "화단(띠 북쪽, 수목)", planter, {"walkable": False, "z": None, "geometry_src": "높은 띠 북쪽 4 m 완충(대일관 외곽선 제외) — 범위 추정", "note": "수목에 가려 상면 z 미확정"})
# 3 대일관 돌출 지붕 / 출입 계단·참·광장
canopy_cells = M["daeil_canopy_cells"]; canopy = big(cells_poly(canopy_cells, 0.5))
cz = statistics.median([c[2] for c in canopy_cells if c[2] >= 157.5])
add("SF-DAEIL-CANOPY", "대일관 출입부 돌출 지붕(지붕, 보행면 아님)", canopy, {"walkable": False, "is_roof": True, "z": cz, "z_src": "건물 모델 셀 상단 중앙값(z>=157.5) " + MESH,
    "under_passage_open": True, "note": "사진13(46.8㎡는 치수 근거 아님). 지붕 아래 통로를 막는 압출 금지. 지붕 하단 높이 미확정"})
s01b = [(201151.93, 557309.04, 149.37), (201155.70, 557308.75, 149.95), (201159.81, 557307.42, 150.10), (201155.79, 557306.38, 149.08)]
plaza = Polygon([(x, y) for x, y, _ in s01b])
add("SF-DAEIL-ENTRY-PAVE", "대일관 출입부 앞 포장(지붕 아래 통로 포함)", plaza, {"walkable": True, "z_mode": "per_vertex", "z_src": "S01-B 뷰어 역투영 4점(2026-10-09)", "note": "범위는 4점 사각형(최소). 실제 포장 범위 미확정"},
    [[{"x": x, "y": y, "z": z, "z_src": "S01-B 역투영 픽"} for x, y, z in s01b + [s01b[0]]]], True)
for aid, fid, kind in (("A7", "ST-DAEIL-ENTRY", "대일관 진입로 계단"), ("A2", "ST-A2", "높은 길→운동장 하행 계단"), ("A3", "ST-A3", "광장→청운관 계단"), ("A5", "ST-CHEONGUN-DOWN", "청운관에서 내려오는 계단")):
    g = shape(A[aid]["geometry"])
    add(fid, kind + "(확인된 계단, 위치는 주석 대응 ±8 m)", g, {"walkable": True, "structure": "stairs", "z": None, "z_flag": "추정 필요(미확정)",
        "geometry_src": f"사용자 주석 {aid} (field-annotation-5186.geojson)", "steps": None, "width_m": None,
        "related_roads": [n["id"][:8] for n in json.load(open(os.path.join(os.path.dirname(AN), "field-annotation-match.json"), encoding="utf-8"))[aid]["near"][:4]]})
# 대일관 출구 옆 하행 계단(사진27 확정) = 기존 b14ac1da→00cd9c0f→2f206e6c 사슬 위치(주석 A12 띠)
chain = [ROAD[k] for k in ("b14ac1da", "00cd9c0f", "2f206e6c")]
ln = LineString([(p[0], p[1]) for r in chain for p in r["coordinates"]])
add("ST-DAEIL-EXIT-SIDE", "대일관 출구 옆 하행 계단·계단참(사진27 확정)", ln, {"walkable": True, "structure": "stairs+landing+stairs", "z": None, "z_flag": "운영 DRAFT z(145.8→143.8)는 S-MAP 근거 아님 → 미기재",
    "geometry_src": "운영 도로 b14ac1da·00cd9c0f·2f206e6c 선(폭 미확정)", "steps": None, "width_m": None})
a14 = next(o for o in P2["ops"] if o.get("id") == "NEW-A14")
add("ST-A14", "화단을 가로지르는 하행 계단(주석 A14)", LineString(a14["coordinates_xy"]), {"walkable": True, "structure": "stairs", "z": None,
    "z_flag": "패치 후보의 기존 운영 z(143.8→141.73)는 S-MAP 근거 아님 → 미기재", "geometry_src": "field-structure-patch NEW-A14", "steps": None})
# 4 청운관 돌출 지붕
cr = M["cheongun_roof_cells"]; croof = big(cells_poly(cr, 0.5))
add("SF-CHEONGUN-CANOPY", "청운관 전면 돌출 지붕(지붕, 별도 객체)", croof, {"walkable": False, "is_roof": True, "z": statistics.median([c[2] for c in cr]), "z_src": "건물 모델 셀 중앙값 " + MESH,
    "under_passage_open": True, "note": "사진16·23: 다층 열린 기둥·슬래브 + 큰 돌출 지붕. 하부 개방 공간·좌우 계단 유지. 기둥·슬래브 치수 미확정"})
# 5 사잇길 일대 연결 면(메시 통합면)
cc = M["corridor_cells"]; corr = cells_poly(cc, 0.5)
for n in ("한림관", "문예관", "대일관", "본관"): corr = corr.difference(OUTL[n])
corr = big(corr.difference(field).difference(strip).difference(wall))
add("SF-CORRIDOR", "사잇길 일대 통합면(차로·계단 보행띠·보도 미분리)", corr, {"walkable": True, "z_mode": "per_vertex", "z_src": MESH, "area_m2": round(corr.area, 1),
    "note": "사진10(865.4㎡ 선택 영역)·31: 차량 경사로/반복 계단형 보행띠/연속 보도가 별개 표면이나 XY 경계 미대응. 메시는 이를 매끈한 경사로 그리므로 계단 형상 아님(추정 면)",
    "sub_surfaces_unmapped": ["차량 경사로", "반복 계단·계단참 보행띠", "연속 보도", "사진11·12 연결면 67.7㎡/60.5㎡"]}, vz_nearest(corr, cc, "사잇길"), True)
# 6 은주2관 상부·하부(독립)
up = Polygon(M["enju2_upper_hull"]); add("SF-ENJU2-UPPER", "은주2관 앞 상부 운동 공간", up, {"walkable": True, "z": M["enju2_upper_z"][1], "z_range": M["enju2_upper_z"], "z_src": "메시 평탄 성분 중앙값; 사용자 130.5~132.2",
    "outline_note": "원천 '수인관' 외곽선 안. 은주관 외곽선 분할 안 함"})
for k, l in enumerate(M["enju2_lower"]):
    add(f"SF-ENJU2-LOWER-{k}", "하부 도로(독립)", Polygon(l["hull"]), {"walkable": True, "z": l["z"][1], "z_range": l["z"], "z_src": "메시 평탄 성분 중앙값; 사용자 109.8~111.3"})
fc_out = {"type": "FeatureCollection", "name": "field-surfaces-v3", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
          "properties": {"status": "scene 연결용 검토 데이터, 운영 DB·원본 미반영", "accuracyVerified": False, "created": "2026-10-10",
                         "rules": "z는 S-MAP 표본·메시 읽기값만; 미확정 null; 표면·벽을 가로지르는 보간 없음; 지붕은 보행면과 분리하고 아래 통로 개방"}, "features": F}
json.dump(fc_out, open(os.path.join(OUT, "field-surfaces-v3.geojson"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
# 검사
L = []
def chk(n, c, t=""): L.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
geo = {f["properties"]["id"]: shape(f["geometry"]) for f in F}
chk("모든 표면에 출처(z_src 또는 z_flag/geometry_src)", all(any(k in f["properties"] for k in ("z_src", "z_flag", "geometry_src", "src")) for f in F))
pv = [v for f in F for ring in f["properties"].get("vertices", []) for v in ring]
chk("정점 z마다 출처 기록", all(v.get("z_src") for v in pv), f"정점 {len(pv)}")
cs = {"높은띠": {(c[0], c[1]) for c in strip_cells}, "사잇길": {(c[0], c[1]) for c in cc}}
chk("정점 z가 자기 표면 셀에서만 옴(교차 보간 없음)", all((int(v["z_src"].split("(")[1].split(",")[0]), int(v["z_src"].split(",")[1].split(")")[0])) in cs[v["z_src"].split(" ")[0]] for v in pv if v["z_src"].split(" ")[0] in cs))
chk("운동장 평지가 높은 띠·옹벽과 겹치지 않음", geo["SF-FIELD"].intersection(geo["SF-HIGH-STRIP"]).area < 1.0 and geo["SF-FIELD"].intersection(geo["SF-WALL"]).area < 1.0,
    f"{geo['SF-FIELD'].intersection(geo['SF-HIGH-STRIP']).area:.2f} / {geo['SF-FIELD'].intersection(geo['SF-WALL']).area:.2f} m²")
chk("사잇길 통합면이 운동장·띠·옹벽·건물 외곽선과 겹치지 않음", all(geo["SF-CORRIDOR"].intersection(geo[k]).area < 1.0 for k in ("SF-FIELD", "SF-HIGH-STRIP", "SF-WALL")) and all(geo["SF-CORRIDOR"].intersection(OUTL[n]).area < 1.0 for n in ("한림관", "문예관", "대일관")))
pave_max = max(z for *_, z in s01b)
chk("대일관 돌출 지붕 아래 통로 개방(지붕 z − 아래 포장 최고 z ≥ 2.0 m)", cz - pave_max >= 2.0, f"{cz} − {pave_max} = {cz - pave_max:.1f}")
chk("지붕은 보행면 아님", all(not f["properties"]["walkable"] for f in F if f["properties"].get("is_roof")))
chk("은주2관 상·하부 독립(겹침 없음)", all(not geo["SF-ENJU2-UPPER"].intersects(geo[k]) for k in geo if k.startswith("SF-ENJU2-LOWER")))
st = [f for f in F if f["properties"]["id"].startswith("ST-")]
chk("계단 단수·폭·z를 만들지 않음", all(f["properties"].get("steps") is None and f["properties"].get("z") is None for f in st), f"계단 {len(st)}")
hi = [v["z"] for ring in next(f for f in F if f["properties"]["id"] == "SF-HIGH-STRIP")["properties"]["vertices"] for v in ring]
L.append(f"INFO 높은 띠 정점 중 운동장+2m(≥150.9) 이상 | {sum(1 for z in hi if z - 148.9 >= 2.0)}/{len(hi)} (나머지는 띠 가장자리 메시 번짐)")
L.append("INFO 운동장 평지 면적 | 메시 성분 %.1f m² (셀 %d × 4 = %d) vs 사용자 8058.8 m²; 사진15 호모그래피 경계 %.1f m², IoU %.3f, 기준점 잔차 %s m" % (
    field.area, len(fc), len(fc) * 4, ph15.area, field.intersection(ph15).area / field.union(ph15).area, [round(r, 2) for r in ctrl_res]))
known = [f["properties"]["id"] for f in F if f["properties"].get("z") is not None or f["properties"].get("z_mode") == "per_vertex"]
L.append("INFO z 있음 | " + ", ".join(known)); L.append("INFO z 없음(null) | " + ", ".join(f["properties"]["id"] for f in F if f["properties"]["id"] not in known))
open(os.path.join(OUT, "field-surfaces-v3-checks.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
try:
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    plt.rcParams["font.family"] = "Malgun Gothic"; plt.rcParams["axes.unicode_minus"] = False
    fig, ax = plt.subplots(figsize=(11, 11)); col = {"SF-FIELD": "#9bd18b", "SF-HIGH-STRIP": "#e05050", "SF-WALL": "#555", "SF-PLANTER": "#2e8b57", "SF-DAEIL-CANOPY": "#4060c0",
          "SF-DAEIL-ENTRY-PAVE": "#e0a020", "SF-CHEONGUN-CANOPY": "#4060c0", "SF-CORRIDOR": "#c8a0e0", "SF-ENJU2-UPPER": "#f0c060", "REF-PHOTO15": "none"}
    for n, p in OUTL.items():
        if p.intersects(box(201090, 557080, 201260, 557350)): ax.plot(*p.exterior.xy, color="0.7", lw=0.8); ax.text(*p.representative_point().coords[0], n, color="0.5", fontsize=8)
    for f in F:
        g = geo[f["properties"]["id"]]; fid = f["properties"]["id"]
        if g.geom_type in ("Polygon", "MultiPolygon"):
            for r in rings(g):
                if fid == "REF-PHOTO15": ax.plot(*r.exterior.xy, "k--", lw=1)
                else: ax.fill(*r.exterior.xy, color=col.get(fid, "#f0a0a0"), alpha=0.6, lw=0.5, ec="k")
        else: ax.plot(*g.xy, color="purple", lw=2.5)
        ax.text(*g.representative_point().coords[0], fid, fontsize=6)
    ax.set_xlim(201090, 201260); ax.set_ylim(557080, 557350); ax.set_aspect("equal"); ax.set_title("field-surfaces-v3 (점선=사진15 경계 대응, 보라=계단 선)")
    fig.savefig(os.path.join(OUT, "field-surfaces-v3.png"), dpi=100, bbox_inches="tight")
except Exception as e:
    print("plot skipped", e)
sys.exit(1 if any(l.startswith("FAIL") for l in L) else 0)
