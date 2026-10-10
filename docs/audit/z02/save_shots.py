"""Z02: 브라우저 도구가 파일로 떨군 시험 지도 캔버스 갈무리 묶음('ALLSHOTS' + 이름|data URL 을 #NEXT# 로 이은 것)을 <볼트>/z02/지도-<이름>.jpg 로 저장하고,
근거 그림과 나란히 붙인 비교 그림 비교-<시점>.png 를 만든다.   python save_shots.py <tool-result.txt>
이름 끝 m = 지금 시험 지도 그대로, s = 구조물 파일을 브라우저 콘솔에서 임시로 올린 것(프런트가 아직 그리지 않아서)."""
import sys, json, base64, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import OUT, AUDIT, HERE
from PIL import Image, ImageDraw, ImageFont
t = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))[0]['text'].strip('"')
assert t.startswith('ALLSHOTS')
for part in t[8:].split('#NEXT#'):
    name, data = part.split('|', 1); (OUT / f'지도-{name}.jpg').write_bytes(base64.b64decode(data.split(',', 1)[1]))
V = json.loads((HERE / 'views.json').read_text(encoding='utf-8'))
font = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 22)
H = 620
def fit(im):
    im = im.convert('RGB'); return im.resize((round(im.width * H / im.height), H))
for key, v in V.items():
    n = key[0]; ev = Image.open(AUDIT / v['evidence'])
    if '사진-27' in v['evidence']: ev = ev.rotate(90, expand=True)   # 옆으로 누운 화면 갈무리
    ims = [fit(ev), fit(Image.open(OUT / f'지도-{n}m.jpg')), fit(Image.open(OUT / f'지도-{n}s.jpg'))]
    labels = ['근거: ' + v['evidence'].split('/')[-1], '시험 지도 그대로(구조물 파일은 아직 안 그려짐)', '시험 지도 + 구조물 파일(콘솔에서 임시로 올림)']
    W = sum(i.width for i in ims) + 20; sheet = Image.new('RGB', (W, H + 40), 'white'); x = 0; d = ImageDraw.Draw(sheet)
    for im, lb in zip(ims, labels):
        sheet.paste(im, (x, 40)); d.text((x + 6, 6), lb, fill='black', font=font); x += im.width + 10
    sheet.save(OUT / f'비교-{key}.png'); print(key, sheet.size)
