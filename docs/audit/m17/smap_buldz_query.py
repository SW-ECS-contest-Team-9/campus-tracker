# S-MAP 공개 표고 조회 (읽기 전용, 인증 없음) 유담관 영역 12점, 1.2초 간격. 원문 저장.
import json, time, urllib.request, urllib.parse, datetime, sys
PTS = [
 ("T1 타워 지붕 중앙", 201040, 557264), ("T2 타워 남동부", 201060, 557246),
 ("D1 서측 129.1 평탄면", 201018, 557270), ("D2 서측 129.1 평탄면 남", 201040, 557236),
 ("D3 서측 평탄면 북(회차공간 남)", 201016, 557292),
 ("W1 서측 띠 135 마루", 201000, 557334), ("W2 서측 띠 북", 201000, 557360), ("W3 서측 띠 경사 하단", 200994, 557320),
 ("S1 남단 꼭지점 부근(광장)", 201046, 557224), ("S2 남서 외곽선 안 경사", 201016, 557246),
 ("O1 외곽선 밖 지붕 돌출(북동)", 201064, 557276), ("O2 외곽선 밖 지상(회차공간)", 201024, 557320),
]
URL = "https://smap.seoul.go.kr/measure/getMeasureElevation3d.do"
out = []
for name, x, y in PTS:
    t = datetime.datetime.now().isoformat(timespec="seconds")
    try:
        req = urllib.request.Request(URL, data=urllib.parse.urlencode({"x": x, "y": y}).encode(),
              headers={"User-Agent": "Mozilla/5.0", "Referer": "https://smap.seoul.go.kr/"})
        with urllib.request.urlopen(req, timeout=20) as r: body, st = r.read().decode("utf-8", "replace"), r.status
    except Exception as e: body, st = repr(e), None
    out.append({"name": name, "x": x, "y": y, "time": t, "status": st, "raw": body}); print(name, st, body); sys.stdout.flush()
    time.sleep(1.2)
json.dump(out, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
