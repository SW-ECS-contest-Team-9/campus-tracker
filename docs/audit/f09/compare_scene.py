"""F09: 장면(GET /api/v1/scene) 전후 비교. 건물의 바닥·지붕·외곽이 그대로이고 겉모습에는 층 이름(floorNames)만 더해졌는지 본다.
   python compare_scene.py 전.json 후.json"""
import json, sys
a, b = (json.load(open(f, encoding='utf-8')) for f in sys.argv[1:3])
A = {x['buildingId']: x for x in a['buildings']}; B = {x['buildingId']: x for x in b['buildings']}
print('장면', a['id'], '->', b['id'], '건물', len(A), '->', len(B))
bad = 0; named = []
for k in sorted(set(A) | set(B)):
    if k not in A or k not in B: print('  한쪽에만:', k); bad += 1; continue
    for f in ('baseM', 'roofM', 'heightM', 'geometry', 'name'):
        if A[k][f] != B[k][f]: print('  다름:', k, f); bad += 1
    wa = ((A[k].get('appearance') or {}).get('windows') or {}); wb = ((B[k].get('appearance') or {}).get('windows') or {})
    la = dict(A[k].get('appearance') or {}); lb = dict(B[k].get('appearance') or {})
    if 'windows' in lb: lb['windows'] = {q: v for q, v in wb.items() if q != 'floorNames'}
    if la != lb: print('  겉모습 다름(층 이름 밖):', k); bad += 1
    if wb.get('floorNames'):
        assert len(wb['floorNames']) == len(wb['floorsM']), k
        named.append(f"{k}: " + ' '.join(f"{n}@{m}" for n, m in zip(wb['floorNames'], wb['floorsM'])))
print('바닥·지붕·외곽·겉모습(층 이름 밖) 차이', bad)
print('층 이름이 실린 건물', len(named)); print('\n'.join('  ' + n for n in named))
sys.exit(1 if bad else 0)
