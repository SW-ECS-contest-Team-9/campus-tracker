# E09: S-MAP 공개 표고 조회(읽기 전용 POST, 인증 없음), 1.2초 간격. picks.json 의 제안 꼭짓점과 기존 길 대조점의 dem_z 를 받는다.
#   python smap_elev_query.py <out.json>     (m16/smap_elev_query.py 와 같은 방식. 원문 응답 저장)
import json, time, urllib.request, urllib.parse, datetime, sys, pathlib
P = json.loads((pathlib.Path(__file__).parent / 'picks.json').read_text(encoding='utf-8'))
KEYS = ['mainGate', 'mainFountain', 'mainBend', 'mainS06C1R4', 'mainPlaza', 'lowerPortalLane', 'p1Lane', 'p1ThresholdS07C1', 'upperBranch', 'upperBranchSouth']
PTS = [(f'{k}[{i}]', p[0], p[1]) for k in KEYS for i, p in enumerate(P[k])]
PTS += [  # 기존 운영 길 꼭짓점(스냅숏 2)과 표지
 ('ccdf841c[0]', 201006.82, 557375.82), ('ccdf841c[1]', 201017.71, 557345.18), ('ccdf841c[2]', 201019.84, 557330.32), ('ccdf841c[3]', 201018.15, 557313.89),
 ('1d983e3a[1]', 201019.59, 557301.53), ('699d0cbc[1]', 201025.2, 557291.29),
 ('951c157d[0]', 201100.3, 557327.58), ('951c157d[1]', 201081.2, 557336.5), ('951c157d[2]', 201056.2, 557348.2), ('951c157d[3]', 201053.9, 557349.2),
 ('8fde6a04[1]', 201047.33, 557363.86), ('c52095ad[0]', 201106.22, 557324.73), ('c52095ad[29]', 201056.83, 557347.76),
 ('westGate road', 200975.14, 557397.49), ('westGate marker', 200967.8, 557401.5), ('westParking marker', 200969.0, 557402.8),
 ('gate marker', 201129.2, 557112.8), ('P1lot marker', 201096.7, 557150.7), ('P2lot marker', 201057.8, 557267.2), ('main entrance(2) marker', 201041.5, 557338.5),
 ('bus 2115 marker', 201031.0, 557319.0), ('bus 1164 marker', 201023.3, 557317.0),
]
URL = 'https://smap.seoul.go.kr/measure/getMeasureElevation3d.do'
out = []
for name, x, y in PTS:
    t = datetime.datetime.now().isoformat(timespec='seconds')
    try:
        req = urllib.request.Request(URL, data=urllib.parse.urlencode({'x': x, 'y': y}).encode(), headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://smap.seoul.go.kr/'})
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode('utf-8', 'replace'); st = r.status
    except Exception as e:
        body, st = repr(e), None
    out.append({'name': name, 'x': x, 'y': y, 'time': t, 'status': st, 'raw': body})
    print(name, st, body[:120]); sys.stdout.flush()
    time.sleep(1.2)
json.dump(out, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
