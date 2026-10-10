"""Z04: 길 검사·도달 쌍을 전후로 견준다(z03·n02·z02 의 쌍 43개).  python compare_state.py"""
import json, pathlib
Z = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009\z04'); out = {}
for p in ('z03', 'n02', 'z02'):
    a = json.loads((Z / f"01-state-before{'' if p == 'z03' else '-' + p + 'pairs'}.json").read_text(encoding='utf-8')); b = json.loads((Z / f'40-state-after-{p}pairs.json').read_text(encoding='utf-8'))
    flips = [(x['id'], k, (x.get(k) or {}).get('reachable'), (y.get(k) or {}).get('reachable')) for x, y in zip(a['reachability'], b['reachability']) for k in ('walk', 'walkAssumeUnknown', 'vehicle') if (x.get(k) or {}).get('reachable') != (y.get(k) or {}).get('reachable')]
    ln = [(x['id'], x['walkAssumeUnknown'].get('lengthM'), y['walkAssumeUnknown'].get('lengthM')) for x, y in zip(a['reachability'], b['reachability']) if abs((x['walkAssumeUnknown'].get('lengthM') or 0) - (y['walkAssumeUnknown'].get('lengthM') or 0)) > 0.5]
    out[p] = {'pairs': len(a['reachability']), 'reachableFlips': flips, 'lengthChanges': ln}; print(p, out[p])
out['validation'] = {'before': a['validation'], 'after': b['validation']}; out['counts'] = {'before': a['counts'], 'after': b['counts']}; print(out['validation'])
(pathlib.Path(__file__).parent / 'state-compare.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
