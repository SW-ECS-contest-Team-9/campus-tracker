"""G02: 브라우저 도구가 파일로 떨군 시험 지도 캔버스 갈무리(이름|data URL|PAD)를 g02/지도-<이름>.jpg 로 저장. python save_shots.py <tool-result.txt>..."""
import sys, json, base64; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import G02
for f in sys.argv[1:]:
    t = json.load(open(f, encoding='utf-8'))[0]['text'].strip('"'); name, data, _ = t.split('|', 2)
    b = base64.b64decode(data.split(',', 1)[1]); (G02 / f'지도-{name}.jpg').write_bytes(b); print(name, len(b))
