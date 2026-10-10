"""Z08: 시점 파일 views.json 을 만든다(파일만 쓴다).   python make_views.py
 - 구역 시점: z06(19개)·z07(16개)의 시점을 그대로 가져온다(같은 각도로 다시 찍어 전후를 본다).
 - 단면 셋: 데크 축(본관 5층 문 – 데크 – 한림관 3층 문), 덮인 복도를 따라(내리막길 → 복도 → 데크), 내리막길 밑 보행 구간을 따라.
   자른 면 뒤 12 m 에 민무늬 벽을 세워 먼 건물을 가리고(단면도 도구 lookAt 의 frame), 보일 높이 범위를 정한다.
 - 전체 다섯: z05 비교-19(남서에서)와 북·동·남·서 비스듬한 시점."""
import json, pathlib
HERE = pathlib.Path(__file__).parent; A = HERE.parent
z6 = json.loads((A / 'z06' / 'views.json').read_text(encoding='utf-8')); z7 = json.loads((A / 'z07' / 'views.json').read_text(encoding='utf-8'))
V = {}
for k, v in z6.items(): V['구역-' + k] = {**{f: v[f] for f in ('pos', 'tgt', 'fov', 'evidence') if f in v}, 'before': f'z06/지도-{k}.jpg'}
for k, v in z7.items():
    if 'section' in v: continue
    V['형상-' + k] = {**{f: v[f] for f in ('pos', 'tgt', 'fov', 'evidence') if f in v}, 'before': f'z07/지도-{k}.jpg'}
EV = '사용자-구역답변-20261011/01-카카오위성-본관한림관-나무데크-위치.webp'
cam = {'pos': [201090.0, 557288.0, 150.0], 'tgt': [201099.0, 557303.0, 136.0], 'fov': 50}
V['단면-03-본관-데크-한림관'] = {**cam, 'evidence': EV, 'before': 'z07/지도-03-단면-본관-데크-한림관.jpg',
    'section': {'a': [201091.0, 557306.5], 'b': [201106.0, 557298.3], 'ortho': True, 'frame': {'lowM': 125, 'highM': 143, 'backdropM': 6}},
    'cam': '단면선 = 데크 가운데 선(본관 5층 문 ~ 한림관 3층 문)을 양쪽으로 3~4 m 늘인 것. 높이 125~143 m, 뒤 6 m 에 민무늬 벽'}
V['단면-04-복도-따라'] = {'pos': [201125.0, 557300.0, 150.0], 'tgt': [201102.0, 557310.0, 136.0], 'fov': 50, 'evidence': EV, 'before': 'z07/지도-04-단면-보행구간-따라.jpg',
    'section': {'a': [201112.3, 557321.2], 'b': [201095.6, 557296.6], 'ortho': True, 'frame': {'lowM': 124, 'highM': 148, 'backdropM': 12}},
    'cam': '단면선 = 덮인 복도의 가운데 선(201106.0, 557311.8 → 201098.5, 557302.4)을 북쪽으로 내리막길 너머까지, 남쪽으로 데크 너머까지 늘인 것'}
V['단면-05-내리막길밑-보행구간'] = {'pos': [201085.0, 557300.0, 160.0], 'tgt': [201093.0, 557325.0, 136.0], 'fov': 50, 'evidence': EV,
    'section': {'a': [201078.1, 557332.4], 'b': [201107.3, 557317.9], 'ortho': True, 'frame': {'lowM': 124, 'highM': 148, 'backdropM': 12}},
    'cam': '단면선 = 지하 보행 구간 2b765aa4 의 내리막길 밑 두 마디(201083.5, 557329.7 → 201101.9, 557320.6)를 양쪽으로 6 m 늘인 것'}
C = [201130.0, 557260.0, 135.0]   # 캠퍼스 가운데쯤
V['전체-0-남서에서(z05 비교-19)'] = {**{f: z6['19-전체-남서에서'][f] for f in ('pos', 'tgt', 'fov')}, 'before': 'z06/지도-19-전체-남서에서.jpg'}
for name, (dx, dy) in {'전체-1-북에서': (0, 330), '전체-2-동에서': (330, 0), '전체-3-남에서': (0, -330), '전체-4-서에서': (-330, 0)}.items():
    V[name] = {'pos': [C[0] + dx, C[1] + dy, 400.0], 'tgt': C, 'fov': 50}
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1), encoding='utf-8'); print(len(V), 'views')
