"""P01: 여러 장을 한 장에 모아 보기(작업 중 확인용, 볼트·저장소에 쓰지 않는다).   python sheet.py OUT.png W H COLS FILE..."""
import sys
from PIL import Image
out, w, h, cols, *fs = sys.argv[1:]; w, h, cols = int(w), int(h), int(cols)
rows = (len(fs) + cols - 1) // cols; c = Image.new('RGB', (cols * (w + 6), rows * (h + 6)), 'white')
for i, f in enumerate(fs):
    im = Image.open(f).convert('RGB')
    if f.endswith('전방위.jpg'): im = im.crop((0, 0, im.width * 2 // 3, im.height))
    c.paste(im.resize((w, h)), ((i % cols) * (w + 6), (i // cols) * (h + 6)))
c.save(out)
