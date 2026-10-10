"""Z05: 같은 시점의 전(Z04 뒤 지도) | 후(Z05 뒤 지도) | 근거(S-MAP 화면·사진)를 나란히 붙인다.  python compare.py
전 = <볼트>/z04/지도-<시점>.jpg, 후 = <볼트>/z05/지도-<시점>.jpg (shots.mjs), 근거 = z04/views.json 의 evidence.
전체 시점(19)의 근거는 S-MAP 화면이 없어 S-MAP 1 m 메시 판독(땅 + 건물 모델 높이)을 같은 카메라로 그린 그림이다(사진이 아니다)."""
import sys, json; from base import *
from PIL import Image, ImageDraw, ImageFont
V = json.loads((HERE / 'views.json').read_text(encoding='utf-8')); font = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 20); H = 640

def smap_view(pos, tgt, fov_deg, size=(1060, 848)):
    """메시 칸의 윗면과 높이가 바뀌는 곳의 세로면을 점으로 찍어 멀리서부터 칠한다."""
    Wp, Hp = size; pos, tgt = np.array(pos, float), np.array(tgt, float); d = (tgt - pos) / np.linalg.norm(tgt - pos); r = np.cross(d, [0, 0, 1.0]); r /= np.linalg.norm(r); u = np.cross(r, d)
    f = (Wp / 2) / np.tan(np.radians(fov_deg) / 2)
    ok = np.isfinite(Z); zz = np.where(ok, Z, np.nan); gy, gx = np.gradient(np.nan_to_num(zz, nan=0.0)); shade = np.clip(0.82 + 0.35 * (-gx * 0.646 - gy * 0.763), 0.5, 1.08)
    base = np.where(M.g[..., None], np.array([150, 160, 130.0]), np.array([232, 224, 200.0])) * shade[..., None]
    P, C, S = [np.c_[XS[ok], YS[ok], zz[ok]]], [base[ok]], [np.full(ok.sum(), 1.25)]
    for dy, dx in ((0, 1), (1, 0)):
        a = zz[:MNY - dy, :MNX - dx]; b = zz[dy:, dx:]; m = np.isfinite(a) & np.isfinite(b) & (np.abs(a - b) > 0.8); ys, xs = np.nonzero(m)
        for y, x in zip(ys, xs):
            lo, hi = sorted((a[y, x], b[y, x])); hs = np.arange(lo, hi, 0.7); bl = not (M.g[y, x] and M.g[y + dy, x + dx])
            P.append(np.c_[np.full(len(hs), MX0 + x + dx / 2), np.full(len(hs), MY0 + y + dy / 2), hs]); C.append(np.tile(np.array([205, 196, 172.0]) * (0.9 if dx else 0.72) if bl else np.array([120, 126, 108.0]), (len(hs), 1))); S.append(np.full(len(hs), 1.1))
    P, C, S = np.vstack(P), np.vstack(C), np.concatenate(S); v = P - pos; depth = v @ d; k = depth > 5; px = Wp / 2 + f * (v[k] @ r) / depth[k]; py = Hp / 2 - f * (v[k] @ u) / depth[k]; sz = np.maximum(1, f * S[k] / depth[k]); C = C[k]; depth = depth[k]
    img = np.full((Hp, Wp, 3), 238, np.uint8); order = np.argsort(-depth)
    for i in order:
        h = sz[i] / 2 + 0.5; x0, x1, y0, y1 = int(px[i] - h), int(px[i] + h) + 1, int(py[i] - h), int(py[i] + h) + 1
        if x1 <= 0 or y1 <= 0 or x0 >= Wp or y0 >= Hp: continue
        img[max(y0, 0):y1, max(x0, 0):x1] = C[i]
    return Image.fromarray(img)
def fit(im, ratio=None):
    im = im.convert('RGB')
    if ratio:
        w, h = im.size
        if w / h > ratio: nw = round(h * ratio); im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
        else: nh = round(w / ratio); im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    return im.resize((round(im.width * H / im.height), H))
only = sys.argv[1:]
for key, v in V.items():
    if only and not any(o in key for o in only): continue
    after = Z05 / f'지도-{key}.jpg'; before = Z04 / f'지도-{key}.jpg'
    if not after.exists(): continue
    if key.startswith('19'): ev = smap_view(v['pos'], v['tgt'], v['fov']); ev.save(Z05 / 'SMAP-메시-19-전체-남서에서.png'); evname = 'S-MAP 1 m 메시 판독을 같은 시점으로 그린 그림(사진 아님)'
    else: ev = Image.open(AUDIT / v['evidence']); evname = '근거: ' + v['evidence'].split('/')[-1]
    A = Image.open(after); ratio = A.width / A.height; ims = [fit(Image.open(before), ratio), fit(A), fit(ev)]
    sheet = Image.new('RGB', (sum(i.width for i in ims) + 20, H + 34), 'white'); d = ImageDraw.Draw(sheet); x = 0
    for im, t in zip(ims, ('전: Z04 뒤 시험 지도', '후: Z05 뒤 시험 지도', evname)):
        sheet.paste(im, (x, 34)); d.text((x + 6, 4), t[: max(12, im.width // 19)], fill='black', font=font); x += im.width + 10
    sheet.save(Z05 / f'비교-{key}.png'); print(key, sheet.size)
