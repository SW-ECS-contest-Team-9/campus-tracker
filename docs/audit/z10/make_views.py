"""Z10: 시점 파일 views.json 을 만든다(파일만 쓴다).   python make_views.py
 - z09 의 63개 시점을 그대로(전 = z09 갈무리). 바로잡은 시점 셋과 더한 시점 하나:
   구역-09(북악관 옆길): 거리뷰 02 의 자리(옆길 어귀)로.  구역-09b: 거리뷰 01(회차 공간에서 본 입구(3) 계단과 옆길 어귀).
   재-f07-14(외국인 생활관): 사진처럼 회전교차로 북쪽의 길 위, 눈높이에서.  재-f07-15(공연실습소): 사진처럼 남서쪽 공도 위(건물 북서쪽 끝)에서 남동쪽으로."""
import json, pathlib
HERE = pathlib.Path(__file__).parent
V = {}
for k, v in json.loads((HERE.parent / 'z09' / 'views.json').read_text(encoding='utf-8')).items():
    V[k] = {**{f: v[f] for f in ('pos', 'tgt', 'fov', 'evidence', 'section', 'cam') if f in v}, 'before': f'z09/지도-{k}.jpg'}
V['구역-09-북악관옆길-거리뷰GS25'].update(pos=[201000.5, 557375.0, 133.0], tgt=[201008.0, 557395.0, 133.6], fov=90)
V['구역-09b-북악관옆길어귀-거리뷰GS25-01'] = {'pos': [201013.0, 557364.0, 132.6], 'tgt': [201007.0, 557388.0, 134.6], 'fov': 80, 'evidence': 'streetview-bukak-gs25-202502-01.png'}
V['재-f07-14-외국인생활관-사진'].update(pos=[200986.0, 557256.0, 96.4], tgt=[200995.0, 557231.0, 99.5], fov=70)
V['재-f07-15-공연실습소-사진'].update(pos=[201023.0, 557228.5, 94.3], tgt=[201034.0, 557206.0, 100.0], fov=85)
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1), encoding='utf-8'); print(len(V), 'views')
