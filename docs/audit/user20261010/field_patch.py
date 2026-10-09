# 사용자 운동장 구조 주석 → 검토용 도로 패치 후보(미적용) + 검증 + 그림.
# 원칙: 기존 객체의 좌표·z·속성은 바꾸지 않는다(분할도 기존 z 값만 재사용). 새 객체 z는 null(미확정). '2m 이상'은 부등식 검사로만 쓴다.
# 사용법: field_patch.py <roads-live-2.json> <nodes-live-2.json> <building-outlines-5186.json> <field-annotation-5186.geojson> <출력 폴더>
import json, sys, os, copy
from shapely.geometry import LineString, Point, shape
if len(sys.argv) != 6: sys.exit("사용법: field_patch.py <roads-live-2.json> <nodes-live-2.json> <building-outlines-5186.json> <field-annotation-5186.geojson> <출력 폴더>")
RP, NP, OP, AP, OUT = sys.argv[1:]
R = json.load(open(RP, encoding="utf-8")); R = R["items"] if isinstance(R, dict) else R
N = json.load(open(NP, encoding="utf-8")); N = N["items"] if isinstance(N, dict) else N
ANN = {f["properties"]["id"]: f for f in json.load(open(AP, encoding="utf-8"))["features"]}
road = {r["id"][:8]: r for r in R}; node = {n["id"]: n for n in N}
R0 = copy.deepcopy(R)
def full(prefix): return next(r["id"] for r in R if r["id"].startswith(prefix))
def nxy(nid): c = node[nid]["coordinate"]; return c
def cent(aid): return list(shape(ANN[aid]["geometry"]).centroid.coords[0])
def line_pts(aid): g = shape(ANN[aid]["geometry"]); return [list(p) for p in (g.coords if g.geom_type == "LineString" else g.exterior.coords)]
n561 = road["88ba01e6"]["toNodeId"]                       # 88ba01e6 하단 = 3910b4a5 시작 = 45682ee7 끝
A1 = line_pts("A1"); plaza = A1[-1]
ops = []
# F1: 높은 가장자리 길(A1) — 88ba01e6 하단 노드에서 동쪽 끝 작은 광장까지. z 미확정.
ops.append({"op": "add_road", "id": "NEW-A1", "from": n561, "to": "NEW-N-plaza", "roadClass": "pedestrian", "structure": "ordinary",
            "coordinates_xy": [nxy(n561)[:2]] + A1[1:], "z": None, "why": "주석 '운동장 대비 2미터 이상 높은 좁은 가장자리 길'(A1). 모델에 해당 도로 없음(3910b4a5는 운동장을 대각 횡단)"})
ops.append({"op": "add_node", "id": "NEW-N-plaza", "xy": plaza, "z": None, "why": "A1 동쪽 끝 작은 광장(A2·A3 계단이 갈라지는 곳)"})
# F2: A2 높은 길→운동장 하행 계단, A3 광장→청운관 계단, A5 청운관에서 내려오는 계단
ops.append({"op": "add_road", "id": "NEW-A2", "from": "NEW-N-plaza", "to": "NEW-N-field-east", "structure": "stairs", "direction": "광장→운동장 하행",
            "coordinates_xy": [plaza, cent("A2")], "z": None, "why": "주석 '2미터 이상 높은 길에서 내려오는 계단'(A2)"})
ops.append({"op": "add_node", "id": "NEW-N-field-east", "xy": cent("A2"), "z": None, "why": "A2 하단(운동장면). 운동장 노드 없음 → 미연결"})
ops.append({"op": "add_road", "id": "NEW-A3", "from": "NEW-N-plaza", "to": "NEW-N-cheongun", "structure": "stairs", "direction": "미확정(문구: 청운관으로 가는 계단)",
            "coordinates_xy": [plaza, cent("A3")], "z": None, "why": "주석 '내려가지 않고 광장에서 청운관으로 가는 계단'(A3, 판독)"})
ops.append({"op": "add_node", "id": "NEW-N-cheongun", "xy": cent("A3"), "z": None, "why": "A3 끝. 청운관 출입 노드 미확정"})
ops.append({"op": "add_road", "id": "NEW-A5", "from": "NEW-N-A5-top", "to": "NEW-N-A5-bottom", "structure": "stairs", "direction": "청운관→운동장 하행",
            "coordinates_xy": line_pts("A5")[:2], "z": None, "why": "주석 '청운관에서 내려오는 계단'(A5). 양 끝 접속 미확정"})
# F3: 618385b9 분할 + 기본 내리막길로 빠지는 하행 계단(A14). 분할점 z는 618385b9 기존 값(143.8) 재사용, 하단은 8e71c240 기존 노드.
r618 = road["618385b9"]; L618 = LineString([(p[0], p[1]) for p in r618["coordinates"]])
a14 = shape(ANN["A14"]["geometry"]).centroid
sp = L618.interpolate(L618.project(a14)); split_xy = [round(sp.x, 2), round(sp.y, 2)]
r8e = road["8e71c240"]; L8e = LineString([(p[0], p[1]) for p in r8e["coordinates"]])
assert r8e["coordinates"][0][2] == r8e["coordinates"][-1][2]   # 8e71c240 양 끝 z 동일(141.73) → 분할점 z도 기존 값
sp2 = L8e.interpolate(L8e.project(a14)); split2_xy = [round(sp2.x, 2), round(sp2.y, 2)]
ops.append({"op": "split_road", "road": r618["id"], "at_xy": split_xy, "new_node": "NEW-N-618split", "z_at_split": r618["coordinates"][0][2],
            "why": "주석 '화단을 가로지르며 기본 내리막길로 빠지는 하행 계단'(A14)의 분기점. 기존 z(평탄 143.8)만 재사용"})
ops.append({"op": "split_road", "road": r8e["id"], "at_xy": split2_xy, "new_node": "NEW-N-8e7split", "z_at_split": r8e["coordinates"][0][2],
            "why": "A14 계단 하단 접속점. 8e71c240 기존 z(141.73, 양 끝 동일)만 재사용"})
ops.append({"op": "add_road", "id": "NEW-A14", "from": "NEW-N-618split", "to": "NEW-N-8e7split", "structure": "stairs", "direction": "618385b9→8e71c240 하행",
            "coordinates_xy": [split_xy, split2_xy], "z_ends_from_existing": [r618["coordinates"][0][2], r8e["coordinates"][0][2]],
            "why": "A14 계단. 양 끝 z는 기존 객체 값(143.8 → 141.73)"})
# 보고만(변경 안 함)
reports = [
 {"object": road["88ba01e6"]["id"], "issue": "주석상 대일관 진입로 계단(A7)은 높은 가장자리 길(A1)로 내려감. 88ba01e6 하단 노드는 운동장 기준(3910b4a5 시작, 141.73)과 같아 'A1 ≥ 운동장+2m'를 만족할 수 없음",
  "action": "z 보정은 근거 없음 → 미적용. 운동장 기준 노드와 A1 노드를 나누려면 A1·운동장 z 확인 필요"},
 {"object": road["45682ee7"]["id"] + " / " + road["8e71c240"]["id"], "issue": "주석 '기본 내리막길'(A13) 위치. 45682ee7 ordinary·8e71c240 ramp 모두 양 끝 z 141.73 동일(평탄)", "action": "내리막 방향만 기록. z 미확정이라 미적용"},
 {"object": road["fdb059c4"]["id"], "issue": "주석 '계단 이후 잠깐의 평지'(A15)와 위치·구조 일치(a7a51d3c 계단 아래 평탄부)", "action": "변경 없음(근거 일치)"},
 {"object": "A9·A10·A11 (운동장 서측 띠)", "issue": "주석상 '조금 높은 화단' + '화단 사이 진입로'(A10). 모델 도로 없음", "action": "화단은 통로로 만들지 않음. A10 진입로는 운동장·외측 노드 미확정이라 보류"},
 {"object": "A8 진입로 계단(운동장 북서 모서리)", "issue": "45682ee7에서 1.5 m. 계단 객체 없음", "action": "양 끝 미확정 → 위치만 기록"},
 {"object": "A16 혜인관 쪽", "issue": "문구 판독 미확정", "action": "연결 생성 금지(지시)"},
]
patch = {"status": "검토용 후보, DB 미적용", "accuracyVerified": False, "crs": "EPSG:5186", "source_annotation": "사용자-운동장구조-20261010/운동장-구조표시.png",
         "ops": ops, "reports": reports}
json.dump(patch, open(os.path.join(OUT, "field-structure-patch.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
# 검증
L = []
def chk(n, c, t=""): L.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
chk("기존 도로 데이터 변경 없음(패치는 별도 파일)", R == R0)
refs = [o.get(k) for o in ops for k in ("from", "to") if o.get(k) and not str(o.get(k)).startswith("NEW")]
chk("기존 노드 참조가 모두 존재", all(x in node for x in refs), str(refs))
chk("새 객체 z는 null 또는 기존 객체 값만", all((o.get("z") is None) for o in ops if o["op"] in ("add_road", "add_node") and "z_ends_from_existing" not in o)
    and all(v in (r618["coordinates"][0][2], r8e["coordinates"][0][2]) for v in ops[-1]["z_ends_from_existing"]))
chk("분할점이 618385b9·8e71c240 위(≤0.01 m)", L618.distance(Point(split_xy)) <= 0.01 and L8e.distance(Point(split2_xy)) <= 0.01, f"A14 길이 {Point(split_xy).distance(Point(split2_xy)):.1f} m")
chk("A14 계단 방향이 하행(기존 z 기준)", ops[-1]["z_ends_from_existing"][0] > ops[-1]["z_ends_from_existing"][1], str(ops[-1]["z_ends_from_existing"]))
field_z = road["3910b4a5"]["coordinates"][0][2]; a1_start_z = nxy(n561)[2]
ineq = a1_start_z - field_z >= 2.0
L.append(("INFO " ) + "부등식 'A1 ≥ 운동장+2m' 현재 모델 | A1 시작 노드 z %.2f − 운동장 기준(3910b4a5 시작) %.2f = %.2f → %s" % (a1_start_z, field_z, a1_start_z - field_z, "만족" if ineq else "불만족(보고)"))
chk("새 도로가 화단(A9·A11 띠) 위를 지나지 않음", all(LineString(o["coordinates_xy"]).distance(shape(ANN[a]["geometry"])) > 1.0 for o in ops if o["op"] == "add_road" for a in ("A9", "A11")))
open(os.path.join(OUT, "field-patch-checks.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
try:
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    plt.rcParams["font.family"] = "Malgun Gothic"; plt.rcParams["axes.unicode_minus"] = False
    fig, ax = plt.subplots(figsize=(11, 10))
    for b in json.load(open(OP, encoding="utf-8")):
        if b["name"] in ("대일관", "청운관", "혜인관", "은주관", "한림관", "문예관", "본관"):
            c = b["coordinates"][0][0]; ax.plot([p[0] for p in c], [p[1] for p in c], color="0.6", lw=1); ax.text(*shape({"type": "Polygon", "coordinates": [c]}).representative_point().coords[0], b["name"], color="0.4", fontsize=8)
    for r in R:
        c = r.get("coordinates") or []
        if len(c) >= 2 and 201090 < c[0][0] < 201260 and 557190 < c[0][1] < 557345:
            ax.plot([p[0] for p in c], [p[1] for p in c], color="k" if r["structure"] != "stairs" else "tab:purple", lw=1)
    for aid, f in ANN.items():
        g = shape(f["geometry"]); xy = g.coords if g.geom_type == "LineString" else g.exterior.coords
        ax.plot([p[0] for p in xy], [p[1] for p in xy], color="red", lw=2); ax.text(*g.centroid.coords[0], aid, color="red", fontsize=9)
    for o in ops:
        if o["op"] == "add_road": ax.plot([p[0] for p in o["coordinates_xy"]], [p[1] for p in o["coordinates_xy"]], color="tab:green", lw=3, ls="--")
    ax.set_xlim(201095, 201255); ax.set_ylim(557195, 557345); ax.set_aspect("equal")
    ax.set_title("빨강=사용자 주석 대응(±%.0f m), 검정/보라=운영 도로(보라=계단), 초록 점선=검토 후보" % ANN["A1"]["properties"]["err_xy_m_assumed"])
    fig.savefig(os.path.join(OUT, "field-annotation-vs-roads.png"), dpi=100, bbox_inches="tight")
except Exception as e:
    print("plot skipped", e)
sys.exit(1 if any(l.startswith("FAIL") for l in L) else 0)
