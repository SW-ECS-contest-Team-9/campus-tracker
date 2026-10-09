# 사용자 S-MAP 사진(2026-10-10) 표본값 ↔ 좌표 대응, 운동장 패치 z 보강(검토용), 은주2관 상·하부 독립 표면 대조.
# 표본 좌표는 S-MAP 3D 뷰어(읽기 전용)에서 얻었다. 사진6: 같은 시점 재현 후 핀 하단 화면 위치 역투영(±3 m).
# 사진8: 핀 값과 같은 메시 z(±0.15~0.2 m) 셀 중 시각 예상 위치에 가장 가까운 셀(2 m 격자, 해시 cc3f122e). 예상 위치와 거리 d를 오차로 보고.
# 사진9: 2 m 격자(해시 2235d3e5)에서 지형 메시의 평탄 연결 성분(상부 130.0~132.6, 이웃 |dz|<=0.3; 하부 108.5~112.0, |dz|<=0.6) 볼록 껍질.
# 사용법: smap_photo_samples.py <field-structure-patch.json> <roads-live-2.json> <building-outlines-5186.json> <terrain-grid-meta.json> <terrain-grid.f32> <출력 폴더> <미리보기 data 폴더>
import json, sys, os, math, struct, copy, shutil
from shapely.geometry import Point, LineString, Polygon
if len(sys.argv) != 8: sys.exit("사용법: smap_photo_samples.py <patch.json> <roads-live-2.json> <building-outlines.json> <terrain-grid-meta.json> <terrain-grid.f32> <출력 폴더> <미리보기 data 폴더>")
PP, RP, OP, MP, GP, OUT, PD = sys.argv[1:]
S = [  # id, 사진, 화면값, 표면 분류, 대응 xy, 메시 z, 대응 방법, 오차 m
 ("P6-151.3", "사진-6", 151.3, "높은 가장자리(벽 위 띠)", (201172.5, 557306.0), 151.5, "시점 재현 역투영", 3.0),
 ("P6-151.6", "사진-6", 151.6, "높은 가장자리(벽 위 띠)", (201183.0, 557302.7), 151.9, "시점 재현 역투영", 3.0),
 ("P6-148.9a", "사진-6", 148.9, "운동장", (201176.0, 557297.4), 148.86, "시점 재현 역투영", 3.0),
 ("P6-148.9b", "사진-6", 148.9, "운동장", (201183.8, 557292.2), 148.9, "시점 재현 역투영", 3.0),
 ("P8-141.4", "사진-8", 141.4, "사잇길(낮은 길)", (201118, 557312), 141.3, "z 일치 최근접", 15.0),
 ("P8-141.9", "사진-8", 141.9, "사잇길(낮은 길)", (201134, 557302), 141.9, "z 일치 최근접", 15.2),
 ("P8-144.2", "사진-8", 144.2, "문예관 쪽 면", (201120, 557322), 144.2, "z 일치 최근접", 6.0),
 ("P8-145.4", "사진-8", 145.4, "대일관 벽 앞 면", (201134, 557324), 145.4, "z 일치 최근접", 3.0),
 ("P8-144.9", "사진-8", 144.9, "화단/경계", (201128, 557316), 145.0, "z 일치 최근접", 17.0),
 ("P8-150.2", "사진-8", 150.2, "높은 대일관 측", (201166, 557306), 150.1, "z 일치 최근접", 8.5),
 ("P8-149.3", "사진-8", 149.3, "높은 대일관 측", (201168, 557304), 149.4, "z 일치 최근접", 2.0),
 ("P8-148.1", "사진-8", 148.1, "높은 대일관 측", (201144, 557306), 148.2, "z 일치 최근접", 18.1),
 ("P8-148.9", "사진-8", 148.9, "운동장", (201170, 557296), 148.9, "z 일치 최근접", 0.0),
]
UNMAPPED = [("P2-4 Start 131.3", "사진-2~4", 131.3, "측정선 시작. 화면 위치만 있고 대응 좌표 미확정(중복 z 위치 다수)"),
            ("P2-4 End 148.8", "사진-2~4", 148.8, "측정선 끝. 운동장 북서 모서리 부근(추정), 좌표 미확정"),
            ("P2-4 커서 138.6", "사진-2~4", 138.6, "그래프 커서 값. 위치 미확정")]
UPPER9 = {"n": 683, "z": [131.5, 132.1, 132.6], "hull": [[201110, 557186], [201118, 557170], [201142, 557130], [201150, 557122], [201168, 557122], [201178, 557130], [201186, 557138], [201186, 557142], [201168, 557164], [201134, 557196], [201130, 557198], [201126, 557198], [201120, 557196], [201110, 557190]]}
LOWER9 = [{"n": 41, "z": [108.5, 109.1, 111.7], "hull": [[201096, 557170], [201098, 557164], [201104, 557160], [201106, 557160], [201106, 557166], [201098, 557188], [201096, 557190]]},
          {"n": 10, "z": [109.7, 110.1, 110.5], "hull": [[201156, 557092], [201158, 557090], [201162, 557090], [201162, 557094], [201158, 557094]]}]
patch = json.load(open(PP, encoding="utf-8")); p2 = copy.deepcopy(patch)
R = json.load(open(RP, encoding="utf-8")); R = R["items"] if isinstance(R, dict) else R
outl = {b["name"]: Polygon(b["coordinates"][0][0]) for b in json.load(open(OP, encoding="utf-8"))}
meta = json.load(open(MP)); W, H, ox, oy, rs = meta["width"], meta["height"], meta["originX"], meta["originY"], meta["resolution"]
grid = struct.unpack("<%df" % (W * H), open(GP, "rb").read())
def dem(x, y):
    fx, fy = (x - ox) / rs - 0.5, (y - oy) / rs - 0.5; i, j = int(math.floor(fx)), int(math.floor(fy)); tx, ty = fx - i, fy - j
    v = lambda a, b: grid[b * W + a]
    return round(v(i, j) * (1 - tx) * (1 - ty) + v(i + 1, j) * tx * (1 - ty) + v(i, j + 1) * (1 - tx) * ty + v(i + 1, j + 1) * tx * ty, 2)
# 1) NEW-A1에 z 부여: 높은 가장자리 표본이 A1 선에서 3 m 이내일 때만 그 지점에 정점 삽입
TOL = 3.0
a1 = next(o for o in p2["ops"] if o.get("id") == "NEW-A1"); L1 = LineString(a1["coordinates_xy"])
assigned = []
for sid, ph, val, surf, xy, mz, how, err in S:
    if surf != "높은 가장자리(벽 위 띠)": continue
    d = L1.distance(Point(xy))
    if d <= TOL:
        s = L1.project(Point(xy)); q = L1.interpolate(s); assigned.append({"object": "NEW-A1", "at_xy": [round(q.x, 2), round(q.y, 2)], "z": val, "sample": sid, "sample_xy": xy, "dist_m": round(d, 2)})
a1["z_points"] = assigned
a1["z_rule"] = "표본(사진 화면값)이 선에서 3 m 이내인 지점에만 z. 나머지 구간 null. 표본 사이 보간 안 함"
p2["revision"] = "2026-10-10 사용자 S-MAP 사진 표본 반영(z 출처 표시)"
p2["samples"] = [{"id": s[0], "photo": s[1], "value": s[2], "surface": s[3], "xy": s[4], "mesh_z": s[5], "method": s[6], "err_m": s[7], "dem2015": dem(*s[4])} for s in S]
p2["samples_unmapped"] = [{"id": a, "photo": b, "value": c, "note": d} for a, b, c, d in UNMAPPED]
# 2) 사진8 표면 분리 정보(패치 객체에는 z 없음; NEW-A14 양 끝은 기존 z 유지)
surfaces = {}
for s in p2["samples"]: surfaces.setdefault(s["surface"], []).append(s["id"])
p2["surfaces_separate"] = {"rule": "서로 다른 표면(사잇길·화단·벽 앞·문예관 쪽·높은 대일관 측·운동장) 표본을 한 선/면으로 잇거나 보간하지 않음", "groups": surfaces}
# 3) 은주2관 사진9: 상부·하부 독립 표면
up = Polygon(UPPER9["hull"]); lows = [Polygon(l["hull"]) for l in LOWER9]
def ov(poly): return {n: round(poly.intersection(p).area / poly.area, 3) for n, p in outl.items() if poly.intersects(p) and poly.intersection(p).area > 1}
def roads_in(poly, tol=2.0):
    out = []
    for r in R:
        c = r.get("coordinates") or []
        if len(c) >= 2 and LineString([(q[0], q[1]) for q in c]).distance(poly) <= tol: out.append({"id": r["id"][:8], "name": r.get("name"), "z": [c[0][2], c[-1][2]]})
    return out
e9 = {"upper": {"smap_flat_cells": UPPER9["n"], "area_m2_hull": round(up.area, 1), "mesh_z_min_med_max": UPPER9["z"], "user_values": [131.2, 130.5, 132.0, 132.1, 132.2],
                "outline_overlap_share": ov(up), "dem2015_at_centroid": dem(*up.centroid.coords[0]), "roads_within_2m": roads_in(up), "hull": UPPER9["hull"]},
      "lower": [{"smap_flat_cells": l["n"], "mesh_z_min_med_max": l["z"], "outline_overlap_share": ov(Polygon(l["hull"])), "dem2015_at_centroid": dem(*Polygon(l["hull"]).centroid.coords[0]),
                 "roads_within_2m": roads_in(Polygon(l["hull"])), "hull": l["hull"]} for l in LOWER9],
      "user_lower_values": [111.3, 109.8, 109.8], "rule": "상부(약 131~132)와 하부(약 109~111)를 같은 면으로 평탄화·보간하지 않음. 은주관 외곽선 분할 안 함. 수평 쌍 좌표가 없어 차이를 벽 높이로 쓰지 않음"}
p2["enju2_photo9"] = e9
json.dump(p2, open(os.path.join(OUT, "field-structure-patch-v2.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
# 미리보기 데이터(표본 점 + 표면 껍질 + A1 z 지점)
pv = {"type": "FeatureCollection", "name": "user-smap-samples-20261010", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}}, "features":
      [{"type": "Feature", "properties": {"id": s["id"], "surface": s["surface"], "value": s["value"], "err_m": s["err_m"], "accuracyVerified": False}, "geometry": {"type": "Point", "coordinates": [*s["xy"], s["value"]]}} for s in p2["samples"]] +
      [{"type": "Feature", "properties": {"id": "E9-upper", "surface": "은주2관 앞 상부(독립)", "value": UPPER9["z"][1], "accuracyVerified": False}, "geometry": {"type": "Polygon", "coordinates": [[[*p, UPPER9["z"][1]] for p in UPPER9["hull"] + [UPPER9["hull"][0]]]]}}] +
      [{"type": "Feature", "properties": {"id": f"E9-lower-{k}", "surface": "하부 도로(독립)", "value": l["z"][1], "accuracyVerified": False}, "geometry": {"type": "Polygon", "coordinates": [[[*p, l["z"][1]] for p in l["hull"] + [l["hull"][0]]]]}} for k, l in enumerate(LOWER9)]}
json.dump(pv, open(os.path.join(OUT, "user-smap-samples-5186.geojson"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
shutil.copy(os.path.join(OUT, "user-smap-samples-5186.geojson"), os.path.join(PD, "user-smap-samples-5186.geojson"))
# 검사
Lc = []
def chk(n, c, t=""): Lc.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
vals = {s[0]: s[2] for s in S}
chk("부여된 z가 모두 표본 화면값과 같고 표본 id를 가짐", all(a["z"] == vals[a["sample"]] for a in assigned), json.dumps(assigned, ensure_ascii=False))
chk("z 부여는 높은 가장자리 표본만(다른 표면 표본 사용 안 함)", all(dict((s[0], s[3]) for s in S)[a["sample"]] == "높은 가장자리(벽 위 띠)" for a in assigned))
chk("NEW-A1 나머지 정점 z는 null(보간 없음)", a1.get("z") is None)
others = [o for o in p2["ops"] if o.get("op") == "add_road" and o.get("id") != "NEW-A1" and o.get("id") != "NEW-A14"]
chk("다른 새 객체 z 변화 없음(null 유지)", all(o.get("z") is None and "z_points" not in o for o in others))
a14o = next(o for o in p2["ops"] if o.get("id") == "NEW-A14"); a14p = next(o for o in patch["ops"] if o.get("id") == "NEW-A14")
chk("NEW-A14 기존 z 유지", a14o["z_ends_from_existing"] == a14p["z_ends_from_existing"])
field = [s for s in S if s[3] == "운동장" and s[1] == "사진-6"]
for a in assigned:
    near_f = min(field, key=lambda s: math.dist(s[4], a["sample_xy"]))
    chk(f"부등식 '높은 길 ≥ 운동장+2m' ({a['sample']} vs {near_f[0]})", a["z"] - near_f[2] >= 2.0, f"{a['z']} − {near_f[2]} = {a['z'] - near_f[2]:.1f}")
chk("은주2관 상부·하부 표면이 겹치지 않음(독립)", all(not up.intersects(l) for l in lows))
chk("은주2관 상부·하부 사이 보간 객체 없음", not any("enju" in str(o).lower() for o in p2["ops"]))
for sid, ph, val, surf, xy, mz, how, err in S:
    if how == "z 일치 최근접" and err > 8: Lc.append(f"INFO 대응 약함 {sid} | 예상 위치와 {err} m — 미확정 표본")
Lc.append("INFO 은주2관 상부 | " + json.dumps({k: e9["upper"][k] for k in ("area_m2_hull", "mesh_z_min_med_max", "outline_overlap_share", "dem2015_at_centroid", "roads_within_2m")}, ensure_ascii=False))
Lc.append("INFO 은주2관 하부 | " + json.dumps([{k: l[k] for k in ("mesh_z_min_med_max", "outline_overlap_share", "dem2015_at_centroid", "roads_within_2m")} for l in e9["lower"]], ensure_ascii=False))
open(os.path.join(OUT, "smap-photo-checks.txt"), "w", encoding="utf-8").write("\n".join(Lc) + "\n"); print("\n".join(Lc))
sys.exit(1 if any(l.startswith("FAIL") for l in Lc) else 0)
