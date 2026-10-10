"""Z02: 브라우저 도구가 파일로 떨군 시험 지도 캔버스 갈무리(이름|data URL|PAD)를 <볼트>/z02/지도-<이름>.jpg 로 저장.
  python save_shots.py <tool-results 폴더>   이름 끝 m = 지금 지도 그대로, s = 구조물 파일을 콘솔에서 임시로 올린 것"""
import sys, json, base64, pathlib, re; sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import OUT
for f in sorted(pathlib.Path(sys.argv[1]).glob('*'), key=lambda p: p.stat().st_mtime):
    try: t = json.loads(f.read_text(encoding='utf-8'))[0]['text'].strip('"')
    except Exception: continue
    m = re.match(r'^(\d[a-z]+)\|data:image/jpeg;base64,([^|]+)\|PAD', t)
    if not m: continue
    (OUT / f'지도-{m[1]}.jpg').write_bytes(base64.b64decode(m[2])); print(m[1], f.name)
