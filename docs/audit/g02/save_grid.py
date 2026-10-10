"""G02: 브라우저 도구가 파일로 떨군 S-MAP 뷰어 격자 판독 결과(JSON 포장)를 <out-dir>/smap-mesh-<name>.txt 로 저장.
  python -I save_grid.py <tool-result.txt> <out-dir>
읽는 함수는 collect_grid.js 의 __g2 (e05 의 __grid 와 같은 방식, 0.5 m 간격·z 는 cm)."""
import json, sys, pathlib
t = json.load(open(sys.argv[1], encoding='utf-8'))[0]['text']
t = t[:t.rindex('"') + 1] if t.lstrip().startswith('"') else t
try: t = json.loads(t)
except Exception: pass
lines = t.split('\n'); name = lines[0].split()[1]
assert lines[-1].startswith('# done'), lines[-1][:80]
p = pathlib.Path(sys.argv[2]) / f'smap-mesh-{name}.txt'
p.write_text('\n'.join(lines) + '\n', encoding='utf-8'); print(p.name, len(lines) - 3, 'rows;', lines[-1])
