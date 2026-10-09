# 사진 2 대응 좌표(정문 원·옆길·뒤편 산책로)와 운영 스냅샷2 도로·노드 대조(읽기 전용).
# 사용법: match_user_paths.py <photo2-georef.json> <roads-live-2.json> <nodes-live-2.json> <출력 json>
import json, sys
from shapely.geometry import LineString, Point
if len(sys.argv) != 5: sys.exit("사용법: match_user_paths.py <photo2-georef.json> <roads-live-2.json> <nodes-live-2.json> <출력 json>")
G = json.load(open(sys.argv[1], encoding="utf-8"))
R = json.load(open(sys.argv[2], encoding="utf-8")); R = R["items"] if isinstance(R, dict) else R
N = json.load(open(sys.argv[3], encoding="utf-8")); N = N["items"] if isinstance(N, dict) else N
red = [tuple(p["xy"]) for p in G["red_line"]]
side = LineString(red[0:2]); back = LineString(red[1:])
circle = Point(G["circle_정문"]["center_5186"])
deg = {}
for r in R:
    for k in ("fromNodeId", "toNodeId"): deg[r.get(k)] = deg.get(r.get(k), 0) + 1
def near(geom, tol):
    out = []
    for r in R:
        c = r.get("coordinates") or []
        if len(c) < 2: continue
        ls = LineString([(p[0], p[1]) for p in c]); d = ls.distance(geom)
        if d <= tol:
            out.append({"id": r["id"], "dist_m": round(d, 1), "name": r.get("name"), "class": r.get("roadClass"), "structure": r.get("structure"),
                        "levelId": r.get("levelId"), "buildingId": r.get("buildingId"), "z": [min(p[2] for p in c), max(p[2] for p in c)],
                        "from": r.get("fromNodeId"), "to": r.get("toNodeId"), "ends": [c[0], c[-1]]})
    return sorted(out, key=lambda a: a["dist_m"])
watch = {}
for nid in ("596405f1", "04044da5", "6d0c13e7", "7895ac0d"):
    m = [n for n in N if n["id"].startswith(nid)]
    for n in m:
        watch[n["id"]] = {"xyz": n.get("coordinate"), "levelId": n.get("levelId"), "kind": n.get("kind"), "degree": deg.get(n["id"], 0),
                          "dist_side_m": None, "dist_back_m": None, "raw_keys": list(n.keys())}
        xy = watch[n["id"]]["xyz"]
        if xy and xy[0] is not None:
            watch[n["id"]]["dist_side_m"] = round(side.distance(Point(xy[0], xy[1])), 1); watch[n["id"]]["dist_back_m"] = round(back.distance(Point(xy[0], xy[1])), 1)
chain = [r for r in R if r["id"][:8] in ("8fde6a04", "ccdf841c", "951c157d")]
out = {"circle_정문_within_15m": near(circle.buffer(12), 3), "side_path_within_8m": near(side, 8), "back_path_within_8m": near(back, 8),
       "watched_nodes": watch, "chain_roads": [{"id": r["id"], "name": r.get("name"), "from": r["fromNodeId"], "to": r["toNodeId"], "coords": r["coordinates"],
                                                 "dist_side_m": round(LineString([(p[0], p[1]) for p in r["coordinates"]]).distance(side), 1),
                                                 "dist_back_m": round(LineString([(p[0], p[1]) for p in r["coordinates"]]).distance(back), 1)} for r in chain]}
json.dump(out, open(sys.argv[4], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for k in ("circle_정문_within_15m", "side_path_within_8m", "back_path_within_8m"):
    print(k, [(a["id"][:8], a["dist_m"], a["structure"], a["z"], a["levelId"] is not None, a["name"]) for a in out[k]])
print(json.dumps(watch, ensure_ascii=False)); print([(c["id"][:8], c["from"][:8], c["to"][:8], c["dist_side_m"], c["dist_back_m"]) for c in out["chain_roads"]])
