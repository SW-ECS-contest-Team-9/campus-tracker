# S-MAP 공개 표고 조회(읽기 전용, 인증 없음) — 대응 위치 지표면 참고값. 1.2초 간격. 사용법: smap_ref_query.py <출력 json>
import json, time, urllib.request, urllib.parse, datetime, sys
if len(sys.argv) != 2: sys.exit("사용법: smap_ref_query.py <출력 json>")
PTS = [("정문 원 중심", 201041.73, 557360.47), ("정문 돌출부 앞 지면", 201041.0, 557362.5), ("옆길 남단(사진2)", 201001.93, 557387.56),
       ("옆길 중간", 201009.0, 557402.9), ("옆길 북단=뒤편 시작(사진2)", 201016.02, 557418.24), ("a03d33c3 시작 노드 7895ac0d", 201018.47, 557413.32),
       ("뒤편 산책로 굴곡(사진2)", 201043.53, 557410.38), ("뒤편 산책로 북악관 동끝 뒤", 201097.0, 557379.12), ("뒤편 산책로 문예관 뒤", 201122.17, 557366.12),
       ("B1 서측 통로 끝 f645a7b9 평면 위치", 201014.4, 557396.2)]
URL = "https://smap.seoul.go.kr/measure/getMeasureElevation3d.do"; out = []
for name, x, y in PTS:
    t = datetime.datetime.now().isoformat(timespec="seconds")
    try:
        req = urllib.request.Request(URL, data=urllib.parse.urlencode({"x": x, "y": y}).encode(), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://smap.seoul.go.kr/"})
        with urllib.request.urlopen(req, timeout=20) as r: body, st = r.read().decode("utf-8", "replace"), r.status
    except Exception as e: body, st = repr(e), None
    out.append({"name": name, "x": x, "y": y, "time": t, "status": st, "raw": body}); print(st, body); sys.stdout.flush(); time.sleep(1.2)
json.dump(out, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
