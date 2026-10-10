"""G02: 비교 그림의 시점(근거 사진마다 카메라 자리·보는 점·가로 시야각). python views.py -> views.json"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
def P(s, t, dz, base=None): x, y = st_to_xy(s, t); return [round(float(x), 2), round(float(y), 2), round(float((way_z(s) if base is None else base) + dz), 2)]
V = {
 '1-입구-차단기-거리뷰09': dict(pos=P(-13, 0.5, 2.5), tgt=P(40, 1.0, 1.0), fov=95, evidence='사용자-서문·제2주차장·수인관-20261010/09-오르막보행로-입구-차단기-거리뷰-202502.webp'),
 '2-하단-사진20': dict(pos=P(-30, -3, 1.6), tgt=P(40, 2, 6.0), fov=105, evidence='사용자-SMAP높이-20261010/사진-20-사잇길-하단.png'),
 '3-상행-사진21': dict(pos=P(31, 2.6, 1.3), tgt=P(75, 0.5, 1.5), fov=105, evidence='사용자-SMAP높이-20261010/사진-21-사잇길-상행.png'),
 '4-하행-사진26': dict(pos=P(64, 1.0, 1.6), tgt=P(15, 0.5, 3.0), fov=105, evidence='사용자-SMAP높이-20261010/사진-26-사잇길-하행.png'),
 '5-하행-사진25': dict(pos=P(84, 1.5, 1.7), tgt=P(40, 3.0, 4.0), fov=105, evidence='사용자-SMAP높이-20261010/사진-25-문예관-하행.png'),
 '7-위쪽-사진8': dict(pos=P(52, -22, 0, 187.0), tgt=P(84, 9, 0, 145.0), fov=62, evidence='사용자-SMAP높이-20261010/사진-8-문예관-대일관-사잇길.png'),
 '8-북악관정문-거리뷰10': dict(pos=P(-9.5, -13, 0, 132.6), tgt=P(-9, 14, 0, 135.5), fov=90, evidence='사용자-서문·제2주차장·수인관-20261010/10-북악관-정문계단-거리뷰-202502.webp'),
 '6-위에서-SMAP정사': dict(pos=[201080.0, 557333.0, 421.0], tgt=[201080.0, 557333.0, 138.0], fov=20, evidence='g02/smap-ortho-rectified-01m.png'),
}
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1), encoding='utf-8', newline='\n')
for k, v in V.items(): print(f"await __snap('{k[0]}',{v['pos']},{v['tgt']},{v['fov']})")
