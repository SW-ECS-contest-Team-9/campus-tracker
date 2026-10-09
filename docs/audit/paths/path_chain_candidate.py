# 길 사슬 후보 그래프 (검토 데이터, 운영 미적용). 기준: 운영 스냅샷2 roads-live-2.json + nodes-live-2.json.
# 사슬 1: 대일관 출구→하행 계단(EXIT-SIDE)→하부 포장(145 m대 평탄부)→A14→141 m대 사잇길 / 높은 띠→운동장(A2) / 청운관 계단(A3·A5)
# 사슬 2: 북악관 정문(원형)과 GS25 B1 옆길은 다른 진입 / 옆길→뒤편 산책로(a03d33c3)→문예관·대일관 출입
# 사슬 3: 실내외 포털과 층간 연결(본관5F↔한림3F는 제약 기록만)
# 규칙: 가까운 노드 임의 병합 금지, 외벽 관통 연결 금지, 사용자 삭제 도로(6f2a4bcd, 7408c108) 복원 금지, 문턱 미확정 접속만 보류,
#       z 검사는 같은 표면의 S-MAP 셀 값(같은 XY)만 사용, 다른 면 사이 보간 없음. 후보는 운영값으로 승격하지 않음.
# 사용법: path_chain_candidate.py <roads-live-2.json> <nodes-live-2.json> <smap-mesh-reads-v3.json> <field-structure-patch-v2.json> <user-mapping-5186.geojson> <building-outlines-5186.json> <출력 폴더>
import json, sys, os, math, hashlib, copy
from collections import defaultdict, deque
from shapely.geometry import LineString, Point, Polygon
if len(sys.argv) != 8: sys.exit("사용법: path_chain_candidate.py <roads> <nodes> <mesh-reads> <patch-v2> <user-mapping> <outlines> <출력 폴더>")
RP, NP, MR, P2, UM, OL, OUT = sys.argv[1:]
RAW = open(RP, "rb").read(); SHA = hashlib.sha256(RAW).hexdigest()
R0 = json.loads(RAW); R0 = R0["items"] if isinstance(R0, dict) else R0
N0 = json.load(open(NP, encoding="utf-8")); N0 = N0["items"] if isinstance(N0, dict) else N0
M = json.load(open(MR, encoding="utf-8")); P = json.load(open(P2, encoding="utf-8")); U = {f["properties"]["id"]: f for f in json.load(open(UM, encoding="utf-8"))["features"]}
OUTL = {b["name"]: Polygon(b["coordinates"][0][0]) for b in json.load(open(OL, encoding="utf-8"))}
DELETED = ("6f2a4bcd", "7408c108")
def rid(p): return next(r["id"] for r in R0 if r["id"].startswith(p))
def road(p): return next(r for r in R0 if r["id"].startswith(p))
NODE = {n["id"]: n for n in N0}
def nid(p): return next(k for k in NODE if k.startswith(p))
# ---- 같은 표면 S-MAP 셀(같은 XY ±1 m) ----
SURF = {"하부포장(145 m대)": M["corridor_cells"], "사잇길 메시": M["corridor_cells"], "높은 띠": M["high_strip_cells"]}
FIELD = set()
for row in M["field_flat_component"]["rle_y_xranges"].split(";"):
    y, rs = row.split(":")
    for rr in rs.split(","):
        a, b = map(int, rr.split("-")); FIELD |= {(x, int(y)) for x in range(a, b + 1, 2)}
def cell(cells, x, y, tol=1.01):
    best = min(cells, key=lambda c: math.dist((x, y), c[:2])); d = math.dist((x, y), best[:2])
    return (best[2], f"셀 ({best[0]},{best[1]})", round(d, 2)) if d <= tol else (None, f"같은 XY 셀 없음(최근접 {d:.1f} m)", round(d, 2))
def field_z(x, y):
    k = (int(round(x / 2) * 2), int(round(y / 2) * 2)); return (148.9, f"SF-FIELD 셀 {k}", 0.0) if k in FIELD else (None, "운동장 셀 아님", None)
# ---- 후보 그래프: 기존 도로/노드 복사 + 패치 ----
roads = {r["id"]: {"id": r["id"], "name": r.get("name"), "structure": r.get("structure"), "class": r.get("roadClass"), "from": r["fromNodeId"], "to": r["toNodeId"],
                   "xy": [p[:2] for p in r["coordinates"]], "z_op": [r["coordinates"][0][2], r["coordinates"][-1][2]], "src": "운영 DRAFT", "indoor": r.get("structure") == "indoor_corridor"} for r in R0}
nodes = {k: {"id": k, "xy": v["coordinate"][:2], "z_op": v["coordinate"][2], "z_cand": None, "z_src": None, "src": "운영"} for k, v in NODE.items()}
ops = []
ALIAS = {}
def add_node(k, xy, z=None, zsrc=None, why=""):
    nodes[k] = {"id": k, "xy": [round(xy[0], 2), round(xy[1], 2)], "z_op": None, "z_cand": z, "z_src": zsrc, "src": "후보"}; ops.append({"op": "add_node", "id": k, "xy": nodes[k]["xy"], "z_cand": z, "z_src": zsrc, "why": why})
def add_road(k, a, b, structure, xy, why, status):
    roads[k] = {"id": k, "name": why, "structure": structure, "class": "pedestrian", "from": a, "to": b, "xy": xy, "z_op": None, "src": "후보", "status": status, "indoor": False}
    ops.append({"op": "add_road", "id": k, "from": a, "to": b, "structure": structure, "xy": xy, "status": status, "why": why})
def split(rk, at, newnode, z, zsrc, why, keep_struct=(None, None)):
    r = roads[rk]; ls = LineString(r["xy"]); s = ls.project(Point(at)); q = ls.interpolate(s)
    pts = r["xy"]; cum = [0]
    for i in range(1, len(pts)): cum.append(cum[-1] + math.dist(pts[i - 1], pts[i]))
    left = [p for p, c in zip(pts, cum) if c < s] + [[q.x, q.y]]; right = [[q.x, q.y]] + [p for p, c in zip(pts, cum) if c > s]
    add_node(newnode, (q.x, q.y), z, zsrc, why)
    a = dict(r, id=rk + "#A", to=newnode, xy=left, src="후보(분할)", structure=keep_struct[0] or r["structure"]); b = dict(r, id=rk + "#B", **{"from": newnode}, xy=right, src="후보(분할)", structure=keep_struct[1] or r["structure"])
    del roads[rk]; roads[a["id"]] = a; roads[b["id"]] = b
    ops.append({"op": "split_road", "road": rk, "at": [round(q.x, 2), round(q.y, 2)], "dist_from_target_m": round(Point(at).distance(q), 2), "new_node": newnode, "parts": [a["id"], b["id"]],
                "structures": [a["structure"], b["structure"]], "why": why})
    return a["id"], b["id"]
# 사슬 1 -------------------------------------------------------------
v6 = {"EXIT_BOT": (201136.0, 557320.0), "A14T": (201133.31, 557321.28), "A14B": (201118.0, 557312.0)}
z1, s1, _ = cell(M["corridor_cells"], *v6["EXIT_BOT"])
a618, b618 = split(rid("618385b9"), v6["EXIT_BOT"], "C1-N-EXITBOT", z1, "하부포장 " + s1, "출구 옆 하행 계단 하단 = 145 m대 평탄부 가장자리(v6 표면 후보 대응). 2f206e6c 끝 d85f61a5와의 사이 구간은 계단 연장", ("stairs", "ordinary"))
z2, s2, _ = cell(M["corridor_cells"], *v6["A14T"])
b618a, b618b = split(b618, v6["A14T"], "C1-N-A14T", z2, "하부포장 " + s2, "A14 상단 = 평탄부(v6 표면 후보 대응)")
z3, s3, _ = cell(M["corridor_cells"], *v6["A14B"])
add_node("C1-N-A14B", v6["A14B"], z3, "사잇길 메시 " + s3, "A14 하단 = 141 m대 셀(v6 미검증, 사진8 핀 대응 15 m)")
add_road("C1-R-A14", "C1-N-A14T", "C1-N-A14B", "stairs", [list(v6["A14T"]), list(v6["A14B"])], "A14 화단 가로지르는 하행 계단(후보)", "미검증(하단)")
r8e = road("8e71c240"); L8 = LineString([p[:2] for p in r8e["coordinates"]]); g8 = L8.distance(Point(v6["A14B"]))
if g8 <= 3.0:
    p8a, p8b = split(rid("8e71c240"), v6["A14B"], "C1-N-8E7", z3, "사잇길 메시 " + s3, "A14 하단을 8e71c240(기본 내리막길)에 접속")
    add_road("C1-R-A14LINK", "C1-N-A14B", "C1-N-8E7", "ordinary", [list(v6["A14B"]), nodes["C1-N-8E7"]["xy"]], "A14 하단–8e71c240 접속(같은 141 m 면)", "후보")
    a14_link = True
else:
    a14_link = False
# 높은 띠(A1)·운동장·청운관
a1 = next(o for o in P["ops"] if o.get("id") == "NEW-A1"); a2 = next(o for o in P["ops"] if o.get("id") == "NEW-A2")
a3 = next(o for o in P["ops"] if o.get("id") == "NEW-A3"); a5 = next(o for o in P["ops"] if o.get("id") == "NEW-A5")
# 높은 띠 중심선: 메시 띠 셀(150.8~152.0)의 x 구간별 평균 위치(주석 A1 선은 대일관 외곽선 안을 지나므로 쓰지 않음)
SC = M["high_strip_cells"]; cols = defaultdict(list)
for x, y, z in SC: cols[(x - 201164) // 6].append((x, y, z))
cl = []
for k in sorted(cols):
    g = cols[k]; cx = sum(c[0] for c in g) / len(g); cy = sum(c[1] for c in g) / len(g); cl.append((round(cx, 2), round(cy, 2)))
for i, (x, y) in enumerate(cl):
    z, sz, _ = cell(SC, x, y, tol=1.5)
    add_node(f"C1-N-A1-{i}", (x, y), z, ("높은 띠 " + sz) if z else "z 미확정(" + sz + ")", "높은 띠 중심선 꼭짓점(메시 띠 셀 평균)")
for i in range(len(cl) - 1):
    add_road(f"C1-R-A1-{i}", f"C1-N-A1-{i}", f"C1-N-A1-{i+1}", "ordinary", [list(cl[i]), list(cl[i + 1])], "높은 가장자리 띠(메시 띠 셀 중심선)", "후보")
A1W, PLAZA = "C1-N-A1-0", f"C1-N-A1-{len(cl)-1}"
def nearest_field(xy, lim=8.0):
    k = min(FIELD, key=lambda c: math.dist(c, xy)); return (k if math.dist(k, xy) <= lim else None), round(math.dist(k, xy), 1)
def stair_to_field(tag, top, anno_xy):
    k, d = nearest_field(anno_xy)
    if k is None: return d, False
    add_node(f"C1-N-{tag}B", k, 148.9, f"SF-FIELD 셀 {k}", f"{tag} 하단 = 주석 위치(±8 m)에서 가장 가까운 운동장 셀")
    add_road(f"C1-R-{tag}", top, f"C1-N-{tag}B", "stairs", [nodes[top]["xy"], list(k)], f"{tag} 계단(→운동장)", "후보")
    return d, True
d_a2, ok_a2 = stair_to_field("A2", PLAZA, a2["coordinates_xy"][-1])
r39 = road("3910b4a5"); c39 = [p[:2] for p in r39["coordinates"]]
def field_link(nk, label):
    xy = nodes[nk]["xy"]; ls = LineString(c39); q = ls.interpolate(ls.project(Point(xy)))
    if field_z(*xy)[0] is None or field_z(q.x, q.y)[0] is None: return None
    seg = min((k for k in roads if k.startswith(r39["id"])), key=lambda k: LineString(roads[k]["xy"]).distance(q))
    ls2 = LineString(roads[seg]["xy"]); s2 = ls2.project(q)
    if s2 < 0.05 or s2 > ls2.length - 0.05:   # 끝점이면 기존 끝 노드에 연결(별칭)
        endn = roads[seg]["from"] if s2 < 0.05 else roads[seg]["to"]; ALIAS[f"C1-N-F-{label}"] = endn; tgt = endn
    else:
        split(seg, (q.x, q.y), f"C1-N-F-{label}", 148.9, "SF-FIELD 셀", f"운동장 면 위 {label} 접속점"); tgt = f"C1-N-F-{label}"
    add_road(f"C1-R-F-{label}", nk, tgt, "ordinary", [xy, [round(q.x, 2), round(q.y, 2)]], f"운동장 평지 위 이동({label}, 같은 SF-FIELD 면)", "후보")
    return round(Point(xy).distance(q), 1)
fl_a2 = field_link("C1-N-A2B", "A2") if ok_a2 else None
# 청운관 쪽 끝은 외곽선 경계에서 멈춤(문·열린 하부 접속 보류)
CH = OUTL["청운관"]
def clip_to_outline(p_out, p_in):
    ls = LineString([p_out, p_in]); q = ls.intersection(CH.exterior)
    q = q if q.geom_type == "Point" else min(q.geoms, key=lambda g: g.distance(Point(p_out))) if not q.is_empty else Point(p_in)
    return [round(q.x, 2), round(q.y, 2)]
a3e = clip_to_outline(nodes[PLAZA]["xy"], a3["coordinates_xy"][-1])
add_node("C1-N-A3E", a3e, None, "청운관 문턱 미확정", "A3 끝(청운관 외곽선 경계, 출입 접속 보류)")
add_road("C1-R-A3", PLAZA, "C1-N-A3E", "stairs", [nodes[PLAZA]["xy"], a3e], "A3 광장→청운관 계단", "그린 후보선만(그래프 미연결): 대일관 외곽선 모서리 통과 — 외벽 관통 여부 미확정")
roads["C1-R-A3"]["drawn_only"] = True
a5b_k, d_a5 = nearest_field(a5["coordinates_xy"][1])
a5t = clip_to_outline(list(a5b_k), a5["coordinates_xy"][0]) if CH.contains(Point(a5["coordinates_xy"][0])) else a5["coordinates_xy"][0]
add_node("C1-N-A5T", a5t, None, "청운관 문턱 미확정", "A5 상단(청운관 외곽선 경계, 열린 하부·문 접속 보류)")
add_node("C1-N-A5B", a5b_k, 148.9, f"SF-FIELD 셀 {a5b_k}", "A5 하단(운동장 셀)")
add_road("C1-R-A5", "C1-N-A5T", "C1-N-A5B", "stairs", [a5t, list(a5b_k)], "A5 청운관에서 운동장 하행 계단", "후보(청운관 출입 접속 보류)")
fl_a5 = field_link("C1-N-A5B", "A5")
# 사슬 2 -------------------------------------------------------------
side = U["C-옆길-연결"]["geometry"]["coordinates"]; n7895 = nid("7895ac0d")
add_node("C2-N-SIDE-MID", side[1], None, "z 미확정", "옆길 북단(뒤편 산책로와 만나는 꺾임)")
add_node("C2-N-SIDE-S", side[2], None, "z 미확정", "옆길 남단(GS25 B1 쪽, 문 위치 미확정)")
add_road("C2-R-SIDE", n7895, "C2-N-SIDE-S", "ordinary", side, "북악관 서측 옆길(GS25 B1 쪽으로 내려감, 사용자 명시)", "후보(B1 문 접속 보류)")
roads["C2-R-SIDE"]["xy"] = side; ops[-1]["note"] = "중간 꼭짓점 C2-N-SIDE-MID는 선 위 표시용(분기 없음)"
# ---- 그래프 ----
adj = defaultdict(list)
for k, r in roads.items():
    if any(k.startswith(d) for d in DELETED) or r.get("drawn_only"): continue
    adj[r["from"]].append((r["to"], k)); adj[r["to"]].append((r["from"], k))
def bfs(a, b, forbid=()):
    prev = {a: None}; q = deque([a]); forbid = set(forbid) - {a, b}
    while q:
        u = q.popleft()
        if u == b: break
        for v, k in adj[u]:
            if v not in prev and v not in forbid: prev[v] = (u, k); q.append(v)
    if b not in prev: return None
    path = []; u = b
    while prev[u]: u0, k = prev[u]; path.append(k); u = u0
    return list(reversed(path))
def comp(a):
    seen = {a}; q = deque([a])
    while q:
        u = q.popleft()
        for v, _ in adj[u]:
            if v not in seen: seen.add(v); q.append(v)
    return seen
# 출입 노드
EXIT_TOP = road("b14ac1da")["fromNodeId"]; ENTR = road("19800cee")["toNodeId"] if False else road("88ba01e6")["fromNodeId"]
DAEIL_IN = road("9a3cce3f")["fromNodeId"]; MAIN_GATE = road("8fde6a04")["toNodeId"]; B1 = road("95632bb8")["toNodeId"]
MUNYE_IN = road("23de6a42")["fromNodeId"]; DAEIL_SIDE = road("1f32cde9")["toNodeId"]; N141 = road("8e71c240")["fromNodeId"]
CHAINS = [
 ("1a 대일관 출구→EXIT 계단→하부 포장→A14→141 m 사잇길", [EXIT_TOP, "C1-N-EXITBOT", "C1-N-A14T", "C1-N-A14B", N141]),
 ("1b 대일관 실내→출구(문턱)", [DAEIL_IN, EXIT_TOP]),
 ("1c 높은 띠→광장→A2→운동장", [A1W, PLAZA, "C1-N-A2B", "C1-N-F-A2"]),
 ("1d 대일관 정문 앞 평탄부→높은 띠", [ENTR, A1W]),
 ("1e 청운관 계단(A5)→운동장", ["C1-N-A5T", "C1-N-A5B", "C1-N-F-A5"]),
 ("1f 광장→A3→청운관 실내", [PLAZA, "C1-N-A3E", "청운관 실내(노드 없음)"]),
 ("2a GS25 옆길 남단→뒤편 산책로→대일관 측면 출입", ["C2-N-SIDE-S", n7895, DAEIL_SIDE]),
 ("2b 뒤편 산책로→문예관 출입(직접)", [n7895, MUNYE_IN]),
 ("2c 옆길 남단→북악관 B1(GS25) 직접 문", ["C2-N-SIDE-S", "GS25 B1 문(노드 없음)"]),
 ("2d 북악관 정문(원형)→B1 진입 통로", [MAIN_GATE, B1]),
]
MAXLEG = {"1a": [6, 6, 3, 6], "2a": [2, 40], "2b": [25]}
res = []
for name, wps in CHAINS:
    legs = []
    for i in range(len(wps) - 1):
        a, b = ALIAS.get(wps[i], wps[i]), ALIAS.get(wps[i + 1], wps[i + 1])
        p = bfs(a, b, [ALIAS.get(w, w) for w in wps[:i]]) if (a in adj and b in adj) else None   # 앞 경유점으로 되돌아가는 우회 금지
        legs.append({"from": a[:16], "to": b[:16], "found": p is not None, "roads": [k[:20] for k in (p or [])],
                     "structures": [roads[k]["structure"] for k in (p or [])], "indoor": [roads[k]["indoor"] for k in (p or [])], "via_candidate": any(roads[k]["src"] != "운영 DRAFT" for k in (p or []))})
    res.append({"chain": name, "waypoints": [w[:16] for w in wps], "legs": legs, "found": all(l["found"] for l in legs)})
# 전(운영 스냅샷만): 각 사슬의 운영 노드 시작→끝
adj0 = defaultdict(list)
for r in R0: adj0[r["fromNodeId"]].append((r["toNodeId"], r["id"])); adj0[r["toNodeId"]].append((r["fromNodeId"], r["id"]))
def bfs0(a, b):
    prev = {a: None}; q = deque([a])
    while q:
        u = q.popleft()
        for v, k in adj0[u]:
            if v not in prev: prev[v] = (u, k); q.append(v)
    if b not in prev: return None
    n = 0; u = b
    while prev[u]: u = prev[u][0]; n += 1
    return n
for r_, (name, wps) in zip(res, CHAINS):
    a, b = wps[0], wps[-1]
    r_["before"] = ("운영 노드 아님(후보에서 새로 생김)" if (a not in adj0 or b not in adj0) else (f"연결 {bfs0(a, b)}도로" if bfs0(a, b) is not None else "미연결"))
# 접속점 Z 검사(같은 표면 셀만)
zc = []
for k, n in nodes.items():
    if n["src"] != "후보": continue
    zc.append({"node": k, "xy": n["xy"], "z_cand": n["z_cand"], "z_src": n["z_src"]})
# 끊긴 끝(사슬 지역)
box = (201000, 557200, 201245, 557425)
def inbox(xy): return box[0] <= xy[0] <= box[2] and box[1] <= xy[1] <= box[3]
dangling = [{"node": k[:12], "xy": [round(v, 1) for v in nodes[k]["xy"]], "road": adj[k][0][1][:20]} for k in adj if len(adj[k]) == 1 and inbox(nodes[k]["xy"])]
# 포털(실내↔실외 공유 노드)
portals = []
for k, lst in adj.items():
    kinds = {roads[r]["indoor"] for _, r in lst}
    if len(kinds) == 2: portals.append({"node": k[:12], "xy": [round(v, 1) for v in nodes[k]["xy"]], "z_op": nodes[k]["z_op"], "roads": [(r[:8], roads[r]["structure"]) for _, r in lst]})
# 외벽 관통 검사: 후보 도로가 건물 외곽선 내부를 2 m 넘게 지나는지
wall = []
for k, r in roads.items():
    if r["src"] == "운영 DRAFT" or r.get("drawn_only"): continue
    ls = LineString(r["xy"])
    for n, poly in OUTL.items():
        L = ls.intersection(poly.buffer(-0.5)).length
        if L > 2.0: wall.append({"road": k, "building": n, "inside_m": round(L, 1)})
out = {"created": "2026-10-10", "status": "후보 그래프 검토 데이터(운영 미적용, 승격 금지)", "base": {"roads": "roads-live-2.json", "sha256": SHA, "roads_n": len(R0), "nodes_n": len(N0)},
       "ops": ops, "chains": res, "candidate_nodes_z": zc, "dangling_in_area": dangling, "portals": portals, "wall_crossings": wall,
       "constraints": [{"id": "본관5F↔한림3F", "note": "안내 자막·내부 화면으로 층간 연결 존재(캠퍼스 소개 영상 근거). 운영 도로·노드에 해당 연결 없음. 연결 위치·바닥 z 미확정이라 그래프에 넣지 않고 제약으로만 기록"}],
       "deleted_not_restored": list(DELETED)}
json.dump(out, open(os.path.join(OUT, "path-graph-candidate.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
L = []
def chk(n, c, t=""): L.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
chk("사용자 삭제 도로 미복원", not any(k.startswith(d) for k in roads for d in DELETED))
L.append("INFO 그린 후보선만(그래프 미연결) | " + ", ".join(k for k, r in roads.items() if r.get("drawn_only")))
chk("그래프에 연결된 후보 도로가 건물 외곽선 내부를 2 m 넘게 지나지 않음(외벽 관통 없음)", not wall, json.dumps(wall, ensure_ascii=False))
chk("분할 후에도 공유 노드 연속(분할 부품 끝점이 같은 노드 좌표)", all(math.dist(roads[k]["xy"][-1], nodes[roads[k]["to"]]["xy"]) < 0.05 and math.dist(roads[k]["xy"][0], nodes[roads[k]["from"]]["xy"]) < 0.05 for k in roads if "#" in k))
chk("후보 노드 z는 같은 XY 같은 표면 셀 값 또는 null", all(n["z_cand"] is None or ("셀" in (n["z_src"] or "")) for n in nodes.values() if n["src"] == "후보"))
chk("정문 진입과 GS25 옆길 진입이 다른 노드", MAIN_GATE != "C2-N-SIDE-S")
for r_ in res:
    brk = [f"{l['from']}→{l['to']}" for l in r_["legs"] if not l["found"]]
    L.append(("PASS " if r_["found"] else "FAIL ") + "경로 " + r_["chain"] + f" | 전: {r_['before']} / 후 구간 " + ", ".join(f"{l['from']}→{l['to']}:{'O' if l['found'] else 'X'}({len(l['roads'])})" for l in r_["legs"]) + (f" / 끊김 {brk}" if brk else ""))
L.append(f"INFO A14 하단–8e71c240 거리 {g8:.1f} m → {'접속(≤3 m)' if a14_link else '미접속(>3 m, 끊김 유지)'}")
L.append(f"INFO 계단 하단 운동장 셀 이동 A2 {d_a2} m, A5 {d_a5} m / 운동장 면 접속 A2 {fl_a2} m, A5 {fl_a5} m (같은 SF-FIELD 면)")
L.append(f"INFO 사슬 지역 끊긴 끝 {len(dangling)}개 | " + json.dumps(dangling, ensure_ascii=False))
L.append(f"INFO 실내외 포털(공유 노드) {len(portals)}개")
open(os.path.join(OUT, "path-graph-checks.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
sys.exit(0)
