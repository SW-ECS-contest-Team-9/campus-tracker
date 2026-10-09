# CT-M16 후보 도형 작성 + 검사. 입력: S-MAP 원문 응답, 2015 DEM, 운영 스냅샷2 도로, 건물 외곽선. 쓰기: claude-m16/ 만.
import json, struct, math, os
B = os.path.dirname(os.path.abspath(__file__)); A = os.path.dirname(B)
raw = json.load(open(os.path.join(B, "smap-elevation-raw-20261009.json"), encoding="utf-8"))
Z = {r["name"].split()[0]: json.loads(r["raw"])["result"] for r in raw}
P = {r["name"].split()[0]: (r["x"], r["y"]) for r in raw}
meta = json.load(open(os.path.join(A, "terrain-grid-meta.json")))
W, H, ox, oy, res = meta["width"], meta["height"], meta["originX"], meta["originY"], meta["resolution"]
g = open(os.path.join(A, "terrain-grid.f32"), "rb").read(); n = W * H
assert len(g) == 4 * n, len(g)
grid = struct.unpack("<%df" % n, g)


def dem(x, y):  # 셀 중심 쌍선형. 행 순서를 모르므로 두 방향 모두 계산
    out = {}
    for name, flip in (("south_first", False), ("north_first", True)):
        fx = (x - ox) / res - 0.5; fy = (y - oy) / res - 0.5
        if flip: fy = H - 1 - fy
        i, j = int(math.floor(fx)), int(math.floor(fy)); tx, ty = fx - i, fy - j
        v = lambda a, b: grid[b * W + a]
        out[name] = round(v(i, j)*(1-tx)*(1-ty) + v(i+1, j)*tx*(1-ty) + v(i, j+1)*(1-tx)*ty + v(i+1, j+1)*tx*ty, 2)
    return out


rows = []
for k, (x, y) in P.items():
    rows.append({"id": k, "x": x, "y": y, "smap_dem_z": round(Z[k]["dem_z"], 2), "buld_z": Z[k]["buld_z"], "dem2015": dem(x, y)})
err = {o: sum(abs(r["dem2015"][o] - r["smap_dem_z"]) for r in rows) / len(rows) for o in ("south_first", "north_first")}
ori = min(err, key=err.get)
for r in rows:
    r["dem2015_used"] = r["dem2015"][ori]; r["diff_smap_minus_2015"] = round(r["smap_dem_z"] - r["dem2015"][ori], 2)
json.dump({"dem_row_order_chosen": ori, "mean_abs_diff_by_order": err, "points": rows},
          open(os.path.join(B, "smap-vs-dem2015.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def zz(k): return round(Z[k]["dem_z"], 2)


SRC_PICK = "S-MAP 3D 메시 getCoordinate3dFromPixel 픽(2026-10-09, 정사 근사 fov0.12 약0.16m/화면px 또는 경사 시점)"


def V(x, y, z, src, exy, ez): return {"x": x, "y": y, "z": z, "src": src, "err_xy_m": exy, "err_z_m": ez}


feats = []
feats.append({"id": "S06-C1", "surface": "ground", "kind": "차도 중심선 후보(유담관-본관 주 오르막)",
  "verts": [V(*P[k], zz(k), SRC_PICK + " + z=S-MAP dem_z(" + k + ")", 1.5, 0.5) for k in ("S06-R1", "S06-R2", "S06-R3", "S06-R4", "S06-R5")],
  "note": "평면 위치는 정사 화면 차선·횡단보도로 판독. z는 S-MAP DEM(메시와 같은 계열로 추정, 독립 측량 아님). 보도·계단 보행로는 위치 띠만 확인되어 미작성."})
feats.append({"id": "S06-C2", "surface": "ground-upper(분수광장 약114m)", "kind": "단 경계 상단선 후보", "verts": [
  V(201048.68, 557218.16, zz("S06-W1"), SRC_PICK + " 단면A 급변 직전 + S-MAP dem_z(S06-W1)", 2.0, 1.0),
  V(201058.77, 557211.86, 113.69, SRC_PICK + " 단면B 급변 직전(메시 z)", 2.0, 1.0)],
  "note": "단면 2개에서 메시 z가 수평 6~7m 안에 약18~20m 급변. 상단·하단은 별도 표면, 사이 사면 생성 금지."})
feats.append({"id": "S06-C3", "surface": "ground-lower(낮은 길 약93~96m)", "kind": "단 경계 하단선 후보", "verts": [
  V(201041.84, 557216.92, zz("S06-W2"), SRC_PICK + " 단면A 급변 직후 + S-MAP dem_z(S06-W2)", 2.0, 1.0),
  V(201056.46, 557206.24, 96.19, SRC_PICK + " 단면B 급변 직후(메시 z)", 2.0, 1.0)],
  "note": "S06-C2와 쌍. 벽면 텍스처가 번져 계단·재질 판독 불가."})
feats.append({"id": "S07-C1", "surface": "ground(포털 문턱, 지상 측)", "kind": "P1 지하주차장 입구 문턱선 후보", "verts": [
  V(201021.09, 557305.03, 127.39, SRC_PICK + " 곡선 석축 화단 아래 하강 차로 왼쪽 끝(메시 z)", 2.0, 1.5),
  V(201022.81, 557309.11, 128.5, SRC_PICK + " 오른쪽 끝(메시 z)", 2.0, 1.5)],
  "note": "포털 위 화단 S-MAP dem_z 131.45(S07-K2). 메시는 하강 바닥을 표현 못함. 지하 표면은 별도 객체, 높이 미상. 951c157d 끝점(201053.9,557349.2)과 약50m 떨어져 연결 근거 없음."})

fc = {"type": "FeatureCollection", "name": "claude-m16-preview-candidates",
      "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
      "properties": {"status": "미리보기 후보 전용, 운영 반영 금지", "created": "2026-10-09"}, "features": []}
for f in feats:
    props = {k: f[k] for k in ("id", "surface", "kind", "note")}; props["vertices"] = f["verts"]
    fc["features"].append({"type": "Feature", "properties": props,
        "geometry": {"type": "LineString", "coordinates": [[a["x"], a["y"], a["z"]] for a in f["verts"]]}})
json.dump(fc, open(os.path.join(B, "candidates-5186.geojson"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

# ---- 검사 ----
chk = []
def ok(name, cond, info=""): chk.append((name, bool(cond), info))
ok("모든 정점이 DEM 격자 범위 안", all(ox < a["x"] < ox + W*res and oy < a["y"] < oy + H*res for f in feats for a in f["verts"]))
ok("모든 정점에 출처·오차 기록", all(a["src"] and a["err_xy_m"] > 0 and a["err_z_m"] > 0 for f in feats for a in f["verts"]))
up = [a["z"] for a in feats[1]["verts"]]; lo = [a["z"] for a in feats[2]["verts"]]
ok("광장 상단선과 낮은길 하단선 분리(15m 이상)", min(up) - max(lo) > 15, f"{min(up)} vs {max(lo)}")
ok("상·하단을 잇는 도형 없음(표면별 별도 피처)", len({f['surface'] for f in feats}) == len(feats))
mc = (201033.4, 557319.4); pc = P["CHK"]
ok("기준점: 본관 남서 모서리 S-MAP 픽 vs 외곽선 1.5m 이내", math.dist(mc, pc) <= 1.5, f"{math.dist(mc, pc):.2f} m; buld_z={Z['CHK']['buld_z']}")
rz = [a["z"] for a in feats[0]["verts"]]
ok("S06-C1 남동→북서 단조 상승", all(b > a for a, b in zip(rz, rz[1:])), str(rz))
L = sum(math.dist((a["x"], a["y"]), (b["x"], b["y"])) for a, b in zip(feats[0]["verts"], feats[0]["verts"][1:]))
ok("S06-C1 길이·상승(정보)", True, f"길이 {L:.1f} m, 상승 {rz[-1]-rz[0]:.2f} m, 평균 {100*(rz[-1]-rz[0])/L:.1f}%")
r = json.load(open(os.path.join(A, "claude-live", "roads-live-2.json"), encoding="utf-8")); r = r if isinstance(r, list) else r.get("roads", r.get("items", r))
def segd(p, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    t = 0 if dx == dy == 0 else max(0, min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)))
    return math.hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy)
near = {}
for f in feats:
    for a in f["verts"]:
        for rd in r:
            c = rd["coordinates"]
            if min(segd((a["x"], a["y"]), c[i], c[i+1]) for i in range(len(c)-1)) < 5: near.setdefault(f["id"], set()).add(rd["id"][:8])
ok("후보 정점 5m 안 기존 운영 도로(정보)", True, json.dumps({k: sorted(v) for k, v in near.items()}))
ok("2015 DEM vs S-MAP dem_z 평균 절대차(정보)", True, f"{err[ori]:.2f} m ({ori})")
with open(os.path.join(B, "checks.txt"), "w", encoding="utf-8") as fo:
    for c in chk: fo.write(("PASS " if c[1] else "FAIL ") + c[0] + " | " + c[2] + "\n")
for c in chk: print(("PASS " if c[1] else "FAIL ") + c[0] + " | " + c[2])
for rw in rows: print(rw["id"], rw["smap_dem_z"], rw["dem2015_used"], rw["diff_smap_minus_2015"])

try:
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt; import numpy as np
    plt.rcParams["font.family"] = "Malgun Gothic"; plt.rcParams["axes.unicode_minus"] = False
    arr = np.array(grid, dtype=float).reshape(H, W)
    if ori == "north_first": arr = arr[::-1]
    ext = [ox, ox + W*res, oy, oy + H*res]
    bo = json.load(open(os.path.join(A, "building-outlines-5186.json"), encoding="utf-8"))
    fig, axs = plt.subplots(1, 2, figsize=(13, 8))
    col = {"S06-C1": "blue", "S06-C2": "magenta", "S06-C3": "cyan", "S07-C1": "black"}
    for ax, title, after in ((axs[0], "전: 2015 DEM + 운영 도로(스냅샷2, 빨강 점선)", False), (axs[1], "후: + CT-M16 미리보기 후보", True)):
        im = ax.imshow(arr, origin="lower", extent=ext, cmap="terrain", vmin=88, vmax=150)
        ax.contour(np.arange(W)*res+ox+res/2, np.arange(H)*res+oy+res/2, arr, levels=range(90, 151, 2), colors="k", linewidths=0.3)
        for b in bo:
            ring = b["coordinates"][0][0]; ax.plot([p[0] for p in ring], [p[1] for p in ring], color="gold", lw=1)
        for rd in r:
            c = rd["coordinates"]; ax.plot([p[0] for p in c], [p[1] for p in c], color="red", lw=1.2, ls="--")
        if after:
            for f in feats:
                ax.plot([a["x"] for a in f["verts"]], [a["y"] for a in f["verts"]], color=col[f["id"]], lw=2.5, marker="o", ms=3, label=f["id"])
            ax.legend(loc="upper right", fontsize=8)
        ax.set_xlim(200980, 201110); ax.set_ylim(557190, 557360); ax.set_aspect("equal"); ax.set_title(title, fontsize=10)
    fig.colorbar(im, ax=axs, shrink=0.6, label="2015 DEM (m)")
    fig.savefig(os.path.join(B, "before-after-candidates.png"), dpi=110)
    print("figure ok")
except Exception as e:
    print("figure skipped", e)
