"""F07: 같은 시점의 시험 지도 갈무리를 근거 사진과 나란히 붙인다. DB·네트워크 접근 없음.   python compare.py [시점 이름 일부 ...]
  근거 | 전(Z06 뒤 지도, views.json 의 before 가 있을 때) | 후(F07 뒤 지도, <볼트>/f07/지도-*.jpg)   -> <볼트>/f07/비교-*.png
갈무리는 docs/audit/z05/shots.mjs 로 찍는다:  node ../z05/shots.mjs views.json <볼트>/f07 지도"""
import sys, json, pathlib
from PIL import Image, ImageDraw, ImageFont
HERE = pathlib.Path(__file__).parent; AUDIT = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009'); OUT = AUDIT / 'f07'
font = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 20); H = 640; only = sys.argv[1:]
def fit(im): im = im.convert('RGB'); return im.resize((round(im.width * H / im.height), H))
for key, v in json.loads((HERE / 'views.json').read_text(encoding='utf-8')).items():
    if only and not any(o in key for o in only): continue
    after = OUT / f'지도-{key}.jpg'
    if not after.exists(): continue
    ims = [fit(Image.open(AUDIT / v['evidence']))]; labels = ['근거: ' + v['evidence'].split('/')[-1]]
    if v.get('before') and (AUDIT / v['before']).exists(): ims.append(fit(Image.open(AUDIT / v['before']))); labels.append('전: Z06 뒤 시험 지도')
    ims.append(fit(Image.open(after))); labels.append('후: F07 뒤 시험 지도(건물 겉모습)')
    s = Image.new('RGB', (sum(i.width for i in ims) + 10 * (len(ims) - 1), H + 34), 'white'); d = ImageDraw.Draw(s); x = 0
    for im, t in zip(ims, labels): s.paste(im, (x, 34)); d.text((x + 6, 4), t[: max(12, im.width // 19)], fill='black', font=font); x += im.width + 10
    s.save(OUT / f'비교-{key}.png'); print(f'비교-{key}.png', s.size)
