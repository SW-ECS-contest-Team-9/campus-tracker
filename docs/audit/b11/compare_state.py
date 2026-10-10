"""B11: 길 검사·도달 쌍(n03 pairs 66개)을 전후로 견준다.  python compare_state.py BEFORE.json AFTER.json  -> state-compare.json"""
import json, pathlib, sys
sys.stdout.reconfigure(encoding='utf-8')
a, b = (json.loads(pathlib.Path(p).read_text(encoding='utf-8')) for p in sys.argv[1:3])
ra = {x['id']: x for x in a['reachability']}; rb = {x['id']: x for x in b['reachability']}
modes = ('walk', 'walkAssumeUnknown', 'vehicle')
ok = lambda x, k: bool((x.get(k) or {}).get('reachable'))
flips = [(i, k, ok(ra[i], k), ok(rb[i], k)) for i in ra if i in rb for k in modes if ok(ra[i], k) != ok(rb[i], k)]
length = [(i, ra[i]['walkAssumeUnknown'].get('lengthM'), rb[i]['walkAssumeUnknown'].get('lengthM')) for i in ra if i in rb
          if abs((ra[i].get('walkAssumeUnknown', {}).get('lengthM') or 0) - (rb[i].get('walkAssumeUnknown', {}).get('lengthM') or 0)) > 0.5]
errors = lambda s: {k: v for k, v in (s['validation'].get('bySeverity') or {}).items()}
out = {'pairs': {'before': len(ra), 'after': len(rb), 'missingAfter': sorted(set(ra) - set(rb))},
       'reachable': {k: {'before': sum(ok(x, k) for x in ra.values()), 'after': sum(ok(x, k) for x in rb.values())} for k in modes},
       'reachableFlips': flips, 'lengthChanges': length, 'validation': {'before': a['validation'], 'after': b['validation']}, 'counts': {'before': a['counts'], 'after': b['counts']},
       'buildingId': {k: {'건물5': sum(1 for x in s[t] if x.get('buildingId') == '건물5' and x.get('status') in ('DRAFT', 'APPROVED')), '혜인관': sum(1 for x in s[t] if x.get('buildingId') == '혜인관' and x.get('status') in ('DRAFT', 'APPROVED'))}
                      for k, s in (('before', a), ('after', b)) for t in ('roads',)}}
print(json.dumps({k: out[k] for k in ('pairs', 'reachable', 'reachableFlips', 'lengthChanges', 'buildingId')}, ensure_ascii=False))
print('검사', errors(a), '->', errors(b), '| 오류', (a['validation'].get('bySeverity') or {}).get('error', 0), '->', (b['validation'].get('bySeverity') or {}).get('error', 0))
(pathlib.Path(__file__).parent / 'state-compare.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
