"""W01: S-MAP 1 m 메시(Z04 때 읽은 것, 볼트 z04 폴더) 읽기.  load() -> {(x, y): (z, 모델 색인)}  (x, y 는 칸의 정수 좌표)"""
import pathlib, re
V = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009')
def load():
    out = {}
    for fn in sorted((V / 'z04').glob('smap-mesh-z04-1m-*.txt')):
        ls = fn.read_text(encoding='utf-8').splitlines(); m = re.search(r'x=(\d+)\+1\*i.*y=(\d+)\+1\*j', ls[0]); x0, y0 = int(m[1]), int(m[2])
        for l in ls[1:]:
            if l.startswith('#') or '|' not in l: continue
            j, z, i = l.split('|')
            for k, (zz, ii) in enumerate(zip(z.split(','), i.split(','))):
                if zz != '-1': out[(x0 + k, y0 + int(j))] = (int(zz) / 100, int(ii))
    return out
