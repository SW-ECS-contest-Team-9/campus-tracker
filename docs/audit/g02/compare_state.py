"""G02: 길 검사·도달 표를 전후로 견준다. python compare_state.py 02-state-before.json 30-state-after.json"""
import sys, json; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import G02
a, b = (json.loads((G02 / f).read_text(encoding='utf-8')) for f in sys.argv[1:3])
print('validation', a['validation'], '->', b['validation'])
print('components', str(a['components'])[:200], '->', str(b['components'])[:200])
ka = lambda d: {(f.get('code'), str(f.get('roadId') or f.get('ids') or f.get('id'))[:60], f.get('message', '')[:80]) for f in d['findings']}
for tag, s in (('gone', ka(a) - ka(b)), ('new', ka(b) - ka(a))):
    print(tag, len(s)); [print('  ', x) for x in sorted(s, key=str)[:40]]
diff = 0
for p, q in zip(a['reachability'], b['reachability']):
    for k in ('walk', 'walkAssumeUnknown', 'vehicle'):
        if p.get(k) != q.get(k): diff += 1; print('REACH', p['id'], k, p.get(k), '->', q.get(k))
print('reachability pairs', len(a['reachability']), 'changed entries', diff)
