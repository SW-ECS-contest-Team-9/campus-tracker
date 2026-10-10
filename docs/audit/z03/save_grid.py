"""Z03: 브라우저 도구가 파일로 떨군 S-MAP 뷰어 격자 판독 결과(JSON 포장, #PAD 로 끝을 채운 글)를 <out-dir>/smap-mesh-<name>.txt 로 저장.
  python -I save_grid.py <out-dir> <tool-result.txt>...
읽는 함수는 smap_read.js 의 __g2 (0.5 m 간격, z 는 cm, 모델 id 는 색인)."""
import json, sys, pathlib
for f in sys.argv[2:]:
    t = json.load(open(f, encoding='utf-8'))[0]['text']
    if t.lstrip().startswith('"'):
        try: t = json.loads(t[:t.rindex('"') + 1])
        except Exception: t = t.strip().strip('"').replace('\n', '\n')
    t = t.split('\n#PAD')[0]; lines = t.split('\n'); name = lines[0].split()[1]
    assert lines[-1].startswith('# done'), lines[-1][:80]
    p = pathlib.Path(sys.argv[1]) / f'smap-mesh-{name}.txt'
    p.write_text('\n'.join(lines) + '\n', encoding='utf-8'); print(p.name, len(lines) - 3, 'rows;', lines[-1])
