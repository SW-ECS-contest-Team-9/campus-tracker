# T04: 표본 칸 일부를 S-MAP 공개 표고 조회(dem_z, 메시와 다른 서비스)로 다시 물어 대조한다. 읽기 전용 POST, 1.2초 간격, 구역마다 최대 N 점.
#   python smap_api_check.py <t04/samples.json> <out raw.json> [N=24]
# 보내는 것은 칸 좌표뿐이다. 원문 응답을 그대로 저장한다(e09/smap_elev_query.py 와 같은 방식).
import json, random, sys, time, urllib.request, urllib.parse, datetime
S = json.load(open(sys.argv[1], encoding='utf-8')); N = int(sys.argv[3]) if len(sys.argv) > 3 else 24
URL = 'https://smap.seoul.go.kr/measure/getMeasureElevation3d.do'
rnd = random.Random(4); out = []
for key, a in S['areas'].items():
    for x, y, z, _ in rnd.sample(a['points'], min(N, len(a['points']))):
        t = datetime.datetime.now().isoformat(timespec='seconds')
        try:
            req = urllib.request.Request(URL, data=urllib.parse.urlencode({'x': x, 'y': y}).encode(), headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://smap.seoul.go.kr/'})
            with urllib.request.urlopen(req, timeout=20) as r: body = r.read().decode('utf-8', 'replace'); st = r.status
        except Exception as e: body, st = repr(e), None
        out.append({'area': key, 'x': x, 'y': y, 'meshZ': z, 'time': t, 'status': st, 'raw': body})
        time.sleep(1.2)
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
d = {}
for o in out:
    if o['status'] != 200: continue
    r = json.loads(o['raw'])['result']
    d.setdefault(o['area'], []).append((round(o['meshZ'] - r['dem_z'], 2), r['buld_z'] is not None))
for k, v in d.items():
    g = sorted(abs(a) for a, b in v if not b); print(k, 'n', len(v), 'buld_z', sum(b for a, b in v), 'median', sorted(a for a, b in v if not b)[len(g) // 2], 'p90abs', g[int(.9 * (len(g) - 1))], 'max', g[-1])
