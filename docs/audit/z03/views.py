"""Z03: 비교 그림의 시점(근거 사진마다 카메라 자리·보는 점·가로 시야각, 눈대중으로 맞춤). python -I views.py -> views.json, 콘솔에 넣을 한 줄"""
import json, pathlib
U = '사용자-유담관분수-북악관앞-20261010/'
V = {
 '1-광장-위에서': dict(pos=[201100.0, 557188.0, 141.0], tgt=[201067.0, 557228.0, 119.0], fov=105, crop=640 / 960, evidence=U + '유담관-분수광장-위에서.jpg'),
 '2-넓게': dict(pos=[201106.0, 557092.0, 160.0], tgt=[201070.0, 557235.0, 127.0], fov=55, evidence=U + '유담관-분수광장-넓게.jpg'),
 '3-차도-오르며-거리뷰Y05': dict(pos=[201090.5, 557213.0, 115.6], tgt=[201086.5, 557262.0, 121.5], fov=100, evidence='streetview-yudam-approach-202602-05.png'),
 '4-차도-내려보며-거리뷰Y08': dict(pos=[201087.5, 557239.0, 119.3], tgt=[201091.0, 557190.0, 110.0], fov=100, evidence='streetview-yudam-approach-202602-08.png'),
 '5-위에서-네이버위성': dict(pos=[201013.6, 557235.8, 540.0], tgt=[201013.6, 557235.8, 110.0], fov=27.7, crop=1146 / 1165, evidence='사용자-서문·제2주차장·수인관-20261010/08-네이버위성-유담관·공연실습소·생활관3동.webp'),
 '6-위에서-SMAP정사': dict(pos=[201067.0, 557214.5, 420.0], tgt=[201067.0, 557214.5, 110.0], fov=24.3, crop=860 / 1030, evidence='z03/smap-정사-분수광장-01m.png'),
}
(pathlib.Path(__file__).parent / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1), encoding='utf-8', newline='\n')
print('await __z03shots(' + json.dumps({k: {a: b for a, b in v.items() if a in ('pos', 'tgt', 'fov')} for k, v in V.items()}, ensure_ascii=False) + ')')
