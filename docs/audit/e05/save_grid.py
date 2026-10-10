"""E05: 브라우저 도구가 파일로 떨군 S-MAP 뷰어 격자 판독 결과(JSON 포장)를 풀어 <out-dir>/smap-mesh-<name>.txt 로 저장한다.
  python save_grid.py <tool-result.txt> <out-dir>
격자는 S-MAP 3D 뷰어(https://smap.seoul.go.kr) 탭에서 collect_grid.js 의 __grid() 로 읽은 것이다(읽기 전용, 화면에 그려진 메시 픽).
"""
import json, sys, pathlib
t = json.load(open(sys.argv[1], encoding='utf-8'))[0]['text']
t = json.loads(t[:t.rindex('"') + 1])
lines = [l for l in t.split('\n') if not l.startswith('#PAD')]
name = lines[0].split()[1]
assert lines[-1].startswith('# done'), lines[-1][:80]
p = pathlib.Path(sys.argv[2]) / f'smap-mesh-{name}.txt'
p.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(p.name, len(lines) - 2, 'rows;', lines[-1])
