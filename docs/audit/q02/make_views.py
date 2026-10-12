"""Q02: 사용자 사진 02 를 찍은 자리(rectify_leaf.py 로 편 값, 추정)와 나뭇잎을 바로 위에서 보는 시점.   python -I make_views.py  -> views.json"""
import sys, json, math, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'g02')); sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import st_to_xy, way_z
import rectify_leaf as R
F, S_TIP = 375, 61.2                                   # S_TIP = g02/build_inputs.py 의 잎 끝 자리
g, H, _ = R.ground(F); cb = math.cos(math.atan(7.73 / 45)); sb = math.sin(math.atan(7.73 / 45))     # 길 기울기(s 55~100)
d_tip = g(*R.TIP)[0]; dc, tc = g(R.CX, R.CY)
s_of = lambda D: S_TIP + (d_tip - D) * cb              # 사진기 발치에서 내리막으로 D m 인 곳의 s
V = {}
def v(name, pos, tgt, fov, cam): V[name] = {'pos': [round(float(c), 2) for c in pos], 'tgt': [round(float(c), 2) for c in tgt], 'fov': fov, 'cam': cam}
sc = s_of(0) - H * sb
v('q02-하행-로고-사진02', (*st_to_xy(sc, R.ground.cam_t), float(way_z(s_of(0))) + H * cb), (*st_to_xy(s_of(dc), tc), float(way_z(s_of(dc)))), round(2 * math.degrees(math.atan(805 / 660 * R.CX / F)), 1),
  f'사용자 사진 02 의 자리(추정): s {sc:.1f}, t {R.ground.cam_t:.2f}, 포장면 위 {H:.2f} m, 화각은 지도 화면(660 x 805, 세로가 길어 세로 화각)에서 가로가 사진의 가로 화각 71.7도가 되게 잡은 값. 사진과 견줄 때는 가운데를 542:369 로 오린다(compare.py)')
v('q02-위에서-로고', (*st_to_xy(64.3, 0.5), float(way_z(64.3)) + 13.0), (*st_to_xy(64.35, 0.5), float(way_z(64.3))), 40, '나뭇잎을 바로 위에서(화면 위쪽이 오르막, 왼쪽이 문예관 쪽)')
pathlib.Path(__file__).with_name('views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps(V, ensure_ascii=False))
