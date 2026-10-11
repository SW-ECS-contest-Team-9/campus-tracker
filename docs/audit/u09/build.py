"""U09: 지하층 평면을 학교 지하도 지도의 사다리꼴 그대로(운동장·건물 외곽으로 자르지 않음), 층 사이 경사로의 ㄴ자를 서쪽 벽에 맞춤(시험용 DB 변경 묶음과 갈무리 시점). DB·네트워크 접근 없음.   python build.py
먼저: python ../u02/build_parts.py, python ../u04/build.py, 다시 ../u02/build_parts.py·../u04/build.py (기둥은 주차 칸을 읽는다), python ../u04/pairs.py.
쓰는 파일: groups/u09.json (적용은 apply.sh, 시험용 DB 에만), views.json (shots.mjs 의 시점).
근거: 사용자 지시 2026-10-12 "운동장의 형상을 반드시 따르지 않아도 되지 않을까?"(그림 17), 사용자 확정 "딱 그냥 ㄴ자야", 사용자 표시 4(붉은 화살표, 그림 16), 학교 지하도 지도, 사진 11·15. 볼트 구역 노트 "운동장 아래 지하층과 지하 차도"(U09 절)."""
import json, pathlib
import numpy as np
HERE = pathlib.Path(__file__).parent
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); RP = M['ramp']
OLD = '2d23c46b-a3f0-4209-9805-281b3d10db26'   # U08 의 층 사이 경사로(개정 1)
EV = (f"사용자 지시 2026-10-12: 지하 주차장 평면은 운동장의 형상을 반드시 따르지 않아도 된다(그림 17: 경사로 굽은 곳이 평면 가장자리에 끼어 있음). 사용자 확정: 경사로는 ㄴ자. 사용자 표시 4(그림 16): 부채꼴 북쪽 끝에서 서쪽 벽·은주관 문 쪽으로 나간다. "
      f"U08 은 두 다리를 주차 줄 격자(31도·121도)에 맞춰 북쪽 다리가 서쪽 벽에서 22도 벌어졌다. U09 는 서쪽 벽(학교 지도의 서쪽 변, 방위 {RP['westWallAzimuthDeg']}도)에 맞춘다")
ops = [{'ref': '거둠: U08 층 사이 경사로', 'op': 'retire_feature', 'args': {'type': 'road', 'id': OLD, 'expectedRevision': 1}, 'grade': '사용자 그림(북쪽 다리의 방향: 붉은 화살표)', 'evidence': EV},
       {'ref': '층 사이 경사로(ㄴ자, 서쪽 벽에 맞춤)', 'op': 'create_road', 'grade': '확정(평면이 ㄴ자: 사용자), 원천(모서리 자리: 학교 지도의 부채꼴, 잔차 RMS 3.3 m), 확정(낮은 벽 밑이 낮은 쪽: 사용자 표시 3), 사용자 그림(북쪽 다리가 서쪽 벽·문 쪽: 붉은 화살표), 추정(다리 길이·내려가는 방향·경사)',
        'evidence': EV + (f". 남쪽 다리 {RP['legSouthM']} m(방위 {RP['legSouthAzimuthDeg']}도, 서쪽 벽의 직각, 위가 트임) → 모서리 {RP['arcM']} m → 낮은 벽 밑({RP['belowFloorAtBandM']} m 아래) → 북쪽 다리 {RP['legNorthM']} m(방위 {RP['legNorthAzimuthDeg']}도, 서쪽 벽과 나란히, 벽에서 {RP['legNorthWestEdgeToWallM']} m. 은주관 문 앞 바닥 밑 {RP['levelBelowDoorM']} m 를 지난다) → 지하 2층."
                          f" 높이 차 {RP['dropM']} m 는 줄이지 않았다. 머리가 남쪽 다리 끝이라는 것은 추정"),
        'args': {'roadClass': 'vehicle', 'name': f"운동장 지하 1층–지하 2층 경사로 (ㄴ자: 남쪽 다리 {RP['legSouthM']} m ~ 모서리 ~ 낮은 벽 밑 ~ 서쪽 벽과 나란한 북쪽 다리 {RP['legNorthM']} m. {RP['lengthM']} m 에 {RP['dropM']} m, {RP['gradePct']} %. 한 차로. 길이·내려가는 방향 추정)",
                 'structure': 'ramp', 'widthM': RP['straightWidthM'], 'vehicleAccess': 'allowed', 'pedestrianAccess': 'prohibited', 'vehicleDirection': 'both', 'pedestrianDirection': 'unknown', 'path': RP['path'], 'zMode': 'explicit', 'densify': False}}]
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'u09.json').write_text(json.dumps({'id': 'U09', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U09: U08 의 층 사이 경사로를 거두고 서쪽 벽에 맞춘 ㄴ자 경사로로', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

# ---------- 갈무리 시점 ----------
xy = lambda k: np.array(RP[k]['xy']); T0, A0, B0, RB = xy('top'), xy('arcStart'), xy('arcEnd'), xy('bottom'); lN, lS = np.array(RP['legNorthDir']), np.array(RP['legSouthDir'])
p2 = lambda p: [round(float(p[0]), 2), round(float(p[1]), 2)]
FRAME = {'lowM': 129, 'highM': 152, 'backdropM': 4}; CAM = {'pos': [201100, 557258, 220], 'tgt': [201150, 557258, 140], 'fov': 50}
MAPFRAME = {'centre': [201161.0, 557262.0], 'widthM': 70.0, 'upM': 300}; WHOLE = {'centre': [201188.0, 557238.0], 'widthM': 190.0, 'upM': 900}
V = {
 '01-띄움-지하1층-학교지도틀': {'lift': {'zone': 'b1', **MAPFRAME}, 'cam': '운동장 지하 1층을 띄움. 학교 지도 조각과 같은 틀(북이 위, 가로 70 m)'},
 '02-띄움-지하2층-학교지도틀': {'lift': {'zone': 'b2', **MAPFRAME}, 'cam': '운동장 지하 2층을 띄움. 같은 틀'},
 '03-띄움-지하1층-그림17방향': {'lift': {'zone': 'b1', 'centre': [201190.0, 557240.0], 'widthM': 175.0, 'upM': 900, 'upAzDeg': 121.0}, 'cam': '운동장 지하 1층 전체, 사용자 그림 17 과 같은 방향(화면 위 = 방위 121도, 서쪽 벽이 아래)'},
 '04-띄움-지하1층-전체': {'lift': {'zone': 'b1', **WHOLE}, 'cam': '운동장 지하 1층 전체(북이 위, 가로 190 m). 외곽 견줌 그림의 바탕'},
 '05-띄움-지하2층-전체': {'lift': {'zone': 'b2', **WHOLE}, 'cam': '운동장 지하 2층 전체(같은 틀)'},
 '08-단면-남쪽다리-따라': {**CAM, 'section': {'a': p2(T0 + lS * 8.0), 'b': p2(A0 - lS * 16.0), 'ortho': True, 'frame': FRAME}, 'cam': '단면선 = 남쪽 다리의 가운데(동 → 서): 통로, 머리, 내려가는 바닥, 모서리(굽은 구간을 가로지름), 청록 벽, 서쪽 벽'},
 '09-단면-북쪽다리-따라': {**CAM, 'section': {'a': p2(B0 - lN * 14.0), 'b': p2(RB + lN * 12.0), 'ortho': True, 'frame': FRAME}, 'cam': '단면선 = 북쪽 다리의 가운데(남 → 북, 서쪽 벽과 나란히): 모서리, 낮은 벽, 지하 1층 바닥(은주관 문 앞) 아래로 내려가 지하 2층 바닥의 발치'},
 '11-운동장-위에서-지하길끔': {'pos': [201110.0, 557235.0, 215.0], 'tgt': [201200.0, 557275.0, 150.0], 'fov': 75, 'cam': '지하 길 끔: 운동장 면과 둘레는 그대로여야 한다(U08-11 과 같은 시점)'},
}
(HERE / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), 'ops', len(RP['path']), 'points', len(V), 'views')
