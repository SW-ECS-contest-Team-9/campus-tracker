# G01: 로그인 없이 물을 수 있는 전 지구 DEM 을 기준점 10곳에서 읽어 S-MAP 표고 조회값·서버 지형과 견준다. 읽기 전용, 원문 응답 저장.
#   python -I global_dem.py <audit 폴더(3d-map-audit-20261009)> <출력 raw.json> <요약 json>
# 조회처: Copernicus GLO-30 = Microsoft Planetary Computer 점 조회, SRTM 30 m·ASTER 30 m·Mapzen = OpenTopoData 공개 API,
#         Open-Meteo 표고(Copernicus GLO-90 바탕), 기준 = S-MAP 표고 조회 dem_z. 보내는 것은 좌표뿐.
import sys, json, math, time, urllib.request, urllib.parse
import os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'e05'))
from tm5186 import to5186
import numpy as np
AUD, RAW, OUT = sys.argv[1:4]
PTS = [  # 이름, x, y (EPSG:5186), 기록된 기준 높이와 그 출처
 ("운동장 표고점(혜인관 앞)", 201212.01, 557220.80, 148.91, "1:5,000 표고점 + 휴대폰 기압(E06)"),
 ("운동장 안쪽", 201180.0, 557260.0, 148.9, "E06 측정"),
 ("대일관 앞 운동장 북쪽 끝", 201157.33, 557301.30, 148.88, "S-MAP 조회(10-09)"),
 ("유담관 분수 광장", 201055.30, 557219.12, 114.1, "S-MAP 메시(E08·T04)"),
 ("정문 안 차도", 201131.14, 557106.97, 107.0, "S-MAP 메시(E09)"),
 ("분수 광장 동쪽 차도", 201089.11, 557219.18, 114.1, "S-MAP 메시(E09)"),
 ("주오르막 굽이", 201072.18, 557274.12, 122.1, "S-MAP 메시(E09)"),
 ("본관 서쪽 회차 공간", 201023.04, 557326.10, 129.4, "S-MAP 메시(E09)"),
 ("북악관 서쪽 끝 앞(광장 모서리)", 201005.0, 557388.0, 131.4, "S-MAP 메시(E08)"),
 ("서문 앞 공도", 200973.89, 557400.0, 117.0, "S-MAP 메시(E09)"),
]
def lonlat(x, y):  # to5186 의 역: 뉴턴 반복
    lon, lat = 127.0, 37.6
    for _ in range(8):
        fx, fy = to5186(lon, lat); lon += (x - fx) / (111320 * math.cos(math.radians(lat))); lat += (y - fy) / 110950
    return lon, lat
def get(url, data=None, hdr=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=hdr or {"User-Agent": "Mozilla/5.0"}), timeout=40) as r: return r.read().decode()
    except Exception as e: return repr(e)
ll = [lonlat(x, y) for _, x, y, _, _ in PTS]; raw = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "lonlat": ll, "glo30": [], "smap": []}
loc = "|".join(f"{la:.6f},{lo:.6f}" for lo, la in ll)
for ds in ("srtm30m", "aster30m", "mapzen"):
    raw[ds] = get(f"https://api.opentopodata.org/v1/{ds}?locations={loc}&interpolation=bilinear"); time.sleep(1.5)
raw["openmeteo"] = get("https://api.open-meteo.com/v1/elevation?latitude=" + ",".join(f"{la:.6f}" for _, la in ll) + "&longitude=" + ",".join(f"{lo:.6f}" for lo, _ in ll))
for (lo, la), (_, x, y, _, _) in zip(ll, PTS):
    raw["glo30"].append(get(f"https://planetarycomputer.microsoft.com/api/data/v1/item/point/{lo:.6f},{la:.6f}?collection=cop-dem-glo-30&item=Copernicus_DSM_COG_10_N37_00_E127_00_DEM&assets=data"))
    raw["smap"].append(get("https://smap.seoul.go.kr/measure/getMeasureElevation3d.do", urllib.parse.urlencode({"x": x, "y": y}).encode(), {"User-Agent": "Mozilla/5.0", "Referer": "https://smap.seoul.go.kr/"})); time.sleep(1.2)
json.dump(raw, open(RAW, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
m = json.load(open(AUD + "/terrain-grid-meta.json")); g = np.fromfile(AUD + "/terrain-grid.f32", dtype="<f4").reshape(m["height"], m["width"])
def grid(x, y):
    fx, fy = (x - m["originX"]) / 2 - .5, (y - m["originY"]) / 2 - .5; i, j = int(fx), int(fy); tx, ty = fx - i, fy - j
    return float(g[j, i] * (1 - tx) * (1 - ty) + g[j, i + 1] * tx * (1 - ty) + g[j + 1, i] * (1 - tx) * ty + g[j + 1, i + 1] * tx * ty)
col = {"glo30": [json.loads(r)["values"][0] for r in raw["glo30"]], "openmeteo_glo90": json.loads(raw["openmeteo"])["elevation"]}
for ds in ("srtm30m", "aster30m", "mapzen"): col[ds] = [r["elevation"] for r in json.loads(raw[ds])["results"]]
col["server2015"] = [grid(x, y) for _, x, y, _, _ in PTS]
smap = [json.loads(r)["result"] for r in raw["smap"]]
rows = [{"name": n, "x": x, "y": y, "lon": round(lo, 6), "lat": round(la, 6), "recorded": z, "recordedFrom": src, "smapDem": round(s["dem_z"], 2), "smapBuld": s["buld_z"],
         **{k: round(v[i], 2) for k, v in col.items()}} for i, ((n, x, y, z, src), (lo, la), s) in enumerate(zip(PTS, ll, smap))]
summ = {}
for k, v in col.items():
    d = np.array(v) - np.array([s["dem_z"] for s in smap]); summ[k] = {"mean": round(float(d.mean()), 2), "rmse": round(float(np.sqrt((d ** 2).mean())), 2), "min": round(float(d.min()), 2), "max": round(float(d.max()), 2), "errors": [round(float(e), 1) for e in d]}
json.dump({"note": "오차 = 해당 자료 − S-MAP dem_z (m). 전 지구 DEM 은 EGM96/EGM2008 지오이드 기준 높이라 한국 표고와 수십 cm 다를 수 있다.", "points": rows, "summary": summ}, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for r in rows: print(r)
print(json.dumps(summ, ensure_ascii=False))
