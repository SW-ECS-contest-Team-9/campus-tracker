"""Z04: 브라우저 도구가 파일로 떨군 S-MAP 뷰어 격자 판독 결과(여러 조각을 #SPLIT 로 이은 글)를 <볼트>/z04/smap-mesh-<이름>.txt 로 저장.  python -I save_grid.py <tool-result.txt>...
읽는 함수는 z03/smap_read.js 의 __g2 (여기서는 1 m 간격, z 는 cm, 모델 id 는 색인)."""
import json, sys, pathlib
OUT = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009\z04')
for f in sys.argv[1:]:
    t = json.load(open(f, encoding='utf-8'))[0]['text']
    if t.lstrip().startswith('"'): t = json.loads(t[:t.rindex('"') + 1])
    for part in t.split('\n#PAD')[0].split('\n#SPLIT\n'):
        lines = part.strip().split('\n'); name = lines[0].split()[1]
        assert lines[-1].startswith('# done'), lines[-1][:80]
        (OUT / f'smap-mesh-{name}.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8'); print(name, len(lines) - 3, 'rows;', lines[-1])
