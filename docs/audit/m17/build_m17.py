# CT-M17 유담관 덩어리 분리 후보 작성 + 검사 (미리보기 전용).
# 입력(읽기): vault claude-m17/smap-surface-grid-2m.txt, smap-modelid-grid-2m.txt,
#            docs/audit/m17/yudam-gpkg.json (gpkg_yudam.py가 campus.gpkg 읽기 전용으로 추출, SHA 검증)
# 출력: vault claude-m17/yudam-split-candidates-5186.geojson, gpkg-vertex-check.json, checks.txt
#       preview 폴더 data/yudam-split-candidates-5186.geojson (복사)
import json, os, sys, statistics, shutil
from shapely.geometry import Polygon, box, Point, mapping
from shapely.ops import unary_union

if len(sys.argv) != 4: sys.exit("사용법: build_m17.py <m17 입출력 폴더> <yudam-gpkg.json> <미리보기 data 폴더>")
V, GPKG_JSON, PREVIEW = sys.argv[1], sys.argv[2], sys.argv[3]
NX, NY, X0, Y0, R = 52, 84, 200984, 557214, 2

z = [None] * (NX * NY)
for ln in open(os.path.join(V, "smap-surface-grid-2m.txt"), encoding="utf-8"):
    if ln.startswith("#") or not ln.strip(): continue
    j, sm, vals = ln.strip().split(":"); vals = [int(t) for t in vals.split(",")]
    assert len(vals) == NX and sum(vals) == int(sm), ("z checksum", j)
    for i, t in enumerate(vals): z[int(j) * NX + i] = t / 10 if t > 0 else None
mid = [None] * (NX * NY)
for ln in open(os.path.join(V, "smap-modelid-grid-2m.txt"), encoding="utf-8"):
    if ln.startswith("#") or not ln.strip(): continue
    j, s = ln.strip().split(":"); assert len(s) == NX, ("mid len", j)
    for i, ch in enumerate(s): mid[int(j) * NX + i] = ch
assert mid.count("Y") == 517 and mid.count("M") == 389 and mid.count("N") == 280, "model id counts differ from browser"

g = json.load(open(GPKG_JSON, encoding="utf-8"))
SHA = g["sha256"]; assert SHA == "26c66faa36bd03c3f7106d68ac8a2f8e0a89a452f7899e5b0f20ab0673b45d13"
ring = g["buildings_3d"][0][0]; attrs = g["attrs"]
GP = Polygon(ring); assert GP.is_valid

def cellbox(i, j): x, y = X0 + R * i, Y0 + R * j; return box(x - 1, y - 1, x + 1, y + 1)
def cells(pred): return [(i, j) for j in range(NY) for i in range(NX) if pred(i, j)]
def poly_of(cs, simplify=1.0):
    u = unary_union([cellbox(i, j) for i, j in cs]).simplify(simplify, preserve_topology=True)
    return max(u.geoms, key=lambda p: p.area) if u.geom_type == "MultiPolygon" else u

# A 타워: S-MAP 유담관 건물 모델 셀
A_cells = cells(lambda i, j: mid[j * NX + i] == "Y")
A = poly_of(A_cells)
# Y-A 표본 분류 (법선 정보 없음 → 표면 z와 이웃 z 차만 사용)
#  규칙: 이웃 = 4방향 중 같은 유담관 모델 셀. jump = 이웃과의 |dz| 최대값. edge = 4방향 중 유담관 모델 아닌 셀이 있음.
#   측벽·아래 표면: z < 150 (지붕 띠 160~183보다 10m 이상 낮음 = 벽면·지면 픽)
#   지붕: z >= 160 이고 jump <= 3.0 m (지붕 경사 2m당 0.3~0.5m 수준의 연속면)
#   판독불가: 나머지 (150~160, 또는 z>=160이나 이웃과 3m 넘게 끊김 — 경계 가장자리 혼합 픽)
SIDE_Z, ROOF_Z, JUMP = 150.0, 160.0, 3.0
Aset = set(A_cells)
def zc(i, j): return z[j * NX + i]
A_class = {}
for (i, j) in A_cells:
    v = zc(i, j)
    nb = [(i + d[0], j + d[1]) for d in ((1, 0), (-1, 0), (0, 1), (0, -1))]
    jumps = [abs(zc(*n) - v) for n in nb if n in Aset and zc(*n) is not None and v is not None]
    jump = max(jumps) if jumps else None
    edge = any(n not in Aset for n in nb)
    if v is None: c = "판독불가"
    elif v < SIDE_Z: c = "측벽·아래 표면"
    elif v >= ROOF_Z and jump is not None and jump <= JUMP: c = "지붕"
    else: c = "판독불가"
    A_class[(i, j)] = {"class": c, "z": v, "jump": jump, "edge": edge,
                       "dist_to_boundary_m": round(A.exterior.distance(Point(X0 + R * i, Y0 + R * j)), 1)}
def zs(cls): return sorted(d["z"] for d in A_class.values() if d["class"] == cls and d["z"] is not None)
A_z = zs("지붕")
def summ(a):
    if not a: return None
    q2 = lambda p: round(a[min(len(a) - 1, int(len(a) * p))], 1)
    return {"n": len(a), "min": a[0], "p10": q2(.1), "median": round(statistics.median(a), 1), "p90": q2(.9), "max": a[-1]}
CLASS_SUMMARY = {c: summ(zs(c)) | {"n_total": sum(1 for d in A_class.values() if d["class"] == c)} if zs(c) else {"n_total": sum(1 for d in A_class.values() if d["class"] == c)}
                 for c in ("지붕", "측벽·아래 표면", "판독불가")}
# B 평탄 데크: 지형 메시, 유담관 외곽선 안, z 128.8~129.4, 타워 서·남서쪽 연결 성분
def isB(i, j):
    v = z[j * NX + i]
    return mid[j * NX + i] == "." and v is not None and 128.8 <= v <= 129.4 and GP.contains(Point(X0 + R * i, Y0 + R * j))
B_all = cells(isB)
# 연결 성분 중 최대
seen, comps = set(), []
S = set(B_all)
for c in B_all:
    if c in seen: continue
    st, comp = [c], []
    seen.add(c)
    while st:
        a = st.pop(); comp.append(a)
        for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            b = (a[0] + d[0], a[1] + d[1])
            if b in S and b not in seen: seen.add(b); st.append(b)
    comps.append(comp)
B_cells = max(comps, key=len)
B = poly_of(B_cells).intersection(GP).difference(A)
if B.geom_type == "MultiPolygon": B = max(B.geoms, key=lambda p: p.area)
B_z = sorted(z[j * NX + i] for i, j in B_cells)
# C 보존: 원본 외곽선에서 A,B를 뺀 나머지 (확인 불가 구간, 축소 금지)
C = GP.difference(unary_union([A, B]))

def rnd(p): return [[round(x, 2), round(y, 2)] for x, y in p.exterior.coords]
def verts(p, src, exy):
    return [{"x": round(x, 2), "y": round(y, 2), "src": src, "err_xy_m_assumed": exy} for x, y in p.exterior.coords]

SRC_A = "S-MAP 3D getModelIdFromPixel=172425217(유담관 모델) 2m 셀 경계 합집합 후 1m 단순화 (2026-10-09)"
SRC_B = "S-MAP 3D 지형 메시 표면 z 128.8~129.4 평탄 셀(유담관 외곽선 안) 2m 셀 경계, 1m 단순화 (2026-10-09)"
SRC_C = "campus.gpkg buildings_3d fid=2 원본 외곽선에서 A·B를 뺀 나머지 (원본 정점 + A·B 경계)"
q = lambda a, p: round(a[int(len(a) * p) if p < 1 else -1], 1)
feats = [
 {"id": "Y-A", "part": "상부 타워(지붕 경사)", "geometry": A,
  "props": {"topZ_median": round(statistics.median(A_z), 1), "topZ_p10": q(A_z, .1), "topZ_p90": q(A_z, .9), "topZ_max": A_z[-1],
            "topZ_class": "지붕 분류 표본만 요약(측벽·아래 표면·판독불가 제외). 최소값은 지붕 높이로 쓰지 않음",
            "topZ_rule": "지붕: z>=160 이고 같은 모델 4방향 이웃과 |dz|<=3m; 측벽·아래: z<150; 나머지 판독불가",
            "sample_class_summary": CLASS_SUMMARY,
            "topZ_source": "S-MAP 메시 표면 z(지붕, 기울어진 면). 수평 지붕 아님", "baseZ": None,
            "baseZ_note": "미확정. 동측 도로 약118~124m, 서측 데크 129.1m, 서측 낮은 길 93~105m에 접해 하단이 일정하지 않음",
            "err_xy_m_assumed": 2.0, "err_z_m_assumed": 1.0},
  "verts": verts(A, SRC_A, 2.0)},
 {"id": "Y-B", "part": "서·남서 평탄 데크(가려진 저층부 지붕 또는 상부 광장 추정)", "geometry": B,
  "props": {"topZ_median": round(statistics.median(B_z), 1), "topZ_min": B_z[0], "topZ_max": B_z[-1],
            "topZ_source": "S-MAP 지형 메시 표면 z. S-MAP dem_z(D2 201040,557236)=115.8m보다 약13m 위", "baseZ": None,
            "baseZ_note": "미확정. 데크 아래 저층부 존재·층수 미확인(사진·도면 없음)", "err_xy_m_assumed": 2.0, "err_z_m_assumed": 0.5},
  "verts": verts(B, SRC_B, 2.0)},
 {"id": "Y-C", "part": "보존 구간(확인 불가, 원본 유지)", "geometry": C,
  "props": {"topZ_median": None, "baseZ": None, "note": "서측 띠(x≈200992~201010)는 S-MAP 지형 메시이며 표면 130~136m 불규칙(수목·사면 추정), 북측 일부는 회차공간 지면(129~131m, S-MAP dem과 일치). 건물 여부를 온라인으로 확정할 수 없어 원본 외곽선 보존",
            "err_xy_m_assumed": 0.0},
  "verts": None},
]
fc = {"type": "FeatureCollection", "name": "yudam-split-candidates",
      "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
      "properties": {"status": "미리보기 후보 전용, 운영·원본 반영 금지", "accuracyVerified": False, "created": "2026-10-09",
                     "source_gpkg_sha256": SHA, "source_feature": "buildings_3d fid=2 유담관",
                     "original_attrs": attrs, "register_height_applied_to_parts": False},
      "features": []}
for f in feats:
    geom = f["geometry"]
    p = {"id": f["id"], "part": f["part"], "accuracyVerified": False, "area_m2": round(geom.area, 1)}; p.update(f["props"])
    if f["verts"]: p["vertices"] = f["verts"]
    fc["features"].append({"type": "Feature", "properties": p, "geometry": mapping(geom)})
json.dump(fc, open(os.path.join(V, "yudam-split-candidates-5186.geojson"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
os.makedirs(PREVIEW, exist_ok=True)
shutil.copy(os.path.join(V, "yudam-split-candidates-5186.geojson"), os.path.join(PREVIEW, "yudam-split-candidates-5186.geojson"))

# GPKG 정점별 대조: 가장 가까운 격자 셀의 표면 z·모델, 타워 경계까지 거리
def nearest(x, y):
    i, j = round((x - X0) / R), round((y - Y0) / R)
    i, j = max(0, min(NX - 1, i)), max(0, min(NY - 1, j)); return i, j
vc = []
for k, (x, y) in enumerate(ring[:-1]):
    i, j = nearest(x, y); v = z[j * NX + i]; m = mid[j * NX + i]
    kind = "타워(유담관 모델)" if m == "Y" else ("다른 건물 모델" if m not in (".", "?") else ("데크 129.1" if v and 128.8 <= v <= 129.4 else "지형 메시"))
    vc.append({"vertex": k, "x": round(x, 2), "y": round(y, 2), "smap_surface_z": v, "smap_model": m, "kind": kind,
               "dist_to_tower_edge_m": round(A.exterior.distance(Point(x, y)), 1)})
json.dump(vc, open(os.path.join(V, "gpkg-vertex-check.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

json.dump([{"i": i, "j": j, "x": X0 + R * i, "y": Y0 + R * j, **d} for (i, j), d in sorted(A_class.items())],
          open(os.path.join(V, "tower-sample-class.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
try:
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    plt.rcParams["font.family"] = "Malgun Gothic"; plt.rcParams["axes.unicode_minus"] = False
    fig, ax = plt.subplots(1, 2, figsize=(13, 7))
    col = {"지붕": "#c03030", "측벽·아래 표면": "#3070c0", "판독불가": "#e0a020"}
    for c, cc in col.items():
        pts = [(X0 + R * i, Y0 + R * j) for (i, j), d in A_class.items() if d["class"] == c]
        ax[0].scatter([p[0] for p in pts], [p[1] for p in pts], s=14, marker="s", c=cc, label=f"{c} ({len(pts)})")
    ax[0].plot(*GP.exterior.xy, color="k", lw=1, label="campus.gpkg 유담관 외곽선")
    ax[0].plot(*A.exterior.xy, color="gray", lw=1, ls="--", label="Y-A 경계(S-MAP 모델 id)")
    ax[0].set_aspect("equal"); ax[0].legend(fontsize=8, loc="lower left"); ax[0].set_title("Y-A 표본 분류 (EPSG:5186, 2m)")
    for c, cc in col.items():
        a = zs(c)
        if a: ax[1].hist(a, bins=range(110, 186, 2), color=cc, alpha=0.75, label=c)
    ax[1].axvline(ROOF_Z, color="k", ls=":"); ax[1].axvline(SIDE_Z, color="k", ls=":")
    ax[1].set_xlabel("S-MAP 메시 표면 z (m)"); ax[1].set_ylabel("표본 수"); ax[1].legend(fontsize=8); ax[1].set_title("분류별 z 분포 (점선 150/160 m)")
    fig.tight_layout(); fig.savefig(os.path.join(V, "tower-sample-class.png"), dpi=100)
except Exception as e:
    print("plot skipped", e)

# 면적 분해
over = A.difference(GP)
area = {"GPKG": round(GP.area, 1), "A_tower": round(A.area, 1), "A_inside_GPKG": round(A.intersection(GP).area, 1),
        "A_outside_GPKG(지붕 돌출)": round(over.area, 1), "B_deck": round(B.area, 1), "C_preserved": round(C.area, 1)}
# 검사
chk = []
def ok(n, c, info=""): chk.append(("PASS " if c else "FAIL ") + n + " | " + info)
def info(n, t): chk.append("INFO " + n + " | " + t)
ok("원본 SHA 일치", SHA == "26c66faa36bd03c3f7106d68ac8a2f8e0a89a452f7899e5b0f20ab0673b45d13", SHA[:12])
ok("A∪B∪C가 원본 외곽선을 모두 덮음(축소 없음)", unary_union([A.intersection(GP), B, C]).symmetric_difference(GP).area < 0.5,
   f"{unary_union([A.intersection(GP), B, C]).symmetric_difference(GP).area:.3f} m2")
ok("B·C가 서로·A와 겹치지 않음", B.intersection(A).area < 0.01 and C.intersection(A).area < 0.01 and C.intersection(B).area < 0.01)
ok("모든 후보 accuracyVerified=false", all(not f["properties"]["accuracyVerified"] for f in fc["features"]))
ok("대장 높이를 부분에 적용하지 않음", all(f["properties"].get("baseZ") is None for f in fc["features"]))
ok("타워 정점마다 출처·오차", all(v["src"] and v["err_xy_m_assumed"] > 0 for v in fc["features"][0]["properties"]["vertices"]))
ok("Y-A 표본 전부 분류됨", sum(v["n_total"] for v in CLASS_SUMMARY.values()) == len(A_cells), f"{len(A_cells)}")
ok("topZ가 지붕 분류만 요약(지붕 표본 z 모두 >= 160)", all(v >= ROOF_Z for v in A_z) and fc["features"][0]["properties"]["topZ_p10"] >= ROOF_Z)
info("면적 분해", json.dumps(area, ensure_ascii=False))
info("Y-A 표본 분류", json.dumps(CLASS_SUMMARY, ensure_ascii=False))
info("데크 z", f"{B_z[0]}~{B_z[-1]}, 셀 {len(B_cells)}")
open(os.path.join(V, "checks.txt"), "w", encoding="utf-8").write("\n".join(chk) + "\n")
print("\n".join(chk))
fails = [c for c in chk if c.startswith("FAIL")]
sys.exit(1 if fails else 0)
