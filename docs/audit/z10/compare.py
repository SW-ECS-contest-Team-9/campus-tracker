"""Z10: 같은 시점의 갈무리를 나란히 붙인다. DB·네트워크 접근 없음.   python compare.py [시점 이름 일부 ...]
  비교-<시점>.png = 근거(있을 때) | 전(views.json 의 before) | 후(지도-*.jpg) | 편집기(편집기-*.jpg, 있을 때)
  묶음-NN.png      = 두 시점씩, 프리뷰 | 편집기 만(편집기 화면이 프리뷰와 같은지 한눈에 보는 용도)
갈무리:  node ../z05/shots.mjs views.json <볼트>/z10 지도      node editor_shots.mjs <볼트>/z10"""
import sys, json, pathlib
from PIL import Image, ImageDraw, ImageFont
HERE = pathlib.Path(__file__).parent; AUDIT = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009'); OUT = AUDIT / 'z10'
font = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 20); H = 640; only = sys.argv[1:]
def fit(im, h=H): im = im.convert('RGB'); return im.resize((round(im.width * h / im.height), h))
VIEWS = json.loads((HERE / 'views.json').read_text(encoding='utf-8')); pairs = []
for key, v in VIEWS.items():
    if only and not any(o in key for o in only): continue
    after = OUT / f'지도-{key}.jpg'; editor = OUT / f'편집기-{key}.jpg'
    if not after.exists(): continue
    ims, labels = [], []
    if v.get('evidence') and (AUDIT / v['evidence']).exists(): ims.append(fit(Image.open(AUDIT / v['evidence']))); labels.append('근거: ' + v['evidence'].split('/')[-1])
    if v.get('before') and (AUDIT / v['before']).exists(): ims.append(fit(Image.open(AUDIT / v['before']))); labels.append('전: Z10 전(Z09 뒤) 시험 지도')
    ims.append(fit(Image.open(after))); labels.append('후: Z10 뒤 프리뷰')
    if editor.exists(): ims.append(fit(Image.open(editor))); labels.append('Z10 뒤 편집기'); pairs.append((key, after, editor))
    s = Image.new('RGB', (sum(i.width for i in ims) + 10 * (len(ims) - 1), H + 34), 'white'); d = ImageDraw.Draw(s); x = 0
    for im, t in zip(ims, labels): s.paste(im, (x, 34)); d.text((x + 6, 4), t[: max(12, im.width // 19)], fill='black', font=font); x += im.width + 10
    s.save(OUT / f'비교-{key}.png'); print(f'비교-{key}.png', s.size)
for n in range(0, len(pairs), 2):
    rows = pairs[n:n + 2]; s = Image.new('RGB', (1400, 34 + 530 * len(rows)), 'white'); d = ImageDraw.Draw(s)
    for r, (key, a, e) in enumerate(rows):
        y = r * 530; d.text((6, y + 4), f'{key}   (왼쪽 프리뷰 | 오른쪽 편집기)', fill='black', font=font)
        for c, f in enumerate((a, e)): s.paste(fit(Image.open(f), 496).crop((0, 0, 695, 496)), (c * 705, y + 34))
    s.save(OUT / f'묶음-{n // 2 + 1:02d}.png')
print(len(pairs), 'pairs')
