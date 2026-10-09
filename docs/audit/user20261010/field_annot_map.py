# 사용자 운동장 구조 주석 지도(운동장-구조표시.png, 네이버 위성, 북쪽 위) → EPSG:5186 대응 + 운영 도로 대조 (읽기 전용).
# 기준점: 운동장 평탄면(S-MAP 메시 z 148.9 연결 성분, 2026-10-10 뷰어 표본) 모서리 ↔ 주석 지도 운동장 모서리(판독).
#   지면 높이 기준점이라 건물 지붕 변위가 없다. 대신 모서리 판독 ±10 px와 성분 경계 2 m 격자 오차가 있다.
# 사용법: field_annot_map.py <roads-live-2.json> <building-outlines-5186.json> <출력 폴더>
import json, sys, os
import numpy as np
from shapely.geometry import LineString, Polygon, Point, mapping
if len(sys.argv) != 4: sys.exit("사용법: field_annot_map.py <roads-live-2.json> <building-outlines-5186.json> <출력 폴더>")
ROADS, OUTL, OUT = sys.argv[1:]
CTRL = [((300, 250), (201150.0, 557308.0), "운동장 북 모서리"), ((975, 575), (201240.0, 557256.0), "운동장 동 모서리"),
        ((195, 775), (201136.0, 557228.0), "운동장 서단 꺾임점")]
# 닮음 변환(회전·축척·이동, 4 매개변수) 최소제곱
A = []; b = []
# 화면 y는 아래로 증가하므로 v' = -v 로 뒤집어 닮음 변환(반사 없음)을 맞춘다
for (u, v), (x, y), _ in CTRL:
    A += [[u, v, 1, 0], [-v, u, 0, 1]]; b += [x, y]
p, *_ = np.linalg.lstsq(np.array(A, float), np.array(b, float), rcond=None)
def f(u, v): return (round(p[0] * u + p[1] * v + p[2], 2), round(p[1] * u - p[0] * v + p[3], 2))
res = [{"name": n, "px": [u, v], "target": [x, y], "mapped": f(u, v), "resid_m": round(float(np.hypot(f(u, v)[0] - x, f(u, v)[1] - y)), 2)} for (u, v), (x, y), n in CTRL]
scale = float(np.hypot(p[0], p[1])); rot = float(np.degrees(np.arctan2(-p[1], p[0])))
ERR = max(r["resid_m"] for r in res) + 4.0   # 잔차 + 주석 선 굵기·판독(약 ±25 px≈3.5 m) 여유
# 주석 구조(판독 px). 선 = 중심선 근사, 다각형 = 빨간 사각 테두리
ANN = [
 ("A1", "운동장 대비 2미터 이상 높은 좁은 가장자리 길", "line", [(300, 222), (480, 255), (600, 270), (715, 300)]),
 ("A2", "2미터 이상 높은 길에서 내려오는 계단", "poly", [(705, 300), (750, 312), (735, 360), (700, 350)]),
 ("A3", "내려가지 않고 광장에서 청운관으로 가는 계단(판독)", "poly", [(770, 310), (805, 330), (795, 378), (752, 352)]),
 ("A4", "청운관 쪽 돌출 지붕(문구 미확정: '청운관 지붕 2미터 …더 높은 지붕')", "poly", [(805, 300), (930, 435), (870, 420), (820, 395)]),
 ("A5", "청운관에서 내려오는 계단", "poly", [(875, 425), (935, 495), (918, 512), (858, 440)]),
 ("A6", "대일관 출입문 앞 튀어나온 지붕", "poly", [(350, 118), (432, 152), (410, 205), (330, 172)]),
 ("A7", "대일관 진입로 계단", "poly", [(330, 172), (390, 195), (378, 230), (318, 205)]),
 ("A8", "진입로 계단(운동장 서북 모서리)", "poly", [(272, 252), (300, 255), (295, 312), (266, 310)]),
 ("A9", "운동장 서측 가장자리 띠(조금 높은 화단 옆)", "line", [(282, 312), (262, 470), (240, 600)]),
 ("A10", "화단 사이 진입로", "poly", [(218, 598), (242, 602), (228, 682), (204, 678)]),
 ("A11", "운동장 서측 띠 남단", "line", [(216, 682), (198, 775)]),
 ("A12", "대일관 앞 긴 띠(상단선, 좀 높은 화단 쪽)", "line", [(10, 88), (200, 140), (330, 168)]),
 ("A13", "기본 내리막길(대일관 서측, 한림관 동측)", "line", [(180, 222), (290, 255)]),
 ("A14", "화단을 가로지르며 기본 내리막길로 빠지는 하행 계단", "poly", [(168, 98), (205, 110), (192, 152), (158, 140)]),
 ("A15", "계단 이후 잠깐의 평지", "poly", [(60, 28), (200, 70), (190, 92), (50, 52)]),
 ("A16", "혜인관 쪽 계단·돌출 지붕(문구 미확정)", "poly", [(888, 775), (910, 785), (820, 945), (800, 935)]),
]
R = json.load(open(ROADS, encoding="utf-8")); R = R["items"] if isinstance(R, dict) else R
feats, match = [], {}
for aid, desc, kind, pts in ANN:
    xy = [f(u, v) for u, v in pts]
    g = LineString(xy) if kind == "line" else Polygon(xy + [xy[0]])
    near = []
    for r in R:
        c = r.get("coordinates") or []
        if len(c) < 2: continue
        ls = LineString([(q[0], q[1]) for q in c]); d = ls.distance(g)
        if d <= ERR:
            near.append({"id": r["id"], "dist_m": round(d, 1), "name": r.get("name"), "structure": r.get("structure"), "class": r.get("roadClass"),
                         "z": [c[0][2], c[-1][2]], "from": r.get("fromNodeId"), "to": r.get("toNodeId"), "ends_xy": [[round(c[0][0], 1), round(c[0][1], 1)], [round(c[-1][0], 1), round(c[-1][1], 1)]]})
    near.sort(key=lambda a: a["dist_m"]); match[aid] = {"desc": desc, "near": near}
    feats.append({"type": "Feature", "properties": {"id": aid, "desc": desc, "err_xy_m_assumed": round(ERR, 1), "accuracyVerified": False,
                  "roads_within_err": [a["id"][:8] for a in near]}, "geometry": mapping(g)})
fc = {"type": "FeatureCollection", "name": "user-field-annotation-mapping", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5186"}},
      "properties": {"source": "사용자-운동장구조-20261010/운동장-구조표시.png", "transform": "닮음 변환(운동장 모서리 3점, S-MAP 지면 148.9)", "scale_m_per_px": round(scale, 4),
                     "rotation_deg": round(rot, 2), "control": res, "err_xy_m_assumed": round(ERR, 1), "note": "2D, z 없음. 주석 도형은 측량 도형이 아님"}, "features": feats}
json.dump(fc, open(os.path.join(OUT, "field-annotation-5186.geojson"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
json.dump(match, open(os.path.join(OUT, "field-annotation-match.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("scale", round(scale, 4), "rot", round(rot, 2), "resid", [r["resid_m"] for r in res], "ERR", round(ERR, 1))
for aid, m in match.items(): print(aid, m["desc"][:22], [(a["id"][:8], a["dist_m"], a["structure"], a["z"]) for a in m["near"][:6]])
