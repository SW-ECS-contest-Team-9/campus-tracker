"""N03: Z04 가 받아 둔 S-MAP 1 m 메시(볼트 z04/smap-mesh-z04-1m-*.txt, 캠퍼스 안 전체)에서 땅 높이를 읽는다. 읽기만 한다.
ground(x, y, r) = 둘레 (2r+1)^2 칸 가운데 땅 칸의 (가운데값, 최소, 최대, 칸 수). 건물 모델 칸은 뺀다. 메시가 없으면 None."""
import importlib.util, pathlib
import numpy as np
_Z = pathlib.Path(__file__).parents[1] / 'z04' / 'common.py'
_M = None
def _mesh():
    global _M
    if _M is None:
        spec = importlib.util.spec_from_file_location('z04_common', _Z); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        assert len(list(mod.Z04.glob('smap-mesh-z04-1m-*.txt'))) >= 8, 'S-MAP 1 m 메시 조각이 모자람'
        _M = mod.Mesh()
    return _M
def ground(x, y, r=1):
    m = _mesh(); v = [float(m.at(x + dx, y + dy)) for dx in range(-r, r + 1) for dy in range(-r, r + 1)]; v = [t for t in v if t == t]
    return (round(float(np.median(v)), 2), round(min(v), 2), round(max(v), 2), len(v)) if v else None
