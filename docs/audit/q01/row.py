"""Q01: 그림 여러 장을 같은 높이로 나란히 놓는다(볼트 q01 폴더에만 쓴다. 사용자 사진은 저장소에 넣지 않는다).
   python row.py <결과 이름> <높이> <제목=파일> [<제목=파일> ...]      파일은 보완자료 폴더 기준 상대 경로 또는 절대 경로"""
import pathlib, sys
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 15)
A = pathlib.Path('C:/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009'); OUT = A / 'q01'
name, h = sys.argv[1], int(sys.argv[2])
parts = []
for a in sys.argv[3:]:
    t, f = a.split('=', 1); p = pathlib.Path(f); p = p if p.is_absolute() else A / f
    im = Image.open(p).convert('RGB'); parts.append((t, im.resize((round(im.width * h / im.height), h), Image.LANCZOS)))
out = Image.new('RGB', (sum(im.width for _, im in parts) + 8 * (len(parts) - 1), h + 30), 'white'); d = ImageDraw.Draw(out); x = 0
for t, im in parts: out.paste(im, (x, 30)); d.text((x + 6, 5), t, fill='black', font=FONT); x += im.width + 8
out.save(OUT / name, quality=88); print('saved', name, out.size)
