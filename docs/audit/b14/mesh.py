"""B14 상승관: S-MAP 0.5 m 메시 읽기 공통.  좌표계: s = 긴 변을 따라 서쪽 끝에서 동쪽으로, d = 북쪽 벽에서 대일관 쪽(남남서)으로."""
import pathlib, numpy as np
V = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009\b14')
X0, Y0, STEP = 201184.0, 557294.0, 0.5
GROUND, DAEIL, CHEONGUN, SANG = '419430528', '173604865', '173670401', '173604866'
def load():
    Z, I, ids = [], [], None
    for l in (V / 'smap-mesh-b14-sangseung-05m.txt').read_text(encoding='utf-8').splitlines():
        if l.startswith('# ids'): ids = l.split()[2].split(',')
        if l.startswith('#') or not l: continue
        j, z, i = l.split('|'); Z.append([int(v) / 100 for v in z.split(',')]); I.append([int(v) for v in i.split(',')])
    Z, I = np.array(Z), np.array(I); ny, nx = Z.shape
    xs, ys = np.meshgrid(X0 + STEP * np.arange(nx), Y0 + STEP * np.arange(ny))
    return xs, ys, Z, np.array(ids)[I]
