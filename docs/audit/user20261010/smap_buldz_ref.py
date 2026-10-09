# S-MAP 공개 표고 조회(읽기 전용) — 모델별 buld_z 확인 4점, 1.2초 간격. 사용법: smap_buldz_ref.py <출력 json>
import json, time, urllib.request, urllib.parse, datetime, sys
if len(sys.argv) != 2: sys.exit("사용법: smap_buldz_ref.py <출력 json>")
PTS = [("문예관 외곽선 중앙(W 모델 고층 지붕)", 201104.0, 557352.0), ("문예관 외곽선 남서부(W 모델 148.8 저층면)", 201102.0, 557340.0),
       ("한림관 중앙(H 모델)", 201114.0, 557295.0), ("북악관 동부(B 모델)", 201080.0, 557370.0)]
URL = "https://smap.seoul.go.kr/measure/getMeasureElevation3d.do"; out = []
for name, x, y in PTS:
    t = datetime.datetime.now().isoformat(timespec="seconds")
    try:
        req = urllib.request.Request(URL, data=urllib.parse.urlencode({"x": x, "y": y}).encode(), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://smap.seoul.go.kr/"})
        with urllib.request.urlopen(req, timeout=20) as r: body, st = r.read().decode("utf-8", "replace"), r.status
    except Exception as e: body, st = repr(e), None
    out.append({"name": name, "x": x, "y": y, "time": t, "status": st, "raw": body}); print(st, body); sys.stdout.flush(); time.sleep(1.2)
json.dump(out, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
