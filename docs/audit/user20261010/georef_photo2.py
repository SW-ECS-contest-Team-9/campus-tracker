# 사용자 사진 2(네이버 위성지도, 북쪽 위) 표시 위치를 EPSG:5186으로 옮기는 아핀 대응(읽기 전용).
# 기준점: 사진 속 북악관 지붕 모서리 3개(판독) ↔ building-outlines-5186 북악관 꼭짓점. 검증점: 문예관 꼭짓점·북악관 남 모서리.
# 사용법: georef_photo2.py <building-outlines-5186.json> <출력 json>
import json, sys
import numpy as np
if len(sys.argv) != 3: sys.exit("사용법: georef_photo2.py <building-outlines-5186.json> <출력 json>")
B = {b["name"]: b["coordinates"][0][0] for b in json.load(open(sys.argv[1], encoding="utf-8"))}
bk = B["북악관"]  # [S 201094.7,557376.0]? 실제 순서: 0 E(201094.7,557376.0) 1 S(201082.5,557350.6) 2 W(201004.8,557387.2) 3 N(201016.5,557412.1)
CTRL = [((313, 398), bk[2]), ((388, 238), bk[3]), ((885, 490), bk[0])]   # 사진 px(판독) ↔ 외곽선
CHECK = [((835, 640), bk[1], "북악관 남 모서리")]
src = np.array([[p[0], p[1], 1] for p, _ in CTRL], float); dst = np.array([q for _, q in CTRL], float)
M = np.linalg.solve(src, dst)   # 3점 정확 아핀
f = lambda px: (np.array([px[0], px[1], 1.0]) @ M).round(2).tolist()
chk = [{"name": n, "px": p, "mapped": f(p), "outline": q, "err_m": round(float(np.hypot(*(np.array(f(p)) - np.array(q)))), 2)} for p, q, n in CHECK]
RED = [(295, 395), (385, 198), (560, 255), (900, 470), (1000, 525), (1060, 560), (1105, 635), (1170, 662), (1245, 676)]
out = {"photo": "사용자-뒤편산책로-20261010/사진-2.png", "method": "북악관 지붕 모서리 3점 아핀(지붕≈외곽선 가정, 판독 ±5px≈±0.8m, 지붕·외곽선 차 포함 오차 ±5m 가정)",
       "affine_px_to_5186": M.round(6).tolist(), "check": chk, "scale_m_per_px": round(float(np.hypot(*(np.array(f((100, 0))) - np.array(f((0, 0)))))) / 100, 4),
       "circle_정문": {"px_center": [548, 580], "px_radius": 80, "center_5186": f((548, 580))},
       "red_line": [{"px": p, "xy": f(p)} for p in RED]}
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps({k: out[k] for k in ("check", "scale_m_per_px", "circle_정문")}, ensure_ascii=False)); print(out["red_line"])
