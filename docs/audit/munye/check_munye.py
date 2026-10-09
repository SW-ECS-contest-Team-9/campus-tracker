# 문예관 후보 검사. 사용법: check_munye.py <볼트 출력 폴더> <building-outlines-5186.json> <scene-live.json>
import json, os, sys
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union
if len(sys.argv) != 4: sys.exit("사용법: check_munye.py <볼트 출력 폴더> <building-outlines-5186.json> <scene-live.json>")
V, OUTL, SCENE = sys.argv[1:]
L = lambda n: json.load(open(os.path.join(V, n), encoding="utf-8"))
S, F, M = L("munye-sample-class-5186.geojson"), L("munye-roof-surface-5186.geojson"), L("munye-massing-candidate-5186.geojson")
idx = {tuple(f["geometry"]["coordinates"][:2]): {**f["properties"], "z": f["geometry"]["coordinates"][2]} for f in S["features"]}
out = []
P = lambda n, c, t="": out.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
bad = adj = dzb = nv = 0
for poly in F["features"][0]["geometry"]["coordinates"]:
    v = poly[0][:3]
    for x, y, z in v:
        nv += 1; s = idx.get((x, y))
        if s is None or s["class"] != "고층 지붕" or s["z"] != z: bad += 1
    for a in range(3):
        for b in range(a + 1, 3):
            if max(abs(v[a][0] - v[b][0]), abs(v[a][1] - v[b][1])) > 2: adj += 1
            if abs(v[a][2] - v[b][2]) > 3: dzb += 1
P("메시 정점 = 고층 지붕 표본 x,y,z 원값", bad == 0, f"정점 참조 {nv}, 불일치 {bad}")
P("삼각형 변은 인접 셀(2m 격자 이웃)만 연결 -> 저층·불명확 셀 가로지름 없음", adj == 0, f"위반 {adj}")
P("삼각형 변 |dz|<=3m (급격한 높이차 연결 없음)", dzb == 0, f"위반 {dzb}")
o = Polygon(next(b for b in json.load(open(OUTL, encoding="utf-8")) if b["name"] == "문예관")["coordinates"][0][0])
g = [shape(f["geometry"]) for f in M["features"]]; u = unary_union(g)
ov = sum(g[a].intersection(g[b]).area for a in range(len(g)) for b in range(a + 1, len(g)))
sd = u.symmetric_difference(o).area
P("매스 부분 합집합 = 원외곽선(축소 없음)", sd < 1e-6, f"원 {o.area:.2f} / 합 {u.area:.2f} / 대칭차 {sd:.2e} m2")
P("매스 부분 겹침 없음", ov < 1e-6, f"겹침 {ov:.2e} m2")
sc = next(b for b in json.load(open(SCENE, encoding="utf-8"))["buildings"] if b["name"] == "문예관")
for f in M["features"]:
    p = f["properties"]
    out.append(f"INFO {p['id']} {p['part']} 면적 {p['area_m2']} m2, 상단 {p['topZ']} (원본 roofM {sc['roofM']} 대비 {p['roof_diff_vs_scene_roofM']:+}, gpkg roof_m 대비 {p['roof_diff_vs_gpkg_roof_m']:+}), 하단 {p['baseM']} 미확정")
P("저층·나머지 상단을 고층 높이로 올리지 않음", all(f["properties"]["topZ"] == sc["roofM"] for f in M["features"] if f["properties"]["id"] != "MY-T"))
P("accuracyVerified=false", all(fc["properties"]["accuracyVerified"] is False for fc in (S, F, M)))
print("\n".join(out))
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "checks.txt"), "w", encoding="utf-8").write("\n".join(out) + "\n")
sys.exit(1 if any(l.startswith("FAIL") for l in out) else 0)
