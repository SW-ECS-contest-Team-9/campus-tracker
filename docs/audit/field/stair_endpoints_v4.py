# 계단 끝점 재대응 v4: ST-DAEIL-EXIT-SIDE, ST-A14 의 물리 접속점 XY·소속 표면·z 출처를 기록 (운영 값 덮어쓰기·일괄 상향 없음).
# 사용법: stair_endpoints_v4.py <field-surfaces-v3.geojson> <field-structure-patch-v2.json> <smap-mesh-reads-v3.json> <roads-live-2.json> <출력 폴더>
import json, sys, os, math
from shapely.geometry import shape, Point
if len(sys.argv) != 6: sys.exit("사용법: stair_endpoints_v4.py <field-surfaces-v3.geojson> <patch-v2.json> <mesh-reads-v3.json> <roads-live-2.json> <출력 폴더>")
FS, P2, MR, RD, OUT = sys.argv[1:]
V3 = {f["properties"]["id"]: f for f in json.load(open(FS, encoding="utf-8"))["features"]}
P = json.load(open(P2, encoding="utf-8")); M = json.load(open(MR, encoding="utf-8"))
R = json.load(open(RD, encoding="utf-8")); R = R["items"] if isinstance(R, dict) else R; RO = {r["id"][:8]: r for r in R}
MESH_SETS = {"사잇길 메시": M["corridor_cells"], "높은띠 메시": M["high_strip_cells"], "전이 메시": M["wall_transition_cells"]}
SURF = [k for k in V3 if k.startswith("SF-")]
def membership(x, y):
    p = Point(x, y); inside = [k for k in SURF if V3[k]["geometry"] and shape(V3[k]["geometry"]).contains(p)]
    near = sorted(((round(shape(V3[k]["geometry"]).distance(p), 2), k) for k in SURF if V3[k]["geometry"]))[:3]
    return inside, near
def mesh_z(x, y):
    best = None
    for name, cells in MESH_SETS.items():
        for c in cells:
            d = math.dist((x, y), c[:2])
            if best is None or d < best[0]: best = (round(d, 2), name, c)
    return {"z": best[2][2], "src": f"{best[1]} 셀 ({best[2][0]},{best[2][1]})", "dist_m": best[0]}
pins = P["samples"]
def near_pins(x, y, k=3):
    return sorted(({"id": s["id"], "value": s["value"], "surface": s["surface"], "dist_m": round(math.dist((x, y), s["xy"]), 1), "map_err_m": s["err_m"]} for s in pins), key=lambda a: a["dist_m"])[:k]
ends = []
def end(stair, role, x, y, op_z, op_src, photo_note, verdict, why):
    ins, nr = membership(x, y)
    ends.append({"stair": stair, "role": role, "xy": [round(x, 2), round(y, 2)], "surface_inside": ins, "surface_nearest": nr, "mesh": mesh_z(x, y),
                 "operational_z": op_z, "operational_src": op_src, "photo_pins_near": near_pins(x, y), "photo_note": photo_note, "verdict": verdict, "why": why})
b14, cd0, f2 = RO["b14ac1da"], RO["00cd9c0f"], RO["2f206e6c"]
t = b14["coordinates"][0]; bt = f2["coordinates"][-1]; ld = cd0["coordinates"][0]
end("ST-DAEIL-EXIT-SIDE", "상단(출구)", t[0], t[1], t[2], "운영 b14ac1da 시작(DRAFT, 고도 추정)",
    "사진27: 상부 출구에서 내려다보는 좁은 하행 계단. 출구 바닥 z는 사진에 수치 없음",
    "연결 미검증", "지점이 대일관 돌출 지붕 아래(메시는 지붕 158 또는 띠 151대)라 지면 z를 메시로 읽을 수 없음. 출입부 앞 포장(149.1~150.1)과 같은 바닥인지 확인 자료 없음")
end("ST-DAEIL-EXIT-SIDE", "중간 계단참", ld[0], ld[1], ld[2], "운영 00cd9c0f(DRAFT)", "사진27: 계단참 존재는 보이나 위치·높이 수치 없음", "형태 확인·위치 미검증",
    "사진27은 회전된 영상 화면으로 좌표 기준점이 없음")
end("ST-DAEIL-EXIT-SIDE", "하단", bt[0], bt[1], bt[2], "운영 2f206e6c 끝(DRAFT)",
    "사진27: 아래 넓은 포장 공간. 사진8 근접 핀 145.4(대일관 벽 앞)는 이 끝점에서 약 14 m 떨어져 다른 지점",
    "연결 미검증", "하단 XY의 메시 값은 운동장 쪽 경사(149대)로 번진 값이라 하부 포장 z로 쓸 수 없음. 하부 포장이 618385b9(운영 143.8)인지 145.4 면인지 미확정")
a14 = next(o for o in P["ops"] if o.get("id") == "NEW-A14")
(xa, ya), (xb, yb) = a14["coordinates_xy"]
end("ST-A14", "상단(618385b9 분할점)", xa, ya, a14["z_ends_from_existing"][0], "운영 618385b9(DRAFT, 평탄 143.8)",
    "사진8 핀 145.4(대일관 벽 앞 면, 대응 오차 3 m)가 약 3~4 m 거리", "소속 후보 확인: 대일관 벽 앞 면(145.4)",
    "가장 가까운 사진 표본이 같은 면(벽 앞 포장)으로 대응. 다만 운영 z 143.8과 1.6 m 차이 — 운영 값은 덮어쓰지 않음")
end("ST-A14", "하단(8e71c240 분할점)", xb, yb, a14["z_ends_from_existing"][1], "운영 8e71c240(ramp, 양 끝 141.73)",
    "사진8 핀 141.4/141.9(사잇길 낮은 길)는 대응 오차 15 m로 미확정", "연결 미검증", "하단 면 표본 대응이 약함")
for e in ends:
    e["diff_mesh_minus_operational"] = round(e["mesh"]["z"] - e["operational_z"], 2) if e["operational_z"] is not None else None
out = {"created": "2026-10-10", "accuracyVerified": False, "status": "검토 데이터. 운영 값·계단 높이 변경 없음",
       "note": "−5.15/−1.69/−1.59 m 같은 차이는 출처가 다른 면(운영 DRAFT vs S-MAP 메시) 사이 값이며 계단 실측 오차가 아님. 이 차이로 계단을 올리지 않음", "endpoints": ends}
json.dump(out, open(os.path.join(OUT, "stair-endpoints-v4.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
L = []
def chk(n, c, t=""): L.append(("PASS " if c else "FAIL ") + n + (" | " + t if t else ""))
chk("모든 끝점에 XY·소속·z 출처 기록", all(e["xy"] and (e["surface_inside"] or e["surface_nearest"]) and e["mesh"]["src"] and e["operational_src"] for e in ends), str(len(ends)))
chk("운영 z 변경 없음(입력 그대로)", ends[0]["operational_z"] == b14["coordinates"][0][2] and ends[2]["operational_z"] == f2["coordinates"][-1][2])
chk("미확정 끝점은 '연결 미검증' 유지", all(("미검증" in e["verdict"]) or e["verdict"].startswith("소속 후보") for e in ends))
for e in ends: L.append(f"INFO {e['stair']} {e['role']} | xy {e['xy']} 안쪽면 {e['surface_inside']} 메시 {e['mesh']['z']}({e['mesh']['src']}, {e['mesh']['dist_m']} m) 운영 {e['operational_z']} 차 {e['diff_mesh_minus_operational']} → {e['verdict']}")
open(os.path.join(OUT, "stair-endpoints-v4-checks.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n"); print("\n".join(L))
sys.exit(1 if any(l.startswith("FAIL") for l in L) else 0)
