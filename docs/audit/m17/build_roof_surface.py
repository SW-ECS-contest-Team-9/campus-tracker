# CT-M17 후속: 지붕 분류 표본만으로 2m 표면 메시 후보 작성 (미리보기 전용, accuracyVerified=false).
# 입력(읽기): vault claude-m17/tower-sample-class.json (build_m17.py 출력)
# 출력: vault claude-m17/yudam-roof-surface-5186.geojson, roof-surface-checks.txt; preview data 사본
# 규칙: 정점 = 지붕 표본(x,y,z 원값 그대로). 2x2 사각형을 두 삼각형으로 나누고, 삼각형의 세 정점이 모두 '지붕'이고
#       세 변(대각 포함) 모두 |dz| <= 3.0 m 일 때만 면을 만든다. 첫 대각선 분할의 삼각형이 하나라도 안 되면 반대 대각선도 시도.
#       판독불가·측벽·미취득 셀은 정점이 아니므로 그 너머로 잇지 않고, 경계 밖 외삽 없음. 떨어진 면 사이는 비워 둔다.
import json, os, sys, shutil
from shapely.geometry import Polygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__)); V = sys.argv[1]
PREVIEW = os.path.join(HERE, "..", "m16", "preview", "data")
JUMP = 3.0
S = json.load(open(os.path.join(V, "tower-sample-class.json"), encoding="utf-8"))
roof = {(s["i"], s["j"]): s for s in S if s["class"] == "지붕"}
def ok(a, b): return abs(roof[a]["z"] - roof[b]["z"]) <= JUMP
def tri_ok(t): return all(c in roof for c in t) and ok(t[0], t[1]) and ok(t[1], t[2]) and ok(t[0], t[2])
tris = []
for (i, j) in roof:
    a, b, c, d = (i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)
    split1 = [(a, b, c), (a, c, d)]; split2 = [(a, b, d), (b, c, d)]
    g1 = [t for t in split1 if tri_ok(t)]; g2 = [t for t in split2 if tri_ok(t)]
    tris += g1 if len(g1) >= len(g2) else g2
# 연결 성분(변 공유)
from collections import defaultdict
edge_tris = defaultdict(list)
for k, t in enumerate(tris):
    for e in ((t[0], t[1]), (t[1], t[2]), (t[0], t[2])): edge_tris[frozenset(e)].append(k)
parent = list(range(len(tris)))
def f(x):
    while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
    return x
for ks in edge_tris.values():
    for k in ks[1:]: parent[f(k)] = f(ks[0])
comps = defaultdict(list)
for k in range(len(tris)): comps[f(k)].append(k)
patches = sorted(comps.values(), key=len, reverse=True)
used = {c for t in tris for c in t}
unused = sorted(set(roof) - used)
XY = lambda c: (roof[c]["x"], roof[c]["y"])
feats, holes_total, summary = [], 0, []
for n, ks in enumerate(patches):
    fp = unary_union([Polygon([XY(c) for c in tris[k]]) for k in ks])
    holes = sum(len(p.interiors) for p in (fp.geoms if fp.geom_type == "MultiPolygon" else [fp]))
    holes_total += holes
    zs = sorted(roof[c]["z"] for k in ks for c in tris[k])
    verts = sorted({c for k in ks for c in tris[k]})
    summary.append({"patch": n, "triangles": len(ks), "vertices": len(verts), "area_m2": round(fp.area, 1), "holes": holes, "z_min": zs[0], "z_max": zs[-1]})
    feats.append({"type": "Feature", "properties": {"id": f"Y-A-surface-{n}", "kind": "Y-A 상단 표면 후보(지붕 표본만)", "accuracyVerified": False,
        "triangles": len(ks), "vertices": len(verts), "area_m2": round(fp.area, 1), "holes": holes,
        "source": "S-MAP 3D 메시 표면 z (2026-10-09, getCoordinate3dFromPixel), tower-sample-class.json 지붕 분류",
        "err_xy_m_assumed": 2.0, "err_z_m_assumed": 1.0, "continuity_threshold_m": JUMP,
        "lower_floors_walls_base": "미확정"},
        "geometry": {"type": "MultiPolygon", "coordinates": [[[[*XY(c), roof[c]["z"]] for c in (*tris[k], tris[k][0])]] for k in ks]}})
fc = {"type": "FeatureCollection", "name": "yudam-roof-surface", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
      "properties": {"status": "미리보기 후보 전용, 운영·원본 반영 금지", "accuracyVerified": False, "created": "2026-10-09",
                     "rule": "지붕 표본만 정점, 삼각형 세 변 |dz|<=3m, 판독불가·측벽·미취득 너머 연결·외삽 없음",
                     "excluded_roof_samples_not_in_any_triangle": [{"x": roof[c]["x"], "y": roof[c]["y"], "z": roof[c]["z"]} for c in unused],
                     "excluded_other_classes": {k: sum(1 for s in S if s["class"] == k) for k in ("측벽·아래 표면", "판독불가")}},
      "features": feats}
out = os.path.join(V, "yudam-roof-surface-5186.geojson")
json.dump(fc, open(out, "w", encoding="utf-8"), ensure_ascii=False)
shutil.copy(out, os.path.join(PREVIEW, "yudam-roof-surface-5186.geojson"))
# 검사: 정점이 표본과 정확히 같음
idx = {(s["x"], s["y"]): s for s in S}
bad = 0; nv = 0
for ft in fc["features"]:
    for poly in ft["geometry"]["coordinates"]:
        for x, y, z in poly[0]:
            nv += 1; s = idx.get((x, y))
            if s is None or s["class"] != "지붕" or s["z"] != z: bad += 1
lines = []
P = lambda n, c, t="": lines.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
I = lambda n, t: lines.append("INFO " + n + " | " + t)
P("모든 메시 정점이 지붕 표본의 x,y,z와 정확히 일치", bad == 0, f"정점 참조 {nv}, 불일치 {bad}")
P("모든 삼각형 변 |dz| <= 3m", all(tri_ok(t) for t in tris))
P("판독불가·측벽 표본이 정점으로 쓰이지 않음", all(c in roof for t in tris for c in t))
I("면", f"삼각형 {len(tris)}, 면 조각 {len(patches)}, 구멍 {holes_total}, 지붕 표본 {len(roof)} 중 미사용 {len(unused)}")
I("조각별", json.dumps(summary, ensure_ascii=False))
open(os.path.join(V, "roof-surface-checks.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("\n".join(lines))
sys.exit(1 if any(l.startswith("FAIL") for l in lines) else 0)
