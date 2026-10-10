"""Z06: 같은 시점의 시험 지도 갈무리를 근거(사진·S-MAP 화면)와 나란히 붙인다. DB·네트워크 접근 없음.   python compare.py [시점 이름 일부 ...]
  Z05 의 19개 시점: 전(Z05 뒤 지도, <볼트>/z05/지도-*.jpg) | 후(Z06 뒤 지도, <볼트>/z06/지도-*.jpg) | 근거   -> <볼트>/z06/비교-*.png
  앞선 구역(G02·Z02·Z03)의 시점: 근거 | 지금 지도(<볼트>/z06/지도-g02-*.jpg 등)                     -> <볼트>/z06/비교-g02-*.png 등
갈무리는 docs/audit/z05/shots.mjs 로 찍는다(views.json 은 이 폴더, g02·z02·z03 은 각 폴더의 views.json).
전체 시점(19)의 근거는 S-MAP 1 m 메시를 같은 카메라로 그린 그림(Z05 에서 만든 것, 사진 아님)이다."""
import sys, json, pathlib
from PIL import Image, ImageDraw, ImageFont
HERE = pathlib.Path(__file__).parent; AUDIT = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009'); OUT = AUDIT / 'z06'
font = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 20); H = 640; only = sys.argv[1:]
def fit(im, ratio=None):
    im = im.convert('RGB')
    if ratio:
        w, h = im.size
        if w / h > ratio: nw = round(h * ratio); im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
        else: nh = round(w / ratio); im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    return im.resize((round(im.width * H / im.height), H))
def sheet(name, ims, labels):
    s = Image.new('RGB', (sum(i.width for i in ims) + 10 * (len(ims) - 1), H + 34), 'white'); d = ImageDraw.Draw(s); x = 0
    for im, t in zip(ims, labels): s.paste(im, (x, 34)); d.text((x + 6, 4), t[: max(12, im.width // 19)], fill='black', font=font); x += im.width + 10
    s.save(OUT / name); print(name, s.size)
V = json.loads((HERE / 'views.json').read_text(encoding='utf-8'))
for key, v in V.items():
    if only and not any(o in key for o in only): continue
    after = OUT / f'지도-{key}.jpg'
    if not after.exists(): continue
    A = Image.open(after); ratio = A.width / A.height
    ev = Image.open(AUDIT / 'z05' / 'SMAP-메시-19-전체-남서에서.png') if key.startswith('19') else Image.open(AUDIT / v['evidence'])
    evname = 'S-MAP 1 m 메시 판독을 같은 시점으로 그린 그림(사진 아님)' if key.startswith('19') else '근거: ' + v['evidence'].split('/')[-1]
    sheet(f'비교-{key}.png', [fit(Image.open(AUDIT / 'z05' / f'지도-{key}.jpg'), ratio), fit(A), fit(ev)], ['전: Z05 뒤 시험 지도', '후: Z06 뒤 시험 지도', evname])
for zone in ('g02', 'z02', 'z03'):
    for key, v in json.loads((HERE.parent / zone / 'views.json').read_text(encoding='utf-8')).items():
        if only and not any(o in f'{zone}-{key}' for o in only): continue
        shot = OUT / f'지도-{zone}-{key}.jpg'
        if not shot.exists() or not v.get('evidence'): continue
        ev = Image.open(AUDIT / v['evidence'])
        if '사진-27' in v['evidence']: ev = ev.rotate(90, expand=True)   # 옆으로 누운 화면 갈무리
        sheet(f'비교-{zone}-{key}.png', [fit(ev), fit(Image.open(shot))], ['근거: ' + v['evidence'].split('/')[-1], '지금 시험 지도(Z06 뒤, 구조물 그려짐)'])
