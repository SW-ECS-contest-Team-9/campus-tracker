# G01: S-MAP 공개 표고 조회(e06/smap_cells_query.py 와 같은 주소·방식, 인증 없음)를 작은 구획에서 격자로 물어
# 건물·옹벽·평지 위에서 무엇을 돌려주는지 본다. 읽기 전용 POST, 동시에 2건, 건마다 0.5초 쉼. 이미 받은 점은 건너뛴다.
#   python -I smap_patch.py <출력 jsonl> <x0> <y0> <nx> <ny> <step>
import sys, json, time, os, io, threading, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
OUT = sys.argv[1]; x0, y0 = float(sys.argv[2]), float(sys.argv[3]); nx, ny = int(sys.argv[4]), int(sys.argv[5]); step = float(sys.argv[6])
URL = "https://smap.seoul.go.kr/measure/getMeasureElevation3d.do"
done = set()
if os.path.exists(OUT):
    for l in io.open(OUT, encoding="utf-8"):
        r = json.loads(l)
        if r["status"] == 200: done.add((r["x"], r["y"]))
todo = [(round(x0 + step * i, 3), round(y0 + step * j, 3)) for j in range(ny) for i in range(nx)]
todo = [c for c in todo if c not in done]
lock = threading.Lock(); f = io.open(OUT, "a", encoding="utf-8"); fail = [0]; t0 = time.time()
def one(c):
    if fail[0] >= 10: return
    x, y = c; t = time.time()
    try:
        req = urllib.request.Request(URL, data=urllib.parse.urlencode({"x": x, "y": y}).encode(),
                                     headers={"User-Agent": "Mozilla/5.0", "Referer": "https://smap.seoul.go.kr/"})
        with urllib.request.urlopen(req, timeout=30) as r: body = r.read().decode("utf-8", "replace"); st = r.status
    except Exception as e: body, st = repr(e), None
    with lock:
        fail[0] = 0 if st == 200 else fail[0] + 1
        f.write(json.dumps({"x": x, "y": y, "status": st, "sec": round(time.time() - t, 2), "raw": body}, ensure_ascii=False) + "\n"); f.flush()
    time.sleep(0.5)
with ThreadPoolExecutor(2) as ex: list(ex.map(one, todo))
print("요청", len(todo), "초", round(time.time() - t0), "연속 실패", fail[0])
