# E06: S-MAP 공개 표고 조회(m16/smap_elev_query.py와 같은 주소·방식, 인증 없음). 칸 중심 좌표만 보낸다.
# 응답이 한 건에 몇 초 걸려서 동시에 3건까지만 보낸다(건마다 0.3초 쉼). 결과를 줄 단위로 덧붙여 저장하고 이미 받은 칸은 건너뛴다.
# 사용: python -I smap_cells_query.py <cells.json> <출력 smap-cells.jsonl>
import sys; sys.stdout.reconfigure(encoding="utf-8")
import json, time, urllib.request, urllib.parse, sys, os, io
CELLS, OUT = sys.argv[1:3]
URL = "https://smap.seoul.go.kr/measure/getMeasureElevation3d.do"
done = set()
if os.path.exists(OUT):
    for l in io.open(OUT, encoding='utf-8'):
        r = json.loads(l)
        if r['status'] == 200: done.add((r['x'], r['y']))
todo = [c for c in json.load(open(CELLS)) if (c[0], c[1]) not in done]
print('남은 칸', len(todo)); sys.stdout.flush()
import threading
from concurrent.futures import ThreadPoolExecutor
lock = threading.Lock(); f = io.open(OUT, 'a', encoding='utf-8'); cnt = [0, 0]
def one(c):
    x, y = c
    if cnt[1] >= 15: return
    try:
        req = urllib.request.Request(URL, data=urllib.parse.urlencode({"x": x, "y": y}).encode(),
                                     headers={"User-Agent": "Mozilla/5.0", "Referer": "https://smap.seoul.go.kr/"})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8", "replace"); st = r.status
    except Exception as e:
        body, st = repr(e), None
    with lock:
        cnt[1] = 0 if st == 200 else cnt[1] + 1
        f.write(json.dumps({"x": x, "y": y, "status": st, "raw": body}, ensure_ascii=False) + "\n"); f.flush()
        cnt[0] += 1
        if cnt[0] % 100 == 0: print(cnt[0], st, body[:80]); sys.stdout.flush()
    time.sleep(0.3)
with ThreadPoolExecutor(3) as ex: list(ex.map(one, todo))
print('끝', cnt)
