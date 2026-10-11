"""Z09: 시점 파일 views.json 을 만든다(파일만 쓴다).   python make_views.py
 - z08 의 43개 시점을 그대로(전 = z08 갈무리), 결함 시점 defect_views.json(전 = z09/전-*.jpg, Z09 전에 찍어 둔 것)을 더한다.
 - 단면 06: 문예관 저층부가 뒤에 보이는 정면 단면(뒤쪽 벽 없이). 본관·수인관·문예관 3층 입구 가까운 시점."""
import json, pathlib
HERE = pathlib.Path(__file__).parent
V = {}
for k, v in json.loads((HERE.parent / 'z08' / 'views.json').read_text(encoding='utf-8')).items(): V[k] = {**v, 'before': f'z08/지도-{k}.jpg'}
D = json.loads((HERE / 'defect_views.json').read_text(encoding='utf-8'))
D['결함-4c-은주관코트-북동'] = {'pos': [201330, 557060, 250], 'tgt': [201170, 557105, 118], 'fov': 50}
for k, v in D.items(): V[k] = {**v, 'before': f'z09/전-{k}.jpg'}
V['단면-06-문예관저층부-뒤쪽벽없이'] = {'pos': [201085.0, 557300.0, 160.0], 'tgt': [201093.0, 557325.0, 136.0], 'fov': 50,
    'section': {'a': [201078.1, 557332.4], 'b': [201107.3, 557317.9], 'ortho': True, 'frame': {'lowM': 124, 'highM': 160}}, 'cam': '단면 05 와 같은 선, 뒤쪽 민무늬 벽 없이(문예관 저층부 유리 벽이 뒤에 보인다)'}
V['형상-17-수인관-서경로에서'] = {'pos': [201100.0, 557105.0, 112.0], 'tgt': [201150.0, 557150.0, 124.0], 'fov': 70, 'evidence': '사용자-서문·제2주차장·수인관-20261010/04-수인관-서경로쪽-거리뷰-202602-b.webp'}
V['형상-18-문예관-3층입구-가까이'] = {'pos': [201093.7, 557329.3, 146.6], 'tgt': [201102.5, 557333.5, 147.2], 'fov': 80, 'evidence': '사용자-출입구·주차장-20261010/09-문예관입구1-3층로비-캠퍼스맵.webp'}
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1), encoding='utf-8'); print(len(V), 'views')
