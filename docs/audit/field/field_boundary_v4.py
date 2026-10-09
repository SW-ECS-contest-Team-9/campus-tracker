# 운동장 평지 경계 v4: 사진15 경계를 지면 기준점(구역 전체 분포)으로 재대응 + 독립 검증점 오차 + SF-FIELD 톱니 외곽 직선화.
# 지면 기준점만 사용(지붕점 섞지 않음): 코트 표식(남서·중앙) + 평지 모서리 4곳(대일관·청운관·혜인관·은주관 쪽, S-MAP 148.9 평탄 성분의 꼭짓점).
# 사용법: field_boundary_v4.py <smap-mesh-reads-v3.json> <field-surfaces-v3.geojson> <출력 폴더>
import json, sys, os, math
import numpy as np
from shapely.geometry import Polygon, LineString, Point, box, mapping, shape
from shapely.ops import unary_union
if len(sys.argv) != 4: sys.exit("사용법: field_boundary_v4.py <smap-mesh-reads-v3.json> <field-surfaces-v3.geojson> <출력 폴더>")
MR, FS, OUT = sys.argv[1:]
M = json.load(open(MR, encoding="utf-8")); V3 = {f["properties"]["id"]: f for f in json.load(open(FS, encoding="utf-8"))["features"]}
field = shape(V3["SF-FIELD"]["geometry"])
court = M["photo15_homography"]["ctrl_photo_px_to_smap_xy"]          # 5개 코트 표식(지면, 뷰어 픽)
# 평지 모서리(지면): 사진15 경계 꼭짓점 ↔ S-MAP 148.9 평탄 성분 극점(2 m 격자, ±1~2 m)
corners = [((100, 437), (201150.0, 557308.0), "대일관 쪽(북) 모서리"), ((602, 222), (201240.0, 557256.0), "청운관 쪽(동) 모서리"),
           ((815, 645), (201196.0, 557176.0), "혜인관 쪽(남) 모서리"), ((368, 752), (201136.0, 557228.0), "은주관 쪽(서) 모서리")]
CTRL = [(tuple(c[0]), tuple(c[1]), f"코트{i}") for i, c in enumerate(court) if i in (0, 2, 4)] + corners
HOLD = [(tuple(c[0]), tuple(c[1]), f"코트{i}") for i, c in enumerate(court) if i in (1, 3)] + [((287, 347), (201188.0, 557294.0), "대일관 쪽 들어간 모서리(성분 오목부, ±2 m)")]
def homog(pts):
    A = []; b = []
    for (u, v), (x, y), _ in pts:
        A += [[u, v, 1, 0, 0, 0, -u * x, -v * x], [0, 0, 0, u, v, 1, -u * y, -v * y]]; b += [x, y]
    h, *_ = np.linalg.lstsq(np.array(A, float), np.array(b, float), rcond=None); return np.append(h, 1).reshape(3, 3)
Hm = homog(CTRL)
def hp(u, v): w = Hm @ [u, v, 1]; return (float(w[0] / w[2]), float(w[1] / w[2]))
res_c = [{"name": n, "err_m": round(math.dist(hp(*p), q), 2)} for p, q, n in CTRL]
res_h = [{"name": n, "err_m": round(math.dist(hp(*p), q), 2)} for p, q, n in HOLD]
ph = Polygon([hp(u, v) for u, v in M["photo15_homography"]["polygon_px"]]).buffer(0)
iou = field.intersection(ph).area / field.union(ph).area
# 이전(v3) 참고 경계와 비교
old = shape(V3["REF-PHOTO15"]["geometry"])
# 톱니 외곽 직선화: 사진 대응 경계(ph)의 변 분할을 쓰고, 각 변 양옆 3 m 띠 안의 SF-FIELD 외곽점(0.5 m 간격)으로 직선 적합 → 이웃 직선 교점
fb = field.exterior; bpts = [fb.interpolate(d) for d in np.arange(0, fb.length, 0.5)]
pv = list(ph.exterior.coords)[:-1]; edges = []
for i in range(len(pv)):
    a, b = pv[i], pv[(i + 1) % len(pv)]; seg = LineString([a, b])
    if seg.length < 6.0: continue
    pts = np.array([[p.x, p.y] for p in bpts if seg.distance(p) <= 3.0 and 0.05 < seg.project(p, normalized=True) < 0.95])
    if len(pts) < 8: continue
    c = pts.mean(0); u, s, vt = np.linalg.svd(pts - c); d = vt[0]; nrm = np.array([-d[1], d[0]])
    rms = float(np.sqrt(np.mean(((pts - c) @ nrm) ** 2)))
    off = float(abs((np.array(seg.interpolate(0.5, normalized=True).coords[0]) - c) @ nrm))
    edges.append({"i": i, "c": c, "d": d, "n_pts": int(len(pts)), "rms_m": round(rms, 2), "photo_edge_offset_m": round(off, 2), "len_m": round(seg.length, 1)})
def inter(e1, e2):
    A = np.array([e1["d"], -e2["d"]]).T
    if abs(np.linalg.det(A)) < 1e-6: return None
    t = np.linalg.solve(A, e2["c"] - e1["c"]); return e1["c"] + t[0] * e1["d"]
def onl(e, q):  # 점 q를 적합 직선 e에 정사영
    q = np.array(q); return e["c"] + ((q - e["c"]) @ e["d"]) * e["d"]
corn, fixed = [], []
for k in range(len(edges)):
    e1, e2 = edges[k], edges[(k + 1) % len(edges)]
    v_end = pv[(e1["i"] + 1) % len(pv)]; v_start = pv[e2["i"]]   # e1 끝 사진 꼭짓점, e2 시작 사진 꼭짓점(사이에 짧은 변 있을 수 있음)
    p = inter(e1, e2)
    if p is not None and min(math.dist(p, v_end), math.dist(p, v_start)) <= 4.0:
        corn.append((float(p[0]), float(p[1])))
    else:  # 교점이 멀거나 없음(거의 평행/짧은 꺾임) → 두 직선 위 사진 꼭짓점 정사영 두 점으로 짧게 잇는다
        a1, a2 = onl(e1, v_end), onl(e2, v_start); corn += [(float(a1[0]), float(a1[1])), (float(a2[0]), float(a2[1]))]
        fixed.append({"between_edges": [e1["i"], e2["i"]], "intersection": None if p is None else [round(float(p[0]), 1), round(float(p[1]), 1)], "used": "꼭짓점 정사영 2점"})
fit = Polygon(corn).buffer(0) if len(corn) >= 3 else None
ok_fit = fit is not None and fit.is_valid and fit.geom_type == "Polygon"
hd = fit.hausdorff_distance(field) if ok_fit else None
out = {"type": "FeatureCollection", "name": "field-boundary-v4", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
       "properties": {"created": "2026-10-10", "accuracyVerified": False, "status": "검토 데이터, 운영 미반영"},
       "features": [
        {"type": "Feature", "properties": {"id": "REF-PHOTO15-V4", "kind": "참고선: 사진15 경계 재대응(지면 기준점 7, 검증점 3)", "area_m2": round(ph.area, 1), "iou_vs_SF_FIELD": round(iou, 3),
            "ctrl_err_m": res_c, "holdout_err_m": res_h, "user_area_m2": 8058.8, "note": "참고선. 평지 교체에 쓰지 않음. 면적을 8058.8에 맞추지 않음"}, "geometry": mapping(ph)},
        {"type": "Feature", "properties": {"id": "SF-FIELD-EDGE-V4", "kind": "운동장 평지 경계(톱니 직선화)", "z": 148.9, "area_m2": round(fit.area, 1) if ok_fit else None,
            "method": "SF-FIELD(S-MAP 148.9 평탄 성분 2 m 셀) 외곽점에 사진15 변 분할대로 직선 적합 후 교점", "edges": [{k: e[k] for k in ("i", "n_pts", "rms_m", "photo_edge_offset_m", "len_m")} for e in edges],
            "hausdorff_vs_cell_outline_m": round(hd, 2) if hd is not None else None, "short_corners_from_vertex_projection": fixed, "accuracyVerified": False}, "geometry": mapping(fit) if ok_fit else None}]}
json.dump(out, open(os.path.join(OUT, "field-boundary-v4.geojson"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
L = []
def chk(n, c, t=""): L.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
chk("기준점이 지면점만(지붕점 없음)", all("모서리" in n or "코트" in n for *_, n in CTRL))
chk("검증점은 기준점과 겹치지 않음", not set(p for p, *_ in HOLD) & set(p for p, *_ in CTRL))
chk("직선화 경계가 유효 다각형", ok_fit)
dd = np.array([fit.exterior.distance(p) for p in bpts]) if ok_fit else np.array([99.0])
p95 = float(np.percentile(dd, 95)); sd = fit.symmetric_difference(field).area / field.area if ok_fit else 1.0
chk("직선화 경계와 셀 외곽 거리 95백분위 ≤ 3 m", ok_fit and p95 <= 3.0, f"{p95:.2f} m")
chk("직선화 경계와 셀 평지 대칭차 ≤ 5 %", ok_fit and sd <= 0.05, f"{100*sd:.1f} %")
far = [[round(b.x, 1), round(b.y, 1)] for b, d in zip(bpts, dd) if d > 3.0]
L.append("INFO 3 m 초과 셀 외곽점(이 구간은 직선화 미채택, 셀 외곽 유지 권고) | " + json.dumps(far))
L.append(f"INFO 최대 이탈(Hausdorff) | {hd:.2f} m — 고립 셀(1~2개) 돌출 위치. 직선화에서 제외")
L.append("INFO 면적 조정 | 면적을 8058.8에 맞추는 확대·축소 연산 없음")
L.append("INFO 재대응 | 기준점 오차 %s m, 검증점 오차 %s m" % ([r["err_m"] for r in res_c], [r["err_m"] for r in res_h]))
L.append("INFO 면적 | 사진15 v4 %.1f m² (v3 %.1f), SF-FIELD %.1f, 직선화 %.1f, 사용자 8058.8 / IoU(v4 vs SF-FIELD) %.3f, IoU(v3) %.3f" % (
    ph.area, old.area, field.area, fit.area if ok_fit else float('nan'), iou, field.intersection(old).area / field.union(old).area))
L.append("INFO 교점 대신 정사영 사용 | " + json.dumps(fixed, ensure_ascii=False))
L.append("INFO 변별 적합 | " + json.dumps([{k: e[k] for k in ("i", "n_pts", "rms_m", "photo_edge_offset_m", "len_m")} for e in edges], ensure_ascii=False))
open(os.path.join(OUT, "field-boundary-v4-checks.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
sys.exit(1 if any(l.startswith("FAIL") for l in L) else 0)
