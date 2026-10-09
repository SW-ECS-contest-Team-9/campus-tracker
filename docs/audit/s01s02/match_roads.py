# S01·S02 후보 위치(뷰어 역투영 좌표)와 운영 스냅샷2 도로 객체 대응(읽기 전용). 출력: vault claude-s01s02/model-match.json
import json, sys, os
from shapely.geometry import Point, LineString, Polygon
V = sys.argv[1]; A = os.path.join(V, "..")
roads = json.load(open(os.path.join(A, "claude-live", "roads-live-2.json"), encoding="utf-8")); roads = roads["items"] if isinstance(roads, dict) else roads
C = {  # id: (설명, [(x,y,z_mesh)...]) — S-MAP getCoordinate3dFromPixel 2026-10-09
 "S01-A": ("남측 차량 진입부(횡단보도·분기)", [(201125.86, 557121.04, 107.10), (201133.08, 557105.39, 107.04), (201135.49, 557099.37, 107.04), (201130.69, 557089.73, 106.49)]),
 "S01-B": ("대일관 돌출 출입부 앞 포장면", [(201151.93, 557309.04, 149.37), (201155.70, 557308.75, 149.95), (201159.81, 557307.42, 150.10), (201155.79, 557306.38, 149.08)]),
 "S02-A": ("운동장 북측(대일관 전면) 상승 띠", [(201179.51, 557296.47, 149.50), (201179.49, 557301.11, 150.54), (201179.47, 557303.40, 151.57), (201171.49, 557305.82, 151.26), (201181.20, 557302.59, 151.48), (201162.12, 557304.91, 149.53)]),
 "S02-B": ("운동장 서측(은주관 서측 동 앞) 가장자리 단", [(201141.42, 557263.65, 149.46), (201138.49, 557263.65, 149.79)]),
}
out = {}
for cid, (desc, pts) in C.items():
    near = {}
    for r in roads:
        c = r.get("coordinates") or []
        if len(c) < 2: continue
        ls = LineString([(p[0], p[1]) for p in c])
        d = min(ls.distance(Point(x, y)) for x, y, _ in pts)
        if d <= 10: near[r["id"][:8]] = {"dist_m": round(d, 1), "name": r.get("name"), "structure": r.get("structure"), "z_range": [min(p[2] for p in c), max(p[2] for p in c)]}
    out[cid] = {"desc": desc, "points": pts, "roads_within_10m": dict(sorted(near.items(), key=lambda kv: kv[1]["dist_m"]))}
json.dump(out, open(os.path.join(V, "model-match.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for k, v in out.items(): print(k, v["desc"], {a: (b["dist_m"], b["structure"], b["z_range"]) for a, b in v["roads_within_10m"].items()})
