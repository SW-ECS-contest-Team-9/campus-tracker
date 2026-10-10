# E05: S-MAP 공개 표고 조회(읽기 전용 POST, 인증 없음) 10점, 1.2초 간격. 원문 응답 저장. m16/smap_elev_query.py 와 같은 방식.
#   python smap_elev_query.py <out.json>
import json, time, urllib.request, urllib.parse, datetime, sys
PTS = [
 ("묶음 A 큰 흰 지붕 건물 중앙", 201032, 557198), ("묶음 B 팔각 건물 중앙", 200996, 557224),
 ("묶음 C 작은 건물(대장 32420)", 201012, 557194), ("묶음 D 작은 건물(대장 21878)", 201008, 557203),
 ("은주1관 지붕 중앙", 201131, 557270), ("은주2관 높은 지붕 중앙", 201168, 557186), ("은주관 접합부 탑", 201131.5, 557220.5),
 ("은주2관 낮은 단", 201152, 557179), ("혜인관 중앙", 201232, 557212), ("수인관 외곽 안 코트", 201150, 557160),
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
