"""U12: 사용자 현장 사진 30·31 을 찍은 자리(자리 맞춤 결과)에서 보는 갈무리 시점. DB·네트워크 접근 없음.   python views.py
자리 맞춤(구역 노트 U12 절): 띠 좌표 s = 섬 중심에서 주차 줄을 따라 북동, v = 혜인관 쪽(남동). 두 사진 다 0.5배 광각(정사각, 초점 600 화소쯤)으로 읽음."""
import json, pathlib
import numpy as np
HERE = pathlib.Path(__file__).parent
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); RP = M['ramp']; Z1 = M['heights']['b1Floor']
ISL = np.array(RP['islandCentre']); ht = np.array(RP['rowDirection']); hn = np.array(RP['towardHyein']); sp = lambda s, v: ISL + ht * s + hn * v
row = RP['rowAzimuthDeg']; rad = lambda d: round(float(np.radians(d % 360)), 4); at = lambda p: [round(float(p[0]), 2), round(float(p[1]), 2), round(Z1 + 0.3, 2)]
FOV = round(float(np.degrees(2 * np.arctan(1.4 * 601 / 600))), 1)   # 화면 1400 × 1000 의 가운데 1000 × 1000 이 사진(세로 90도)과 같게
CAMS = {   # 사진: (s, v, 방위, 숙임 rad, ±자리 m, ±방위 도)
 '30': (25.0, 8.0, row + 258.0, -0.217, 2.5, 5), '31': (24.0, 6.5, row + 210.0, -0.065, 3.0, 5)}
V = {f'{n}-1인칭-지하1층-현장사진{n}': {'walk': {'at': at(sp(s, v)), 'heading': rad(h), 'pitch': p, 'fov': FOV}, 'sv': [s, v], 'headingDeg': round(h % 360, 1), 'posErrM': e, 'headingErrDeg': he,
     'cam': f'지하 1층 S04·S07 사이 통로, 섬 중심에서 북동 {s} m·남동 {v} m, 방위 {h % 360:.0f}도. 사진 {n}'} for n, (s, v, h, p, e, he) in CAMS.items()}
V['40-띄움-지하1층-북이위'] = {'lift': {'zone': 'b1', 'centre': [201161.0, 557268.0], 'widthM': 80.0, 'upM': 300}, 'cam': '띄운 지하 1층(북이 위, 가로 80 m)'}
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n'); print({k: (v.get('walk') or v.get('lift')) for k, v in V.items()})
