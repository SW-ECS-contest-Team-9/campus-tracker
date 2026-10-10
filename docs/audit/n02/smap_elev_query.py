# N02: S-MAP 공개 표고 조회(읽기 전용 POST, 인증 없음), 1.2초 간격. b10/smap_elev_query.py 와 같은 방식. 점 목록은 points.json.
#   python smap_elev_query.py points.json <out.json>
import json, time, urllib.request, urllib.parse, datetime, sys
PTS = json.load(open(sys.argv[1], encoding='utf-8'))
URL = "https://smap.seoul.go.kr/measure/getMeasureElevation3d.do"
out = []
for name, x, y in PTS:
    t = datetime.datetime.now().isoformat(timespec="seconds")
    try:
        req = urllib.request.Request(URL, data=urllib.parse.urlencode({"x": x, "y": y}).encode(), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://smap.seoul.go.kr/"})
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace"); st = r.status
    except Exception as e:
        body, st = repr(e), None
    out.append({"name": name, "x": x, "y": y, "time": t, "status": st, "raw": body})
    print(name, st, body[:120]); sys.stdout.flush()
    time.sleep(1.2)
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
