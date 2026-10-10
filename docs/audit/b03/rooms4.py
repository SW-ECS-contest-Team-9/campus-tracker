"""B03 — 학교 호실 목록에서 4로 시작하는 호수(4층처럼 보이는 것)를 동별로 모아 집계한다. 원자료는 저장소·볼트에 두지 않는다.

  python docs/audit/b03/rooms4.py <rooms.json> <out.json>

<rooms.json> = 학교 공개 호실 목록(건물 규칙서 "학교 캠퍼스맵 호실 목록"의 주소를 GET 으로 받은 파일, 임시 폴더에 둔다).
사용자 확정(2026-10-10): 학교 건물에는 4층이 없다(3층 다음이 5층). 그러면 4xx 호수는 4층 방이 아니다. 무엇인지 볼 수 있게
호수의 자릿수, 같은 동의 다른 층 호수 모양, 용도별 개수만 낸다(호실명은 용도 묶음으로만).
"""
import collections, json, pathlib, re, sys
sys.stdout.reconfigure(encoding='utf-8')
rows = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
by = collections.defaultdict(list)
for r in rows: by[r['건물명']].append(r)


def floor(no):
    m = re.match(r'(B?)(\d+)', no.strip())
    if not m: return None
    d = m.group(2)
    return ('B' if m.group(1) else '') + (d[:-2] if len(d) >= 3 else d)


out = {}
for b, rs in sorted(by.items()):
    four = [r for r in rs if floor(r['호수']) == '4']
    if not four: continue
    per_floor = collections.Counter(floor(r['호수']) for r in rs)
    out[b] = {'rooms': len(rs), 'roomsNumbered4xx': len(four), 'numbers4xx': sorted(r['호수'] for r in four),
              'uses4xx': dict(collections.Counter(r['호실용도'] for r in four)), 'names4xx': dict(collections.Counter(r['호실명'] for r in four).most_common(12)),
              'roomsPerFloorLabel': dict(sorted(per_floor.items(), key=lambda kv: str(kv[0]))),
              'numbers3xx': sorted(r['호수'] for r in rs if floor(r['호수']) == '3')[:40], 'numbers5xx': sorted(r['호수'] for r in rs if floor(r['호수']) == '5')[:40]}
json.dump({'source': 'university room list (public), fetched 2026-10-10; aggregates only', 'totalRows': len(rows), 'buildingsWith4xx': out}, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for b, o in out.items():
    print(b, o['roomsNumbered4xx'], '/', o['rooms']); print('  4xx', o['numbers4xx']); print('  용도', o['uses4xx']); print('  이름', o['names4xx'])
    print('  층별', o['roomsPerFloorLabel']); print('  3xx', o['numbers3xx']); print('  5xx', o['numbers5xx'])
