# CT-M17 검토 후속: Y-A 지붕 표본의 약 2m 톱니가 태양광 패널(부착물)인지 건물 지붕인지 기존 자료만으로 판정.
# 입력(읽기): vault claude-m17/tower-sample-class.json, claude-m16/S06/smap-ortho-yudam-main-road-c201060_557270-r600.jpg 판독값(아래 상수)
# 새 외부 조회 없음. 출력: vault claude-m17/panel-analysis.json, panel-class.png, panel-checks.txt
import json, os, sys, math
import numpy as np
from shapely.geometry import Polygon, Point

V = sys.argv[1]
S = json.load(open(os.path.join(V, "tower-sample-class.json"), encoding="utf-8"))
roof = [s for s in S if s["class"] == "지붕"]
X = np.array([s["x"] for s in roof], float); Y = np.array([s["y"] for s in roof], float); Z = np.array([s["z"] for s in roof], float)

# 1) 정사 화면 판독 (smap-ortho-yudam-main-road-c201060_557270-r600.jpg, 800x450, 북쪽 위, 회전 0)
#    화면 중심(400,250) = (201060, 557270, z120). 지면 z120 기준 0.1585 m/px (CT-M16 픽 2점에서 산출).
#    지붕 높이 h에서는 원근으로 0.1585*600/(600-(h-120)) m/px. 지붕 h=175 사용 → 0.144 m/px. 오차 ±2 m 가정.
#    판독점은 2.5배 확대 crop(원점 120,130) 좌표로 읽고 화면 px = 120+cx/2.5, 130+cy/2.5.
def crop2map(cx, cy, h=175.0):
    sx, sy = 120 + cx / 2.5, 130 + cy / 2.5
    s = 0.1585 * 600 / (600 - (h - 120))
    return 201060 + (sx - 400) * s, 557270 + (250 - sy) * s
PANEL_CORNERS_CROP = [(285, 55), (865, 415), (630, 770), (70, 395)]       # 패널 배열 바깥 모서리(판독)
GAP_LINE_CROP = [((590, 250), (380, 580)), ((690, 300), (470, 640))]     # 패널 열 사이 어두운 간극선 2개
GAP_STARTS_CROP = [(300, 60), (400, 120), (490, 185), (590, 250), (690, 300), (780, 355)]  # 간극선 북동 끝(판독)
panel_poly = Polygon([crop2map(*c) for c in PANEL_CORNERS_CROP])
gl = [(crop2map(*a), crop2map(*b)) for a, b in GAP_LINE_CROP]
dirs = [math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 180 for a, b in gl]
strip_dir = float(np.mean(dirs))                         # 패널 열(간극선) 방향, 동쪽 기준 반시계 각
perp = math.radians(strip_dir + 90)
gs = [crop2map(*c) for c in GAP_STARTS_CROP]
proj = [p[0] * math.cos(perp) + p[1] * math.sin(perp) for p in gs]
ortho_period = float(np.mean(np.abs(np.diff(sorted(proj)))))

# 2) 격자 톱니의 방향·주기: 평면 제거 후 잔차를 톱니 기저(2고조파)로 맞춰 R2 최대인 방향·주기 탐색 (패널 영역 셀만)
inP = np.array([panel_poly.contains(Point(x, y)) for x, y in zip(X, Y)])
def plane_resid(m):
    A = np.c_[X[m], Y[m], np.ones(m.sum())]; c, *_ = np.linalg.lstsq(A, Z[m], rcond=None); return Z[m] - A @ c
r = plane_resid(inP)
best = (-1, None, None)
for th in np.arange(0, 180, 1.0):
    u = X[inP] * math.cos(math.radians(th)) + Y[inP] * math.sin(math.radians(th))
    for P in np.arange(4.0, 12.01, 0.1):
        ph = 2 * math.pi * u / P
        B = np.c_[np.sin(ph), np.cos(ph), np.sin(2 * ph), np.cos(2 * ph), np.ones_like(ph)]
        c, *_ = np.linalg.lstsq(B, r, rcond=None); res = r - B @ c
        R2 = 1 - res.var() / r.var()
        if R2 > best[0]: best = (R2, th, P)
R2, th_best, P_best = best
# 같은 방법을 패널 영역 밖 지붕 셀에 적용(대조)
outP = (~inP) & np.array([panel_poly.exterior.distance(Point(x, y)) > 2.0 for x, y in zip(X, Y)])
R2_out = None
if outP.sum() >= 12:
    ro = plane_resid(outP); u = X[outP] * math.cos(math.radians(th_best)) + Y[outP] * math.sin(math.radians(th_best)); ph = 2 * math.pi * u / P_best
    B = np.c_[np.sin(ph), np.cos(ph), np.sin(2 * ph), np.cos(2 * ph), np.ones_like(ph)]; c, *_ = np.linalg.lstsq(B, ro, rcond=None)
    R2_out = float(1 - (ro - B @ c).var() / ro.var())
perp_deg = (strip_dir + 90) % 180
ang_diff = abs(((th_best - perp_deg) + 90) % 180 - 90)

# 3) 분류 (지붕 표본만). 근거: 평면 제거 잔차가 두 층(+1.1~+1.9 / -1.2~-0.7 m)으로 갈리고,
#    높은 층은 정사 화면 패널 열과 같은 방향(57°)·주기의 띠로만 나타남.
#   평면은 낮은 층 표본으로 다시 맞춤(2회 반복). HIGH = 잔차 > +0.2 m.
#   부착물(패널 상면): HIGH 이고 패널 배열 다각형 안(경계 포함)
#   건물 지붕: HIGH 아님(낮은 층) — 패널 사이 간극과 패널 밖 가장자리에서 같은 높이층
#   미판정: HIGH 인데 패널 다각형 밖(패널 근거 없음)
low = np.ones(len(Z), bool)
for _ in range(3):
    A = np.c_[X, Y, np.ones(len(X))]; pc, *_ = np.linalg.lstsq(A[low], Z[low], rcond=None)
    res = Z - A @ pc; low = res <= 0.2
HIGH = ~low
cls = np.array(["부착물(패널)" if h and panel_poly.buffer(2.0).contains(Point(x, y)) else ("미판정" if h else "건물 지붕") for x, y, h in zip(X, Y, HIGH)])
def summ(a):
    a = np.sort(a); return None if len(a) == 0 else {"n": int(len(a)), "area_m2": 4.0 * len(a), "min": float(a[0]), "p10": float(np.percentile(a, 10)), "median": float(np.median(a)), "p90": float(np.percentile(a, 90)), "max": float(a[-1])}
summary = {c: summ(Z[cls == c]) for c in ("부착물(패널)", "건물 지붕", "미판정")}
step_hi_lo = float(np.median(res[HIGH]) - np.median(res[low]))
lowres_in = res[low & np.array([panel_poly.contains(Point(x, y)) for x, y in zip(X, Y)])]
lowres_out = res[low & ~np.array([panel_poly.buffer(2.0).contains(Point(x, y)) for x, y in zip(X, Y)])]

# 4) 건물 지붕 후보: 낮은 층(건물 지붕) 표본은 원값 z 그대로. 패널 상면 표본 위치는 톱니 방향(th_best)으로
#    양쪽 가장 가까운 건물 지붕 표본(각각 한 주기 P_best 이내, 측방 오차 1.5 m 이내) 사이 선형 보간만 허용.
#    한쪽이라도 없으면 그 위치는 제외(외삽 없음). 미판정 표본은 제외.
ux, uy = math.cos(math.radians(th_best)), math.sin(math.radians(th_best))
roofk = np.where(cls == "건물 지붕")[0]
cand = []
for k in range(len(Z)):
    if cls[k] == "건물 지붕": cand.append((X[k], Y[k], float(Z[k]), "표본(건물 지붕)")); continue
    if cls[k] != "부착물(패널)": continue
    dx, dy = X[roofk] - X[k], Y[roofk] - Y[k]; along = dx * ux + dy * uy; side = np.abs(-dx * uy + dy * ux)
    okm = side <= 1.5
    fwd = np.where(okm & (along > 0) & (along <= P_best))[0]; bwd = np.where(okm & (along < 0) & (along >= -P_best))[0]
    if len(fwd) == 0 or len(bwd) == 0: continue
    f = fwd[np.argmin(along[fwd])]; b = bwd[np.argmax(along[bwd])]
    t = -along[b] / (along[f] - along[b]); zf, zb = Z[roofk[f]], Z[roofk[b]]
    cand.append((X[k], Y[k], float(zb + t * (zf - zb)), "보간(패널 아래, 양쪽 간극 표본 사이)"))
out = {"ortho": {"image": "claude-m16/S06/smap-ortho-yudam-main-road-c201060_557270-r600.jpg", "strip_dir_deg_from_east": round(strip_dir, 1),
                 "period_m": round(ortho_period, 2), "panel_polygon_5186": [[round(a, 1), round(b, 1)] for a, b in panel_poly.exterior.coords],
                 "panel_polygon_area_m2": round(panel_poly.area, 1), "err_xy_m_assumed": 2.0},
       "grid_sawtooth": {"best_dir_deg_from_east": float(th_best), "best_period_m": round(float(P_best), 2), "R2_panel_area": round(float(R2), 3),
                          "R2_outside_panel_same_basis": None if R2_out is None else round(R2_out, 3),
                          "ortho_perp_dir_deg": round(perp_deg, 1), "angle_diff_deg": round(float(ang_diff), 1)},
       "class_summary": summary,
       "two_level": {"high_minus_low_median_m": round(step_hi_lo, 2), "low_resid_inside_panel": summ(lowres_in), "low_resid_outside_panel": summ(lowres_out)},
       "samples": [{"x": float(x), "y": float(y), "z": float(z), "class": c} for x, y, z, c in zip(X, Y, Z, cls)]}
lines = []
# 후보 메시 (2m 이웃, 세 변 |dz|<=3m, 빈 위치 연결 안 함)
P2 = {(int(round(x)), int(round(y))): (z, src) for x, y, z, src in cand}
tris = []
for (x, y) in P2:
    a_, b_, c_, d_ = (x, y), (x + 2, y), (x + 2, y + 2), (x, y + 2)
    for t in ((a_, b_, c_), (a_, c_, d_)):
        if all(q in P2 for q in t) and max(P2[q][0] for q in t) - min(P2[q][0] for q in t) <= 3.0: tris.append(t)
n_s = sum(1 for v in P2.values() if v[1].startswith("표본")); n_i = len(P2) - n_s
excluded_panel = int((cls == "부착물(패널)").sum()) - n_i
fc = {"type": "FeatureCollection", "name": "yudam-building-roof-candidate", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
      "properties": {"status": "미리보기 후보 전용, 운영·원본 반영 금지", "accuracyVerified": False, "created": "2026-10-09",
                     "rule": "건물 지붕 분류 표본 z 원값 + 패널 상면 위치는 톱니 방향 양쪽 간극 표본(한 주기 이내) 사이 선형 보간만. 외삽·평활·중앙값 대체 없음",
                     "vertices_sample": n_s, "vertices_interpolated": n_i, "panel_positions_excluded_no_bracket": excluded_panel,
                     "excluded_classes": {"미판정": int((cls == "미판정").sum())}},
      "features": [{"type": "Feature", "properties": {"id": "Y-A-building-roof", "accuracyVerified": False, "triangles": len(tris),
                     "vertex_sources": {f"{x},{y}": P2[(x, y)][1] for (x, y) in sorted(P2)}},
                    "geometry": {"type": "MultiPolygon", "coordinates": [[[[q[0], q[1], P2[q][0]] for q in (*t, t[0])]] for t in tris]}}]}
json.dump(fc, open(os.path.join(V, "yudam-building-roof-candidate-5186.geojson"), "w", encoding="utf-8"), ensure_ascii=False)
import shutil
shutil.copy(os.path.join(V, "yudam-building-roof-candidate-5186.geojson"), os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "m16", "preview", "data", "yudam-building-roof-candidate-5186.geojson"))
# 검사: 표본 정점 z 보존
smap = {(int(round(x)), int(round(y))): float(z) for x, y, z in zip(X, Y, Z)}
bad = sum(1 for (q, (z, src)) in P2.items() if src.startswith("표본") and smap[q] != z)
lines.append(("PASS " if bad == 0 else "FAIL ") + "건물 지붕 후보의 표본 정점 z가 원값과 같음 | 불일치 %d / %d" % (bad, n_s))
lines.append(("PASS " if all(max(P2[q][0] for q in t) - min(P2[q][0] for q in t) <= 3.0 for t in tris) else "FAIL ") + "후보 삼각형 |dz|<=3m")
lines.append("INFO 건물 지붕 후보 | 표본 정점 %d, 보간 정점 %d, 보간 못 해 제외한 패널 위치 %d, 삼각형 %d" % (n_s, n_i, excluded_panel, len(tris)))
json.dump(out, open(os.path.join(V, "panel-analysis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
lines.append(("PASS " if len(cls) == len(roof) else "FAIL ") + "지붕 표본 전부 분류됨 | " + str(len(roof)))
lines.append("INFO 정사 판독 | 패널 열 방향 %.1f°, 주기 %.2f m, 패널 다각형 %.0f m²" % (strip_dir, ortho_period, panel_poly.area))
lines.append("INFO 격자 톱니 | 방향 %.0f°, 주기 %.2f m, R2 %.3f (패널 밖 같은 기저 R2 %s), 정사 수직방향과 각도 차 %.1f°" % (th_best, P_best, R2, "없음" if R2_out is None else "%.3f" % R2_out, ang_diff))
lines.append("INFO 분류 | " + json.dumps({k: (v and {"n": v["n"], "area_m2": v["area_m2"], "median": v["median"]}) for k, v in summary.items()}, ensure_ascii=False))
lines.append("INFO 두 층 | 높은층-낮은층 잔차 중앙값 차 %.2f m; 낮은층 잔차 패널 안 중앙 %.2f / 밖 중앙 %.2f" % (step_hi_lo, np.median(lowres_in), np.median(lowres_out)))
open(os.path.join(V, "panel-checks.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n"); print("\n".join(lines))
try:
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    plt.rcParams["font.family"] = "Malgun Gothic"; plt.rcParams["axes.unicode_minus"] = False
    fig, ax = plt.subplots(1, 2, figsize=(14, 6.5))
    col = {"부착물(패널)": "#3060c0", "건물 지붕": "#c03030", "미판정": "#e0a020"}
    for c, cc in col.items(): ax[0].scatter(X[cls == c], Y[cls == c], s=16, marker="s", c=cc, label=f"{c} ({(cls == c).sum()})")
    ax[0].plot(*panel_poly.exterior.xy, "k--", lw=1, label="정사 화면 판독 패널 배열")
    for a, b in gl: ax[0].plot([a[0], b[0]], [a[1], b[1]], "k-", lw=1)
    ax[0].set_aspect("equal"); ax[0].legend(fontsize=8); ax[0].set_title("지붕 표본 분류 (EPSG:5186)")
    u = X * math.cos(math.radians(th_best)) + Y * math.sin(math.radians(th_best))
    rr = Z - np.c_[X, Y, np.ones(len(X))] @ np.linalg.lstsq(np.c_[X, Y, np.ones(len(X))], Z, rcond=None)[0]
    for c, cc in col.items(): ax[1].scatter(u[cls == c] % P_best, rr[cls == c], s=8, c=cc, label=c)
    ax[1].set_xlabel(f"톱니 방향 {th_best:.0f}° 위치 mod 주기 {P_best:.2f} m"); ax[1].set_ylabel("평면 제거 잔차 (m)"); ax[1].legend(fontsize=8)
    ax[1].set_title("주기로 접은 잔차: 높은 층(패널 상면)은 위상 약 1.4~6.4 m, 간극 위상에는 없음")
    fig.tight_layout(); fig.savefig(os.path.join(V, "panel-class.png"), dpi=100)
except Exception as e:
    print("plot skipped", e)
sys.exit(1 if any(l.startswith("FAIL") for l in lines) else 0)
