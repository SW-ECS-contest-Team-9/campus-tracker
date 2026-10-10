"""Z03: S-MAP 뷰어의 위에서 본 화면 조각(거의 정사: fov 0.12, 기울기 90도)들을 좌표에 맞춰 한 장으로 붙인다(0.1 m/px, 위가 북).
  python -I ortho.py <tool-result.txt>      조각 = {cx,cy,w,h,cw,ch,pts:[[x,y,px,py]..]}|data URL  (smap_read.js 의 __tiles)
쓰는 파일: z03/smap-정사-분수광장-01m.png (원점 = 왼쪽 위 (X0, Y1))"""
import sys, io, base64; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
from PIL import Image
X0, X1, Y0, Y1, R = 201024, 201110, 557163, 557266, 0.1
t = json.load(open(sys.argv[1], encoding='utf-8'))[0]['text']
t = json.loads(t[:t.rindex('"') + 1]) if t.lstrip().startswith('"') else t
out = np.zeros((int((Y1 - Y0) / R), int((X1 - X0) / R), 3), np.uint8)
xs = X0 + (np.arange(out.shape[1]) + .5) * R; ys = Y1 - (np.arange(out.shape[0]) + .5) * R; gx, gy = np.meshgrid(xs, ys)
for part in t.split('\n#PAD')[0].split('\n'):
    meta, url = part.split('|', 1); meta = json.loads(meta)
    im = np.asarray(Image.open(io.BytesIO(base64.b64decode(url.split(',', 1)[1]))).convert('RGB'))
    P = np.array(meta['pts']); A = np.c_[P[:, :2], np.ones(len(P))]
    cu, *_ = np.linalg.lstsq(A, P[:, 2], rcond=None); cv, *_ = np.linalg.lstsq(A, P[:, 3], rcond=None)
    s = 1.0   # getPixelFromCoordinate 는 캔버스 픽셀(그림 픽셀)로 준다
    u = (cu[0] * gx + cu[1] * gy + cu[2]) * s; v = (cv[0] * gx + cv[1] * gy + cv[2]) * s
    ok = (u >= 2) & (v >= 2) & (u < im.shape[1] - 2) & (v < im.shape[0] - 2)
    out[ok] = im[v[ok].astype(int), u[ok].astype(int)]
    print(meta['cx'], meta['cy'], im.shape, 'px/m', round(float(np.hypot(cu[0], cu[1]) * s), 2), 'cover', int(ok.sum()))
Image.fromarray(out).save(Z03 / 'smap-정사-분수광장-01m.png'); print('origin(top-left)', X0, Y1, 'm/px', R, out.shape)
