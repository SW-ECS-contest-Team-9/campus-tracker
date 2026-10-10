"""Z02: 비교 그림의 시점(근거 그림마다 카메라 자리·보는 점·가로 시야각). python views.py -> views.json"""
import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from common import *
def P(u, v, z): x, y = uv_to_xy(u, v); return [round(float(x), 2), round(float(y), 2), z]
A = '사용자-SMAP높이-20261010/'; B = '사용자-공연실습소-은주관-20261010/'
V = {
 '1-정면-넓게': dict(pos=P(22, 78, 150.6), tgt=P(22, 0, 160.0), fov=72, evidence=B + '대일관-운동장에서-정면.webp'),
 '2-현관-계단-가까이': dict(pos=P(5.5, 24, 150.4), tgt=P(1.7, 2, 156.5), fov=88, evidence=B + '대일관-현관-계단-가까이.webp'),
 '3-현관과-난간-사진18': dict(pos=P(0, 19, 150.3), tgt=P(9, 0, 160.0), fov=105, evidence=A + '사진-18-대일관-정면.png'),
 '4-동쪽끝-계단-사진24': dict(pos=P(42, 26, 150.3), tgt=P(55, -3, 160.0), fov=105, evidence=A + '사진-24-대일관-청운관-연결계단.png'),
 '5-통로-비스듬히-사진14': dict(pos=P(48, 62, 196.0), tgt=P(24, 3, 150.0), fov=38, evidence=A + '사진-14-대일관-앞띠.png'),
 '6-위에서': dict(pos=P(25, 2, 330.0), tgt=P(25, 2, 149.0), fov=24, evidence='사용자-구역답변-20261011/02-카카오위성-대일관앞-나무데크-범위.webp'),
 '7-서쪽끝-형편없음': dict(pos=P(4, -9, 200.0), tgt=P(-18, 9, 146.0), fov=50, evidence='사용자-지적-시험지도-20261011/01-대일관서쪽끝·한림관·운동장모서리-형편없음.png'),
 '9-하행계단-위에서-사진27': dict(pos=P(-4.6, 3.6, 152.7), tgt=P(-24, 3.2, 145.5), fov=75, evidence=A + '사진-27-대일관출구옆-하행계단-실물.png'),
 '8-하행계단-옆에서': dict(pos=P(-20, 27, 158.0), tgt=P(-12, 3, 148.5), fov=70, evidence=A + '사진-18-대일관-정면.png'),
}
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1), encoding='utf-8', newline='\n')
for k, v in V.items(): print(f"await __snap('{k[0]}',{v['pos']},{v['tgt']},{v['fov']})")
