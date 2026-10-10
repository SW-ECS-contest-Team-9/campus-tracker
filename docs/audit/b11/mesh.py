"""B11 공용: 볼트의 S-MAP 메시 판독 파일(smap-mesh-*.txt)을 읽는다. 점 = (x, y, z m, 모델 번호(0 = 지형), 파일)."""
import glob, pathlib, re
AUDIT = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009')
HEAD = re.compile(r'grid x=([\d.]+)\+([\d.]+)\*i \(i<(\d+)\), y=([\d.]+)\+([\d.]+)\*j \(j<(\d+)\)')

def load(patterns):
    pts = []
    for pat in patterns:
        for f in sorted(glob.glob(str(AUDIT / pat))):
            lines = pathlib.Path(f).read_text(encoding='utf-8').splitlines()
            m = HEAD.search(lines[0])
            if not m: continue
            x0, dx, nx, y0, dy, ny = float(m[1]), float(m[2]), int(m[3]), float(m[4]), float(m[5]), int(m[6])
            for ln in lines[1:]:
                p = ln.split('|')
                if len(p) < 2 or not p[0].strip().lstrip('-').isdigit(): continue
                j = int(p[0]); zs = p[1].split(','); ms = p[2].split(',') if len(p) > 2 else []
                for i, z in enumerate(zs):
                    if z in ('', '-1'): continue
                    pts.append((x0 + dx * i, y0 + dy * j, int(z) / 100, int(ms[i]) if i < len(ms) and ms[i] not in ('', '-1') else 0, pathlib.Path(f).name, dx))
    return pts

def grid_print(pts, x0, x1, y0, y1, step=1.0, show_model=False):
    """북쪽이 위인 표. 칸에 점이 여럿이면 가장 촘촘한 판독의 값."""
    cell = {}
    for x, y, z, m, f, d in pts:
        if x0 <= x <= x1 and y0 <= y <= y1:
            k = (round((x - x0) / step), round((y - y0) / step))
            if k not in cell or d < cell[k][2]: cell[k] = (z, m, d)
    nx = int(round((x1 - x0) / step)); ny = int(round((y1 - y0) / step))
    print('y,x    ' + ' '.join(f'{x0 + i * step:6.0f}' for i in range(nx + 1)))
    for j in range(ny, -1, -1):
        print(f'{y0 + j * step:6.0f} ' + ' '.join((f"{cell[(i, j)][0]:5.1f}" + ('*' if cell[(i, j)][1] else ' ')) if (i, j) in cell else '   .  ' for i in range(nx + 1)))
