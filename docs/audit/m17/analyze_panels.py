# CT-M17 검토 후속: Y-A 지붕 표본의 약 2m 톱니가 태양광 패널(부착물)인지 건물 지붕인지 기존 자료만으로 판정.
# 입력(읽기): vault claude-m17/tower-sample-class.json, claude-m17/ortho-camera-recovery.json(뷰어 역투영 기록)
# 새 외부 조회 없음. 출력: vault claude-m17/panel-analysis.json, panel-before-after.json, panel-class.png, panel-checks.txt,
#       yudam-building-roof-candidate-5186.geojson (+ preview data 사본)
#
# 3f53bb9 정정: 이전 crop2map은 화면 중심을 (400,250)으로, 축척을 0.1585*600/(600-(h-120)) = 0.1745 m/px로 썼다.
# 뷰어 재현 결과(ortho-camera-recovery.json): 눈 높이 720(=중심 z120 + range 600), 중심 투영점 화면 (406.25,243.75),
# 축척 z120 0.1599, z175 0.1452 m/px. 높은 면일수록 m/px가 작아지므로 이전 식은 방향이 반대였다.
# 이제 판독점 좌표는 식으로 계산하지 않고 뷰어의 getCoordinate3dFromPixel 역투영값을 그대로 쓴다.
import json, os, sys, math, shutil
import numpy as np
from shapely.geometry import Polygon, Point, LineString

if len(sys.argv) != 3: sys.exit("사용법: analyze_panels.py <m17 입출력 폴더> <미리보기 data 폴더>")
V, PREVIEW = sys.argv[1], sys.argv[2]
S = json.load(open(os.path.join(V, "tower-sample-class.json"), encoding="utf-8"))
CAM = json.load(open(os.path.join(V, "ortho-camera-recovery.json"), encoding="utf-8"))
roof = [s for s in S if s["class"] == "지붕"]
X = np.array([s["x"] for s in roof], float); Y = np.array([s["y"] for s in roof], float); Z = np.array([s["z"] for s in roof], float)
CLS_ALL = {(int(s["x"]), int(s["y"])): s["class"] for s in S}   # 타워 모델 셀 분류 (지붕/측벽·아래 표면/판독불가)
HOLE = Polygon([(201060, 557264), (201066, 557264), (201066, 557268), (201060, 557268)])  # 표면 후보 구멍(§8)

# ---- 판독점: 이전(잘못된 식) / 이후(뷰어 역투영)
def crop2map_old(cx, cy, h=175.0):
    sx, sy = 120 + cx / 2.5, 130 + cy / 2.5
    s = 0.1585 * 600 / (600 - (h - 120))
    return 201060 + (sx - 400) * s, 557270 + (250 - sy) * s
U = {tuple(p["crop"]): tuple(p["xyz"][:2]) for p in CAM["unprojected_read_points"]}
CORNERS = [(285, 55), (865, 415), (630, 770), (70, 395)]
GAPS = [((590, 250), (380, 580)), ((690, 300), (470, 640))]
STARTS = [(300, 60), (400, 120), (490, 185), (590, 250), (690, 300), (780, 355)]
def geom(f):
    poly = Polygon([f(*c) for c in CORNERS]); gl = [(f(*a), f(*b)) for a, b in GAPS]
    sd = float(np.mean([math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 180 for a, b in gl]))
    pr = math.radians(sd + 90); gs = [f(*c) for c in STARTS]
    per = float(np.mean(np.abs(np.diff(sorted(p[0] * math.cos(pr) + p[1] * math.sin(pr) for p in gs)))))
    return poly, gl, sd, per
OLD = geom(crop2map_old)
NEW = geom(lambda cx, cy: U[(cx, cy)])
corner_shift = [round(math.dist(crop2map_old(*c), U[c]), 2) for c in CORNERS]

# ---- 톱니 방향·주기 (패널 다각형 안 셀)
def plane_resid(m):
    A = np.c_[X[m], Y[m], np.ones(m.sum())]; c, *_ = np.linalg.lstsq(A, Z[m], rcond=None); return Z[m] - A @ c
def sawtooth(poly):
    inP = np.array([poly.contains(Point(x, y)) for x, y in zip(X, Y)]); r = plane_resid(inP); best = (-1, None, None)
    for th in np.arange(0, 180, 1.0):
        u = X[inP] * math.cos(math.radians(th)) + Y[inP] * math.sin(math.radians(th))
        for P in np.arange(4.0, 12.01, 0.1):
            ph = 2 * math.pi * u / P; B = np.c_[np.sin(ph), np.cos(ph), np.sin(2 * ph), np.cos(2 * ph), np.ones_like(ph)]
            c, *_ = np.linalg.lstsq(B, r, rcond=None); R2 = 1 - (r - B @ c).var() / r.var()
            if R2 > best[0]: best = (float(R2), float(th), float(P))
    return best

# ---- 분류. 가정: 잔차 임계 HI(기본 +0.2 m), 패널 다각형 여유 BUF(기본 2 m)
def classify(poly, HI=0.2, BUF=2.0):
    low = np.ones(len(Z), bool)
    for _ in range(3):
        A = np.c_[X, Y, np.ones(len(X))]; pc, *_ = np.linalg.lstsq(A[low], Z[low], rcond=None); res = Z - A @ pc; low = res <= HI
    pb = poly.buffer(BUF)
    cls = np.array(["부착물(패널)" if (not l) and pb.contains(Point(x, y)) else ("미판정" if not l else "건물 지붕") for x, y, l in zip(X, Y, low)])
    return cls, res

# ---- 건물 지붕 후보: 건물 지붕 표본 원값 + 패널 위치는 톱니 방향 양쪽 간극 표본 사이 선형 보간
def build(cls, th, P):
    ux, uy = math.cos(math.radians(th)), math.sin(math.radians(th))
    rk = np.where(cls == "건물 지붕")[0]; out = {}
    for k in range(len(Z)):
        key = (int(X[k]), int(Y[k]))
        if cls[k] == "건물 지붕": out[key] = {"z": float(Z[k]), "src": "표본(건물 지붕)"}; continue
        if cls[k] != "부착물(패널)": continue
        dx, dy = X[rk] - X[k], Y[rk] - Y[k]; al = dx * ux + dy * uy; sd = np.abs(-dx * uy + dy * ux); okm = sd <= 1.5
        fw = np.where(okm & (al > 0) & (al <= P))[0]; bw = np.where(okm & (al < 0) & (al >= -P))[0]
        if len(fw) == 0 or len(bw) == 0: continue
        f = rk[fw[np.argmin(al[fw])]]; b = rk[bw[np.argmax(al[bw])]]
        af, ab = al[fw].min(), al[bw].max(); t = float(-ab / (af - ab))
        out[key] = {"z": float(Z[b] + t * (Z[f] - Z[b])), "src": "보간(패널 아래, 양쪽 간극 표본 사이)",
                    "from": {"x": float(X[b]), "y": float(Y[b]), "z": float(Z[b])}, "to": {"x": float(X[f]), "y": float(Y[f]), "z": float(Z[f])}, "ratio_from_to": round(t, 4)}
    return out
def tris_of(P2):
    T = []
    for (x, y) in P2:
        a, b, c, d = (x, y), (x + 2, y), (x + 2, y + 2), (x, y + 2)
        for t in ((a, b, c), (a, c, d)):
            if all(q in P2 for q in t) and max(P2[q]["z"] for q in t) - min(P2[q]["z"] for q in t) <= 3.0: T.append(t)
    return T

# ---- 보간 선분이 금지 셀(미판정·측벽·판독불가·미취득·구멍)을 지나지 않는지
def crossing_violations(P2, cls):
    clsmap = {(int(x), int(y)): c for x, y, c in zip(X, Y, cls)}
    bad = []
    for key, v in P2.items():
        if "from" not in v: continue
        seg = LineString([(v["from"]["x"], v["from"]["y"]), (v["to"]["x"], v["to"]["y"])])
        for s in np.linspace(0, seg.length, max(2, int(seg.length / 0.25) + 1)):
            p = seg.interpolate(s); c = (int(round(p.x / 2) * 2), int(round(p.y / 2) * 2))
            tag = CLS_ALL.get(c)
            if tag is None: why = "미취득/모델 밖"
            elif tag != "지붕": why = tag
            elif clsmap.get(c) == "미판정": why = "미판정"
            elif HOLE.contains(Point(*c)): why = "구멍"
            else: continue
            bad.append({"vertex": key, "cell": c, "why": why}); break
    return bad

# ---- 실행: 이전 다각형 / 이후(검증) 다각형
R_old = sawtooth(OLD[0]); R_new = sawtooth(NEW[0])
cls_old, _ = classify(OLD[0]); cls_new, res = classify(NEW[0])
P_old = build(cls_old, R_old[1], R_old[2]); P_new = build(cls_new, R_new[1], R_new[2])
T_new = tris_of(P_new)
viol = crossing_violations(P_new, cls_new)
def cnt(c): return {k: int((c == k).sum()) for k in ("부착물(패널)", "건물 지붕", "미판정")}
changed = [{"x": float(x), "y": float(y), "before": a, "after": b} for x, y, a, b in zip(X, Y, cls_old, cls_new) if a != b]
common = set(P_old) & set(P_new)
dz = np.array([P_new[k]["z"] - P_old[k]["z"] for k in common])
# 가정 민감도
sens = {f"HI={hi},BUF={bf}": cnt(classify(NEW[0], hi, bf)[0]) for hi in (0.0, 0.2, 0.5) for bf in (0.0, 2.0, 4.0)}
ba = {"corner_shift_old_to_viewer_m": corner_shift,
      "old": {"strip_dir": round(OLD[2], 1), "period_m": round(OLD[3], 2), "poly_area_m2": round(OLD[0].area, 1), "sawtooth": R_old, "counts": cnt(cls_old), "candidate_vertices": len(P_old)},
      "new": {"strip_dir": round(NEW[2], 1), "period_m": round(NEW[3], 2), "poly_area_m2": round(NEW[0].area, 1), "sawtooth": R_new, "counts": cnt(cls_new), "candidate_vertices": len(P_new)},
      "changed_samples": changed,
      "surface_diff_common_vertices": {"n": int(len(dz)), "max_abs_m": round(float(np.abs(dz).max()), 3) if len(dz) else None, "n_changed_over_0.01m": int((np.abs(dz) > 0.01).sum())},
      "only_in_old": len(set(P_old) - set(P_new)), "only_in_new": len(set(P_new) - set(P_old)),
      "sensitivity_counts_new_poly": sens}
json.dump(ba, open(os.path.join(V, "panel-before-after.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

poly, gl, strip_dir, ortho_period = NEW; R2, th_best, P_best = R_new
perp_deg = (strip_dir + 90) % 180; ang_diff = abs(((th_best - perp_deg) + 90) % 180 - 90)
n_s = sum(1 for v in P_new.values() if "from" not in v); n_i = len(P_new) - n_s
fc = {"type": "FeatureCollection", "name": "yudam-building-roof-candidate", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
      "properties": {"status": "미리보기 후보 전용, 운영·원본 반영 금지", "accuracyVerified": False, "created": "2026-10-09", "revised": "3f53bb9 정정(뷰어 역투영 다각형)",
                     "rule": "건물 지붕 분류 표본 z 원값 + 패널 상면 위치는 톱니 방향 양쪽 간극 표본(한 주기 이내, 측방 1.5m) 사이 선형 보간만. 외삽·평활·중앙값 대체 없음",
                     "assumptions": {"residual_high_m": 0.2, "panel_polygon_buffer_m": 2.0, "note": "가정값. 민감도는 panel-before-after.json"},
                     "vertices_sample": n_s, "vertices_interpolated": n_i},
      "features": [{"type": "Feature", "properties": {"id": "Y-A-building-roof", "accuracyVerified": False, "triangles": len(T_new),
                     "vertices": [{"x": k[0], "y": k[1], **v} for k, v in sorted(P_new.items())]},
                    "geometry": {"type": "MultiPolygon", "coordinates": [[[[q[0], q[1], P_new[q]["z"]] for q in (*t, t[0])]] for t in T_new]}}]}
json.dump(fc, open(os.path.join(V, "yudam-building-roof-candidate-5186.geojson"), "w", encoding="utf-8"), ensure_ascii=False)
shutil.copy(os.path.join(V, "yudam-building-roof-candidate-5186.geojson"), os.path.join(PREVIEW, "yudam-building-roof-candidate-5186.geojson"))
json.dump({"ortho": {"source": "ortho-camera-recovery.json 역투영", "strip_dir_deg_from_east": round(strip_dir, 1), "period_m": round(ortho_period, 2),
                     "panel_polygon_5186": [[round(a, 2), round(b, 2)] for a, b in poly.exterior.coords], "panel_polygon_area_m2": round(poly.area, 1)},
           "grid_sawtooth": {"best_dir_deg_from_east": th_best, "best_period_m": round(P_best, 2), "R2_panel_area": round(R2, 3), "angle_diff_deg": round(ang_diff, 1)},
           "samples": [{"x": float(x), "y": float(y), "z": float(z), "resid": round(float(r), 3), "class": c} for x, y, z, r, c in zip(X, Y, Z, res, cls_new)]},
          open(os.path.join(V, "panel-analysis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)

smap = {(int(x), int(y)): float(z) for x, y, z in zip(X, Y, Z)}
L = []
def chk(n, c, t=""): L.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
def info(n, t): L.append("INFO " + n + " | " + t)
chk("지붕 표본 전부 분류됨", len(cls_new) == len(roof), str(len(roof)))
chk("판독점 12개 모두 뷰어 역투영 좌표 있음(유담관 모델 위)", all(tuple(c) in U for c in CORNERS + STARTS) and all(p["model"] == 172425217 for p in CAM["unprojected_read_points"]))
chk("건물 지붕 후보 표본 정점 z 원값 일치", all(P_new[k]["z"] == smap[k] for k, v in P_new.items() if "from" not in v), f"표본 {n_s}")
chk("보간 정점마다 양쪽 원천 표본 x,y,z와 비율 기록", all({"from", "to", "ratio_from_to"} <= set(v) for v in P_new.values() if v["src"].startswith("보간")), f"보간 {n_i}")
chk("보간 원천 표본이 실제 건물 지붕 표본과 일치", all(smap.get((int(v[s]["x"]), int(v[s]["y"]))) == v[s]["z"] for v in P_new.values() if "from" in v for s in ("from", "to")))
chk("보간 선분이 미판정·측벽·판독불가·미취득·구멍 셀을 지나지 않음", len(viol) == 0, f"위반 {len(viol)}" + ("" if not viol else " 예: " + json.dumps(viol[:3], ensure_ascii=False)))
chk("후보 삼각형 |dz|<=3m", all(max(P_new[q]["z"] for q in t) - min(P_new[q]["z"] for q in t) <= 3.0 for t in T_new))
info("카메라", "눈 z720(중심 z120+range600), 축척 z120 0.1599 / z175 0.1452 m/px, 중심 투영점 화면(406.25,243.75)")
info("판독 모서리 이동(이전 식→역투영) m", str(corner_shift))
info("정사(역투영)", "패널 열 방향 %.1f°, 주기 %.2f m, 다각형 %.0f m²" % (strip_dir, ortho_period, poly.area))
info("격자 톱니(새 다각형)", "방향 %.0f°, 주기 %.2f m, R2 %.3f, 정사 수직방향과 차 %.1f°" % (th_best, P_best, R2, ang_diff))
info("분류 이전→이후", json.dumps({"이전": cnt(cls_old), "이후": cnt(cls_new), "바뀐 표본": len(changed)}, ensure_ascii=False))
info("표면 차(공통 정점)", json.dumps(ba["surface_diff_common_vertices"], ensure_ascii=False) + f", 이전에만 {ba['only_in_old']}, 이후에만 {ba['only_in_new']}")
info("건물 지붕 후보", "표본 정점 %d, 보간 정점 %d, 삼각형 %d" % (n_s, n_i, len(T_new)))
open(os.path.join(V, "panel-checks.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
try:
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    plt.rcParams["font.family"] = "Malgun Gothic"; plt.rcParams["axes.unicode_minus"] = False
    fig, ax = plt.subplots(1, 2, figsize=(14, 6.5))
    col = {"부착물(패널)": "#3060c0", "건물 지붕": "#c03030", "미판정": "#e0a020"}
    for a, (cls_, pol, ttl) in zip(ax, ((cls_old, OLD[0], "이전(잘못된 축척 식)"), (cls_new, NEW[0], "이후(뷰어 역투영 다각형)"))):
        for c, cc in col.items(): a.scatter(X[cls_ == c], Y[cls_ == c], s=16, marker="s", c=cc, label=f"{c} ({(cls_ == c).sum()})")
        a.plot(*pol.exterior.xy, "k--", lw=1, label="패널 배열 판독 다각형")
        a.set_aspect("equal"); a.legend(fontsize=8); a.set_title(f"지붕 표본 분류 — {ttl}")
    fig.tight_layout(); fig.savefig(os.path.join(V, "panel-class.png"), dpi=100)
except Exception as e:
    print("plot skipped", e)
sys.exit(1 if any(l.startswith("FAIL") for l in L) else 0)
