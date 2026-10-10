# B10: S-MAP 공개 표고 조회(읽기 전용 POST, 인증 없음), 1.2초 간격. 원문 응답 저장. e05/smap_elev_query.py 와 같은 방식.
#   python smap_elev_query.py <out.json>
import json, time, urllib.request, urllib.parse, datetime, sys
PTS = [
 ("횡단보도 본관 쪽 끝", 201045.7, 557350.6), ("횡단보도 북악관 쪽 끝", 201047.5, 557354.3), ("통로 상자 가운데", 201046.7, 557359.8), ("통로 북쪽(계단 앞)", 201047.5, 557362.5),
 ("정문 계단 아래", 201039.5, 557360.5), ("정문 바깥 계단 위(차양 앞)", 201041.5, 557365.0), ("정문 동쪽 화단 단", 201052.0, 557360.0),
 ("GS25 문 앞(학교 표지 옮김)", 201008.0, 557395.0), ("서쪽 벽 북쪽 끝", 201012.0, 557410.0), ("서쪽 벽 남쪽 끝", 201005.0, 557386.0), ("남서 모서리 단(입구(3) 앞)", 201016.0, 557378.0),
 ("뒤편(북쪽 벽 가운데)", 201045.0, 557403.0), ("회차 공간 가운데", 201030.0, 557355.0), ("본관 모서리 앞 계단", 201040.8, 557342.0), ("회차 공간 북악관 정면 서쪽", 201025.0, 557370.0),
]
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
json.dump(out, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
