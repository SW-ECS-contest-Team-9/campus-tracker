"""Z03: 브라우저 도구가 파일로 떨군 시험 지도 캔버스 갈무리 묶음('ALLSHOTS' + 이름|data URL 을 #NEXT# 로 이은 것)을 <볼트>/z03/지도-<이름>.jpg 로 저장하고,
views.json 의 시점마다 근거 그림과 나란히 붙인 비교 그림 비교-<시점>.png 를 만든다.   python -I save_shots.py [<tool-result.txt>...]
이름 끝 m = 지금 시험 지도 그대로, s = 구조물 파일을 브라우저 콘솔에서 임시로 올린 것(map_shots.js. 프런트가 아직 그리지 않아서).
crop = 근거 그림의 가로/세로 비(지도 갈무리의 가운데를 그 비로 자른다). evidenceCrop = 근거 그림에서 쓸 부분 [x0, y0, x1, y1] (0~1)."""
import sys, json, base64, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import Z03, AUDIT, HERE
from PIL import Image, ImageDraw, ImageFont
for f in sys.argv[1:]:
    t = json.loads(pathlib.Path(f).read_text(encoding='utf-8'))[0]['text'].strip('"').split('#PAD')[0]
    assert t.startswith('ALLSHOTS')
    for part in t[8:].split('#NEXT#'):
        name, data = part.split('|', 1); (Z03 / f'지도-{name}.jpg').write_bytes(base64.b64decode(data.split(',', 1)[1])); print('saved', name)
V = json.loads((HERE / 'views.json').read_text(encoding='utf-8'))
font = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 22); H = 760
def fit(im): im = im.convert('RGB'); return im.resize((round(im.width * H / im.height), H))
def centre_crop(im, ratio):
    w, h = im.size
    if w / h > ratio: nw = round(h * ratio); return im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    nh = round(w / ratio); return im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
for key, v in V.items():
    if not (Z03 / f'지도-{key}m.jpg').exists(): continue
    ev = Image.open(AUDIT / v['evidence'])
    if v.get('evidenceCrop'): a = v['evidenceCrop']; ev = ev.crop((round(a[0] * ev.width), round(a[1] * ev.height), round(a[2] * ev.width), round(a[3] * ev.height)))
    ratio = v.get('crop', ev.width / ev.height)
    ims = [fit(ev), fit(centre_crop(Image.open(Z03 / f'지도-{key}m.jpg'), ratio)), fit(centre_crop(Image.open(Z03 / f'지도-{key}s.jpg'), ratio))]
    labels = ['근거: ' + v['evidence'].split('/')[-1], '시험 지도 그대로', '시험 지도 + 구조물 파일(임시로 올림)']
    W = sum(i.width for i in ims) + 20; sheet = Image.new('RGB', (W, H + 40), 'white'); x = 0; d = ImageDraw.Draw(sheet)
    for im, lb in zip(ims, labels):
        sheet.paste(im, (x, 40)); d.text((x + 6, 6), lb[: max(12, im.width // 21)], fill='black', font=font); x += im.width + 10
    sheet.save(Z03 / f'비교-{key}.png'); print(key, sheet.size)
