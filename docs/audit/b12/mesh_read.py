"""B12: 본관 둘레의 S-MAP 메시 판독(볼트 smap-mesh-*.txt)을 한 표로.  python mesh_read.py [step]"""
import glob, pathlib, re, sys
AUDIT = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009')
HEAD = re.compile(r'grid x=([\d.]+)\+([\d.]+)\*i \(i<(\d+)\), y=([\d.]+)\+([\d.]+)\*j \(j<(\d+)\); line j\|z(\*10| cm)')
def load(x0, x1, y0, y1):
    pts = []
    for f in sorted(glob.glob(str(AUDIT / '**' / 'smap-mesh-*.txt'), recursive=True)):
        lines = pathlib.Path(f).read_text(encoding='utf-8').splitlines(); m = HEAD.search(lines[0])
        if not m: continue
        gx, dx, gy, dy = float(m[1]), float(m[2]), float(m[4]), float(m[5]); div = 10 if m[7] == '*10' else 100
        for ln in lines[1:]:
            p = ln.split('|')
            if len(p) < 2 or not p[0].strip().isdigit(): continue
            y = gy + dy * int(p[0])
            if not y0 <= y <= y1: continue
            ms = p[2].split(',') if len(p) > 2 else []
            for i, z in enumerate(p[1].split(',')):
                x = gx + dx * i
                if z in ('', '-1') or not x0 <= x <= x1: continue
                pts.append((x, y, int(z) / div, (ms[i] not in ('', '-1', '0')) if i < len(ms) else False, dx, pathlib.Path(f).name))
    return pts
def table(pts, x0, x1, y0, y1, step):
    cell = {}
    for x, y, z, m, d, f in pts:
        k = (round((x - x0) / step), round((y - y0) / step))
        if k not in cell or d < cell[k][2]: cell[k] = (z, m, d)
    nx, ny = int((x1 - x0) / step), int((y1 - y0) / step)
    print('  y,x ' + ''.join(f'{(x0 + i * step) % 1000:4.0f}' for i in range(nx + 1)))
    for j in range(ny, -1, -1):
        print(f'{(y0 + j * step) % 1000:5.0f} ' + ''.join(f'{cell[(i, j)][0] - 100:4.0f}' if (i, j) in cell else '   .' for i in range(nx + 1)))
    return cell
if __name__ == '__main__':
    step = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
    B = (201026, 201110, 557284, 557350)
    pts = load(*B); print(len(pts), sorted({(p[5], p[4]) for p in pts})); print('값 = 높이 − 100 m'); table(pts, *B, step)
