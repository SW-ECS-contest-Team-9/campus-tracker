# S-MAP 공개 표고 조회(읽기 전용 POST, 인증 없음), 20점, 1.2초 간격. 원문 응답 저장.
import json, time, urllib.request, urllib.parse, datetime, sys
PTS = [
 ("S06-R1 동쪽길 하단", 201091.11, 557241.71), ("S06-R2 주오르막", 201075.75, 557270.59),
 ("S06-R3 주오르막", 201062.18, 557281.71), ("S06-R4 주오르막", 201052.66, 557287.23),
 ("S06-R5 주오르막 상단", 201043.19, 557293.51), ("S06-P1 분수광장 중앙부", 201055.30, 557219.12),
 ("S06-P2 분수", 201072.64, 557204.14), ("S06-L1 낮은길", 201032.69, 557215.60),
 ("S06-L2 낮은길", 201052.25, 557201.00), ("S06-W1 벽 상단", 201048.68, 557218.16),
 ("S06-W2 벽 하단", 201041.84, 557216.92), ("S07-K1 P1 포털 가장자리", 201022.16, 557307.06),
 ("S07-K2 포털 위 화단", 201018.44, 557310.25), ("S07-K3 포털 앞 도로", 201024.60, 557301.93),
 ("S07-K4 회차공간", 201021.67, 557326.98), ("S07-G1 식재섬 사이 하단", 201068.93, 557284.42),
 ("S07-G2 식재섬 사이 상단", 201070.16, 557296.31), ("S07-F1 본관 전면 보도", 201056.65, 557301.09),
 ("S07-E1 951c157d 끝점", 201053.90, 557349.20), ("CHK 본관 남서 모서리", 201033.99, 557319.29),
]
URL = "https://smap.seoul.go.kr/measure/getMeasureElevation3d.do"
out = []
for name, x, y in PTS:
    t = datetime.datetime.now().isoformat(timespec="seconds")
    try:
        req = urllib.request.Request(URL, data=urllib.parse.urlencode({"x": x, "y": y}).encode(),
                                     headers={"User-Agent": "Mozilla/5.0", "Referer": "https://smap.seoul.go.kr/"})
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace"); st = r.status
    except Exception as e:
        body, st = repr(e), None
    out.append({"name": name, "x": x, "y": y, "time": t, "status": st, "raw": body})
    print(name, st, body[:200]); sys.stdout.flush()
    time.sleep(1.2)
json.dump(out, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
