"""Z11: 시점 파일 views.json 을 만든다(파일만 쓴다).   python make_views.py
 - z10 의 64개 시점을 그대로(전 = z10 갈무리). 더한 시점: 창 크기를 보는 가까운 넷(대일관·북악관·청운관·본관), 입구(3) 계단 가까이, 유담관 공도 쪽 벽을 길에서."""
import json, pathlib
HERE = pathlib.Path(__file__).parent
V = {}
for k, v in json.loads((HERE.parent / 'z10' / 'views.json').read_text(encoding='utf-8')).items():
    V[k] = {**{f: v[f] for f in ('pos', 'tgt', 'fov', 'evidence', 'section', 'cam') if f in v}, 'before': f'z10/지도-{k}.jpg'}
V['창-1-대일관-정면'] = {'pos': [201150.0, 557262.0, 153.0], 'tgt': [201176.0, 557308.0, 160.0], 'fov': 70, 'evidence': '사용자-SMAP높이-20261010/사진-18-대일관-정면.png'}
V['창-2-북악관-정면'] = {'pos': [201028.0, 557340.0, 133.0], 'tgt': [201046.0, 557378.0, 145.0], 'fov': 75, 'evidence': '사용자-SMAP높이-20261010/사진-19-북악관-정면.png'}
V['창-3-청운관-운동장에서'] = {'pos': [201178.0, 557262.0, 151.0], 'tgt': [201232.0, 557286.0, 166.0], 'fov': 75, 'evidence': '사용자-SMAP높이-20261010/사진-23-청운관-열린돌출부.png'}
V['창-4-본관-남쪽면'] = {'pos': [201072.0, 557284.0, 130.0], 'tgt': [201064.0, 557306.0, 140.0], 'fov': 95, 'evidence': '사용자-유담관분수-북악관앞-20261010/유담관-분수광장-넓게.jpg'}
V['계단-입구3-가까이'] = {'pos': [201001.5, 557377.5, 133.2], 'tgt': [201008.0, 557385.0, 133.4], 'fov': 80, 'evidence': 'streetview-bukak-gs25-202502-02.png'}
V['결함-1c-유담관-공도에서'] = {'pos': [200996.0, 557246.0, 95.5], 'tgt': [201012.0, 557262.0, 108.0], 'fov': 85, 'evidence': '사용자-서문-공연실습소-생활관-20261010/공연실습소.webp'}
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1), encoding='utf-8'); print(len(V), 'views')
