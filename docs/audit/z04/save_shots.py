"""Z04: 브라우저 도구가 파일로 떨군 시험 지도 캔버스 갈무리 묶음('ALLSHOTS' + 번호|data URL 을 #NEXT# 로 이은 것)을 <볼트>/z04/지도-<시점>.jpg 로 저장하고,
views.json 의 시점마다 근거 그림과 나란히 붙인 비교-<시점>.png 를 만든다(왼쪽 근거 | 오른쪽 시험 지도).   python save_shots.py [<tool-result.txt>...]
지도 화면이 구조물을 직접 그리므로(F06) 지도 갈무리는 한 장이다."""
import sys, json, base64, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import Z04, AUDIT, HERE
from PIL import Image, ImageDraw, ImageFont
V = json.loads((HERE / 'views.json').read_text(encoding='utf-8')); KEY = {k.split('-')[0]: k for k in V}
for f in sys.argv[1:]:
    t = json.loads(pathlib.Path(f).read_text(encoding='utf-8'))[0]['text'].strip('"').split('#PAD')[0]; assert t.startswith('ALLSHOTS')
    for part in t[8:].split('#NEXT#'):
        name, data = part.split('|', 1); (Z04 / f'지도-{KEY[name]}.jpg').write_bytes(base64.b64decode(data.split(',', 1)[1])); print('saved', KEY[name])
font = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 20); H = 700
def fit(im): im = im.convert('RGB'); return im.resize((round(im.width * H / im.height), H))
for key, v in V.items():
    mp = Z04 / f'지도-{key}.jpg'
    if not mp.exists(): continue
    ev = fit(Image.open(AUDIT / v['evidence'])); m = Image.open(mp); r = ev.width / ev.height; w, h = m.size
    if w / h > r: nw = round(h * r); m = m.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else: nh = round(w / r); m = m.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    m = fit(m); sheet = Image.new('RGB', (ev.width + m.width + 10, H + 34), 'white'); d = ImageDraw.Draw(sheet)
    sheet.paste(ev, (0, 34)); sheet.paste(m, (ev.width + 10, 34)); d.text((6, 4), ('근거: ' + v['evidence'].split('/')[-1])[: max(14, ev.width // 19)], fill='black', font=font); d.text((ev.width + 16, 4), f"시험 지도 (Z04 뒤, 시점 {v['cam']})"[: max(14, m.width // 19)], fill='black', font=font)
    sheet.save(Z04 / f'비교-{key}.png'); print(key, sheet.size)
