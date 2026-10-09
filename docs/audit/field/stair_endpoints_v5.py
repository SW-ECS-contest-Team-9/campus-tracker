# 계단 끝점 v5: 사진27(대일관 출구 옆 하행 계단)·사진8 표본과 S-MAP 메시 평탄부로 ST-DAEIL-EXIT-SIDE·ST-A14 끝점을 다시 정한다.
# 원칙: 가장 가까운 메시 z를 계단 바닥으로 바로 쓰지 않음(지붕·전이 면 제외). 운영 DRAFT z는 정답이 아님 — 덮어쓰기·일괄 이동 없음.
#       끝점마다 소속 면, z 출처, 하행 단조 검사, 상태(확인/미검증).
# 사용법: stair_endpoints_v5.py <smap-mesh-reads-v3.json> <field-structure-patch-v2.json> <roads-live-2.json> <출력 폴더>
import json, sys, os, math
from shapely.geometry import LineString, Point, mapping
if len(sys.argv) != 5: sys.exit("사용법: stair_endpoints_v5.py <mesh-reads-v3.json> <patch-v2.json> <roads-live-2.json> <출력 폴더>")
MR, P2, RD, OUT = sys.argv[1:]
M = json.load(open(MR, encoding="utf-8")); P = json.load(open(P2, encoding="utf-8"))
R = json.load(open(RD, encoding="utf-8")); R = R["items"] if isinstance(R, dict) else R; RO = {r["id"][:8]: r for r in R}
CC = {(c[0], c[1]): c[2] for c in M["corridor_cells"]}
pin = {s["id"]: s for s in P["samples"]}
# 145 m대 평탄부(대일관 벽 앞 하부 포장): 사잇길 메시 셀 중 145.2~146.0 이고 4방향 이웃 |dz|<=0.6 인 연결 성분 (계단·경사 셀 제외)
flat = {k for k, z in CC.items() if 145.2 <= z <= 146.0 and all(abs(CC.get((k[0] + a, k[1] + b), z) - z) <= 0.6 for a, b in ((2, 0), (-2, 0), (0, 2), (0, -2)))}
seed = min(flat, key=lambda k: math.dist(k, pin["P8-145.4"]["xy"])); comp = {seed}; st = [seed]
while st:
    a = st.pop()
    for d in ((2, 0), (-2, 0), (0, 2), (0, -2)):
        b = (a[0] + d[0], a[1] + d[1])
        if b in flat and b not in comp: comp.add(b); st.append(b)
plateau_z = sorted(CC[k] for k in comp)
xs = [k[0] for k in comp]; plateau_east_x = max(xs)
# 141 m대 낮은 길(기본 내리막길) 셀: 140.8~142.2
low = sorted(((k, z) for k, z in CC.items() if 140.8 <= z <= 142.2), key=lambda kz: math.dist(kz[0], pin["P8-141.4"]["xy"]))
b14, f2 = RO["b14ac1da"], RO["2f206e6c"]
top_xy = b14["coordinates"][0][:2]
chain = LineString([(p[0], p[1]) for r in (b14, RO["00cd9c0f"], f2) for p in r["coordinates"]])
# 출구 옆 계단 하단 이동: 기존 사슬 방향(서쪽)으로 연장해 평탄부 동쪽 가장자리 셀 중 사슬 연장선에 가장 가까운 셀
dx, dy = chain.coords[-1][0] - chain.coords[0][0], chain.coords[-1][1] - chain.coords[0][1]; L = math.hypot(dx, dy); ux, uy = dx / L, dy / L
ext = LineString([chain.coords[0], (chain.coords[0][0] + ux * 40, chain.coords[0][1] + uy * 40)])
edge_cells = [k for k in comp if (k[0] + 2, k[1]) not in comp]
bot = min(edge_cells, key=lambda k: ext.distance(Point(k)))
pave = [(201151.93, 557309.04, 149.37), (201155.70, 557308.75, 149.95), (201159.81, 557307.42, 150.10), (201155.79, 557306.38, 149.08)]
ends = []
def E(stair, role, xy, surface, z, zsrc, status, why, extra=None):
    d = {"stair": stair, "role": role, "xy": [round(xy[0], 2), round(xy[1], 2)], "surface": surface, "z": z, "z_src": zsrc, "status": status, "why": why}
    if extra: d.update(extra)
    ends.append(d)
E("ST-DAEIL-EXIT-SIDE", "상단(출구 바닥, 돌출 지붕 아래)", top_xy, "대일관 출구 바닥(지붕 아래 통로 면)", [min(p[2] for p in pave), max(p[2] for p in pave)],
  "S01-B 역투영 4점(출입부 앞 포장, 같은 바닥으로 가정 — 미검증) 범위. 지붕 아래 메시(158/151대)는 쓰지 않음", "미검증",
  "사진27은 계단 위에서 내려다본 시점이라 출구 바닥 높이 수치 없음. 출입부 앞 포장과 같은 바닥인지 사진으로 확인 못 함")
E("ST-DAEIL-EXIT-SIDE", "하단(하부 포장 접속, 이동 제안)", bot, "대일관 벽 앞 하부 포장(145 m대 평탄부)", CC[bot],
  f"메시 평탄 성분 셀 {bot} (성분 {len(comp)}셀, z {plateau_z[0]}~{plateau_z[-1]}) + 사진8 핀 145.4(대응 오차 3 m)", "확인(위치 ±3 m)",
  "사진27: 계단 아래 넓은 포장·곡선 화단, 앞쪽에 문예관 저층 유리부 → 대일관 서남쪽 벽 앞 평탄부. 기존 하단(2f206e6c 끝)은 운동장 쪽 경사(메시 149.7)라 하부 포장이 아님",
  {"moved_from": [round(f2["coordinates"][-1][0], 2), round(f2["coordinates"][-1][1], 2)], "move_dist_m": round(math.dist(f2["coordinates"][-1][:2], bot), 1)})
E("ST-DAEIL-EXIT-SIDE", "중간 계단참", RO["00cd9c0f"]["coordinates"][0][:2], "계단참(위치 미검증)", None, "없음(사진27 형태만)", "미검증", "좌표 기준점 없음")
# A14
a14 = next(o for o in P["ops"] if o.get("id") == "NEW-A14"); (xa, ya), (xb, yb) = a14["coordinates_xy"]
ta = min(comp, key=lambda k: math.dist(k, (xa, ya)))
E("ST-A14", "상단", (xa, ya), "대일관 벽 앞 하부 포장(145 m대 평탄부)", CC[ta], f"메시 평탄 성분 셀 {ta}, 사진8 핀 145.4와 같은 면", "확인(위치 ±3 m)",
  "145.5/145.4는 평탄부(상부 벽 앞 면) 값. 141 m 길 값이 아님")
lb = low[0]
E("ST-A14", "하단(141 m대 낮은 길 접속, 이동 제안)", lb[0], "기본 내리막길(141 m대)", lb[1], f"메시 셀 {lb[0]} + 사진8 핀 141.4(대응 오차 15 m, 약함)", "미검증",
  "기존 하단(201129.8,557313.8)은 메시 145.4로 평탄부 쪽이라 141 m 길에 닿지 않음. 141 m대 셀까지 이동 제안", {"moved_from": [round(xb, 2), round(yb, 2)], "move_dist_m": round(math.dist((xb, yb), lb[0]), 1)})
def zmax(z): return max(z) if isinstance(z, list) else z
def zmin(z): return min(z) if isinstance(z, list) else z
mono = {}
for s in ("ST-DAEIL-EXIT-SIDE", "ST-A14"):
    t = next(e for e in ends if e["stair"] == s and e["role"].startswith("상단")); b = next(e for e in ends if e["stair"] == s and e["role"].startswith("하단"))
    mono[s] = {"top_min": zmin(t["z"]), "bottom": b["z"], "descending": zmin(t["z"]) > b["z"]}
geo = {"type": "FeatureCollection", "name": "stairs-moved-v5", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
       "features": [{"type": "Feature", "properties": {"id": "ST-DAEIL-EXIT-SIDE-V5", "status": "제안(하단 확인, 상단 미검증)", "z_top_range": ends[0]["z"], "z_bottom": ends[1]["z"], "err_xy_m": 3.0, "steps": None, "width_m": None,
                     "note": "기존 사슬 방향 유지, 하단만 평탄부 가장자리로 연장. 계단참 위치 미검증"}, "geometry": mapping(LineString([top_xy, bot]))},
                    {"type": "Feature", "properties": {"id": "ST-A14-V5", "status": "제안(상단 확인, 하단 미검증)", "z_top": ends[3]["z"], "z_bottom": ends[4]["z"], "err_xy_m": 3.0, "steps": None},
                     "geometry": mapping(LineString([(xa, ya), lb[0]]))}]}
json.dump(geo, open(os.path.join(OUT, "stairs-moved-v5.geojson"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
json.dump({"created": "2026-10-10", "accuracyVerified": False, "status": "검토 데이터. 운영 승격·일괄 z 이동 없음", "plateau": {"cells": len(comp), "z": [plateau_z[0], plateau_z[-1]], "east_x": plateau_east_x},
           "endpoints": ends, "monotonic": mono}, open(os.path.join(OUT, "stair-endpoints-v5.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
Lc = []
def chk(n, c, t=""): Lc.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
chk("끝점마다 소속 면·z 출처·상태 기록", all(e["surface"] and e["z_src"] and e["status"] for e in ends), str(len(ends)))
chk("지붕·전이 메시 값을 계단 바닥 z로 쓰지 않음", all("158" not in str(e["z"]) and (e["z"] is None or zmax(e["z"]) < 151.0) for e in ends))
chk("하행 단조(상단 > 하단)", all(v["descending"] for v in mono.values()), json.dumps(mono, ensure_ascii=False))
chk("운영 z 미변경(입력 파일 그대로 사용)", RO["b14ac1da"]["coordinates"][0][2] == 145.8 and RO["2f206e6c"]["coordinates"][-1][2] == 143.8)
Lc.append(f"INFO 평탄부 | 셀 {len(comp)}, z {plateau_z[0]}~{plateau_z[-1]}, 동쪽 가장자리 x {plateau_east_x}")
for e in ends: Lc.append(f"INFO {e['stair']} {e['role']} | {e['xy']} {e['surface']} z={e['z']} → {e['status']}" + (f" (이동 {e.get('move_dist_m')} m)" if e.get("move_dist_m") else ""))
open(os.path.join(OUT, "stair-endpoints-v5-checks.txt"), "w", encoding="utf-8").write("\n".join(Lc) + "\n"); print("\n".join(Lc))
sys.exit(1 if any(l.startswith("FAIL") for l in Lc) else 0)
