"""U08: 층 사이 경사로를 ㄴ자로(시험용 DB 변경 묶음과 갈무리 시점). DB·네트워크 접근 없음.   python build.py
먼저: python ../u02/build_parts.py, python ../u04/build.py, 다시 ../u02/build_parts.py·../u04/build.py (기둥은 주차 칸을 읽는다), python ../u04/pairs.py.
쓰는 파일: groups/u08.json (적용은 apply.sh, 시험용 DB 에만), views.json (shots.mjs 의 시점: 다리 좌표에서 계산).
근거: 사용자 확정 2026-10-12 "딱 그냥 ㄴ자야", 사용자 표시 4(붉은 화살표), 학교 지하도 지도의 부채꼴(u07/crescent.json), 사용자 표시 3(낮은 벽), 사진 04. 볼트 구역 노트 "운동장 아래 지하층과 지하 차도"(U08 절)."""
import json, pathlib
import numpy as np
HERE = pathlib.Path(__file__).parent
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); RP = M['ramp']
OLD = 'a2914e7d-c8c4-4db1-992b-af667c54ce38'   # U07 의 층 사이 경사로(개정 1)
EV = (f"사용자 확정 2026-10-12: 층 사이 경사로의 평면은 '딱 그냥 ㄴ자'. 곧은 다리 둘이 직각으로 만나고 학교 지하도 지도의 굽은 부채꼴(중심 ({RP['centre'][0]}, {RP['centre'][1]}), 반지름 {RP['innerRadiusM']}~{RP['outerRadiusM']} m)이 그 모서리다. "
      f"U07 의 '같은 원을 260도까지 더 도는 구간'은 틀림(사용자 표시 4)")
ops = [{'ref': '거둠: U07 층 사이 경사로', 'op': 'retire_feature', 'args': {'type': 'road', 'id': OLD, 'expectedRevision': 1}, 'grade': '확정(사용자: ㄴ자)', 'evidence': EV},
       {'ref': '층 사이 경사로(ㄴ자)', 'op': 'create_road', 'grade': '확정(평면이 ㄴ자: 사용자), 원천(모서리 자리: 학교 지도의 부채꼴, 잔차 RMS 3.3 m), 확정(낮은 벽 밑이 낮은 쪽: 사용자 표시 3), 추정(다리 방향·길이·내려가는 방향·경사)',
        'evidence': EV + (f". 남쪽 다리 {RP['legSouthM']} m(방위 {RP['legSouthAzimuthDeg']}도, 주차 줄의 직각, 위가 트임) → 모서리 {RP['arcM']} m → 낮은 벽 밑({RP['belowFloorAtBandM']} m 아래) → 북쪽 다리 {RP['legNorthM']} m(방위 {RP['legNorthAzimuthDeg']}도, 주차 줄 방향, 지하 1층 바닥 아래) → 지하 2층."
                          f" 높이 차 {RP['dropM']} m 는 줄이지 않았다. 머리가 남쪽 다리 끝이라는 것은 추정"),
        'args': {'roadClass': 'vehicle', 'name': f"운동장 지하 1층–지하 2층 경사로 (ㄴ자: 남쪽 다리 {RP['legSouthM']} m ~ 모서리(학교 지도의 부채꼴) ~ 낮은 벽 밑 ~ 북쪽 다리 {RP['legNorthM']} m ~ 지하 2층. {RP['lengthM']} m 에 {RP['dropM']} m, 경사 {RP['gradePct']} %. 한 차로. 다리 방향·길이와 내려가는 방향은 추정)",
                 'structure': 'ramp', 'widthM': RP['straightWidthM'], 'vehicleAccess': 'allowed', 'pedestrianAccess': 'prohibited', 'vehicleDirection': 'both', 'pedestrianDirection': 'unknown', 'path': RP['path'], 'zMode': 'explicit', 'densify': False}}]
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'u08.json').write_text(json.dumps({'id': 'U08', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U08: U07 의 층 사이 경사로를 거두고 ㄴ자 경사로로(사용자 확정)', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

# ---------- 갈무리 시점 ----------
xy = lambda k: np.array(RP[k]['xy']); T0, A0, B0, RB = xy('top'), xy('arcStart'), xy('arcEnd'), xy('bottom'); ht = np.array(RP['rowDirection']); hn = np.array([ht[1], -ht[0]])
p2 = lambda p: [round(float(p[0]), 2), round(float(p[1]), 2)]; rad = lambda deg: round(float(np.radians(deg)), 3)
FRAME = {'lowM': 129, 'highM': 152, 'backdropM': 4}; CAM = {'pos': [201100, 557258, 220], 'tgt': [201150, 557258, 140], 'fov': 50}
MAPFRAME = {'centre': [201161.0, 557262.0], 'widthM': 70.0, 'upM': 300}; WHOLE = {'centre': [201170.57, 557248.52], 'pxPerM': 4.46, 'upM': 900}
V = {
 '01-띄움-지하1층-학교지도틀': {'lift': {'zone': 'b1', **MAPFRAME}, 'cam': '운동장 지하 1층을 띄움. 학교 지도 조각과 같은 틀(북이 위, 가로 70 m)'},
 '02-띄움-지하2층-학교지도틀': {'lift': {'zone': 'b2', **MAPFRAME}, 'cam': '운동장 지하 2층을 띄움. 같은 틀'},
 '03-띄움-지하1층-전체': {'lift': {'zone': 'b1', **WHOLE}, 'cam': '운동장 지하 1층 전체(U07-03 과 같은 틀)'},
 '04-띄움-지하2층-전체': {'lift': {'zone': 'b2', **WHOLE}, 'cam': '운동장 지하 2층 전체(U07-04 와 같은 틀)'},
 '05-1인칭-남쪽다리-머리에서-내려다봄': {'walk': {'at': [*p2(T0 + hn * 6.0 + ht * 0.6), 141.7], 'heading': rad(RP['legSouthAzimuthDeg'] + 180), 'pitch': -0.08, 'fov': 75}, 'cam': '1인칭: 남쪽 다리의 머리 앞(긴 줄 S07·S08 사이 통로)에서 다리를 따라 내려다봄. 사진 04 와 견줌'},
 '06-1인칭-지하2층-발치에서-북쪽다리-올려다봄': {'walk': {'at': [*p2(RB + ht * 6.5 + hn * 0.8), 133.3], 'heading': rad(RP['legNorthAzimuthDeg'] + 180), 'pitch': 0.05, 'fov': 75}, 'cam': '1인칭: 지하 2층의 발치 앞에서 북쪽 다리를 올려다봄. 사진 04 와 견줌(사진은 올라가는 경사로로 보인다)'},
 '07-1인칭-섬사진11-자리': {'walk': {'at': [201151.6, 557243.8, 141.7], 'heading': 0.3, 'pitch': -0.1, 'fov': 100}, 'cam': '1인칭: U07-06 과 같은 자리(부채꼴 남쪽 끝의 남쪽에서 북쪽을 봄). 사진 11 과 견줌'},
 '08-단면-남쪽다리-따라': {**CAM, 'section': {'a': p2(T0 + hn * 7.0), 'b': p2(A0 - hn * 15.0), 'ortho': True, 'frame': FRAME}, 'cam': '단면선 = 남쪽 다리의 가운데(남동 → 북서): 통로, 머리, 내려가는 바닥, 모서리(굽은 구간을 가로지름), 청록 벽'},
 '09-단면-북쪽다리-따라': {**CAM, 'section': {'a': p2(B0 - ht * 13.0), 'b': p2(RB + ht * 9.0), 'ortho': True, 'frame': FRAME}, 'cam': '단면선 = 북쪽 다리의 가운데(남서 → 북동): 모서리, 낮은 벽, 지하 1층 바닥 아래로 내려가 지하 2층 바닥의 발치'},
 '10-지하길-운동장-바로위에서': {'pos': [201190, 557235, 330], 'tgt': [201190, 557240, 140], 'fov': 40, 'underground': True, 'cam': '지하 길 켬, 운동장 바로 위에서(U07-09 와 같은 시점)'},
 '11-운동장-위에서-지하길끔': {'pos': [201110.0, 557235.0, 215.0], 'tgt': [201200.0, 557275.0, 150.0], 'fov': 75, 'cam': '지하 길 끔: 운동장 면은 그대로여야 한다(U07-10 과 같은 시점)'},
}
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), 'ops', len(RP['path']), 'points', len(V), 'views')
